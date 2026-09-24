import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import * as Adapter from "@/adapters/overdew";
import * as Finish from "@/finish";
import * as Protocol from "@/qa_protocol";
import * as State from "@/state";

const ROOT: string = resolve(import.meta.dir, "../..");
const PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,220}$/;
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export type Client = {
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  upload: (
    run: string,
    path: string,
    bytes: Uint8Array,
    mime: string,
  ) => Promise<number>;
  comments: (note: number) => Promise<string[]>;
};
export const connect = (url: string, board: string, token: string): Client => {
  const file: string =
    process.env.QUAZ_DB ?? join(ROOT, "artifacts/qa/state.db");
  mkdirSync(dirname(file), { recursive: true });
  const state: State.State = State.open(
    file,
    Adapter.connect(url, board, token),
  );
  state.db.exec(
    "CREATE TABLE IF NOT EXISTS qa_destination (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
  );
  const destination: string = `${new URL(url).origin}/${board}`;
  const prior = state.db
    .query<{ value: string }, []>("SELECT value FROM qa_destination WHERE id=1")
    .get();
  if (prior && prior.value !== destination)
    throw new Error("Use a separate Quaz database for another tracking board");
  if (!prior)
    state.db
      .query("INSERT INTO qa_destination (id,value) VALUES (1,?)")
      .run(destination);
  const request = async <T>(
    path: string,
    method: string = "GET",
    body?: unknown,
  ): Promise<T> => {
    const target: URL = new URL(path, "http://quaz.local");
    const run = /^\/runs\/([^/]+)$/.exec(target.pathname);
    const ready = /^\/runs\/([^/]+)\/ready$/.exec(target.pathname);
    const claim = /^\/runs\/([^/]+)\/claim$/.exec(target.pathname);
    const publication = /^\/runs\/([^/]+)\/publication$/.exec(target.pathname);
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
      throw new Error(`Unsupported Quaz request: ${method} ${target.pathname}`);
    return result as T;
  };
  const upload = async (
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
  const comments = async (note: number): Promise<string[]> =>
    (await state.tracker.get(note))?.comments ?? [];
  return { request, upload, comments };
};
