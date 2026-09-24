import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { image: { type: "string", default: "quaz-overdew:local" } },
});
for (const scenario of ["empty", "typical", "busy"] as const) {
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=512m",
      "--memory",
      "2g",
      "--env",
      `QUAZ_SCENARIO=${scenario}`,
      "--entrypoint",
      "bun",
      values.image,
      "--no-env-file",
      "/quaz/examples/overdew/probe.ts",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 },
  );
  const [output, errors, code]: [string, string, number] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `Disposable ${scenario} proof failed: ${errors.trim() || `exit ${code}`}`,
    );
  process.stdout.write(output);
}
