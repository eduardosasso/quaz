import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { z } from "zod";

const loopback = z.url().refine((value: string): boolean => {
  const url: URL = new URL(value);
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.pathname === "/" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
export const schema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]+$/),
    root: z.string(),
    dockerfile: z.string().default(""),
    sources: z
      .array(
        z
          .string()
          .refine(
            (value: string): boolean =>
              Boolean(value) &&
              !value.startsWith("/") &&
              !value
                .split("/")
                .some((part: string): boolean =>
                  ["", ".", ".."].includes(part),
                ),
            "Sources must stay inside the project root",
          ),
      )
      .min(1),
    adapter: z.string().startsWith("/").default("/quaz/scripts/qa/command.ts"),
    context: z.array(z.string().startsWith("/app/")).default([]),
    settings: z.record(z.string(), z.string()).default({}),
    scenarios: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
    revision: z.enum(["git", "source"]).default("git"),
    deployment: z
      .object({
        url: z.url(),
        repository: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .optional(),
      })
      .optional(),
  })
  .strict();
export type Project = z.infer<typeof schema>;
export type Prepared = {
  origin: string;
  entry: string;
  ready: string;
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
  command: string[];
  env: Record<string, string>;
  metadata: Record<string, unknown>;
};
export type Adapter = {
  prepare: (input: {
    directory: string;
    runId: string;
    testerId: string;
    scenario: string;
    revision: string;
    settings: Record<string, string>;
  }) => Promise<Prepared>;
  smoke: (
    prepared: Prepared,
    browser: Browser,
    output: string,
  ) => Promise<Record<string, unknown>>;
};
export const load = (file: string): Project => {
  const value: Project = schema.parse(JSON.parse(readFileSync(file, "utf8")));
  return { ...value, root: resolve(dirname(file), value.root) };
};
export const validate = (value: Prepared): Prepared => {
  loopback.parse(value.origin);
  if (
    !value.entry.startsWith("/") ||
    !value.ready.startsWith("/") ||
    !value.command.length
  )
    throw new Error("Invalid project adapter result");
  return value;
};
