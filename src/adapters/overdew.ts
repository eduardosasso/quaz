import { z } from "zod";
import type * as Tracker from "@/tracker";

const TIMEOUT_MS: number = 30_000;
const PAGE_SIZE: number = 100;
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

export const connect = (
  origin: string,
  board: string,
  token: string,
): Tracker.Tracker => {
  const url: URL = new URL(origin);
  if (!token || !/^[\w-]+\/[\w-]+$/.test(board) || url.username || url.password)
    throw new Error("A board and API token are required");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Remote card API requires HTTPS");
  const endpoint: string = url.origin;
  const request = async (
    path: string,
    method: string = "GET",
    body?: BodyInit,
    key?: string,
  ): Promise<Response> => {
    const response: Response = await fetch(`${endpoint}/api${path}`, {
      method,
      body,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Card API ${method} ${path} returned ${response.status}`);
    return response;
  };
  const comments = async (id: number): Promise<string[]> =>
    z
      .array(commentSchema)
      .parse(await (await request(`/notes/${id}/comments`)).json())
      .map((entry): string => entry.body);
  let boardId: number | undefined;
  const selectedBoard = async (): Promise<number> => {
    if (boardId) return boardId;
    const response: Response = await request(
      `/boards/${board}/notes/search?limit=1`,
    );
    boardId = z
      .object({ boardId: z.number().int().positive() })
      .parse(await response.json()).boardId;
    return boardId;
  };
  const parseCard = async (response: Response): Promise<Tracker.Card> => {
    const card = cardSchema.parse(await response.json());
    if (card.board_id !== (await selectedBoard()))
      throw new Error(`Card ${card.id} moved outside the selected board`);
    return asCard(card, await comments(card.id));
  };
  const guard = async (id: number): Promise<void> => {
    if (!(await tracker.get(id)))
      throw new Error(`Card ${id} is unavailable on the selected board`);
  };
  const tracker: Tracker.Tracker = {
    list: async (): Promise<Tracker.Card[]> => {
      const cards: Tracker.Card[] = [];
      let after: number = 0;
      while (true) {
        const page = z
          .object({
            notes: z.array(cardSchema),
            nextCursor: z.number().int().nullable(),
            boardId: z.number().int().positive(),
          })
          .parse(
            await (
              await request(
                `/boards/${board}/notes/search?status=active,completed,archived&after=${after}&limit=${PAGE_SIZE}`,
              )
            ).json(),
          );
        boardId = page.boardId;
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
      const response: Response = await fetch(`${endpoint}/api/notes/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(
          `Card API GET /notes/${id} returned ${response.status}`,
        );
      const card = cardSchema.parse(await response.json());
      if (card.board_id !== (await selectedBoard())) return null;
      return asCard(card, await comments(id));
    },
    create: async (
      title: string,
      changes: Tracker.Changes,
      key: string,
    ): Promise<Tracker.Card> => {
      const form: FormData = new FormData();
      form.set("content", title);
      for (const [field, value] of Object.entries({
        description: changes.description,
        checklist: changes.checklist,
        tags: changes.tags,
      }))
        if (value !== undefined) form.set(field, value);
      return parseCard(
        await request(`/boards/${board}/notes`, "POST", form, key),
      );
    },
    update: async (
      id: number,
      changes: Tracker.Changes,
    ): Promise<Tracker.Card> => {
      await guard(id);
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
      return parseCard(await request(`/notes/${id}`, "PUT", form));
    },
    complete: async (id: number): Promise<void> => {
      await guard(id);
      await request(`/notes/${id}/complete`, "PUT");
    },
    reopen: async (id: number): Promise<void> => {
      await guard(id);
      await request(`/notes/${id}/complete`, "DELETE");
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
        await (await request(`/notes/${id}/attachments`, "POST", form)).json(),
      );
      return { id: raw.id, name: raw.filename };
    },
    attachments: async (id: number): Promise<Tracker.Attachment[]> => {
      await guard(id);
      return z
        .array(attachmentSchema)
        .parse(await (await request(`/notes/${id}/attachments`)).json())
        .map(
          (item): Tracker.Attachment => ({ id: item.id, name: item.filename }),
        );
    },
    download: async (id: number): Promise<Uint8Array> =>
      new Uint8Array(await (await request(`/attachments/${id}`)).arrayBuffer()),
    attachmentUrl: (id: number): string => `${endpoint}/api/attachments/${id}`,
  };
  return tracker;
};
