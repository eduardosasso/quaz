import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Finish from "@/finish";
import * as Protocol from "@/qa_protocol";
import * as State from "@/state";
import type * as Tracker from "@/tracker";

const folders: string[] = [];
const MILLISECONDS: number = 1000;
afterEach((): void => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
const fixture = (): {
  state: State.State;
  cards: Map<number, Tracker.Card>;
  comments: Map<number, string[]>;
  files: Map<
    number,
    { owner: number; name: string; bytes: Uint8Array; mime: string }
  >;
} => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-test-"));
  folders.push(folder);
  const cards: Map<number, Tracker.Card> = new Map();
  const comments: Map<number, string[]> = new Map();
  const files: Map<
    number,
    { owner: number; name: string; bytes: Uint8Array; mime: string }
  > = new Map();
  const keys: Map<string, number> = new Map();
  let next: number = 1;
  let fileId: number = 1;
  const copy = (card: Tracker.Card): Tracker.Card => ({
    ...card,
    comments: [...(comments.get(card.id) ?? [])],
  });
  const tracker: Tracker.Tracker = {
    list: async (): Promise<Tracker.Card[]> => [...cards.values()].map(copy),
    get: async (id: number): Promise<Tracker.Card | null> => {
      const card = cards.get(id);
      return card ? copy(card) : null;
    },
    create: async (title: string, key: string): Promise<Tracker.Card> => {
      const prior: number | undefined = keys.get(key);
      if (prior && cards.get(prior)?.status !== 2)
        return copy(cards.get(prior) as Tracker.Card);
      const card: Tracker.Card = {
        id: next++,
        version: 1,
        title,
        description: "",
        checklist: "[]",
        tags: "",
        status: 0,
        comments: [],
      };
      cards.set(card.id, card);
      keys.set(key, card.id);
      return copy(card);
    },
    recover: async (key: string): Promise<Tracker.Card | null> => {
      const id: number | undefined = keys.get(key);
      const card: Tracker.Card | undefined = id ? cards.get(id) : undefined;
      return card && card.status !== 2 ? copy(card) : null;
    },
    update: async (
      id: number,
      changes: Tracker.Changes,
    ): Promise<Tracker.Card> => {
      const card = cards.get(id);
      if (!card) throw new Error("Card missing");
      const labels: Set<string> = new Set(card.tags.split(",").filter(Boolean));
      for (const label of changes.tagsAdd?.split(",").filter(Boolean) ?? [])
        labels.add(label);
      for (const label of changes.tagsRemove?.split(",").filter(Boolean) ?? [])
        labels.delete(label);
      const updated: Tracker.Card = {
        ...card,
        version: card.version + 1,
        title: changes.title ?? card.title,
        description: changes.description ?? card.description,
        checklist: changes.checklist ?? card.checklist,
        tags: changes.tags ?? [...labels].join(","),
      };
      cards.set(id, updated);
      return copy(updated);
    },
    complete: async (id: number): Promise<void> => {
      const card = cards.get(id);
      if (!card) throw new Error("Card missing");
      cards.set(id, { ...card, status: 1, version: card.version + 1 });
    },
    reopen: async (id: number): Promise<void> => {
      const card = cards.get(id);
      if (!card) throw new Error("Card missing");
      cards.set(id, { ...card, status: 0, version: card.version + 1 });
    },
    comment: async (id: number, body: string): Promise<void> => {
      comments.set(id, [...(comments.get(id) ?? []), body]);
      const card = cards.get(id);
      if (!card) throw new Error("Card missing");
      cards.set(id, { ...card, version: card.version + 1 });
    },
    upload: async (
      owner: number,
      path: string,
      bytes: Uint8Array,
      mime: string,
    ): Promise<Tracker.Attachment> => {
      const id: number = fileId++;
      files.set(id, { owner, name: path, bytes, mime });
      const card = cards.get(owner);
      if (!card) throw new Error("Card missing");
      cards.set(owner, { ...card, version: card.version + 1 });
      return { id, name: path };
    },
    attachments: async (owner: number): Promise<Tracker.Attachment[]> =>
      [...files]
        .filter(([, value]): boolean => value.owner === owner)
        .map(([id, value]): Tracker.Attachment => ({ id, name: value.name })),
    download: async (id: number): Promise<Uint8Array> => {
      const file = files.get(id);
      if (!file) throw new Error("Attachment missing");
      return file.bytes;
    },
    attachmentUrl: (id: number): string => `https://tracker.test/files/${id}`,
  };
  return {
    state: State.open(join(folder, "state.db"), tracker),
    cards,
    comments,
    files,
  };
};
const revision: string = "a".repeat(40);
const begin = (mode: Protocol.Mode): Protocol.Begin => ({
  id: `qa-${randomUUID()}`,
  project: "sample",
  mode,
  revision,
  runner: { source: revision, image: `sha256:${"b".repeat(64)}` },
  scenario: "empty",
});
const finding = (attachment: number): Protocol.Finding => ({
  fingerprint: "b".repeat(64),
  title: "Save loses text",
  actual: "Text disappeared",
  impact: "The user loses a draft",
  test: {
    flow: "save-draft",
    route: "/",
    steps: ["Enter text", "Save"],
    expected: "Text remains",
    scenario: "empty",
  },
  evidence: [attachment],
});

const recordFiles = (files: ReturnType<typeof fixture>["files"]): string[] =>
  [...files.values()]
    .map((file): string => file.name)
    .filter((name): boolean => name.startsWith("quaz-record-"));

test("migration timestamps previously verified findings", () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-migration-"));
  folders.push(folder);
  const database: Database = new Database(join(folder, "old.db"));
  try {
    database.exec(`
      CREATE TABLE qa_findings (
        project TEXT NOT NULL, fingerprint TEXT NOT NULL,
        note_id INTEGER NOT NULL, test TEXT NOT NULL,
        fix TEXT, last_result TEXT,
        verified_through INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project,fingerprint)
      );
      INSERT INTO qa_findings (project,fingerprint,note_id,test,verified_through)
      VALUES ('sample','verified',1,'{}',1),('sample','open',2,'{}',0);
    `);
    State.prepare(database);
    const verified = database
      .query<{ verified_at: number }, []>(
        "SELECT verified_at FROM qa_findings WHERE fingerprint='verified'",
      )
      .get();
    const open = database
      .query<{ verified_at: number }, []>(
        "SELECT verified_at FROM qa_findings WHERE fingerprint='open'",
      )
      .get();
    expect(verified?.verified_at).toBeGreaterThan(0);
    expect(verified?.verified_at).toBeLessThan(Date.now());
    expect(open?.verified_at).toBe(0);
    State.prepare(database);
    expect(
      database
        .query<{ verified_at: number }, []>(
          "SELECT verified_at FROM qa_findings WHERE fingerprint='verified'",
        )
        .get(),
    ).toEqual(verified);
  } finally {
    database.close();
  }
});

