import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Client from "@qa/client";
import * as Image from "@qa/image";
import * as Lifecycle from "@qa/lifecycle";
import type * as Project from "@qa/project";
import * as Review from "@qa/review";
import * as Runner from "@qa/run";
import type * as Protocol from "@/qa_protocol";

const REVISION: string = "a".repeat(40);
const NEXT_REVISION: string = "b".repeat(40);
const RUN: Protocol.Run = {
  id: "verification-run",
  project: "sample-app",
  mode: "verify",
  revision: REVISION,
  runner: null,
  scenario: "new-account",
  note_id: 10,
  board_id: 1,
  owner: "reviewer",
  status: "running",
  expires: Date.now() + 600_000,
  target: null,
  snapshot: null,
  receipt: null,
};
const TICKET: Protocol.Ticket = {
  id: 12,
  version: 3,
  content: "The edited title disappears",
  description: "Reload restores the previous title",
  tags: "qa,needs-verification",
  test: {
    flow: "card-title",
    route: "/cards",
    steps: ["Edit the title", "Reload the page"],
    expected: "The changed title stays",
    scenario: "new-account",
  },
  fix: REVISION,
};
const PROJECT: Project.Project = {
  id: "sample-app",
  root: ".",
  dockerfile: "Dockerfile",
  sources: ["app.ts"],
  adapter: "/app/adapter.ts",
  context: [],
  settings: {},
  scenarios: ["new-account"],
  revision: "source",
};
const client = (tickets: Protocol.Ticket[] = [TICKET]): Client.Client => ({
  comments: async (): Promise<string[]> => [],
  request: async <T>(path: string): Promise<T> => {
    if (path.startsWith("/state?"))
      return { tickets, runs: [], flows: [] } as T;
    if (path.endsWith("/claim")) return { accepted: true } as T;
    throw new Error(`Unexpected request: ${path}`);
  },
  upload: async (): Promise<number> => {
    throw new Error("No upload expected");
  },
});
const probe = async (revision: string): Promise<Lifecycle.Plan> => {
  const transportRequest: typeof fetch = Object.assign(
    async (): Promise<Response> => Response.json({ revision }),
    { preconnect: globalThis.fetch.preconnect },
  );
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    transportRequest,
  );
  try {
    return await Lifecycle.plan(client(), RUN, {
      ...PROJECT,
      deployment: { url: "https://sample.example/version" },
    });
  } finally {
    transport.mockRestore();
  }
};
let directory: string;
let config: string;

