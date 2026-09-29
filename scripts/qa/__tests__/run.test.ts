import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Client from "@qa/client";
import * as Image from "@qa/image";
import * as Runner from "@qa/run";

const client: Client.Client = {
  comments: async (): Promise<string[]> => [],
  request: async (): Promise<never> => {
    throw new Error("Unexpected client request");
  },
  upload: async (): Promise<number> => {
    throw new Error("No upload expected");
  },
};
const project = async (directory: string): Promise<string> => {
  await writeFile(join(directory, "app.ts"), "export const value = 1;");
  const file: string = join(directory, "project.json");
  await writeFile(
    file,
    JSON.stringify({
      id: "sample-app",
      root: ".",
      sources: ["app.ts"],
      scenarios: ["empty"],
      revision: "source",
      fetch: false,
    }),
  );
  return file;
};
const dockerBinary = async (
  directory: string,
  script: string,
): Promise<string> => {
  const binaries: string = join(directory, "bin");
  await mkdir(binaries, { recursive: true });
  const path: string = join(binaries, "docker");
  await writeFile(path, script, { mode: 0o700 });
  return path;
};

describe("build-time source drift", (): void => {
  test("staged image source mismatch raises Drift", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "quaz-run-drift-"));
    const staged: string = await mkdtemp(join(tmpdir(), "quaz-run-stage-"));
    const spawn: typeof Bun.spawn = Bun.spawn;
    const docker: string = await dockerBinary(
      directory,
      `#!/bin/sh\ncase "$1" in\ninfo) echo test ;;\nesac\nexit 0\n`,
    );
    const executable = spyOn(Bun, "spawn").mockImplementation(
      ((...args: Parameters<typeof Bun.spawn>): ReturnType<typeof Bun.spawn> =>
        spawn([docker, ...args[0].slice(1)], args[1])) as typeof Bun.spawn,
    );
    const base = spyOn(Image, "base").mockResolvedValue(
      `quaz:base@sha256:${"b".repeat(64)}`,
    );
    await writeFile(join(staged, "app.ts"), "export const value = 2;");
    const stage = spyOn(Image, "stage").mockResolvedValue(staged);
    try {
      const file: string = await project(directory);
      await expect(
        Runner.run(
          Runner.options([
            "--project",
            file,
            "--mode",
            "smoke",
            "--testers",
            "1",
          ]),
          undefined,
          client,
        ),
      ).rejects.toThrow("Staged QA image source differs");
    } finally {
      stage.mockRestore();
      base.mockRestore();
      executable.mockRestore();
      await rm(directory, { recursive: true, force: true });
      await rm(staged, { recursive: true, force: true });
    }
  });

  test("source changed mid-build raises Drift", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "quaz-run-drift-"));
    const spawn: typeof Bun.spawn = Bun.spawn;
    const docker: string = await dockerBinary(
      directory,
      `#!/bin/sh\ncase "$1" in\ninfo) echo test ;;\nbuild) echo "export const value = 2;" > app.ts; exit 0 ;;\nesac\nexit 0\n`,
    );
    const executable = spyOn(Bun, "spawn").mockImplementation(
      ((...args: Parameters<typeof Bun.spawn>): ReturnType<typeof Bun.spawn> =>
        spawn([docker, ...args[0].slice(1)], args[1])) as typeof Bun.spawn,
    );
    const base = spyOn(Image, "base").mockResolvedValue(
      `quaz:base@sha256:${"b".repeat(64)}`,
    );
    try {
      const file: string = await project(directory);
      await expect(
        Runner.run(
          Runner.options([
            "--project",
            file,
            "--mode",
            "smoke",
            "--testers",
            "1",
          ]),
          undefined,
          client,
        ),
      ).rejects.toThrow("Source changed during the build");
    } finally {
      base.mockRestore();
      executable.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
