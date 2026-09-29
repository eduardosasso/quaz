import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Project from "@qa/project";
import * as Source from "@qa/source";

const TOKEN: string = "ghs_secretTokenValue123";
const IDENTITY: string[] = [
  "-c",
  "user.name=QA",
  "-c",
  "user.email=qa@example.test",
  "-c",
  "commit.gpgsign=false",
];
const folders: string[] = [];
let remote: string = "";
let older: string = "";
let newer: string = "";
const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd });
  if (result.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
};
const folder = (): string => {
  const path: string = mkdtempSync(join(tmpdir(), "quaz-source-"));
  folders.push(path);

  return path;
};
beforeAll((): void => {
  const work: string = folder();
  git(work, "init", "-q");
  writeFileSync(join(work, "app.txt"), "one");
  git(work, "add", ".");
  git(work, "commit", "-qm", "one");
  older = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "app.txt"), "two");
  git(work, "commit", "-qam", "two");
  newer = git(work, "rev-parse", "HEAD");
  remote = join(folder(), "remote.git");
  git(work, "clone", "-q", "--bare", work, remote);
});
afterAll((): void => {
  for (const path of folders.splice(0))
    rmSync(path, { recursive: true, force: true });
});
type Setup = {
  project: Project.Project;
  events: Record<string, unknown>[];
  spawned: string[][];
  options: (deployed: string, env?: Source.Env) => Source.Options;
};
const setup = (): Setup => {
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    root: join(folder(), "source"),
    sources: ["app.txt"],
    scenarios: ["empty"],
    fetch: true,
    deployment: { url: "https://app.test/version", repository: "acme/app" },
  });
  const spawned: string[][] = [];

  return {
    project,
    events: [],
    spawned,
    options: (
      deployed: string,
      env: Source.Env = { QUAZ_SOURCE_TOKEN_ACME: TOKEN },
    ) => ({
      request: async (): Promise<Response> =>
        new Response("{}", { headers: { "x-quaz-revision": deployed } }),
      remote: (): string => `file://${remote}`,
      git: (args: string[], cwd: string, environment: Source.Env) => {
        spawned.push(args);

        return Source.spawn(args, cwd, environment);
      },
      env,
    }),
  };
};
const head = (project: Project.Project): string =>
  git(project.root, "rev-parse", "HEAD");
const status = (project: Project.Project): string =>
  git(project.root, "status", "--porcelain", "--untracked-files=normal");
const fetches = (spawned: string[][]): number =>
  spawned.filter((args: string[]): boolean => args[0] === "fetch").length;

test("initial fetch", async (): Promise<void> => {
  const { project, events, options } = setup();
  await Source.sync(project, (event) => events.push(event), options(older));
  expect(head(project)).toBe(older);
  expect(status(project)).toBe("");
  expect(events).toEqual([
    { event: "source-sync", project: "sample", from: null, to: older },
  ]);
});

test("already current", async (): Promise<void> => {
  const { project, events, spawned, options } = setup();
  await Source.sync(project, (event) => events.push(event), options(newer));
  spawned.length = 0;
  await Source.sync(project, (event) => events.push(event), options(newer, {}));
  expect(fetches(spawned)).toBe(0);
  expect(events).toHaveLength(1);
});

test("advances to new deploy", async (): Promise<void> => {
  const { project, events, options } = setup();
  await Source.sync(project, (event) => events.push(event), options(older));
  await Source.sync(project, (event) => events.push(event), options(newer));
  expect(head(project)).toBe(newer);
  expect(readFileSync(join(project.root, "app.txt"), "utf8")).toBe("two");
  expect(events[1]).toEqual({
    event: "source-sync",
    project: "sample",
    from: older,
    to: newer,
  });
});

test("rollback to older commit", async (): Promise<void> => {
  const { project, events, options } = setup();
  await Source.sync(project, (event) => events.push(event), options(newer));
  await Source.sync(project, (event) => events.push(event), options(older));
  expect(head(project)).toBe(older);
  expect(readFileSync(join(project.root, "app.txt"), "utf8")).toBe("one");
});

test("resets dirty checkout", async (): Promise<void> => {
  const { project, events, options } = setup();
  await Source.sync(project, (event) => events.push(event), options(newer));
  writeFileSync(join(project.root, "app.txt"), "changed");
  writeFileSync(join(project.root, "extra.txt"), "extra");
  mkdirSync(join(project.root, "nested"));
  writeFileSync(join(project.root, "nested/file.txt"), "nested");
  await Source.sync(project, (event) => events.push(event), options(newer));
  expect(status(project)).toBe("");
  expect(readFileSync(join(project.root, "app.txt"), "utf8")).toBe("two");
  expect(existsSync(join(project.root, "extra.txt"))).toBe(false);
  expect(existsSync(join(project.root, "nested"))).toBe(false);
});

