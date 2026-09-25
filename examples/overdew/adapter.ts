import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type * as Project from "@qa/project";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { z } from "zod";

const ORIGIN: string = "http://127.0.0.1:3001";
const ACTION_MS: number = 15000;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const SCENARIOS = ["empty", "typical", "busy"] as const;
const FIXTURE_DIRECTORY: string = "/app/uploads/.quaz";
const FIXTURE_PATH: string = join(FIXTURE_DIRECTORY, "fixture.ts");
type Fixture = {
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
  username: string;
  secret: string;
  key: string;
  counts: { boards: number; cards: number };
};
const seed = async (input: {
  dataPath: string;
  scenario: (typeof SCENARIOS)[number];
  runId: string;
  testerId: string;
}): Promise<Fixture> => {
  await mkdir(FIXTURE_DIRECTORY, { recursive: true });
  await copyFile(join(import.meta.dir, "fixture.ts"), FIXTURE_PATH);
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", FIXTURE_PATH, "--seed"],
    {
      cwd: "/app",
      env: {
        NODE_ENV: "test",
        QA_MODE: "fixture",
        DATA_PATH: input.dataPath,
        AGENT: "off",
      },
      stdin: new Blob([
        JSON.stringify({
          ...input,
          origin: ORIGIN,
          disposable: true,
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  const [stdout, stderr, code]: [string, string, number] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `Target fixture failed: ${stderr.trim() || `exit ${code}`}`,
    );

  return z
    .object({
      username: z.string(),
      secret: z.string(),
      key: z.string(),
      counts: z.object({ boards: z.number(), cards: z.number() }),
      storageState: z.object({
        cookies: z.array(z.unknown()),
        origins: z.array(z.unknown()),
      }),
    })
    .passthrough()
    .parse(JSON.parse(stdout)) as Fixture;
};
export const prepare: Project.Adapter["prepare"] = async (input) => {
  const data: string = join(input.directory, "data");
  const fixture: Fixture = await seed({
    dataPath: data,
    scenario: z.enum(SCENARIOS).parse(input.scenario),
    runId: input.runId,
    testerId: input.testerId,
  });
  return {
    origin: ORIGIN,
    entry: "/dashboard",
    ready: "/favicon.svg",
    storageState: fixture.storageState,
    command: [process.execPath, "--no-env-file", "/app/index.tsx"],
    env: {
      NODE_ENV: "test",
      NEOLOGIN_SECRET: fixture.secret,
      NEOLOGIN_KEY: fixture.key,
      NEOLOGIN_URL: `${ORIGIN}/qa-auth-unavailable`,
      DATA_PATH: data,
      LOCAL_STORAGE_PATH: join(input.directory, "uploads"),
      HOST: "127.0.0.1",
      PORT: "3001",
      AGENT: "off",
      KAMAL_VERSION: input.revision,
    },
    metadata: {
      username: fixture.username,
      boards: fixture.counts.boards,
      counts: fixture.counts,
    },
  };
};
const context = async (
  instance: Browser,
  fixture: Project.Prepared,
  mobile: boolean,
): Promise<BrowserContext> => {
  const result: BrowserContext = await instance.newContext({
    storageState: fixture.storageState,
    viewport: mobile ? MOBILE : DESKTOP,
    isMobile: mobile,
    hasTouch: mobile,
    serviceWorkers: "block",
  });
  await result.route("**/*", async (route): Promise<void> => {
    if (new URL(route.request().url()).origin !== ORIGIN) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  result.setDefaultTimeout(ACTION_MS);

  return result;
};

export const smoke = async (
  fixture: Project.Prepared,
  instance: Browser,
  output: string,
): Promise<Record<string, unknown>> => {
  const OUTPUT: string = output;
  await mkdir(join(OUTPUT, "smoke"), { recursive: true });
  try {
    const desktop: BrowserContext = await context(instance, fixture, false);
    const page: Page = await desktop.newPage();
    await page.goto(`${ORIGIN}/dashboard`, { waitUntil: "networkidle" });
    const profile = await desktop.request.get(`${ORIGIN}/api/user/profile`);
    if (!profile.ok())
      throw new Error(
        `Disposable browser authentication failed: ${profile.status()}`,
      );
    const identity: unknown = await profile.json();
    const username: string = z
      .object({ username: z.string() })
      .parse(identity).username;
    if (username !== String(fixture.metadata.username))
      throw new Error("Disposable browser authenticated as the wrong user");
    await page.screenshot({
      path: join(OUTPUT, "smoke/desktop.png"),
      fullPage: true,
    });
    const touch: BrowserContext = await context(instance, fixture, true);
    const mobile: Page = await touch.newPage();
    await mobile.goto(`${ORIGIN}/dashboard`, { waitUntil: "networkidle" });
    await mobile.screenshot({
      path: join(OUTPUT, "smoke/mobile.png"),
      fullPage: true,
    });
    await mobile.setViewportSize(LANDSCAPE);
    await mobile.screenshot({
      path: join(OUTPUT, "smoke/landscape.png"),
      fullPage: true,
    });
    const empty: boolean = Number(fixture.metadata.boards) === 0;
    if (!empty)
      await page
        .getByRole("button", { name: "New board", exact: true })
        .click();
    await page
      .getByRole("textbox", {
        name: empty ? "Name your first board" : "Name your new board",
      })
      .fill("QA smoke board");
    await page
      .getByRole("button", {
        name: empty ? "make my board" : "Create board",
        exact: true,
      })
      .click();
    await page.waitForURL(
      `**/${String(fixture.metadata.username)}/qa-smoke-board`,
    );
    const content: string = "QA smoke persisted card";
    const created = await desktop.request.post(
      `${ORIGIN}/api/boards/${String(fixture.metadata.username)}/qa-smoke-board/notes`,
      { form: { content } },
    );
    if (!created.ok())
      throw new Error(`Disposable write failed: ${created.status()}`);
    const note = z
      .object({ id: z.number(), content: z.string() })
      .parse(await created.json());
    const persisted = await desktop.request.get(
      `${ORIGIN}/api/notes/${note.id}`,
    );
    if (
      !persisted.ok() ||
      z.object({ content: z.string() }).parse(await persisted.json())
        .content !== content
    )
      throw new Error("Disposable write did not persist");
    await page.reload({ waitUntil: "networkidle" });
    const saved: Locator = page.getByText(content, { exact: true }).first();
    await saved.waitFor({ state: "visible" });
    await saved.scrollIntoViewIfNeeded();
    await saved.screenshot({ path: join(OUTPUT, "smoke/write-title.png") });
    await page.screenshot({ path: join(OUTPUT, "smoke/write.png") });

    return {
      authenticated: true,
      username,
      browser: "Chromium headless",
      initialCounts: fixture.metadata.counts,
      createdCard: note.id,
      persisted: true,
      evidence: [
        "smoke/desktop.png",
        "smoke/mobile.png",
        "smoke/landscape.png",
        "smoke/write.png",
        "smoke/write-title.png",
      ],
      limitations: [
        "Infrastructure smoke only. No AI review or Impeccable finding assessment.",
        "Mobile uses Chromium touch emulation. Physical devices and native keyboards are not tested.",
      ],
    };
  } finally {
    await instance.close();
  }
};
