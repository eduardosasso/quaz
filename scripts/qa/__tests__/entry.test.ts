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
import * as Client from "@qa/client";
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
    await Controller.recovery(
      Client.connect("https://tracker.example", "owner/board", "tracker-token"),
      root,
    );
    expect(existsSync(credential)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
