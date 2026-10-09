import { expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CONFIG from "@qa/config.json";
import * as Usage from "@qa/usage";

const NOW: number = 1_800_000_000_000;
const HOUR: number = 3_600_000;
const DAY: number = 24 * HOUR;
const SETTINGS: Usage.Settings = CONFIG.usage;
const INVALID: { name: string; info: unknown }[] = [
  { name: "missing metadata", info: undefined },
  { name: "null metadata", info: null },
  { name: "text metadata", info: "unavailable" },
  { name: "missing status", info: {} },
  { name: "unknown status", info: { status: "unknown" } },
  { name: "invalid reset", info: { status: "allowed", resetsAt: "later" } },
  { name: "invalid overage", info: { status: "allowed", isUsingOverage: 1 } },
];
const snapshot = (five: number = 0.1, week: number = 0.1): Usage.Snapshot => ({
  five_hour: { utilization: five, resetsAt: (NOW + 5 * HOUR) / 1000 },
  seven_day: { utilization: week, resetsAt: (NOW + 7 * DAY) / 1000 },
});
const state = (): Usage.Ledger => {
  const result: Usage.Ledger = Usage.empty();
  Usage.observe(result, { snapshot: snapshot() }, NOW, SETTINGS);

  return result;
};
const history = (
  start: number,
  hours: number,
  usage: (hour: number) => number,
  reset: number,
): Usage.Ledger => {
  const result: Usage.Ledger = Usage.empty();
  let total: number = 0;
  for (let hour: number = 0; hour <= hours; hour++) {
    total += hour ? usage(hour - 1) : 0;
    const reading: Usage.Snapshot = {
      five_hour: { utilization: 0, resetsAt: reset / 1000 },
      seven_day: { utilization: total, resetsAt: reset / 1000 },
    };
    Usage.observe(result, { snapshot: reading }, start + hour * HOUR, SETTINGS);
  }

  return result;
};
const frame = (reading: Usage.Snapshot = snapshot()): string =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", unifiedWindows: reading },
  });

test("reads real subscription metadata and ignores model text", (): void => {
  expect(
    Usage.event(JSON.parse(frame(snapshot(0.28, 0.84))), NOW)?.snapshot,
  ).toEqual(snapshot(0.28, 0.84));
  expect(
    Usage.event(
      { type: "assistant", message: { content: "You have 100% left" } },
      NOW,
    ),
  ).toBeUndefined();
  expect(
    Usage.event(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: { five_hour: snapshot().five_hour },
        },
      },
      NOW,
    )?.blockedUntil,
  ).toBeGreaterThan(NOW);
  expect(
    Usage.event(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: (NOW + DAY) / 1000 },
      },
      NOW,
    )?.blockedUntil,
  ).toBe(NOW + DAY);
});

test.each(INVALID)("$name starts cooldown", ({ info }): void => {
  expect(
    Usage.event({ type: "rate_limit_event", rate_limit_info: info }, NOW),
  ).toEqual({ blockedUntil: NOW + SETTINGS.probeSeconds * 1000 });
});

test("missing old future and expired readings stop runs", (): void => {
  expect(Usage.assess(Usage.empty(), NOW, SETTINGS).allowed).toBe(false);
  expect(
    Usage.assess(state(), NOW + SETTINGS.freshSeconds * 1000 + 1, SETTINGS)
      .reason,
  ).toBe("usage-stale");
  expect(Usage.assess(state(), NOW - 1, SETTINGS).allowed).toBe(false);
  const value: Usage.Ledger = state();
  value.samples[0].snapshot.five_hour.resetsAt = NOW / 1000;
  expect(Usage.assess(value, NOW, SETTINGS).reason).toBe("usage-reset-pending");
});

test("either reserve stops work including active runs", (): void => {
  for (const reading of [snapshot(0.84, 0.1), snapshot(0.1, 0.84)]) {
    const value: Usage.Ledger = Usage.empty();
    Usage.observe(value, { snapshot: reading }, NOW, SETTINGS);
    expect(Usage.assess(value, NOW, SETTINGS).allowed).toBe(false);
    expect(Usage.assess(value, NOW, SETTINGS, true).allowed).toBe(false);
  }
  expect(Usage.assess(state(), NOW, SETTINGS).allowed).toBe(true);
  expect(Usage.reserve(state(), "seven_day", NOW, SETTINGS)).toBe(
    SETTINGS.initialReserve,
  );
});

