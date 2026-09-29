import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Controller from "@qa/controller";
import type * as Project from "@qa/project";

test("follow probes the deployment once per poll cycle for a fetch-enabled project", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-follow-probe-"));
  const git = (...args: string[]): string =>
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=QA",
        "-c",
        "user.email=qa@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root },
    )
      .stdout.toString()
      .trim();
  git("init", "-q");
  await writeFile(join(root, "app.ts"), "export const app = true;");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const deployed: string = git("rev-parse", "HEAD");
  let probes: number = 0;
  const project: Project.Project = {
    id: "sample-app",
    root,
    dockerfile: "",
    sources: ["app.ts"],
    adapter: "/app/adapter.ts",
    context: [],
    settings: {},
    scenarios: ["empty"],
    revision: "git",
    fetch: true,
    deployment: { url: "https://app.test/version", repository: "acme/app" },
  };
  try {
    const revision: string = await Controller.follow(
      project,
      30,
      new AbortController().signal,
      { wait: async (): Promise<void> => {}, log: (): void => {} },
      async (): Promise<Response> => {
        probes++;

        return new Response("{}", {
          headers: { "x-quaz-revision": deployed },
        });
      },
    )();
    expect(revision).toBe(deployed);
    expect(probes).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
