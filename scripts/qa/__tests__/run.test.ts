import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Client from "@qa/client";
import * as Image from "@qa/image";
import * as Runner from "@qa/run";
import type * as Protocol from "@/qa_protocol";

const client: Client.Client = {
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

const IDENTITY: string[] = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "user.name=QA",
  "-c",
  "user.email=qa@example.test",
];
const git = (cwd: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd });
  if (result.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
};
const repository = async (directory: string): Promise<string> => {
  const root: string = join(directory, "app");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "app.ts"), "export const value = 1;");
  git(root, "init", "-q");
  git(root, "add", "app.ts");
  git(root, "commit", "-qm", "fixture");
  const file: string = join(directory, "project.json");
  await writeFile(
    file,
    JSON.stringify({
      id: "sample-app",
      root: "app",
      sources: ["app.ts"],
      scenarios: ["empty"],
      revision: "git",
      fetch: false,
    }),
  );
  return file;
};
const fail = (file: string): Promise<unknown> =>
  Runner.run(
    Runner.options(["--project", file, "--mode", "smoke", "--testers", "1"]),
    undefined,
    client,
  ).catch((error: unknown): unknown => error);
const dockerOnly = (docker: string) => {
  const spawn: typeof Bun.spawn = Bun.spawn;

  return spyOn(Bun, "spawn").mockImplementation(
    ((...args: Parameters<typeof Bun.spawn>): ReturnType<typeof Bun.spawn> =>
      spawn(
        args[0][0] === "docker" ? [docker, ...args[0].slice(1)] : args[0],
        args[1],
      )) as typeof Bun.spawn,
  );
};

