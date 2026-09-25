import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import * as Protocol from "@/qa_protocol";
import * as State from "@/state";

type LegacyRun = {
  sequence: number;
  id: string;
  board_id: number;
  note_id: number;
  owner: string;
  project: string;
  mode: string;
  revision: string;
  scenario: string;
  attention: string | null;
  status: string;
  expires: number;
  target: number | null;
  snapshot: number | null;
  receipt: string | null;
  request: string;
  result: string | null;
  started: number | null;
};
type LegacyFlow = {
  project: string;
  key: string;
  goal: string;
  run: string;
  expires: number;
  status: string;
};
type LegacyFinding = {
  project: string;
  fingerprint: string;
  note_id: number;
  test: string;
  fix: string | null;
  last_result: string | null;
  verified_through: number;
};
type LegacyArtifact = {
  run: string;
  path: string;
  digest: string;
  mime: string;
  attachment: number;
};
type LegacyPublication = { project: string; run: string; expires: number };
export type Counts = {
  runs: number;
  flows: number;
  findings: number;
  artifacts: number;
  publications: number;
};

export const migrate = (
  sourcePath: string,
  outputPath: string,
  board: number,
  project: string,
): Counts => {
  Protocol.key.parse(project);
  if (!Number.isSafeInteger(board) || board <= 0)
    throw new Error("Board ID must be positive");
  if (existsSync(outputPath))
    throw new Error("Quaz import output already exists");
  const source: Database = new Database(sourcePath, { readonly: true });
  let target: Database | null = null;
  let completed: boolean = false;
  try {
    if (
      source.query<{ quick_check: string }, []>("PRAGMA quick_check").get()
        ?.quick_check !== "ok"
    )
      throw new Error("Legacy database integrity check failed");
    if (
      !source
        .query<{ id: number }, [number]>("SELECT id FROM boards WHERE id=?")
        .get(board)
    )
      throw new Error("Legacy board ID does not exist");
    const runs: LegacyRun[] = source
      .query<LegacyRun, [number, string]>(
        "SELECT rowid AS sequence,id,board_id,note_id,owner,project,mode,revision,scenario,attention,status,expires,target,snapshot,receipt,request,result,started FROM qa_runs WHERE board_id=? AND project=? ORDER BY rowid",
      )
      .all(board, project);
    const flows: LegacyFlow[] = source
      .query<LegacyFlow, [number, string]>(
        "SELECT project,key,goal,run,expires,status FROM qa_flows WHERE board_id=? AND project=?",
      )
      .all(board, project);
    const findings: LegacyFinding[] = source
      .query<LegacyFinding, [number, string]>(
        "SELECT project,fingerprint,note_id,test,fix,last_result,verified_through FROM qa_findings WHERE board_id=? AND project=?",
      )
      .all(board, project);
    const artifacts: LegacyArtifact[] = source
      .query<LegacyArtifact, [number, string]>(
        "SELECT a.run,a.path,a.digest,COALESCE(NULLIF(t.mime_type,''),'application/octet-stream') AS mime,a.attachment FROM qa_artifacts a JOIN qa_runs r ON r.id=a.run LEFT JOIN attachments t ON t.id=a.attachment WHERE r.board_id=? AND r.project=?",
      )
      .all(board, project);
    const publications: LegacyPublication[] = source
      .query<LegacyPublication, [number, string]>(
        "SELECT r.project,p.run,p.expires FROM qa_publications p JOIN qa_runs r ON r.id=p.run WHERE p.board_id=? AND r.project=?",
      )
      .all(board, project);
    if (!runs.length && !flows.length && !findings.length)
      throw new Error("Legacy board has no QA state; use QUAZ_BOOTSTRAP=empty");
    mkdirSync(dirname(outputPath), { recursive: true });
    target = new Database(outputPath, { create: true });
    State.prepare(target);
    target.transaction((): void => {
      for (const row of runs)
        target
          ?.query(
            "INSERT INTO qa_runs (rowid,id,board_id,note_id,owner,project,mode,revision,scenario,attention,status,expires,target,snapshot,receipt,request,result,started) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            row.sequence,
            row.id,
            row.board_id,
            row.note_id,
            row.owner,
            row.project,
            row.mode,
            row.revision,
            row.scenario,
            row.attention,
            row.status,
            row.expires,
            row.target,
            row.snapshot,
            row.receipt,
            row.request,
            row.result,
            row.started,
          );
      for (const row of flows)
        target
          ?.query(
            "INSERT INTO qa_flows (project,key,goal,run,expires,status) VALUES (?,?,?,?,?,?)",
          )
          .run(
            row.project,
            row.key,
            row.goal,
            row.run,
            row.expires,
            row.status,
          );
      for (const row of findings)
        target
          ?.query(
            "INSERT INTO qa_findings (project,fingerprint,note_id,test,fix,last_result,verified_through) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            row.project,
            row.fingerprint,
            row.note_id,
            row.test,
            row.fix,
            row.last_result,
            row.verified_through,
          );
      for (const row of artifacts)
        target
          ?.query(
            "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
          )
          .run(row.run, row.path, row.digest, row.mime, row.attachment);
      for (const row of publications)
        target
          ?.query(
            "INSERT INTO qa_publications (project,run,expires) VALUES (?,?,?)",
          )
          .run(row.project, row.run, row.expires);
    })();
    if (
      target.query<{ quick_check: string }, []>("PRAGMA quick_check").get()
        ?.quick_check !== "ok"
    )
      throw new Error("Imported database integrity check failed");

    completed = true;
    return {
      runs: runs.length,
      flows: flows.length,
      findings: findings.length,
      artifacts: artifacts.length,
      publications: publications.length,
    };
  } finally {
    target?.close();
    source.close();
    if (!completed) {
      rmSync(outputPath, { force: true });
      rmSync(`${outputPath}-wal`, { force: true });
      rmSync(`${outputPath}-shm`, { force: true });
    }
  }
};

if (import.meta.main) {
  const args = parseArgs({
    options: {
      source: { type: "string" },
      output: { type: "string" },
      board: { type: "string" },
      project: { type: "string" },
    },
  }).values;
  if (!args.source || !args.output || !args.board || !args.project)
    throw new Error(
      "Usage: bun scripts/qa/import.ts --source DB --output DB --board ID --project ID",
    );
  console.log(
    JSON.stringify(
      migrate(args.source, args.output, Number(args.board), args.project),
    ),
  );
}
