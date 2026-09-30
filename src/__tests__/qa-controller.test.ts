import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Backoff from "@qa/backoff";
import type * as Client from "@qa/client";
import CONFIG from "@qa/config.json";
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
  fetch: false,
};
const NOW: number = 10_000_000;
const RUNAWAY: number = 50;
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
  test("interrupted run does not use the retry budget", (): void => {
    const config: Controller.Settings = settings();
    const history: Protocol.Run[] = Array.from(
      { length: config.attempts + 1 },
      (_, index): Protocol.Run =>
        run(NOW - 301_000 * (index + 1), { status: Protocol.INTERRUPTED }),
    );
    expect(Controller.available(history, config, NOW)).toBe(true);
    expect(
      Controller.available(
        [
          run(NOW - 301_000, { status: Protocol.INTERRUPTED }),
          ...history.map(
            (item): Protocol.Run => ({ ...item, status: "failed" }),
          ),
        ].slice(0, config.attempts),
        config,
        NOW,
      ),
    ).toBe(true);
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
        revision: async (): Promise<string> => REVISION,
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
          revision: async (): Promise<string> => REVISION,
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
          revision: async (): Promise<string> => REVISION,
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
        revision: async (): Promise<string> => REVISION,
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

describe("QA controller revision drift", (): void => {
  const MISMATCH: string =
    "Project checkout does not match the deployed revision";
  const NEXT: string = "b".repeat(40);
  test("checkout mismatch waits with backoff instead of exiting", async (): Promise<void> => {
    const events: Record<string, unknown>[] = [];
    const delays: number[] = [];
    let calls: number = 0;
    const revision: string = await Controller.settle(
      async (): Promise<string> => {
        calls++;
        if (calls <= 3) throw new Error(MISMATCH);

        return NEXT;
      },
      30,
      new AbortController().signal,
      {
        wait: async (milliseconds: number): Promise<void> => {
          delays.push(milliseconds);
          if (delays.length > RUNAWAY) throw new Error("Runaway wait");
        },
        log: (event: Record<string, unknown>): void => {
          events.push(event);
        },
      },
    );
    expect(revision).toBe(NEXT);
    expect(delays).toEqual([30_000, 60_000, 120_000]);
    expect(events.map((event): unknown => event.event)).toEqual([
      "revision-wait",
      "revision-wait",
      "revision-wait",
      "revision-ready",
    ]);
    expect(events[0].error).toContain(MISMATCH);
  });
  test("revision wait stops on shutdown", async (): Promise<void> => {
    const stop = new AbortController();
    let calls: number = 0;
    await expect(
      Controller.settle(
        async (): Promise<string> => {
          if (++calls > RUNAWAY) throw new Controller.Halt("Runaway resolve");
          throw new Error(MISMATCH);
        },
        30,
        stop.signal,
        {
          wait: async (): Promise<void> => {
            stop.abort();
          },
          log: (): void => {},
        },
      ),
    ).rejects.toThrow();
  });
  test("failing source sync waits then recovers", async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), "quaz-follow-"));
    const git = (...args: string[]): string =>
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=QA",
          "-c",
          "user.email=qa@example.test",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: root },
      )
        .stdout.toString()
        .trim();
    git("init", "-q");
    await writeFile(join(root, "app.ts"), "export const app = true;");
    git("add", ".");
    git("commit", "-qm", "fixture");
    const deployed: string = git("rev-parse", "HEAD");
    const events: Record<string, unknown>[] = [];
    let probes: number = 0;
    const project: Project.Project = {
      ...PROJECT,
      root,
      revision: "git",
      fetch: true,
      deployment: { url: "https://app.test/version", repository: "acme/app" },
    };
    try {
      const revision: string = await Controller.follow(
        project,
        30,
        new AbortController().signal,
        {
          wait: async (): Promise<void> => {},
          log: (event: Record<string, unknown>): void => {
            events.push(event);
          },
        },
        async (): Promise<Response> => {
          if (++probes <= 2) throw new Error("Probe unreachable");

          return new Response("{}", {
            headers: { "x-quaz-revision": deployed },
          });
        },
      )();
      expect(revision).toBe(deployed);
      expect(events.map((event): unknown => event.event)).toEqual([
        "revision-wait",
        "revision-wait",
        "revision-ready",
      ]);
      expect(String(events[0].error)).toContain("Probe unreachable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("deployed revision change keeps the loop running", async (): Promise<void> => {
    const events: Record<string, unknown>[] = [];
    const executed: string[] = [];
    const polled: string[] = [];
    let calls: number = 0;
    await Controller.loop(
      settings({ parallel: 1, runs: 2 }),
      PROJECT,
      REVISION,
      new AbortController().signal,
      {
        revision: async (): Promise<string> =>
          Controller.settle(
            async (): Promise<string> => {
              calls++;
              if (calls === 1) return REVISION;
              if (calls <= 5) throw new Error(MISMATCH);

              return NEXT;
            },
            1,
            new AbortController().signal,
            {
              wait: async (): Promise<void> => {},
              log: (event: Record<string, unknown>): void => {
                events.push(event);
              },
            },
          ),
        state: async (revision: string): Promise<Protocol.State> => {
          polled.push(revision);

          return state();
        },
        recover: async (): Promise<void> => {},
        now: (): number => NOW,
        wait: async (): Promise<void> => {
          await Bun.sleep(1);
        },
        log: (event: Record<string, unknown>): void => {
          events.push(event);
        },
        execute: async (
          _job: Controller.Job,
          revision: string,
        ): Promise<void> => {
          executed.push(revision);
          await Bun.sleep(5);
        },
      },
    );
    expect(executed).toEqual([REVISION, NEXT]);
    expect(polled).toContain(NEXT);
    const names: unknown[] = events.map((event): unknown => event.event);
    expect(names).toContain("revision-wait");
    expect(names).toContain("revision-change");
    expect(names).not.toContain("controller-error");
  });
});

