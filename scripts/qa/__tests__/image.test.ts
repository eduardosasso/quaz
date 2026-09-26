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

test("source projects need a derived image", () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-recipe-"));
  folders.push(folder);
  const dockerfile: string = join(folder, "Dockerfile");
  writeFileSync(dockerfile, "FROM source-one");
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    root: "/sample",
    dockerfile,
    sources: ["app.ts"],
    scenarios: ["empty"],
    revision: "source",
  });
  const fingerprint: string = "b".repeat(64);
  const base: string = `sha256:${"a".repeat(64)}`;
  const planned: { tag: string; build: boolean } = Runner.projectImage(
    project,
    base,
    fingerprint,
    "revision-one",
  );
  expect(
    Runner.projectImage(
      { ...project, revision: "git" },
      base,
      fingerprint,
      "revision-one",
    ),
  ).toEqual(planned);
  expect(planned.tag).toMatch(/^quaz:[a-f0-9]{32}$/);
  expect(planned.build).toBe(true);
  expect(
    Runner.projectImage(
      { ...project, id: "other" },
      base,
      fingerprint,
      "revision-one",
    ).tag,
  ).not.toBe(planned.tag);
  expect(
    Runner.projectImage(
      project,
      `sha256:${"c".repeat(64)}`,
      fingerprint,
      "revision-one",
    ).tag,
  ).not.toBe(planned.tag);
  expect(
    Runner.projectImage(project, base, fingerprint, "revision-two").tag,
  ).not.toBe(planned.tag);
  writeFileSync(dockerfile, "FROM source-two");
  expect(
    Runner.projectImage(project, base, fingerprint, "revision-one").tag,
  ).not.toBe(planned.tag);
  expect(
    Runner.projectImage(
      { ...project, revision: "target" },
      base,
      fingerprint,
      "revision-one",
    ),
  ).toEqual({ tag: base, build: false });
});

test.skipIf(Bun.which("python3") === null)(
  "deployment checks target source before startup",
  () => {
    const folder: string = mkdtempSync(join(tmpdir(), "quaz-source-gate-"));
    folders.push(folder);
    const config: string = join(folder, "project.json");
    const script: string = join(import.meta.dir, "../../source.py");
    const check = (): ReturnType<typeof Bun.spawnSync> =>
      Bun.spawnSync(["python3", script, config]);
    writeFileSync(
      config,
      JSON.stringify({ root: "app", sources: ["app.ts"], revision: "source" }),
    );
    expect(check().exitCode).not.toBe(0);
    mkdirSync(join(folder, "app"));
    writeFileSync(join(folder, "app/app.ts"), "export const value = true;");
    expect(check().exitCode).toBe(0);
    writeFileSync(
      config,
      JSON.stringify({
        root: "app",
        dockerfile: "app/Dockerfile",
        sources: ["app.ts"],
        revision: "source",
      }),
    );
    expect(check().exitCode).not.toBe(0);
    writeFileSync(join(folder, "app/Dockerfile"), "FROM scratch");
    expect(check().exitCode).toBe(0);
    writeFileSync(
      config,
      JSON.stringify({
        root: "app",
        dockerfile: "app/Dockerfile",
        sources: ["app.ts"],
        revision: "git",
      }),
    );
    expect(check().exitCode).not.toBe(0);
    expect(
      Bun.spawnSync(["git", "-C", join(folder, "app"), "init", "-q"]).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        join(folder, "app"),
        "add",
        "app.ts",
        "Dockerfile",
      ]).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        join(folder, "app"),
        "-c",
        "user.name=QA",
        "-c",
        "user.email=qa@example.test",
        "commit",
        "-qm",
        "fixture",
      ]).exitCode,
    ).toBe(0);
    expect(check().exitCode).toBe(0);
    const commit: string = Bun.spawnSync([
      "git",
      "-C",
      join(folder, "app"),
      "rev-parse",
      "HEAD",
    ])
      .stdout.toString()
      .trim();
    const version: string = join(folder, "version.json");
    writeFileSync(version, JSON.stringify({ revision: commit }));
    writeFileSync(
      config,
      JSON.stringify({
        root: "app",
        dockerfile: "app/Dockerfile",
        sources: ["app.ts"],
        revision: "git",
        deployment: { url: `file://${version}` },
      }),
    );
    expect(check().exitCode).toBe(0);
    writeFileSync(version, JSON.stringify({ revision: "a".repeat(40) }));
    expect(check().exitCode).not.toBe(0);
    writeFileSync(version, JSON.stringify({ revision: commit }));
    writeFileSync(join(folder, "app/app.ts"), "export const value = false;");
    expect(check().exitCode).not.toBe(0);
    writeFileSync(config, JSON.stringify({ revision: "target" }));
    expect(check().exitCode).toBe(0);
  },
);

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

test("controller reads the current project source revision", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-revision-"));
  folders.push(folder);
  writeFileSync(join(folder, "app.ts"), "first");
  const dockerfile: string = join(folder, "Dockerfile");
  writeFileSync(dockerfile, "FROM first");
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    root: folder,
    dockerfile,
    sources: ["app.ts"],
    scenarios: ["empty"],
    revision: "source",
  });
  const built: string = await Runner.revision(project);
  await Runner.checkRevision(project, built);
  writeFileSync(join(folder, "app.ts"), "second");
  expect(await Runner.revision(project)).not.toBe(built);
  await expect(Runner.checkRevision(project, built)).rejects.toThrow(
    "restart the QA controller",
  );
  const changed: string = await Runner.revision(project);
  writeFileSync(dockerfile, "FROM second");
  expect(await Runner.revision(project)).not.toBe(changed);
});

test("deployed Git revision must match the target checkout", async () => {
  const folder: string = mkdtempSync(join(tmpdir(), "quaz-deployed-git-"));
  folders.push(folder);
  writeFileSync(join(folder, "app.ts"), "export const value = true;");
  expect(Bun.spawnSync(["git", "-C", folder, "init", "-q"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", folder, "add", "app.ts"]).exitCode).toBe(
    0,
  );
  expect(
    Bun.spawnSync([
      "git",
      "-C",
      folder,
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.test",
      "commit",
      "-qm",
      "fixture",
    ]).exitCode,
  ).toBe(0);
  const commit: string = Bun.spawnSync([
    "git",
    "-C",
    folder,
    "rev-parse",
    "HEAD",
  ])
    .stdout.toString()
    .trim();
  const project: Project.Project = Project.schema.parse({
    id: "sample",
    root: folder,
    sources: ["app.ts"],
    scenarios: ["empty"],
    revision: "git",
    deployment: { url: "https://target.example/version" },
  });
  const current = async (): Promise<Response> =>
    Response.json({ revision: commit });
  const old = async (): Promise<Response> =>
    Response.json({ revision: "a".repeat(40) });
  expect(await Runner.revision(project, current)).toBe(commit);
  await expect(Runner.revision(project, old)).rejects.toThrow(
    "does not match the deployed revision",
  );
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
  expect(await Runner.revision(project, request)).toBe(revision);
  expect(await Project.deployed(project, request)).toBe(revision);
  expect(requests).toEqual([`GET:${url}`, `GET:${url}`]);
  await expect(
    Runner.revision(
      { ...project, deployment: { url, revision: "e".repeat(64) } },
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
  expect(await Runner.revision(project, request)).toBe(revision);
  expect(requests).toEqual([`GET:${url}`]);
  await expect(
    Runner.revision(
      { ...project, deployment: { url, revision: "e".repeat(40) } },
      request,
    ),
  ).rejects.toThrow("does not match");
});
