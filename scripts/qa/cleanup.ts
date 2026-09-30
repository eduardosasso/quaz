import { Database } from "bun:sqlite";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import * as Adapter from "@/adapters/overdew";
import * as Migrate from "@/migrate";
import * as Protocol from "@/qa_protocol";
import * as Record from "@/record";
import * as State from "@/state";
import * as Tracker from "@/tracker";

const ARCHIVE: string = "archive/board-cleanup";
const FILE_MODE: number = 0o600;
const DIRECTORY_MODE: number = 0o700;
const UNSAFE_NAME = /[^\w.-]/g;

export type Entry = { card: number; attachment: Tracker.Attachment };
export type Plan = { cards: Tracker.Card[]; records: Entry[] };
export type Summary = {
  event: "board-cleanup";
  cards: number;
  records: number;
};
export type Input = {
  tracker: Tracker.Tracker;
  remove: Adapter.Remover;
  db: string;
  project: string;
  target: string;
  confirm?: number;
};

const count = (db: Database, sql: string, ...values: string[]): number =>
  db.query<{ total: number }, string[]>(sql).get(...values)?.total ?? 0;
const table = (db: Database, name: string): boolean =>
  Boolean(
    db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
const meta = (db: Database, key: string): string | null =>
  table(db, "qa_meta")
    ? (db
        .query<{ value: string }, [string]>(
          "SELECT value FROM qa_meta WHERE key=?",
        )
        .get(key)?.value ?? null)
    : null;
const guard = (db: Database, target: string): void => {
  if (meta(db, Migrate.AUTHORITY) !== Migrate.LOCAL)
    throw new Error("Quaz database is not the local authority yet");
  if (!meta(db, Migrate.IMPORTED))
    throw new Error("Finding records are not imported into the Quaz database");
  const destination: string | undefined = table(db, "qa_destination")
    ? db
        .query<{ value: string }, []>(
          "SELECT value FROM qa_destination WHERE id=1",
        )
        .get()?.value
    : undefined;
  if (destination !== target)
    throw new Error("Quaz database belongs to another tracking board");
  const live: number = count(
    db,
    `SELECT COUNT(*) AS total FROM qa_runs WHERE status IN (${State.LIVE.map((): string => "?").join(",")})`,
    ...State.LIVE,
  );
  if (live)
    throw new Error(`${live} Quaz runs are still running or publishing`);
  const legacy: number = count(
    db,
    `SELECT COUNT(DISTINCT a.run) AS total FROM qa_artifacts a
     JOIN qa_runs r ON r.id=a.run
     WHERE a.file IS NULL AND (r.receipt IS NULL OR EXISTS
       (SELECT 1 FROM qa_pending_findings p WHERE p.run=a.run))`,
  );
  if (legacy)
    throw new Error(
      `${legacy} unfinished Quaz runs still hold evidence on run cards`,
    );
};
const referenced = (db: Database): Set<number> =>
  new Set(
    db
      .query<{ note_id: number }, []>(
        "SELECT note_id FROM qa_findings UNION SELECT note_id FROM qa_pending_findings",
      )
      .all()
      .map((row): number => row.note_id),
  );
export const plan = async (
  tracker: Tracker.Tracker,
  db: Database,
  project: string,
): Promise<Plan> => {
  const cards: Tracker.Card[] = (await tracker.list(Tracker.STATUSES)).filter(
    (card): boolean => card.status !== State.DELETED,
  );
  const known: Set<number> = referenced(db);
  const runs: Tracker.Card[] = cards.filter((card): boolean => {
    const labels: Set<string> = State.tags(card.tags);
    const projects: string[] = [...labels].filter((label): boolean =>
      label.startsWith("project:"),
    );

    return (
      !labels.has(Protocol.TAG.issue) &&
      !known.has(card.id) &&
      (!projects.length || projects.includes(`project:${project}`)) &&
      (labels.has(Protocol.TAG.run) || State.isRunCard(card))
    );
  });
  const records: Entry[] = [];
  for (const card of cards) {
    const labels: Set<string> = State.tags(card.tags);
    if (!labels.has(Protocol.TAG.issue) || !labels.has(`project:${project}`))
      continue;
    for (const attachment of await tracker.attachments(card.id))
      if (Record.file(attachment.name))
        records.push({ card: card.id, attachment });
  }

  return { cards: runs, records };
};
const flush = (path: string): void => {
  const descriptor: number = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};
const save = (path: string, data: Uint8Array | string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  const descriptor: number = openSync(path, "w", FILE_MODE);
  try {
    fchmodSync(descriptor, FILE_MODE);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  flush(dirname(path));
};
const file = (attachment: Tracker.Attachment): string =>
  `${attachment.id}-${basename(attachment.name).replace(UNSAFE_NAME, "_")}`;
const archive = async (
  tracker: Tracker.Tracker,
  root: string,
  found: Plan,
): Promise<void> => {
  for (const card of found.cards) {
    const folder: string = join(root, String(card.id));
    const items: Tracker.Attachment[] = await tracker.attachments(card.id);
    save(join(folder, "note.json"), JSON.stringify(card, null, 2));
    save(join(folder, "description.md"), card.description);
    save(join(folder, "comments.json"), JSON.stringify(card.comments, null, 2));
    save(
      join(folder, "attachments.json"),
      JSON.stringify(
        items.map((item): object => ({ ...item, file: file(item) })),
        null,
        2,
      ),
    );
    for (const item of items)
      save(
        join(folder, "attachments", file(item)),
        await tracker.download(item.id),
      );
  }
  for (const entry of found.records)
    save(
      join(root, String(entry.card), "records", file(entry.attachment)),
      await tracker.download(entry.attachment.id),
    );
};
const report = (found: Plan): void => {
  console.log("Run cards to delete (id, status, title)");
  for (const card of found.cards)
    console.log(`${card.id}\t${card.status}\t${card.title}`);
  console.log("Record attachments to delete (attachment, card, name)");
  for (const entry of found.records)
    console.log(
      `${entry.attachment.id}\t${entry.card}\t${entry.attachment.name}`,
    );
  console.log(
    `Total: ${found.cards.length} run cards, ${found.records.length} record attachments`,
  );
};
const inspect = async (input: Input): Promise<Plan> => {
  const db: Database = new Database(input.db, { readonly: true });
  try {
    guard(db, input.target);

    return await plan(input.tracker, db, input.project);
  } finally {
    db.close();
  }
};
const gone = async (tracker: Tracker.Tracker, id: number): Promise<boolean> => {
  const card: Tracker.Card | null = await tracker.get(id);

  return card === null || card.status === State.DELETED;
};
const log = (entry: object): void => {
  console.log(JSON.stringify({ event: "board-cleanup-delete", ...entry }));
};

export const cleanup = async (input: Input): Promise<Summary | null> => {
  const found: Plan = await inspect(input);
  report(found);
  const total: number = found.cards.length + found.records.length;
  if (input.confirm === undefined) {
    console.log(`Dry run. Delete with --confirm ${total}`);

    return null;
  }
  if (input.confirm !== total)
    throw new Error(`Confirmed ${input.confirm} items but found ${total}`);
  await archive(input.tracker, join(dirname(input.db), ARCHIVE), found);
  const summary: Summary = { event: "board-cleanup", cards: 0, records: 0 };
  for (const entry of found.records) {
    const removed: boolean = await input.remove.attachment(entry.attachment.id);
    log({
      kind: "record",
      id: entry.attachment.id,
      card: entry.card,
      removed,
    });
    if (removed) summary.records++;
  }
  for (const card of found.cards) {
    const removed: boolean = await input.remove.note(card.id);
    if (!(await gone(input.tracker, card.id)))
      throw new Error(`Run card ${card.id} is still on the board after delete`);
    log({ kind: "card", id: card.id, removed });
    if (removed) summary.cards++;
  }
  console.log(JSON.stringify(summary));

  return summary;
};

if (import.meta.main) {
  const args = parseArgs({
    options: {
      url: { type: "string" },
      board: { type: "string" },
      project: { type: "string" },
      db: { type: "string", default: process.env.QUAZ_DB },
      confirm: { type: "string" },
    },
  }).values;
  const token: string = process.env.QUAZ_TRACKER_TOKEN ?? "";
  if (!args.url || !args.board || !args.project || !args.db)
    throw new Error(
      "Usage: bun scripts/qa/cleanup.ts --url URL --board OWNER/BOARD --project ID [--db DB] [--confirm N]",
    );
  const confirm: number | undefined =
    args.confirm === undefined ? undefined : Number(args.confirm);
  if (confirm !== undefined && !Number.isSafeInteger(confirm))
    throw new Error("--confirm needs a whole number");
  await cleanup({
    tracker: Adapter.connect(args.url, args.board, token),
    remove: Adapter.remover(args.url, args.board, token),
    db: args.db,
    project: Protocol.key.parse(args.project),
    target: Migrate.target(args.url, args.board),
    confirm,
  });
}
