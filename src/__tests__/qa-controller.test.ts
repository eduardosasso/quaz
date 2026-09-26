import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Client from "@qa/client";
import * as Controller from "@qa/controller";
import * as Docker from "@qa/docker";
import * as Lifecycle from "@qa/lifecycle";
import type * as Project from "@qa/project";
import * as Runner from "@qa/run";
import * as Protocol from "@/qa_protocol";

const REVISION: string = "a".repeat(40);
const PROJECT_FILE: string = join(
  import.meta.dir,
  "../../examples/project.json",
);
const PROJECT: Project.Project = {
  id: "sample-app",
  root: ".",
  dockerfile: "Dockerfile",
  sources: ["app.ts"],
  adapter: "/app/adapter.ts",
  context: [],
  settings: {},
  scenarios: ["empty", "typical", "busy"],
  revision: "source",
};
const NOW: number = 10_000_000;
const run = (
  time: number,
  changes: Partial<Protocol.Run> = {},
): Protocol.Run => ({
  id: `qa-${time}-test`,
  project: PROJECT.id,
  mode: "discover",
  revision: REVISION,
  runner: null,
  scenario: "empty",
  note_id: 1,
  board_id: 1,
  owner: "tester",
  status: "complete",
  expires: time + Protocol.LEASE_SECONDS * 1000,
  target: null,
  snapshot: null,
  receipt: "receipt",
  ...changes,
});
const ticket = (id: number): Protocol.Ticket => ({
  id,
  version: 1,
  content: "test",
  description: "",
  tags: "qa,needs-verification",
  fix: REVISION,
  test: {
    flow: "sample-flow",
    route: "/",
    steps: ["Save"],
    expected: "Saved",
    scenario: "empty",
  },
});
const state = (changes: Partial<Protocol.State> = {}): Protocol.State => ({
  runs: [],
  tickets: [],
  flows: [],
  ...changes,
});
const settings = (
  changes: Partial<Controller.Settings> = {},
): Controller.Settings =>
  Controller.schema.parse({ project: "sample", ...changes });
const plans = (
  input: Protocol.State,
  config: Partial<Controller.Settings> = {},
  active: Controller.Job[] = [],
): Controller.Job[] =>
  Controller.plans(settings(config), PROJECT, input, REVISION, active, NOW);

describe("QA controller scheduling", (): void => {
  test("supports ten workers and rejects invalid limits", (): void => {
    expect(plans(state(), { parallel: 10 })).toHaveLength(10);
    for (const parallel of [0, 11, 1.5])
      expect((): unknown => settings({ parallel })).toThrow();
  });
  test("verification uses free slots before discovery", (): void => {
    const selected: Controller.Job[] = plans(
      state({ tickets: [ticket(2)] }),
      { parallel: 3 },
      [{ mode: "discover", scenario: "empty" }],
    );
    expect(selected).toEqual([
      { mode: "verify", scenario: "empty", ticket: 2 },
    ]);
    expect(plans(state({ tickets: [ticket(2)] }), { parallel: 2 })).toEqual([
      { mode: "verify", scenario: "empty", ticket: 2 },
      { mode: "discover", scenario: "empty" },
    ]);
  });
  test("active verification and remote leases prevent duplicate work", (): void => {
    const input: Protocol.State = state({
      tickets: [ticket(2), ticket(3)],
      flows: [
        {
          key: "ticket-3",
          goal: "Saved",
          run: "another",
          expires: NOW + 1,
          status: "partial",
        },
      ],
    });
    expect(
      plans(input, { mode: "verify", parallel: 3 }, [
        { mode: "verify", scenario: "empty", ticket: 2 },
      ]),
    ).toEqual([]);
  });
  test("discovery timing survives a controller restart", (): void => {
    expect(plans(state({ runs: [run(NOW - 1000)] }))).toEqual([]);
    expect(plans(state({ runs: [run(NOW - 301_000)] }))).toHaveLength(2);
  });
  test("failures wait and stop at the attempt limit", (): void => {
    expect(
      plans(state({ runs: [run(NOW - 1000, { status: "failed" })] })),
    ).toEqual([]);
    expect(
      plans(state({ runs: [run(NOW - 31_000, { status: "failed" })] })),
    ).toHaveLength(2);
    expect(
      plans(
        state({
          runs: [1, 2, 3].map(
            (index): Protocol.Run =>
              run(NOW - 31_000 * index, { status: "failed" }),
          ),
        }),
      ),
    ).toEqual([]);
    expect(
      plans(
        state({
          runs: [run(NOW, { revision: "b".repeat(40), status: "failed" })],
        }),
      ),
    ).toHaveLength(2);
  });
  test("scenarios rotate after the global history fills", (): void => {
    const input: Protocol.State = state({
      runs: Array.from(
        { length: 100 },
        (_value, index): Protocol.Run => run(index, { scenario: "busy" }),
      ),
    });
    expect(plans(input).map((job): string => job.scenario)).toEqual([
      "empty",
      "typical",
    ]);
    input.runs[0].scenario = "typical";
    expect(plans(input).map((job): string => job.scenario)).toEqual([
      "busy",
      "empty",
    ]);
  });
  test("explicit modes remain independent", (): void => {
    expect(plans(state(), { mode: "verify" })).toEqual([]);
    expect(
      plans(state({ tickets: [ticket(2)] }), { mode: "discover" }).every(
        (job): boolean => job.mode === "discover",
      ),
    ).toBe(true);
    expect(
      plans(state(), { mode: "smoke" }).every(
        (job): boolean => job.mode === "smoke",
      ),
    ).toBe(true);
  });
});