describe("QA controller supervision", (): void => {
  const pacing = (
    delays: number[],
    events: Record<string, unknown>[],
    now: () => number = (): number => NOW,
  ): Backoff.Pacing => ({
    now,
    wait: async (milliseconds: number): Promise<void> => {
      delays.push(milliseconds);
      if (delays.length > RUNAWAY) throw new Error("Runaway wait");
    },
    log: (event: Record<string, unknown>): void => {
      events.push(event);
    },
  });
  test("failures restart in process with capped backoff", async (): Promise<void> => {
    const delays: number[] = [];
    const events: Record<string, unknown>[] = [];
    let calls: number = 0;
    await Controller.supervise(
      async (): Promise<void> => {
        calls++;
        if (calls <= 9) throw new Error("Tracker offline");
      },
      60,
      new AbortController().signal,
      pacing(delays, events),
    );
    expect(calls).toBe(10);
    expect(delays.slice(0, 3)).toEqual([60_000, 120_000, 240_000]);
    expect(Math.max(...delays)).toBe(
      CONFIG.controller.maxBackoffSeconds * Backoff.MILLISECONDS,
    );
    expect(
      events.every((event): boolean => event.event === "controller-restart"),
    ).toBe(true);
    expect(events[0].error).toContain("Tracker offline");
  });
  test("halt stops without a restart", async (): Promise<void> => {
    const delays: number[] = [];
    const events: Record<string, unknown>[] = [];
    let calls: number = 0;
    await expect(
      Controller.supervise(
        async (): Promise<void> => {
          calls++;
          throw new Controller.Halt("Worker retry limit reached");
        },
        60,
        new AbortController().signal,
        pacing(delays, events),
      ),
    ).rejects.toThrow("Worker retry limit reached");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
  test("a long healthy run resets the restart backoff", async (): Promise<void> => {
    const delays: number[] = [];
    let now: number = NOW;
    let calls: number = 0;
    await Controller.supervise(
      async (): Promise<void> => {
        calls++;
        now += CONFIG.controller.maxBackoffSeconds * Backoff.MILLISECONDS;
        if (calls <= 3) throw new Error("Tracker offline");
      },
      60,
      new AbortController().signal,
      pacing(delays, [], (): number => now),
    );
    expect(delays).toEqual([60_000, 60_000, 60_000]);
  });
  test("shutdown during a restart wait is not fatal", async (): Promise<void> => {
    const stop = new AbortController();
    let calls: number = 0;
    await Controller.supervise(
      async (): Promise<void> =>
        Controller.settle(
          async (): Promise<string> => {
            calls++;
            throw new Error("Project checkout does not match");
          },
          30,
          stop.signal,
          {
            wait: async (): Promise<void> => {
              stop.abort();
            },
            log: (): void => {},
          },
        ).then((): void => {}),
      60,
      stop.signal,
      pacing([], []),
    );
    expect(calls).toBe(1);
  });
  test("missing tracker token halts", (): void => {
    expect((): string => Controller.trackerToken({})).toThrow(Controller.Halt);
  });
  test("bounded runs with failures halt", async (): Promise<void> => {
    await expect(
      Controller.loop(
        settings({ parallel: 1, runs: 1, attempts: 3 }),
        PROJECT,
        REVISION,
        new AbortController().signal,
        {
          revision: async (): Promise<string> => REVISION,
          state: async (): Promise<Protocol.State> => state(),
          recover: async (): Promise<void> => {},
          now: (): number => NOW,
          wait: async (): Promise<void> => {
            await Bun.sleep(1);
          },
          log: (): void => {},
          execute: async (): Promise<void> => {
            throw new Error("Cannot start");
          },
        },
      ),
    ).rejects.toBeInstanceOf(Controller.Halt);
  });
  test("runs stopped by a revision change do not reach the retry limit", async (): Promise<void> => {
    const stop = new AbortController();
    const events: Record<string, unknown>[] = [];
    let calls: number = 0;
    let clock: number = NOW;
    await Controller.loop(
      settings({ parallel: 1, attempts: 2, retrySeconds: 1 }),
      PROJECT,
      REVISION,
      stop.signal,
      {
        revision: async (): Promise<string> => REVISION,
        state: async (): Promise<Protocol.State> => state(),
        recover: async (): Promise<void> => {},
        now: (): number => {
          clock += 1_000_000;

          return clock;
        },
        wait: async (): Promise<void> => {
          await Bun.sleep(1);
        },
        log: (event: Record<string, unknown>): void => {
          events.push(event);
        },
        execute: async (): Promise<void> => {
          calls++;
          if (calls >= 5) stop.abort();
          throw new Runner.Drift("Project revision changed during the QA run");
        },
      },
    );
    const names: unknown[] = events.map((event): unknown => event.event);
    expect(calls).toBe(5);
    expect(names.filter((name): boolean => name === "run-stale")).toHaveLength(
      5,
    );
    expect(names).not.toContain("run-error");
  });
  test("shutdown interruption is not a failure", async (): Promise<void> => {
    const stop = new AbortController();
    const events: Record<string, unknown>[] = [];
    let calls: number = 0;
    let clock: number = NOW;
    await Controller.loop(
      settings({ parallel: 1, attempts: 2, retrySeconds: 1 }),
      PROJECT,
      REVISION,
      stop.signal,
      {
        revision: async (): Promise<string> => REVISION,
        state: async (): Promise<Protocol.State> => state(),
        recover: async (): Promise<void> => {},
        now: (): number => {
          clock += 1_000_000;

          return clock;
        },
        wait: async (): Promise<void> => {
          await Bun.sleep(1);
        },
        log: (event: Record<string, unknown>): void => {
          events.push(event);
        },
        execute: async (): Promise<void> => {
          calls++;
          if (calls >= 5) stop.abort();
          throw new Runner.Interrupted("QA run interrupted");
        },
      },
    );
    const names: unknown[] = events.map((event): unknown => event.event);
    expect(calls).toBe(5);
    expect(names.filter((name): boolean => name === "run-stale")).toHaveLength(
      5,
    );
    expect(names).not.toContain("run-error");
  });
  test("bounded runs stopped by shutdown do not halt", async (): Promise<void> => {
    await expect(
      Controller.loop(
        settings({ parallel: 1, runs: 1, attempts: 3 }),
        PROJECT,
        REVISION,
        new AbortController().signal,
        {
          revision: async (): Promise<string> => REVISION,
          state: async (): Promise<Protocol.State> => state(),
          recover: async (): Promise<void> => {},
          now: (): number => NOW,
          wait: async (): Promise<void> => {
            await Bun.sleep(1);
          },
          log: (): void => {},
          execute: async (): Promise<void> => {
            throw new Runner.Interrupted("QA run interrupted");
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
  test("bounded runs stopped by a revision change do not halt", async (): Promise<void> => {
    await expect(
      Controller.loop(
        settings({ parallel: 1, runs: 1, attempts: 3 }),
        PROJECT,
        REVISION,
        new AbortController().signal,
        {
          revision: async (): Promise<string> => REVISION,
          state: async (): Promise<Protocol.State> => state(),
          recover: async (): Promise<void> => {},
          now: (): number => NOW,
          wait: async (): Promise<void> => {
            await Bun.sleep(1);
          },
          log: (): void => {},
          execute: async (): Promise<void> => {
            throw new Runner.Drift(
              "Project revision changed during the QA run",
            );
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
  test("a stale run waits before relaunching", async (): Promise<void> => {
    const stop = new AbortController();
    let calls: number = 0;
    setTimeout((): void => stop.abort(), 50);
    await Controller.loop(
      settings({ parallel: 1, retrySeconds: 60 }),
      PROJECT,
      REVISION,
      stop.signal,
      {
        revision: async (): Promise<string> => REVISION,
        state: async (): Promise<Protocol.State> => state(),
        recover: async (): Promise<void> => {},
        now: (): number => NOW,
        wait: async (): Promise<void> => {
          await Bun.sleep(1);
        },
        log: (): void => {},
        execute: async (): Promise<void> => {
          calls++;
          throw new Runner.Drift("Project revision changed during the QA run");
        },
      },
    );
    expect(calls).toBe(1);
  });
  test("worker retry limit halts the controller", async (): Promise<void> => {
    await expect(
      Controller.loop(
        settings({ parallel: 1, attempts: 1 }),
        PROJECT,
        REVISION,
        new AbortController().signal,
        {
          revision: async (): Promise<string> => REVISION,
          state: async (): Promise<Protocol.State> => state(),
          recover: async (): Promise<void> => {},
          now: (): number => NOW,
          wait: async (): Promise<void> => {
            await Bun.sleep(1);
          },
          log: (): void => {},
          execute: async (): Promise<void> => {
            throw new Error("Cannot start");
          },
        },
      ),
    ).rejects.toBeInstanceOf(Controller.Halt);
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

describe("QA interrupted run recovery", (): void => {
  let directory: string;
  beforeAll(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), "qa-interrupted-"));
  });
  afterAll(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  test("interrupted journal finishes as interrupted and is cleared", async (): Promise<void> => {
    const path: string = join(directory, "temporary-one", "run");
    await mkdir(join(path, "output"), { recursive: true });
    const original: Protocol.Run = run(NOW, {
      status: "running",
      receipt: null,
    });
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
        error: "QA run interrupted before completion",
        interrupted: true,
      }),
    );
    const finishes: Protocol.Finish[] = [];
    const client: Client.Client = {
      comments: async (): Promise<string[]> => [],
      request: async <T>(
        endpoint: string,
        _method?: string,
        body?: unknown,
      ): Promise<T> => {
        if (endpoint === "/runs") return original as T;
        if (endpoint.endsWith("/finish")) {
          finishes.push(body as Protocol.Finish);

          return {
            run: {
              ...original,
              receipt: "done",
              status: Protocol.INTERRUPTED,
            },
          } as T;
        }

        return {} as T;
      },
      upload: async (): Promise<number> => {
        throw new Error("No upload");
      },
    };
    await Controller.recovery(client, directory);
    expect(finishes.map((finish): string => finish.status)).toEqual([
      Protocol.INTERRUPTED,
    ]);
    expect(existsSync(path)).toBe(false);
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
