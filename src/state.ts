import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as Protocol from "@/qa_protocol";
import * as Record from "@/record";
import type * as Tracker from "@/tracker";

const MILLISECONDS: number = 1000;
const HISTORY_LIMIT: number = 100;
const CLOSED: readonly number[] = [1, 3];
const DELETED: number = 2;
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tags = (value: string): Set<string> =>
  new Set(
    value
      .split(",")
      .map((tag): string => tag.trim())
      .filter(Boolean),
  );
const isRunCard = (card: Tracker.Card): boolean =>
  /^QA (smoke|discover|verify): [a-z0-9_-]+$/.test(card.title) &&
  /^Run qa-[a-zA-Z0-9_-]+\r?\n/.test(card.description);
const conflict = (message: string): never => {
  throw new Error(message);
};

type RunRow = Protocol.Run & {
  request: string;
  result: string | null;
  started: number | null;
  publish: string | null;
  publish_lease: number | null;
  publish_held: string | null;
};
type RawRunRow = Omit<RunRow, "runner"> & { runner: string | null };
type ExpiredRun = { id: string; note_id: number | null };
type FindingRow = {
  project: string;
  fingerprint: string;
  note_id: number;
  test: string;
  fix: string | null;
  last_result: string | null;
  verified_through: number;
  verified_at: number;
};
export type State = {
  db: Database;
  tracker: Tracker.Tracker;
  run: (id: string) => RunRow;
  active: (id: string) => RunRow;
  begin: (input: Protocol.Begin) => Promise<Protocol.Run>;
  ready: (id: string) => Protocol.Run;
  state: (project: string, revision?: string) => Promise<Protocol.State>;
  catalog: (project: string) => Promise<Protocol.Catalog>;
  publication: (id: string) => Promise<Protocol.Catalog | null>;
  claim: (
    id: string,
    key: string,
    goal: string,
    ticket?: number,
  ) => Promise<boolean>;
  fix: (note: number, revision: string) => Promise<void>;
  finding: (note: number) => FindingRow | null;
};

