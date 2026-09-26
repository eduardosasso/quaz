import { afterEach, expect, test } from "bun:test";
import * as Overdew from "@/adapters/overdew";

const previous: typeof fetch = globalThis.fetch;
const previousError: typeof console.error = console.error;
afterEach((): void => {
  globalThis.fetch = previous;
  console.error = previousError;
});

test("moved card stays outside the selected board", async () => {
  let writes: number = 0;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url: string = String(input);
    if (url.endsWith("/boards/destinations"))
      return Response.json([{ id: 1, workspace: "owner", slug: "board" }]);
    if (url.includes("/notes/search"))
      return Response.json({ notes: [], nextCursor: null });
    if (url.endsWith("/notes/7"))
      return Response.json({
        id: 7,
        board_id: 2,
        version: 1,
        content: "Moved issue",
        description: "",
        checklist: "[]",
        tags: "qa",
        status: 0,
      });
    if (init?.method !== "GET") writes++;
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const tracker = Overdew.connect(
    "https://tracker.test",
    "owner/board",
    "token",
  );
  expect(await tracker.get(7)).toBeNull();
  await expect(tracker.update(7, { title: "Wrong board" })).rejects.toThrow(
    "unavailable on the selected board",
  );
  expect(writes).toBe(0);
});

test("timeout names the card and document request", async () => {
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as typeof fetch;
  const tracker = Overdew.connect(
    "https://tracker.test",
    "owner/board",
    "token",
  );
  await expect(tracker.get(7)).rejects.toThrow(
    "Card API GET /notes/7 failed: TimeoutError",
  );
  await expect(tracker.document.claim("state", "owner", 120)).rejects.toThrow(
    "Board document POST /boards/owner/board/documents/<key>/lease failed: TimeoutError",
  );
});

test("body timeout names the request and hides the document key", async () => {
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller): void => {
          controller.error(
            new DOMException("The operation timed out.", "TimeoutError"),
          );
        },
      }),
    )) as typeof fetch;
  const tracker = Overdew.connect(
    "https://tracker.test",
    "owner/board",
    "token",
  );
  await expect(tracker.get(7)).rejects.toThrow(
    "Card API GET /notes/7 failed: TimeoutError",
  );
  let message: string = "";
  try {
    await tracker.document.claim("private-user-text", "owner", 120);
  } catch (error: unknown) {
    message = String(error);
  }
  expect(message).toContain(
    "Board document POST /boards/owner/board/documents/<key>/lease failed: TimeoutError",
  );
  expect(message).not.toContain("private-user-text");
});

