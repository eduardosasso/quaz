import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as Coverage from "@qa/coverage";
import { z } from "zod";

const BRIDGE: string = "/tmp/qa-bridge.json";
const OUTPUT: string = "/output";
const EVIDENCE_PATHS = [
  "reviewer/events.jsonl",
  "reviewer/technical.json",
  "reviewer/checked.json",
] as const;
const EVIDENCE_CHARS: number = 32_000;
const EVIDENCE_BYTES: number = 64 * 1024 * 1024;
const bridgeSchema = z
  .object({ url: z.url(), token: z.string().min(1) })
  .strict();

const compact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== "object") return value;
  const fields: Record<string, unknown> = value as Record<string, unknown>;

  return Object.fromEntries(
    Object.entries(fields).map(
      ([key, entry]: [string, unknown]): [string, unknown] => [
        key,
        key === "data" && fields.type === "image" && typeof entry === "string"
          ? `[image payload omitted: ${entry.length} characters]`
          : compact(entry),
      ],
    ),
  );
};

const compactEvents = (content: string): string =>
  content
    .split("\n")
    .map((line: string): string =>
      line ? JSON.stringify(compact(JSON.parse(line))) : line,
    )
    .join("\n");

export const evidence = async (
  path: (typeof EVIDENCE_PATHS)[number],
  offset: number = 0,
  query: string = "",
  root: string = OUTPUT,
): Promise<{ text: string; nextOffset: number | null; total: number }> => {
  if (!EVIDENCE_PATHS.includes(path))
    throw new Error("Reviewer evidence path is unavailable");
  const source: string = await realpath(join(root, path));
  if (relative(await realpath(root), source) !== path)
    throw new Error("Reviewer evidence path changed");
  if ((await stat(source)).size > EVIDENCE_BYTES)
    throw new Error("Reviewer evidence exceeds the read limit");
  const raw: string = await readFile(source, "utf8");
  const content: string =
    path === "reviewer/events.jsonl" ? compactEvents(raw) : raw;
  const selected: string = query
    ? content
        .split("\n")
        .filter((line: string): boolean =>
          line.toLowerCase().includes(query.toLowerCase()),
        )
        .join("\n")
    : content;
  const end: number = Math.min(offset + EVIDENCE_CHARS, selected.length);

  return {
    text: selected.slice(offset, end),
    nextOffset: end < selected.length ? end : null,
    total: selected.length,
  };
};

export const create = (
  actions: Pick<typeof Coverage, "list" | "claim"> = Coverage,
  role: "reviewer" | "validator" = "reviewer",
  reader: typeof evidence = evidence,
): McpServer => {
  const server = new McpServer({ name: "quaz-coverage", version: "0.1.0" });
  if (role === "validator") {
    server.registerTool(
      "read",
      {
        description:
          "Read only saved reviewer evidence after independent reproduction. Use offset for the next page and query to filter event lines.",
        inputSchema: {
          path: z.enum(EVIDENCE_PATHS),
          offset: z.number().int().nonnegative().default(0),
          query: z.string().max(128).default(""),
        },
      },
      async ({ path, offset, query }) => {
        try {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(await reader(path, offset, query)),
              },
            ],
          };
        } catch (error: unknown) {
          console.error(
            `Reviewer evidence read failed: ${path}: ${String(error)}`,
          );
          throw error;
        }
      },
    );

    return server;
  }
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
  const role: "reviewer" | "validator" = process.argv.includes("--validator")
    ? "validator"
    : "reviewer";
  if (role === "reviewer") {
    const bridge = bridgeSchema.parse(
      JSON.parse(await readFile(BRIDGE, "utf8")),
    );
    process.env.QA_BRIDGE_URL = bridge.url;
    process.env.QA_BRIDGE_TOKEN = bridge.token;
    process.env.QA_DISPOSABLE = "1";
  }
  await create(Coverage, role).connect(new StdioServerTransport());
};

if (import.meta.main) await start();