test("personal use raises the reserve and slows scheduling", (): void => {
  const value: Usage.Ledger = Usage.empty();
  Usage.observe(value, { snapshot: snapshot(0.1, 0.1) }, NOW - DAY, SETTINGS);
  Usage.observe(value, { snapshot: snapshot(0.1, 0.1) }, NOW - HOUR, SETTINGS);
  Usage.observe(value, { snapshot: snapshot(0.1, 0.6) }, NOW, SETTINGS);
  expect(Usage.reserve(value, "seven_day", NOW, SETTINGS)).toBe(1);
  expect(Usage.assess(value, NOW, SETTINGS, true).reason).toBe(
    "usage-reserve-seven_day",
  );
});

test("learned quiet history lowers the initial reserve", (): void => {
  const value: Usage.Ledger = Usage.empty();
  Usage.observe(value, { snapshot: snapshot() }, NOW - DAY, SETTINGS);
  Usage.observe(value, { snapshot: snapshot() }, NOW, SETTINGS);
  expect(Usage.reserve(value, "seven_day", NOW, SETTINGS)).toBe(
    SETTINGS.margin,
  );
});

test("forecast uses the same hours of past weeks", (): void => {
  const early: Usage.Ledger = history(
    NOW - 7 * DAY,
    7 * 24,
    (hour: number): number => (hour >= 2 && hour < 5 ? 0.01 : 0),
    NOW + DAY,
  );
  expect(Usage.forecast(early, "seven_day", NOW, SETTINGS)).toBeCloseTo(0.03);
  const late: Usage.Ledger = history(
    NOW - 7 * DAY,
    7 * 24,
    (hour: number): number => (hour >= 30 && hour < 33 ? 0.01 : 0),
    NOW + DAY,
  );
  expect(Usage.forecast(late, "seven_day", NOW, SETTINGS)).toBeCloseTo(0);
});

test("busiest recorded week sets each hour", (): void => {
  const value: Usage.Ledger = history(
    NOW - 14 * DAY,
    14 * 24,
    (hour: number): number => {
      if (hour >= 2 && hour < 5) return 0.03;

      return hour >= 170 && hour < 173 ? 0.01 : 0;
    },
    NOW + DAY,
  );
  expect(Usage.forecast(value, "seven_day", NOW, SETTINGS)).toBeCloseTo(0.09);
});

test("unseen hours use the flat rate", (): void => {
  const value: Usage.Ledger = history(
    NOW - 2 * DAY,
    2 * 24,
    (hour: number): number => (hour < 24 ? 0.002 : 0),
    NOW + 7 * DAY,
  );
  expect(Usage.forecast(value, "seven_day", NOW, SETTINGS)).toBeCloseTo(0.168);
});

test("a work burst does not fill unseen hours", (): void => {
  const value: Usage.Ledger = history(
    NOW - 2 * DAY,
    2 * 24,
    (hour: number): number => (hour >= 45 ? 0.03 : 0),
    NOW + DAY,
  );
  expect(Usage.forecast(value, "seven_day", NOW, SETTINGS)).toBeCloseTo(
    (0.09 / 48) * 24,
  );
});

test("QA intervals never become personal usage samples", (): void => {
  const value: Usage.Ledger = state();
  value.runs.push({ id: "run", start: NOW + 1, end: null, charges: [] });
  Usage.observe(value, { snapshot: snapshot(0.15, 0.2) }, NOW + HOUR, SETTINGS);
  value.runs[0].end = NOW + HOUR;
  Usage.observe(
    value,
    { snapshot: snapshot(0.15, 0.2) },
    NOW + 2 * HOUR,
    SETTINGS,
  );
  expect(Usage.reserve(value, "seven_day", NOW + 2 * HOUR, SETTINGS)).toBe(
    SETTINGS.initialReserve,
  );
  expect(
    value.runs[0].charges.find((item): boolean => item.window === "seven_day")
      ?.amount,
  ).toBeCloseTo(0.1);
});

