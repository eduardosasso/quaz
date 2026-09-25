import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export class InvalidOutputError extends Error {}

const DISABLED: string[] = [
  "apps",
  "plugins",
  "hooks",
  "memories",
  "skill_search",
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "code_mode_host",
  "code_mode",
  "view_image",
  "image_generation",
  "goals",
  "sleep_tool",
  "workspace_dependencies",
  "unbounded_connection_retries",
];
const KILL_MS: number = 2000;
// How long the interrupt waits for the children it just killed to be reaped
// before it gives up and leaves anyway. A SIGKILL cannot be refused, so this
// is a backstop against a pathological host rather than an expected wait.
const REAP_MS: number = 2000;
// Each running child, against a promise that settles once this process has
// reaped it. The pid alone is not enough: a signal is delivered, not awaited,
// and only the parent can turn a killed child into a gone one.
const active: Map<number, Promise<void>> = new Map();

const after = (ms: number): Promise<void> =>
  new Promise((done: () => void): void => {
    setTimeout(done, ms);
  });
let interrupted: boolean = false;
let listening: boolean = false;
const signal = (pid: number, value: NodeJS.Signals): void => {
  try {
    process.kill(-pid, value);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};
// A signal is delivered, not awaited. Exiting in the same tick as the SIGKILL
// leaves children that are dying but not yet reaped, and this process is the
// only one that can reap them: once it is gone they are orphans, and whether
// they disappear is up to PID 1. A container started without an init has no
// reaper there, so they stay zombies for its whole life - and a zombie still
// answers `kill(pid, 0)`, so anything asking whether they stopped is told they
// did not. So the children are waited for, and only then is this process done.
const interrupt = (value: "SIGINT" | "SIGTERM"): void => {
  if (interrupted) return;
  interrupted = true;
  const running: [number, Promise<void>][] = [...active];
  for (const [pid] of running) signal(pid, "SIGTERM");
  setTimeout((): void => {
    for (const [pid] of running) signal(pid, "SIGKILL");
    const quit = (): void => process.exit(value === "SIGINT" ? 130 : 143);
    void Promise.race([
      Promise.all(
        running.map(
          ([, reaped]: [number, Promise<void>]): Promise<void> => reaped,
        ),
      ),
      after(REAP_MS),
    ]).then(quit, quit);
  }, KILL_MS);
};
const available = (): void => {
  if (interrupted)
    throw new Error("Eval interrupted; no more model calls start");
};
const exclusions = async (directory: string): Promise<string[]> => {
  try {
    return (
      await Array.fromAsync(
        new Bun.Glob("**/SKILL.md").scan({
          cwd: directory,
          absolute: true,
          followSymlinks: true,
          dot: true,
        }),
      )
    ).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};
const DISABLED_HOST_WARNING: string =
  "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
const eventSchema = z
  .object({
    type: z.string(),
    item: z.object({ type: z.string() }).passthrough().optional(),
  })
  .passthrough();
export type Settings = {
  model: string;
  effort: string;
  seconds: number;
};
export type Input = Settings & {
  prompt: string;
  images: Buffer[];
  schema: z.ZodType;
  directory: string;
};

export const argumentsFor = (
  work: string,
  images: string[],
  settings: Settings,
  skills: string[] = [],
): string[] => [
  "exec",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "-C",
  work,
  "--json",
  "--model",
  settings.model,
  "-c",
  `model_reasoning_effort="${settings.effort}"`,
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  "suppress_unstable_features_warning=true",
  "-c",
  `skills.config=[${skills.map((path: string): string => `{path=${JSON.stringify(path)},enabled=false}`).join(",")}]`,
  "-c",
  'web_search="disabled"',
  "--enable",
  "skip_host_skill_discovery",
  ...DISABLED.flatMap((feature: string): string[] => ["--disable", feature]),
  "--output-schema",
  join(work, "schema.json"),
  "--output-last-message",
  join(work, "response.json"),
  ...images.flatMap((path: string): string[] => ["--image", path]),
  "-",
];

export const events = (source: string, response: unknown): void => {
  const records: z.infer<typeof eventSchema>[] = source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line: string) => eventSchema.parse(JSON.parse(line)));
  for (const type of ["thread.started", "turn.started", "turn.completed"]) {
    if (records.filter((event) => event.type === type).length !== 1)
      throw new Error("Expected one started and completed model turn");
  }
  const start: number = records.findIndex(
    (event) => event.type === "turn.started",
  );
  if (
    records[0]?.type !== "thread.started" ||
    records.at(-1)?.type !== "turn.completed"
  )
    throw new Error("Invalid model event order");
  const messages = records.filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "agent_message",
  );
  const final = messages.at(-1);
  if (
    !final?.item ||
    typeof final.item.text !== "string" ||
    records.indexOf(final) < start ||
    JSON.stringify(JSON.parse(final.item.text)) !== JSON.stringify(response)
  )
    throw new Error("Final model message is missing or differs from response");
  for (const event of records) {
    if (
      records.indexOf(event) < start &&
      event.type === "item.completed" &&
      event.item?.type === "error" &&
      event.item.message === DISABLED_HOST_WARNING
    )
      continue;
    if (
      ![
        "thread.started",
        "turn.started",
        "turn.completed",
        "item.started",
        "item.updated",
        "item.completed",
      ].includes(event.type)
    )
      throw new Error(`Unexpected model event: ${event.type}`);
    if (
      event.type.startsWith("item.") &&
      !["reasoning", "agent_message"].includes(event.item?.type ?? "")
    )
      throw new Error(
        `Tool or unknown item invalidates attempt: ${event.item?.type}`,
      );
  }
};

