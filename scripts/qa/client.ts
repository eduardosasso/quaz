import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import * as Adapter from "@/adapters/overdew";
import * as Finish from "@/finish";
import * as Protocol from "@/qa_protocol";
import * as State from "@/state";
import type * as Tracker from "@/tracker";

const ROOT: string = resolve(import.meta.dir, "../..");
const PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,220}$/;
const LEASE_SECONDS: number = 120;
const LEASE_RENEW_MS: number = 30_000;
const DOCUMENT_ID_LENGTH: number = 48;
const SNAPSHOT_BYTES: number = 64 * 1024 * 1024;
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

export type Client = {
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  upload: (
    run: string,
    path: string,
    bytes: Uint8Array,
    mime: string,
  ) => Promise<number>;
  comments: (note: number) => Promise<string[]>;
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
  const key: string = `quaz-${createHash("sha256").update(selected).digest("hex").slice(0, DOCUMENT_ID_LENGTH)}`;
  const owner: string = randomUUID();
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
  adapter.bind?.(key, owner, lease.fence);
  let timer: ReturnType<typeof setInterval> | null = null;
  let database: Database | null = null;
  const temporary: string = mkdtempSync(join(tmpdir(), "quaz-state-"));
  try {
    const fence: number = lease.fence;
    let version: number = lease.version;
    let lost: boolean = false;
    let checkpoint: (() => Promise<void>) | null = null;
    const ensure = async (): Promise<void> => {
      if (lost) throw new Error("Quaz board lease is lost");
      try {
        await adapter.document.renew(key, owner, fence, LEASE_SECONDS);
      } catch (error: unknown) {
        lost = true;
        throw error;
      }
    };
    const beforeWrite = async (): Promise<void> => {
      await ensure();
      if (!checkpoint) throw new Error("Quaz state checkpoint is unavailable");
      await checkpoint();
      await ensure();
    };
    const tracker: Tracker.Tracker = {
      ...adapter,
      create: async (
        title: string,
        idempotency: string,
      ): Promise<Tracker.Card> => {
        await beforeWrite();

        return adapter.create(title, idempotency);
      },
      update: async (
        id: number,
        changes: Tracker.Changes,
      ): Promise<Tracker.Card> => {
        await beforeWrite();

        return adapter.update(id, changes);
      },
      complete: async (id: number): Promise<void> => {
        await beforeWrite();
        await adapter.complete(id);
      },
      reopen: async (id: number): Promise<void> => {
        await beforeWrite();
        await adapter.reopen(id);
      },
      comment: async (id: number, body: string): Promise<void> => {
        await beforeWrite();
        await adapter.comment(id, body);
      },
      upload: async (
        id: number,
        path: string,
        bytes: Uint8Array,
        mime: string,
      ): Promise<Tracker.Attachment> => {
        await beforeWrite();

        return adapter.upload(id, path, bytes, mime);
      },
    };
    const snapshot: string = join(temporary, "state.db");
    let original: Uint8Array | null = null;
    if (lease.value.byteLength) {
      let bytes: Uint8Array;
      try {
        bytes = gunzipSync(lease.value, { maxOutputLength: SNAPSHOT_BYTES });
      } catch (error: unknown) {
        throw new Error("Quaz authority snapshot is invalid or too large", {
          cause: error,
        });
      }
      original = bytes;
      writeFileSync(snapshot, bytes, { mode: 0o600 });
    } else if (process.env.QUAZ_BOOTSTRAP === "import" && existsSync(file)) {
      const source: Database = new Database(file, { readonly: true });
      try {
        if (!importMarker(source))
          throw new Error("QUAZ_DB needs the Quaz legacy import marker");
        const bytes: Uint8Array = source.serialize();
        if (bytes.byteLength > SNAPSHOT_BYTES)
          throw new Error("Quaz authority snapshot is too large");
        writeFileSync(snapshot, bytes, { mode: 0o600 });
      } finally {
        source.close();
      }
    } else if (process.env.QUAZ_BOOTSTRAP !== "empty")
      throw new Error(
        "Empty Quaz authority requires QUAZ_BOOTSTRAP=empty or QUAZ_BOOTSTRAP=import with an existing QUAZ_DB",
      );
    database = new Database(snapshot, { create: true });
    if (process.env.QUAZ_BOOTSTRAP === "import" && lease.value.byteLength) {
      if (!existsSync(file)) throw new Error("QUAZ_DB import file is missing");
      const source: Database = new Database(file, { readonly: true });
      try {
        const expected: string | null = importMarker(source);
        if (!expected || importMarker(database) !== expected)
          throw new Error(
            "Remote Quaz state does not match the requested legacy import",
          );
      } finally {
        source.close();
      }
    }
    const state: State.State = State.open(database, tracker);
    state.db.exec(
      "CREATE TABLE IF NOT EXISTS qa_destination (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    const destination: string = `${new URL(url).origin}/${board}`;
    const prior = state.db
      .query<{ value: string }, []>(
        "SELECT value FROM qa_destination WHERE id=1",
      )
      .get();
    if (prior && prior.value !== destination)
      throw new Error(
        "Use a separate Quaz database for another tracking board",
      );
    if (!prior)
      state.db
        .query("INSERT INTO qa_destination (id,value) VALUES (1,?)")
        .run(destination);
    let lastDigest: string = original
      ? createHash("sha256").update(original).digest("hex")
      : "";
    const save = async (): Promise<void> => {
      if (lost) throw new Error("Quaz board lease is lost");
      const snapshot: Uint8Array = state.db.serialize();
      if (snapshot.byteLength > SNAPSHOT_BYTES)
        throw new Error("Quaz authority snapshot is too large");
      const currentDigest: string = createHash("sha256")
        .update(snapshot)
        .digest("hex");
      if (currentDigest === lastDigest) return;
      const bytes: Uint8Array = gzipSync(snapshot);
      try {
        version = await adapter.document.write(
          key,
          owner,
          fence,
          version,
          bytes,
        );
        lastDigest = currentDigest;
      } catch (error: unknown) {
        lost = true;
        throw error;
      }
    };
    checkpoint = save;
    if (!lease.value.byteLength) await save();
    timer = setInterval((): void => {
      void ensure().catch((error: unknown): void => {
        console.error(
          JSON.stringify({ event: "quaz-lease-lost", error: String(error) }),
        );
      });
    }, LEASE_RENEW_MS);
    timer.unref?.();
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
      const value: Protocol.Run = state.active(run);
      const hash: string = createHash("sha256").update(bytes).digest("hex");
      const prior = state.db
        .query<
          { digest: string; mime: string; attachment: number },
          [string, string]
        >(
          "SELECT digest,mime,attachment FROM qa_artifacts WHERE run=? AND path=?",
        )
        .get(run, path);
      if (prior) {
        if (prior.digest !== hash || prior.mime !== mime)
          throw new Error("Artifact path has different content");
        return prior.attachment;
      }
      const extension: string = path.includes(".")
        ? `.${path.split(".").at(-1)}`
        : "";
      const name: string = `quaz-${digest(`${run}:${path}:${hash}:${mime}`).slice(0, 32)}${extension}`;
      const existing = (await state.tracker.attachments(value.note_id)).find(
        (entry): boolean => entry.name === name,
      );
      const attachment: number =
        existing?.id ??
        (await state.tracker.upload(value.note_id, name, bytes, mime)).id;
      state.db
        .query(
          "INSERT OR IGNORE INTO qa_artifacts (run,path,digest,mime,attachment) VALUES (?,?,?,?,?)",
        )
        .run(run, path, hash, mime, attachment);
      return attachment;
    };
    const persisted = async <T>(action: () => Promise<T>): Promise<T> => {
      let result: T;
      try {
        result = await action();
      } catch (error: unknown) {
        if (!lost) {
          try {
            await save();
          } catch (snapshot: unknown) {
            throw new AggregateError(
              [error, snapshot],
              "Quaz action and state save failed",
            );
          }
        }
        throw error;
      }
      await save();

      return result;
    };
    const request = <T>(
      path: string,
      method: string = "GET",
      body?: unknown,
    ): Promise<T> =>
      exclusive(
        (): Promise<T> =>
          persisted((): Promise<T> => requestRaw<T>(path, method, body)),
      );
    const upload = (
      run: string,
      path: string,
      bytes: Uint8Array,
      mime: string,
    ): Promise<number> =>
      exclusive(
        (): Promise<number> =>
          persisted((): Promise<number> => uploadRaw(run, path, bytes, mime)),
      );
    const comments = async (note: number): Promise<string[]> =>
      (await state.tracker.get(note))?.comments ?? [];
    const close = async (): Promise<void> => {
      if (timer) clearInterval(timer);
      await queue;
      try {
        await adapter.document.release(key, owner, fence);
      } catch (error: unknown) {
        console.error(
          JSON.stringify({
            event: "quaz-lease-release-failed",
            error: String(error),
          }),
        );
      }
      state.db.close();
      rmSync(temporary, { recursive: true, force: true });
    };

    return { request, upload, comments, close };
  } catch (error: unknown) {
    if (timer) clearInterval(timer);
    database?.close();
    rmSync(temporary, { recursive: true, force: true });
    try {
      await adapter.document.release(key, owner, lease.fence);
    } catch (releaseError: unknown) {
      console.error(
        JSON.stringify({
          event: "quaz-lease-release-failed",
          error: String(releaseError),
        }),
      );
    }
    throw error;
  }
};
