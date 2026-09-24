import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import CONFIG from "@qa/config.json";
import * as Project from "@qa/project";

export const args = (
  project: Project.Project,
  revision: string,
  image: string,
  context: string,
): string[] => [
  "docker",
  "build",
  "-f",
  project.dockerfile || resolve(import.meta.dir, "../../Dockerfile"),
  "--build-context",
  `quaz=${resolve(import.meta.dir, "../..")}`,
  ...Object.entries({
    BUN_VERSION: CONFIG.bun,
    NODE_VERSION: CONFIG.node,
    CODEX_VERSION: CONFIG.codex,
    PLAYWRIGHT_MCP_VERSION: CONFIG.playwrightMcp,
    DOCKER_VERSION: CONFIG.docker,
    OP_VERSION: CONFIG.op,
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
    const context: string = await stage(project, directory);
    if (Runner.source({ ...project, root: context }) !== fingerprint)
      throw new Error("Staged QA image source differs from the project source");
    const child = Bun.spawn(args(project, revision, values.tag, context), {
      cwd: project.root,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await child.exited;
    if (process.exitCode === 0 && Runner.source(project) !== fingerprint)
      throw new Error("Project source changed during the QA image build");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
