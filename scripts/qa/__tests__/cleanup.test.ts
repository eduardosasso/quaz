import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Cleanup from "@qa/cleanup";
import type * as Adapter from "@/adapters/overdew";
import * as Migrate from "@/migrate";
import * as State from "@/state";
import type * as Tracker from "@/tracker";

const TARGET: string = "https://tracker.test/owner/board";
const PROJECT: string = "sample";
const FILE_MODE: number = 0o777;
const OWNER_ONLY: number = 0o600;
const FINGERPRINT: string = "a".repeat(64);
const RUN_TAGS: string = "qa-run,project:sample";
const FINDING_TAGS: string = "qa,needs-verification,project:sample";
const RUN_DESCRIPTION: string = "Run qa-abc\nReport";

type Fixture = {
  folder: string;
  path: string;
  db: Database;
  tracker: Tracker.Tracker;
  remove: Adapter.Remover;
  removed: string[];
  add: (title: string, tags: string, description?: string) => number;
  attach: (card: number, name: string, text: string) => number;
  input: (confirm?: number) => Cleanup.Input;
};
let folder: string = "";
let output: ReturnType<typeof spyOn> | null = null;
const opened: Database[] = [];
beforeEach((): void => {
  folder = mkdtempSync(join(tmpdir(), "quaz-cleanup-"));
  output = spyOn(console, "log").mockImplementation((): void => {});
});
afterEach((): void => {
  for (const db of opened.splice(0)) db.close();
  rmSync(folder, { recursive: true, force: true });
  output?.mockRestore();
});

const fixture = (seed: boolean = true): Fixture => {
  const path: string = join(folder, "state.db");
  const db: Database = new Database(path, { create: true });
  opened.push(db);
  State.prepare(db);
  db.exec(
    "CREATE TABLE qa_destination (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
  );
  db.query("INSERT INTO qa_destination (id,value) VALUES (1,?)").run(TARGET);
  if (seed) {
    db.query("INSERT INTO qa_meta (key,value) VALUES (?,?)").run(
      Migrate.AUTHORITY,
      Migrate.LOCAL,
    );
    db.query("INSERT INTO qa_meta (key,value) VALUES (?,?)").run(
      Migrate.IMPORTED,
      "1",
    );
  }
  const cards: Tracker.Card[] = [];
  const files: Map<number, { card: number; name: string; bytes: Uint8Array }> =
    new Map();
  const removed: string[] = [];
  const tracker = {
    list: async (): Promise<Tracker.Card[]> =>
      cards.filter((card): boolean => card.status !== State.DELETED),
    get: async (id: number): Promise<Tracker.Card | null> =>
      cards.find((card): boolean => card.id === id) ?? null,
    attachments: async (card: number): Promise<Tracker.Attachment[]> =>
      [...files]
        .filter(([, file]): boolean => file.card === card)
        .map(([id, file]): Tracker.Attachment => ({ id, name: file.name })),
    download: async (id: number): Promise<Uint8Array> => {
      const file = files.get(id);
      if (!file) throw new Error("Attachment missing");

      return file.bytes;
    },
  } as unknown as Tracker.Tracker;
  const remove: Adapter.Remover = {
    note: async (id: number): Promise<boolean> => {
      removed.push(`note:${id}`);
      const card = cards.find((entry): boolean => entry.id === id);
      if (!card || card.status === State.DELETED) return false;
      card.status = State.DELETED;

      return true;
    },
    attachment: async (id: number): Promise<boolean> => {
      removed.push(`attachment:${id}`);

      return files.delete(id);
    },
  };

  return {
    folder,
    path,
    db,
    tracker,
    remove,
    removed,
    add: (title, tags, description = ""): number => {
      const id: number = cards.length + 1;
      cards.push({
        id,
        version: 1,
        title,
        description,
        checklist: "[]",
        tags,
        status: 0,
        comments: [`comment on ${id}`],
      });

      return id;
    },
    attach: (card, name, text): number => {
      const id: number = files.size + 100 + card;
      files.set(id, { card, name, bytes: new TextEncoder().encode(text) });

      return id;
    },
    input: (confirm?: number): Cleanup.Input => ({
      tracker,
      remove,
      db: path,
      project: PROJECT,
      target: TARGET,
      confirm,
    }),
  };
};
const run = (
  db: Database,
  id: string,
  status: string,
  receipt: string | null,
) =>
  db
    .query(
      "INSERT INTO qa_runs (id,project,mode,revision,scenario,expires,request,status,receipt) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      PROJECT,
      "discover",
      "a".repeat(40),
      "empty",
      0,
      id,
      status,
      receipt,
    );