test("migration repairs existing zero verification timestamps", () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-migration-"));
  folders.push(folder);
  const database: Database = new Database(join(folder, "old.db"));
  try {
    database.exec(`
      CREATE TABLE qa_findings (
        project TEXT NOT NULL, fingerprint TEXT NOT NULL,
        note_id INTEGER NOT NULL, test TEXT NOT NULL,
        fix TEXT, last_result TEXT,
        verified_through INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project,fingerprint)
      );
      INSERT INTO qa_findings (project,fingerprint,note_id,test,verified_through,verified_at)
      VALUES ('sample','verified',1,'{}',1,0),('sample','open',2,'{}',0,0),
        ('sample','dated',3,'{}',1,123);
    `);
    State.prepare(database);
    const rows: { fingerprint: string; verified_at: number }[] = database
      .query<{ fingerprint: string; verified_at: number }, []>(
        "SELECT fingerprint,verified_at FROM qa_findings ORDER BY fingerprint",
      )
      .all();
    expect(rows[0]).toEqual({ fingerprint: "dated", verified_at: 123 });
    expect(rows[1]).toEqual({ fingerprint: "open", verified_at: 0 });
    expect(rows[2]?.verified_at).toBeGreaterThan(0);
    State.prepare(database);
    expect(
      database
        .query<{ fingerprint: string; verified_at: number }, []>(
          "SELECT fingerprint,verified_at FROM qa_findings ORDER BY fingerprint",
        )
        .all(),
    ).toEqual(rows);
  } finally {
    database.close();
  }
});

test("legacy card-less run stays out of scheduling history", async () => {
  const { state } = fixture();
  state.db
    .query(
      "INSERT INTO qa_runs (id,project,mode,revision,scenario,expires,request,recorded) VALUES (?,?,?,?,?,?,?,0)",
    )
    .run("qa-no-card", "sample", "discover", revision, "empty", 0, "{}");
  const current: Protocol.State = await state.state("sample");
  expect(current.runs).toEqual([]);
  expect(
    state.db
      .query<{ status: string }, []>(
        "SELECT status FROM qa_runs WHERE id='qa-no-card'",
      )
      .get(),
  ).toEqual({ status: "expired" });
});

test("migration hides card-less runs once", () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-migration-"));
  folders.push(folder);
  const database: Database = new Database(join(folder, "old.db"));
  try {
    database.exec(`
      CREATE TABLE qa_runs (
        id TEXT PRIMARY KEY, note_id INTEGER, board_id INTEGER NOT NULL DEFAULT 0,
        owner TEXT NOT NULL DEFAULT 'quaz', project TEXT NOT NULL, mode TEXT NOT NULL,
        revision TEXT NOT NULL, scenario TEXT NOT NULL, attention TEXT,
        status TEXT NOT NULL DEFAULT 'running', expires INTEGER NOT NULL,
        target INTEGER, snapshot INTEGER, receipt TEXT, request TEXT NOT NULL,
        result TEXT, started INTEGER, publish TEXT, publish_lease INTEGER,
        publish_held TEXT
      );
      INSERT INTO qa_runs (id,note_id,project,mode,revision,scenario,expires,request)
      VALUES ('qa-card',5,'sample','smoke','r','empty',0,'{}'),
             ('qa-bare',NULL,'sample','smoke','r','empty',0,'{}');
    `);
    State.prepare(database);
    database.exec(
      "INSERT INTO qa_runs (id,project,mode,revision,scenario,expires,request) VALUES ('qa-new','sample','smoke','r','empty',0,'{}')",
    );
    State.prepare(database);
    const recorded = database
      .query<{ id: string; recorded: number }, []>(
        "SELECT id,recorded FROM qa_runs ORDER BY id",
      )
      .all();

    expect(recorded).toEqual([
      { id: "qa-bare", recorded: 0 },
      { id: "qa-card", recorded: 1 },
      { id: "qa-new", recorded: 1 },
    ]);
  } finally {
    database.close();
  }
});

