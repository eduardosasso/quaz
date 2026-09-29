import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Backoff from "@qa/backoff";
import CONFIG from "@qa/config.json";

// The container's writable layer survives Docker restarts but not a new container.
const LEDGER: string = join(tmpdir(), "quaz-controller-failures");
const modes: Record<string, string> = {
  controller: "controller.ts",
  worker: "worker.ts",
  run: "run.ts",
};
export const invocation = (
  mode: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): string[] => {
  const script: string | undefined = modes[mode];
  if (!script) throw new Error("Use controller, worker, or run");
  const command: string[] = [
    process.execPath,
    "--no-env-file",
    `${import.meta.dir}/${script}`,
    ...args,
  ];
  if (mode !== "controller") return command;
  const token: string = env.OP_SERVICE_ACCOUNT_TOKEN ?? "";
  const environment: string = env.QUAZ_ENVIRONMENT ?? "";
  if (Boolean(token) !== Boolean(environment))
    throw new Error(
      "Set both OP_SERVICE_ACCOUNT_TOKEN and QUAZ_ENVIRONMENT, or set neither",
    );

  return token
    ? ["op", "run", "--environment", environment, "--", ...command]
    : command;
};
export const failures = async (path: string): Promise<number> => {
  try {
    const value: number = Number((await readFile(path, "utf8")).trim());
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`Invalid controller failure count in ${path}`);

    return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
};
export const count = (
  previous: number,
  code: number,
  elapsed: number,
): number => {
  if (!code) return 0;
  if (elapsed >= CONFIG.controller.maxBackoffSeconds * Backoff.MILLISECONDS)
    return 1;

  return previous + 1;
};
export const guard = async (
  path: string,
  launch: () => Promise<number>,
  signal: AbortSignal,
  pacing: Backoff.Pacing,
): Promise<number> => {
  const previous: number = await failures(path);
  if (previous >= CONFIG.controller.restartLimit) {
    pacing.log({
      event: "controller-halted",
      failures: previous,
      error: `Controller failed ${previous} times in a row; inspect the logs, then recreate the container`,
    });
    await pacing.wait(
      CONFIG.controller.maxBackoffSeconds * Backoff.MILLISECONDS,
      signal,
    );

    return 1;
  }
  if (previous) {
    const delay: number = Backoff.delay(
      previous,
      CONFIG.controller.backoffSeconds,
    );
    pacing.log({
      event: "controller-backoff",
      failures: previous,
      delaySeconds: delay / Backoff.MILLISECONDS,
    });
    await pacing.wait(delay, signal);
  }
  if (signal.aborted) return 0;
  const started: number = pacing.now();
  const code: number = await launch();
  const next: number = signal.aborted
    ? 0
    : count(previous, code, pacing.now() - started);
  if (next) await writeFile(path, String(next));
  else await rm(path, { force: true });
  if (next)
    pacing.log({
      event: "controller-exit",
      code,
      failures: next,
      nextDelaySeconds:
        Backoff.delay(next, CONFIG.controller.backoffSeconds) /
        Backoff.MILLISECONDS,
    });

  return code;
};
if (import.meta.main) {
  const [mode = "controller", ...args]: string[] = process.argv.slice(2);
  const command: string[] = invocation(mode, args, process.env);
  const stopping = new AbortController();
  let child: Bun.Subprocess | null = null;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, (): void => {
      stopping.abort();
      child?.kill(signal);
    });
  const launch = async (): Promise<number> => {
    child = Bun.spawn(command, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    return child.exited;
  };
  process.exitCode =
    mode === "controller"
      ? await guard(LEDGER, launch, stopping.signal, {
          now: Date.now,
          wait: Backoff.wait,
          log: (event: Record<string, unknown>): void =>
            console.error(JSON.stringify(event)),
        })
      : await launch();
}
