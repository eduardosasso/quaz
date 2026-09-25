import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Finish from "@/finish";
import * as Protocol from "@/qa_protocol";
import * as Record from "@/record";
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

test("run cards stay out of the issue catalog without tags", async () => {
  const { state, cards } = fixture();
  const run: Protocol.Run = await state.begin(begin("discover"));
  const card: Tracker.Card | undefined = cards.get(run.note_id);
  if (!card) throw new Error("Missing run card");
  cards.set(card.id, { ...card, tags: "" });

  expect((await state.catalog("sample")).cards).toEqual([]);
});

test("run card metadata retry reuses the created card", async () => {
  const { state, cards } = fixture();
  const input: Protocol.Begin = begin("discover");
  const update: Tracker.Tracker["update"] = state.tracker.update;
  let fails: boolean = true;
  state.tracker.update = async (
    id: number,
    changes: Tracker.Changes,
  ): Promise<Tracker.Card> => {
    if (fails) {
      fails = false;
      throw new Error("Metadata write failed");
    }

    return update(id, changes);
  };
  await expect(state.begin(input)).rejects.toThrow("Metadata write failed");
  expect(cards.size).toBe(1);
  const run: Protocol.Run = await state.begin(input);
  expect(cards.size).toBe(1);
  expect(cards.get(run.note_id)?.tags).toContain("qa-run");
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

test.each(["issue", "run"] as const)(
  "discovery retries after a partial %s card write",
  async (failure): Promise<void> => {
    const { state, cards, files } = fixture();
    const input: Protocol.Begin = begin("discover");
    const run: Protocol.Run = await state.begin(input);
    expect((await state.begin(input)).note_id).toBe(run.note_id);
    state.ready(run.id);
    expect(await state.claim(run.id, "save-draft", "Save retains text")).toBe(
      true,
    );
    const bytes: Uint8Array = new TextEncoder().encode("proof");
    const hash: string = createHash("sha256").update(bytes).digest("hex");
    const attachment: number = (
      await state.tracker.upload(run.note_id, "proof.txt", bytes, "text/plain")
    ).id;
    state.db
      .query(
        "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
      )
      .run(run.id, "proof.txt", hash, "text/plain", attachment);
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
      if (failOnce && failure === "issue" && id !== run.note_id) {
        failOnce = false;
        throw new Error("interrupted write");
      }
      return update(id, changes);
    };
    const complete: Tracker.Tracker["complete"] = state.tracker.complete;
    state.tracker.complete = async (id: number): Promise<void> => {
      if (failOnce && failure === "run" && id === run.note_id) {
        failOnce = false;
        throw new Error("interrupted write");
      }

      return complete(id);
    };
    await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
      "interrupted write",
    );
    expect(creations).toBe(1);
    expect(cards.size).toBe(2);
    expect((await state.catalog("sample")).cards).toEqual([
      expect.objectContaining({
        id: 2,
        fingerprints: [issue.fingerprint],
      }),
    ]);
    const first: Finish.Result = await Finish.publish(state, run.id, result);
    const second: Finish.Result = await Finish.publish(state, run.id, result);
    expect(first.created).toHaveLength(1);
    expect(second.replayed).toBe(true);
    expect(cards.size).toBe(2);
    expect(creations).toBe(1);
    expect(
      [...files.values()]
        .filter((file): boolean => /^quaz-[a-f0-9]/.test(file.name))
        .map((file): string => file.mime),
    ).toEqual(["text/plain"]);
    expect(state.finding(first.created[0])?.fingerprint).toBe(
      issue.fingerprint,
    );
  },
);

test("later discovery can reuse an abandoned pending finding", async () => {
  const { state, cards } = fixture();
  const first: Protocol.Run = await state.begin(begin("discover"));
  state.ready(first.id);
  await state.claim(first.id, "save-draft", "Save retains text");
  const bytes: Uint8Array = new TextEncoder().encode("proof");
  const attachment: number = (
    await state.tracker.upload(first.note_id, "proof.txt", bytes, "text/plain")
  ).id;
  const hash: string = createHash("sha256").update(bytes).digest("hex");
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(first.id, "proof.txt", hash, "text/plain", attachment);
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
  expect(cards.size).toBe(3);
  expect(cards.get(pending[0]?.id ?? 0)?.tags).toContain("needs-verification");
});

