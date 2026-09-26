import { createHash } from "node:crypto";
import { z } from "zod";
import * as ErrorName from "@/error";
import type * as Tracker from "@/tracker";

const TIMEOUT_MS: number = 30_000;
const PAGE_SIZE: number = 100;
const MARKER_LENGTH: number = 32;
const marker = (key: string): string =>
  `[quaz:${createHash("sha256").update(key).digest("hex").slice(0, MARKER_LENGTH)}]`;
const cardSchema = z.object({
  id: z.number().int().positive(),
  board_id: z.number().int().positive(),
  version: z.number().int(),
  content: z.string(),
  description: z.string(),
  checklist: z.string(),
  tags: z.string(),
  status: z.number().int(),
});
const attachmentSchema = z.object({
  id: z.number().int().positive(),
  filename: z.string(),
});
const commentSchema = z.object({ body: z.string() });
const leaseSchema = z.object({
  version: z.number().int().nonnegative(),
  value: z.string(),
  fence: z.number().int().positive(),
  expires: z.number().int().positive(),
});
const asCard = (
  raw: z.infer<typeof cardSchema>,
  comments: string[],
): Tracker.Card => ({
  id: raw.id,
  version: raw.version,
  title: raw.content,
  description: raw.description,
  checklist: raw.checklist,
  tags: raw.tags,
  status: raw.status,
  comments,
});
const tags = (value: string): Set<string> =>
  new Set(
    value
      .split(",")
      .map((tag): string => tag.trim())
      .filter(Boolean),
  );
const sameTags = (left: Set<string>, right: Set<string>): boolean =>
  left.size === right.size && [...left].every((tag): boolean => right.has(tag));
const sameText = (left: string, right: string): boolean =>
  left.replaceAll("\r\n", "\n") === right.replaceAll("\r\n", "\n");
const applied = (
  before: Tracker.Card,
  after: Tracker.Card,
  changes: Tracker.Changes,
): boolean => {
  const expected: Set<string> = tags(changes.tags ?? before.tags);
  for (const tag of tags(changes.tagsAdd ?? "")) expected.add(tag);
  for (const tag of tags(changes.tagsRemove ?? "")) expected.delete(tag);

  return (
    after.version === before.version + 1 &&
    after.title === (changes.title ?? before.title) &&
    sameText(after.description, changes.description ?? before.description) &&
    after.checklist === (changes.checklist ?? before.checklist) &&
    sameTags(tags(after.tags), expected)
  );
};
const recovered = (operation: string, id: number): void => {
  console.error(
    JSON.stringify({ event: "tracker-write-recovered", operation, card: id }),
  );
};
const checkFailed = (operation: string, id: number, error: unknown): void => {
  console.error(
    JSON.stringify({
      event: "tracker-recovery-check-failed",
      operation,
      card: id,
      error: String(error),
    }),
  );
};
const operations: WeakMap<Response, { label: string; privateData: boolean }> =
  new WeakMap();
const send = async (
  operation: string,
  url: string,
  init: RequestInit,
  privateData: boolean = false,
): Promise<Response> => {
  try {
    const response: Response = await fetch(url, init);
    operations.set(response, { label: operation, privateData });
    return response;
  } catch (error: unknown) {
    throw new Error(
      `${operation} failed: ${ErrorName.describe(error, privateData)}`,
    );
  }
};
const read = async <T>(
  response: Response,
  parse: (response: Response) => Promise<T>,
): Promise<T> => {
  try {
    return await parse(response);
  } catch (error: unknown) {
    const operation = operations.get(response);
    throw new Error(
      `${operation?.label ?? "API response"} failed: ${ErrorName.describe(error, operation?.privateData)}`,
    );
  }
};
const json = async (response: Response): Promise<unknown> =>
  read(response, (value): Promise<unknown> => value.json());
const bytes = async (response: Response): Promise<ArrayBuffer> =>
  read(response, (value): Promise<ArrayBuffer> => value.arrayBuffer());

