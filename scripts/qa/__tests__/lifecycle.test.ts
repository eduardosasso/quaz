import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@qa/client";
import * as Lifecycle from "@qa/lifecycle";
import * as Review from "@qa/review";

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

test("measured interactions include the recorded browser events", () => {
  const checks: Review.Assessment["checks"] = [
    {
      id: "navigation",
      status: "measured",
      actual: "Navigation succeeded",
      evidence: ["reviewer/page.png"],
    },
    {
      id: "performance",
      status: "blocked",
      actual: "No timing evidence",
      evidence: ["reviewer/page.png"],
    },
  ];
  const result: Review.Assessment["checks"] = Review.checkedEvidence(checks);
  expect(result[0]?.evidence).toEqual([
    "reviewer/page.png",
    "reviewer/events.jsonl",
  ]);
  expect(result[1]?.evidence).toEqual(["reviewer/page.png"]);
});

test("one click cannot support every measured interaction check", () => {
  const checks: Review.Assessment["checks"] = [
    "navigation",
    "prevention",
    "recovery",
    "persistence",
    "states",
    "keyboard",
  ].map((id) => ({
    id: id as Review.Assessment["checks"][number]["id"],
    status: "measured",
    actual: "Measured",
    evidence: ["reviewer/events.jsonl"],
  }));
  const log: string = JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "mobile",
      tool: "browser_click",
      status: "completed",
      error: null,
      arguments: {},
    },
  });
  expect(() => Review.interactionSupport(checks, log)).toThrow(
    "Measured checks lack distinct browser actions",
  );
});
