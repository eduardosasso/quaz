import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import * as Fix from "@/fix";
import * as Pool from "@/pool";
import * as Protocol from "@/qa_protocol";
import type * as Tracker from "@/tracker";

const MILLISECONDS: number = 1000;
const DAY_MILLISECONDS: number = 24 * 60 * 60 * MILLISECONDS;
const FILE_MODE: number = 0o600;
const DIRECTORY_MODE: number = 0o700;
export const ARTIFACTS: string = "runs";
const EVIDENCE_KEY: string = "evidence";
export const LIVE: readonly string[] = ["running", "publishing"];
const RUN_COLUMNS: string =
  "id,note_id,board_id,owner,project,mode,revision,scenario,attention,runner,status,expires,target,snapshot,receipt,request,result,started,publish,publish_lease,publish_held,publish_target_version,publish_target_step,recorded";
const HISTORY_LIMIT: number = 100;
export const CARD_READS: number = 4;
const COMPLETED: number = 1;
const ARCHIVED: number = 3;
const CLOSED: readonly number[] = [COMPLETED, ARCHIVED];
const DISMISSED_VERSION: number = 0;
const ELLIPSIS: string = "…";
export const DELETED: number = 2;
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const tags = (value: string): Set<string> =>
  new Set(
    value
      .split(",")
      .map((tag): string => tag.trim())
      .filter(Boolean),
  );
export const opened = (cards: Tracker.Card[], project: string): number =>
  cards.filter((card): boolean => {
    const labels: Set<string> = tags(card.tags);

    return labels.has(Protocol.TAG.issue) && labels.has(`project:${project}`);
  }).length;