test("delayed final usage is charged to the finished run", (): void => {
  const value: Usage.Ledger = state();
  value.runs.push({ id: "failed", start: NOW, end: NOW + 1000, charges: [] });
  expect(Usage.assess(value, NOW + 1000, SETTINGS).reason).toBe(
    "usage-post-run",
  );
  Usage.observe(
    value,
    { snapshot: snapshot(0.15, 0.15) },
    NOW + HOUR,
    SETTINGS,
  );
  expect(value.runs[0].charges[0].amount).toBeCloseTo(0.05);
});

test("a window reset is never charged to the active run", (): void => {
  const value: Usage.Ledger = state();
  value.runs.push({ id: "active", start: NOW, end: null, charges: [] });
  const reset: Usage.Snapshot = snapshot(0.08, 0.1);
  reset.five_hour.resetsAt += 5 * 3600;
  Usage.observe(value, { snapshot: reset }, NOW + HOUR, SETTINGS);
  const five = value.runs[0].charges.find(
    (item): boolean => item.window === "five_hour",
  );
  expect(five?.amount).toBe(0);
});

test("increased account use delays the next run", (): void => {
  const value: Usage.Ledger = state();
  value.runs.push({
    id: "run",
    start: NOW - 4 * HOUR,
    end: NOW - HOUR,
    charges: [
      {
        window: "seven_day",
        reset: snapshot().seven_day.resetsAt,
        amount: 0.002,
      },
    ],
  });
  expect(Usage.assess(value, NOW, SETTINGS).allowed).toBe(true);
  value.samples[0].snapshot.seven_day.utilization = 0.39;
  expect(Usage.assess(value, NOW, SETTINGS).reason).toBe(
    "usage-pacing-seven_day",
  );
});

test("the same spare is spent faster near reset", (): void => {
  const value: Usage.Ledger = state();
  value.samples[0].snapshot.seven_day.utilization = 0.39;
  value.runs.push({
    id: "run",
    start: NOW - 4 * HOUR,
    end: NOW - HOUR,
    charges: [
      {
        window: "seven_day",
        reset: snapshot().seven_day.resetsAt,
        amount: 0.002,
      },
    ],
  });
  expect(Usage.assess(value, NOW, SETTINGS).reason).toBe(
    "usage-pacing-seven_day",
  );
  value.samples[0].snapshot.seven_day.resetsAt = (NOW + DAY) / 1000;
  value.runs[0].charges[0].reset = (NOW + DAY) / 1000;
  expect(Usage.assess(value, NOW, SETTINGS).allowed).toBe(true);
});

test("measured run cost replaces the initial estimate", (): void => {
  const value: Usage.Ledger = state();
  value.samples[0].snapshot.seven_day.utilization = 0.39;
  value.runs.push({
    id: "run",
    start: NOW - 4 * HOUR,
    end: NOW - HOUR,
    charges: [],
  });
  expect(Usage.assess(value, NOW, SETTINGS).allowed).toBe(true);
  value.runs[0].charges.push({
    window: "seven_day",
    reset: snapshot().seven_day.resetsAt,
    amount: 0.2,
  });
  expect(Usage.assess(value, NOW, SETTINGS).reason).toBe(
    "usage-capacity-seven_day",
  );
});

test("reset requires a fresh meter and starts a new share", (): void => {
  const value: Usage.Ledger = state();
  value.runs.push({
    id: "old",
    start: NOW - 10 * DAY,
    end: NOW - 1,
    charges: [
      {
        window: "seven_day",
        reset: snapshot().seven_day.resetsAt - 1,
        amount: 0.04,
      },
    ],
  });
  expect(Usage.assess(value, NOW, SETTINGS).allowed).toBe(true);
  value.samples[0].snapshot.seven_day.resetsAt = NOW / 1000;
  expect(Usage.assess(value, NOW, SETTINGS).allowed).toBe(false);
});