test("resets a dirty checkout already at the deployed commit without a token", async (): Promise<void> => {
  const { project, events, spawned, options } = setup();
  await Source.sync(project, (event) => events.push(event), options(newer));
  writeFileSync(join(project.root, "app.txt"), "changed");
  spawned.length = 0;
  await Source.sync(project, (event) => events.push(event), options(newer, {}));
  expect(fetches(spawned)).toBe(0);
  expect(status(project)).toBe("");
  expect(readFileSync(join(project.root, "app.txt"), "utf8")).toBe("two");
});

test("token by owner", (): void => {
  expect(Source.variable("tedstonne/overdew")).toBe(
    "QUAZ_SOURCE_TOKEN_TEDSTONNE",
  );
  expect(Source.variable("eduardosasso/neologin")).toBe(
    "QUAZ_SOURCE_TOKEN_EDUARDOSASSO",
  );
  expect(Source.variable("my-org/app")).toBe("QUAZ_SOURCE_TOKEN_MY_ORG");
});

test("missing owner token", async (): Promise<void> => {
  const { project, events, options } = setup();
  const failure: unknown = await Source.sync(
    project,
    (event) => events.push(event),
    options(newer, { QUAZ_SOURCE_TOKEN_OTHER: TOKEN }),
  ).catch((error: unknown): unknown => error);
  expect(String(failure)).toContain("Missing QUAZ_SOURCE_TOKEN_ACME;");
  expect(events).toEqual([]);
});

test("token never leaks", async (): Promise<void> => {
  const { project, events, options } = setup();
  const arguments_: string[][] = [];
  const environments: Source.Env[] = [];
  const leaking: Source.Options = {
    ...options(newer, {
      QUAZ_SOURCE_TOKEN_ACME: TOKEN,
      QUAZ_SOURCE_TOKEN_OTHER: "ghs_otherOwnerToken456",
    }),
    git: async (args: string[], cwd: string, env: Source.Env) => {
      arguments_.push(args);
      environments.push(env);
      if (args[0] !== "fetch") return Source.spawn(args, cwd, env);

      return {
        code: 128,
        output: "",
        errors: `fatal: ${TOKEN} rejected; ${env.GIT_CONFIG_VALUE_0}`,
      };
    },
  };
  const failure: unknown = await Source.sync(
    project,
    (event) => events.push(event),
    leaking,
  ).catch((error: unknown): unknown => error);
  expect(String(failure)).toContain("git fetch failed");
  expect(String(failure)).not.toContain(TOKEN);
  expect(String(failure)).not.toContain(btoa(`x-access-token:${TOKEN}`));
  const fetching: Source.Env | undefined = environments.find(
    (_, index: number): boolean => arguments_[index]?.[0] === "fetch",
  );
  expect(fetching?.GIT_CONFIG_KEY_0).toBe(
    "http.https://github.com/.extraheader",
  );
  expect(fetching?.GIT_CONFIG_VALUE_0).toBe(
    `Authorization: Basic ${btoa(`x-access-token:${TOKEN}`)}`,
  );
  expect(fetching?.GIT_TERMINAL_PROMPT).toBe("0");
  expect(fetching?.QUAZ_SOURCE_TOKEN_ACME).toBeUndefined();
  expect(fetching?.QUAZ_SOURCE_TOKEN_OTHER).toBeUndefined();
  expect(JSON.stringify(environments)).not.toContain("ghs_otherOwnerToken456");
  expect(JSON.stringify(arguments_)).not.toContain(TOKEN);

  await Source.sync(project, (event) => events.push(event), options(newer));
  expect(readFileSync(join(project.root, ".git/config"), "utf8")).not.toContain(
    TOKEN,
  );
  expect(JSON.stringify(events)).not.toContain(TOKEN);
});

test("probe failure throws", async (): Promise<void> => {
  const { project, spawned, options } = setup();
  const failing: Source.Options = {
    ...options(newer),
    request: async (): Promise<Response> => new Response("", { status: 503 }),
  };
  await expect(Source.sync(project, (): void => {}, failing)).rejects.toThrow(
    "503",
  );
  const empty: Source.Options = {
    ...options(newer),
    request: async (): Promise<Response> => new Response("{}"),
  };
  await expect(Source.sync(project, (): void => {}, empty)).rejects.toThrow(
    "no revision",
  );
  expect(spawned).toEqual([]);
});

test("refuses a directory that is not a checkout", async (): Promise<void> => {
  const { project, options } = setup();
  mkdirSync(project.root, { recursive: true });
  writeFileSync(join(project.root, "state.json"), "{}");
  await expect(
    Source.sync(project, (): void => {}, options(newer)),
  ).rejects.toThrow("not a git checkout");
  expect(existsSync(join(project.root, "state.json"))).toBe(true);
});
