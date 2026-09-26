import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Legacy from "@qa/import";

test("imports board history without changing the legacy database", () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-legacy-"));
  const sourcePath: string = join(folder, "overdew.db");
  const outputPath: string = join(folder, "quaz.db");
  try {
    const source: Database = new Database(sourcePath, { create: true });
    source.exec(`
      CREATE TABLE workspaces (id INTEGER PRIMARY KEY,slug TEXT);
      CREATE TABLE boards (id INTEGER PRIMARY KEY,slug TEXT,workspace_id INTEGER);
      CREATE TABLE qa_runs (id TEXT PRIMARY KEY,board_id INTEGER,note_id INTEGER,owner TEXT,project TEXT,mode TEXT,revision TEXT,scenario TEXT,attention TEXT,status TEXT,expires INTEGER,target INTEGER,snapshot INTEGER,receipt TEXT,request TEXT,result TEXT,started INTEGER);
      CREATE TABLE qa_flows (board_id INTEGER,project TEXT,key TEXT,goal TEXT,run TEXT,expires INTEGER,status TEXT);
      CREATE TABLE qa_findings (board_id INTEGER,project TEXT,fingerprint TEXT,note_id INTEGER,test TEXT,fix TEXT,last_result TEXT,verified_through INTEGER);
      CREATE TABLE qa_artifacts (run TEXT,path TEXT,digest TEXT,attachment INTEGER);
      CREATE TABLE qa_publications (board_id INTEGER,run TEXT,expires INTEGER);
      CREATE TABLE attachments (id INTEGER PRIMARY KEY,mime_type TEXT);
      INSERT INTO workspaces VALUES (1,'owner');
      INSERT INTO boards VALUES (7,'board-seven',1),(8,'board-eight',1);
      INSERT INTO attachments VALUES (20,'image/png');
      INSERT INTO qa_runs VALUES ('qa-old',7,11,'tester','sample','discover','${"a".repeat(40)}','empty',NULL,'complete',0,NULL,NULL,'receipt','request','{}',1);
      INSERT INTO qa_runs VALUES ('qa-other',8,12,'tester','sample','discover','${"a".repeat(40)}','empty',NULL,'complete',0,NULL,NULL,'receipt','request','{}',1);
      INSERT INTO qa_flows VALUES (7,'sample','save','Save works','qa-old',0,'complete');
      INSERT INTO qa_findings VALUES (7,'sample','${"b".repeat(64)}',13,'{}',NULL,NULL,1);
      INSERT INTO qa_artifacts VALUES ('qa-old','shot.png','${"c".repeat(64)}',20);
      INSERT INTO qa_publications VALUES (7,'qa-old',100);
    `);
    source.close();
    expect(
      Legacy.migrate(
        sourcePath,
        outputPath,
        7,
        "sample",
        "https://tracker.example",
      ),
    ).toEqual({
      runs: 1,
      flows: 1,
      findings: 1,
      artifacts: 1,
      publications: 1,
    });
    const target: Database = new Database(outputPath, { readonly: true });
    expect(
      target.query<{ id: string }, []>("SELECT id FROM qa_runs").all(),
    ).toEqual([{ id: "qa-old" }]);
    expect(
      target.query<{ mime: string }, []>("SELECT mime FROM qa_artifacts").get(),
    ).toEqual({ mime: "image/png" });
    expect(
      target.query<{ key: string }, []>("SELECT key FROM qa_flows").get(),
    ).toEqual({ key: "save" });
    const verification = target
      .query<{ verified_through: number; verified_at: number }, []>(
        "SELECT verified_through,verified_at FROM qa_findings",
      )
      .get();
    expect(verification?.verified_through).toBe(1);
    expect(verification?.verified_at).toBeGreaterThan(0);
    expect(Date.now()).toBeGreaterThan(verification?.verified_at ?? 0);
    expect(
      target
        .query<{ value: string }, []>(
          "SELECT value FROM qa_destination WHERE id=1",
        )
        .get()?.value,
    ).toBe("https://tracker.example/owner/board-seven");
    expect(
      target
        .query<{ marker: string }, []>(
          "SELECT marker FROM qa_import WHERE id=1",
        )
        .get()?.marker,
    ).toMatch(/^[0-9a-f-]{36}$/);
    target.close();
    const unchanged: Database = new Database(sourcePath, { readonly: true });
    expect(
      unchanged
        .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM qa_runs")
        .get()?.total,
    ).toBe(2);
    unchanged.close();
    expect(
      (): Legacy.Counts =>
        Legacy.migrate(
          sourcePath,
          outputPath,
          7,
          "sample",
          "https://tracker.example",
        ),
    ).toThrow("already exists");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