export const connect = (
  origin: string,
  board: string,
  token: string,
): Tracker.Authority => {
  const url: URL = new URL(origin);
  if (!token || !/^[\w-]+\/[\w-]+$/.test(board) || url.username || url.password)
    throw new Error("A board and API token are required");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Remote card API requires HTTPS");
  const endpoint: string = url.origin;
  let leaseHeader: string | undefined;
  const request = async (
    path: string,
    method: string = "GET",
    body?: BodyInit,
    key?: string,
  ): Promise<Response> => {
    const response: Response = await send(
      `Card API ${method} ${path}`,
      `${endpoint}/api${path}`,
      {
        method,
        body,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(key ? { "Idempotency-Key": key } : {}),
          ...(leaseHeader ? { "X-Board-Document-Lease": leaseHeader } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok)
      throw new Error(`Card API ${method} ${path} returned ${response.status}`);
    return response;
  };
  const comments = async (id: number): Promise<string[]> =>
    z
      .array(commentSchema)
      .parse(await json(await request(`/notes/${id}/comments`)))
      .map((entry): string => entry.body);
  let boardId: number | undefined;
  const selectedBoard = async (): Promise<number> => {
    if (boardId) return boardId;
    const response: Response = await request("/boards/destinations");
    const boards = z
      .array(
        z.object({
          id: z.number().int().positive(),
          workspace: z.string(),
          slug: z.string(),
        }),
      )
      .parse(await json(response));
    boardId = boards.find(
      (entry): boolean => `${entry.workspace}/${entry.slug}` === board,
    )?.id;
    if (!boardId) throw new Error("Selected board is not writable");
    return boardId;
  };
  const parseCard = async (response: Response): Promise<Tracker.Card> => {
    const card = cardSchema.parse(await json(response));
    if (card.board_id !== (await selectedBoard()))
      throw new Error(`Card ${card.id} moved outside the selected board`);
    return asCard(card, await comments(card.id));
  };
  const guard = async (id: number): Promise<void> => {
    if (!(await tracker.get(id)))
      throw new Error(`Card ${id} is unavailable on the selected board`);
  };
  const documentRequest = async (
    key: string,
    suffix: string,
    method: string,
    body?: unknown,
  ): Promise<Response> => {
    const response: Response = await send(
      `Board document ${method} /boards/${board}/documents/<key>${suffix}`,
      `${endpoint}/api/boards/${board}/documents/${encodeURIComponent(key)}${suffix}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      true,
    );
    if (!response.ok && response.status !== 409)
      throw new Error(`Board document ${method} returned ${response.status}`);

    return response;
  };
  const document: Tracker.Document = {
    claim: async (key, owner, ttlSeconds): Promise<Tracker.Lease | null> => {
      const response: Response = await documentRequest(key, "/lease", "POST", {
        owner,
        ttlSeconds,
      });
      if (response.status === 409) return null;
      const value = leaseSchema.parse(await json(response));

      return { ...value, value: Buffer.from(value.value, "base64") };
    },
    renew: async (key, owner, fence, ttlSeconds): Promise<number> => {
      const response: Response = await documentRequest(key, "/lease", "PUT", {
        owner,
        fence,
        ttlSeconds,
      });
      if (response.status === 409)
        throw new Error("Board document lease changed");
      const value = z
        .object({ expires: z.number().int().positive() })
        .parse(await json(response));

      return value.expires;
    },
    write: async (key, owner, fence, version, value): Promise<number> => {
      const response: Response = await documentRequest(key, "", "PUT", {
        owner,
        fence,
        version,
        value: Buffer.from(value).toString("base64"),
      });
      if (response.status === 409) throw new Error("Board document changed");
      const saved = z
        .object({ version: z.number().int().positive() })
        .parse(await json(response));

      return saved.version;
    },
    release: async (key, owner, fence): Promise<void> => {
      const response: Response = await documentRequest(
        key,
        "/lease",
        "DELETE",
        {
          owner,
          fence,
        },
      );
      if (response.status === 409)
        throw new Error("Board document lease changed");
    },
  };
  const tracker: Tracker.Authority = {
    bind: (key: string, owner: string, fence: number): void => {
      leaseHeader = JSON.stringify({ key, owner, fence });
    },
    list: async (): Promise<Tracker.Card[]> => {
      const selected: number = await selectedBoard();
      const cards: Tracker.Card[] = [];
      let after: number = 0;
      while (true) {
        const page = z
          .object({
            notes: z.array(cardSchema),
            nextCursor: z.number().int().nullable(),
          })
          .parse(
            await json(
              await request(
                `/boards/${board}/notes/search?status=active,completed,archived&after=${after}&limit=${PAGE_SIZE}`,
              ),
            ),
          );
        if (page.notes.some((raw): boolean => raw.board_id !== selected))
          throw new Error("Card search returned a card from another board");
        cards.push(
          ...(await Promise.all(
            page.notes.map(
              async (raw): Promise<Tracker.Card> =>
                asCard(raw, await comments(raw.id)),
            ),
          )),
        );
        if (page.nextCursor === null) return cards;
        after = page.nextCursor;
      }
    },
    get: async (id: number): Promise<Tracker.Card | null> => {
      const response: Response = await send(
        `Card API GET /notes/${id}`,
        `${endpoint}/api/notes/${id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(
          `Card API GET /notes/${id} returned ${response.status}`,
        );
      const card = cardSchema.parse(await json(response));
      if (card.board_id !== (await selectedBoard())) return null;
      return asCard(card, await comments(id));
    },
    create: async (title: string, key: string): Promise<Tracker.Card> => {
      const pendingTitle: string = `${title} ${marker(key)}`;
      const prior: Tracker.Card | null = await tracker.recover(key);
      if (prior) return prior;
      const form: FormData = new FormData();
      form.set("content", pendingTitle);

      return parseCard(
        await request(`/boards/${board}/notes`, "POST", form, key),
      );
    },
    recover: async (key: string): Promise<Tracker.Card | null> =>
      (await tracker.list()).find((card): boolean =>
        card.title.endsWith(marker(key)),
      ) ?? null,
    update: async (
      id: number,
      changes: Tracker.Changes,
    ): Promise<Tracker.Card> => {
      const before: Tracker.Card | null = await tracker.get(id);
      if (!before)
        throw new Error(`Card ${id} is unavailable on the selected board`);
      const form: FormData = new FormData();
      const fields: Record<string, string | undefined> = {
        content: changes.title,
        description: changes.description,
        checklist: changes.checklist,
        tags: changes.tags,
        tags_add: changes.tagsAdd,
        tags_remove: changes.tagsRemove,
      };
      for (const [key, value] of Object.entries(fields))
        if (value !== undefined) form.set(key, value);
      try {
        return await parseCard(await request(`/notes/${id}`, "PUT", form));
      } catch (error: unknown) {
        try {
          const current: Tracker.Card | null = await tracker.get(id);
          if (current && applied(before, current, changes)) {
            recovered("update", id);
            return current;
          }
        } catch (checkError: unknown) {
          checkFailed("update", id, checkError);
        }
        throw error;
      }
    },
    complete: async (id: number): Promise<void> => {
      await guard(id);
      await request(`/notes/${id}/complete`, "PUT");
    },
    reopen: async (id: number): Promise<void> => {
      const before: Tracker.Card | null = await tracker.get(id);
      if (!before)
        throw new Error(`Card ${id} is unavailable on the selected board`);
      try {
        await request(`/notes/${id}/complete`, "DELETE");
      } catch (error: unknown) {
        try {
          const current: Tracker.Card | null = await tracker.get(id);
          if (current?.status === 0 && current.version === before.version + 1) {
            recovered("reopen", id);
            return;
          }
        } catch (checkError: unknown) {
          checkFailed("reopen", id, checkError);
        }
        throw error;
      }
    },
    comment: async (id: number, body: string): Promise<void> => {
      await guard(id);
      const form: FormData = new FormData();
      form.set("body", body);
      await request(`/notes/${id}/comments`, "POST", form);
    },
    upload: async (
      id: number,
      path: string,
      bytes: Uint8Array,
      mime: string,
    ): Promise<Tracker.Attachment> => {
      await guard(id);
      const form: FormData = new FormData();
      form.set(
        "file",
        new File([Uint8Array.from(bytes)], path, { type: mime }),
      );
      const raw = attachmentSchema.parse(
        await json(await request(`/notes/${id}/attachments`, "POST", form)),
      );
      return { id: raw.id, name: raw.filename };
    },
    attachments: async (id: number): Promise<Tracker.Attachment[]> => {
      await guard(id);
      return z
        .array(attachmentSchema)
        .parse(await json(await request(`/notes/${id}/attachments`)))
        .map(
          (item): Tracker.Attachment => ({ id: item.id, name: item.filename }),
        );
    },
    download: async (id: number): Promise<Uint8Array> =>
      new Uint8Array(await bytes(await request(`/attachments/${id}`))),
    attachmentUrl: (id: number): string => `${endpoint}/api/attachments/${id}`,
    document,
  };
  return tracker;
};
