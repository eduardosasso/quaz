import { expect, test } from "bun:test";
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Provider from "@qa/provider";

const input: Provider.Input = {
  work: "/output",
  schema: "/output/schema.json",
  result: "/output/result.json",
  browser: ["--strict-mcp-config", "--mcp-config", "{}"],
  token: "test-token",
  skill: "/opt/impeccable",
};

test("Claude runs with a schema and only the requested browser", () => {
  const args: string[] = Provider.argumentsFor(input, '{"type":"object"}');
  expect(args).toContain("--setting-sources");
  expect(args).not.toContain("--disable-slash-commands");
  expect(args).toContain("--no-session-persistence");
  expect(args).toContain("stream-json");
  expect(args).toContain('{"type":"object"}');
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("Bash,Read,Skill");
  expect(Provider.argumentsFor({ ...input, browser: [] }, "{}")).toContain("");
});

test("Claude browser evidence becomes checked QA events", () => {
  const lines: string = [
    {
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "mobile", status: "connected" }],
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "mcp__mobile__browser_take_screenshot",
            input: {},
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [
              {
                type: "text",
                text: "- [Screenshot of app](/output/reviewer/1.png)",
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "aGVsbG8=",
                },
              },
            ],
          },
        ],
      },
    },
    {
      type: "result",
      is_error: false,
      structured_output: { status: "complete" },
    },
  ]
    .map((value: unknown): string => JSON.stringify(value))
    .join("\n");
  const parsed = Provider.normalize(lines);
  expect(parsed.browser).toBe(true);
  expect(parsed.output).toEqual({ status: "complete" });
  const evidence: { item: { tool: string; result: { content: unknown[] } } } =
    JSON.parse(parsed.events);
  expect(evidence.item.tool).toBe("browser_take_screenshot");
  expect(evidence.item.result.content).toContainEqual({
    type: "image",
    data: "aGVsbG8=",
    mimeType: "image/png",
  });
});

test("Claude missing result fails closed", () => {
  expect(
    (): ReturnType<typeof Provider.normalize> =>
      Provider.normalize('{"type":"system","subtype":"init"}'),
  ).toThrow("structured output");
});

test("Claude authentication errors name the credential", () => {
  expect(
    (): ReturnType<typeof Provider.normalize> =>
      Provider.normalize(
        '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}',
      ),
  ).toThrow("token is missing or invalid");
});

test("Claude logs redact the QA token", () => {
  expect(Provider.redacted("before test-token after", "test-token")).toBe(
    "before [REDACTED] after",
  );
});

test("Claude scrubs credentials from tool subprocesses", () => {
  const root: string = mkdtempSync(join(tmpdir(), "quaz-provider-"));
  const schema: string = join(root, "schema.json");
  writeFileSync(schema, '{"type":"object"}');
  try {
    const invocation: Provider.Invocation = Provider.select(
      "claude",
    ).invocation({
      ...input,
      schema,
    });
    expect(invocation.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(invocation.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY).toBe("1");
    expect(invocation.args.join(" ")).not.toContain(input.token);
    expect(
      readlinkSync(
        join(invocation.env.CLAUDE_CONFIG_DIR ?? "", "skills", "impeccable"),
      ),
    ).toBe(input.skill ?? "");
    rmSync(invocation.env.CLAUDE_CONFIG_DIR ?? "", {
      recursive: true,
      force: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