test("run cards stay out of the issue catalog without tags", async () => {
  const { state, cards } = fixture();
  cards.set(7, {
    id: 7,
    version: 1,
    title: "QA discover: sample",
    description: "Run qa-old\nMode: discover",
    checklist: "[]",
    tags: "",
    status: 1,
    comments: [],
  });
  state.db
    .query(
      "INSERT INTO qa_runs (id,note_id,project,mode,revision,scenario,expires,request) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run("qa-old", 7, "sample", "discover", revision, "empty", 0, "{}");

  expect((await state.catalog("sample")).cards).toEqual([]);
});

test("begin creates no card and is idempotent", async () => {
  const { state, cards } = fixture();
  const input: Protocol.Begin = begin("discover");
  const first: Protocol.Run = state.begin(input);
  const second: Protocol.Run = state.begin(input);

  expect(first.note_id).toBeNull();
  expect(second).toEqual(first);
  expect(cards.size).toBe(0);
  expect(
    state.db
      .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM qa_runs")
      .get()?.total,
  ).toBe(1);
  expect((await state.state("sample")).runs.map((run) => run.id)).toEqual([
    input.id,
  ]);
  expect(() => state.begin({ ...input, scenario: "other" })).toThrow(
    "different inputs",
  );
});

test("interrupted run is persisted as interrupted", async () => {
  const { state } = fixture();
  const run: Protocol.Run = state.begin(begin("smoke"));
  const result: Protocol.Finish = {
    status: Protocol.INTERRUPTED,
    summary: "QA run interrupted",
    report: { summary: "QA run interrupted" },
    findings: [],
    evidence: [],
    verdict: "none",
    deployment: null,
  };
  await Finish.publish(state, run.id, result);

  expect(state.run(run.id).status).toBe(Protocol.INTERRUPTED);
});

test("finished run replay keeps its local report", async () => {
  const { state, cards } = fixture();
  const input: Protocol.Begin = begin("smoke");
  const run: Protocol.Run = state.begin(input);
  const result: Protocol.Finish = {
    status: "failed",
    summary: "Image build timed out",
    report: { summary: "Image build timed out" },
    findings: [],
    evidence: [],
    verdict: "none",
    deployment: null,
  };
  await Finish.publish(state, run.id, result);
  const stored = (): string | null | undefined =>
    state.db
      .query<{ report: string | null }, [string]>(
        "SELECT report FROM qa_runs WHERE id=?",
      )
      .get(run.id)?.report;
  const report: string | null | undefined = stored();

  expect(JSON.parse(report ?? "{}")).toEqual({
    summary: "Image build timed out",
    report: { summary: "Image build timed out" },
  });
  expect(state.begin(input).status).toBe("failed");
  expect((await Finish.publish(state, run.id, result)).replayed).toBe(true);
  expect(stored()).toBe(report);
  expect(cards.size).toBe(0);
});

test("expired, failed or held run touches no card", async () => {
  const { state, cards, comments, files } = fixture();
  const expired: Protocol.Run = state.begin(begin("discover"));
  state.db.query("UPDATE qa_runs SET expires=0 WHERE id=?").run(expired.id);
  await state.state("sample");
  expect(state.run(expired.id).status).toBe("expired");
  const failed: Protocol.Run = state.begin(begin("smoke"));
  await Finish.publish(state, failed.id, {
    status: "failed",
    summary: "Image build timed out",
    report: {},
    findings: [],
    evidence: [],
    verdict: "none",
    deployment: null,
  });
  const held: Protocol.Run = state.begin(begin("discover"));
  state.ready(held.id);
  await state.claim(held.id, "save-draft", "Save retains text");
  const attachment: number = state.store(
    held.id,
    "proof.txt",
    new TextEncoder().encode("proof"),
    "text/plain",
  );
  const result: Finish.Result = await Finish.publish(state, held.id, {
    status: "complete",
    summary: "One issue",
    report: {},
    findings: [finding(attachment)],
    evidence: [attachment],
    verdict: "none",
    deployment: null,
    matching: { snapshot: "stale", decisions: [] },
  });

  expect(result.held).toContain("Publication lease expired");
  expect([cards.size, comments.size, files.size]).toEqual([0, 0, 0]);
  expect(
    JSON.parse(
      state.db
        .query<{ report: string }, [string]>(
          "SELECT report FROM qa_runs WHERE id=?",
        )
        .get(held.id)?.report ?? "{}",
    ).publication.held,
  ).toContain("Publication lease expired");
});

test("older untagged run cards stay out of the issue catalog", async () => {
  const { state, cards } = fixture();
  cards.set(42, {
    id: 42,
    version: 1,
    title: "QA discover: sample",
    description: "Run qa-old-1\r\nMode: discover\r\nStatus: partial",
    checklist: "[]",
    tags: "needs-attention",
    status: 1,
    comments: [],
  });

  expect((await state.catalog("sample")).cards).toEqual([]);
});

test("ordinary QA titled issue stays in the catalog", async () => {
  const { state, cards } = fixture();
  cards.set(42, {
    id: 42,
    version: 1,
    title: "QA discover: login",
    description: "The login screen fails after submit.",
    checklist: "[]",
    tags: "",
    status: 0,
    comments: [],
  });

  expect((await state.catalog("sample")).cards.map((card) => card.id)).toEqual([
    42,
  ]);
});

const ACTIVE: number = 0;
const COMPLETED: number = 1;
const ARCHIVED: number = 3;
const card = (
  id: number,
  status: number,
  description: string = "",
): Tracker.Card => ({
  id,
  version: 1,
  title: `Issue ${id}`,
  description,
  checklist: "[]",
  tags: "",
  status,
  comments: [],
});

test("catalog leaves out archived cards", async () => {
  const { state, cards } = fixture();
  cards.set(1, card(1, ACTIVE));
  cards.set(2, card(2, COMPLETED));
  cards.set(3, card(3, ARCHIVED));

  expect(
    (await state.catalog("sample")).cards.map((entry) => entry.id),
  ).toEqual([1, 2]);
});

test("catalog under the limit after archiving", async () => {
  const { state, cards } = fixture();
  const bulk: string = "x".repeat(Protocol.CATALOG_BYTES);
  cards.set(1, card(1, ACTIVE));
  cards.set(2, card(2, ARCHIVED, bulk));

  expect(
    (await state.catalog("sample")).cards.map((entry) => entry.id),
  ).toEqual([1]);

  cards.set(3, card(3, COMPLETED, bulk));

  await expect(state.catalog("sample")).rejects.toThrow("review limit");
});

test("discovery retries after a partial issue card write", async () => {
  const { state, cards, files } = fixture();
  const input: Protocol.Begin = begin("discover");
  const run: Protocol.Run = state.begin(input);
  state.ready(run.id);
  expect(await state.claim(run.id, "save-draft", "Save retains text")).toBe(
    true,
  );
  const bytes: Uint8Array = new TextEncoder().encode("proof");
  const attachment: number = state.store(
    run.id,
    "proof.txt",
    bytes,
    "text/plain",
  );
  const catalog: Protocol.Catalog | null = await state.publication(run.id);
  if (!catalog) throw new Error("Publication lease missing");
  const issue: Protocol.Finding = finding(attachment);
  const result: Protocol.Finish = {
    status: "complete",
    summary: "One issue",
    report: {},
    findings: [issue],
    evidence: [attachment],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: catalog.snapshot,
      decisions: [
        {
          fingerprint: issue.fingerprint,
          verdict: "new",
          target: null,
          sameAs: null,
          reason: "No match",
        },
      ],
    },
  };
  const create: Tracker.Tracker["create"] = state.tracker.create;
  let creations: number = 0;
  state.tracker.create = async (
    title: string,
    key: string,
  ): Promise<Tracker.Card> => {
    creations += 1;

    return create(title, `${key}-${creations}`);
  };
  const update: Tracker.Tracker["update"] = state.tracker.update;
  let failOnce: boolean = true;
  state.tracker.update = async (
    id: number,
    changes: Tracker.Changes,
  ): Promise<Tracker.Card> => {
    if (failOnce) {
      failOnce = false;
      throw new Error("interrupted write");
    }
    return update(id, changes);
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "interrupted write",
  );
  expect(creations).toBe(1);
  expect(cards.size).toBe(1);
  expect((await state.catalog("sample")).cards).toEqual([
    expect.objectContaining({
      id: 1,
      fingerprints: [issue.fingerprint],
    }),
  ]);
  const first: Finish.Result = await Finish.publish(state, run.id, result);
  const second: Finish.Result = await Finish.publish(state, run.id, result);
  expect(first.created).toHaveLength(1);
  expect(second.replayed).toBe(true);
  expect(cards.size).toBe(1);
  expect(creations).toBe(1);
  expect(
    [...files.values()]
      .filter((file): boolean => /^quaz-[a-f0-9]/.test(file.name))
      .map((file): string => file.mime),
  ).toEqual(["text/plain"]);
  expect(state.finding(first.created[0])?.fingerprint).toBe(issue.fingerprint);
});