test("meter regressions stop work", (): void => {
  const value: Usage.Ledger = state();
  expect(
    Usage.observe(value, { snapshot: snapshot(0.01) }, NOW + 1, SETTINGS),
  ).toBe("regression");
  expect(Usage.assess(value, NOW + 1, SETTINGS).reason).toBe("usage-cooldown");
});

test("a one-step meter drop is rounding, not a regression", (): void => {
  for (const reading of [snapshot(0.09, 0.1), snapshot(0.1, 0.09)]) {
    const value: Usage.Ledger = state();
    expect(Usage.observe(value, { snapshot: reading }, NOW + 1, SETTINGS)).toBe(
      "rounding",
    );
    expect(value.samples).toHaveLength(1);
    expect(Usage.assess(value, NOW + 1, SETTINGS).allowed).toBe(true);
  }
  const live: Usage.Ledger = Usage.empty();
  Usage.observe(live, { snapshot: snapshot(0.01, 0.52) }, NOW, SETTINGS);
  expect(
    Usage.observe(live, { snapshot: snapshot(0, 0.51) }, NOW + 1, SETTINGS),
  ).toBe("rounding");
});

test("state survives restarts and charges interrupted runs", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  const path: string = join(root, "usage.json");
  let now: number = NOW;
  let calls: number = 0;
  let reading: Usage.Snapshot = snapshot();
  const probe = async (): Promise<Usage.Report> => {
    calls++;
    return { snapshot: reading };
  };
  try {
    const store: Usage.Store = await Usage.connect(
      path,
      SETTINGS,
      (): void => {},
      probe,
      (): number => now,
    );
    expect((await store.ready()).allowed).toBe(true);
    await store.begin();
    expect((await store.ready()).reason).toBe("usage-active");
    now += HOUR;
    reading = snapshot(0.16, 0.16);
    const restarted: Usage.Store = await Usage.connect(
      path,
      SETTINGS,
      (): void => {},
      probe,
      (): number => now,
    );
    await restarted.ready();
    const saved: Usage.Ledger = JSON.parse(await readFile(path, "utf8"));
    expect(saved.runs).toHaveLength(1);
    expect(saved.runs[0].end).toBe(now);
    expect(saved.runs[0].charges[0].amount).toBeCloseTo(0.06);
    expect(calls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probe failures remain paused without repeated calls", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  let calls: number = 0;
  const events: Record<string, unknown>[] = [];
  try {
    const store: Usage.Store = await Usage.connect(
      join(root, "usage.json"),
      SETTINGS,
      (event): void => {
        events.push(event);
      },
      async (): Promise<Usage.Report> => {
        calls++;
        throw new Error("Unavailable");
      },
      (): number => NOW,
    );
    for (let index: number = 0; index < 10; index++)
      expect((await store.ready()).allowed).toBe(false);
    expect(calls).toBe(1);
    expect(
      events.some((event): boolean => event.event === "usage-probe-error"),
    ).toBe(true);
    await expect(store.begin()).rejects.toThrow("usage-cooldown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active refresh keeps long runs alive and shares concurrent probes", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  const path: string = join(root, "usage.json");
  let now: number = NOW;
  let calls: number = 0;
  const events: Record<string, unknown>[] = [];
  try {
    const store: Usage.Store = await Usage.connect(
      path,
      SETTINGS,
      (event): void => {
        events.push(event);
      },
      async (): Promise<Usage.Report> => {
        calls++;
        return { snapshot: snapshot(0.1 + calls / 100, 0.1 + calls / 100) };
      },
      (): number => now,
    );
    await store.ready();
    await store.begin();
    now += SETTINGS.activeProbeSeconds * 1000;
    const decisions: Usage.Decision[] = await Promise.all([
      store.update(),
      store.update(),
      store.update(),
    ]);
    expect(decisions.every((decision): boolean => decision.allowed)).toBe(true);
    expect(calls).toBe(2);
    now += SETTINGS.activeProbeSeconds * 1000;
    expect(now - NOW).toBeGreaterThan(SETTINGS.freshSeconds * 1000);
    expect((await store.update()).allowed).toBe(true);
    expect(calls).toBe(3);
    const saved: Usage.Ledger = JSON.parse(await readFile(path, "utf8"));
    expect(saved.samples.at(-1)?.active).toBe(true);
    expect(saved.runs[0].charges[0].amount).toBeCloseTo(0.02);
    expect(
      events.filter(
        (event): boolean =>
          event.event === "usage-probe" && event.active === true,
      ),
    ).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh stream readings postpone active probes", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  let now: number = NOW;
  let calls: number = 0;
  try {
    const store: Usage.Store = await Usage.connect(
      join(root, "usage.json"),
      SETTINGS,
      (): void => {},
      async (): Promise<Usage.Report> => {
        calls++;
        return { snapshot: snapshot() };
      },
      (): number => now,
    );
    await store.ready();
    await store.begin();
    now += SETTINGS.activeProbeSeconds * 1000;
    await store.update({ snapshot: snapshot() });
    now += SETTINGS.activeProbeSeconds * 1000 - 1;
    expect((await store.update()).allowed).toBe(true);
    expect(calls).toBe(1);
    now++;
    expect((await store.update()).allowed).toBe(true);
    expect(calls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle requests never trigger active probes", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  let now: number = NOW;
  let calls: number = 0;
  try {
    const store: Usage.Store = await Usage.connect(
      join(root, "usage.json"),
      SETTINGS,
      (): void => {},
      async (): Promise<Usage.Report> => {
        calls++;
        return { snapshot: snapshot() };
      },
      (): number => now,
    );
    await store.ready();
    now += SETTINGS.activeProbeSeconds * 1000;
    await store.update();
    await store.ready();
    expect(calls).toBe(1);
    now = NOW + SETTINGS.probeSeconds * 1000 - 1;
    await store.update();
    await store.ready();
    expect(calls).toBe(1);
    now++;
    await store.ready();
    expect(calls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["failure", "empty", "reserve", "rejected"])(
  "active probe %s stops work",
  async (outcome: string): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
    const path: string = join(root, "usage.json");
    let now: number = NOW;
    let calls: number = 0;
    const events: Record<string, unknown>[] = [];
    try {
      const store: Usage.Store = await Usage.connect(
        path,
        SETTINGS,
        (event): void => {
          events.push(event);
        },
        async (): Promise<Usage.Report> => {
          calls++;
          if (calls === 1) return { snapshot: snapshot() };
          if (outcome === "failure") throw new Error("Probe unavailable");
          if (outcome === "empty") return {};
          if (outcome === "rejected") return { blockedUntil: now + HOUR };
          return { snapshot: snapshot(0.9, 0.9) };
        },
        (): number => now,
      );
      await store.ready();
      const id: string = await store.begin();
      now += SETTINGS.activeProbeSeconds * 1000;
      const decision: Usage.Decision = await store.update();
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe(
        outcome === "reserve" ? "usage-reserve-five_hour" : "usage-cooldown",
      );
      expect((await store.update()).allowed).toBe(false);
      expect(calls).toBe(2);
      await store.finish(id);
      const restarted: Usage.Store = await Usage.connect(
        path,
        SETTINGS,
        (): void => {},
        async (): Promise<Usage.Report> => {
          throw new Error("Unexpected probe");
        },
        (): number => now,
      );
      expect((await restarted.ready()).allowed).toBe(false);
      if (["failure", "empty"].includes(outcome))
        expect(
          events.some(
            (event): boolean =>
              event.event === "usage-probe-error" && event.active === true,
          ),
        ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("storage fault clears after a later successful write", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  const path: string = join(root, "usage.json");
  try {
    const store: Usage.Store = await Usage.connect(
      path,
      SETTINGS,
      (): void => {},
      async (): Promise<Usage.Report> => ({ snapshot: snapshot() }),
      (): number => NOW,
    );
    await mkdir(`${path}.tmp`);
    await expect(store.update({ snapshot: snapshot() })).rejects.toThrow();
    expect((await store.ready()).reason).toBe("usage-storage");
    await rm(`${path}.tmp`, { recursive: true });
    expect((await store.ready()).reason).not.toBe("usage-storage");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt state never resets the budget", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  const path: string = join(root, "usage.json");
  try {
    await writeFile(path, "broken");
    await expect(
      Usage.connect(
        path,
        SETTINGS,
        (): void => {},
        async (): Promise<Usage.Report> => ({ snapshot: snapshot() }),
      ),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stream reader forwards split frames and final usage", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  const path: string = join(root, "events.jsonl");
  const entries: Usage.Report[] = [];
  const value: string = `${frame()}\n`;
  try {
    await writeFile(path, value.slice(0, 30));
    const done: Promise<void> = Bun.sleep(10).then(async (): Promise<void> => {
      await appendFile(path, value.slice(30));
    });
    await Usage.watch(path, done, async (reading): Promise<Usage.Decision> => {
      if (reading) entries.push(reading);
      return { allowed: true, reason: "test" };
    });
    expect(entries).toEqual([{ snapshot: snapshot() }]);
    await expect(
      Usage.watch(
        path,
        Promise.resolve(),
        async (): Promise<Usage.Decision> => ({
          allowed: false,
          reason: "usage-reserve",
        }),
      ),
    ).rejects.toThrow("usage-reserve");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing phase metadata pauses the following work", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  const path: string = join(root, "events.jsonl");
  const reports: Usage.Report[] = [];
  try {
    await writeFile(
      path,
      `${JSON.stringify({ type: "result", usage: { input_tokens: 100 } })}\n`,
    );
    await expect(
      Usage.watch(
        path,
        Promise.resolve(),
        async (reading): Promise<Usage.Decision> => {
          if (reading) reports.push(reading);
          return { allowed: false, reason: "usage-cooldown" };
        },
      ),
    ).rejects.toThrow("no complete subscription meters");
    expect(reports[0].blockedUntil).toBeGreaterThan(Date.now());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(INVALID)(
  "$name persists stream cooldown",
  async ({ info }): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
    const path: string = join(root, "events.jsonl");
    const ledger: string = join(root, "usage.json");
    const probe = async (): Promise<Usage.Report> => ({ snapshot: snapshot() });
    try {
      const store: Usage.Store = await Usage.connect(
        ledger,
        SETTINGS,
        (): void => {},
        probe,
      );
      expect((await store.ready()).allowed).toBe(true);
      const id: string = await store.begin();
      await writeFile(
        path,
        `${JSON.stringify({ type: "rate_limit_event", rate_limit_info: info })}\n`,
      );
      await expect(
        Usage.watch(path, Promise.resolve(), store.update),
      ).rejects.toThrow("usage-cooldown");
      await store.finish(id);
      const saved: Usage.Ledger = JSON.parse(await readFile(ledger, "utf8"));
      expect(saved.blockedUntil).toBeGreaterThan(Date.now());
      const restarted: Usage.Store = await Usage.connect(
        ledger,
        SETTINGS,
        (): void => {},
        probe,
      );
      expect(await restarted.ready()).toEqual({
        allowed: false,
        reason: "usage-cooldown",
      });
      await expect(restarted.begin()).rejects.toThrow("usage-cooldown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("concurrent reservations cannot exceed one active run", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-usage-test-"));
  try {
    const store: Usage.Store = await Usage.connect(
      join(root, "usage.json"),
      SETTINGS,
      (): void => {},
      async (): Promise<Usage.Report> => ({ snapshot: snapshot() }),
      (): number => NOW,
    );
    await store.ready();
    const results: PromiseSettledResult<string>[] = await Promise.allSettled([
      store.begin(),
      store.begin(),
    ]);
    expect(
      results.filter((result): boolean => result.status === "fulfilled"),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overage use stops QA even when windows report spare capacity", (): void => {
  const reading: Usage.Report | undefined = Usage.event(
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        isUsingOverage: true,
        unifiedWindows: snapshot(),
      },
    },
    NOW,
  );
  const value: Usage.Ledger = state();
  if (!reading) throw new Error("Missing rate-limit reading");
  Usage.observe(value, reading, NOW, SETTINGS);
  expect(Usage.assess(value, NOW, SETTINGS, true).reason).toBe(
    "usage-cooldown",
  );
});
