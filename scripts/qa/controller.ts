import { existsSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as Client from "@qa/client";
import CONFIG from "@qa/config.json";
import * as Docker from "@qa/docker";
import * as Project from "@qa/project";
import * as Runner from "@qa/run";
import { z } from "zod";
import * as Storage from "@/local_storage_native";
import * as Protocol from "@/qa_protocol";

const MILLISECONDS: number = 1000;
const duration = z.number().int().positive();
export const schema = z
  .object({
    project: z.string(),
    mode: z.enum(["auto", "discover", "verify", "smoke"]).default("auto"),
    parallel: z
      .number()
      .int()
      .min(1)
      .max(CONFIG.maxTesters)
      .default(CONFIG.controller.parallel),
    pollSeconds: duration.default(CONFIG.controller.pollSeconds),
    intervalSeconds: duration.default(CONFIG.controller.intervalSeconds),
    retrySeconds: duration.default(CONFIG.controller.retrySeconds),
    attempts: z
      .number()
      .int()
      .min(1)
      .max(Protocol.SCHEDULE_HISTORY)
      .default(CONFIG.controller.attempts),
    runs: z.number().int().nonnegative().default(0),
    seconds: z
      .number()
      .int()
      .min(CONFIG.minSeconds)
      .max(CONFIG.maxSeconds)
      .default(CONFIG.seconds),
    scenarios: z.array(z.string()).min(1).optional(),
    provider: z.enum(["codex"]).default("codex"),
    model: z.string().optional(),
    attention: z.string().optional(),
  })
  .strict();
export type Settings = z.infer<typeof schema>;
export type Job = { mode: Protocol.Mode; scenario: string; ticket?: number };
export type Active = { job: Job; promise: Promise<void> };
const failed = (run: Protocol.Run): boolean =>
  ["failed", "expired"].includes(run.status);
export const timestamp = (run: Protocol.Run): number => {
  const value: number = Number(/^qa-(\d+)-/.exec(run.id)?.[1]);

  return Number.isFinite(value)
    ? value
    : run.expires - Protocol.LEASE_SECONDS * MILLISECONDS;
};
export const available = (
  history: Protocol.Run[],
  settings: Settings,
  now: number,
): boolean => {
  if (!history.length) return true;
  const consecutive: number = history.findIndex(
    (run: Protocol.Run): boolean => !failed(run),
  );
  const failures: number = consecutive < 0 ? history.length : consecutive;
  if (failures >= settings.attempts) return false;
  const wait: number = failed(history[0])
    ? settings.retrySeconds
    : settings.intervalSeconds;

  return now >= timestamp(history[0]) + wait * MILLISECONDS;
};
export const plans = (
  settings: Settings,
  project: Project.Project,
  state: Protocol.State,
  revision: string,
  active: Job[],
  now: number,
): Job[] => {
  const free: number = settings.parallel - active.length;
  if (free <= 0) return [];
  const history: Protocol.Run[] = state.runs.filter(
    (run): boolean => run.revision === revision,
  );
  const jobs: Job[] = [];
  if (["auto", "verify"].includes(settings.mode)) {
    for (const ticket of state.tickets) {
      if (jobs.length >= free) break;
      if (active.some((job): boolean => job.ticket === ticket.id)) continue;
      if (
        state.flows.some(
          (flow): boolean =>
            flow.key === `ticket-${ticket.id}` && flow.expires > now,
        )
      )
        continue;
      const previous: Protocol.Run[] = history.filter(
        (run): boolean => run.target === ticket.id,
      );
      if (!available(previous, settings, now)) continue;
      jobs.push({
        mode: "verify",
        scenario: ticket.test.scenario,
        ticket: ticket.id,
      });
    }
  }
  const mode: Protocol.Mode = settings.mode === "smoke" ? "smoke" : "discover";
  if (
    settings.mode === "verify" ||
    jobs.length >= free ||
    active.some((job): boolean => job.mode === mode)
  )
    return jobs;
  if (
    !available(
      history.filter((run): boolean => run.mode === mode),
      settings,
      now,
    )
  )
    return jobs;
  const scenarios: string[] = settings.scenarios ?? project.scenarios;
  const last: string | undefined = state.runs.find(
    (run): boolean => run.mode === mode,
  )?.scenario;
  const offset: number = last ? scenarios.indexOf(last) + 1 : 0;
  let selected: number = 0;
  while (jobs.length < free)
    jobs.push({
      mode,
      scenario: scenarios[(offset + selected++) % scenarios.length],
    });

  return jobs;
};
export const recovery = async (
  client: Client.Client,
  directory: string,
  input?: Runner.Options,
): Promise<void> => {
  const errors: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("temporary-")) continue;
    const root: string = join(directory, entry.name);
    const children = await readdir(root, { withFileTypes: true });
    const credentials: string[] = [];
    for (const child of children) {
      if (!child.isDirectory() || !child.name.startsWith("credential-"))
        continue;
      const path: string = join(root, child.name);
      try {
        if (
          input &&
          existsSync(`${path}.initial`) &&
          existsSync(join(path, "auth.json"))
        )
          await Runner.restoreAuth(
            input,
            path,
            await readFile(`${path}.initial`),
          );
      } catch (error: unknown) {
        credentials.push(String(error));
      }
      await rm(path, { recursive: true, force: true });
    }
    let pending: boolean = false;
    for (const child of children) {
      const path: string = join(root, child.name);
      if (!child.isDirectory() || !existsSync(join(path, "recovery.json")))
        continue;
      try {
        if (credentials.length) {
          await mkdir(join(path, "output"), { recursive: true });
          await writeFile(
            join(path, "output/credential-error.json"),
            JSON.stringify({ errors: credentials }),
          );
        }
        await Runner.recover(client, path);
        await rm(path, { recursive: true });
      } catch (error: unknown) {
        pending = true;
        errors.push(String(error));
      }
    }
    errors.push(...credentials);
    if (!pending) await rm(root, { recursive: true });
  }
  if (errors.length)
    throw new Error(`QA recovery needs attention: ${errors.join("; ")}`);
};
const wait = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((finish): void => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      finish();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
};
export type Dependencies = {
  state: () => Promise<Protocol.State>;
  execute: (job: Job, signal: AbortSignal) => Promise<void>;
  recover: () => Promise<void>;
  now: () => number;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  log: (event: Record<string, unknown>) => void;
};
export const loop = async (
  settings: Settings,
  project: Project.Project,
  revision: string,
  signal: AbortSignal,
  dependencies: Dependencies,
): Promise<void> => {
  const active: Set<Active> = new Set();
  let launched: number = 0;
  let errors: number = 0;
  let failedRuns: number = 0;
  let consecutiveFailures: number = 0;
  let retryAfter: number = 0;
  try {
    while (!signal.aborted) {
      if (settings.runs && launched >= settings.runs && !active.size) break;
      if (consecutiveFailures >= settings.attempts && !active.size)
        throw new Error(
          "Worker retry limit reached; inspect the tracking board and controller logs",
        );
      try {
        if (!active.size) await dependencies.recover();
        const state: Protocol.State = await dependencies.state();
        signal.throwIfAborted();
        const remaining: number = settings.runs
          ? settings.runs - launched
          : settings.parallel;
        const jobs: Job[] =
          dependencies.now() < retryAfter
            ? []
            : plans(
                settings,
                project,
                state,
                revision,
                [...active].map((item): Job => item.job),
                dependencies.now(),
              ).slice(0, remaining);
        for (const job of jobs) {
          launched++;
          const item: Active = { job, promise: Promise.resolve() };
          active.add(item);
          dependencies.log({
            event: "start",
            ...job,
            active: active.size,
            launched,
          });
          item.promise = Promise.resolve()
            .then(async (): Promise<void> => {
              await dependencies.execute(job, signal);
              consecutiveFailures = 0;
            })
            .catch((error: unknown): void => {
              failedRuns++;
              consecutiveFailures++;
              retryAfter =
                dependencies.now() + settings.retrySeconds * MILLISECONDS;
              dependencies.log({
                event: "run-error",
                ...job,
                error: String(error),
              });
            })
            .finally((): void => {
              active.delete(item);
            });
        }
        errors = 0;
        if (settings.runs && launched >= settings.runs && !active.size) break;
        const paused = new AbortController();
        const forward = (): void => paused.abort();
        signal.addEventListener("abort", forward, { once: true });
        try {
          await Promise.race([
            dependencies.wait(
              settings.pollSeconds * MILLISECONDS,
              paused.signal,
            ),
            ...[...active].map((item): Promise<void> => item.promise),
          ]);
        } finally {
          paused.abort();
          signal.removeEventListener("abort", forward);
        }
      } catch (error: unknown) {
        if (signal.aborted) break;
        errors++;
        dependencies.log({
          event: "controller-error",
          attempt: errors,
          error: String(error),
        });
        if (errors >= settings.attempts) throw error;
        await dependencies.wait(settings.retrySeconds * MILLISECONDS, signal);
      }
    }
  } finally {
    await Promise.all([...active].map((item): Promise<void> => item.promise));
  }
  if (failedRuns && settings.runs)
    throw new Error(
      `${failedRuns} QA runs fail; inspect the tracking board reports`,
    );
};
export const start = async (
  settings: Settings,
  signal: AbortSignal,
): Promise<void> => {
  const runtime: Docker.Runtime = await Docker.inspect();
  await mkdir(runtime.directory, { recursive: true });
  const lock = await open(
    join(runtime.directory, "controller.lock"),
    "a",
    0o600,
  );
  if (!Storage.tryExclusiveLock(lock.fd)) {
    await lock.close();
    throw new Error("Another controller owns this runtime volume");
  }
  let connected: boolean = false;
  try {
    const project: Project.Project = Project.load(settings.project);
    const input: Runner.Options = {
      ...Runner.options([
        "--project",
        settings.project,
        "--testers",
        "1",
        "--seconds",
        String(settings.seconds),
        "--auth",
        CONFIG.controller.auth,
        "--skill",
        CONFIG.controller.skill,
        ...(settings.scenarios
          ? ["--scenarios", settings.scenarios.join(",")]
          : []),
      ]),
      runtime,
      mode: settings.mode === "smoke" ? "smoke" : "discover",
      provider: settings.provider,
      model: settings.model,
      attention: settings.attention,
    };
    Runner.validate(input);
    const client: Client.Client = Client.connect(
      input.url,
      input.board,
      process.env.QUAZ_TRACKER_TOKEN ?? "",
    );
    const destination: string = JSON.stringify({
      url: new URL(input.url).origin,
      board: input.board,
      project: project.id,
    });
    const path: string = join(runtime.directory, "destination.json");
    if (existsSync(path) && (await readFile(path, "utf8")) !== destination)
      throw new Error(
        "Use a separate runtime volume for another tracking board or project",
      );
    await writeFile(path, destination, { mode: 0o600 });
    const revision: string = await Runner.revision(project, runtime);
    await Docker.cleanup(runtime);
    await Docker.network(runtime);
    connected = true;
    const log = (event: Record<string, unknown>): void =>
      console.log(JSON.stringify(event));
    log({
      event: "ready",
      project: project.id,
      image: runtime.image,
      parallel: settings.parallel,
      mode: settings.mode,
    });
    await loop(settings, project, revision, signal, {
      state: async (): Promise<Protocol.State> => {
        const state: Protocol.State = await client.request(
          `/state?project=${encodeURIComponent(project.id)}&revision=${revision}`,
        );
        if (state.scheduledRevision !== revision)
          throw new Error("Tracking server needs the QA controller API update");

        return state;
      },
      execute: async (job: Job, stopping: AbortSignal): Promise<void> => {
        await Runner.run(
          {
            ...input,
            mode: job.mode,
            scenarios: [job.scenario],
            tickets: job.ticket ? [job.ticket] : undefined,
          },
          stopping,
        );
      },
      recover: async (): Promise<void> =>
        recovery(client, runtime.directory, input),
      now: Date.now,
      wait,
      log,
    });
  } finally {
    try {
      if (connected) {
        await Docker.cleanup(runtime);
        await Docker.command([
          "network",
          "disconnect",
          runtime.network,
          process.env.HOSTNAME ?? "",
        ]);
        await Docker.command(["network", "rm", runtime.network]);
      }
    } finally {
      await lock.close();
    }
  }
};
if (import.meta.main) {
  const { values } = parseArgs({
    options: { config: { type: "string", default: "/config/controller.json" } },
  });
  const settings: Settings = schema.parse(
    JSON.parse(await readFile(resolve(values.config), "utf8")),
  );
  const stopping = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, (): void => stopping.abort());
  try {
    await start(settings, stopping.signal);
  } catch (error: unknown) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