export const summary = (text: string): string => {
  const flat: string = text.replace(/\s+/g, " ").trim();
  if (flat.length <= Protocol.SUMMARY_CHARS) return flat;
  const cut: string = flat.slice(0, Protocol.SUMMARY_CHARS - ELLIPSIS.length);
  const boundary: number = cut.lastIndexOf(" ");

  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}${ELLIPSIS}`;
};
export const isRunCard = (card: Tracker.Card): boolean =>
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
  begin: (input: Protocol.Begin) => Protocol.Run;
  artifact: (relative: string) => string;
  store: (run: string, path: string, bytes: Uint8Array, mime: string) => number;
  prune: (days: number) => string[];
  ready: (id: string) => Protocol.Run;
  state: (project: string, revision?: string) => Promise<Protocol.State>;
  count: (project: string) => Promise<number>;
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
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
  );
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
    CREATE TABLE IF NOT EXISTS qa_dismissed (
      project TEXT NOT NULL, note_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL, summary TEXT NOT NULL, dismissed_at INTEGER NOT NULL
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
    CREATE TABLE IF NOT EXISTS qa_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
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
  const artifactColumns: Set<string> = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(qa_artifacts)")
      .all()
      .map((column): string => column.name),
  );
  if (!columns.has("publish_target_version"))
    db.exec("ALTER TABLE qa_runs ADD COLUMN publish_target_version INTEGER");
  if (!columns.has("publish_target_step"))
    db.exec("ALTER TABLE qa_runs ADD COLUMN publish_target_step TEXT");
  if (!columns.has("runner"))
    db.exec("ALTER TABLE qa_runs ADD COLUMN runner TEXT");
  if (!columns.has("report"))
    db.exec("ALTER TABLE qa_runs ADD COLUMN report TEXT");
  if (!artifactColumns.has("file"))
    db.exec("ALTER TABLE qa_artifacts ADD COLUMN file TEXT");
  if (!columns.has("recorded"))
    db.transaction((): void => {
      db.exec(
        "ALTER TABLE qa_runs ADD COLUMN recorded INTEGER NOT NULL DEFAULT 1",
      );
      db.exec("UPDATE qa_runs SET recorded=0 WHERE note_id IS NULL");
    })();
};

export const open = (
  path: string | Database,
  tracker: Tracker.Tracker,
  directory?: string,
  repository?: string,
): State => {
  const db: Database =
    typeof path === "string" ? new Database(path, { create: true }) : path;
  prepare(db);
  const home: string = typeof path === "string" ? path : db.filename;
  const root: string | null =
    directory ??
    (home && home !== ":memory:" ? join(dirname(home), ARTIFACTS) : null);
  const decode = (value: RawRunRow): RunRow => ({
    ...value,
    runner: value.runner
      ? Protocol.runner.parse(JSON.parse(value.runner))
      : null,
  });
  const run = (id: string): RunRow => {
    const value: RawRunRow | null = db
      .query<RawRunRow, [string]>(
        `SELECT ${RUN_COLUMNS} FROM qa_runs WHERE id=?`,
      )
      .get(id);
    if (!value) throw new Error("QA run not found");
    return decode(value);
  };
  const active = (id: string): RunRow => {
    const value: RunRow = run(id);
    if (value.status !== "running" || value.expires <= Date.now())
      conflict("QA run is finished or expired");
    return value;
  };
  const begin = (input: Protocol.Begin): Protocol.Run => {
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

    return run(input.id);
  };
  const artifact = (relative: string): string => {
    if (!root) throw new Error("Quaz artifact directory is unavailable");
    const target: string = resolve(root, relative);
    if (
      relative.split("/").includes("..") ||
      !target.startsWith(`${resolve(root)}${sep}`)
    )
      throw new Error("Invalid QA artifact path");

    return target;
  };
  const evidence = (): number => {
    const saved = db
      .query<{ value: string }, [string]>(
        "SELECT value FROM qa_meta WHERE key=?",
      )
      .get(EVIDENCE_KEY);
    const top = db
      .query<{ top: number }, []>(
        "SELECT COALESCE(MAX(attachment),0) AS top FROM qa_artifacts",
      )
      .get();
    const next: number = Math.max(Number(saved?.value ?? 0), top?.top ?? 0) + 1;
    db.query("INSERT OR REPLACE INTO qa_meta (key,value) VALUES (?,?)").run(
      EVIDENCE_KEY,
      String(next),
    );

    return next;
  };
  const store = (
    id: string,
    path: string,
    bytes: Uint8Array,
    mime: string,
  ): number => {
    const hash: string = createHash("sha256").update(bytes).digest("hex");
    const prior = db
      .query<
        { digest: string; mime: string; attachment: number },
        [string, string]
      >(
        "SELECT digest,mime,attachment FROM qa_artifacts WHERE run=? AND path=?",
      )
      .get(id, path);
    if (prior) {
      if (prior.digest !== hash || prior.mime !== mime)
        throw new Error("Artifact path has different content");

      return prior.attachment;
    }
    const file: string = `${id}/${path}`;
    const target: string = artifact(file);
    mkdirSync(dirname(target), { recursive: true, mode: DIRECTORY_MODE });
    const temporary: string = `${target}.${randomUUID()}.tmp`;
    const descriptor: number = openSync(temporary, "wx", FILE_MODE);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } catch (error: unknown) {
      rmSync(temporary, { force: true });
      throw error;
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);

    return db.transaction((): number => {
      const attachment: number = evidence();
      db.query(
        "INSERT INTO qa_artifacts (run,path,digest,mime,attachment,file) VALUES (?,?,?,?,?,?)",
      ).run(id, path, hash, mime, attachment, file);

      return attachment;
    })();
  };
  const prune = (days: number): string[] => {
    if (!root || !existsSync(root)) return [];
    const cutoff: number = Date.now() - days * DAY_MILLISECONDS;
    const pruned: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const row = db
        .query<{ status: string }, [string]>(
          "SELECT status FROM qa_runs WHERE id=?",
        )
        .get(entry.name);
      const directory: string = join(root, entry.name);
      if (!row || LIVE.includes(row.status)) continue;
      if (statSync(directory).mtimeMs > cutoff) continue;
      rmSync(directory, { recursive: true, force: true });
      pruned.push(entry.name);
    }

    return pruned;
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
  const forget = (project: string, note: number): void => {
    const held: boolean = LIVE.some((status): boolean =>
      Boolean(
        db
          .query("SELECT 1 FROM qa_runs WHERE target=? AND status=?")
          .get(note, status),
      ),
    );
    if (held) return;
    const removed: number = db.transaction((): number => {
      db.query("DELETE FROM qa_dismissed WHERE note_id=?").run(note);

      return db.query("DELETE FROM qa_findings WHERE note_id=?").run(note)
        .changes;
    })();
    if (removed)
      console.log(
        JSON.stringify({ event: "finding-forgotten", card: note, project }),
      );
  };
  const settle = (
    project: string,
    card: Tracker.Card,
    rows: FindingRow[],
    dismissed: Set<number>,
  ): void => {
    const fixed: boolean =
      rows.some(
        (row): boolean => row.note_id === card.id && Boolean(row.fix),
      ) ||
      Boolean(
        repository &&
          Fix.reference(card.description, card.comments, repository),
      );
    const wontfix: boolean =
      CLOSED.includes(card.status) &&
      !fixed &&
      tags(card.tags).has(Protocol.TAG.issue);
    if (wontfix) {
      const added = db
        .query(
          "INSERT OR IGNORE INTO qa_dismissed (project,note_id,title,summary,dismissed_at) VALUES (?,?,?,?,?)",
        )
        .run(
          project,
          card.id,
          card.title,
          summary(card.description),
          Date.now(),
        );
      dismissed.add(card.id);
      if (added.changes)
        console.log(
          JSON.stringify({
            event: "finding-dismissed",
            card: card.id,
            project,
          }),
        );
    } else if (dismissed.delete(card.id)) {
      db.query("DELETE FROM qa_dismissed WHERE note_id=?").run(card.id);
      console.log(
        JSON.stringify({ event: "finding-restored", card: card.id, project }),
      );
    }
  };
  const review = async (
    project: string,
  ): Promise<{
    rows: FindingRow[];
    cards: (Tracker.Card | null)[];
    dismissed: Set<number>;
  }> => {
    const rows: FindingRow[] = db
      .query<FindingRow, [string]>(
        "SELECT * FROM qa_findings WHERE project=? ORDER BY note_id",
      )
      .all(project);
    const cards: (Tracker.Card | null)[] = await Pool.map(
      rows,
      CARD_READS,
      (row): Promise<Tracker.Card | null> => tracker.get(row.note_id),
    );
    const dismissed: Set<number> = new Set(
      db
        .query<{ note_id: number }, [string]>(
          "SELECT note_id FROM qa_dismissed WHERE project=?",
        )
        .all(project)
        .map((row): number => row.note_id),
    );
    const seen: Set<number> = new Set();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.note_id)) continue;
      seen.add(row.note_id);
      const card: Tracker.Card | null = cards[index];
      if (!card || card.status === DELETED) {
        dismissed.delete(row.note_id);
        forget(project, row.note_id);
      } else settle(project, card, rows, dismissed);
    }

    return { rows, cards, dismissed };
  };
  const catalog = async (project: string): Promise<Protocol.Catalog> => {
    await review(project);
    const cards: Tracker.Card[] = await tracker.list();
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
        summary: summary(card.description),
        tags: card.tags,
        status: card.status,
        fingerprints: known.get(card.id)?.fingerprints ?? [],
      }));
    const listed: Set<number> = new Set(
      selected.map((entry): number => entry.id),
    );
    selected.push(
      ...db
        .query<{ note_id: number; title: string; summary: string }, [string]>(
          "SELECT note_id,title,summary FROM qa_dismissed WHERE project=? ORDER BY note_id",
        )
        .all(project)
        .filter((row): boolean => !listed.has(row.note_id))
        .map((row): Protocol.Catalog["cards"][number] => ({
          id: row.note_id,
          version: DISMISSED_VERSION,
          title: row.title,
          summary: row.summary,
          tags: `${Protocol.TAG.issue},project:${project}`,
          status: COMPLETED,
          fingerprints: known.get(row.note_id)?.fingerprints ?? [],
          dismissed: true,
        })),
    );
    if (
      new TextEncoder().encode(JSON.stringify(selected)).byteLength >
      Protocol.CATALOG_BYTES
    )
      conflict("The issue catalog exceeds the review limit");
    return { snapshot: digest(selected), cards: selected };
  };
  const count = async (project: string): Promise<number> =>
    opened(await tracker.list(), project);
  const state = async (
    project: string,
    revision?: string,
  ): Promise<Protocol.State> => {
    const now: number = Date.now();
    const expired: { id: string }[] = db
      .query<{ id: string }, [string, number]>(
        "SELECT id FROM qa_runs WHERE project=? AND status='running' AND expires<=?",
      )
      .all(project, now);
    for (const value of expired) {
      db.query(
        "UPDATE qa_runs SET status='expired' WHERE id=? AND status='running'",
      ).run(value.id);
      console.log(
        JSON.stringify({ event: "run-expired", run: value.id, project }),
      );
    }
    const { rows, cards, dismissed } = await review(project);
    const seen: Set<number> = new Set();
    const tickets: Protocol.Ticket[] = rows.flatMap(
      (row, index): Protocol.Ticket[] => {
        const card: Tracker.Card | null = cards[index];
        if (
          !card ||
          !CLOSED.includes(card.status) ||
          dismissed.has(card.id) ||
          seen.has(card.id)
        )
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
        `SELECT ${RUN_COLUMNS} FROM qa_runs WHERE project=? AND recorded=1 ORDER BY rowid DESC LIMIT ?`,
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
      open: await count(project),
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
    const rows: { fix: string | null }[] = db
      .query<{ fix: string | null }, [number]>(
        "SELECT fix FROM qa_findings WHERE note_id=?",
      )
      .all(note);
    if (!rows.length) throw new Error("QA card not found");
    if (rows.every((row): boolean => row.fix === revision)) return;
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
    artifact,
    store,
    prune,
    ready,
    state,
    count,
    catalog,
    publication,
    claim,
    fix,
    finding,
  };
};
