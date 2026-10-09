import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CONFIG from "@qa/config.json";
import { z } from "zod";
import * as Protocol from "@/qa_protocol";

const MILLISECONDS: number = 1000;
export const REQUEST_MS: number =
  CONFIG.usage.probeTimeoutSeconds * MILLISECONDS + Protocol.REQUEST_MS;
const HOUR: number = 3600 * MILLISECONDS;
const DAY: number = 24 * HOUR;
const WEEK_HOURS: number = 7 * 24;
const WINDOWS = ["five_hour", "seven_day"] as const;
type Window = (typeof WINDOWS)[number];
const window = z.object({
  utilization: z.number().min(0).max(1),
  resetsAt: z.number().int().positive(),
});
export const snapshot = z.object({ five_hour: window, seven_day: window });
export type Snapshot = z.infer<typeof snapshot>;
export const report = z
  .object({
    snapshot: snapshot.optional(),
    blockedUntil: z.number().nonnegative().optional(),
  })
  .strict();
export type Report = z.infer<typeof report>;
export const decision = z.object({ allowed: z.boolean(), reason: z.string() });
export type Decision = z.infer<typeof decision>;
export const control = decision.extend({ enabled: z.boolean() });
export type Control = z.infer<typeof control>;
const sample = z.object({ at: z.number(), active: z.boolean(), snapshot });
const charge = z.object({
  window: z.enum(WINDOWS),
  reset: z.number(),
  amount: z.number().nonnegative(),
});
const run = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number().nullable(),
  charges: z.array(charge),
});
const ledger = z
  .object({
    version: z.literal(1),
    samples: z.array(sample),
    runs: z.array(run),
    nextProbe: z.number(),
    blockedUntil: z.number(),
  })
  .strict();
export type Ledger = z.infer<typeof ledger>;
export type Settings = typeof CONFIG.usage;
export type Log = (event: Record<string, unknown>) => void;
export const empty = (): Ledger => ({
  version: 1,
  samples: [],
  runs: [],
  nextProbe: 0,
  blockedUntil: 0,
});
export const event = (value: unknown, now: number): Report | undefined => {
  const frame = z
    .object({ type: z.string(), rate_limit_info: z.unknown().optional() })
    .safeParse(value);
  if (!frame.success || frame.data.type !== "rate_limit_event") return;
  const parsedInfo = z
    .object({
      status: z.enum(["allowed", "allowed_warning", "rejected"]),
      isUsingOverage: z.boolean().optional(),
      resetsAt: z.number().optional(),
      unifiedWindows: z.unknown().optional(),
    })
    .safeParse(frame.data.rate_limit_info);
  const cooldown: number = now + CONFIG.usage.probeSeconds * MILLISECONDS;
  if (!parsedInfo.success) return { blockedUntil: cooldown };
  const info = parsedInfo.data;
  const parsed = snapshot.safeParse(info.unifiedWindows);

  return {
    ...(parsed.success ? { snapshot: parsed.data } : {}),
    ...(!parsed.success || info.status === "rejected" || info.isUsingOverage
      ? {
          blockedUntil: Math.max(
            cooldown,
            (info.status === "rejected" || info.isUsingOverage
              ? (info.resetsAt ?? 0)
              : 0) * MILLISECONDS,
          ),
        }
      : {}),
  };
};
export type Rejection = "rounding" | "regression";
export const observe = (
  state: Ledger,
  reading: Report,
  now: number,
  settings: Settings,
): Rejection | undefined => {
  state.blockedUntil = Math.max(state.blockedUntil, reading.blockedUntil ?? 0);
  if (!reading.snapshot) return;
  const currentSnapshot: Snapshot = reading.snapshot;
  const previous: z.infer<typeof sample> | undefined = state.samples.at(-1);
  const active: z.infer<typeof run> | undefined = state.runs.find(
    (item): boolean => item.end === null,
  );
  const charged: z.infer<typeof run> | undefined =
    active ??
    state.runs.findLast(
      (item): boolean => (item.end ?? now) >= (previous?.at ?? now),
    );
  const drop = (name: Window): number =>
    previous?.snapshot[name].resetsAt === currentSnapshot[name].resetsAt
      ? previous.snapshot[name].utilization - currentSnapshot[name].utilization
      : 0;
  if (
    WINDOWS.some(
      (name): boolean => Math.round(drop(name) / settings.meterStep) > 1,
    )
  ) {
    state.blockedUntil = Math.max(
      state.blockedUntil,
      now + settings.probeSeconds * MILLISECONDS,
    );
    return "regression";
  }
  // Meters report whole steps, so readings seconds apart can differ by one step.
  if (WINDOWS.some((name): boolean => drop(name) > 0)) return "rounding";
  for (const name of WINDOWS) {
    const current: z.infer<typeof window> = currentSnapshot[name];
    const prior: z.infer<typeof window> | undefined = previous?.snapshot[name];
    if (!charged) continue;
    const amount: number =
      prior && prior.resetsAt !== current.resetsAt
        ? 0
        : Math.max(0, current.utilization - (prior?.utilization ?? 0));
    const stored: z.infer<typeof charge> | undefined = charged.charges.find(
      (item): boolean =>
        item.window === name && item.reset === current.resetsAt,
    );
    if (stored) stored.amount += amount;
    else
      charged.charges.push({ window: name, reset: current.resetsAt, amount });
  }
  state.samples.push({ at: now, active: !!active, snapshot: reading.snapshot });
  state.samples = state.samples.filter(
    (item): boolean => item.at >= now - settings.historyDays * DAY,
  );
  state.runs = state.runs.filter(
    (item): boolean =>
      item.end === null || item.start >= now - settings.historyDays * DAY,
  );
};
type Interval = { start: number; end: number; delta: number };
const personal = (
  state: Ledger,
  name: Window,
  now: number,
  settings: Settings,
): Interval[] =>
  state.samples.slice(1).flatMap((current, index): Interval[] => {
    const prior = state.samples[index];
    const quiet: boolean =
      !prior.active &&
      !current.active &&
      current.at - prior.at >= settings.minimumSampleSeconds * MILLISECONDS &&
      prior.snapshot[name].resetsAt === current.snapshot[name].resetsAt &&
      !state.runs.some(
        (item): boolean =>
          item.start < current.at && (item.end ?? now) > prior.at,
      );
    if (!quiet) return [];

    return [
      {
        start: prior.at,
        end: current.at,
        delta: Math.max(
          0,
          current.snapshot[name].utilization - prior.snapshot[name].utilization,
        ),
      },
    ];
  });
