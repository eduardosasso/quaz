import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Image from "@qa/image";
import * as Project from "@qa/project";

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
  await expect(Bun.file(join(context, ".env")).exists()).resolves.toBe(false);
  expect(
    (): Project.Project =>
      Project.schema.parse({ ...project, sources: ["../.env"] }),
  ).toThrow();
});