test("later discovery can reuse an abandoned pending finding", async () => {
  const { state, cards } = fixture();
  const first: Protocol.Run = state.begin(begin("discover"));
  state.ready(first.id);
  await state.claim(first.id, "save-draft", "Save retains text");
  const bytes: Uint8Array = new TextEncoder().encode("proof");
  const attachment: number = state.store(
    first.id,
    "proof.txt",
    bytes,
    "text/plain",
  );
  const initial: Protocol.Catalog | null = await state.publication(first.id);
  if (!initial) throw new Error("Publication lease missing");
  const issue: Protocol.Finding = finding(attachment);
  const result: Protocol.Finish = {
    status: "complete",
    summary: "One issue",
    report: {},
    findings: [issue],
    evidence: [attachment],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: initial.snapshot,
      decisions: [
        {
          fingerprint: issue.fingerprint,
          verdict: "new",
          target: null,
          sameAs: null,
          reason: "No match",
        },
      ],
    },
  };
  const update: Tracker.Tracker["update"] = state.tracker.update;
  let interrupted: boolean = false;
  state.tracker.update = async (
    id: number,
    changes: Tracker.Changes,
  ): Promise<Tracker.Card> => {
    if (id !== first.note_id && !interrupted) {
      interrupted = true;
      throw new Error("metadata interrupted");
    }

    return update(id, changes);
  };
  await expect(Finish.publish(state, first.id, result)).rejects.toThrow(
    "metadata interrupted",
  );
  state.db
    .query("UPDATE qa_runs SET publish_lease=? WHERE id=?")
    .run(Date.now() + Protocol.PUBLICATION_SECONDS * MILLISECONDS, first.id);
  state.db
    .query("UPDATE qa_publications SET expires=0 WHERE run=?")
    .run(first.id);
  const pending = (await state.catalog("sample")).cards;
  expect(pending).toHaveLength(1);
  expect(pending[0]?.fingerprints).toEqual([issue.fingerprint]);
  state.db.query("UPDATE qa_flows SET expires=0 WHERE run=?").run(first.id);
  const second: Protocol.Run = await state.begin(begin("discover"));
  state.ready(second.id);
  expect(await state.claim(second.id, "save-draft", "Save retains text")).toBe(
    true,
  );
  const next: Protocol.Catalog | null = await state.publication(second.id);
  if (!next) throw new Error("Second publication lease missing");
  const published: Finish.Result = await Finish.publish(state, second.id, {
    ...result,
    findings: [{ ...issue, evidence: [] }],
    evidence: [],
    matching: {
      snapshot: next.snapshot,
      decisions: [
        {
          fingerprint: issue.fingerprint,
          verdict: "existing",
          target: pending[0]?.id ?? null,
          sameAs: null,
          reason: "Same fingerprint",
        },
      ],
    },
  });
  expect(published.cards).toEqual([pending[0]?.id]);
  expect(cards.size).toBe(1);
  expect(cards.get(pending[0]?.id ?? 0)?.tags).toContain("needs-verification");
});

test("later discovery reuses a bare card after create interruption", async () => {
  const { state, cards } = fixture();
  const first: Protocol.Run = state.begin(begin("discover"));
  state.ready(first.id);
  await state.claim(first.id, "save-draft", "Save retains text");
  const initial: Protocol.Catalog | null = await state.publication(first.id);
  if (!initial) throw new Error("Publication lease missing");
  const issue: Protocol.Finding = { ...finding(0), evidence: [] };
  const result: Protocol.Finish = {
    status: "complete",
    summary: "One issue",
    report: {},
    findings: [issue],
    evidence: [],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: initial.snapshot,
      decisions: [
        {
          fingerprint: issue.fingerprint,
          verdict: "new",
          target: null,
          sameAs: null,
          reason: "No match",
        },
      ],
    },
  };
  const create: Tracker.Tracker["create"] = state.tracker.create;
  let stopped: boolean = false;
  state.tracker.create = async (
    title: string,
    key: string,
  ): Promise<Tracker.Card> => {
    const card: Tracker.Card = await create(title, key);
    if (key.startsWith("quaz-finding-") && !stopped) {
      stopped = true;
      throw new Error("Stopped after create");
    }

    return card;
  };
  await expect(Finish.publish(state, first.id, result)).rejects.toThrow(
    "Stopped after create",
  );
  expect(cards.size).toBe(1);
  expect((await state.catalog("other")).cards).toEqual([]);
  expect((await state.catalog("sample")).cards[0]?.fingerprints).toEqual([
    issue.fingerprint,
  ]);
  state.db
    .query("UPDATE qa_publications SET expires=0 WHERE run=?")
    .run(first.id);
  state.db.query("UPDATE qa_flows SET expires=0 WHERE run=?").run(first.id);
  const second: Protocol.Run = await state.begin(begin("discover"));
  state.ready(second.id);
  await state.claim(second.id, "save-draft", "Save retains text");
  const next: Protocol.Catalog | null = await state.publication(second.id);
  if (!next) throw new Error("Second publication lease missing");
  const published: Finish.Result = await Finish.publish(state, second.id, {
    ...result,
    matching: {
      snapshot: next.snapshot,
      decisions: [
        {
          fingerprint: issue.fingerprint,
          verdict: "existing",
          target: 1,
          sameAs: null,
          reason: "Same fingerprint",
        },
      ],
    },
  });
  expect(published.cards).toEqual([1]);
  expect(published.created).toEqual([]);
  expect(cards.size).toBe(1);
  expect(cards.get(1)?.tags).toContain(Protocol.TAG.pending);
});

test("reproduced card clears its old fix after an interrupted reopen", async () => {
  const { state, cards, comments } = fixture();
  const original: Tracker.Card = await state.tracker.create("Old issue", "old");
  const issue: Tracker.Card = await state.tracker.update(original.id, {
    tags: "qa,verified,project:sample",
  });
  cards.set(issue.id, { ...issue, status: 1 });
  const fingerprint: string = "d".repeat(64);
  state.db
    .query(
      "INSERT INTO qa_findings (project,fingerprint,note_id,test,fix,last_result) VALUES (?,?,?,?,?,?)",
    )
    .run("sample", fingerprint, issue.id, "{}", revision, "old result");
  const run: Protocol.Run = await state.begin(begin("discover"));
  state.ready(run.id);
  await state.claim(run.id, "save-draft", "Save retains text");
  const catalog: Protocol.Catalog | null = await state.publication(run.id);
  if (!catalog) throw new Error("Publication lease missing");
  const candidate: Protocol.Finding = {
    ...finding(0),
    fingerprint,
    evidence: [],
  };
  const result: Protocol.Finish = {
    status: "complete",
    summary: "Reproduced",
    report: {},
    findings: [candidate],
    evidence: [],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: catalog.snapshot,
      decisions: [
        {
          fingerprint,
          verdict: "existing",
          target: issue.id,
          sameAs: null,
          reason: "Same issue",
        },
      ],
    },
  };
  const update: Tracker.Tracker["update"] = state.tracker.update;
  let stopped: boolean = false;
  state.tracker.update = async (
    id: number,
    changes: Tracker.Changes,
  ): Promise<Tracker.Card> => {
    const card: Tracker.Card = await update(id, changes);
    if (
      id === issue.id &&
      changes.tagsAdd === Protocol.TAG.pending &&
      !stopped
    ) {
      stopped = true;
      throw new Error("Stopped after pending tags");
    }

    return card;
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "Stopped after pending tags",
  );
  expect(cards.get(issue.id)?.status).toBe(0);
  expect(state.finding(issue.id)?.fix).toBeNull();
  expect((await Finish.publish(state, run.id, result)).cards).toEqual([
    issue.id,
  ]);
  expect(state.finding(issue.id)?.fix).toBeNull();
  expect(state.finding(issue.id)?.last_result).toBeNull();
  expect(comments.get(issue.id)?.at(-1)).toContain(
    "reproduces this issue again",
  );
});

