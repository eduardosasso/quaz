import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Image from "@qa/image";
import * as Project from "@qa/project";
import * as Runner from "@qa/run";

const folders: string[] = [];
afterEach((): void => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

test("image context copies only declared sources", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-image-"));
  folders.push(folder);
  writeFileSync(join(folder, "app.ts"), "export const app = true;");
  writeFileSync(join(folder, ".env"), "SECRET=private");
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    root: folder,
    sources: ["app.ts"],
    scenarios: ["empty"],
  });
  const context: string = await Image.stage(project, folder);
  expect(readFileSync(join(context, "app.ts"), "utf8")).toContain("app");
  expect(Runner.source({ ...project, root: context })).toBe(
    Runner.source(project),
  );
  await expect(Bun.file(join(context, ".env")).exists()).resolves.toBe(false);
  expect(
    (): Project.Project =>
      Project.schema.parse({ ...project, sources: ["../.env"] }),
  ).toThrow();
});

test("project image extends a pinned Quaz base", () => {
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    root: "/sample",
    sources: ["app.ts"],
    scenarios: ["empty"],
  });
  const base: string = `sha256:${"a".repeat(64)}`;
  const args: string[] = Image.args(
    project,
    "source-revision",
    "quaz:sample",
    "/staged",
    base,
  );
  expect(args).toContain(`QUAZ_BASE=${base}`);
  expect(args).toContain("QA_REVISION=source-revision");
  expect(args).not.toContain("--build-context");
  expect(args.at(-1)).toBe("/staged");
  expect(Image.baseArgs("base-revision", "0.1.0")).toContain(
    "SOURCE_REVISION=base-revision",
  );
  expect(Image.baseArgs("base-revision", "0.1.0")).toContain(
    "IMPECCABLE_VERSION=4.3.1",
  );
});

test("base image override needs an immutable digest", async () => {
  const before: string | undefined = process.env.QUAZ_BASE_IMAGE;
  try {
    process.env.QUAZ_BASE_IMAGE = "quaz:latest";
    await expect(Image.base()).rejects.toThrow("immutable image digest");
  } finally {
    if (before) process.env.QUAZ_BASE_IMAGE = before;
    else delete process.env.QUAZ_BASE_IMAGE;
  }
  expect(
    Image.matches(
      {
        "org.opencontainers.image.source":
          "https://github.com/eduardosasso/quaz",
        "org.opencontainers.image.revision": "current",
      },
      "current",
    ),
  ).toBe(true);
  expect(
    Image.matches(
      {
        "org.opencontainers.image.source":
          "https://github.com/eduardosasso/quaz",
        "org.opencontainers.image.revision": "old",
      },
      "current",
    ),
  ).toBe(false);
});

test("controller rejects a project image built from older source", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-revision-"));
  folders.push(folder);
  writeFileSync(join(folder, "app.ts"), "first");
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    root: folder,
    sources: ["app.ts"],
    scenarios: ["empty"],
    revision: "source",
  });
  const built: string = await Runner.revision(project);
  writeFileSync(join(folder, "app.ts"), "second");
  await expect(
    Runner.revision(project, {
      image: `sha256:${"a".repeat(64)}`,
      revision: built,
      volume: "quaz-state",
      directory: "/qa",
      network: "qa-private",
      owner: "controller",
    }),
  ).rejects.toThrow("rebuild the project image");
});