const legacy = (db: Database, id: string): void => {
  db.query(
    "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
  ).run(id, "shot.png", "d", "image/png", 1);
};

test("dry run deletes nothing", async () => {
  const f = fixture();
  f.add("Run", RUN_TAGS);
  const card: number = f.add("Finding", FINDING_TAGS);
  f.attach(card, "quaz-record-x.json", "{}");

  expect(await Cleanup.cleanup(f.input())).toBeNull();
  expect(f.removed).toEqual([]);
  expect(existsSync(join(folder, "archive"))).toBe(false);
});

test("refuses a count mismatch", async () => {
  const f = fixture();
  f.add("Run", RUN_TAGS);
  const card: number = f.add("Finding", FINDING_TAGS);
  f.attach(card, "quaz-record-x.json", "{}");

  await expect(Cleanup.cleanup(f.input(1))).rejects.toThrow(
    "Confirmed 1 items but found 2",
  );
  expect(f.removed).toEqual([]);
  expect(existsSync(join(folder, "archive"))).toBe(false);
});

test("skips cards with the qa tag and unknown ids", async () => {
  const f = fixture();
  const deletable: number = f.add("Run", RUN_TAGS);
  const titled: number = f.add("QA smoke: sample", "", RUN_DESCRIPTION);
  f.add("Finding that kept a run tag", `qa-run,${FINDING_TAGS}`);
  f.add("Run title with qa tag", "qa", RUN_DESCRIPTION);
  const known: number = f.add("Referenced run", RUN_TAGS);
  f.add("Plain card", "project:sample");
  f.db
    .query(
      "INSERT INTO qa_findings (project,fingerprint,note_id,test) VALUES (?,?,?,?)",
    )
    .run(PROJECT, FINGERPRINT, known, "{}");
  run(f.db, "qa-gone", "complete", "receipt");
  f.db.query("UPDATE qa_runs SET note_id=999 WHERE id='qa-gone'").run();

  const summary = await Cleanup.cleanup(f.input(2));

  expect(summary).toEqual({ event: "board-cleanup", cards: 2, records: 0 });
  expect(f.removed.toSorted()).toEqual(
    [`note:${deletable}`, `note:${titled}`].toSorted(),
  );
});

test("refuses before records are imported", async () => {
  const f = fixture(false);
  f.add("Run", RUN_TAGS);
  await expect(Cleanup.cleanup(f.input(1))).rejects.toThrow(
    "not the local authority",
  );

  f.db
    .query("INSERT INTO qa_meta (key,value) VALUES (?,?)")
    .run(Migrate.AUTHORITY, Migrate.LOCAL);
  await expect(Cleanup.cleanup(f.input(1))).rejects.toThrow("not imported");
  expect(f.removed).toEqual([]);
});

test("refuses while a legacy run is unfinished", async () => {
  const f = fixture();
  f.add("Run", RUN_TAGS);
  run(f.db, "qa-live", "running", null);
  await expect(Cleanup.cleanup(f.input(1))).rejects.toThrow(
    "still running or publishing",
  );
  f.db.query("UPDATE qa_runs SET status='expired' WHERE id='qa-live'").run();
  legacy(f.db, "qa-live");
  await expect(Cleanup.cleanup(f.input(1))).rejects.toThrow(
    "unfinished Quaz runs",
  );
  f.db
    .query(
      "UPDATE qa_runs SET receipt='done',status='complete' WHERE id='qa-live'",
    )
    .run();
  f.db
    .query(
      "INSERT INTO qa_pending_findings (run,fingerprint,note_id) VALUES (?,?,?)",
    )
    .run("qa-live", FINGERPRINT, 7);
  await expect(Cleanup.cleanup(f.input(1))).rejects.toThrow(
    "unfinished Quaz runs",
  );
  f.db.query("DELETE FROM qa_pending_findings").run();

  expect(await Cleanup.cleanup(f.input(1))).toEqual({
    event: "board-cleanup",
    cards: 1,
    records: 0,
  });
  expect(f.removed).toEqual(["note:1"]);
});