test("verification recovers interrupted card changes", async () => {
  const { state, cards, comments } = fixture();
  const created: Tracker.Card = await state.tracker.create(
    "Broken save",
    "issue",
  );
  const issue: Tracker.Card = await state.tracker.update(created.id, {
    tags: "qa,needs-verification,project:sample",
    description: "Broken",
  });
  cards.set(issue.id, { ...issue, status: 1 });
  state.db
    .query(
      "INSERT INTO qa_findings (project,fingerprint,note_id,test,fix) VALUES (?,?,?,?,?)",
    )
    .run(
      "sample",
      "c".repeat(64),
      issue.id,
      JSON.stringify({
        flow: "save-draft",
        route: "/",
        steps: ["Save"],
        expected: "Saved",
        scenario: "empty",
      }),
      revision,
    );
  const input: Protocol.Begin = begin("verify");
  const run: Protocol.Run = await state.begin(input);
  state.ready(run.id);
  expect(
    await state.claim(run.id, `ticket-${issue.id}`, "Saved", issue.id),
  ).toBe(true);
  const bytes: Uint8Array = new TextEncoder().encode("failed");
  const attachment: number = state.store(
    run.id,
    "failure.txt",
    bytes,
    "text/plain",
  );
  const result: Protocol.Finish = {
    status: "complete",
    summary: "Still broken",
    report: {},
    findings: [],
    evidence: [attachment],
    verdict: "fail",
    deployment: { expected: revision, deployed: revision, tested: revision },
  };
  const invalid: Protocol.Finish = { ...result, deployment: null };
  await expect(Finish.publish(state, run.id, invalid)).rejects.toThrow(
    "Verification needs completed tests",
  );
  expect(
    state.db
      .query<{ publish: string | null }, [string]>(
        "SELECT publish FROM qa_runs WHERE id=?",
      )
      .get(run.id)?.publish,
  ).toBeNull();
  const upload: Tracker.Tracker["upload"] = state.tracker.upload;
  let uploadStopped: boolean = false;
  state.tracker.upload = async (
    owner: number,
    path: string,
    content: Uint8Array,
    mime: string,
  ): Promise<Tracker.Attachment> => {
    const added: Tracker.Attachment = await upload(owner, path, content, mime);
    if (owner === issue.id && !uploadStopped) {
      uploadStopped = true;
      throw new Error("Stopped after attachment");
    }

    return added;
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "Stopped after attachment",
  );
  const reopen: Tracker.Tracker["reopen"] = state.tracker.reopen;
  let interrupted: boolean = false;
  state.tracker.reopen = async (id: number): Promise<void> => {
    await reopen(id);
    if (!interrupted) {
      interrupted = true;
      throw new Error("Stopped after reopen");
    }
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "Stopped after reopen",
  );
  expect(cards.get(issue.id)?.status).toBe(0);
  const update: Tracker.Tracker["update"] = state.tracker.update;
  interrupted = false;
  state.tracker.update = async (
    id: number,
    changes: Tracker.Changes,
  ): Promise<Tracker.Card> => {
    const card: Tracker.Card = await update(id, changes);
    if (
      id === issue.id &&
      changes.tagsAdd === Protocol.TAG.pending &&
      !interrupted
    ) {
      interrupted = true;
      throw new Error("Stopped after failure tags");
    }

    return card;
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "Stopped after failure tags",
  );
  const published: Finish.Result = await Finish.publish(state, run.id, result);
  expect(published.cards).toEqual([issue.id]);
  expect(cards.get(issue.id)?.status).toBe(0);
  expect(comments.get(issue.id)?.at(-1)).toContain("QA fail");
  expect((await Finish.publish(state, run.id, result)).replayed).toBe(true);
  expect(comments.get(issue.id)).toHaveLength(1);
  expect(cards.get(issue.id)?.version).toBe(issue.version + 4);

  await state.tracker.complete(issue.id);
  const passed: Protocol.Run = await state.begin(begin("verify"));
  state.ready(passed.id);
  await state.claim(passed.id, `ticket-${issue.id}`, "Saved", issue.id);
  const passEvidence: number = state.store(
    passed.id,
    "pass.txt",
    bytes,
    "text/plain",
  );
  const pass: Protocol.Finish = {
    ...result,
    summary: "Fixed",
    evidence: [passEvidence],
    verdict: "pass",
  };
  interrupted = false;
  state.tracker.update = async (
    id: number,
    changes: Tracker.Changes,
  ): Promise<Tracker.Card> => {
    const card: Tracker.Card = await update(id, changes);
    if (
      id === issue.id &&
      changes.tagsAdd === Protocol.TAG.verified &&
      !interrupted
    ) {
      interrupted = true;
      throw new Error("Stopped after pass tags");
    }

    return card;
  };
  await expect(Finish.publish(state, passed.id, pass)).rejects.toThrow(
    "Stopped after pass tags",
  );
  expect((await Finish.publish(state, passed.id, pass)).cards).toEqual([
    issue.id,
  ]);
  expect(cards.get(issue.id)?.tags).toContain(Protocol.TAG.verified);
  expect(
    state.db
      .query<{ verified_through: number }, [number]>(
        "SELECT verified_through FROM qa_findings WHERE note_id=?",
      )
      .get(issue.id)?.verified_through,
  ).toBeGreaterThan(0);
});

