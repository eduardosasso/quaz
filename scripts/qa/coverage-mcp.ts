import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as Coverage from "@qa/coverage";
import { z } from "zod";

const BRIDGE: string = "/tmp/qa-bridge.json";
const bridgeSchema = z
  .object({ url: z.url(), token: z.string().min(1) })
  .strict();

export const create = (
  actions: Pick<typeof Coverage, "list" | "claim"> = Coverage,
): McpServer => {
  const server = new McpServer({ name: "quaz-coverage", version: "0.1.0" });
  server.registerTool(
    "list",
    {
      description: "List existing QA flow claims before selecting a new flow.",
      inputSchema: {},
    },
    async () => {
      try {
        return {
          content: [
            { type: "text", text: JSON.stringify(await actions.list()) },
          ],
        };
      } catch (error: unknown) {
        console.error(`Coverage list failed: ${String(error)}`);
        throw error;
      }
    },
  );
  server.registerTool(
    "claim",
    {
      description: "Claim one stable QA flow for this run before testing it.",
      inputSchema: { key: z.string().min(1), goal: z.string().min(1) },
    },
    async ({ key, goal }) => {
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                accepted: await actions.claim(key, goal),
              }),
            },
          ],
        };
      } catch (error: unknown) {
        console.error(`Coverage claim failed: ${String(error)}`);
        throw error;
      }
    },
  );

  return server;
};

export const start = async (): Promise<void> => {
  const bridge = bridgeSchema.parse(JSON.parse(await readFile(BRIDGE, "utf8")));
  process.env.QA_BRIDGE_URL = bridge.url;
  process.env.QA_BRIDGE_TOKEN = bridge.token;
  process.env.QA_DISPOSABLE = "1";
  await create().connect(new StdioServerTransport());
};

if (import.meta.main) await start();