test("later discovery reuses a bare card after create interruption", async () => {
  const { state, cards } = fixture();
  const first: Protocol.Run = await state.begin(begin("discover"));
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
  expect(cards.size).toBe(2);
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
          target: 2,
          sameAs: null,
          reason: "Same fingerprint",
        },
      ],
    },
  });
  expect(published.cards).toEqual([2]);
  expect(published.created).toEqual([]);
  expect(cards.size).toBe(3);
  expect(cards.get(2)?.tags).toContain(Protocol.TAG.pending);
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
  const attachment: number = (
    await state.tracker.upload(run.note_id, "failure.txt", bytes, "text/plain")
  ).id;
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(
      run.id,
      "failure.txt",
      createHash("sha256").update(bytes).digest("hex"),
      "text/plain",
      attachment,
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
  expect(cards.get(issue.id)?.version).toBe(issue.version + 5);

  await state.tracker.complete(issue.id);
  const passed: Protocol.Run = await state.begin(begin("verify"));
  state.ready(passed.id);
  await state.claim(passed.id, `ticket-${issue.id}`, "Saved", issue.id);
  const passEvidence: number = (
    await state.tracker.upload(passed.note_id, "pass.txt", bytes, "text/plain")
  ).id;
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(
      passed.id,
      "pass.txt",
      createHash("sha256").update(bytes).digest("hex"),
      "text/plain",
      passEvidence,
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
  const attachment: number = (
    await state.tracker.upload(run.note_id, "proof.txt", bytes, "text/plain")
  ).id;
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(
      run.id,
      "proof.txt",
      createHash("sha256").update(bytes).digest("hex"),
      "text/plain",
      attachment,
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
  const { state } = fixture();
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
  const attachment: number = (
    await state.tracker.upload(run.note_id, "proof.txt", bytes, "text/plain")
  ).id;
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(
      run.id,
      "proof.txt",
      createHash("sha256").update(bytes).digest("hex"),
      "text/plain",
      attachment,
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
});

test("fresh database recovers a card test and fix from its files", async () => {
  const { state } = fixture();
  const created: Tracker.Card = await state.tracker.create(
    "Broken save",
    "issue",
  );
  const issue: Tracker.Card = await state.tracker.update(created.id, {
    tags: "qa,needs-verification,project:sample",
  });
  await state.tracker.complete(issue.id);
  const found: Protocol.Finding = finding(1);
  await Record.save(state.tracker, issue.id, {
    project: "sample",
    fingerprint: found.fingerprint,
    test: found.test,
  });
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-recover-"));
  folders.push(folder);
  const recovered: State.State = State.open(
    join(folder, "new.db"),
    state.tracker,
  );
  expect((await recovered.catalog("sample")).cards[0].fingerprints).toEqual([
    found.fingerprint,
  ]);
  expect((await recovered.state("sample")).tickets[0].test).toEqual(found.test);
  await recovered.fix(issue.id, revision);
  const again: State.State = State.open(
    join(folder, "again.db"),
    state.tracker,
  );

  expect((await again.state("sample")).tickets[0].fix).toBe(revision);
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
  const hash: string = createHash("sha256").update(bytes).digest("hex");
  const verifyFile: number = (
    await state.tracker.upload(
      verify.note_id,
      "verify.txt",
      bytes,
      "text/plain",
    )
  ).id;
  const discoverFile: number = (
    await state.tracker.upload(
      discover.note_id,
      "discover.txt",
      bytes,
      "text/plain",
    )
  ).id;
  for (const [run, path, attachment] of [
    [verify.id, "verify.txt", verifyFile],
    [discover.id, "discover.txt", discoverFile],
  ] as const)
    state.db
      .query(
        "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
      )
      .run(run, path, hash, "text/plain", attachment);
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
  const attachment = (
    await state.tracker.upload(run.note_id, "proof.txt", bytes, "text/plain")
  ).id;
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(
      run.id,
      "proof.txt",
      createHash("sha256").update(bytes).digest("hex"),
      "text/plain",
      attachment,
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
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-same-run-"));
  folders.push(folder);
  const recovered: State.State = State.open(
    join(folder, "new.db"),
    state.tracker,
  );
  await recovered.catalog("sample");
  const tests: { fingerprint: string; test: string }[] = recovered.db
    .query<{ fingerprint: string; test: string }, [number]>(
      "SELECT fingerprint,test FROM qa_findings WHERE note_id=?",
    )
    .all(published.created[0]);
  expect(
    Object.fromEntries(
      tests.map((entry): [string, Protocol.Case] => [
        entry.fingerprint,
        JSON.parse(entry.test) as Protocol.Case,
      ]),
    ),
  ).toEqual({
    [first.fingerprint]: first.test,
    [second.fingerprint]: second.test,
  });
  await recovered.fix(published.created[0], revision);
  const again: State.State = State.open(
    join(folder, "again.db"),
    state.tracker,
  );
  await again.catalog("sample");
  expect(
    again.db
      .query<{ fix: string | null }, [number]>(
        "SELECT fix FROM qa_findings WHERE note_id=?",
      )
      .all(published.created[0])
      .map((entry): string | null => entry.fix),
  ).toEqual([revision, revision]);
});

test("legacy card record survives controller restart", async () => {
  const { state } = fixture();
  const created: Tracker.Card = await state.tracker.create(
    "Legacy issue",
    "legacy",
  );
  const issue: Tracker.Card = await state.tracker.update(created.id, {
    tags: "qa,needs-verification,project:sample",
  });
  await state.tracker.complete(issue.id);
  const found: Protocol.Finding = finding(1);
  const bytes: Uint8Array = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      card: issue.id,
      project: "sample",
      fingerprints: [found.fingerprint],
      test: found.test,
      fix: revision,
      lastResult: null,
    }),
  );
  await state.tracker.upload(
    issue.id,
    "quaz-record-legacy.json",
    bytes,
    Record.MIME,
  );
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-legacy-"));
  folders.push(folder);
  const recovered: State.State = State.open(
    join(folder, "new.db"),
    state.tracker,
  );

  expect((await recovered.state("sample")).tickets[0]).toEqual(
    expect.objectContaining({ test: found.test, fix: revision }),
  );
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
  const attachment = (
    await state.tracker.upload(run.note_id, "proof.txt", bytes, "text/plain")
  ).id;
  state.db
    .query(
      "INSERT INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
    )
    .run(
      run.id,
      "proof.txt",
      createHash("sha256").update(bytes).digest("hex"),
      "text/plain",
      attachment,
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
