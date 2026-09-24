import { afterEach, expect, test } from "bun:test";
import * as Overdew from "@/adapters/overdew";

const previous: typeof fetch = globalThis.fetch;
afterEach((): void => {
  globalThis.fetch = previous;
});

test("moved card stays outside the selected board", async () => {
  let writes: number = 0;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url: string = String(input);
    if (url.includes("/notes/search"))
      return Response.json({ boardId: 1, notes: [], nextCursor: null });
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
