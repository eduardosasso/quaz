import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import * as Adapter from "@/adapters/overdew";
import * as Finish from "@/finish";
import * as Storage from "@/local_storage_native";
import * as Migrate from "@/migrate";
import * as Protocol from "@/qa_protocol";
import * as State from "@/state";
import * as Tracker from "@/tracker";

const ROOT: string = resolve(import.meta.dir, "../..");
const PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,220}$/;
const LEASE_SECONDS: number = 120;
const DOCUMENT_ID_LENGTH: number = 48;
const SNAPSHOT_BYTES: number = 64 * 1024 * 1024;
const LOCK_MODE: number = 0o600;
const AUTHORITY_KEY: string = "authority";
const AUTHORITY_LOCAL: string = "local";
const SIDECARS: string[] = ["-wal", "-shm"];
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const importMarker = (database: Database): string | null => {
  if (
    !database
      .query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_import'",
      )
      .get()
  )
    return null;

  return (
    database
      .query<{ marker: string }, []>("SELECT marker FROM qa_import WHERE id=1")
      .get()?.marker ?? null
  );
};
const local = (file: string): boolean => {
  if (!existsSync(file)) return false;
  const database: Database = new Database(file, { readonly: true });
  try {
    if (
      !database
        .query(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_meta'",
        )
        .get()
    )
      return false;

    return Boolean(
      database
        .query<{ value: string }, [string]>(
          "SELECT value FROM qa_meta WHERE key=?",
        )
        .get(AUTHORITY_KEY)?.value === AUTHORITY_LOCAL,
    );
  } finally {
    database.close();
  }
};
const flush = (path: string): void => {
  const descriptor: number = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};