test("verification retry rejects an externally edited card", async () => {
  const { state, cards, comments } = fixture();
  const created: Tracker.Card = await state.tracker.create(
    "Broken save",
    "issue",
  );
  const issue: Tracker.Card = await state.tracker.update(created.id, {
    tags: "qa,needs-verification,project:sample",
  });
  cards.set(issue.id, { ...issue, status: 1 });
  state.db
    .query(
      "INSERT INTO qa_findings (project,fingerprint,note_id,test) VALUES (?,?,?,?)",
    )
    .run(
      "sample",
      "c".repeat(64),
      issue.id,
      JSON.stringify({
        flow: "save-draft",
        route: "/",
        steps: ["Save"],
        expected: "Saved",
        scenario: "empty",
      }),
    );
  const run: Protocol.Run = await state.begin(begin("verify"));
  state.ready(run.id);
  await state.claim(run.id, `ticket-${issue.id}`, "Saved", issue.id);
  const result: Protocol.Finish = {
    status: "partial",
    summary: "Needs another check",
    report: {},
    findings: [],
    evidence: [],
    verdict: "blocked",
    deployment: null,
  };
  const comment: Tracker.Tracker["comment"] = state.tracker.comment;
  const update: Tracker.Tracker["update"] = state.tracker.update;
  state.tracker.comment = async (id: number, body: string): Promise<void> => {
    await comment(id, body);
    await update(id, { description: "Changed externally" });
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "Verification card changed during publication",
  );
  const priorComments: number = comments.get(issue.id)?.length ?? 0;
  const published: Finish.Result = await Finish.publish(state, run.id, result);
  expect(published.run.status).toBe("superseded");
  expect(published.cards).toEqual([]);
  expect(comments.get(issue.id)).toHaveLength(priorComments);
});

test("verification accepts tracker comment line endings", async () => {
  const { state, cards, comments } = fixture();
  const created: Tracker.Card = await state.tracker.create(
    "Broken save",
    "issue",
  );
  const issue: Tracker.Card = await state.tracker.update(created.id, {
    tags: "qa,needs-verification,project:sample",
  });
  cards.set(issue.id, { ...issue, status: 1 });
  state.db
    .query(
      "INSERT INTO qa_findings (project,fingerprint,note_id,test) VALUES (?,?,?,?)",
    )
    .run(
      "sample",
      "c".repeat(64),
      issue.id,
      JSON.stringify({
        flow: "save-draft",
        route: "/",
        steps: ["Save"],
        expected: "Saved",
        scenario: "empty",
      }),
    );
  const run: Protocol.Run = await state.begin(begin("verify"));
  state.ready(run.id);
  await state.claim(run.id, `ticket-${issue.id}`, "Saved", issue.id);
  const comment: Tracker.Tracker["comment"] = state.tracker.comment;
  let interrupted: boolean = false;
  state.tracker.comment = async (id: number, body: string): Promise<void> => {
    await comment(id, body.replace(/\n/g, "\r\n"));
    if (!interrupted) {
      interrupted = true;
      throw new Error("Stopped after comment");
    }
  };
  const result: Protocol.Finish = {
    status: "partial",
    summary: "Needs another check",
    report: {},
    findings: [],
    evidence: [],
    verdict: "blocked",
    deployment: null,
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "Stopped after comment",
  );
  const published: Finish.Result = await Finish.publish(state, run.id, result);
  expect(published.cards).toEqual([issue.id]);
  expect(comments.get(issue.id)).toHaveLength(1);
  expect((await Finish.publish(state, run.id, result)).replayed).toBe(true);
  expect(comments.get(issue.id)).toHaveLength(1);

  const next: Protocol.Run = await state.begin(begin("verify"));
  state.ready(next.id);
  await state.claim(next.id, `ticket-${issue.id}`, "Saved", issue.id);
  const second: Finish.Result = await Finish.publish(state, next.id, {
    ...result,
    summary: "Needs a third check",
  });
  expect(second.cards).toEqual([issue.id]);
  expect(comments.get(issue.id)).toHaveLength(2);
});

test("verification retry rejects a changed card", async () => {
  const { state, cards } = fixture();
  const created: Tracker.Card = await state.tracker.create(
    "Broken save",
    "issue",
  );
  const issue: Tracker.Card = await state.tracker.update(created.id, {
    tags: "qa,needs-verification,project:sample",
  });
  await state.tracker.complete(issue.id);
  state.db
    .query(
      "INSERT INTO qa_findings (project,fingerprint,note_id,test,fix) VALUES (?,?,?,?,?)",
    )
    .run(
      "sample",
      "c".repeat(64),
      issue.id,
      JSON.stringify({
        flow: "save-draft",
        route: "/",
        steps: ["Save"],
        expected: "Saved",
        scenario: "empty",
      }),
      revision,
    );
  const run: Protocol.Run = await state.begin(begin("verify"));
  state.ready(run.id);
  await state.claim(run.id, `ticket-${issue.id}`, "Saved", issue.id);
  const bytes: Uint8Array = new TextEncoder().encode("proof");
  const attachment: number = state.store(
    run.id,
    "proof.txt",
    bytes,
    "text/plain",
  );
  const result: Protocol.Finish = {
    status: "complete",
    summary: "Save works",
    report: {},
    findings: [],
    evidence: [attachment],
    verdict: "pass",
    deployment: { expected: revision, deployed: revision, tested: revision },
  };
  const attachments: Tracker.Tracker["attachments"] = state.tracker.attachments;
  state.tracker.attachments = async (): Promise<Tracker.Attachment[]> => {
    throw new Error("API interrupted before any mutation");
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "API interrupted before any mutation",
  );
  state.tracker.attachments = attachments;
  await state.tracker.reopen(issue.id);
  await state.tracker.update(issue.id, {
    title: "Human changed acceptance criteria",
    tagsRemove: "needs-verification",
  });

  const retry: Finish.Result = await Finish.publish(state, run.id, result);
  expect(retry.run.status).toBe("superseded");
  expect(cards.get(issue.id)?.tags).not.toContain("verified");
});

test("matched card becomes a tracked issue", async () => {
  const { state, files } = fixture();
  const created: Tracker.Card = await state.tracker.create(
    "Existing report",
    "existing",
  );
  const issue: Tracker.Card = await state.tracker.update(created.id, {
    tags: "project:sample",
  });
  const run: Protocol.Run = await state.begin(begin("discover"));
  state.ready(run.id);
  await state.claim(run.id, "save-draft", "Save retains text");
  const bytes: Uint8Array = new TextEncoder().encode("proof");
  const attachment: number = state.store(
    run.id,
    "proof.txt",
    bytes,
    "text/plain",
  );
  const catalog: Protocol.Catalog | null = await state.publication(run.id);
  if (!catalog) throw new Error("Publication lease missing");
  const found: Protocol.Finding = finding(attachment);
  const result: Protocol.Finish = {
    status: "complete",
    summary: "Matched existing report",
    report: {},
    findings: [found],
    evidence: [attachment],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: catalog.snapshot,
      decisions: [
        {
          fingerprint: found.fingerprint,
          verdict: "existing",
          target: issue.id,
          sameAs: null,
          reason: "Same issue",
        },
      ],
    },
  };
  await Finish.publish(state, run.id, result);
  await state.tracker.complete(issue.id);

  expect(
    (await state.state("sample")).tickets.map((ticket) => ticket.id),
  ).toEqual([issue.id]);
  expect(
    state.db
      .query<{ note_id: number; test: string }, [string]>(
        "SELECT note_id,test FROM qa_findings WHERE fingerprint=?",
      )
      .all(found.fingerprint),
  ).toEqual([{ note_id: issue.id, test: JSON.stringify(found.test) }]);
  expect(recordFiles(files)).toEqual([]);
});

