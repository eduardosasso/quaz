import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Backoff from "@qa/backoff";
import type * as Client from "@qa/client";
import CONFIG from "@qa/config.json";
import * as Controller from "@qa/controller";
import * as Entry from "@qa/entry";
import * as Runner from "@qa/run";

test("controller resolves tracker secrets at runtime", () => {
  const command: string[] = Entry.invocation("controller", [], {
    OP_SERVICE_ACCOUNT_TOKEN: "service-token",
    QUAZ_ENVIRONMENT: "quaz-environment",
  });
  expect(command.slice(0, 5)).toEqual([
    "op",
    "run",
    "--environment",
    "quaz-environment",
    "--",
  ]);
  expect(command.at(-1)).toEndWith("controller.ts");
  expect((): string[] =>
    Entry.invocation("controller", [], {
      OP_SERVICE_ACCOUNT_TOKEN: "service-token",
    }),
  ).toThrow("Set both OP_SERVICE_ACCOUNT_TOKEN and QUAZ_ENVIRONMENT");
  expect((): string => Controller.trackerToken({})).toThrow(
    "Missing QUAZ_TRACKER_TOKEN",
  );
  expect(Controller.trackerToken({ QUAZ_TRACKER_TOKEN: "tracker-token" })).toBe(
    "tracker-token",
  );
});

test("worker does not load 1Password secrets", () => {
  const command: string[] = Entry.invocation("worker", [], {
    OP_SERVICE_ACCOUNT_TOKEN: "service-token",
    QUAZ_ENVIRONMENT: "quaz-environment",
  });
  expect(command[0]).not.toBe("op");
  expect(command.at(-1)).toEndWith("worker.ts");
});

test("guided review needs a Claude token", () => {
  const options: Runner.Options = {
    mode: "discover",
    testers: 1,
    scenarios: ["empty"],
    seconds: 90,
    project: "/missing/project.json",
    url: "https://tracker.example",
    board: "owner/board",
    provider: "claude",
  };
  const prior: string | undefined = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  expect((): void => Runner.validate(options)).toThrow(
    "Missing CLAUDE_CODE_OAUTH_TOKEN",
  );
  expect((): void =>
    Runner.validate({ ...options, mode: "smoke" }),
  ).not.toThrow();
  if (prior) process.env.CLAUDE_CODE_OAUTH_TOKEN = prior;
});

test("controller recovery removes a stale Claude token", async () => {
  const root: string = mkdtempSync(join(tmpdir(), "quaz-credential-"));
  const credential: string = join(root, "temporary-one", "credential-1");
  mkdirSync(credential, { recursive: true });
  writeFileSync(join(credential, "token"), "test-token");
  try {
    const client: Client.Client = {
      request: async <T>(): Promise<T> => {
        throw new Error("Unexpected recovery request");
      },
      upload: async (): Promise<number> => {
        throw new Error("Unexpected recovery upload");
      },
    };
    await Controller.recovery(client, root);
    expect(existsSync(credential)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller restarts wait before reading 1Password again", async () => {
  const root: string = mkdtempSync(join(tmpdir(), "quaz-entry-"));
  const ledger: string = join(root, "failures");
  const delays: number[] = [];
  const events: Record<string, unknown>[] = [];
  let now: number = 0;
  let launches: number = 0;
  const pacing: Backoff.Pacing = {
    now: (): number => now,
    wait: async (milliseconds: number): Promise<void> => {
      delays.push(milliseconds);
    },
    log: (event: Record<string, unknown>): void => {
      events.push(event);
    },
  };
  const crash = async (): Promise<number> => {
    launches++;
    now += 1000;

    return 1;
  };
  const signal: AbortSignal = new AbortController().signal;
  try {
    expect(await Entry.guard(ledger, crash, signal, pacing)).toBe(1);
    expect(delays).toEqual([]);
    expect(await Entry.failures(ledger)).toBe(1);
    expect(events.at(-1)?.event).toBe("controller-exit");
    expect(await Entry.guard(ledger, crash, signal, pacing)).toBe(1);
    expect(await Entry.guard(ledger, crash, signal, pacing)).toBe(1);
    const base: number =
      CONFIG.controller.backoffSeconds * Backoff.MILLISECONDS;
    expect(delays).toEqual([base, base * 2]);
    expect(await Entry.failures(ledger)).toBe(3);
    expect(
      await Entry.guard(ledger, async (): Promise<number> => 0, signal, pacing),
    ).toBe(0);
    expect(existsSync(ledger)).toBe(false);
    expect(launches).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller shutdown during backoff skips 1Password", async () => {
  const root: string = mkdtempSync(join(tmpdir(), "quaz-entry-"));
  const ledger: string = join(root, "failures");
  writeFileSync(ledger, "2");
  const stop = new AbortController();
  let launches: number = 0;
  try {
    const code: number = await Entry.guard(
      ledger,
      async (): Promise<number> => {
        launches++;

        return 0;
      },
      stop.signal,
      {
        now: (): number => 0,
        wait: async (): Promise<void> => {
          stop.abort();
        },
        log: (): void => {},
      },
    );
    expect(code).toBe(0);
    expect(launches).toBe(0);
    expect(await Entry.failures(ledger)).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated controller failures halt without reading 1Password", async () => {
  const root: string = mkdtempSync(join(tmpdir(), "quaz-entry-"));
  const ledger: string = join(root, "failures");
  writeFileSync(ledger, String(CONFIG.controller.restartLimit));
  const delays: number[] = [];
  const events: Record<string, unknown>[] = [];
  let launches: number = 0;
  try {
    const code: number = await Entry.guard(
      ledger,
      async (): Promise<number> => {
        launches++;

        return 0;
      },
      new AbortController().signal,
      {
        now: (): number => 0,
        wait: async (milliseconds: number): Promise<void> => {
          delays.push(milliseconds);
        },
        log: (event: Record<string, unknown>): void => {
          events.push(event);
        },
      },
    );
    expect(code).toBe(1);
    expect(launches).toBe(0);
    expect(events.map((event): unknown => event.event)).toEqual([
      "controller-halted",
    ]);
    expect(delays).toEqual([
      CONFIG.controller.maxBackoffSeconds * Backoff.MILLISECONDS,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stopped controller is not counted as a failure", async () => {
  const root: string = mkdtempSync(join(tmpdir(), "quaz-entry-"));
  const ledger: string = join(root, "failures");
  writeFileSync(ledger, "1");
  const stop = new AbortController();
  const events: Record<string, unknown>[] = [];
  try {
    const code: number = await Entry.guard(
      ledger,
      async (): Promise<number> => {
        stop.abort();

        return 143;
      },
      stop.signal,
      {
        now: (): number => 0,
        wait: async (): Promise<void> => {},
        log: (event: Record<string, unknown>): void => {
          events.push(event);
        },
      },
    );
    expect(code).toBe(143);
    expect(existsSync(ledger)).toBe(false);
    expect(events.map((event): unknown => event.event)).toEqual([
      "controller-backoff",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a long healthy run resets the restart backoff", () => {
  const healthy: number =
    CONFIG.controller.maxBackoffSeconds * Backoff.MILLISECONDS;
  expect(Entry.count(4, 1, healthy)).toBe(1);
  expect(Entry.count(4, 1, healthy - 1)).toBe(5);
  expect(Entry.count(4, 0, 1)).toBe(0);
  expect(Backoff.delay(20, CONFIG.controller.backoffSeconds)).toBe(healthy);
});
