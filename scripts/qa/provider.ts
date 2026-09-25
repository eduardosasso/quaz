import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
export type Invocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};
export type Input = {
  work: string;
  schema: string;
  result: string;
  browser: string[];
  token: string;
  skill?: string;
  model?: string;
};
export type Provider = {
  invocation: (input: Input) => Invocation;
  collect: (
    raw: string,
    events: string,
    result: string,
    browser: boolean,
  ) => Promise<void>;
};
const event = z.object({ type: z.string() }).passthrough();
const tool = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const reply = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});
const message = z.object({
  type: z.enum(["assistant", "user"]),
  message: z.object({ content: z.array(z.unknown()) }),
});
const result = z.object({
  type: z.literal("result"),
  is_error: z.boolean().optional(),
  structured_output: z.unknown().optional(),
  result: z.string().optional(),
});
const init = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  mcp_servers: z
    .array(z.object({ name: z.string(), status: z.string() }))
    .optional(),
});
const image = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }),
});
const content = (value: unknown): unknown[] => {
  const entries: unknown[] = Array.isArray(value) ? value : [value];

  return entries.flatMap((entry: unknown): unknown[] => {
    const parsed = image.safeParse(entry);
    return parsed.success
      ? [
          {
            type: "image",
            data: parsed.data.source.data,
            mimeType: parsed.data.source.media_type,
          },
        ]
      : [entry];
  });
};
export const normalize = (
  lines: string,
): { events: string; output: unknown; browser: boolean } => {
  const calls: Map<string, z.infer<typeof tool>> = new Map();
  const recorded: unknown[] = [];
  let output: unknown;
  let browser: boolean = false;
  for (const line of lines
    .split("\n")
    .filter((value: string): boolean => !!value)) {
    const value: unknown = JSON.parse(line);
    const item = event.parse(value);
    const startup = init.safeParse(item);
    if (startup.success)
      browser =
        startup.data.mcp_servers?.some(
          (server): boolean =>
            server.name === "mobile" &&
            ["connected", "pending"].includes(server.status),
        ) ?? false;
    const spoken = message.safeParse(item);
    if (spoken.success)
      for (const block of spoken.data.message.content) {
        const called = tool.safeParse(block);
        if (called.success && called.data.name.startsWith("mcp__mobile__"))
          calls.set(called.data.id, called.data);
        const returned = reply.safeParse(block);
        if (!returned.success) continue;
        const call = calls.get(returned.data.tool_use_id);
        if (!call) continue;
        calls.delete(returned.data.tool_use_id);
        recorded.push({
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            server: "mobile",
            tool: call.name.slice("mcp__mobile__".length),
            arguments: call.input,
            status: returned.data.is_error ? "failed" : "completed",
            error: returned.data.is_error ? "MCP tool failed" : null,
            result: { content: content(returned.data.content) },
          },
        });
      }
    const ended = result.safeParse(item);
    if (ended.success) {
      if (ended.data.is_error) {
        if (/not logged in|authenticate|401/i.test(ended.data.result ?? ""))
          throw new Error("Claude QA token is missing or invalid");
        if (/rate.?limit|usage limit/i.test(ended.data.result ?? ""))
          throw new Error("Claude QA reached a subscription usage limit");
        throw new Error("Claude QA returned an error; inspect the phase log");
      }
      output = ended.data.structured_output;
    }
  }
  if (output === undefined)
    throw new Error("Claude QA did not return structured output");

  return {
    events: recorded
      .map((entry: unknown): string => JSON.stringify(entry))
      .join("\n"),
    output,
    browser,
  };
};
export const argumentsFor = (input: Input, schema: string): string[] => [
  "-p",
  "--setting-sources",
  "",
  "--no-session-persistence",
  "--permission-mode",
  "dontAsk",
  "--allowedTools",
  input.browser.length ? "mcp__mobile__* mcp__coverage__*" : "",
  "--output-format",
  "stream-json",
  "--verbose",
  "--json-schema",
  schema,
  "--tools",
  "",
  ...input.browser,
  ...(input.model ? ["--model", input.model] : []),
];
export const schema = (value: z.ZodType): string => {
  const output = z.toJSONSchema(value);
  delete output.$schema;

  return JSON.stringify(output);
};
export const redacted = (value: string, token: string): string =>
  token ? value.replaceAll(token, "[REDACTED]") : value;
const frame = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    console.error("Claude stream contains an incomplete JSON frame");

    return null;
  }
};
export const failure = (stderr: string, stdout: string = ""): string => {
  const terminal = stdout
    .split("\n")
    .filter((line: string): boolean => line.length > 0)
    .map(frame)
    .map((value: unknown) =>
      z
        .object({
          type: z.literal("result"),
          is_error: z.literal(true),
          api_error_status: z.number().optional(),
        })
        .safeParse(value),
    )
    .filter((value) => value.success)
    .at(-1);
  if (terminal?.data.api_error_status === 401)
    return "Claude authentication failed";
  if (terminal?.data.api_error_status === 429)
    return "Claude request was rate limited";
  const reasons: Array<[RegExp, string]> = [
    [/sandbox|bubblewrap|bwrap/i, "Claude sandbox failed"],
    [
      /mcp.{0,60}(failed|error)|failed.{0,60}mcp/i,
      "Claude browser failed to start",
    ],
    [/permission denied|EACCES/i, "Claude cannot access a required file"],
    [/json.schema|structured.output/i, "Claude rejected the output schema"],
    [
      /authentication|not logged in|unauthorized/i,
      "Claude authentication failed",
    ],
    [/rate.limit|usage.limit/i, "Claude reached its usage limit"],
  ];

  return (
    reasons.find(([pattern]: [RegExp, string]): boolean =>
      pattern.test(stderr),
    )?.[1] ?? "Claude exited without a classified error"
  );
};
export const scrub = async (path: string, token: string): Promise<void> => {
  const value: string = await readFile(path, "utf8");
  const safe: string = redacted(value, token);
  if (safe !== value) await writeFile(path, safe);
};
const claude: Provider = {
  invocation: (input: Input): Invocation => {
    if (!input.token) throw new Error("Missing Claude QA token");
    if (input.browser.length && !input.skill)
      throw new Error("Missing Impeccable skill for guided QA");
    const config: string = `/tmp/claude-${randomUUID()}`;
    if (input.skill) {
      const skills: string = join(config, "skills");
      mkdirSync(skills, { recursive: true });
      symlinkSync(input.skill, join(skills, "impeccable"), "dir");
    }

    return {
      command: "claude",
      args: argumentsFor(input, readFileSync(input.schema, "utf8")),
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp/home",
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_OAUTH_TOKEN: input.token,
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
      },
    };
  },
  collect: async (
    raw: string,
    events: string,
    destination: string,
    browser: boolean,
  ): Promise<void> => {
    const parsed = normalize(await readFile(raw, "utf8"));
    if (browser && !parsed.browser)
      throw new Error("Claude QA mobile browser MCP did not connect");
    await writeFile(events, `${parsed.events}\n`);
    await writeFile(destination, `${JSON.stringify(parsed.output)}\n`);
    await rm(raw);
  },
};
export const select = (name: string): Provider => {
  if (name !== "claude")
    throw new Error("Only the Claude provider is available");

  return claude;
};