test("older discovery cannot reopen a newly verified issue", async () => {
  const { state, cards } = fixture();
  const created: Tracker.Card = await state.tracker.create(
    "Broken save",
    "issue",
  );
  const issue: Tracker.Card = await state.tracker.update(created.id, {
    tags: "qa,needs-verification,project:sample",
  });
  await state.tracker.complete(issue.id);
  const found: Protocol.Finding = finding(1);
  state.db
    .query(
      "INSERT INTO qa_findings (project,fingerprint,note_id,test,fix) VALUES (?,?,?,?,?)",
    )
    .run(
      "sample",
      found.fingerprint,
      issue.id,
      JSON.stringify(found.test),
      revision,
    );
  const verify: Protocol.Run = await state.begin(begin("verify"));
  state.ready(verify.id);
  await state.claim(verify.id, `ticket-${issue.id}`, "Save works", issue.id);
  const discover: Protocol.Run = await state.begin(begin("discover"));
  state.ready(discover.id);
  await state.claim(discover.id, found.test.flow, "Save retains text");
  const bytes: Uint8Array = new TextEncoder().encode("proof");
  const verifyFile: number = state.store(
    verify.id,
    "verify.txt",
    bytes,
    "text/plain",
  );
  const discoverFile: number = state.store(
    discover.id,
    "discover.txt",
    bytes,
    "text/plain",
  );
  await Finish.publish(state, verify.id, {
    status: "complete",
    summary: "Save works",
    report: {},
    findings: [],
    evidence: [verifyFile],
    verdict: "pass",
    deployment: { expected: revision, deployed: revision, tested: revision },
  });
  const catalog: Protocol.Catalog | null = await state.publication(discover.id);
  if (!catalog) throw new Error("Publication lease missing");
  await Finish.publish(state, discover.id, {
    status: "complete",
    summary: "Old discovery result",
    report: {},
    findings: [finding(discoverFile)],
    evidence: [discoverFile],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: catalog.snapshot,
      decisions: [
        {
          fingerprint: found.fingerprint,
          verdict: "existing",
          target: issue.id,
          sameAs: null,
          reason: "Same issue",
        },
      ],
    },
  });

  expect(cards.get(issue.id)?.status).toBe(1);
  expect(cards.get(issue.id)?.tags).toContain("verified");
  expect(state.finding(issue.id)?.fix).toBe(revision);
});

test("same-run findings retain both fingerprints", async () => {
  const { state } = fixture();
  const run = await state.begin(begin("discover"));
  state.ready(run.id);
  await state.claim(run.id, "save-draft", "Save retains text");
  const bytes = new TextEncoder().encode("proof");
  const attachment: number = state.store(
    run.id,
    "proof.txt",
    bytes,
    "text/plain",
  );
  const catalog = await state.publication(run.id);
  if (!catalog) throw new Error("Publication lease missing");
  const first = finding(attachment);
  const second = {
    ...finding(attachment),
    fingerprint: "d".repeat(64),
    title: "Save also loses checklist",
    test: {
      ...first.test,
      steps: ["Add checklist", "Save"],
      expected: "Checklist persists",
    },
  };
  const result: Protocol.Finish = {
    status: "complete",
    summary: "Two related findings",
    report: {},
    findings: [first, second],
    evidence: [attachment],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: catalog.snapshot,
      decisions: [
        {
          fingerprint: first.fingerprint,
          verdict: "new",
          target: null,
          sameAs: null,
          reason: "New issue",
        },
        {
          fingerprint: second.fingerprint,
          verdict: "same-run",
          target: null,
          sameAs: first.fingerprint,
          reason: "Same failure",
        },
      ],
    },
  };
  const published = await Finish.publish(state, run.id, result);
  expect(published.created).toHaveLength(1);
  const current = await state.catalog("sample");
  expect(
    current.cards.find((card): boolean => card.id === published.created[0])
      ?.fingerprints,
  ).toEqual([first.fingerprint, second.fingerprint]);
  const rows = (): {
    fingerprint: string;
    test: string;
    fix: string | null;
  }[] =>
    state.db
      .query<
        { fingerprint: string; test: string; fix: string | null },
        [number]
      >(
        "SELECT fingerprint,test,fix FROM qa_findings WHERE note_id=? ORDER BY rowid",
      )
      .all(published.created[0]);
  expect(
    Object.fromEntries(
      rows().map((entry): [string, Protocol.Case] => [
        entry.fingerprint,
        JSON.parse(entry.test) as Protocol.Case,
      ]),
    ),
  ).toEqual({
    [first.fingerprint]: first.test,
    [second.fingerprint]: second.test,
  });
  await state.fix(published.created[0], revision);

  expect(rows().map((entry): string | null => entry.fix)).toEqual([
    revision,
    revision,
  ]);
});

test("deleted finding gets a replacement card", async () => {
  const { state, cards } = fixture();
  const fingerprint = "e".repeat(64);
  const created = await state.tracker.create("Old issue", "old");
  const old = await state.tracker.update(created.id, {
    tags: "qa,needs-verification,project:sample",
  });
  cards.set(old.id, { ...old, status: 2 });
  state.db
    .query(
      "INSERT INTO qa_findings (project,fingerprint,note_id,test) VALUES (?,?,?,?)",
    )
    .run(
      "sample",
      fingerprint,
      old.id,
      JSON.stringify({
        flow: "save-draft",
        route: "/",
        steps: ["Save"],
        expected: "Saved",
        scenario: "empty",
      }),
    );
  const run = await state.begin(begin("discover"));
  state.ready(run.id);
  await state.claim(run.id, "save-draft", "Save retains text");
  const bytes = new TextEncoder().encode("proof");
  const attachment: number = state.store(
    run.id,
    "proof.txt",
    bytes,
    "text/plain",
  );
  const catalog = await state.publication(run.id);
  if (!catalog) throw new Error("Publication lease missing");
  const issue = { ...finding(attachment), fingerprint };
  const result: Protocol.Finish = {
    status: "complete",
    summary: "Reproduced",
    report: {},
    findings: [issue],
    evidence: [attachment],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: catalog.snapshot,
      decisions: [
        {
          fingerprint,
          verdict: "new",
          target: null,
          sameAs: null,
          reason: "Old card deleted",
        },
      ],
    },
  };
  const published = await Finish.publish(state, run.id, result);
  expect(published.created).toHaveLength(1);
  expect(published.created[0]).not.toBe(old.id);
  expect(
    state.db
      .query<{ note_id: number }, [string, string]>(
        "SELECT note_id FROM qa_findings WHERE project=? AND fingerprint=?",
      )
      .get("sample", fingerprint)?.note_id,
  ).toBe(published.created[0]);
});

