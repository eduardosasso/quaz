const [mode, ...args]: string[] = process.argv.slice(2);
const modes: Record<string, string> = {
  controller: "controller.ts",
  worker: "worker.ts",
  run: "run.ts",
};
const script: string | undefined = modes[mode ?? "controller"];
if (!script) throw new Error("Use controller, worker, or run");
const child = Bun.spawn(
  [process.execPath, "--no-env-file", `${import.meta.dir}/${script}`, ...args],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, (): void => child.kill(signal));
process.exitCode = await child.exited;
