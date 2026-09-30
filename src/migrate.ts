import type { Database } from "bun:sqlite";
import * as Protocol from "@/qa_protocol";
import * as Record from "@/record";
import * as State from "@/state";
import * as Tracker from "@/tracker";

export const IMPORTED: string = "records_imported";
export const AUTHORITY: string = "authority";
export const LOCAL: string = "local";
export const target = (url: string, board: string): string =>
  `${new URL(url).origin}/${board}`;
const PROJECT_TAG: string = "project:";

const managed = (card: Tracker.Card): boolean => {
  const labels: Set<string> = State.tags(card.tags);

  return (
    card.status !== State.DELETED &&
    labels.has(Protocol.TAG.issue) &&
    [...labels].some((label): boolean => label.startsWith(PROJECT_TAG))
  );
};
const load = async (
  tracker: Tracker.Tracker,
  card: Tracker.Card,
): Promise<Record.Record | null> => {
  try {
    return await Record.load(tracker, card.id);
  } catch (error: unknown) {
    throw new Error(
      `Quaz record import failed on card ${card.id}: ${String(error)}`,
      { cause: error },
    );
  }
};

export const records = async (
  db: Database,
  tracker: Tracker.Tracker,
): Promise<void> => {
  if (db.query("SELECT 1 FROM qa_meta WHERE key=?").get(IMPORTED)) return;
  const cards: Tracker.Card[] = (await tracker.list(Tracker.STATUSES)).filter(
    managed,
  );
  const entries: Record.Record[] = (
    await Promise.all(cards.map((card) => load(tracker, card)))
  ).filter((entry): entry is Record.Record => entry !== null);
  const labels: Map<number, Set<string>> = new Map(
    cards.map((card): [number, Set<string>] => [
      card.id,
      State.tags(card.tags),
    ]),
  );
  const imported: Set<number> = new Set();
  let findings: number = 0;
  db.transaction((): void => {
    for (const entry of entries) {
      if (!labels.get(entry.card)?.has(`${PROJECT_TAG}${entry.project}`))
        continue;
      for (const finding of entry.findings) {
        if (!finding.test) continue;
        db.query(
          `INSERT INTO qa_findings (project,fingerprint,note_id,test,fix,last_result)
           VALUES (?,?,?,?,?,?) ON CONFLICT(project,fingerprint) DO UPDATE SET
           note_id=excluded.note_id,test=excluded.test,fix=excluded.fix,
           last_result=excluded.last_result`,
        ).run(
          entry.project,
          finding.fingerprint,
          entry.card,
          JSON.stringify(finding.test),
          finding.fix,
          finding.lastResult,
        );
        imported.add(entry.card);
        findings++;
      }
    }
    db.query("INSERT INTO qa_meta (key,value) VALUES (?,?)").run(
      IMPORTED,
      String(Date.now()),
    );
  })();
  console.log(
    JSON.stringify({
      event: "quaz-records-imported",
      cards: imported.size,
      findings,
    }),
  );
};
