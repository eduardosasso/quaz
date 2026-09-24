import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { z } from "zod";
import * as Protocol from "@/qa_protocol";

const origin = z.url().refine((value: string): boolean => {
  const url: URL = new URL(value);
  return (
    ["https:", "http:"].includes(url.protocol) &&
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
    root: z.string().default("."),
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
      .default([]),
    adapter: z.string().startsWith("/").default("/quaz/scripts/qa/command.ts"),
    context: z.array(z.string().startsWith("/app/")).default([]),
    settings: z.record(z.string(), z.string()).default({}),
    scenarios: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
    revision: z.enum(["git", "source", "target"]).default("git"),
    deployment: z
      .object({
        url: z.url(),
        repository: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .optional(),
        revision: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (project): boolean =>
      project.revision === "target"
        ? Boolean(project.deployment?.revision) && project.sources.length === 0
        : project.sources.length > 0,
    "Local targets need app sources; remote targets need a deployed revision",
  );
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
export const validate = (value: Prepared, project: Project): Prepared => {
  origin.parse(value.origin);
  if (!value.entry.startsWith("/") || !value.ready.startsWith("/"))
    throw new Error("Invalid project adapter result");

  const normalized: string = new URL(value.origin).origin;
  if (
    project.revision === "target" &&
    (!project.deployment ||
      normalized !== new URL(project.deployment.url).origin)
  )
    throw new Error("Project adapter origin differs from target deployment");

  return { ...value, origin: normalized };
};

export const checkTarget = async (
  project: Project,
  request: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): Promise<string> => {
  if (project.revision !== "target" || !project.deployment?.revision)
    throw new Error("Project has no deployed target revision");
  const response: Response = await request(project.deployment.url, {
    method: "HEAD",
    redirect: "error",
    signal: AbortSignal.timeout(Protocol.REQUEST_MS),
  });
  if (
    !response.ok ||
    response.headers.get("x-quaz-revision") !== project.deployment.revision
  )
    throw new Error("Target deployment revision does not match project config");

  return project.deployment.revision;
};
