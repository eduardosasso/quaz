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
if (import.meta.main) {
  const [mode = "controller", ...args]: string[] = process.argv.slice(2);
  const child = Bun.spawn(invocation(mode, args, process.env), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, (): void => child.kill(signal));
  process.exitCode = await child.exited;
}
