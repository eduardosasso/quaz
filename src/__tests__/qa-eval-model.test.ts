import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS: number = 15_000;
const READY_MS: number = 5_000;
const POLL_MS: number = 20;
const REPEAT_SIGNAL_MS: number = 50;
const MODEL_SECONDS: number = 60;
const CONCURRENT: number = 2;
const INTERRUPTED_EXIT: number = 130;
const RUNNER: string = import.meta.resolve("@qa/eval-model");
const ZOD: string = import.meta.resolve("zod");
type Process = { pid: number; work: string };
type Fixture = {
  root: string;
  starts: string;
  child?: Bun.Subprocess<"ignore", "pipe", "pipe">;
};
const fixtures: Fixture[] = [];
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const records = async (path: string): Promise<Process[]> => {
  if (!(await Bun.file(path).exists())) return [];
  const source: string = await readFile(path, "utf8");

  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line: string): Process => JSON.parse(line) as Process);
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }

  return true;
};
// A signalled process is not gone the instant the parent that signalled it
// is: the kill still has to travel, and `kill(pid, 0)` keeps answering for one
// that is on its way out until it has been reaped. Read once, right after the
// parent exits, and a dying child reads as alive - which is a race, not a
// child that survived. So liveness is polled to the same deadline every other
// readiness check here uses, and what comes back is the settled answer for the
// assertion to read.
const settled = async (processes: readonly Process[]): Promise<boolean[]> => {
  const deadline: number = Date.now() + READY_MS;
  let living: boolean[] = processes.map((entry: Process): boolean =>
    alive(entry.pid),
  );
  while (Date.now() < deadline && living.some(Boolean)) {
    await Bun.sleep(POLL_MS);
    living = processes.map((entry: Process): boolean => alive(entry.pid));
  }

  return living;
};
const stop = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};
const wait = async (ready: () => Promise<boolean>): Promise<void> => {
  const deadline: number = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error("Subprocess did not become ready");
};
const fixture = async (stubborn: boolean = false): Promise<Fixture> => {
  const root: string = await mkdtemp(join(tmpdir(), "qa-eval-model-test-"));
  const value: Fixture = { root, starts: join(root, "starts.jsonl") };
  fixtures.push(value);
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "home", "skills"), { recursive: true });
  await writeFile(
    join(root, "fake.ts"),
    `import { appendFileSync } from "node:fs";
${stubborn ? 'process.on("SIGTERM", (): void => {});' : ""}
appendFileSync(${JSON.stringify(value.starts)}, JSON.stringify({ pid: process.pid, work: process.cwd() }) + "\\n");
setInterval((): void => {}, ${TIMEOUT_MS});
`,
  );
  await writeFile(
    join(root, "bin", "codex"),
    `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(join(root, "fake.ts"))} "$@"\n`,
  );
  await chmod(join(root, "bin", "codex"), 0o755);

  return value;
};
const launch = async (
  value: Fixture,
  source: string,
): Promise<Bun.Subprocess<"ignore", "pipe", "pipe">> => {
  await writeFile(
    join(value.root, "wrapper.ts"),
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Model from ${JSON.stringify(RUNNER)};
import { z } from ${JSON.stringify(ZOD)};
const root: string = ${JSON.stringify(value.root)};
const input = (index: number, seconds: number = ${MODEL_SECONDS}): Model.Input => ({ model: "mock", effort: "low", seconds, prompt: "Test only", images: [], schema: z.object({ answer: z.string() }), directory: join(root, String(index)) });
${source}
`,
  );
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [process.execPath, "--no-env-file", join(value.root, "wrapper.ts")],
    {
      env: {
        PATH: join(value.root, "bin"),
        HOME: join(value.root, "home"),
        CODEX_HOME: join(value.root, "home"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  value.child = child;

  return child;
};

afterEach(async (): Promise<void> => {
  for (const value of fixtures.splice(0)) {
    value.child?.kill("SIGKILL");
    if (value.child) await value.child.exited;
    const processes: Process[] = await records(value.starts);
    for (const entry of processes) stop(entry.pid);
    await Promise.all(
      processes.map(
        (entry: Process): Promise<void> =>
          rm(entry.work, { recursive: true, force: true }),
      ),
    );
    await rm(value.root, { recursive: true, force: true });
  }
});

test(
  "interrupt stops both children and rejects later calls",
  async (): Promise<void> => {
    const value: Fixture = await fixture();
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = await launch(
      value,
      `
await Promise.allSettled(Array.from({ length: ${CONCURRENT} }, (_, index: number): Promise<unknown> => Model.run(input(index))));
try { await Model.run(input(${CONCURRENT})); writeFileSync(join(root, "later.txt"), "launched"); }
catch (error: unknown) { writeFileSync(join(root, "later.txt"), error instanceof Error ? error.message : String(error)); }
`,
    );
    await wait(
      async (): Promise<boolean> =>
        (await records(value.starts)).length === CONCURRENT,
    );
    child.kill("SIGINT");
    expect(await child.exited).toBe(INTERRUPTED_EXIT);
    expect(await readFile(join(value.root, "later.txt"), "utf8")).toContain(
      "no more model calls start",
    );
    const processes: Process[] = await records(value.starts);
    expect(processes).toHaveLength(CONCURRENT);
    expect(await settled(processes)).toEqual([false, false]);
  },
  TIMEOUT_MS,
);

test(
  "interrupt during setup prevents spawning",
  async (): Promise<void> => {
    const value: Fixture = await fixture();
    await mkdir(join(value.root, "0"));
    const pipe: string = join(value.root, "0", "prompt.txt");
    expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = await launch(
      value,
      `
const pending: Promise<unknown> = Model.run(input(0));
process.once("SIGINT", (): void => { writeFileSync(join(root, "signal.txt"), "received"); });
writeFileSync(join(root, "ready.txt"), "ready");
try { await pending; writeFileSync(join(root, "result.txt"), "launched"); }
catch (error: unknown) { writeFileSync(join(root, "result.txt"), error instanceof Error ? error.message : String(error)); }
`,
    );
    await wait(
      async (): Promise<boolean> =>
        Bun.file(join(value.root, "ready.txt")).exists(),
    );
    child.kill("SIGINT");
    await wait(
      async (): Promise<boolean> =>
        Bun.file(join(value.root, "signal.txt")).exists(),
    );
    expect(await readFile(pipe, "utf8")).toBe("Test only");
    expect(await child.exited).toBe(INTERRUPTED_EXIT);
    expect(await readFile(join(value.root, "result.txt"), "utf8")).toContain(
      "no more model calls start",
    );
    expect(await records(value.starts)).toEqual([]);
  },
  TIMEOUT_MS,
);

test(
  "repeated interruption still stops resistant children",
  async (): Promise<void> => {
    const value: Fixture = await fixture(true);
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = await launch(
      value,
      `await Promise.allSettled(Array.from({ length: ${CONCURRENT} }, (_, index: number): Promise<unknown> => Model.run(input(index))));`,
    );
    await wait(
      async (): Promise<boolean> =>
        (await records(value.starts)).length === CONCURRENT,
    );
    child.kill("SIGINT");
    await Bun.sleep(REPEAT_SIGNAL_MS);
    child.kill("SIGINT");
    expect(await child.exited).toBe(INTERRUPTED_EXIT);
    const processes: Process[] = await records(value.starts);
    expect(processes).toHaveLength(CONCURRENT);
    expect(await settled(processes)).toEqual([false, false]);
  },
  TIMEOUT_MS,
);

test(
  "timeout kills a child that ignores termination",
  async (): Promise<void> => {
    const value: Fixture = await fixture(true);
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = await launch(
      value,
      `
try { await Model.run(input(0, 1)); writeFileSync(join(root, "result.txt"), "accepted"); }
catch (error: unknown) { writeFileSync(join(root, "result.txt"), error instanceof Error ? error.message : String(error)); }
`,
    );
    expect(await child.exited).toBe(0);
    expect(await readFile(join(value.root, "result.txt"), "utf8")).toContain(
      "Model timeout; attempt is invalid",
    );
    const processes: Process[] = await records(value.starts);
    expect(processes).toHaveLength(1);
    expect(await settled(processes)).toEqual([false]);
    expect(
      JSON.parse(await readFile(join(value.root, "0", "timing.json"), "utf8")),
    ).toMatchObject({ expired: true });
  },
  TIMEOUT_MS,
);
