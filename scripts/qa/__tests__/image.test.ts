import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("worker guide omits unrelated private files", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-guide-"));
  folders.push(folder);
  const source: string = join(folder, "source");
  const destination: string = join(folder, "copied");
  mkdirSync(join(source, "reference"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "guide");
  for (const name of [
    "critique",
    "audit",
    "polish",
    "layout",
    "typeset",
    "adapt",
  ])
    writeFileSync(join(source, "reference", `${name}.md`), name);
  writeFileSync(join(source, "private-token.txt"), "secret");
  await Runner.copyGuide(source, destination);
  expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe("guide");
  await expect(
    Bun.file(join(destination, "private-token.txt")).exists(),
  ).resolves.toBe(false);
});

test("worker guide rejects a linked reference directory", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-linked-guide-"));
  folders.push(folder);
  const skill: string = join(folder, "skill");
  const reference: string = join(folder, "private");
  mkdirSync(skill);
  mkdirSync(reference);
  symlinkSync(reference, join(skill, "reference"));
  expect((): void => Runner.validateGuide(skill)).toThrow(
    "Missing Impeccable guide directory",
  );
  await expect(Runner.copyGuide(skill, join(folder, "copied"))).rejects.toThrow(
    "Missing Impeccable guide directory",
  );
});
