import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as Migrate from "@/migrate";
import type * as Protocol from "@/qa_protocol";
import * as State from "@/state";
import type * as Tracker from "@/tracker";

const REVISION: string = "a".repeat(40);
const FIRST: string = "b".repeat(64);
const SECOND: string = "c".repeat(64);
const THIRD: string = "d".repeat(64);
const DELETED: number = 2;
const TAGS: string = "qa,needs-verification,project:sample";
const testCase = (flow: string): Protocol.Case => ({
  flow,
  route: "/",
  steps: ["Enter text", "Save"],
  expected: "Text remains",
  scenario: "empty",
});
const opened: Database[] = [];
afterEach((): void => {
  for (const db of opened.splice(0)) db.close();
});

type Fixture = {
  db: Database;
  tracker: Tracker.Tracker;
  add: (
    tags: string,
    status: number,
    record?: (card: number) => unknown,
  ) => number;
  lists: (readonly string[] | undefined)[];
  reads: { attachments: number; downloads: number };
};
const fixture = (): Fixture => {
  const db: Database = new Database(":memory:");
  opened.push(db);
  State.prepare(db);
  const cards: Tracker.Card[] = [];
  const files: Map<number, { owner: number; name: string; bytes: Uint8Array }> =
    new Map();
  const lists: (readonly string[] | undefined)[] = [];
  const reads: { attachments: number; downloads: number } = {
    attachments: 0,
    downloads: 0,
  };
  const tracker = {
    list: async (statuses?: readonly string[]): Promise<Tracker.Card[]> => {
      lists.push(statuses);

      return cards;
    },
    get: async (id: number): Promise<Tracker.Card | null> =>
      cards.find((card): boolean => card.id === id) ?? null,
    attachments: async (owner: number): Promise<Tracker.Attachment[]> => {
      reads.attachments++;

      return [...files]
        .filter(([, file]): boolean => file.owner === owner)
        .map(([id, file]): Tracker.Attachment => ({ id, name: file.name }));
    },
    download: async (id: number): Promise<Uint8Array> => {
      reads.downloads++;
      const file = files.get(id);
      if (!file) throw new Error("Attachment missing");

      return file.bytes;
    },
  } as unknown as Tracker.Tracker;
  const add: Fixture["add"] = (tags, status, record) => {
    const id: number = cards.length + 1;
    cards.push({
      id,
      version: 1,
      title: `Card ${id}`,
      description: "",
      checklist: "[]",
      tags,
      status,
      comments: [],
    });
    if (record)
      files.set(files.size + 1, {
        owner: id,
        name: "quaz-record-x.json",
        bytes: new TextEncoder().encode(JSON.stringify(record(id))),
      });

    return id;
  };

  return { db, tracker, add, lists, reads };
};
const rows = (db: Database): string[] =>
  db
    .query<
      {
        project: string;
        fingerprint: string;
        note_id: number;
        fix: string | null;
        last_result: string | null;
      },
      []
    >(
      "SELECT project,fingerprint,note_id,fix,last_result FROM qa_findings ORDER BY fingerprint",
    )
    .all()
    .map(
      (row): string =>
        `${row.project}:${row.fingerprint[0]}:${row.note_id}:${row.fix}:${row.last_result}`,
    );
const marker = (db: Database): unknown =>
  db.query("SELECT 1 FROM qa_meta WHERE key=?").get(Migrate.IMPORTED);
const legacy = (card: number): unknown => ({
  version: 1,
  card,
  project: "sample",
  fingerprints: [FIRST],
  test: testCase("legacy"),
  fix: REVISION,
  lastResult: null,
});
const current = (card: number): unknown => ({
  version: 2,
  card,
  project: "sample",
  findings: [
    {
      fingerprint: SECOND,
      test: testCase("current"),
      fix: null,
      lastResult: "failed",
    },
    { fingerprint: THIRD, test: null, fix: null, lastResult: null },
  ],
});

test("one-time import copies v1 and v2 records into qa_findings", async () => {
  const { db, tracker, add, lists } = fixture();
  const log = spyOn(console, "log").mockImplementation((): void => {});
  const first: number = add(TAGS, 0, legacy);
  const second: number = add(TAGS, 1, current);
  add(TAGS, DELETED, legacy);
  add("project:sample", 0, legacy);
  add("qa,project:other", 0, legacy);
  add(TAGS, 0);
  db.query(
    "INSERT INTO qa_findings (project,fingerprint,note_id,test,fix) VALUES (?,?,?,?,?)",
  ).run("sample", FIRST, 99, JSON.stringify(testCase("stale")), "old");
  await Migrate.records(db, tracker);

  expect(rows(db)).toEqual([
    `sample:b:${first}:${REVISION}:null`,
    `sample:c:${second}:null:failed`,
  ]);
  expect(marker(db)).not.toBeNull();
  expect(lists).toEqual([["active", "completed", "archived"]]);
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: "quaz-records-imported", cards: 2, findings: 2 }),
  );
  log.mockRestore();
});

test("record import runs once and never reads attachments again", async () => {
  const { db, tracker, add, lists, reads } = fixture();
  const log = spyOn(console, "log").mockImplementation((): void => {});
  add(TAGS, 0, legacy);
  await Migrate.records(db, tracker);
  const imported: string[] = rows(db);
  const before: number = reads.attachments + reads.downloads;
  tracker.attachments = async (): Promise<Tracker.Attachment[]> => {
    throw new Error("Attachments must not be read again");
  };
  tracker.download = async (): Promise<Uint8Array> => {
    throw new Error("Attachments must not be downloaded again");
  };
  await Migrate.records(db, tracker);
  expect(lists).toHaveLength(1);
  const state: State.State = State.open(db, tracker);
  await state.catalog("sample");
  await state.state("sample");

  expect(before).toBeGreaterThan(0);
  expect(rows(db)).toEqual(imported);
  log.mockRestore();
});

test("failed record import sets no marker", async () => {
  const { db, tracker, add } = fixture();
  const log = spyOn(console, "log").mockImplementation((): void => {});
  add(TAGS, 0, legacy);
  add(TAGS, 0, current);
  const download = tracker.download;
  tracker.download = async (id: number): Promise<Uint8Array> => {
    if (id === 2) throw new Error("Attachment unavailable");

    return download(id);
  };

  await expect(Migrate.records(db, tracker)).rejects.toThrow(
    "Quaz record import failed on card 2",
  );
  expect(marker(db)).toBeNull();
  expect(rows(db)).toEqual([]);

  tracker.download = download;
  await Migrate.records(db, tracker);

  expect(marker(db)).not.toBeNull();
  expect(rows(db)).toHaveLength(2);
  log.mockRestore();
});