const PROOF: Uint8Array = new TextEncoder().encode("proof");
const publishIssue = async (
  state: State.State,
  run: Protocol.Run,
  attachment: number,
): Promise<Finish.Result> => {
  state.ready(run.id);
  await state.claim(run.id, "save-draft", "Save retains text");
  const catalog: Protocol.Catalog | null = await state.publication(run.id);
  if (!catalog) throw new Error("Publication lease missing");
  const issue: Protocol.Finding = finding(attachment);

  return Finish.publish(state, run.id, {
    status: "complete",
    summary: "One issue",
    report: {},
    findings: [issue],
    evidence: [attachment],
    verdict: "none",
    deployment: null,
    matching: {
      snapshot: catalog.snapshot,
      decisions: [
        {
          fingerprint: issue.fingerprint,
          verdict: "new",
          target: null,
          sameAs: null,
          reason: "No match",
        },
      ],
    },
  });
};

test("discovery copies local evidence bytes to the finding card", async () => {
  const { state, files } = fixture();
  state.tracker.download = async (): Promise<Uint8Array> => {
    throw new Error("Local evidence must not be downloaded");
  };
  const run: Protocol.Run = state.begin(begin("discover"));
  const attachment: number = state.store(
    run.id,
    "nested/proof.txt",
    PROOF,
    "text/plain",
  );
  const published: Finish.Result = await publishIssue(state, run, attachment);
  const copied = [...files.values()].filter(
    (file): boolean => file.mime === "text/plain",
  );

  expect(copied).toHaveLength(1);
  expect(copied[0].owner).toBe(published.created[0]);
  expect(copied[0].bytes).toEqual(PROOF);
  expect(copied[0].name).toEndWith(".txt");
});

test("discovery, fix and verification write no quaz-record attachment", async () => {
  const { state, files } = fixture();
  const run: Protocol.Run = await state.begin(begin("discover"));
  const proof: number = state.store(run.id, "proof.txt", PROOF, "text/plain");
  const published: Finish.Result = await publishIssue(state, run, proof);
  const issue: number = published.created[0];
  await state.tracker.complete(issue);
  await state.fix(issue, revision);
  const verify: Protocol.Run = await state.begin(begin("verify"));
  state.ready(verify.id);
  await state.claim(verify.id, `ticket-${issue}`, "Save works", issue);
  const verified: number = state.store(
    verify.id,
    "verify.txt",
    PROOF,
    "text/plain",
  );
  await Finish.publish(state, verify.id, {
    status: "complete",
    summary: "Save works",
    report: {},
    findings: [],
    evidence: [verified],
    verdict: "pass",
    deployment: { expected: revision, deployed: revision, tested: revision },
  });

  expect(state.finding(issue)?.fix).toBe(revision);
  expect(state.finding(issue)?.last_result).not.toBeNull();
  expect(files.size).toBeGreaterThan(0);
  expect(recordFiles(files)).toEqual([]);
});

test("legacy run-card evidence still copies after upgrade", async () => {
  const { state, files } = fixture();
  const legacy: Tracker.Card = await state.tracker.create(
    "QA discover: sample",
    "legacy-run",
  );
  const uploaded: Tracker.Attachment = await state.tracker.upload(
    legacy.id,
    "proof.txt",
    PROOF,
    "text/plain",
  );
  const run: Protocol.Run = state.begin(begin("discover"));
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(
      run.id,
      "proof.txt",
      createHash("sha256").update(PROOF).digest("hex"),
      "text/plain",
      uploaded.id,
    );
  const published: Finish.Result = await publishIssue(state, run, uploaded.id);
  const copied = [...files.values()].filter(
    (file): boolean =>
      file.owner === published.created[0] && file.mime === "text/plain",
  );

  expect(copied).toHaveLength(1);
  expect(copied[0].bytes).toEqual(PROOF);
});

test("local artifact ids continue above legacy attachment ids", () => {
  const { state } = fixture();
  const old: Protocol.Run = state.begin(begin("smoke"));
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(old.id, "old.txt", "0", "text/plain", 40);
  const run: Protocol.Run = state.begin(begin("smoke"));
  const first: number = state.store(run.id, "a.txt", PROOF, "text/plain");
  const second: number = state.store(run.id, "b.txt", PROOF, "text/plain");

  expect([first, second]).toEqual([41, 42]);
  expect(state.store(run.id, "a.txt", PROOF, "text/plain")).toBe(41);
  expect(() =>
    state.store(
      run.id,
      "a.txt",
      new TextEncoder().encode("other"),
      "text/plain",
    ),
  ).toThrow("different content");
  expect(() =>
    state.store(run.id, "../escape.txt", PROOF, "text/plain"),
  ).toThrow("Invalid QA artifact path");
});

test("old run artifacts are pruned", () => {
  const { state } = fixture();
  const DAYS: number = 14;
  const old: number = (DAYS + 1) * 24 * 60 * 60;
  const directories = (["old", "recent", "live", "busy"] as const).map(
    (name): { name: string; id: string; directory: string } => {
      const run: Protocol.Run = state.begin(begin("smoke"));
      state.store(run.id, "proof.txt", PROOF, "text/plain");

      return {
        name,
        id: run.id,
        directory: dirname(state.artifact(`${run.id}/proof.txt`)),
      };
    },
  );
  for (const entry of directories) {
    if (entry.name === "recent" || entry.name === "old")
      state.db
        .query("UPDATE qa_runs SET status='complete' WHERE id=?")
        .run(entry.id);
    if (entry.name === "busy")
      state.db
        .query("UPDATE qa_runs SET status='publishing' WHERE id=?")
        .run(entry.id);
    if (entry.name !== "recent")
      utimesSync(
        entry.directory,
        Date.now() / 1000 - old,
        Date.now() / 1000 - old,
      );
  }
  const pruned: string[] = state.prune(DAYS);

  expect(pruned).toEqual([directories[0].id]);
  expect(
    directories.map((entry): boolean => existsSync(entry.directory)),
  ).toEqual([false, true, true, true]);
});