export const run = async (input: Input): Promise<unknown> => {
  available();
  if (!listening) {
    listening = true;
    process.on("SIGINT", (): void => interrupt("SIGINT"));
    process.on("SIGTERM", (): void => interrupt("SIGTERM"));
  }
  const work: string = await mkdtemp(join(tmpdir(), "visual-eval-"));
  const started: number = Date.now();
  const codexHome: string = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  await mkdir(input.directory, { recursive: true });
  const images: string[] = input.images.map(
    (_: Buffer, index: number): string => join(work, `image-${index + 1}.png`),
  );
  try {
    await Promise.all(
      images.map(
        (path: string, index: number): Promise<void> =>
          writeFile(path, input.images[index]),
      ),
    );
    await writeFile(
      join(work, "schema.json"),
      JSON.stringify(z.toJSONSchema(input.schema)),
    );
    await writeFile(join(input.directory, "prompt.txt"), input.prompt);
    const skills: string[] = await exclusions(join(codexHome, "skills"));
    const args: string[] = argumentsFor(work, images, input, skills);
    await writeFile(
      join(input.directory, "invocation.json"),
      JSON.stringify({ args, started }, null, 2),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code: number | null = await new Promise((resolve, reject): void => {
      available();
      const child = spawn("codex", args, {
        cwd: work,
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: work,
          CODEX_HOME: codexHome,
          TMPDIR: process.env.TMPDIR,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (child.pid)
        active.set(
          child.pid,
          new Promise((reaped: () => void): void => {
            child.once("close", reaped);
          }),
        );
      let expired: boolean = false;
      let killer: ReturnType<typeof setTimeout> | undefined;
      const stop = (value: NodeJS.Signals): void => {
        if (!child.pid) return;
        try {
          signal(child.pid, value);
        } catch (error: unknown) {
          reject(error);
        }
      };
      const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
        expired = true;
        stop("SIGTERM");
        killer = setTimeout((): void => stop("SIGKILL"), KILL_MS);
      }, input.seconds * 1000);
      child.stdout.on("data", (chunk: Buffer): void => {
        stdout.push(chunk.toString());
      });
      child.stderr.on("data", (chunk: Buffer): void => {
        stderr.push(chunk.toString());
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException): void => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.on("error", (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (status: number | null): void => {
        if (child.pid) active.delete(child.pid);
        stop("SIGKILL");
        clearTimeout(timer);
        if (killer) clearTimeout(killer);
        Promise.all([
          writeFile(join(input.directory, "events.jsonl"), stdout.join("")),
          writeFile(join(input.directory, "stderr.log"), stderr.join("")),
          writeFile(
            join(input.directory, "timing.json"),
            JSON.stringify({
              elapsedMs: Date.now() - started,
              expired,
              status,
            }),
          ),
        ]).then((): void => {
          if (expired) reject(new Error("Model timeout; attempt is invalid"));
          else resolve(status);
        }, reject);
      });
      child.stdin.end(input.prompt);
    });
    if (code !== 0)
      throw new Error(`Codex exits ${code}; see ${input.directory}/stderr.log`);
    const response: string = await readFile(
      join(work, "response.json"),
      "utf8",
    );
    await writeFile(join(input.directory, "response.json"), response);
    events(stdout.join(""), JSON.parse(response));

    try {
      return input.schema.parse(JSON.parse(response));
    } catch (error: unknown) {
      if (error instanceof z.ZodError)
        throw new InvalidOutputError("Model output does not match its schema", {
          cause: error,
        });
      throw error;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};