describe("QA controller execution", (): void => {
  test("parallel limit holds as six jobs finish", async (): Promise<void> => {
    let running: number = 0;
    let peak: number = 0;
    let count: number = 0;
    await Controller.loop(
      settings({ parallel: 3, runs: 6 }),
      PROJECT,
      REVISION,
      new AbortController().signal,
      {
        state: async (): Promise<Protocol.State> => state(),
        recover: async (): Promise<void> => {},
        now: (): number => NOW,
        wait: async (): Promise<void> => {
          await Bun.sleep(5);
        },
        log: (): void => {},
        execute: async (): Promise<void> => {
          running++;
          count++;
          peak = Math.max(peak, running);
          await Bun.sleep(10);
          running--;
        },
      },
    );
    expect(count).toBe(6);
    expect(peak).toBe(3);
    expect(running).toBe(0);
  });
  test("unrecorded execution failures have bounded retries", async (): Promise<void> => {
    let calls: number = 0;
    let now: number = NOW;
    const times: number[] = [];
    await expect(
      Controller.loop(
        settings({ parallel: 1, attempts: 3, retrySeconds: 2, pollSeconds: 1 }),
        PROJECT,
        REVISION,
        new AbortController().signal,
        {
          state: async (): Promise<Protocol.State> => state(),
          recover: async (): Promise<void> => {},
          now: (): number => now,
          wait: async (milliseconds: number): Promise<void> => {
            now += milliseconds;
            await Bun.sleep(0);
          },
          log: (): void => {},
          execute: async (): Promise<void> => {
            calls++;
            times.push(now);
            throw new Error("Cannot start");
          },
        },
      ),
    ).rejects.toThrow("retry limit");
    expect(calls).toBe(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(2000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(2000);
  });
  test("tracking outage stops without launching workers", async (): Promise<void> => {
    let polls: number = 0;
    let executions: number = 0;
    await expect(
      Controller.loop(
        settings({ attempts: 2 }),
        PROJECT,
        REVISION,
        new AbortController().signal,
        {
          state: async (): Promise<Protocol.State> => {
            polls++;
            throw new Error("Offline");
          },
          recover: async (): Promise<void> => {},
          now: (): number => NOW,
          wait: async (): Promise<void> => {},
          log: (): void => {},
          execute: async (): Promise<void> => {
            executions++;
          },
        },
      ),
    ).rejects.toThrow("Offline");
    expect(polls).toBe(2);
    expect(executions).toBe(0);
  });
  test("stop waits for active workers and launches no replacement", async (): Promise<void> => {
    const stop = new AbortController();
    let finished: number = 0;
    await Controller.loop(
      settings({ parallel: 2 }),
      PROJECT,
      REVISION,
      stop.signal,
      {
        state: async (): Promise<Protocol.State> => state(),
        recover: async (): Promise<void> => {},
        now: (): number => NOW,
        wait: async (): Promise<void> => {
          await Bun.sleep(5);
        },
        log: (): void => {},
        execute: async (): Promise<void> => {
          stop.abort();
          await Bun.sleep(10);
          finished++;
        },
      },
    );
    expect(finished).toBe(2);
  });
});

describe("QA Docker boundary", (): void => {
  const runtime: Docker.Runtime = Docker.runtime({
    Id: "controller",
    Image: `sha256:${"a".repeat(64)}`,
    Config: { Labels: { "app.qa.revision": REVISION } },
    HostConfig: {
      Mounts: [{ Type: "volume", Source: "qa-runtime", Target: "/qa" }],
      Binds: null,
    },
    Mounts: [
      { Type: "volume", Name: "qa-runtime", Destination: "/qa", RW: true },
    ],
  });
  test("same pinned image and private mounts", (): void => {
    const args: string[] = Runner.container(
      { ...Runner.options(["--project", PROJECT_FILE]), runtime },
      run(NOW),
      "/qa/temporary-one/run",
      "/qa/temporary-one/credential-0",
      runtime.image,
      { url: "http://qa-controller:3000", token: "scoped" },
    );
    expect(args.slice(-2)).toEqual([runtime.image, "worker"]);
    expect(args).toContain(
      "type=volume,src=qa-runtime,volume-subpath=temporary-one/run/output,dst=/output",
    );
    expect(args).toContain(
      "type=volume,src=qa-runtime,volume-subpath=temporary-one/run/input,dst=/input,readonly",
    );
    expect(args.join(" ")).not.toMatch(
      /docker.sock|OVERDEW_QA_TOKEN|dst=\/qa|dst=\/auth/,
    );
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
  });
  test("mount traversal and missing volumes fail before startup", (): void => {
    for (const path of ["/qa", "/qa/../etc", "/elsewhere", "/qa/bad,name"])
      expect((): string => Docker.mount(runtime, path, "/output")).toThrow();
    expect(
      (): Docker.Runtime =>
        Docker.runtime({
          Id: "controller",
          Image: runtime.image,
          Config: { Labels: {} },
          HostConfig: { Mounts: [], Binds: null },
          Mounts: [],
        }),
    ).toThrow("named volume");
  });
});

describe("QA automatic publication recovery", (): void => {
  let directory: string;
  beforeAll(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), "qa-controller-"));
  });
  afterAll(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  test("lost finish response reuses the original run and preserves pending evidence", async (): Promise<void> => {
    const path: string = join(directory, "temporary-one", "run");
    await mkdir(join(path, "output"), { recursive: true });
    const original: Protocol.Run = run(NOW, {
      status: "running",
      receipt: null,
    });
    const result: Protocol.Finish = Lifecycle.result("Done");
    await Runner.journal(
      path,
      JSON.stringify({
        isolated: true,
        run: Protocol.begin.parse({
          id: original.id,
          project: original.project,
          mode: original.mode,
          revision: original.revision,
          runner: { source: REVISION, image: `sha256:${"b".repeat(64)}` },
          scenario: original.scenario,
        }),
        finish: result,
      }),
    );
    let lost: boolean = true;
    const ids: string[] = [];
    const client: Client.Client = {
      comments: async (): Promise<string[]> => [],
      request: async <T>(
        endpoint: string,
        _method?: string,
        body?: unknown,
      ): Promise<T> => {
        if (endpoint === "/runs") {
          ids.push((body as Protocol.Begin).id);
          return original as T;
        }
        if (lost) {
          lost = false;
          throw new Error("Response lost");
        }
        return {
          run: { ...original, receipt: "done", status: "complete" },
        } as T;
      },
      upload: async (): Promise<number> => {
        throw new Error("No upload");
      },
    };
    await expect(Controller.recovery(client, directory)).rejects.toThrow(
      "Response lost",
    );
    expect(existsSync(join(path, "recovery.json"))).toBe(true);
    expect(
      JSON.parse(await readFile(join(path, "recovery.json"), "utf8")).run.id,
    ).toBe(original.id);
    await Controller.recovery(client, directory);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.every((id): boolean => id === original.id)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
