import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as Backoff from "@qa/backoff";
import CONFIG from "@qa/config.json";
import * as Project from "@qa/project";

export const PREFIX: string = "QUAZ_SOURCE_TOKEN_";
const HEADER: string = "http.https://github.com/.extraheader";
const REDACTED: string = "[redacted]";
export type Env = Record<string, string | undefined>;
export type Result = { code: number; output: string; errors: string };
export type Git = (args: string[], cwd: string, env: Env) => Promise<Result>;
export type Options = {
  request?: Parameters<typeof Project.deployed>[1];
  remote?: (repository: string) => string;
  git?: Git;
  env?: Env;
};

export const variable = (repository: string): string =>
  `${PREFIX}${(repository.split("/")[0] ?? "").toUpperCase().replaceAll("-", "_")}`;
export const github = (repository: string): string =>
  `https://github.com/${repository}.git`;
export const spawn: Git = async (
  args: string[],
  cwd: string,
  env: Env,
): Promise<Result> => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: CONFIG.fetchSeconds * Backoff.MILLISECONDS,
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, output: output.trim(), errors: errors.trim() };
};
const scrub = (text: string, secrets: string[]): string =>
  secrets.reduce(
    (value: string, secret: string): string =>
      value.replaceAll(secret, REDACTED),
    text,
  );
const authorization = (token: string): Env => {
  const header: string = `Authorization: Basic ${btoa(`x-access-token:${token}`)}`;

  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: HEADER,
    GIT_CONFIG_VALUE_0: header,
    GIT_TERMINAL_PROMPT: "0",
  };
};
export const sync = async (
  project: Project.Project,
  log: (event: Record<string, unknown>) => void,
  options: Options = {},
): Promise<string> => {
  const { request, remote = github, git = spawn, env = process.env } = options;
  const repository: string | undefined = project.deployment?.repository;
  if (!project.fetch || !repository)
    throw new Error("Project does not fetch source");

  const deployed: string | null = await Project.deployed(project, request);
  if (!deployed) throw new Error("Deployment probe returned no revision");

  const name: string = variable(repository);
  const token: string = env[name] ?? "";
  const inherited: Env = Object.fromEntries(
    Object.entries(env).filter(
      ([key]: [string, unknown]): boolean => !key.startsWith(PREFIX),
    ),
  );
  const secrets: string[] = token
    ? [token, btoa(`x-access-token:${token}`)]
    : [];
  const run = async (
    args: string[],
    extra: Env = {},
    tolerate: boolean = false,
  ): Promise<string | null> => {
    const result: Result = await git(args, project.root, {
      ...inherited,
      ...extra,
    });
    if (result.code === 0) return result.output;
    if (tolerate) return null;

    const reason: string =
      scrub(result.errors, secrets) || `exit ${result.code}`;
    throw new Error(`git ${args[0]} failed: ${reason}`);
  };
  if (!existsSync(join(project.root, ".git"))) {
    await mkdir(project.root, { recursive: true });
    if (readdirSync(project.root).length)
      throw new Error(
        `Source directory is not a git checkout: ${project.root}`,
      );

    await run(["init", "-q"]);
  }
  const from: string | null = await run(
    ["rev-parse", "--verify", "-q", "HEAD"],
    {},
    true,
  );
  const dirty: string | null = await run([
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (from === deployed && !dirty) return deployed;

  if (from !== deployed) {
    if (!token) throw new Error(`Missing ${name}; provide it at runtime`);

    await run(
      ["fetch", "--depth", "1", "--no-tags", remote(repository), deployed],
      authorization(token),
    );
  }
  await run(["checkout", "--detach", "--force", deployed]);
  await run(["clean", "-ffdx"]);
  log({ event: "source-sync", project: project.id, from, to: deployed });

  return deployed;
};
