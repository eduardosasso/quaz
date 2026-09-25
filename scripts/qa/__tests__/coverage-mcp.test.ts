import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as Coverage from "@qa/coverage-mcp";

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
