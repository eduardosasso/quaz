import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Model from "@qa/eval-model";
import * as Provider from "@qa/provider";
import { z } from "zod";

const CLAUDE: string = "claude";
const IMAGE: string = "image/png";

export const frame = (input: Model.Input): string =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        ...input.images.map((bytes: Buffer) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: IMAGE,
            data: bytes.toString("base64"),
          },
        })),
        { type: "text", text: input.prompt },
      ],
    },
  });

export const argumentsFor = (input: Model.Input): string[] => [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--json-schema",
  Provider.schema(input.schema),
  "--tools",
  "",
  "--allowedTools",
  "",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--permission-mode",
  "dontAsk",
  "--model",
  input.model,
];

export const run = async (input: Model.Input): Promise<unknown> => {
  const token: string | undefined = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("Missing Claude subscription token");
  await mkdir(input.directory, { recursive: true });
  await writeFile(join(input.directory, "prompt.txt"), input.prompt);
  const child = Bun.spawn([CLAUDE, ...argumentsFor(input)], {
    cwd: input.directory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_CODE_OAUTH_TOKEN: token,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: input.seconds * 1000,
  });
  child.stdin.write(`${frame(input)}\n`);
  child.stdin.end();
  const [events, errors, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await Promise.all([
    writeFile(
      join(input.directory, "events.jsonl"),
      Provider.redacted(events, token),
    ),
    writeFile(
      join(input.directory, "stderr.log"),
      Provider.redacted(errors, token),
    ),
  ]);
  if (status !== 0)
    throw new Error(
      `${Provider.failure(errors)}; inspect ${join(input.directory, "stderr.log")}`,
    );
  const output: unknown = Provider.normalize(events).output;
  let result: unknown;
  try {
    result = input.schema.parse(output);
  } catch (error: unknown) {
    if (error instanceof z.ZodError)
      throw new Model.InvalidOutputError(
        "Model output does not match its schema",
        {
          cause: error,
        },
      );
    throw error;
  }
  await writeFile(
    join(input.directory, "response.json"),
    JSON.stringify(result),
  );
  return result;
};
