import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import {
  chown,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as Client from "@qa/client";
import CONFIG from "@qa/config.json";
import * as Docker from "@qa/docker";
import * as Image from "@qa/image";
import * as Lifecycle from "@qa/lifecycle";
import * as Project from "@qa/project";
import * as Provider from "@qa/provider";
import { z } from "zod";
import * as Protocol from "@/qa_protocol";

const ROOT: string = resolve(import.meta.dir, "../..");
const MILLISECONDS: number = 1000;
export type Options = {
  mode: Protocol.Mode;
  testers: number;
  scenarios: string[];
  seconds: number;
  project: string;
  url: string;
  board: string;
  provider: string;
  attention?: string;
  model?: string;
  resume?: string;
  runtime?: Docker.Runtime;
  output?: string;
  tickets?: number[];
};
export const options = (args: string[]): Options => {
  const { values } = parseArgs({
    args,
    options: {
      mode: { type: "string", default: "discover" },
      testers: { type: "string", default: String(CONFIG.testers) },
      scenarios: { type: "string" },
      seconds: { type: "string", default: String(CONFIG.seconds) },
      project: { type: "string" },
      tracker: { type: "string", default: process.env.QUAZ_TRACKER_URL ?? "" },
      board: { type: "string", default: process.env.QUAZ_TRACKER_BOARD ?? "" },
      provider: { type: "string", default: "claude" },
      attention: { type: "string" },
      model: { type: "string" },
      resume: { type: "string" },
      output: { type: "string" },
    },
  });
  const mode: Protocol.Mode = Protocol.mode.parse(values.mode);
  const testers: number = Number(values.testers);
  const seconds: number = Number(values.seconds);
  if (
    !Number.isSafeInteger(testers) ||
    testers < 1 ||
    testers > CONFIG.maxTesters
  )
    throw new Error(`Testers must be 1–${CONFIG.maxTesters}`);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < CONFIG.minSeconds ||
    seconds > CONFIG.maxSeconds
  )
    throw new Error(
      `Seconds must be ${CONFIG.minSeconds}–${CONFIG.maxSeconds}`,
    );
  if (!values.project) throw new Error("--project is required");
  const project: Project.Project = Project.load(values.project);
  const scenarios: string[] =
    values.scenarios?.split(",") ?? project.scenarios.slice(0, CONFIG.testers);
  if (
    scenarios.some(
      (scenario: string): boolean => !project.scenarios.includes(scenario),
    )
  )
    throw new Error("Unsupported project scenario");
  Provider.select(values.provider);
  return {
    mode,
    testers,
    seconds,
    scenarios,
    project: resolve(values.project),
    url: values.tracker,
    board: values.board,
    ...(values.output ? { output: resolve(values.output) } : {}),
    provider: values.provider,
    attention: values.attention,
    model: values.model,
    resume: values.resume,
  };
};
const files = (path: string): string[] => {
  const details = lstatSync(path);
  if (details.isSymbolicLink())
    throw new Error(`Source must not be a symlink: ${path}`);
  return details.isDirectory()
    ? readdirSync(path)
        .sort()
        .flatMap((name: string): string[] => files(join(path, name)))
    : [path];
};
export const source = (project: Project.Project): string => {
  const digest = createHash("sha256").update(
    JSON.stringify({ adapter: project.adapter, settings: project.settings }),
  );
  for (const path of project.sources.flatMap((entry: string): string[] =>
    files(join(project.root, entry)),
  ))
    digest.update(path.slice(project.root.length)).update(readFileSync(path));
  return digest.digest("hex");
};
const command = async (args: string[], cwd: string): Promise<string> => {
  const child = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: Protocol.REQUEST_MS,
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${args.slice(0, 2).join(" ")} failed: ${errors.trim()}`);
  return output.trim();
};
export const revision = async (
  project: Project.Project,
  runtime?: Docker.Runtime,
  request: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): Promise<string> => {
  if (project.revision === "target")
    return Project.checkTarget(project, request);
  if (project.revision === "source") {
    const current: string = source(project);
    if (runtime && runtime.revision !== current)
      throw new Error(
        "Project source changed since the QA image build; rebuild the project image",
      );

    return current;
  }
  if (runtime) return Protocol.revision.parse(runtime.revision);
  if (
    await command(
      ["git", "status", "--porcelain", "--untracked-files=normal"],
      project.root,
    )
  )
    throw new Error("Git revision verification requires a clean checkout");

  return Protocol.revision.parse(
    await command(["git", "rev-parse", "HEAD"], project.root),
  );
};
export const container = (
  input: Options,
  run: Protocol.Run,
  directory: string,
  credential: string,
  image: string,
  bridge: { url: string; token: string },
): string[] => {
  const identity = Docker.user(
    process.getuid?.() ?? 0,
    process.getgid?.() ?? 0,
  );
  const args: string[] = [
    "docker",
    "run",
    "--rm",
    "--init",
    "--name",
    run.id,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit",
    String(CONFIG.processLimit),
    "--memory",
    CONFIG.memory,
    "--shm-size",
    CONFIG.sharedMemory,
    "--tmpfs",
    `/tmp:rw,nosuid,size=${CONFIG.temporaryMemory}`,
    "--tmpfs",
    `/app/uploads:rw,nosuid,size=${CONFIG.temporaryMemory},mode=1777`,
    "--user",
    `${identity.uid}:${identity.gid}`,
  ];
  if (input.runtime) {
    args.push(
      "--network",
      input.runtime.network,
      "--label",
      `${CONFIG.controller.label}=${input.runtime.owner}`,
      "--mount",
      Docker.mount(input.runtime, join(directory, "output"), "/output"),
      "--mount",
      Docker.mount(input.runtime, join(directory, "input"), "/input", true),
    );
  } else {
    args.push(
      "--mount",
      `type=bind,src=${join(directory, "output")},dst=/output`,
      "--mount",
      `type=bind,src=${join(directory, "project.json")},dst=/project.json,readonly`,
      "--mount",
      `type=bind,src=${join(directory, "assignment.json")},dst=/assignment.json,readonly`,
    );
  }
  if (!input.runtime && process.platform === "linux")
    args.push("--add-host", "host.docker.internal:host-gateway");
  const env: Record<string, string> = {
    QA_DISPOSABLE: "1",
    QA_RUN_ID: run.id,
    QA_TESTER_ID: "tester-1",
    QA_SCENARIO: run.scenario,
    QA_MODE: run.mode,
    QA_BUDGET_SECONDS: String(input.seconds),
    QA_COMMIT: run.revision,
    QA_BRIDGE_URL: bridge.url,
    QA_BRIDGE_TOKEN: bridge.token,
  };
  if (input.model) env.QA_MODEL = input.model;
  if (input.runtime) {
    env.QA_PROJECT_PATH = "/input/project.json";
    env.QA_ASSIGNMENT_PATH = "/input/assignment.json";
  }
  for (const [key, value] of Object.entries(env))
    args.push("--env", `${key}=${value}`);
  if (run.mode !== "smoke" && input.runtime)
    args.push(
      "--mount",
      Docker.mount(input.runtime, credential, "/credential"),
    );
  if (run.mode !== "smoke" && !input.runtime)
    args.push("--mount", `type=bind,src=${credential},dst=/credential`);
  args.push(image, "worker");
  return args;
};
export const journal = async (
  directory: string,
  value: string,
): Promise<void> => {
  const temporary: string = join(directory, "recovery.json.next");
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, join(directory, "recovery.json"));
};
const recoverySchema = z.object({
  isolated: z.boolean().optional(),
  run: Protocol.begin,
  finish: Protocol.finish.optional(),
  report: z.record(z.string(), z.unknown()).optional(),
  selection: z
    .object({
      ticket: z.unknown().nullable(),
      deployment: Protocol.finish.shape.deployment,
      result: Protocol.finish.nullable(),
    })
    .optional(),
  project: Project.schema.optional(),
  error: z.string().optional(),
});
export const recover = async (
  client: Client.Client,
  directory: string,
): Promise<Protocol.Finish> => {
  const stored = recoverySchema.parse(
    JSON.parse(await readFile(join(directory, "recovery.json"), "utf8")),
  );
  const original: Protocol.Run = await client.request(
    "/runs",
    "POST",
    stored.run,
  );
  const output: string = stored.isolated
    ? join(directory, "output")
    : directory;
  let conclusion: Protocol.Finish | undefined = stored.finish;
  if (!conclusion) {
    const ids: Map<string, number> = await Lifecycle.artifacts(
      client,
      original.id,
      output,
    );
    if (stored.report && stored.selection) {
      try {
        conclusion = await Lifecycle.publication(
          stored.report,
          original,
          output,
          ids,
          stored.selection as Lifecycle.Plan,
          stored.project?.root,
        );
      } catch (error: unknown) {
        conclusion = {
          ...Lifecycle.result(String(error), "none", "failed"),
          evidence: [...ids.values()],
        };
      }
    } else
      conclusion = {
        ...Lifecycle.result(
          stored.error ?? "QA run interrupted before completion",
          "none",
          "failed",
        ),
        evidence: [...ids.values()],
      };
    await journal(directory, JSON.stringify({ ...stored, finish: conclusion }));
  }
  if (!original.receipt && stored.project?.revision === "target") {
    try {
      await Project.checkTarget(stored.project);
    } catch (error: unknown) {
      conclusion = {
        ...conclusion,
        status: "partial",
        verdict: original.mode === "verify" ? "waiting" : "none",
        summary: `Target deployment changed or became unavailable before publication: ${String(error)}`,
        findings: [],
        matching: undefined,
        deployment: null,
      };
      await journal(
        directory,
        JSON.stringify({ ...stored, finish: conclusion }),
      );
    }
  }
  if (
    !original.receipt &&
    original.mode === "verify" &&
    ["pass", "fail"].includes(conclusion.verdict)
  ) {
    let current: string | null = null;
    try {
      current = stored.project
        ? await Lifecycle.deployed(stored.project)
        : null;
    } catch {
      current = null;
    }
    if (current !== conclusion.deployment?.deployed) {
      conclusion = {
        ...conclusion,
        status: "partial",
        verdict: "waiting",
        summary: "Deployment changed or became unavailable before publication.",
        deployment: null,
      };
      await journal(
        directory,
        JSON.stringify({ ...stored, finish: conclusion }),
      );
    }
  }
  if (
    !original.receipt &&
    original.mode === "discover" &&
    conclusion.matching &&
    original.expires > Date.now()
  )
    await client.request(`/runs/${original.id}/publication`, "POST", {});
  const publication = await client.request<{
    run: Protocol.Run;
    held?: string;
  }>(`/runs/${original.id}/finish`, "POST", conclusion);
  if (publication.held)
    return { ...conclusion, status: "partial", summary: publication.held };
  if (publication.run.status === "superseded")
    return {
      ...conclusion,
      status: "partial",
      verdict: original.mode === "verify" ? "waiting" : "none",
      summary:
        "The claim expired or its card changed. This result does not change the ticket.",
      findings: [],
      deployment: null,
    };
  return conclusion;
};
export const validate = (input: Options): void => {
  if (input.mode !== "smoke") {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN)
      throw new Error(
        "Missing CLAUDE_CODE_OAUTH_TOKEN for guided Quaz reviews",
      );
  }
  if (input.project.includes(",") || input.project.includes("\n"))
    throw new Error("Docker paths must not contain commas or newlines");
};
export const run = async (
  input: Options,
  signal?: AbortSignal,
): Promise<string[]> => {
  const started: number = Date.now();
  const project: Project.Project = Project.load(input.project);
  const client: Client.Client = Client.connect(
    input.url,
    input.board,
    process.env.QUAZ_TRACKER_TOKEN ?? "",
  );
  if (input.resume) {
    const stored = recoverySchema.parse(
      JSON.parse(await readFile(join(input.resume, "recovery.json"), "utf8")),
    );
    const conclusion: Protocol.Finish = await recover(client, input.resume);
    if (conclusion.status !== "complete")
      throw new Error(
        `QA resume remains ${conclusion.status}: ${conclusion.summary}. Evidence: ${input.resume}`,
      );
    await rm(input.resume, { recursive: true });
    return [`${input.url}/${input.board} (run ${stored.run.id})`];
  }
  validate(input);
  const fingerprint: string = source(project);
  const selectedRevision: string = await revision(project, input.runtime);
  const temporary: string =
    input.runtime?.directory ?? input.output ?? join(ROOT, "artifacts/qa");
  await mkdir(temporary, { recursive: true });
  const scratch: string = await mkdtemp(join(temporary, "temporary-"));
  const prefix: string = `qa-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const records: Protocol.Run[] = [];
  const attempts: string[] = [];
  const image: string =
    input.runtime?.image ??
    (project.revision === "target"
      ? await Image.base()
      : `${CONFIG.image}:${fingerprint.slice(0, 16)}`);
  const names: Set<string> = new Set();
  const endpoints: Map<string, { run: Protocol.Run }> = new Map();
  const bridge = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    maxRequestBodySize: 4096,
    fetch: async (request: Request): Promise<Response> => {
      const authority = endpoints.get(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
      );
      if (!authority) return new Response("Unauthorized", { status: 401 });
      try {
        const path: string = new URL(request.url).pathname;
        if (path === "/catalog" && request.method === "GET")
          return Response.json(
            await client.request(
              `/catalog?project=${encodeURIComponent(project.id)}`,
            ),
          );
        if (
          path === "/publication" &&
          request.method === "POST" &&
          authority.run.mode === "discover"
        )
          return Response.json(
            await client.request(
              `/runs/${authority.run.id}/publication`,
              "POST",
              {},
            ),
          );
        if (path === "/flows" && request.method === "GET")
          return Response.json(
            (
              await client.request<Protocol.State>(
                `/state?project=${encodeURIComponent(project.id)}`,
              )
            ).flows,
          );
        if (
          path === "/claim" &&
          request.method === "POST" &&
          authority.run.mode === "discover"
        ) {
          const body = z
            .object({ key: Protocol.key, goal: z.string().min(1).max(500) })
            .strict()
            .parse(await request.json());
          return Response.json(
            await client.request(
              `/runs/${authority.run.id}/claim`,
              "POST",
              body,
            ),
          );
        }
        return new Response("Not found", { status: 404 });
      } catch {
        return new Response("Coverage unavailable", { status: 503 });
      }
    },
  });
  const cleanup = async (): Promise<void> => {
    await Promise.all(
      [...names].map(async (name: string): Promise<void> => {
        const child = Bun.spawn(["docker", "rm", "-f", name], {
          stdout: "ignore",
          stderr: "ignore",
          timeout: Protocol.REQUEST_MS,
        });
        await child.exited;
      }),
    );
    bridge.stop(true);
  };
  let cancelled: boolean = false;
  let build: Pick<Bun.Subprocess, "kill"> | undefined;
  const active = (): void => {
    if (cancelled || signal?.aborted) throw new Error("QA run interrupted");
  };
  const interrupted = (): void => {
    cancelled = true;
    build?.kill();
    void cleanup();
  };
  if (signal) signal.addEventListener("abort", interrupted, { once: true });
  else {
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
  }
  let success: boolean = false;
  try {
    for (let index: number = 0; index < input.testers; index++) {
      active();
      const began: Protocol.Begin = {
        id: `${prefix}-${index + 1}`,
        project: project.id,
        mode: input.mode,
        revision: selectedRevision,
        scenario: input.scenarios[index % input.scenarios.length],
        ...(input.attention ? { attention: input.attention } : {}),
      };
      const directory: string = join(scratch, began.id);
      await mkdir(join(directory, "output"), { recursive: true });
      await journal(
        directory,
        JSON.stringify({
          isolated: true,
          run: began,
          error: "QA run interrupted before completion",
        }),
      );
      attempts.push(directory);
      records.push(await client.request<Protocol.Run>("/runs", "POST", began));
    }
    active();
    await command(
      ["docker", "info", "--format", "{{.ServerVersion}}"],
      project.root,
    );
    if (!input.runtime && project.revision !== "target") {
      console.log(`Preparing ${project.id} QA image`);
      active();
      const base: string = await Image.base();
      const context: string = await Image.stage(project, scratch);
      if (source({ ...project, root: context }) !== fingerprint)
        throw new Error(
          "Staged QA image source differs from the project source",
        );
      const preparation = Bun.spawn(
        Image.args(project, selectedRevision, image, context, base),
        {
          cwd: project.root,
          stdout: Bun.file(join(scratch, "build.log")),
          stderr: Bun.file(join(scratch, "build-error.log")),
        },
      );
      build = preparation;
      if ((await preparation.exited) !== 0)
        throw new Error(`QA image build failed; ${scratch}/build-error.log`);
      if (source(project) !== fingerprint)
        throw new Error("Source changed during the build");
    }
    active();
    const dockerContext: string = input.runtime
      ? ""
      : await command(["docker", "context", "show"], project.root);
    const hostname: string = input.runtime
      ? "qa-controller"
      : process.platform === "darwin" && dockerContext.includes("colima")
        ? "host.lima.internal"
        : "host.docker.internal";
    const outcomes = await Promise.allSettled(
      records.map(
        async (record: Protocol.Run, index: number): Promise<string> => {
          const directory: string = join(scratch, record.id);
          const credential: string = join(scratch, `credential-${index}`);
          const output: string = join(directory, "output");
          await mkdir(credential, { mode: 0o700 });
          const began: Protocol.Begin = {
            id: record.id,
            project: record.project,
            mode: record.mode,
            revision: record.revision,
            scenario: record.scenario,
            ...(record.attention ? { attention: record.attention } : {}),
          };
          await journal(
            directory,
            JSON.stringify({
              isolated: true,
              run: began,
              error: "QA run interrupted before completion",
            }),
          );
          let selection: Lifecycle.Plan = {
            ticket: null,
            deployment: null,
            result: null,
          };
          let conclusion: Protocol.Finish | undefined;

          const bridgeToken: string = randomUUID();
          endpoints.set(bridgeToken, { run: record });
          try {
            active();
            await client.request(`/runs/${record.id}/ready`, "POST", {});
            selection = await Lifecycle.plan(
              client,
              record,
              project,
              input.tickets,
            );
            active();
            if (selection.result) {
              conclusion = selection.result;
              await journal(
                directory,
                JSON.stringify({
                  isolated: true,
                  run: began,
                  finish: conclusion,
                }),
              );
            } else {
              await writeFile(
                join(directory, "project.json"),
                JSON.stringify(project),
              );
              await writeFile(
                join(directory, "assignment.json"),
                JSON.stringify(selection.ticket?.test ?? null),
              );
              await writeFile(
                join(output, "manifest.json"),
                JSON.stringify({
                  run: record.id,
                  project: project.id,
                  revision: selectedRevision,
                  source: fingerprint,
                  image,
                  mode: record.mode,
                  provider: input.provider,
                  config: CONFIG,
                }),
              );
              if (input.runtime) {
                await mkdir(join(directory, "input"));
                await copyFile(
                  join(directory, "project.json"),
                  join(directory, "input/project.json"),
                );
                await copyFile(
                  join(directory, "assignment.json"),
                  join(directory, "input/assignment.json"),
                );
              }
              if (input.mode !== "smoke") {
                await writeFile(
                  join(credential, "token"),
                  process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
                  {
                    mode: 0o600,
                  },
                );
              }
              if (process.getuid?.() === 0) {
                const worker = Docker.user(0, 0);
                await chown(output, worker.uid, worker.gid);
                await chown(credential, worker.uid, worker.gid);
                if (input.mode !== "smoke")
                  await chown(
                    join(credential, "token"),
                    worker.uid,
                    worker.gid,
                  );
              }
              active();
              names.add(record.id);
              console.log(
                `${record.id}: ${record.mode}, ${selection.ticket?.test.scenario ?? record.scenario}`,
              );
              const selected: Protocol.Run = {
                ...record,
                scenario: selection.ticket?.test.scenario ?? record.scenario,
              };
              const child = Bun.spawn(
                container(input, selected, directory, credential, image, {
                  url: `http://${hostname}:${bridge.port}`,
                  token: bridgeToken,
                }),
                {
                  cwd: project.root,
                  stdout: Bun.file(join(output, "worker.log")),
                  stderr: Bun.file(join(output, "worker-error.log")),
                },
              );
              const timer = setTimeout(
                (): void => {
                  void command(
                    ["docker", "rm", "-f", record.id],
                    project.root,
                  ).catch((error: unknown): void =>
                    console.error(String(error)),
                  );
                },
                (input.seconds + CONFIG.cleanupSeconds) * MILLISECONDS,
              );
              let code: number;
              try {
                code = await child.exited;
              } finally {
                clearTimeout(timer);
              }
              if (code !== 0) {
                const path: string = join(output, "report.json");
                const failure = existsSync(path)
                  ? z
                      .object({ error: z.string().optional() })
                      .safeParse(JSON.parse(await readFile(path, "utf8")))
                  : null;
                const stderr: string = await readFile(
                  join(output, "worker-error.log"),
                  "utf8",
                );
                throw new Error(
                  `QA worker exited ${code}: ${failure?.success ? (failure.data.error ?? (stderr.trim() || "incomplete work cannot verify a card")) : stderr.trim() || "incomplete work cannot verify a card"}. Log: ${join(output, "worker-error.log")}`,
                );
              }
              const report = z
                .record(z.string(), z.unknown())
                .parse(
                  JSON.parse(
                    await readFile(join(output, "report.json"), "utf8"),
                  ),
                );
              if (
                report.runId !== record.id ||
                report.mode !== record.mode ||
                report.commit !== record.revision
              )
                throw new Error("Worker report belongs to different inputs");
              await journal(
                directory,
                JSON.stringify({
                  isolated: true,
                  run: began,
                  report,
                  selection,
                  project,
                }),
              );
            }
          } catch (error: unknown) {
            await writeFile(
              join(output, "failure.json"),
              JSON.stringify({ error: String(error) }),
            );
            await journal(
              directory,
              JSON.stringify({
                isolated: true,
                run: began,
                error: String(error),
              }),
            );
          } finally {
            endpoints.delete(bridgeToken);
            await rm(credential, { recursive: true, force: true });
          }
          conclusion = await recover(client, directory);
          if (!conclusion) throw new Error("QA run has no outcome");
          if (conclusion.status === "failed")
            throw new Error(conclusion.summary);
          await rm(directory, { recursive: true });
          return `${input.url}/${input.board} (run ${record.id})`;
        },
      ),
    );
    const failures = outcomes.filter(
      (outcome): boolean => outcome.status === "rejected",
    );
    if (failures.length)
      throw new Error(
        `${failures.length} QA run(s) failed: ${failures.flatMap((outcome): string[] => (outcome.status === "rejected" ? [String(outcome.reason)] : [])).join("; ")}. Temporary recovery files: ${scratch}`,
      );
    success = true;
    console.log(
      `QA duration: ${((Date.now() - started) / MILLISECONDS).toFixed(1)} seconds`,
    );
    return outcomes.flatMap((outcome): string[] =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
  } catch (error: unknown) {
    for (const directory of attempts) {
      const path: string = join(directory, "recovery.json");
      if (!existsSync(path)) continue;
      try {
        const stored = recoverySchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
        if (!stored.finish && !stored.report)
          await journal(
            directory,
            JSON.stringify({ ...stored, error: String(error) }),
          );
        for (const name of ["build.log", "build-error.log"])
          if (existsSync(join(scratch, name)))
            await copyFile(
              join(scratch, name),
              join(directory, "output", name),
            );
        const conclusion: Protocol.Finish = await recover(client, directory);
        if (conclusion.status !== "failed")
          await rm(directory, { recursive: true });
      } catch (recoveryError: unknown) {
        console.error(
          `QA publication needs --resume ${directory}: ${String(recoveryError)}`,
        );
      }
    }
    throw error;
  } finally {
    await cleanup();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    signal?.removeEventListener("abort", interrupted);
    if (success) await rm(scratch, { recursive: true, force: true });
  }
};
if (import.meta.main) {
  try {
    console.log((await run(options(process.argv.slice(2)))).join("\n"));
  } catch (error: unknown) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
