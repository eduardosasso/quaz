import { describe, expect, test } from "bun:test";
import * as Duplicates from "@qa/duplicates";
import type * as Protocol from "@/qa_protocol";

const FINGERPRINT: string = "a".repeat(64);
const OTHER: string = "b".repeat(64);
const CASE: Protocol.Case = {
  flow: "card-editor",
  route: "/cards",
  steps: ["Open a card", "Save the changed title"],
  expected: "The title stays after reload",
  scenario: "empty",
};
const candidate: Duplicates.Candidate = {
  fingerprint: FINGERPRINT,
  title: "The changed title disappears",
  actual: "The old title returns after reload",
  impact: "Users lose saved edits",
  test: CASE,
};
const catalog = (fingerprint: string | null): Protocol.Catalog => ({
  snapshot: "c".repeat(64),
  cards: [
    {
      id: 1,
      version: 1,
      title: "The changed title disappears",
      description: "",
      checklist: "",
      tags: "",
      status: 0,
      comments: [],
      fingerprints: fingerprint ? [fingerprint] : [],
    },
  ],
});
const decision = (
  overrides: Partial<Protocol.Matching["decisions"][number]> = {},
): unknown => ({
  decisions: [
    {
      fingerprint: FINGERPRINT,
      verdict: "new",
      target: null,
      sameAs: null,
      reason: "No matching card in the catalog",
      ...overrides,
    },
  ],
});

describe("QA duplicate review fingerprint", (): void => {
  test("is stable for equivalent title and expected outcome regardless of case or spacing", (): void => {
    expect(
      Duplicates.fingerprint("sample-app", "card-editor", "  Title  ", "Fixed"),
    ).toBe(
      Duplicates.fingerprint("sample-app", "card-editor", "title", "fixed"),
    );
  });

  test("changes when the project, flow, title, or expected outcome changes", (): void => {
    const base: string = Duplicates.fingerprint(
      "sample-app",
      "card-editor",
      "Title",
      "Fixed",
    );
    expect(
      Duplicates.fingerprint("other-app", "card-editor", "Title", "Fixed"),
    ).not.toBe(base);
    expect(
      Duplicates.fingerprint("sample-app", "other-flow", "Title", "Fixed"),
    ).not.toBe(base);
    expect(
      Duplicates.fingerprint("sample-app", "card-editor", "Other", "Fixed"),
    ).not.toBe(base);
    expect(
      Duplicates.fingerprint("sample-app", "card-editor", "Title", "Other"),
    ).not.toBe(base);
  });
});

describe("QA duplicate review prompt", (): void => {
  test("embeds the catalog and candidates as untrusted data", (): void => {
    const board: Protocol.Catalog = catalog(null);
    const text: string = Duplicates.prompt(board, [candidate]);
    expect(text).toContain("untrusted data");
    expect(text).toContain(FINGERPRINT);
    expect(text).toContain(candidate.title);
  });
});

describe("QA duplicate review validate", (): void => {
  test("accepts a new verdict against an unrelated catalog", (): void => {
    const board: Protocol.Catalog = catalog(OTHER);
    const result: Protocol.Matching = Duplicates.validate(decision(), board, [
      candidate,
    ]);
    expect(result.snapshot).toBe(board.snapshot);
    expect(result.decisions[0].verdict).toBe("new");
  });

  test("accepts an existing verdict that names the exact fingerprint match", (): void => {
    const board: Protocol.Catalog = catalog(FINGERPRINT);
    const result: Protocol.Matching = Duplicates.validate(
      decision({ verdict: "existing", target: 1 }),
      board,
      [candidate],
    );
    expect(result.decisions[0].target).toBe(1);
  });

  test("rejects an existing verdict naming a card outside the catalog", (): void => {
    const board: Protocol.Catalog = catalog(FINGERPRINT);
    expect(
      (): Protocol.Matching =>
        Duplicates.validate(
          decision({ verdict: "existing", target: 99 }),
          board,
          [candidate],
        ),
    ).toThrow();
  });

  test("rejects a decision list that omits a candidate", (): void => {
    const board: Protocol.Catalog = catalog(null);
    expect(
      (): Protocol.Matching =>
        Duplicates.validate({ decisions: [] }, board, [candidate]),
    ).toThrow();
  });

  test("does not itself gate on an exact fingerprint match", (): void => {
    // Fingerprint identity is enforced server-side on /finish, not here.
    const board: Protocol.Catalog = catalog(FINGERPRINT);
    const result: Protocol.Matching = Duplicates.validate(decision(), board, [
      candidate,
    ]);
    expect(result.decisions[0].verdict).toBe("new");
  });
});
