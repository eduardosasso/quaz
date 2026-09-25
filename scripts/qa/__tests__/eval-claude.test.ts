import { expect, test } from "bun:test";
import * as Claude from "@qa/eval-claude";
import type * as Model from "@qa/eval-model";
import { z } from "zod";

const input: Model.Input = {
  model: "sonnet",
  effort: "high",
  seconds: 30,
  prompt: "Review image 1",
  images: [Buffer.from("image")],
  schema: z.object({ answer: z.string() }).strict(),
  directory: "/tmp/quaz-eval",
};

test("Claude visual review receives the screenshot as an image", () => {
  const frame = JSON.parse(Claude.frame(input));
  expect(frame.message.content[0]).toEqual({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: Buffer.from("image").toString("base64"),
    },
  });
  expect(frame.message.content[1]).toEqual({
    type: "text",
    text: input.prompt,
  });
});

test("Claude visual review disables tools and uses the subscription CLI", () => {
  const args: string[] = Claude.argumentsFor(input);
  expect(args.slice(0, 3)).toEqual(["-p", "--input-format", "stream-json"]);
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args[args.indexOf("--allowedTools") + 1]).toBe("");
  expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  expect(JSON.parse(args[args.indexOf("--json-schema") + 1]).$schema).toBe(
    undefined,
  );
});