const duration = (items: Interval[]): number =>
  items.reduce((sum: number, item): number => sum + item.end - item.start, 0);
const rate = (items: Interval[]): number => {
  const elapsed: number = duration(items);

  return elapsed
    ? items.reduce((sum: number, item): number => sum + item.delta, 0) / elapsed
    : 0;
};
// Each hour of the week keeps the busiest rate seen in any recorded week.
const profile = (items: Interval[]): Map<number, number> => {
  const hours: Map<number, { used: number; covered: number }> = new Map();
  for (const item of items) {
    const speed: number = item.delta / (item.end - item.start);
    for (
      let hour: number = Math.floor(item.start / HOUR);
      hour * HOUR < item.end;
      hour++
    ) {
      const covered: number =
        Math.min(item.end, (hour + 1) * HOUR) -
        Math.max(item.start, hour * HOUR);
      const entry = hours.get(hour) ?? { used: 0, covered: 0 };
      hours.set(hour, {
        used: entry.used + speed * covered,
        covered: entry.covered + covered,
      });
    }
  }
  const slots: Map<number, number> = new Map();
  for (const [hour, entry] of hours) {
    const slot: number = hour % WEEK_HOURS;
    slots.set(slot, Math.max(slots.get(slot) ?? 0, entry.used / entry.covered));
  }

  return slots;
};
export const forecast = (
  state: Ledger,
  name: Window,
  now: number,
  settings: Settings,
): number => {
  const items: Interval[] = personal(state, name, now, settings);
  const slots: Map<number, number> = profile(items);
  const flat: number = rate(items);
  const reset: number =
    (state.samples.at(-1)?.snapshot[name].resetsAt ?? 0) * MILLISECONDS;
  let total: number = 0;
  for (let start: number = now; start < reset; ) {
    const hour: number = Math.floor(start / HOUR);
    const end: number = Math.min(reset, (hour + 1) * HOUR);
    total += (slots.get(hour % WEEK_HOURS) ?? flat) * (end - start);
    start = end;
  }

  return total;
};
export const reserve = (
  state: Ledger,
  name: Window,
  now: number,
  settings: Settings,
): number => {
  const learning: boolean =
    duration(personal(state, name, now, settings)) <
    settings.learningHours * HOUR;

  return Math.min(
    1,
    Math.max(
      learning ? settings.initialReserve : 0,
      forecast(state, name, now, settings) + settings.margin,
    ),
  );
};
const cost = (state: Ledger, name: Window, settings: Settings): number => {
  const finished: z.infer<typeof run>[] = state.runs.filter(
    (item): boolean => item.end !== null,
  );
  const spent: number = finished
    .flatMap((item): z.infer<typeof charge>[] => item.charges)
    .filter((item): boolean => item.window === name)
    .reduce((sum: number, item): number => sum + item.amount, 0);

  return (
    (finished.length ? spent / finished.length : settings.initialCost) *
    settings.safety
  );
};
export const assess = (
  state: Ledger,
  now: number,
  settings: Settings,
  running: boolean = false,
): Decision => {
  const deny = (reason: string): Decision => ({ allowed: false, reason });
  if (now < state.blockedUntil) return deny("usage-cooldown");
  const last = state.samples.at(-1);
  if (
    !last ||
    now < last.at ||
    now - last.at > settings.freshSeconds * MILLISECONDS
  )
    return deny("usage-stale");
  if (!running && last.at < (state.runs.at(-1)?.end ?? 0))
    return deny("usage-post-run");
  if (!running && state.runs.some((item): boolean => item.end === null))
    return deny("usage-active");
  for (const name of WINDOWS) {
    const current = last.snapshot[name];
    const remaining: number = current.resetsAt * MILLISECONDS - now;
    if (remaining <= 0) return deny("usage-reset-pending");
    const spare: number =
      1 - current.utilization - reserve(state, name, now, settings);
    if (spare <= 0) return deny(`usage-reserve-${name}`);
    if (running) continue;
    const price: number = cost(state, name, settings);
    if (price > spare) return deny(`usage-capacity-${name}`);
    // Unused allowance expires at reset, so the same spare is spent faster near it.
    const delay: number = Math.max(
      settings.minimumRunSeconds * MILLISECONDS,
      (remaining * price) / spare,
    );
    const previous = state.runs.at(-1);
    if (previous && now - previous.start < delay)
      return deny(`usage-pacing-${name}`);
  }

  return { allowed: true, reason: "usage-available" };
};
export type Store = {
  ready: () => Promise<Decision>;
  begin: () => Promise<string>;
  finish: (id: string) => Promise<void>;
  update: (reading?: Report) => Promise<Decision>;
};
export const connect = async (
  path: string,
  settings: Settings,
  log: Log,
  probe: () => Promise<Report>,
  now: () => number = Date.now,
): Promise<Store> => {
  let state: Ledger;
  try {
    state = ledger.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = empty();
  }
  // Keep interrupted runs charged and exclude their unobserved interval from personal usage.
  for (const item of state.runs) if (item.end === null) item.end = now();
  let tail: Promise<void> = Promise.resolve();
  let previous: string = "";
  let fault: boolean = false;
  const save = async (): Promise<void> => {
    const temporary: string = `${path}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path);
      fault = false;
    } catch (error: unknown) {
      fault = true;
      throw error;
    }
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result: Promise<T> = tail.then(operation);
    tail = result.then(
      (): void => {},
      (error: unknown): void => {
        log({ event: "usage-error", error: String(error) });
      },
    );

    return result;
  };
  const record = (reading: Report): void => {
    const rejection: Rejection | undefined = observe(
      state,
      reading,
      now(),
      settings,
    );
    if (rejection) log({ event: `usage-${rejection}`, ...reading });
  };
  const status = (running: boolean): Decision => {
    const result: Decision = fault
      ? { allowed: false, reason: "usage-storage" }
      : assess(state, now(), settings, running);
    if (previous !== result.reason) log({ event: "usage-decision", ...result });
    previous = result.reason;

    return result;
  };
  const refresh = async (running: boolean): Promise<void> => {
    const active: boolean = state.runs.some(
      (item): boolean => item.end === null,
    );
    if (fault || active !== running || now() < state.blockedUntil) return;
    const last: z.infer<typeof sample> | undefined = state.samples.at(-1);
    const interval: number = running
      ? settings.activeProbeSeconds
      : settings.freshSeconds;
    const stale: boolean =
      !last ||
      last.at < (state.runs.at(-1)?.end ?? 0) ||
      now() - last.at >= interval * MILLISECONDS ||
      WINDOWS.some(
        (name): boolean => last.snapshot[name].resetsAt * MILLISECONDS <= now(),
      );
    if (!stale || (!running && now() < state.nextProbe)) return;
    state.nextProbe = now() + settings.probeSeconds * MILLISECONDS;
    await save();
    try {
      const reading: Report = report.parse(await probe());
      if (!reading.snapshot && !reading.blockedUntil)
        throw new Error("Usage probe has no subscription meters");
      record(reading);
      log({ event: "usage-probe", active: running, ...reading });
    } catch (error: unknown) {
      state.blockedUntil = Math.max(state.blockedUntil, state.nextProbe);
      log({
        event: "usage-probe-error",
        active: running,
        error: String(error),
      });
    }
    await save();
  };
  await save();

  return {
    ready: (): Promise<Decision> =>
      serial(async (): Promise<Decision> => {
        // Retry storage so a transient write failure does not disable the guard for good.
        if (fault) await save().catch((): void => undefined);
        await refresh(false);

        return status(false);
      }),
    begin: (): Promise<string> =>
      serial(async (): Promise<string> => {
        const result: Decision = status(false);
        if (!result.allowed) throw new Error(result.reason);
        const id: string = randomUUID();
        state.runs.push({ id, start: now(), end: null, charges: [] });
        await save();

        return id;
      }),
    finish: (id: string): Promise<void> =>
      serial(async (): Promise<void> => {
        const item = state.runs.find((entry): boolean => entry.id === id);
        if (!item) throw new Error("Unknown usage run");
        item.end = now();
        await save();
        log({ event: "usage-run-done", run: id, charges: item.charges });
      }),
    update: (reading?: Report): Promise<Decision> =>
      serial(async (): Promise<Decision> => {
        if (reading) {
          record(report.parse(reading));
          await save();
        }
        await refresh(true);

        return status(true);
      }),
  };
};
export const probe = async (
  token: string,
  signal: AbortSignal,
): Promise<Report> => {
  if (!token) throw new Error("Missing Claude credential for usage probe");
  const directory: string = await mkdtemp(join(tmpdir(), "quaz-usage-"));
  try {
    const child = Bun.spawn(
      [
        "claude",
        "--safe-mode",
        "--strict-mcp-config",
        "--tools",
        "",
        "--no-session-persistence",
        "--model",
        CONFIG.usage.probeModel,
        "--effort",
        "low",
        "--max-budget-usd",
        String(CONFIG.usage.probeBudgetUsd),
        "--output-format",
        "stream-json",
        "--verbose",
        "-p",
        "Reply OK.",
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          CLAUDE_CONFIG_DIR: join(directory, "config"),
          CLAUDE_CODE_OAUTH_TOKEN: token,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: CONFIG.usage.probeTimeoutSeconds * MILLISECONDS,
        signal,
      },
    );
    const [raw, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    let reading: Report | undefined;
    for (const line of raw.split("\n").filter(Boolean)) {
      const next: Report | undefined = event(JSON.parse(line), Date.now());
      if (next) reading = next;
    }
    if (!reading || (!reading.snapshot && !reading.blockedUntil))
      throw new Error(`Usage probe has no subscription meters (exit ${code})`);

    return reading;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
export const watch = async (
  path: string,
  finished: Promise<unknown>,
  publish: (reading?: Report) => Promise<Decision>,
): Promise<void> => {
  let complete: boolean = false;
  const settled: Promise<void> = finished.then(
    (): void => {
      complete = true;
    },
    (): void => {
      complete = true;
    },
  );
  const file = await open(path, "r");
  const buffer: Buffer = Buffer.alloc(CONFIG.usage.readBytes);
  let pending: string = "";
  const decoder: TextDecoder = new TextDecoder();
  let checked: number = Date.now();
  let received: boolean = false;
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer);
      if (bytesRead) {
        pending += decoder.decode(buffer.subarray(0, bytesRead), {
          stream: true,
        });
        const lines: string[] = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const reading: Report | undefined = event(
            JSON.parse(line),
            Date.now(),
          );
          if (!reading) continue;
          received = true;
          const result: Decision = await publish(reading);
          checked = Date.now();
          if (!result.allowed) throw new Error(result.reason);
        }
        continue;
      }
      if (complete) {
        if (!received || pending.trim()) {
          await publish({
            blockedUntil: Date.now() + CONFIG.usage.probeSeconds * MILLISECONDS,
          });
          throw new Error("Usage stream has no complete subscription meters");
        }
        break;
      }
      if (
        Date.now() - checked >=
        CONFIG.usage.heartbeatSeconds * MILLISECONDS
      ) {
        const result: Decision = await publish();
        checked = Date.now();
        if (!result.allowed) throw new Error(result.reason);
      }
      await Promise.race([
        settled,
        Bun.sleep(CONFIG.usage.monitorSeconds * MILLISECONDS),
      ]);
    }
  } finally {
    await file.close();
  }
};
