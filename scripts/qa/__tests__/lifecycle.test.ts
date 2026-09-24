import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@qa/client";
import * as Lifecycle from "@qa/lifecycle";

test("raw Claude logs never become tracker artifacts", async () => {
  const root: string = mkdtempSync(join(tmpdir(), "quaz-artifacts-"));
  const folder: string = join(root, "reviewer");
  const uploaded: string[] = [];
  mkdirSync(folder);
  writeFileSync(join(folder, "events.raw.jsonl"), "secret-token");
  writeFileSync(join(folder, "events.raw.stderr.log"), "secret-token");
  writeFileSync(join(folder, "events.jsonl"), '{"type":"checked"}\n');
  const client: Client = {
    request: async <T>(): Promise<T> => {
      throw new Error("Unexpected tracker request");
    },
    upload: async (
      _run: string,
      path: string,
      _bytes: Uint8Array,
      _mime: string,
    ): Promise<number> => {
      uploaded.push(path);

      return uploaded.length;
    },
    comments: async (): Promise<string[]> => [],
  };
  try {
    await Lifecycle.artifacts(client, "test-run", root);
    expect(uploaded).toEqual(["reviewer/events.jsonl.gz"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
