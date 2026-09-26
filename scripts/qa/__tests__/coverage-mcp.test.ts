import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as Bridge from "@qa/coverage";
import * as Coverage from "@qa/coverage-mcp";

test("bridge timeout names the request", async (): Promise<void> => {
  const url: string | undefined = process.env.QA_BRIDGE_URL;
  const token: string | undefined = process.env.QA_BRIDGE_TOKEN;
  const disposable: string | undefined = process.env.QA_DISPOSABLE;
  const fetcher: typeof fetch = globalThis.fetch;
  try {
    process.env.QA_BRIDGE_URL = "http://127.0.0.1";
    process.env.QA_BRIDGE_TOKEN = "token";
    process.env.QA_DISPOSABLE = "1";
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    await expect(Bridge.catalog()).rejects.toThrow(
      "QA coverage /catalog failed: TimeoutError",
    );
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
    await expect(Bridge.catalog()).rejects.toThrow(
      "QA coverage /catalog failed: TimeoutError",
    );
  } finally {
    if (url === undefined) delete process.env.QA_BRIDGE_URL;
    else process.env.QA_BRIDGE_URL = url;
    if (token === undefined) delete process.env.QA_BRIDGE_TOKEN;
    else process.env.QA_BRIDGE_TOKEN = token;
    if (disposable === undefined) delete process.env.QA_DISPOSABLE;
    else process.env.QA_DISPOSABLE = disposable;
    globalThis.fetch = fetcher;
  }
});

test("reviewer claims a flow through the scoped MCP tool", async () => {
  let claimed: string = "";
  const server = Coverage.create({
    list: async () => [],
    claim: async (key: string, goal: string): Promise<boolean> => {
      claimed = `${key}:${goal}`;

      return true;
    },
  });
  const client = new Client({ name: "quaz-test", version: "1.0.0" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "claim",
      "list",
    ]);
    const result = await client.callTool({
      name: "claim",
      arguments: { key: "home-add-task", goal: "Add a task" },
    });
    expect(result.content).toEqual([
      { type: "text", text: '{"accepted":true}' },
    ]);
    expect(claimed).toBe("home-add-task:Add a task");
  } finally {
    await client.close();
    await server.close();
  }
});

test("validator reads only saved reviewer evidence", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-evidence-"));
  await mkdir(join(root, "reviewer"));
  await writeFile(join(root, "reviewer/technical.json"), "x".repeat(32_010));
  await writeFile(
    join(root, "reviewer/events.jsonl"),
    '{"type":"click"}\n{"type":"screenshot"}',
  );
  const server = Coverage.create(
    {
      list: async (): Promise<[]> => [],
      claim: async (): Promise<boolean> => true,
    },
    "validator",
    (
      path: Parameters<typeof Coverage.evidence>[0],
      offset: number = 0,
      query: string = "",
    ) => Coverage.evidence(path, offset, query, root),
  );
  const client = new Client({ name: "quaz-test", version: "1.0.0" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "read",
    ]);
    const first = await client.callTool({
      name: "read",
      arguments: { path: "reviewer/technical.json" },
    });
    expect(first.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          text: "x".repeat(32_000),
          nextOffset: 32_000,
          total: 32_010,
        }),
      },
    ]);
    expect(
      (
        await client.callTool({
          name: "read",
          arguments: { path: "reviewer/technical.json", offset: 32_000 },
        })
      ).content,
    ).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          text: "x".repeat(10),
          nextOffset: null,
          total: 32_010,
        }),
      },
    ]);
    expect(
      (
        await client.callTool({
          name: "read",
          arguments: { path: "reviewer/events.jsonl", query: "click" },
        })
      ).content,
    ).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          text: '{"type":"click"}',
          nextOffset: null,
          total: 16,
        }),
      },
    ]);
    await writeFile(join(root, "outside.json"), "outside");
    await symlink(
      join(root, "outside.json"),
      join(root, "reviewer/checked.json"),
    );
    await expect(
      Coverage.evidence("reviewer/checked.json", 0, "", root),
    ).rejects.toThrow("path changed");
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("validator skips image data in large event logs", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-events-"));
  await mkdir(join(root, "reviewer"));
  const image: string = "a".repeat(4 * 1024 * 1024);
  await writeFile(
    join(root, "reviewer/events.jsonl"),
    `${JSON.stringify({ type: "image", data: image })}\n${JSON.stringify({ type: "click", target: "button" })}`,
  );
  try {
    const all = await Coverage.evidence("reviewer/events.jsonl", 0, "", root);
    expect(all.nextOffset).toBeNull();
    expect(all.text).toContain("image payload omitted");
    expect(all.text).toContain('"type":"click"');
    expect(all.text).not.toContain("aaaa");
    const click = await Coverage.evidence(
      "reviewer/events.jsonl",
      0,
      "click",
      root,
    );
    expect(click.text).toBe('{"type":"click","target":"button"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
