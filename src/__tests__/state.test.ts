import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Finish from "@/finish";
import type * as Protocol from "@/qa_protocol";
import * as State from "@/state";
import type * as Tracker from "@/tracker";

const folders: string[] = [];
afterEach((): void => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
const fixture = (): {
  state: State.State;
  cards: Map<number, Tracker.Card>;
  comments: Map<number, string[]>;
  files: Map<number, { name: string; bytes: Uint8Array; mime: string }>;
} => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-test-"));
  folders.push(folder);
  const cards: Map<number, Tracker.Card> = new Map();
  const comments: Map<number, string[]> = new Map();
  const files: Map<number, { name: string; bytes: Uint8Array; mime: string }> =
    new Map();
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
    create: async (
      title: string,
      changes: Tracker.Changes,
      key: string,
    ): Promise<Tracker.Card> => {
      const prior: number | undefined = keys.get(key);
      if (prior) return copy(cards.get(prior) as Tracker.Card);
      const card: Tracker.Card = {
        id: next++,
        version: 1,
        title,
        description: changes.description ?? "",
        checklist: changes.checklist ?? "[]",
        tags: changes.tags ?? "",
        status: 0,
        comments: [],
      };
      cards.set(card.id, card);
      keys.set(key, card.id);
      return copy(card);
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
    },
    upload: async (
      _id: number,
      path: string,
      bytes: Uint8Array,
      mime: string,
    ): Promise<Tracker.Attachment> => {
      const id: number = fileId++;
      files.set(id, { name: path, bytes, mime });
      return { id, name: path };
    },
    attachments: async (_id: number): Promise<Tracker.Attachment[]> =>
      [...files].map(
        ([id, value]): Tracker.Attachment => ({ id, name: value.name }),
      ),
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

test("discovery retries after a partial card write", async () => {
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
  const update: Tracker.Tracker["update"] = state.tracker.update;
  let failOnce: boolean = true;
  state.tracker.update = async (
    id: number,
    changes: Tracker.Changes,
  ): Promise<Tracker.Card> => {
    if (failOnce) {
      failOnce = false;
      throw new Error("interrupted update");
    }
    return update(id, changes);
  };
  await expect(Finish.publish(state, run.id, result)).rejects.toThrow(
    "interrupted update",
  );
  const first: Finish.Result = await Finish.publish(state, run.id, result);
  const second: Finish.Result = await Finish.publish(state, run.id, result);
  expect(first.created).toHaveLength(1);
  expect(second.replayed).toBe(true);
  expect(cards.size).toBe(2);
  expect(
    [...files.values()]
      .filter((file): boolean => file.name.startsWith("quaz-"))
      .map((file): string => file.mime),
  ).toEqual(["text/plain"]);
  expect(state.finding(first.created[0])?.fingerprint).toBe(issue.fingerprint);
});

test("failed verification reopens the card and records a comment", async () => {
  const { state, cards, comments } = fixture();
  const issue: Tracker.Card = await state.tracker.create(
    "Broken save",
    {
      tags: "qa,needs-verification,project:sample",
      description: "Broken",
    },
    "issue",
  );
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
  const published: Finish.Result = await Finish.publish(state, run.id, result);
  expect(published.cards).toEqual([issue.id]);
  expect(cards.get(issue.id)?.status).toBe(0);
  expect(comments.get(issue.id)?.at(-1)).toContain("QA fail");
  expect((await Finish.publish(state, run.id, result)).replayed).toBe(true);
  expect(comments.get(issue.id)).toHaveLength(1);
});

test("verification retry rejects a changed card", async () => {
  const { state, cards } = fixture();
  const issue: Tracker.Card = await state.tracker.create(
    "Broken save",
    { tags: "qa,needs-verification,project:sample" },
    "issue",
  );
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
  const issue: Tracker.Card = await state.tracker.create(
    "Existing report",
    { tags: "project:sample" },
    "existing",
  );
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

test("older discovery cannot reopen a newly verified issue", async () => {
  const { state, cards } = fixture();
  const issue: Tracker.Card = await state.tracker.create(
    "Broken save",
    { tags: "qa,needs-verification,project:sample" },
    "issue",
  );
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
});

test("deleted finding gets a replacement card", async () => {
  const { state, cards } = fixture();
  const fingerprint = "e".repeat(64);
  const old = await state.tracker.create(
    "Old issue",
    { tags: "qa,needs-verification,project:sample" },
    "old",
  );
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