const lock = (path: string): number => {
  const descriptor: number = openSync(path, "a", LOCK_MODE);
  let held: boolean = false;
  try {
    held = Storage.tryExclusiveLock(descriptor);
  } finally {
    if (!held) closeSync(descriptor);
  }
  if (!held)
    throw new Error(`Another process owns the Quaz state database ${path}`);

  return descriptor;
};
const destination = (database: Database, url: string, board: string): void => {
  database.exec(
    "CREATE TABLE IF NOT EXISTS qa_destination (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
  );
  const target: string = `${new URL(url).origin}/${board}`;
  const prior = database
    .query<{ value: string }, []>("SELECT value FROM qa_destination WHERE id=1")
    .get();
  if (prior && prior.value !== target)
    throw new Error("Use a separate Quaz database for another tracking board");
  if (!prior)
    database
      .query("INSERT INTO qa_destination (id,value) VALUES (1,?)")
      .run(target);
};
const claim = async (
  adapter: Tracker.Authority,
  key: string,
  owner: string,
): Promise<Tracker.Lease> => {
  let lease: Tracker.Lease | null;
  try {
    lease = await adapter.document.claim(key, owner, LEASE_SECONDS);
  } catch (error: unknown) {
    console.error(
      JSON.stringify({ event: "quaz-lease-claim-retry", error: String(error) }),
    );
    lease = await adapter.document.claim(key, owner, LEASE_SECONDS);
  }
  if (!lease)
    throw new Error("Another Quaz controller owns this board and project");

  return lease;
};
type Seed = { bytes: Uint8Array; source: "board" | "import" | "empty" };
const seed = (lease: Tracker.Lease, file: string): Seed => {
  if (lease.value.byteLength) {
    try {
      return {
        bytes: gunzipSync(lease.value, { maxOutputLength: SNAPSHOT_BYTES }),
        source: "board",
      };
    } catch (error: unknown) {
      throw new Error("Quaz authority snapshot is invalid or too large", {
        cause: error,
      });
    }
  }
  if (process.env.QUAZ_BOOTSTRAP === "import" && existsSync(file)) {
    const source: Database = new Database(file, { readonly: true });
    try {
      if (!importMarker(source))
        throw new Error("QUAZ_DB needs the Quaz legacy import marker");
      const bytes: Uint8Array = source.serialize();
      if (bytes.byteLength > SNAPSHOT_BYTES)
        throw new Error("Quaz authority snapshot is too large");

      return { bytes, source: "import" };
    } finally {
      source.close();
    }
  }
  if (process.env.QUAZ_BOOTSTRAP !== "empty")
    throw new Error(
      "Empty Quaz authority requires QUAZ_BOOTSTRAP=empty or QUAZ_BOOTSTRAP=import with an existing QUAZ_DB",
    );

  return { bytes: new Uint8Array(), source: "empty" };
};
const verify = (
  lease: Tracker.Lease,
  bytes: Uint8Array,
  file: string,
): void => {
  if (process.env.QUAZ_BOOTSTRAP !== "import" || !lease.value.byteLength)
    return;
  if (!existsSync(file)) throw new Error("QUAZ_DB import file is missing");
  const source: Database = new Database(file, { readonly: true });
  const remote: Database = Database.deserialize(bytes);
  try {
    const expected: string | null = importMarker(source);
    if (!expected || importMarker(remote) !== expected)
      throw new Error(
        "Remote Quaz state does not match the requested legacy import",
      );
  } finally {
    source.close();
    remote.close();
  }
};
const refuse = async (
  adapter: Tracker.Authority,
  project: string,
): Promise<void> => {
  const cards: Tracker.Card[] = (await adapter.list(Tracker.STATUSES)).filter(
    (card): boolean => {
      const labels: Set<string> = State.tags(card.tags);

      return labels.has(Protocol.TAG.issue) && labels.has(`project:${project}`);
    },
  );
  if (cards.length)
    throw new Error(
      `The board already has ${cards.length} QA cards for project ${project}. An empty Quaz database would duplicate them; import the existing state instead`,
    );
};
const migrate = async (
  adapter: Tracker.Authority,
  url: string,
  board: string,
  project: string,
  file: string,
): Promise<void> => {
  const key: string = `quaz-${digest(project).slice(0, DOCUMENT_ID_LENGTH)}`;
  const owner: string = randomUUID();
  const lease: Tracker.Lease = await claim(adapter, key, owner);
  const staged: string = `${file}.tmp`;
  let backup: string | null = null;
  let event: { source: string; bytes: number };
  try {
    const { bytes, source } = seed(lease, file);
    verify(lease, bytes, file);
    if (source === "empty") await refuse(adapter, project);
    for (const suffix of ["", ...SIDECARS])
      rmSync(`${staged}${suffix}`, { force: true });
    writeFileSync(staged, bytes, { mode: LOCK_MODE });
    const database: Database = new Database(staged);
    try {
      State.prepare(database);
      destination(database, url, board);
      database
        .query("INSERT OR REPLACE INTO qa_meta (key,value) VALUES (?,?)")
        .run(AUTHORITY_KEY, AUTHORITY_LOCAL);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
    flush(staged);
    if (existsSync(file) && source !== "import") {
      backup = `${file}.pre-local-${Date.now()}`;
      for (const suffix of ["", ...SIDECARS])
        if (existsSync(`${file}${suffix}`))
          renameSync(`${file}${suffix}`, `${backup}${suffix}`);
    }
    for (const suffix of SIDECARS) rmSync(`${file}${suffix}`, { force: true });
    renameSync(staged, file);
    flush(dirname(file));
    event = { source, bytes: bytes.byteLength };
  } catch (error: unknown) {
    for (const suffix of ["", ...SIDECARS])
      rmSync(`${staged}${suffix}`, { force: true });
    throw error;
  } finally {
    try {
      await adapter.document.release(key, owner, lease.fence);
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          event: "quaz-lease-release-failed",
          error: String(error),
        }),
      );
    }
  }
  console.error(
    JSON.stringify({ event: "quaz-state-migrated", ...event, backup }),
  );
};

