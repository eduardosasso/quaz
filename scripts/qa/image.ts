import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import CONFIG from "@qa/config.json";
import * as Project from "@qa/project";
import { z } from "zod";

const ROOT: string = resolve(import.meta.dir, "../..");
const BASE: string = `${CONFIG.image}:base`;
const SOURCE: string = "https://github.com/eduardosasso/quaz";
export const matches = (
  labels: Record<string, string> | undefined,
  revision: string,
): boolean =>
  labels?.["org.opencontainers.image.source"] === SOURCE &&
  labels["org.opencontainers.image.revision"] === revision;
const SOURCES: string[] = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "Dockerfile.release",
  "src",
  "scripts",
  "examples",
];
const files = (path: string): string[] =>
  statSync(path).isDirectory()
    ? readdirSync(path)
        .sort()
        .flatMap((name: string): string[] => files(join(path, name)))
    : [path];
export const source = (): string => {
  const digest = createHash("sha256");
  for (const path of SOURCES.flatMap((entry: string): string[] =>
    files(join(ROOT, entry)),
  ))
    digest.update(path.slice(ROOT.length)).update(readFileSync(path));

  return digest.digest("hex");
};
export const baseArgs = (revision: string, version: string): string[] => [
  "docker",
  "build",
  "-f",
  join(ROOT, "Dockerfile.release"),
  ...Object.entries({
    BUN_VERSION: CONFIG.bun,
    NODE_VERSION: CONFIG.node,
    CLAUDE_VERSION: CONFIG.claude,
    IMPECCABLE_VERSION: CONFIG.impeccable,
    IMPECCABLE_SHA256: CONFIG.impeccableSha256,
    IMPECCABLE_ENGINE_VERSION: CONFIG.impeccableEngine,
    IMPECCABLE_ENGINE_ARM64_SHA256: CONFIG.impeccableEngineArm64Sha256,
    IMPECCABLE_ENGINE_X64_SHA256: CONFIG.impeccableEngineX64Sha256,
    PLAYWRIGHT_MCP_VERSION: CONFIG.playwrightMcp,
    DOCKER_VERSION: CONFIG.docker,
    OP_VERSION: CONFIG.op,
    SOURCE_REVISION: revision,
    IMAGE_VERSION: version,
  }).flatMap(([key, value]: [string, string]): string[] => [
    "--build-arg",
    `${key}=${value}`,
  ]),
  "-t",
  BASE,
  ROOT,
];
export const base = async (): Promise<string> => {
  const pinned: string = process.env.QUAZ_BASE_IMAGE ?? "";
  if (pinned) {
    if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(pinned))
      throw new Error("QUAZ_BASE_IMAGE must use an immutable image digest");
    const status = Bun.spawnSync(
      ["git", "status", "--porcelain", "--untracked-files=normal"],
      { cwd: ROOT },
    );
    if (status.exitCode !== 0 || status.stdout.toString().trim())
      throw new Error("Published Quaz base requires a clean source checkout");
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT });
    if (commit.exitCode !== 0)
      throw new Error("Cannot read the Quaz source revision");
    const pull = Bun.spawn(["docker", "pull", pinned], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await pull.exited) !== 0)
      throw new Error("Cannot pull the pinned Quaz base image");
    const inspect = Bun.spawnSync(["docker", "image", "inspect", pinned], {
      cwd: ROOT,
    });
    if (inspect.exitCode !== 0)
      throw new Error("Cannot inspect the pinned Quaz base image");
    const details = z
      .array(
        z.object({
          Config: z.object({ Labels: z.record(z.string(), z.string()) }),
        }),
      )
      .parse(JSON.parse(inspect.stdout.toString()));
    const labels = details[0]?.Config.Labels;
    if (!matches(labels, commit.stdout.toString().trim()))
      throw new Error("Pinned Quaz base does not match this source revision");

    return pinned;
  }
  const revision: string = source();
  const packageFile: { version: string } = await Bun.file(
    join(ROOT, "package.json"),
  ).json();
  const build = Bun.spawn(baseArgs(revision, packageFile.version), {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0)
    throw new Error("Quaz base image build failed");
  if (source() !== revision)
    throw new Error("Quaz source changed during the base image build");
  const inspect = Bun.spawn(
    ["docker", "image", "inspect", "--format", "{{.Id}}", BASE],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [id, errors, code] = await Promise.all([
    new Response(inspect.stdout).text(),
    new Response(inspect.stderr).text(),
    inspect.exited,
  ]);
  if (code !== 0) throw new Error(`Quaz base image inspect failed: ${errors}`);

  return `${BASE}@${id.trim()}`;
};
export const args = (
  project: Project.Project,
  revision: string,
  image: string,
  context: string,
  base: string,
): string[] => [
  "docker",
  "build",
  "-f",
  project.dockerfile || resolve(import.meta.dir, "../../Dockerfile"),
  ...Object.entries({
    QUAZ_BASE: base,
    QA_REVISION: revision,
  }).flatMap(([key, value]): string[] => ["--build-arg", `${key}=${value}`]),
  "-t",
  image,
  context,
];
export const stage = async (
  project: Project.Project,
  directory: string,
): Promise<string> => {
  const context: string = join(directory, "context");
  await mkdir(context);
  for (const source of project.sources) {
    const destination: string = join(context, source);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await cp(join(project.root, source), destination, { recursive: true });
  }
  return context;
};
if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      project: {
        type: "string",
        default: "",
      },
      tag: { type: "string", default: `${CONFIG.image}:local` },
    },
  });
  if (!values.project) throw new Error("--project is required");
  const project: Project.Project = Project.load(resolve(values.project));
  const Runner = await import("@qa/run");
  const revision: string = await Runner.revision(project);
  const fingerprint: string = Runner.source(project);
  const directory: string = await mkdtemp(join(tmpdir(), "quaz-build-"));
  try {
    const pinned: string = await base();
    const context: string = await stage(project, directory);
    if (Runner.source({ ...project, root: context }) !== fingerprint)
      throw new Error("Staged QA image source differs from the project source");
    const child = Bun.spawn(
      args(project, revision, values.tag, context, pinned),
      {
        cwd: project.root,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    process.exitCode = await child.exited;
    if (process.exitCode === 0 && Runner.source(project) !== fingerprint)
      throw new Error("Project source changed during the QA image build");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
