import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type * as Project from "@qa/project";
import type { Browser } from "playwright";
import { z } from "zod";

const settings = z
  .object({
    command: z
      .string()
      .optional()
      .transform((value): string[] =>
        value ? z.array(z.string()).min(1).parse(JSON.parse(value)) : [],
      ),
    setup: z
      .string()
      .optional()
      .transform((value): string[] | undefined =>
        value ? z.array(z.string()).min(1).parse(JSON.parse(value)) : undefined,
      ),
    origin: z.url(),
    entry: z.string().startsWith("/"),
    ready: z.string().startsWith("/"),
  })
  .passthrough();
export const prepare: Project.Adapter["prepare"] = async (
  input,
): Promise<Project.Prepared> => {
  const parsed = settings.parse(input.settings);
  const env: Record<string, string> = {
    QA_RUN_ID: input.runId,
    QA_TESTER_ID: input.testerId,
    QA_SCENARIO: input.scenario,
    QA_DATA_DIR: input.directory,
    QA_REVISION: input.revision,
  };
  if (parsed.setup) {
    const result = spawnSync(parsed.setup[0], parsed.setup.slice(1), {
      cwd: "/app",
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Project setup failed: ${result.error?.message ?? result.stderr.trim()}`,
      );
  }
  const path: string = join(input.directory, "state.json");
  const storageState = existsSync(path)
    ? (JSON.parse(
        readFileSync(path, "utf8"),
      ) as Project.Prepared["storageState"])
    : { cookies: [], origins: [] };
  return {
    origin: parsed.origin,
    entry: parsed.entry,
    ready: parsed.ready,
    storageState,
    command: parsed.command,
    env,
    metadata: { scenario: input.scenario, revision: input.revision },
  };
};
export const smoke: Project.Adapter["smoke"] = async (
  prepared: Project.Prepared,
  browser: Browser,
  output: string,
): Promise<Record<string, unknown>> => {
  const context = await browser.newContext({
    storageState: prepared.storageState,
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(
      new URL(prepared.entry, prepared.origin).href,
    );
    await page.screenshot({ path: join(output, "smoke.png") });
    if (!response?.ok())
      throw new Error(
        `Smoke page returned ${response?.status() ?? "no response"}`,
      );
    return {
      url: page.url(),
      status: response.status(),
      screenshot: "smoke.png",
    };
  } finally {
    await context.close();
    await browser.close();
  }
};