describe("build-time source drift", (): void => {
  test("staged source mismatch fails on source revision", async (): Promise<void> => {
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
      const failure: unknown = await Runner.run(
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
      ).catch((error: unknown): unknown => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(Runner.Drift);
      expect((failure as Error).message).toContain(
        "Staged QA image source differs",
      );
    } finally {
      stage.mockRestore();
      base.mockRestore();
      executable.mockRestore();
      await rm(directory, { recursive: true, force: true });
      await rm(staged, { recursive: true, force: true });
    }
  });

  test("source change during build fails on source revision", async (): Promise<void> => {
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
      const failure: unknown = await Runner.run(
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
      ).catch((error: unknown): unknown => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(Runner.Drift);
      expect((failure as Error).message).toContain(
        "Source changed during the build",
      );
    } finally {
      base.mockRestore();
      executable.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("source change without new commit fails during staging", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "quaz-run-drift-"));
    const staged: string = await mkdtemp(join(tmpdir(), "quaz-run-stage-"));
    const docker: string = await dockerBinary(
      directory,
      `#!/bin/sh\ncase "$1" in\ninfo) echo test ;;\nesac\nexit 0\n`,
    );
    const executable = dockerOnly(docker);
    const base = spyOn(Image, "base").mockResolvedValue(
      `quaz:base@sha256:${"b".repeat(64)}`,
    );
    await writeFile(join(staged, "app.ts"), "export const value = 2;");
    const stage = spyOn(Image, "stage").mockResolvedValue(staged);
    try {
      const failure: unknown = await fail(await repository(directory));
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(Runner.Drift);
      expect((failure as Error).message).toContain(
        "Staged QA image source differs",
      );
    } finally {
      stage.mockRestore();
      base.mockRestore();
      executable.mockRestore();
      await rm(directory, { recursive: true, force: true });
      await rm(staged, { recursive: true, force: true });
    }
  });

  test("source change without new commit fails during build", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "quaz-run-drift-"));
    const docker: string = await dockerBinary(
      directory,
      `#!/bin/sh\ncase "$1" in\ninfo) echo test ;;\nbuild) echo "export const value = 2;" > app.ts; exit 0 ;;\nesac\nexit 0\n`,
    );
    const executable = dockerOnly(docker);
    const base = spyOn(Image, "base").mockResolvedValue(
      `quaz:base@sha256:${"b".repeat(64)}`,
    );
    try {
      const failure: unknown = await fail(await repository(directory));
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(Runner.Drift);
      expect((failure as Error).message).toContain(
        "Source changed during the build",
      );
    } finally {
      base.mockRestore();
      executable.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("new commit during staging is stale", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "quaz-run-drift-"));
    const staged: string = await mkdtemp(join(tmpdir(), "quaz-run-stage-"));
    const docker: string = await dockerBinary(
      directory,
      `#!/bin/sh\ncase "$1" in\ninfo) echo test ;;\nesac\nexit 0\n`,
    );
    const executable = dockerOnly(docker);
    const base = spyOn(Image, "base").mockResolvedValue(
      `quaz:base@sha256:${"b".repeat(64)}`,
    );
    await writeFile(join(staged, "app.ts"), "export const value = 2;");
    const stage = spyOn(Image, "stage").mockImplementation(
      async (): Promise<string> => {
        const root: string = join(directory, "app");
        await writeFile(join(root, "app.ts"), "export const value = 2;");
        git(root, "commit", "-qam", "moved");

        return staged;
      },
    );
    try {
      const failure: unknown = await fail(await repository(directory));
      expect(failure).toBeInstanceOf(Runner.Drift);
      expect((failure as Error).message).toContain(
        "Staged QA image source differs",
      );
    } finally {
      stage.mockRestore();
      base.mockRestore();
      executable.mockRestore();
      await rm(directory, { recursive: true, force: true });
      await rm(staged, { recursive: true, force: true });
    }
  });

  test("new commit during build is stale", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "quaz-run-drift-"));
    const docker: string = await dockerBinary(
      directory,
      `#!/bin/sh\ncase "$1" in\ninfo) echo test ;;\nbuild) echo "export const value = 2;" > app.ts; git -c commit.gpgsign=false -c user.name=QA -c user.email=qa@example.test commit -qam moved; exit 0 ;;\nesac\nexit 0\n`,
    );
    const executable = dockerOnly(docker);
    const base = spyOn(Image, "base").mockResolvedValue(
      `quaz:base@sha256:${"b".repeat(64)}`,
    );
    try {
      const failure: unknown = await fail(await repository(directory));
      expect(failure).toBeInstanceOf(Runner.Drift);
      expect((failure as Error).message).toContain(
        "Source changed during the build",
      );
    } finally {
      base.mockRestore();
      executable.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("crash recovery placeholder", (): void => {
  test("uncorrected pre-run placeholder resolves as failed, not interrupted", async (): Promise<void> => {
    const directory: string = await mkdtemp(
      join(tmpdir(), "quaz-run-recover-"),
    );
    await mkdir(join(directory, "output"), { recursive: true });
    const began: Protocol.Begin = {
      id: "sample-1",
      project: "sample-app",
      mode: "smoke",
      revision: "a".repeat(40),
      runner: { source: "a".repeat(40), image: `sha256:${"b".repeat(64)}` },
      scenario: "empty",
    };
    const run: Protocol.Run = {
      ...began,
      note_id: 1,
      board_id: 1,
      owner: "qa",
      status: "open",
      expires: Date.now() + 1_000_000,
      target: null,
      snapshot: null,
      receipt: null,
    };
    await writeFile(
      join(directory, "recovery.json"),
      JSON.stringify({
        isolated: true,
        run: began,
        error: "QA run interrupted before completion",
        interrupted: false,
      }),
    );
    const recoverClient: Client.Client = {
      upload: async (): Promise<number> => 1,
      request: async <T>(path: string): Promise<T> => {
        if (path === "/runs") return run as T;
        if (path === `/runs/${began.id}/finish`)
          return { run: { ...run, status: "failed" } } as T;
        throw new Error(`Unexpected client request ${path}`);
      },
    };
    try {
      const conclusion: Protocol.Finish = await Runner.recover(
        recoverClient,
        directory,
      );
      expect(conclusion.status).toBe("failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
