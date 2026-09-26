import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type Config, neologin, readUser, type Session } from "@neologin/sdk";
import type { BrowserContext } from "playwright";
import { z } from "zod";

const IDENTIFIER: RegExp = /^[a-zA-Z0-9_-]{1,80}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);
const CHILD_ARGUMENT: string = "--seed";
const LOCK_FILENAME: string = ".qa-fixture.lock";
const SESSION_SECONDS: number = 24 * 60 * 60;
const HASH_LENGTH: number = 16;
const SECRET_BYTES: number = 32;
const CARD_GAP: number = 280;
const CARD_MARGIN: number = 80;
const CARD_COLUMNS: number = 4;
const COMPLETED_INTERVAL: number = 5;
const DAY_MS: number = 24 * 60 * 60 * 1000;
const DUE_DAYS: number = 7;
const CHILD_TIMEOUT_MS: number = 30_000;

export const SCENARIOS = ["empty", "typical", "busy"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const COUNTS: Record<Scenario, { boards: number; cards: number }> = {
  empty: { boards: 0, cards: 0 },
  typical: { boards: 2, cards: 8 },
  busy: { boards: 6, cards: 120 },
};

const optionsSchema = z.object({
  dataPath: z.string().refine(isAbsolute, "DATA_PATH must be absolute"),
  origin: z.url().refine((value: string): boolean => {
    const url: URL = new URL(value);

    return (
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }, "QA origin must be a loopback HTTP origin"),
  scenario: z.enum(SCENARIOS),
  runId: z.string().regex(IDENTIFIER),
  testerId: z.string().regex(IDENTIFIER),
  disposable: z.literal(true),
});

export type Options = z.infer<typeof optionsSchema>;
export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
export type Fixture = {
  databasePath: string;
  storageState: StorageState;
  username: string;
  email: string;
  secret: string;
  key: string;
  counts: { boards: number; cards: number };
  plan: "free" | "plus";
};

const reserve = async (dataPath: string): Promise<void> => {
  await mkdir(dataPath, { recursive: true, mode: 0o700 });
  const target = await lstat(dataPath);
  if (!target.isDirectory() || target.isSymbolicLink())
    throw new Error("QA DATA_PATH must be a real directory");
  if ((await readdir(dataPath)).length > 0)
    throw new Error(
      "QA DATA_PATH must be empty; existing data is never reused",
    );
  const lock = await open(join(dataPath, LOCK_FILENAME), "wx", 0o600);
  await lock.close();
  if (
    (await readdir(dataPath)).some(
      (name: string): boolean => name !== LOCK_FILENAME,
    )
  )
    throw new Error("QA DATA_PATH changed during fixture preparation");
};

const seed = async (options: Options): Promise<Fixture> => {
  if (
    process.env.QA_MODE !== "fixture" ||
    process.env.DATA_PATH !== options.dataPath
  )
    throw new Error("Fixture seeding requires an isolated QA child process");
  await reserve(options.dataPath);

  const secret: string = Buffer.from(
    crypto.getRandomValues(new Uint8Array(SECRET_BYTES)),
  ).toString("hex");
  const identity: string = new Bun.CryptoHasher("sha256")
    .update(`${options.runId}:${options.testerId}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const email: string = `qa-${identity}@example.invalid`;
  const pair: CryptoKeyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicKey: JsonWebKey = await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  );
  const key: string = `nl_pk_${Buffer.from(JSON.stringify(publicKey)).toString("base64url")}`;
  const config: Config = {
    url: `${options.origin}/qa-auth-unavailable`,
    key,
    secret,
    cookieSecure: false,
    cookieMaxAge: SESSION_SECONDS,
  };
  const login = await neologin.test.login(config, { email });
  const session: Session | null = await readUser(
    new Request(options.origin, { headers: { cookie: login.cookie } }),
    config,
  );
  if (!session)
    throw new Error("The disposable test session failed verification");

  // Importing schema opens the app database, so it happens only after the child reserves its empty directory.
  const Database = await import("@/database");
  await import("@/schema");
  const User = await import("@/user");
  const Board = await import("@/board");
  const Note = await import("@/note");
  const Workspace = await import("@/workspace");
  const Shared = await import("@/shared");

  try {
    const user = User.upsert(session.id, session.email);
    const workspace = Workspace.ensurePersonal(user.username);
    const counts = COUNTS[options.scenario];
    const plan: "free" | "plus" =
      options.scenario === "empty" ? "free" : "plus";
    User.setPlan(user.username, plan);
    User.setDisplayName(user.username, "QA Tester");
    const titles: string[] = [
      "Plan the next release",
      "Review the mobile card editor and check every control on a narrow screen",
      "Prepare customer notes",
      "Check the calendar",
    ];
    const cardsPerBoard: number =
      counts.boards === 0 ? 0 : counts.cards / counts.boards;
    const dueDate: string = new Date(Date.now() + DUE_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    Array.from({ length: counts.boards }).forEach(
      (_, boardIndex: number): void => {
        const ordinal: number = boardIndex + 1;
        const board = Board.create(
          workspace.id,
          `qa-board-${ordinal}`,
          user.username,
        );
        Board.setName(
          board.id,
          ordinal === 1 ? "Product planning" : `Project ${ordinal}`,
        );
        Array.from({ length: cardsPerBoard }).forEach(
          (_, cardIndex: number): void => {
            const note = Note.create(
              board.id,
              `${titles[cardIndex % titles.length]} ${cardIndex + 1}`,
              user.username,
              CARD_MARGIN + (cardIndex % CARD_COLUMNS) * CARD_GAP,
              CARD_MARGIN + Math.floor(cardIndex / CARD_COLUMNS) * CARD_GAP,
              Shared.COLORS[cardIndex % Shared.COLORS.length],
            );
            Note.update(note.id, {
              description:
                cardIndex === 1
                  ? "Review the layout, keyboard behavior, and save result.\n\nA longer description makes wrapping and editor scrolling visible."
                  : "Disposable content for this QA run.",
              checklist: JSON.stringify([
                { text: "Open the card", done: true },
                { text: "Check the saved result", done: false },
              ]),
              tags: cardIndex % 2 === 0 ? "planning" : "review",
              due_date: cardIndex % 2 === 0 ? dueDate : null,
            });
            if ((cardIndex + 1) % COMPLETED_INTERVAL === 0)
              Note.complete(note.id, user.username);
          },
        );
      },
    );

    return {
      databasePath: join(options.dataPath, "overdew.db"),
      username: user.username,
      email,
      secret,
      key,
      counts: { ...counts },
      plan,
      storageState: {
        cookies: [
          {
            name: login.cookieName,
            value: login.cookieValue,
            domain: new URL(options.origin).hostname,
            path: "/",
            expires: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
    };
  } finally {
    Database.db.close();
  }
};

export const prepare = async (input: Options): Promise<Fixture> => {
  const options: Options = optionsSchema.parse(input);
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", import.meta.path, CHILD_ARGUMENT],
    {
      cwd: import.meta.dir,
      env: {
        NODE_ENV: "test",
        QA_MODE: "fixture",
        DATA_PATH: options.dataPath,
        AGENT: "off",
      },
      stdin: new Blob([JSON.stringify(options)]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
    },
  );
  const [stdout, stderr, code]: [string, string, number] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`QA fixture failed: ${stderr.trim() || `exit ${code}`}`);

  return JSON.parse(stdout) as Fixture;
};

if (import.meta.main) {
  if (process.argv[2] !== CHILD_ARGUMENT)
    throw new Error("Use the QA runner to prepare a disposable fixture");
  const options: Options = optionsSchema.parse(
    JSON.parse(await Bun.stdin.text()),
  );
  process.stdout.write(JSON.stringify(await seed(options)));
}