export type Client = {
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  upload: (
    run: string,
    path: string,
    bytes: Uint8Array,
    mime: string,
  ) => Promise<number>;
  comments: (note: number) => Promise<string[]>;
  prune?: (days: number) => Promise<string[]>;
  close?: () => Promise<void>;
};
export const open = async (
  url: string,
  board: string,
  token: string,
  project: string,
  authority?: Tracker.Authority,
): Promise<Client> => {
  const selected: string = Protocol.key.parse(project);
  const file: string =
    process.env.QUAZ_DB ?? join(ROOT, "artifacts/qa/state.db");
  mkdirSync(dirname(file), { recursive: true });
  const adapter: Tracker.Authority =
    authority ?? Adapter.connect(url, board, token);
  const held: number = lock(`${file}.lock`);
  let database: Database | null = null;
  try {
    if (!local(file)) await migrate(adapter, url, board, selected, file);
    database = new Database(file);
    const state: State.State = State.open(
      database,
      adapter,
      join(dirname(file), State.ARTIFACTS),
    );
    destination(state.db, url, board);
    await Migrate.records(state.db, adapter);
    let queue: Promise<void> = Promise.resolve();
    const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
      const current: Promise<T> = queue.then(action);
      queue = current.then(
        (): void => {},
        (error: unknown): void => {
          console.error(
            JSON.stringify({ event: "quaz-state-error", error: String(error) }),
          );
        },
      );

      return current;
    };
    const requestRaw = async <T>(
      path: string,
      method: string = "GET",
      body?: unknown,
    ): Promise<T> => {
      const target: URL = new URL(path, "http://quaz.local");
      const run = /^\/runs\/([^/]+)$/.exec(target.pathname);
      const ready = /^\/runs\/([^/]+)\/ready$/.exec(target.pathname);
      const claim = /^\/runs\/([^/]+)\/claim$/.exec(target.pathname);
      const publication = /^\/runs\/([^/]+)\/publication$/.exec(
        target.pathname,
      );
      const finish = /^\/runs\/([^/]+)\/finish$/.exec(target.pathname);
      const fix = /^\/cards\/(\d+)\/fix$/.exec(target.pathname);
      let result: unknown;
      if (method === "GET" && target.pathname === "/state")
        result = await state.state(
          Protocol.key.parse(target.searchParams.get("project")),
          Protocol.revision
            .optional()
            .parse(target.searchParams.get("revision") ?? undefined),
        );
      else if (method === "GET" && target.pathname === "/catalog")
        result = await state.catalog(
          Protocol.key.parse(target.searchParams.get("project")),
        );
      else if (method === "POST" && target.pathname === "/runs")
        result = await state.begin(Protocol.begin.parse(body));
      else if (method === "POST" && ready) result = state.ready(ready[1]);
      else if (method === "POST" && claim) {
        const input = z
          .object({
            key: Protocol.key,
            goal: z.string().min(1).max(500),
            ticket: z.number().int().positive().optional(),
          })
          .strict()
          .parse(body);
        result = {
          accepted: await state.claim(
            claim[1],
            input.key,
            input.goal,
            input.ticket,
          ),
        };
      } else if (method === "POST" && publication)
        result = await state.publication(publication[1]);
      else if (method === "PUT" && fix) {
        const input = z
          .object({ revision: Protocol.revision })
          .strict()
          .parse(body);
        await state.fix(Number(fix[1]), input.revision);
        result = { revision: input.revision };
      } else if (method === "POST" && finish)
        result = await Finish.publish(
          state,
          finish[1],
          Protocol.finish.parse(body),
        );
      else if (method === "GET" && run) result = state.run(run[1]);
      else
        throw new Error(
          `Unsupported Quaz request: ${method} ${target.pathname}`,
        );
      return result as T;
    };
    const uploadRaw = async (
      run: string,
      path: string,
      bytes: Uint8Array,
      mime: string,
    ): Promise<number> => {
      if (!PATH.test(path) || path.split("/").includes(".."))
        throw new Error("Invalid QA artifact path");
      if (bytes.byteLength > Protocol.MAX_BYTES)
        throw new Error("QA artifact is too large");
      state.active(run);

      return state.store(run, path, bytes, mime);
    };
    const request = <T>(
      path: string,
      method: string = "GET",
      body?: unknown,
    ): Promise<T> =>
      exclusive((): Promise<T> => requestRaw<T>(path, method, body));
    const upload = (
      run: string,
      path: string,
      bytes: Uint8Array,
      mime: string,
    ): Promise<number> =>
      exclusive((): Promise<number> => uploadRaw(run, path, bytes, mime));
    const comments = async (note: number): Promise<string[]> =>
      (await state.tracker.get(note))?.comments ?? [];
    const close = async (): Promise<void> => {
      await queue;
      try {
        state.db.close();
      } finally {
        closeSync(held);
      }
    };

    const prune = (days: number): Promise<string[]> =>
      exclusive((): Promise<string[]> => Promise.resolve(state.prune(days)));

    return { request, upload, comments, prune, close };
  } catch (error: unknown) {
    try {
      database?.close();
    } finally {
      closeSync(held);
    }
    throw error;
  }
};
