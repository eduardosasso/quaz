import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as Client from "@qa/client";
import type * as Protocol from "@/qa_protocol";
import * as State from "@/state";
import type * as Tracker from "@/tracker";

const REVISION: string = "a".repeat(40);
const LEASE_MS: number = 120_000;
const BEGIN: Protocol.Begin = {
  id: "qa-first",
  project: "sample",
  mode: "discover",
  revision: REVISION,
  runner: { source: REVISION, image: `sha256:${"b".repeat(64)}` },
  scenario: "empty",
};
const ISSUE_TAGS: string = "qa,needs-verification,project:sample";

const fixture = (): {
  tracker: Tracker.Authority;
  seed: (bytes: Uint8Array) => void;
  hold: () => void;
  free: () => void;
  forbid: () => void;
  tag: (tags: string) => void;
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
  let forbidden: boolean = false;
  const document: Tracker.Document = {
    claim: async (
      _key: string,
      selected: string,
      ttl: number,
    ): Promise<Tracker.Lease | null> => {
      if (forbidden) throw new Error("Board document is forbidden");
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
      if (forbidden) throw new Error("Board document is forbidden");
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
      if (forbidden) throw new Error("Board document is forbidden");
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
      if (forbidden) throw new Error("Board document is forbidden");
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
    seed: (bytes: Uint8Array): void => {
      value = Uint8Array.from(bytes);
    },
    hold: (): void => {
      owner = "another-controller";
      fence += 1;
      expires = Date.now() + LEASE_MS;
    },
    free: (): void => {
      owner = null;
      expires = 0;
    },
    forbid: (): void => {
      forbidden = true;
    },
    tag: (tags: string): void => {
      const id: number = next++;
      cards.set(id, {
        id,
        version: 1,
        title: `Finding ${id}`,
        description: "",
        checklist: "[]",
        tags,
        status: 0,
        comments: [],
      });
    },
    writes: (): number => writes,
  };
};

let folder: string = "";
const priorDb: string | undefined = process.env.QUAZ_DB;
const priorBootstrap: string | undefined = process.env.QUAZ_BOOTSTRAP;
const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const configure = (name: string, bootstrap?: string): string => {
  const file: string = join(folder, name);
  process.env.QUAZ_DB = file;
  restore("QUAZ_BOOTSTRAP", bootstrap);

  return file;
};
const connect = (tracker: Tracker.Authority): Promise<Client.Client> =>
  Client.open(
    "https://tracker.example",
    "owner/board",
    "token",
    "sample",
    tracker,
  );
const snapshot = async (
  tracker: Tracker.Authority,
  marker?: string,
): Promise<Uint8Array> => {
  const source: State.State = State.open(new Database(":memory:"), tracker);
  await source.begin(BEGIN);
  if (marker) {
    source.db.exec(
      "CREATE TABLE qa_import (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL)",
    );
    source.db
      .query("INSERT INTO qa_import (id,marker) VALUES (1,?)")
      .run(marker);
  }
  const bytes: Uint8Array = source.db.serialize();
  source.db.close();

  return gzipSync(bytes);
};
const legacy = (
  file: string,
  tracker: Tracker.Authority,
  marker: string,
): void => {
  const source: State.State = State.open(file, tracker);
  source.db.exec(
    "CREATE TABLE qa_import (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL)",
  );
  source.db.query("INSERT INTO qa_import (id,marker) VALUES (1,?)").run(marker);
  source.db.close();
};

beforeEach((): void => {
  folder = mkdtempSync(join(tmpdir(), "quaz-state-"));
});
afterEach((): void => {
  restore("QUAZ_DB", priorDb);
  restore("QUAZ_BOOTSTRAP", priorBootstrap);
  for (const entry of readdirSync(folder))
    chmodSync(join(folder, entry), 0o644);
  rmSync(folder, { recursive: true, force: true });
});

test("second process cannot open a locked state database", async () => {
  const shared = fixture();
  configure("state.db", "empty");
  const first: Client.Client = await connect(shared.tracker);
  await expect(connect(shared.tracker)).rejects.toThrow(
    "Another process owns the Quaz state database",
  );
  await first.close?.();
  const again: Client.Client = await connect(shared.tracker);
  await again.close?.();
});

test("artifact upload stays local and private beside the database", async () => {
  const shared = fixture();
  configure("state.db", "empty");
  const client: Client.Client = await connect(shared.tracker);
  const run: Protocol.Run = await client.request("/runs", "POST", BEGIN);
  const bytes: Uint8Array = new TextEncoder().encode("screenshot");
  const id: number = await client.upload(
    run.id,
    "validator/screen.png",
    bytes,
    "image/png",
  );
  const file: string = join(folder, "runs", run.id, "validator/screen.png");

  expect(id).toBe(1);
  expect(
    await client.upload(run.id, "validator/screen.png", bytes, "image/png"),
  ).toBe(id);
  await expect(
    client.upload(run.id, "../escape.png", bytes, "image/png"),
  ).rejects.toThrow("Invalid QA artifact path");
  expect(readFileSync(file)).toEqual(Buffer.from(bytes));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(shared.writes()).toBe(0);
  await client.close?.();
  rmSync(join(folder, "runs"), { recursive: true });
});

test("state survives close and reopen without the tracker document", async () => {
  const shared = fixture();
  configure("state.db", "empty");
  const first: Client.Client = await connect(shared.tracker);
  const run: Protocol.Run = await first.request("/runs", "POST", BEGIN);
  await first.request(`/runs/${run.id}/ready`, "POST", {});
  const claim: { accepted: boolean } = await first.request(
    `/runs/${run.id}/claim`,
    "POST",
    { key: "save-draft", goal: "Save persists" },
  );
  expect(claim.accepted).toBe(true);
  await first.close?.();
  shared.forbid();
  configure("state.db");
  const second: Client.Client = await connect(shared.tracker);
  const state: Protocol.State = await second.request("/state?project=sample");
  expect(state.flows).toEqual([
    expect.objectContaining({ key: "save-draft", run: run.id }),
  ]);
  await second.close?.();
  expect(shared.writes()).toBe(0);
});

test("first start imports the board document snapshot into QUAZ_DB", async () => {
  const shared = fixture();
  shared.seed(await snapshot(shared.tracker));
  const file: string = configure("state.db");
  const client: Client.Client = await connect(shared.tracker);
  expect((await client.request<Protocol.Run>(`/runs/${BEGIN.id}`)).id).toBe(
    BEGIN.id,
  );
  await client.close?.();
  const database: Database = new Database(file, { readonly: true });
  expect(
    database
      .query<{ value: string }, []>(
        "SELECT value FROM qa_meta WHERE key='authority'",
      )
      .get()?.value,
  ).toBe("local");
  database.close();
  expect(existsSync(`${file}.tmp`)).toBe(false);
  expect(await shared.tracker.document.claim("key", "next", 1)).not.toBeNull();
});

test("migrated database never calls the board document again", async () => {
  const shared = fixture();
  shared.seed(await snapshot(shared.tracker));
  configure("state.db");
  await (await connect(shared.tracker)).close?.();
  shared.forbid();
  const client: Client.Client = await connect(shared.tracker);
  expect((await client.request<Protocol.Run>(`/runs/${BEGIN.id}`)).id).toBe(
    BEGIN.id,
  );
  await client.close?.();
});

test("unmarked existing QUAZ_DB is backed up, not trusted", async () => {
  const shared = fixture();
  const file: string = configure("state.db", "empty");
  const stale: State.State = State.open(file, shared.tracker);
  await stale.begin(BEGIN);
  stale.db.close();
  const client: Client.Client = await connect(shared.tracker);
  await expect(client.request(`/runs/${BEGIN.id}`)).rejects.toThrow();
  await client.close?.();
  const backups: string[] = readdirSync(folder).filter((entry): boolean =>
    /^state\.db\.pre-local-\d+$/.test(entry),
  );
  expect(backups).toHaveLength(1);
  const backup: Database = new Database(join(folder, backups[0]), {
    readonly: true,
  });
  expect(
    backup.query("SELECT 1 FROM qa_runs WHERE id=?").get(BEGIN.id),
  ).not.toBeNull();
  backup.close();
});

test("invalid snapshot leaves no state file", async () => {
  const shared = fixture();
  shared.seed(Uint8Array.from([1, 2, 3, 4]));
  const file: string = configure("state.db");
  await expect(connect(shared.tracker)).rejects.toThrow(
    "snapshot is invalid or too large",
  );
  expect(existsSync(file)).toBe(false);
  expect(existsSync(`${file}.tmp`)).toBe(false);
  expect(await shared.tracker.document.claim("key", "next", 1)).not.toBeNull();
});

test("held board lease blocks migration", async () => {
  const shared = fixture();
  shared.hold();
  const file: string = configure("state.db", "empty");
  await expect(connect(shared.tracker)).rejects.toThrow(
    "Another Quaz controller",
  );
  expect(existsSync(file)).toBe(false);
  shared.free();
  await (await connect(shared.tracker)).close?.();
});

test("empty bootstrap refuses a board with existing QA cards", async () => {
  const shared = fixture();
  shared.tag("qa-run,project:sample");
  shared.tag("qa,project:other");
  const file: string = configure("state.db", "empty");
  const empty: Client.Client = await connect(shared.tracker);
  await empty.close?.();
  rmSync(file);
  shared.tag(ISSUE_TAGS);
  await expect(connect(shared.tracker)).rejects.toThrow(
    "already has 1 QA cards",
  );
  expect(existsSync(file)).toBe(false);
});

test("imports a file-backed WAL database", async () => {
  const shared = fixture();
  const file: string = configure("history.db", "import");
  legacy(file, shared.tracker, "test-import");
  const source: State.State = State.open(file, shared.tracker);
  await source.begin(BEGIN);
  source.db.close();
  chmodSync(file, 0o444);
  const first: Client.Client = await connect(shared.tracker);
  expect((await first.request<Protocol.Run>(`/runs/${BEGIN.id}`)).id).toBe(
    BEGIN.id,
  );
  await first.close?.();
  shared.forbid();
  configure("history.db");
  const second: Client.Client = await connect(shared.tracker);
  expect((await second.request<Protocol.Run>(`/runs/${BEGIN.id}`)).id).toBe(
    BEGIN.id,
  );
  await second.close?.();
});

test("import refuses an unrelated remote snapshot", async () => {
  const shared = fixture();
  shared.seed(await snapshot(shared.tracker, "remote-import"));
  const file: string = configure("import.db", "import");
  legacy(file, shared.tracker, "different-import");
  await expect(connect(shared.tracker)).rejects.toThrow(
    "does not match the requested legacy import",
  );
  expect(shared.writes()).toBe(0);
  expect(
    readdirSync(folder).some((entry): boolean => entry.includes("pre-local")),
  ).toBe(false);
});

test("empty authority needs an explicit bootstrap choice", async () => {
  configure("missing.db");
  await expect(connect(fixture().tracker)).rejects.toThrow(
    "Empty Quaz authority",
  );
});
