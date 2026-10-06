import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CONFIG from "@qa/config.json";
import * as Usage from "@qa/usage";
import * as Worker from "@qa/worker";
import * as Protocol from "@/qa_protocol";

const SECOND: number = 1000;

test(
  "active refresh outlasts the normal bridge timeout",
  async (): Promise<void> => {
    const root: string = await mkdtemp(
      join(tmpdir(), "quaz-usage-integration-"),
    );
    let now: number = Date.now();
    let calls: number = 0;
    const snapshot: Usage.Snapshot = {
      five_hour: {
        utilization: 0.1,
        resetsAt: Math.floor(now / SECOND) + 18_000,
      },
      seven_day: {
        utilization: 0.1,
        resetsAt: Math.floor(now / SECOND) + 604_800,
      },
    };
    const store: Usage.Store = await Usage.connect(
      join(root, "usage.json"),
      CONFIG.usage,
      (): void => {},
      async (): Promise<Usage.Report> => {
        calls++;
        if (calls > 1) await Bun.sleep(Protocol.REQUEST_MS + SECOND);
        return { snapshot };
      },
      (): number => now,
    );
    await store.ready();
    await store.begin();
    now += CONFIG.usage.activeProbeSeconds * SECOND;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: Usage.REQUEST_MS / SECOND,
      fetch: async (): Promise<Response> =>
        Response.json({ ...(await store.update()), enabled: true }),
    });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          'import * as Coverage from "@qa/coverage"; console.log(JSON.stringify(await Coverage.budget()));',
        ],
        {
          cwd: join(import.meta.dir, "../../.."),
          env: {
            ...process.env,
            QA_BRIDGE_URL: server.url.origin,
            QA_BRIDGE_TOKEN: "test-bridge",
            QA_DISPOSABLE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: Usage.REQUEST_MS,
        },
      );
      const [output, errors, code]: [string, string, number] =
        await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
      expect(errors).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({
        allowed: true,
        reason: "usage-available",
        enabled: true,
      });
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  Usage.REQUEST_MS + Protocol.REQUEST_MS,
);

test("worker stops an active phase when live usage crosses the reserve", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-integration-"));
  const raw: string = join(root, "events.jsonl");
  const now: number = Date.now();
  const snapshot: Usage.Snapshot = {
    five_hour: {
      utilization: 0.1,
      resetsAt: Math.floor(now / SECOND) + 18_000,
    },
    seven_day: {
      utilization: 0.1,
      resetsAt: Math.floor(now / SECOND) + 604_800,
    },
  };
  const store: Usage.Store = await Usage.connect(
    join(root, "usage.json"),
    CONFIG.usage,
    (): void => {},
    async (): Promise<Usage.Report> => ({ snapshot }),
  );
  await store.ready();
  const id: string = await store.begin();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      expect(request.headers.get("authorization")).toBe("Bearer test-bridge");
      const reading: Usage.Report = Usage.report.parse(await request.json());

      return Response.json({ ...(await store.update(reading)), enabled: true });
    },
  });
  const prior: NodeJS.ProcessEnv = {
    QA_BRIDGE_URL: process.env.QA_BRIDGE_URL,
    QA_BRIDGE_TOKEN: process.env.QA_BRIDGE_TOKEN,
    QA_DISPOSABLE: process.env.QA_DISPOSABLE,
  };
  process.env.QA_BRIDGE_URL = server.url.origin;
  process.env.QA_BRIDGE_TOKEN = "test-bridge";
  process.env.QA_DISPOSABLE = "1";
  const event: string = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      unifiedWindows: {
        ...snapshot,
        seven_day: { ...snapshot.seven_day, utilization: 0.84 },
      },
    },
  });
  const descriptor: number = openSync(raw, "w");
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--no-env-file",
      "-e",
      `console.log(${JSON.stringify(event)}); setInterval(() => {}, 1000);`,
    ],
    { cwd: root, detached: true, stdio: ["ignore", descriptor, "ignore"] },
  );
  closeSync(descriptor);
  try {
    await expect(Worker.guided(child, 10, raw, true)).rejects.toThrow(
      "usage-reserve-seven_day",
    );
    expect(child.signalCode).toBe("SIGTERM");
    expect((await store.update()).allowed).toBe(false);
    await store.finish(id);
    expect((await store.ready()).allowed).toBe(false);
  } finally {
    server.stop(true);
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