test("refuses another tracking board", async () => {
  const f = fixture();
  f.add("Run", RUN_TAGS);
  f.db.query("UPDATE qa_destination SET value='https://other.test/a/b'").run();

  await expect(Cleanup.cleanup(f.input(1))).rejects.toThrow(
    "another tracking board",
  );
});

test("exports before delete and is idempotent", async () => {
  const f = fixture();
  const card: number = f.add("Run", RUN_TAGS, RUN_DESCRIPTION);
  const shot: number = f.attach(card, "shots/home.png", "png bytes");
  const finding: number = f.add("Finding", FINDING_TAGS);
  const record: number = f.attach(finding, "quaz-record-x.json", '{"a":1}');
  const folderOf = (id: number): string =>
    join(folder, "archive", "board-cleanup", String(id));
  const snapshots: boolean[] = [];
  const note = f.remove.note;
  f.remove.note = async (id: number): Promise<boolean> => {
    snapshots.push(
      existsSync(join(folderOf(card), "attachments", `${shot}-home.png`)) &&
        existsSync(
          join(folderOf(finding), "records", `${record}-quaz-record-x.json`),
        ),
    );

    return note(id);
  };

  const first = await Cleanup.cleanup(f.input(2));

  expect(first).toEqual({ event: "board-cleanup", cards: 1, records: 1 });
  expect(snapshots).toEqual([true]);
  expect(
    JSON.parse(readFileSync(join(folderOf(card), "note.json"), "utf8")).title,
  ).toBe("Run");
  expect(readFileSync(join(folderOf(card), "description.md"), "utf8")).toBe(
    RUN_DESCRIPTION,
  );
  expect(readFileSync(join(folderOf(card), "comments.json"), "utf8")).toContain(
    `comment on ${card}`,
  );
  expect(
    readFileSync(
      join(folderOf(card), "attachments", `${shot}-home.png`),
      "utf8",
    ),
  ).toBe("png bytes");
  expect(statSync(join(folderOf(card), "note.json")).mode & FILE_MODE).toBe(
    OWNER_ONLY,
  );
  expect(
    readFileSync(
      join(folderOf(finding), "records", `${record}-quaz-record-x.json`),
      "utf8",
    ),
  ).toBe('{"a":1}');

  const calls: number = f.removed.length;
  const second = await Cleanup.cleanup(f.input(0));

  expect(second).toEqual({ event: "board-cleanup", cards: 0, records: 0 });
  expect(f.removed).toHaveLength(calls);
});

test("skips items already gone on the board", async () => {
  const f = fixture();
  const card: number = f.add("Run", RUN_TAGS);
  f.remove.note = async (id: number): Promise<boolean> => {
    f.removed.push(`note:${id}`);
    const entry = await f.tracker.get(id);
    if (entry) entry.status = State.DELETED;

    return false;
  };

  expect(await Cleanup.cleanup(f.input(1))).toEqual({
    event: "board-cleanup",
    cards: 0,
    records: 0,
  });
  expect(f.removed).toEqual([`note:${card}`]);
});

test("deletes only record attachments on finding cards", async () => {
  const f = fixture();
  const finding: number = f.add("Finding", FINDING_TAGS);
  const record: number = f.attach(finding, "quaz-record-x.json", "{}");
  f.attach(finding, "quaz-evidence.png", "png");
  f.attach(finding, "quaz-record-notes.txt", "text");
  f.attach(finding, "other.json", "{}");
  const other: number = f.add("Other project", "qa,project:other");
  f.attach(other, "quaz-record-y.json", "{}");
  const manual: number = f.add("Manual", "project:sample");
  f.attach(manual, "quaz-record-z.json", "{}");

  const summary = await Cleanup.cleanup(f.input(1));

  expect(summary).toEqual({ event: "board-cleanup", cards: 0, records: 1 });
  expect(f.removed).toEqual([`attachment:${record}`]);
});

test("excludes run cards belonging to another project", async () => {
  const f = fixture();
  const deletable: number = f.add("Run", RUN_TAGS);
  f.add("Other project run", "qa-run,project:other");

  const summary = await Cleanup.cleanup(f.input(1));

  expect(summary).toEqual({ event: "board-cleanup", cards: 1, records: 0 });
  expect(f.removed).toEqual([`note:${deletable}`]);
});
