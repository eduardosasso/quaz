import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Areas from "@qa/areas";
import CONFIG from "@qa/config.json";
import * as Project from "@qa/project";
import type * as Protocol from "@/qa_protocol";

const folders: string[] = [];
const AREAS: Areas.Area[] = [
  { name: "Billing", description: "Pay for a plan." },
  { name: "Boards", description: "Arrange cards on a board." },
];
const project = (
  files: string[],
  input: Record<string, unknown> = {},
): Project.Project => {
  const root: string = mkdtempSync(join(tmpdir(), "quaz-areas-"));
  folders.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), file);
  }

  return {
    ...Project.schema.parse({
      id: "sample",
      scenarios: ["empty"],
      sources: ["src", "www"],
      ...input,
    }),
    root,
  };
};
const recorder = (): {
  events: Record<string, unknown>[];
  log: Areas.Log;
} => {
  const events: Record<string, unknown>[] = [];

  return {
    events,
    log: (event: Record<string, unknown>): void => {
      events.push(event);
    },
  };
};
const flow = (area: string | null, covered: string | null): Protocol.Flow => ({
  key: `flow-${Math.random()}`,
  goal: "Goal",
  run: "run",
  expires: 0,
  status: "partial",
  covered,
  area,
});
afterEach((): void => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

test("paths skip tests, assets, hidden folders, and lock files", (): void => {
  const value: Project.Project = project([
    "src/billing.ts",
    "src/__tests__/billing.test.ts",
    "src/board.spec.tsx",
    "src/logo.png",
    "src/.cache/state.ts",
    "www/index.html",
    "www/bun.lock",
    "other/ignored.ts",
  ]);
  expect(Areas.paths(value)).toEqual(["src/billing.ts", "www/index.html"]);
  expect(Areas.paths({ ...value, map: ["www"] })).toEqual(["www/index.html"]);
});

test("signature follows file names, not file contents", (): void => {
  const value: Project.Project = project(["src/billing.ts"]);
  const first: string = Areas.signature(Areas.paths(value));
  writeFileSync(join(value.root, "src/billing.ts"), "changed");
  expect(Areas.signature(Areas.paths(value))).toBe(first);
  writeFileSync(join(value.root, "src/member.ts"), "new");
  expect(Areas.signature(Areas.paths(value))).not.toBe(first);
});

test("a large repository sends folder names", (): void => {
  const long: string[] = Array.from(
    { length: CONFIG.areas.pathBytes / 16 },
    (_value: unknown, index: number): string =>
      `src/feature-${index % 3}/file-${index}.ts`,
  );
  expect(Areas.outline(long)).toBe(
    "src/feature-0\nsrc/feature-1\nsrc/feature-2",
  );
  expect(Areas.outline(["src/a.ts", "src/b.ts"])).toBe("src/a.ts\nsrc/b.ts");
});

test("the map is reused until a file is added", async (): Promise<void> => {
  const value: Project.Project = project(["src/billing.ts"]);
  const path: string = join(value.root, "areas.json");
  const { events, log } = recorder();
  const inputs: Areas.Input[] = [];
  const create: Areas.Generate = async (
    input: Areas.Input,
  ): Promise<Areas.Area[]> => {
    inputs.push(input);

    return [...AREAS, AREAS[0]];
  };
  expect(await Areas.load(value, path, log, create)).toEqual(AREAS);
  expect(await Areas.load(value, path, log, create)).toEqual(AREAS);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.paths).toBe("src/billing.ts");
  writeFileSync(join(value.root, "src/member.ts"), "new");
  await Areas.load(value, path, log, create);
  expect(inputs).toHaveLength(2);
  expect(events.map((event): unknown => event.event)).toEqual([
    "areas-mapped",
    "areas-reused",
    "areas-mapped",
  ]);
});

test("product notes are sent with the paths", async (): Promise<void> => {
  const value: Project.Project = project(["src/billing.ts", "PRODUCT.md"]);
  let notes: string = "";
  await Areas.load(
    value,
    join(value.root, "areas.json"),
    recorder().log,
    async (input: Areas.Input): Promise<Areas.Area[]> => {
      notes = input.docs;
      return AREAS;
    },
  );
  expect(notes).toBe("PRODUCT.md:\nPRODUCT.md");
});

test("a failed map is logged and leaves the run without areas", async (): Promise<void> => {
  const value: Project.Project = project(["src/billing.ts"]);
  const { events, log } = recorder();
  expect(
    await Areas.load(
      value,
      join(value.root, "areas.json"),
      log,
      async (): Promise<Areas.Area[]> => {
        throw new Error("model unavailable");
      },
    ),
  ).toEqual([]);
  expect(events).toEqual([
    {
      event: "areas-error",
      project: "sample",
      error: "Error: model unavailable",
    },
  ]);
});

test("a corrupt cache is rebuilt", async (): Promise<void> => {
  const value: Project.Project = project(["src/billing.ts"]);
  const path: string = join(value.root, "areas.json");
  writeFileSync(path, "{");
  const { events, log } = recorder();
  expect(await Areas.load(value, path, log, async () => AREAS)).toEqual(AREAS);
  expect(events.map((event): unknown => event.event)).toEqual([
    "areas-cache-invalid",
    "areas-mapped",
  ]);
});

test("remote targets have no source map", async (): Promise<void> => {
  const value: Project.Project = {
    ...project([]),
    revision: "target",
    sources: [],
  };
  const { events, log } = recorder();
  let called: boolean = false;
  expect(
    await Areas.load(value, join(value.root, "areas.json"), log, async () => {
      called = true;
      return AREAS;
    }),
  ).toEqual([]);
  expect(called).toBe(false);
  expect(events).toEqual([
    { event: "areas-skipped", project: "sample", reason: "no-source" },
  ]);
});

test("least reviewed areas come first", (): void => {
  const ranked: Areas.Ranked[] = Areas.rank(AREAS, [
    flow("Billing", "a".repeat(40)),
    flow("Billing", "a".repeat(40)),
    flow("Boards", null),
    flow(null, "a".repeat(40)),
  ]);
  expect(ranked.map((item): string => `${item.name}:${item.reviews}`)).toEqual([
    "Boards:0",
    "Billing:2",
  ]);
});