describe("QA orchestration boundaries", (): void => {
  beforeAll(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), "overdew-qa-orchestration-"));
    config = join(directory, "project.json");
    await writeFile(config, JSON.stringify(PROJECT));
  });
  afterAll(
    async (): Promise<void> =>
      await rm(directory, { recursive: true, force: true }),
  );

  test("project scenarios supply the default run scenarios", (): void => {
    expect(
      Runner.options(["--project", config, "--mode", "smoke"]).scenarios,
    ).toEqual(PROJECT.scenarios);
  });

  test("matching deployment permits acceptance tests", async (): Promise<void> => {
    const result: Lifecycle.Plan = await probe(REVISION);
    expect(result.result).toBeNull();
    expect(result.deployment).toEqual({
      expected: REVISION,
      deployed: REVISION,
      tested: REVISION,
    });
    expect(result.ticket?.test.scenario).toBe("new-account");
  });

  test("another deployment blocks acceptance tests", async (): Promise<void> => {
    const result: Lifecycle.Plan = await probe(NEXT_REVISION);
    expect(result.result?.verdict).toBe("waiting");
    expect(result.deployment).toBeNull();
  });

  test("malformed deployment blocks acceptance tests", async (): Promise<void> => {
    const result: Lifecycle.Plan = await probe("unknown");
    expect(result.result?.verdict).toBe("waiting");
    expect(result.deployment).toBeNull();
  });

  test("missing fix blocks acceptance tests", async (): Promise<void> => {
    const result: Lifecycle.Plan = await Lifecycle.plan(
      client([{ ...TICKET, fix: null }]),
      RUN,
      PROJECT,
    );
    expect(result.result?.verdict).toBe("blocked");
    expect(result.deployment).toBeNull();
  });

  test("a newer fix PR replaces the previous failed revision", async (): Promise<void> => {
    const binaries: string = join(directory, "bin");
    await mkdir(binaries);
    await writeFile(
      join(binaries, "gh"),
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ state: "MERGED", mergeCommit: { oid: NEXT_REVISION } })}'\n`,
      { mode: 0o700 },
    );
    const child = Bun.spawn(["/bin/sh", join(binaries, "gh")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const process = spyOn(Bun, "spawn").mockReturnValue(child);
    const fixed: unknown[] = [];
    const latest: Client.Client = {
      ...client(),
      comments: async (): Promise<string[]> => [
        "New fix: https://github.com/example/app/pull/2",
      ],
      request: async <T>(
        path: string,
        _method?: string,
        body?: unknown,
      ): Promise<T> => {
        if (path.endsWith("/fix")) {
          fixed.push(body);
          return body as T;
        }
        return await client().request<T>(path);
      },
    };
    const transportRequest: typeof fetch = Object.assign(
      async (): Promise<Response> => Response.json({ revision: NEXT_REVISION }),
      { preconnect: globalThis.fetch.preconnect },
    );
    const transport = spyOn(globalThis, "fetch").mockImplementation(
      transportRequest,
    );
    try {
      const result: Lifecycle.Plan = await Lifecycle.plan(
        latest,
        { ...RUN, revision: NEXT_REVISION },
        {
          ...PROJECT,
          deployment: {
            url: "https://sample.example/version",
            repository: "example/app",
          },
        },
      );
      expect(result.result).toBeNull();
      expect(result.deployment?.expected).toBe(NEXT_REVISION);
      expect(fixed).toEqual([{ revision: NEXT_REVISION }]);
    } finally {
      transport.mockRestore();
      process.mockRestore();
    }
  });

  test("pending recovery rechecks deployment before publishing pass", async (): Promise<void> => {
    const recovery: string = join(directory, "pending-recovery");
    await mkdir(recovery);
    const finish: Protocol.Finish = {
      ...Lifecycle.result("Acceptance checks pass", "pass"),
      evidence: [1],
      deployment: { expected: REVISION, deployed: REVISION, tested: REVISION },
    };
    await writeFile(
      join(recovery, "recovery.json"),
      JSON.stringify({
        run: {
          id: RUN.id,
          project: RUN.project,
          mode: RUN.mode,
          revision: RUN.revision,
          runner: { source: REVISION, image: `sha256:${"b".repeat(64)}` },
          scenario: RUN.scenario,
        },
        finish,
        project: {
          ...PROJECT,
          deployment: { url: "https://sample.example/version" },
        },
      }),
    );
    const pending: Client.Client = {
      ...client(),
      request: async <T>(
        path: string,
        _method?: string,
        body?: unknown,
      ): Promise<T> => {
        if (path === "/runs") return RUN as T;
        if (path.endsWith("/finish")) return { run: RUN, finish: body } as T;
        throw new Error(`Unexpected request: ${path}`);
      },
    };
    const transportRequest: typeof fetch = Object.assign(
      async (): Promise<Response> => Response.json({ revision: NEXT_REVISION }),
      { preconnect: globalThis.fetch.preconnect },
    );
    const transport = spyOn(globalThis, "fetch").mockImplementation(
      transportRequest,
    );
    try {
      const result: Protocol.Finish = await Runner.recover(pending, recovery);
      expect(result.verdict).toBe("waiting");
      expect(result.deployment).toBeNull();
    } finally {
      transport.mockRestore();
    }
  });

  test("containers receive scoped bridge credentials", (): void => {
    const input: Runner.Options = Runner.options([
      "--project",
      config,
      "--scenarios",
      "new-account",
    ]);
    const args: string[] = Runner.container(
      input,
      RUN,
      "/tmp/qa-output",
      "/tmp/qa-credential",
      "qa:test",
      { url: "http://host.docker.internal:12345", token: "scoped-token" },
    );
    const environment: string[] = args.filter(
      (_value: string, index: number): boolean => args[index - 1] === "--env",
    );
    expect(environment).toContain("QA_BRIDGE_TOKEN=scoped-token");
    expect(environment).toContain("QA_SCENARIO=new-account");
    expect(
      environment.some((value: string): boolean =>
        /OVERDEW_QA_TOKEN|R2_|GITHUB_TOKEN|OP_SERVICE_ACCOUNT_TOKEN/.test(
          value,
        ),
      ),
    ).toBe(false);
    expect(
      args.some(
        (value: string): boolean =>
          value.includes("docker.sock") ||
          value.includes("dst=/coordination") ||
          value.includes(".env"),
      ),
    ).toBe(false);
  });

  test("cancellation during planning prevents container launch", async (): Promise<void> => {
    const cancelled: string = join(directory, "cancelled");
    const binaries: string = join(cancelled, "bin");
    const marker: string = join(cancelled, "launched");
    const project: string = join(cancelled, "project.json");
    await mkdir(binaries, { recursive: true });
    await writeFile(join(cancelled, "app.ts"), "export const value = 1;");
    await writeFile(join(cancelled, "Dockerfile"), "FROM scratch");
    await writeFile(project, JSON.stringify(PROJECT));
    await writeFile(
      join(binaries, "docker"),
      `#!/bin/sh\ncase "$1" in\ninfo) echo test ;;\ncontext) echo default ;;\nbuild) exit 0 ;;\nimage) echo sha256:${"b".repeat(64)} ;;\nrun) : > '${marker}'; exit 1 ;;\nesac\n`,
      { mode: 0o700 },
    );
    const spawn: typeof Bun.spawn = Bun.spawn;
    const executable = spyOn(Bun, "spawn").mockImplementation(
      ((...args: Parameters<typeof Bun.spawn>): ReturnType<typeof Bun.spawn> =>
        spawn(
          [join(binaries, "docker"), ...args[0].slice(1)],
          args[1],
        )) as typeof Bun.spawn,
    );
    const records: Protocol.Run[] = [];
    const tracking: Client.Client = {
      comments: async (): Promise<string[]> => [],
      request: async <T>(
        path: string,
        _method?: string,
        body?: unknown,
      ): Promise<T> => {
        if (path === "/runs") {
          const input: Protocol.Begin = body as Protocol.Begin;
          const existing: Protocol.Run | undefined = records.find(
            (record: Protocol.Run): boolean => record.id === input.id,
          );
          if (existing) return existing as T;
          const record: Protocol.Run = { ...RUN, ...input };
          records.push(record);

          return record as T;
        }
        if (path.endsWith("/ready")) return records[0] as T;
        if (path.startsWith("/state?"))
          return { tickets: [], flows: [], runs: records } as T;
        if (path.endsWith("/finish")) {
          const record: Protocol.Run | undefined = records.find(
            (value: Protocol.Run): boolean => path.includes(value.id),
          );
          if (record) record.status = "failed";

          return { run: record, cards: [] } as T;
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      upload: async (): Promise<number> => 1,
    };
    const connection = spyOn(Client, "open").mockResolvedValue(tracking);
    const base = spyOn(Image, "base").mockResolvedValue(
      `quaz:base@sha256:${"b".repeat(64)}`,
    );
    const planning = spyOn(Lifecycle, "plan").mockImplementation(
      async (): Promise<Lifecycle.Plan> => {
        process.emit("SIGINT");

        return { ticket: null, deployment: null, result: null };
      },
    );
    try {
      await expect(
        Runner.run(
          Runner.options([
            "--project",
            project,
            "--mode",
            "smoke",
            "--testers",
            "1",
          ]),
        ),
      ).rejects.toThrow();
      expect(planning).toHaveBeenCalledTimes(1);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      planning.mockRestore();
      base.mockRestore();
      connection.mockRestore();
      executable.mockRestore();
      const artifacts: string = resolve(import.meta.dir, "../../artifacts/qa");
      for (const name of await readdir(artifacts)) {
        const scratch: string = join(artifacts, name);
        for (const record of records) {
          if (
            await Bun.file(join(scratch, record.id, "recovery.json")).exists()
          )
            await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  });

  test("a lost begin response preserves recovery or a final outcome", async (): Promise<void> => {
    const startup: string = join(directory, "startup");
    const binaries: string = join(startup, "bin");
    const project: string = join(startup, "project.json");
    await mkdir(binaries, { recursive: true });
    await writeFile(
      join(binaries, "docker"),
      `#!/bin/sh\ncase "$1" in\ninfo) echo test ;;\ncontext) echo default ;;\nbuild) exit 0 ;;\nimage) echo sha256:${"b".repeat(64)} ;;\nesac\n`,
      { mode: 0o700 },
    );
    const spawn: typeof Bun.spawn = Bun.spawn;
    const executable = spyOn(Bun, "spawn").mockImplementation(
      ((...args: Parameters<typeof Bun.spawn>): ReturnType<typeof Bun.spawn> =>
        spawn(
          [join(binaries, "docker"), ...args[0].slice(1)],
          args[1],
        )) as typeof Bun.spawn,
    );
    await writeFile(join(startup, "app.ts"), "export const value = 1;");
    await writeFile(join(startup, "Dockerfile"), "FROM scratch");
    await writeFile(project, JSON.stringify(PROJECT));
    const records: Protocol.Run[] = [];
    const tracking: Client.Client = {
      comments: async (): Promise<string[]> => [],
      request: async <T>(
        path: string,
        _method?: string,
        body?: unknown,
      ): Promise<T> => {
        if (path === "/runs") {
          const input: Protocol.Begin = body as Protocol.Begin;
          if (!records.some((record): boolean => record.id === input.id))
            records.push({ ...RUN, ...input });
          throw new Error("Begin response lost after server commit");
        }
        if (path.startsWith("/state?"))
          return { tickets: [], flows: [], runs: records } as T;
        if (path.endsWith("/finish")) {
          const record: Protocol.Run | undefined = records.find(
            (value: Protocol.Run): boolean => path.includes(value.id),
          );
          if (record) record.status = "failed";

          return { run: record, cards: [] } as T;
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      upload: async (): Promise<number> => {
        throw new Error("No worker evidence exists");
      },
    };
    const connection = spyOn(Client, "open").mockResolvedValue(tracking);
    const base = spyOn(Image, "base").mockResolvedValue(
      `quaz:base@sha256:${"b".repeat(64)}`,
    );
    try {
      await expect(
        Runner.run(
          Runner.options([
            "--project",
            project,
            "--mode",
            "smoke",
            "--testers",
            "1",
          ]),
        ),
      ).rejects.toThrow("Begin response lost");
      expect(records).toHaveLength(1);
      expect(records[0].runner?.image).toBe(`sha256:${"b".repeat(64)}`);
      const artifacts: string = resolve(import.meta.dir, "../../artifacts/qa");
      let recoverable: boolean = false;
      for (const name of await readdir(artifacts)) {
        const scratch: string = join(artifacts, name);
        if (
          await Bun.file(join(scratch, records[0].id, "recovery.json")).exists()
        ) {
          recoverable = true;
          await rm(scratch, { recursive: true, force: true });
        }
      }
      expect(records[0].status !== "running" || recoverable).toBe(true);
    } finally {
      base.mockRestore();
      connection.mockRestore();
      executable.mockRestore();
    }
  });

  test("evidence upload includes nested reports and screenshots", async (): Promise<void> => {
    const output: string = join(directory, "artifacts");
    await mkdir(join(output, "validator"), { recursive: true });
    await writeFile(
      join(output, "report.json"),
      JSON.stringify({ complete: true }),
    );
    await writeFile(join(output, "validator/screen.png"), "screenshot");
    await writeFile(join(output, "validator/events.jsonl"), "{}\n");
    await writeFile(join(output, "recovery.json"), "private recovery state");
    await writeFile(
      join(output, "assignment.json"),
      "private assignment state",
    );
    const uploaded: string[] = [];
    const store: Client.Client = {
      ...client(),
      upload: async (_run: string, path: string): Promise<number> => {
        uploaded.push(path);
        return uploaded.length;
      },
    };
    const ids: Map<string, number> = await Lifecycle.artifacts(
      store,
      RUN.id,
      output,
    );
    expect(uploaded).toEqual([
      "report.json",
      "validator/events.jsonl.gz",
      "validator/screen.png",
    ]);
    expect(ids.get("validator/screen.png")).toBe(3);
    expect(ids.has("recovery.json")).toBe(false);
  });

  test.each(["yml", "yaml", "txt"])(
    "browser snapshot evidence uploads and links to a finding (%s)",
    async (extension: string): Promise<void> => {
      const output: string = join(directory, `snapshot-${extension}`);
      const screenshot: Buffer = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
        "base64",
      );
      const snapshots: string[] = [];
      for (const phase of ["reviewer", "validator"]) {
        await mkdir(join(output, phase), { recursive: true });
        const image: string = `${phase}/mobile.png`;
        const snapshot: string = `${phase}/page.${extension}`;
        snapshots.push(snapshot);
        await writeFile(join(output, image), screenshot);
        await writeFile(join(output, snapshot), "- button [ref=e1]\n");
        await writeFile(
          join(output, phase, "events.jsonl"),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "mcp_tool_call",
              server: "mobile",
              tool: "browser_take_screenshot",
              status: "completed",
              error: null,
              result: {
                content: [
                  {
                    type: "text",
                    text: `- [Screenshot of viewport](${image})`,
                  },
                  {
                    type: "image",
                    data: screenshot.toString("base64"),
                    mimeType: "image/png",
                  },
                ],
              },
            },
          }),
        );
      }
      const candidate: Review.Candidate = {
        id: "review-name",
        title: "Button lacks an accessible name",
        severity: "P2",
        guide: "audit",
        impact: "The control purpose is unclear",
        steps: ["Open the card and inspect its button names"],
        expected: "The button has a name",
        actual: "The button is unnamed",
        viewport: "390x844",
        evidence: [snapshots[0], "reviewer/mobile.png"],
        acceptance: ["The button has a name"],
        fingerprint: "card-button-name",
      };
      const assessment: Review.Assessment = {
        design: {
          controls: [
            {
              name: "Unnamed button",
              purpose: "Unknown",
              location: "Card",
              treatment: "Icon only",
            },
          ],
          comparisons: [],
          noPeers: "Other controls are not inspected",
          composition: {
            observation: "Only one control inspected",
            alternative: "Unknown",
            tradeoff: "Not assessed",
            verdict: "unknown",
            candidateId: null,
          },
          evidence: ["reviewer/mobile.png"],
        },
        flow: {
          key: "card-open",
          title: "Open a card",
          route: "/cards",
          goal: candidate.expected,
          steps: candidate.steps,
          expected: candidate.expected,
          actual: candidate.actual,
          status: "fail",
          evidence: candidate.evidence,
        },
        guides: Object.fromEntries(
          Review.GUIDES.map(
            (guide): [string, { status: "partial"; note: string }] => [
              guide,
              { status: "partial", note: "Only this control is checked" },
            ],
          ),
        ) as Review.Assessment["guides"],
        critique: Review.HEURISTICS.map((): null => null),
        audit: Review.DIMENSIONS.map((): null => null),
        checks: Review.CHECKS.map((id) => ({
          id,
          status: "blocked",
          actual: "Not measured",
          evidence: ["reviewer/mobile.png"],
        })),
        screenshots: ["reviewer/mobile.png"],
        candidates: [candidate],
        limitations: ["Only this case is checked"],
      };
      const validation: Review.Validation = {
        flowKey: assessment.flow.key,
        status: "partial",
        summary: "The unnamed button is reproduced",
        coverage: { checked: [], unsupported: ["design"] },
        steps: candidate.steps,
        evidence: ["validator/mobile.png"],
        results: [
          {
            candidateId: candidate.id,
            verdict: "confirmed",
            reason: candidate.actual,
            steps: candidate.steps,
            evidence: [snapshots[1], "validator/mobile.png"],
          },
        ],
        limitations: [],
      };
      const uploaded: Array<{ path: string; mime: string }> = [];
      const tracking: Client.Client = {
        ...client(),
        upload: async (
          _run: string,
          path: string,
          _bytes: Uint8Array,
          mime: string,
        ): Promise<number> => {
          uploaded.push({ path, mime });

          return uploaded.length;
        },
      };
      const run: Protocol.Run = { ...RUN, mode: "discover" };
      const ids: Map<string, number> = await Lifecycle.artifacts(
        tracking,
        run.id,
        output,
      );
      const published: Protocol.Finish = await Lifecycle.publication(
        {
          status: "partial",
          audit: { status: "complete" },
          assessment,
          validation,
          matching: {
            snapshot: "a".repeat(64),
            decisions: [
              {
                fingerprint: Lifecycle.fingerprint(
                  run.project,
                  assessment.flow.key,
                  candidate.title,
                  candidate.expected,
                ),
                verdict: "new",
                target: null,
                sameAs: null,
                reason: "No matching card",
              },
            ],
          },
        },
        run,
        output,
        ids,
        { ticket: null, deployment: null, result: null },
      );
      const held: Protocol.Finish = await Lifecycle.publication(
        {
          status: "partial",
          audit: { status: "complete" },
          assessment,
          validation,
          matchingError: "Comparison timed out",
        },
        run,
        output,
        ids,
        { ticket: null, deployment: null, result: null },
      );
      const blocked: Protocol.Finish = await Lifecycle.publication(
        {
          status: "partial",
          audit: { status: "complete" },
          assessment,
          validation: { ...validation, status: "blocked" },
          matching: published.matching,
        },
        run,
        output,
        ids,
        { ticket: null, deployment: null, result: null },
      );
      expect(held.status).toBe("partial");
      expect(held.summary).toContain("unpublished");
      expect(held.findings).toEqual([]);
      expect(held.report.unpublished).toHaveLength(1);
      expect(blocked.status).toBe("partial");
      expect(blocked.summary).toContain("validation is blocked");
      expect(blocked.findings).toEqual([]);
      expect(published.findings).toHaveLength(1);
      expect(published.status).toBe("partial");
      for (const snapshot of snapshots) {
        expect(uploaded).toContainEqual({ path: snapshot, mime: "text/plain" });
        expect(ids.has(snapshot)).toBe(true);
        const attachment: number | undefined = ids.get(snapshot);
        if (attachment === undefined)
          throw new Error("Snapshot is not uploaded");
        expect(published.findings[0].evidence).toContain(attachment);
      }
    },
  );
});