test("card metadata updates after creation", async () => {
  const calls: string[] = [];
  const card = {
    id: 8,
    board_id: 1,
    version: 1,
    content: "QA discover: sample",
    description: "",
    checklist: "[]",
    tags: "",
    status: 0,
  };
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url: string = String(input);
    const method: string = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url).pathname}`);
    if (url.endsWith("/boards/destinations"))
      return Response.json([{ id: 1, workspace: "owner", slug: "board" }]);
    if (url.includes("/notes/search"))
      return Response.json({ notes: [], nextCursor: null });
    if (url.endsWith("/notes/8/comments")) return Response.json([]);
    if (method === "POST" && url.endsWith("/boards/owner/board/notes"))
      return Response.json(card);
    if (method === "GET" && url.endsWith("/notes/8"))
      return Response.json(card);
    if (method === "PUT" && url.endsWith("/notes/8")) {
      expect(new Headers(init?.headers).get("X-Board-Document-Lease")).toBe(
        JSON.stringify({ key: "quaz-sample", owner: "owner", fence: 1 }),
      );
      if (!(init?.body instanceof FormData))
        throw new Error("Card update needs form data");
      card.description = String(init.body.get("description"));
      card.tags = String(init.body.get("tags"));
      card.version++;

      return Response.json(card);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  const tracker = Overdew.connect(
    "https://tracker.test",
    "owner/board",
    "token",
  );
  tracker.bind?.("quaz-sample", "owner", 1);
  const created = await tracker.create("QA discover: sample", "test-key");
  const updated = await tracker.update(created.id, {
    title: "QA discover: sample",
    description: "Run details",
    tags: "qa-run,project:sample",
  });
  expect(updated.description).toBe("Run details");
  expect(updated.tags).toBe("qa-run,project:sample");
  expect(calls).toContain("PUT /api/notes/8");
});

test("lost create response reuses the pending card", async () => {
  const cards: Array<{
    id: number;
    board_id: number;
    version: number;
    content: string;
    description: string;
    checklist: string;
    tags: string;
    status: number;
  }> = [];
  let posts: number = 0;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url: string = String(input);
    const method: string = init?.method ?? "GET";
    if (url.endsWith("/boards/destinations"))
      return Response.json([{ id: 1, workspace: "owner", slug: "board" }]);
    if (url.includes("/notes/search"))
      return Response.json({ notes: cards, nextCursor: null });
    if (url.endsWith("/notes/8/comments")) return Response.json([]);
    if (method === "POST" && url.endsWith("/boards/owner/board/notes")) {
      if (!(init?.body instanceof FormData))
        throw new Error("Card creation needs form data");
      posts += 1;
      cards.push({
        id: 8,
        board_id: 1,
        version: 1,
        content: String(init.body.get("content")),
        description: "",
        checklist: "[]",
        tags: "",
        status: 0,
      });
      throw new Error("response lost");
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  const tracker = Overdew.connect(
    "https://tracker.test",
    "owner/board",
    "token",
  );
  await expect(tracker.create("Lost save", "save-key")).rejects.toThrow(
    "response lost",
  );
  const recovered = await tracker.create("Renamed save", "save-key");
  expect(recovered.id).toBe(8);
  expect(recovered.title).toContain("[quaz:");
  expect(posts).toBe(1);
});

test("lost update and reopen responses recover observed writes", async () => {
  const logs: string[] = [];
  console.error = (message: unknown): void => {
    logs.push(String(message));
  };
  const card = {
    id: 8,
    board_id: 1,
    version: 1,
    content: "Issue",
    description: "Broken",
    checklist: "[]",
    tags: "qa,needs-verification",
    status: 1,
  };
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url: string = String(input);
    const method: string = init?.method ?? "GET";
    if (url.endsWith("/boards/destinations"))
      return Response.json([{ id: 1, workspace: "owner", slug: "board" }]);
    if (url.endsWith("/notes/8/comments")) return Response.json([]);
    if (method === "GET" && url.endsWith("/notes/8"))
      return Response.json(card);
    if (method === "PUT" && url.endsWith("/notes/8")) {
      card.version += 1;
      card.tags = "qa,verified";
      throw new Error("update response lost");
    }
    if (method === "DELETE" && url.endsWith("/notes/8/complete")) {
      card.version += 1;
      card.status = 0;
      throw new Error("reopen response lost");
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  const tracker = Overdew.connect(
    "https://tracker.test",
    "owner/board",
    "token",
  );
  const updated = await tracker.update(8, {
    tagsAdd: "verified",
    tagsRemove: "needs-verification",
  });
  expect(updated.version).toBe(2);
  await tracker.reopen(8);
  expect(card.status).toBe(0);
  expect(logs.map((line): string => JSON.parse(line).operation)).toEqual([
    "update",
    "reopen",
  ]);
});

test("board document lease and snapshot use the generic API", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url: URL = new URL(String(input));
    const method: string = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer token",
    );
    if (method === "POST" && url.pathname.endsWith("/lease"))
      return Response.json({
        version: 0,
        value: "",
        fence: 1,
        expires: Date.now() + 60_000,
      });
    if (method === "PUT" && url.pathname.endsWith("/lease"))
      return Response.json({ expires: Date.now() + 60_000 });
    if (method === "DELETE" && url.pathname.endsWith("/lease"))
      return new Response(null, { status: 204 });
    if (method === "PUT" && url.pathname.endsWith("/quaz-sample")) {
      const body = JSON.parse(String(init?.body)) as {
        value: string;
        version: number;
      };
      expect(body.value).toBe(Buffer.from("snapshot").toString("base64"));
      expect(body.version).toBe(0);

      return Response.json({ version: 1 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  const tracker = Overdew.connect(
    "https://tracker.test",
    "owner/board",
    "token",
  );
  const owner: string = crypto.randomUUID();
  const lease = await tracker.document.claim("quaz-sample", owner, 60);
  expect(lease?.version).toBe(0);
  expect(
    await tracker.document.renew("quaz-sample", owner, lease?.fence ?? 0, 60),
  ).toBeGreaterThan(Date.now());
  expect(
    await tracker.document.write(
      "quaz-sample",
      owner,
      lease?.fence ?? 0,
      0,
      new TextEncoder().encode("snapshot"),
    ),
  ).toBe(1);
  await tracker.document.release("quaz-sample", owner, lease?.fence ?? 0);
  expect(calls).toEqual([
    "POST /api/boards/owner/board/documents/quaz-sample/lease",
    "PUT /api/boards/owner/board/documents/quaz-sample/lease",
    "PUT /api/boards/owner/board/documents/quaz-sample",
    "DELETE /api/boards/owner/board/documents/quaz-sample/lease",
  ]);
});
