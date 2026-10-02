import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as Controller from "@qa/controller";
import * as Project from "@qa/project";

const ROOT: string = join(import.meta.dir, "../..");
const PROJECTS: string = join(ROOT, "projects");
const IMAGE_ROOT: string = "/quaz/";
const ids: string[] = readdirSync(PROJECTS, { withFileTypes: true })
  .filter((entry): boolean => entry.isDirectory())
  .map((entry): string => entry.name)
  .filter((name: string): boolean =>
    existsSync(join(PROJECTS, name, "project.json")),
  );

test("projects folder holds at least one project", (): void => {
  expect(ids.length).toBeGreaterThan(0);
});

for (const id of ids)
  test(`project ${id} is ready to deploy`, async (): Promise<void> => {
    const file: string = join(PROJECTS, id, "project.json");
    const project: Project.Project = Project.load(file);
    const settings: Controller.Settings = await Controller.load(file);
    expect(project.id).toBe(id);
    expect(project.controller).toBeDefined();
    expect(settings.project).toBe(file);
    expect(project.fetch || project.revision === "target").toBe(true);
    if (project.adapter.startsWith(IMAGE_ROOT))
      expect(
        existsSync(join(ROOT, project.adapter.slice(IMAGE_ROOT.length))),
      ).toBe(true);
  });
