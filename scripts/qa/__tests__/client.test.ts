import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Client from "@qa/client";
import type * as Protocol from "@/qa_protocol";
import * as State from "@/state";
import type * as Tracker from "@/tracker";

const REVISION: string = "a".repeat(40);
const BEGIN: Protocol.Begin = {
  id: "qa-first",
  project: "sample",
  mode: "discover",
  revision: REVISION,
  runner: { source: REVISION, image: `sha256:${"b".repeat(64)}` },
  scenario: "empty",
};

const fixture = (): {
  tracker: Tracker.Authority;
  expire: () => void;
  breakAfterUpdate: () => void;
  cardsCount: () => number;
  writes: () => number;
} => {
  const cards: Map<number, Tracker.Card> = new Map();
  const keys: Map<string, number> = new Map();
  let next: number = 1;
  let owner: string | null = null;
  let fence: number = 0;
  let expires: number = 0;
  let version: number = 0;
  let writes: number = 0;
  let value: Uint8Array = new Uint8Array();
  let interruptAfterUpdate: boolean = false;
  const document: Tracker.Document = {
    claim: async (
      _key: string,
      selected: string,
      ttl: number,
    ): Promise<Tracker.Lease | null> => {
      if (owner && expires > Date.now()) return null;
      owner = selected;
      fence += 1;
      expires = Date.now() + ttl * 1000;

      return { version, value: Uint8Array.from(value), fence, expires };
    },
    renew: async (
      _key: string,
      selected: string,
      current: number,
      ttl: number,
    ): Promise<number> => {
      if (owner !== selected || fence !== current || expires <= Date.now())
        throw new Error("Lease changed");
      expires = Date.now() + ttl * 1000;

      return expires;
    },
    write: async (
      _key: string,
      selected: string,
      current: number,
      expected: number,
      bytes: Uint8Array,
    ): Promise<number> => {
      if (
        owner !== selected ||
        fence !== current ||
        expires <= Date.now() ||
        version !== expected
      )
        throw new Error("Document changed");
      value = Uint8Array.from(bytes);
      version += 1;
      writes += 1;

      return version;
    },
    release: async (
      _key: string,
      selected: string,
      current: number,
    ): Promise<void> => {
      if (owner !== selected || fence !== current)
        throw new Error("Lease changed");
      owner = null;
      expires = 0;
    },
  };
  const tracker: Tracker.Authority = {
    document,
    list: async (): Promise<Tracker.Card[]> => [...cards.values()],
    get: async (id: number): Promise<Tracker.Card | null> =>
      cards.get(id) ?? null,
    create: async (title: string, key: string): Promise<Tracker.Card> => {
      const prior: Tracker.Card | undefined = cards.get(keys.get(key) ?? 0);
      if (prior) return prior;
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

      return card;
    },
    recover: async (key: string): Promise<Tracker.Card | null> =>
      cards.get(keys.get(key) ?? 0) ?? null,
    update: async (
      id: number,
      changes: Tracker.Changes,
    ): Promise<Tracker.Card> => {
      const prior: Tracker.Card | undefined = cards.get(id);
      if (!prior) throw new Error("Card missing");
      const card: Tracker.Card = {
        ...prior,
        version: prior.version + 1,
        title: changes.title ?? prior.title,
        description: changes.description ?? prior.description,
        checklist: changes.checklist ?? prior.checklist,
        tags: changes.tags ?? prior.tags,
      };
      cards.set(id, card);
      if (interruptAfterUpdate) {
        interruptAfterUpdate = false;
        throw new Error("Card update interrupted");
      }

      return card;
    },
    complete: async (id: number): Promise<void> => {
      const card: Tracker.Card | undefined = cards.get(id);
      if (!card) throw new Error("Card missing");
      cards.set(id, { ...card, version: card.version + 1, status: 1 });
    },
    reopen: async (id: number): Promise<void> => {
      const card: Tracker.Card | undefined = cards.get(id);
      if (!card) throw new Error("Card missing");
      cards.set(id, { ...card, version: card.version + 1, status: 0 });
    },
    comment: async (): Promise<void> => {},
    upload: async (): Promise<Tracker.Attachment> => {
      throw new Error("Unexpected upload");
    },
    attachments: async (): Promise<Tracker.Attachment[]> => [],
    download: async (): Promise<Uint8Array> => {
      throw new Error("Unexpected download");
    },
    attachmentUrl: (id: number): string =>
      `https://tracker.example/attachments/${id}`,
  };

  return {
    tracker,
    expire: (): void => {
      expires = 0;
    },
    breakAfterUpdate: (): void => {
      interruptAfterUpdate = true;
    },
    cardsCount: (): number => cards.size,
    writes: (): number => writes,
  };
};