export const prepare = (db: Database): void => {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_runs (
      id TEXT PRIMARY KEY, note_id INTEGER, board_id INTEGER NOT NULL DEFAULT 0,
      owner TEXT NOT NULL DEFAULT 'quaz', project TEXT NOT NULL, mode TEXT NOT NULL,
      revision TEXT NOT NULL, scenario TEXT NOT NULL, attention TEXT,
      runner TEXT,
      status TEXT NOT NULL DEFAULT 'running', expires INTEGER NOT NULL,
      target INTEGER, snapshot INTEGER, receipt TEXT, request TEXT NOT NULL,
      result TEXT, started INTEGER, publish TEXT, publish_lease INTEGER,
      publish_held TEXT, publish_target_version INTEGER,
      publish_target_step TEXT
    );
    CREATE TABLE IF NOT EXISTS qa_flows (
      project TEXT NOT NULL, key TEXT NOT NULL, goal TEXT NOT NULL,
      run TEXT NOT NULL REFERENCES qa_runs(id), expires INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'partial', PRIMARY KEY (project,key)
    );
    CREATE TABLE IF NOT EXISTS qa_findings (
      project TEXT NOT NULL, fingerprint TEXT NOT NULL, note_id INTEGER NOT NULL,
      test TEXT NOT NULL, fix TEXT, last_result TEXT,
      verified_through INTEGER NOT NULL DEFAULT 0,
      verified_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project,fingerprint)
    );
    CREATE TABLE IF NOT EXISTS qa_artifacts (
      run TEXT NOT NULL REFERENCES qa_runs(id), path TEXT NOT NULL,
      digest TEXT NOT NULL, mime TEXT NOT NULL, attachment INTEGER NOT NULL,
      PRIMARY KEY (run,path)
    );
    CREATE TABLE IF NOT EXISTS qa_publications (
      project TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES qa_runs(id),
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa_pending_findings (
      run TEXT NOT NULL REFERENCES qa_runs(id), fingerprint TEXT NOT NULL,
      note_id INTEGER NOT NULL, PRIMARY KEY (run,fingerprint)
    );
    CREATE TABLE IF NOT EXISTS qa_reopenings (
      run TEXT NOT NULL REFERENCES qa_runs(id), note_id INTEGER NOT NULL,
      PRIMARY KEY (run,note_id)
    );
    CREATE TABLE IF NOT EXISTS qa_create_intents (
      run TEXT NOT NULL REFERENCES qa_runs(id), fingerprint TEXT NOT NULL,
      key TEXT NOT NULL, PRIMARY KEY (run,fingerprint)
    );
  `);
  const findingColumns: Set<string> = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(qa_findings)")
      .all()
      .map((column): string => column.name),
  );
  const cutoverAt: number = Date.now() - 1;
  db.transaction((): void => {
    if (!findingColumns.has("verified_at")) {
      db.exec(
        "ALTER TABLE qa_findings ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0",
      );
    }
    db.query(
      "UPDATE qa_findings SET verified_at=? WHERE verified_through>0 AND verified_at=0",
    ).run(cutoverAt);
  })();
  const columns: Set<string> = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(qa_runs)")
      .all()
      .map((column): string => column.name),
  );
  if (!columns.has("publish_target_version"))
    db.exec("ALTER TABLE qa_runs ADD COLUMN publish_target_version INTEGER");
  if (!columns.has("publish_target_step"))
    db.exec("ALTER TABLE qa_runs ADD COLUMN publish_target_step TEXT");
  if (!columns.has("runner"))
    db.exec("ALTER TABLE qa_runs ADD COLUMN runner TEXT");
};

export const open = (
  path: string | Database,
  tracker: Tracker.Tracker,
): State => {
  const db: Database =
    typeof path === "string" ? new Database(path, { create: true }) : path;
  prepare(db);
  const decode = (value: RawRunRow): RunRow => ({
    ...value,
    runner: value.runner
      ? Protocol.runner.parse(JSON.parse(value.runner))
      : null,
  });
  const run = (id: string): RunRow => {
    const value: RawRunRow | null = db
      .query<RawRunRow, [string]>("SELECT * FROM qa_runs WHERE id=?")
      .get(id);
    if (!value || value.note_id === null) throw new Error("QA run not found");
    return decode(value);
  };
  const active = (id: string): RunRow => {
    const value: RunRow = run(id);
    if (value.status !== "running" || value.expires <= Date.now())
      conflict("QA run is finished or expired");
    return value;
  };
  const begin = async (input: Protocol.Begin): Promise<Protocol.Run> => {
    const request: string = digest(input);
    const prior = db
      .query<{ request: string }, [string]>(
        "SELECT request FROM qa_runs WHERE id=?",
      )
      .get(input.id);
    if (prior?.request !== undefined && prior.request !== request)
      conflict("Run ID already has different inputs");
    if (!prior)
      db.query(
        "INSERT INTO qa_runs (id,project,mode,revision,runner,scenario,attention,expires,request) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        input.id,
        input.project,
        input.mode,
        input.revision,
        JSON.stringify(input.runner),
        input.scenario,
        input.attention ?? null,
        Date.now() + Protocol.LEASE_SECONDS * MILLISECONDS,
        request,
      );
    const saved = db
      .query<
        { note_id: number | null; started: number | null; status: string },
        [string]
      >("SELECT note_id,started,status FROM qa_runs WHERE id=?")
      .get(input.id);
    let noteId: number | null = saved?.note_id ?? null;
    if (!noteId) {
      const card: Tracker.Card = await tracker.create(
        `QA ${input.mode}: ${input.project}`,
        `quaz-run-${digest(input.id)}`,
      );
      db.query(
        "UPDATE qa_runs SET note_id=? WHERE id=? AND note_id IS NULL",
      ).run(card.id, input.id);
      noteId = card.id;
    }
    if (!saved?.started && saved?.status === "running")
      await tracker.update(noteId, {
        title: `QA ${input.mode}: ${input.project}`,
        tags: `${Protocol.TAG.run},project:${input.project}`,
        description: `Run ${input.id}\nMode: ${input.mode}\nProject: ${input.project}\nStatus: running\nRevision: ${input.revision}\nRunner source: ${input.runner.source}\nRunner image: ${input.runner.image}`,
      });
    return run(input.id);
  };
  const ready = (id: string): Protocol.Run =>
    db.transaction((): Protocol.Run => {
      const value: RunRow = run(id);
      if (value.receipt) conflict("QA run is already finished");
      if (value.started) return value;
      if (db.query("SELECT 1 FROM qa_flows WHERE run=?").get(id))
        conflict("QA run already claims work");
      db.query(
        "UPDATE qa_runs SET started=?,expires=?,status='running' WHERE id=?",
      ).run(Date.now(), Date.now() + Protocol.LEASE_SECONDS * MILLISECONDS, id);
      return run(id);
    })();
  const records = async (
    project: string,
    cards: Tracker.Card[],
  ): Promise<Map<number, Record.Record>> => {
    const entries: (Record.Record | null)[] = await Promise.all(
      cards.map(async (card): Promise<Record.Record | null> => {
        const labels: Set<string> = tags(card.tags);
        if (
          card.status === DELETED ||
          !labels.has(Protocol.TAG.issue) ||
          !labels.has(`project:${project}`)
        )
          return null;

        return Record.load(tracker, card.id);
      }),
    );
    const found: Map<number, Record.Record> = new Map();
    for (const entry of entries) {
      if (!entry || entry.project !== project) continue;
      found.set(entry.card, entry);
      for (const finding of entry.findings) {
        if (!finding.test) continue;
        db.query(
          `INSERT INTO qa_findings (project,fingerprint,note_id,test,fix,last_result)
           VALUES (?,?,?,?,?,?) ON CONFLICT(project,fingerprint) DO UPDATE SET
           note_id=excluded.note_id,test=excluded.test,fix=excluded.fix,
           last_result=excluded.last_result`,
        ).run(
          project,
          finding.fingerprint,
          entry.card,
          JSON.stringify(finding.test),
          finding.fix,
          finding.lastResult,
        );
      }
    }

    return found;
  };
  const catalog = async (project: string): Promise<Protocol.Catalog> => {
    const cards: Tracker.Card[] = await tracker.list();
    const saved: Map<number, Record.Record> = await records(project, cards);
    for (const intent of db
      .query<{ run: string; fingerprint: string; key: string }, []>(
        "SELECT run,fingerprint,key FROM qa_create_intents",
      )
      .all()) {
      const card: Tracker.Card | null = await tracker.recover(intent.key);
      if (!card) continue;
      db.transaction((): void => {
        db.query(
          "INSERT OR IGNORE INTO qa_pending_findings (run,fingerprint,note_id) VALUES (?,?,?)",
        ).run(intent.run, intent.fingerprint, card.id);
        db.query(
          "DELETE FROM qa_create_intents WHERE run=? AND fingerprint=?",
        ).run(intent.run, intent.fingerprint);
      })();
    }
    const runs: Set<number> = new Set(
      db
        .query<{ note_id: number }, []>(
          "SELECT note_id FROM qa_runs WHERE note_id IS NOT NULL",
        )
        .all()
        .map((run): number => run.note_id),
    );
    const pending = db
      .query<
        {
          run: string;
          note_id: number;
          fingerprint: string;
          project: string;
          status: string;
          publish_lease: number | null;
          publication_run: string | null;
          publication_expires: number | null;
        },
        []
      >(
        "SELECT p.run,p.note_id,p.fingerprint,r.project,r.status,r.publish_lease,q.run AS publication_run,q.expires AS publication_expires FROM qa_pending_findings p JOIN qa_runs r ON r.id=p.run LEFT JOIN qa_publications q ON q.project=r.project",
      )
      .all();
    const activePending: Set<number> = new Set(
      pending
        .filter(
          (entry): boolean =>
            entry.status === "publishing" &&
            (entry.publish_lease ?? 0) > Date.now() &&
            entry.publication_run === entry.run &&
            (entry.publication_expires ?? 0) > Date.now(),
        )
        .map((entry): number => entry.note_id),
    );
    const known: Map<number, { project: string; fingerprints: string[] }> =
      new Map();
    for (const entry of db
      .query<{ fingerprint: string; note_id: number; project: string }, []>(
        "SELECT fingerprint,note_id,project FROM qa_findings ORDER BY rowid",
      )
      .all()) {
      const current = known.get(entry.note_id);
      if (current) current.fingerprints.push(entry.fingerprint);
      else
        known.set(entry.note_id, {
          project: entry.project,
          fingerprints: [entry.fingerprint],
        });
    }
    for (const entry of pending) {
      const current = known.get(entry.note_id);
      if (current) {
        if (!current.fingerprints.includes(entry.fingerprint))
          current.fingerprints.push(entry.fingerprint);
      } else
        known.set(entry.note_id, {
          project: entry.project,
          fingerprints: [entry.fingerprint],
        });
    }
    const selected: Protocol.Catalog["cards"] = cards
      .filter((card): boolean => {
        const labels: Set<string> = tags(card.tags);
        const projects: string[] = [...labels].filter((label): boolean =>
          label.startsWith("project:"),
        );
        const managed = known.get(card.id);
        return (
          card.status !== DELETED &&
          !runs.has(card.id) &&
          !activePending.has(card.id) &&
          !labels.has(Protocol.TAG.run) &&
          !isRunCard(card) &&
          (!managed || managed.project === project) &&
          (!projects.length || projects.includes(`project:${project}`))
        );
      })
      .map((card): Protocol.Catalog["cards"][number] => ({
        id: card.id,
        version: card.version,
        title: card.title,
        description: card.description,
        checklist: card.checklist,
        tags: card.tags,
        status: card.status,
        comments: card.comments,
        fingerprints:
          saved
            .get(card.id)
            ?.findings.map((entry): string => entry.fingerprint) ??
          known.get(card.id)?.fingerprints ??
          [],
      }));
    if (
      new TextEncoder().encode(JSON.stringify(selected)).byteLength >
      Protocol.CATALOG_BYTES
    )
      conflict("The issue catalog exceeds the review limit");
    return { snapshot: digest(selected), cards: selected };
  };
  const state = async (
    project: string,
    revision?: string,
  ): Promise<Protocol.State> => {
    await records(project, await tracker.list());
    const now: number = Date.now();
    const expired: ExpiredRun[] = db
      .query<ExpiredRun, [string, number]>(
        "SELECT id,note_id FROM qa_runs WHERE project=? AND status='running' AND expires<=?",
      )
      .all(project, now);
    for (const value of expired) {
      db.query(
        "UPDATE qa_runs SET status='expired' WHERE id=? AND status='running'",
      ).run(value.id);
      if (value.note_id === null) continue;
      const card: Tracker.Card | null = await tracker.get(value.note_id);
      if (card)
        await tracker.update(card.id, {
          description: `${card.description}\n\nStatus: expired. The worker stopped reporting.`,
          tagsAdd: Protocol.TAG.attention,
        });
    }
    const rows: FindingRow[] = db
      .query<FindingRow, [string]>(
        "SELECT * FROM qa_findings WHERE project=? ORDER BY note_id",
      )
      .all(project);
    const cards: (Tracker.Card | null)[] = await Promise.all(
      rows.map((row): Promise<Tracker.Card | null> => tracker.get(row.note_id)),
    );
    const seen: Set<number> = new Set();
    const tickets: Protocol.Ticket[] = rows.flatMap(
      (row, index): Protocol.Ticket[] => {
        const card: Tracker.Card | null = cards[index];
        if (!card || !CLOSED.includes(card.status) || seen.has(card.id))
          return [];
        seen.add(card.id);
        const labels: Set<string> = tags(card.tags);
        if (
          !labels.has(Protocol.TAG.issue) ||
          !labels.has(Protocol.TAG.pending)
        )
          return [];
        return [
          {
            id: card.id,
            version: card.version,
            content: card.title,
            description: card.description,
            tags: card.tags,
            test: Protocol.caseSchema.parse(JSON.parse(row.test)),
            fix: row.fix,
          },
        ];
      },
    );
    const runs: RunRow[] = db
      .query<RawRunRow, [string, number]>(
        "SELECT * FROM qa_runs WHERE project=? AND note_id IS NOT NULL ORDER BY rowid DESC LIMIT ?",
      )
      .all(project, HISTORY_LIMIT)
      .map(decode);
    const selected: RunRow[] = revision
      ? runs.filter(
          (entry): boolean =>
            entry.revision === revision &&
            (entry.target === null ||
              tickets.some((ticket): boolean => ticket.id === entry.target)),
        )
      : runs;
    return {
      flows: db
        .query<Protocol.Flow, [string]>(
          "SELECT key,goal,run,expires,status FROM qa_flows WHERE project=? ORDER BY expires,key",
        )
        .all(project),
      tickets,
      runs: selected,
      ...(revision ? { scheduledRevision: revision } : {}),
    };
  };
  const publication = async (id: string): Promise<Protocol.Catalog | null> => {
    const value: RunRow = active(id);
    if (value.mode !== "discover") conflict("Only discovery compares issues");
    const acquired = db
      .query(`INSERT INTO qa_publications (project,run,expires) VALUES (?,?,?)
      ON CONFLICT(project) DO UPDATE SET run=excluded.run,expires=excluded.expires
      WHERE qa_publications.expires<=? OR qa_publications.run=excluded.run`)
      .run(
        value.project,
        id,
        Math.min(
          value.expires,
          Date.now() + Protocol.PUBLICATION_SECONDS * MILLISECONDS,
        ),
        Date.now(),
      );
    return acquired.changes ? catalog(value.project) : null;
  };
  const claim = async (
    id: string,
    key: string,
    goal: string,
    ticket?: number,
  ): Promise<boolean> => {
    const value: RunRow = active(id);
    if (value.mode === "smoke") conflict("Smoke runs cannot claim work");
    let scenario: string = value.scenario;
    let snapshot: number | null = null;
    if (value.mode === "verify") {
      const selected = (await state(value.project)).tickets.find(
        (entry): boolean => entry.id === ticket,
      );
      if (!selected) throw new Error("Card is no longer awaiting verification");
      if (key !== `ticket-${ticket}`)
        conflict("Card is no longer awaiting verification");
      if (value.target !== null && value.target !== ticket)
        conflict("Run already owns another card");
      scenario = selected.test.scenario;
      snapshot = selected.version;
    } else if (ticket !== undefined) conflict("Discovery cannot claim a card");
    return db.transaction((): boolean => {
      active(id);
      const changed = db
        .query(`INSERT INTO qa_flows (project,key,goal,run,expires) VALUES (?,?,?,?,?)
        ON CONFLICT(project,key) DO UPDATE SET goal=excluded.goal,run=excluded.run,expires=excluded.expires,status='partial'
        WHERE qa_flows.expires<=? OR qa_flows.run=excluded.run`)
        .run(value.project, key, goal, id, value.expires, Date.now());
      if (changed.changes && ticket !== undefined && value.target === null)
        db.query(
          "UPDATE qa_runs SET target=?,snapshot=?,scenario=? WHERE id=?",
        ).run(ticket, snapshot, scenario, id);
      return changed.changes === 1;
    })();
  };
  const fix = async (note: number, revision: string): Promise<void> => {
    if (!(await tracker.get(note))) throw new Error("QA card not found");
    const rows = db
      .query<
        {
          fix: string | null;
          project: string;
          fingerprint: string;
          test: string;
        },
        [number]
      >(
        "SELECT fix,project,fingerprint,test FROM qa_findings WHERE note_id=? ORDER BY rowid",
      )
      .all(note);
    if (!rows.length) throw new Error("QA card not found");
    if (rows.every((row): boolean => row.fix === revision)) return;
    for (const row of rows)
      await Record.save(tracker, note, {
        project: row.project,
        fingerprint: row.fingerprint,
        test: Protocol.caseSchema.parse(JSON.parse(row.test)),
        fix: revision,
        lastResult: null,
      });
    db.query(
      "UPDATE qa_findings SET fix=?,last_result=NULL WHERE note_id=?",
    ).run(revision, note);
  };
  const finding = (note: number): FindingRow | null =>
    db
      .query<FindingRow, [number]>(
        "SELECT * FROM qa_findings WHERE note_id=? ORDER BY rowid LIMIT 1",
      )
      .get(note);
  return {
    db,
    tracker,
    run,
    active,
    begin,
    ready,
    state,
    catalog,
    publication,
    claim,
    fix,
    finding,
  };
};
