import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

test("runner source includes the app build recipe", () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-source-"));
  folders.push(folder);
  for (const name of ["src", "scripts", "examples"])
    mkdirSync(join(folder, name));
  for (const name of [
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "Dockerfile.release",
  ])
    writeFileSync(join(folder, name), name);
  const dockerfile: string = join(folder, "Dockerfile");
  writeFileSync(dockerfile, "FROM image-one");
  const before: string = Image.source(folder);
  writeFileSync(dockerfile, "FROM image-two");
  expect(Image.source(folder)).not.toBe(before);
});

test("project adapter origin has no trailing slash", () => {
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    revision: "target",
    deployment: {
      url: "http://qa-target:3000/version",
      revision: "a".repeat(64),
    },
    scenarios: ["home"],
  });
  const prepared: Project.Prepared = {
    origin: "http://qa-target:3000/",
    entry: "/",
    ready: "/",
    storageState: { cookies: [], origins: [] },
    command: [],
    env: {},
    metadata: {},
  };

  expect(Project.validate(prepared, project).origin).toBe(
    "http://qa-target:3000",
  );
  expect(
    (): Project.Prepared =>
      Project.validate({ ...prepared, origin: "http://other:3000" }, project),
  ).toThrow("differs from target deployment");
});

test("local project adapter stays on loopback", () => {
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    sources: ["app.ts"],
    scenarios: ["home"],
    revision: "source",
  });
  const prepared: Project.Prepared = {
    origin: "http://127.0.0.1:3000/",
    entry: "/",
    ready: "/",
    storageState: { cookies: [], origins: [] },
    command: ["bun", "app.ts"],
    env: {},
    metadata: {},
  };
  expect(Project.validate(prepared, project).origin).toBe(
    "http://127.0.0.1:3000",
  );
  expect(
    (): Project.Prepared =>
      Project.validate(
        { ...prepared, origin: "https://example.com/" },
        project,
      ),
  ).toThrow("requires loopback");
  expect(
    (): Project.Prepared =>
      Project.validate({ ...prepared, command: [] }, project),
  ).toThrow("requires loopback");
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

test("release workflow supplies every base image build argument", () => {
  const workflow: string = readFileSync(
    join(import.meta.dir, "../../../.github/workflows/validate.yml"),
    "utf8",
  );
  const args: string[] = Image.baseArgs("revision", "0.1.0");
  const names: string[] = args
    .filter((value: string): boolean => value.includes("="))
    .map((value: string): string => value.split("=")[0] ?? "");
  for (const name of names)
    expect(workflow).toMatch(new RegExp(`^\\s+${name}=\\$\\{\\{`, "m"));
  expect(workflow).toContain("- name: Build Quaz image");
  expect(workflow).toContain("await Image.base()");
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

test("remote target uses the deployed revision with one Quaz image", async () => {
  const revision: string = "d".repeat(64);
  const url: string = "https://target.example/version";
  const requests: string[] = [];
  const request = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push(`${init?.method}:${String(input)}`);

    return new Response(null, { headers: { "x-quaz-revision": revision } });
  };
  const project: Project.Project = Project.schema.parse({
    id: "remote",
    scenarios: ["home"],
    revision: "target",
    deployment: { url, revision },
  });
  expect(project.sources).toEqual([]);
  expect(await Runner.revision(project, undefined, request)).toBe(revision);
  expect(await Project.deployed(project, request)).toBe(revision);
  expect(requests).toEqual([`GET:${url}`, `GET:${url}`]);
  await expect(
    Runner.revision(
      { ...project, deployment: { url, revision: "e".repeat(64) } },
      undefined,
      request,
    ),
  ).rejects.toThrow("does not match");
});

test("remote target accepts a generic JSON version endpoint", async () => {
  const revision: string = "d".repeat(40);
  const url: string = "https://target.example/api/version";
  const requests: string[] = [];
  const request = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push(`${init?.method}:${String(input)}`);

    return Response.json({ revision });
  };
  const project: Project.Project = Project.schema.parse({
    id: "remote",
    scenarios: ["home"],
    revision: "target",
    deployment: { url, revision },
  });
  expect(await Runner.revision(project, undefined, request)).toBe(revision);
  expect(requests).toEqual([`GET:${url}`]);
  await expect(
    Runner.revision(
      { ...project, deployment: { url, revision: "e".repeat(40) } },
      undefined,
      request,
    ),
  ).rejects.toThrow("does not match");
});