test("two controllers share claims across separate databases", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-authority-"));
  const previous: string | undefined = process.env.QUAZ_DB;
  const priorBootstrap: string | undefined = process.env.QUAZ_BOOTSTRAP;
  const shared = fixture();
  try {
    process.env.QUAZ_BOOTSTRAP = "empty";
    process.env.QUAZ_DB = join(folder, "first.db");
    const first: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    await expect(
      Client.open(
        "https://tracker.example",
        "owner/board",
        "token",
        "sample",
        shared.tracker,
      ),
    ).rejects.toThrow("Another Quaz controller");
    const run: Protocol.Run = await first.request("/runs", "POST", BEGIN);
    await first.request(`/runs/${run.id}/ready`, "POST", {});
    const firstClaim: { accepted: boolean } = await first.request(
      `/runs/${run.id}/claim`,
      "POST",
      {
        key: "save-draft",
        goal: "Save persists",
      },
    );
    expect(firstClaim.accepted).toBe(true);
    await first.close?.();
    process.env.QUAZ_DB = join(folder, "second.db");
    const second: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    const state: Protocol.State = await second.request("/state?project=sample");
    expect(state.flows).toEqual([
      expect.objectContaining({ key: "save-draft", run: run.id }),
    ]);
    const writes: number = shared.writes();
    await second.request("/state?project=sample");
    expect(shared.writes()).toBe(writes);
    const next: Protocol.Run = await second.request("/runs", "POST", {
      ...BEGIN,
      id: "qa-second",
    });
    await second.request(`/runs/${next.id}/ready`, "POST", {});
    const secondClaim: { accepted: boolean } = await second.request(
      `/runs/${next.id}/claim`,
      "POST",
      {
        key: "save-draft",
        goal: "Save persists",
      },
    );
    expect(secondClaim.accepted).toBe(false);
    await second.close?.();
  } finally {
    if (previous === undefined) delete process.env.QUAZ_DB;
    else process.env.QUAZ_DB = previous;
    if (priorBootstrap === undefined) delete process.env.QUAZ_BOOTSTRAP;
    else process.env.QUAZ_BOOTSTRAP = priorBootstrap;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("another controller recovers an interrupted card write", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-retry-"));
  const previous: string | undefined = process.env.QUAZ_DB;
  const priorBootstrap: string | undefined = process.env.QUAZ_BOOTSTRAP;
  const shared = fixture();
  try {
    process.env.QUAZ_BOOTSTRAP = "empty";
    process.env.QUAZ_DB = join(folder, "first.db");
    const first: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    shared.breakAfterUpdate();
    await expect(first.request("/runs", "POST", BEGIN)).rejects.toThrow(
      "Card update interrupted",
    );
    expect(shared.cardsCount()).toBe(1);
    await first.close?.();
    process.env.QUAZ_DB = join(folder, "second.db");
    const second: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    const resumed: Protocol.Run = await second.request("/runs", "POST", BEGIN);
    expect(resumed.note_id).toBe(1);
    expect(shared.cardsCount()).toBe(1);
    await second.close?.();
  } finally {
    if (previous === undefined) delete process.env.QUAZ_DB;
    else process.env.QUAZ_DB = previous;
    if (priorBootstrap === undefined) delete process.env.QUAZ_BOOTSTRAP;
    else process.env.QUAZ_BOOTSTRAP = priorBootstrap;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("expired controller cannot write after takeover", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-fence-"));
  const previous: string | undefined = process.env.QUAZ_DB;
  const priorBootstrap: string | undefined = process.env.QUAZ_BOOTSTRAP;
  const shared = fixture();
  try {
    process.env.QUAZ_BOOTSTRAP = "empty";
    process.env.QUAZ_DB = join(folder, "first.db");
    const first: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    shared.expire();
    process.env.QUAZ_DB = join(folder, "second.db");
    const second: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    await expect(first.request("/runs", "POST", BEGIN)).rejects.toThrow(
      "Lease changed",
    );
    expect(shared.cardsCount()).toBe(0);
    await second.request("/runs", "POST", BEGIN);
    expect(shared.cardsCount()).toBe(1);
    await first.close?.();
    await second.close?.();
  } finally {
    if (previous === undefined) delete process.env.QUAZ_DB;
    else process.env.QUAZ_DB = previous;
    if (priorBootstrap === undefined) delete process.env.QUAZ_BOOTSTRAP;
    else process.env.QUAZ_BOOTSTRAP = priorBootstrap;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("imports a file-backed WAL database", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-import-"));
  const previous: string | undefined = process.env.QUAZ_DB;
  const priorBootstrap: string | undefined = process.env.QUAZ_BOOTSTRAP;
  const shared = fixture();
  try {
    const file: string = join(folder, "history.db");
    const source: State.State = State.open(file, shared.tracker);
    await source.begin(BEGIN);
    source.db.exec(
      "CREATE TABLE qa_import (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL)",
    );
    source.db
      .query("INSERT INTO qa_import (id,marker) VALUES (1,?)")
      .run("test-import");
    source.db.close();
    process.env.QUAZ_DB = file;
    process.env.QUAZ_BOOTSTRAP = "import";
    const first: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    expect((await first.request<Protocol.Run>(`/runs/${BEGIN.id}`)).id).toBe(
      BEGIN.id,
    );
    await first.close?.();
    process.env.QUAZ_DB = join(folder, "other.db");
    delete process.env.QUAZ_BOOTSTRAP;
    const second: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    expect((await second.request<Protocol.Run>(`/runs/${BEGIN.id}`)).id).toBe(
      BEGIN.id,
    );
    await second.close?.();
  } finally {
    if (previous === undefined) delete process.env.QUAZ_DB;
    else process.env.QUAZ_DB = previous;
    if (priorBootstrap === undefined) delete process.env.QUAZ_BOOTSTRAP;
    else process.env.QUAZ_BOOTSTRAP = priorBootstrap;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("import refuses an unrelated remote snapshot", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-import-conflict-"));
  const previous: string | undefined = process.env.QUAZ_DB;
  const priorBootstrap: string | undefined = process.env.QUAZ_BOOTSTRAP;
  const shared = fixture();
  try {
    process.env.QUAZ_DB = join(folder, "empty.db");
    process.env.QUAZ_BOOTSTRAP = "empty";
    const first: Client.Client = await Client.open(
      "https://tracker.example",
      "owner/board",
      "token",
      "sample",
      shared.tracker,
    );
    await first.close?.();
    const writes: number = shared.writes();
    const file: string = join(folder, "import.db");
    const source: State.State = State.open(file, shared.tracker);
    source.db.exec(
      "CREATE TABLE qa_import (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL)",
    );
    source.db
      .query("INSERT INTO qa_import (id,marker) VALUES (1,?)")
      .run("different-import");
    source.db.close();
    process.env.QUAZ_DB = file;
    process.env.QUAZ_BOOTSTRAP = "import";
    await expect(
      Client.open(
        "https://tracker.example",
        "owner/board",
        "token",
        "sample",
        shared.tracker,
      ),
    ).rejects.toThrow("does not match the requested legacy import");
    expect(shared.writes()).toBe(writes);
  } finally {
    if (previous === undefined) delete process.env.QUAZ_DB;
    else process.env.QUAZ_DB = previous;
    if (priorBootstrap === undefined) delete process.env.QUAZ_BOOTSTRAP;
    else process.env.QUAZ_BOOTSTRAP = priorBootstrap;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("empty authority needs an explicit bootstrap choice", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-gate-"));
  const previous: string | undefined = process.env.QUAZ_DB;
  const priorBootstrap: string | undefined = process.env.QUAZ_BOOTSTRAP;
  try {
    process.env.QUAZ_DB = join(folder, "missing.db");
    delete process.env.QUAZ_BOOTSTRAP;
    await expect(
      Client.open(
        "https://tracker.example",
        "owner/board",
        "token",
        "sample",
        fixture().tracker,
      ),
    ).rejects.toThrow("Empty Quaz authority");
  } finally {
    if (previous === undefined) delete process.env.QUAZ_DB;
    else process.env.QUAZ_DB = previous;
    if (priorBootstrap === undefined) delete process.env.QUAZ_BOOTSTRAP;
    else process.env.QUAZ_BOOTSTRAP = priorBootstrap;
    rmSync(folder, { recursive: true, force: true });
  }
});
