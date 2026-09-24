import CONFIG from "@qa/config.json";
export type Invocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};
export type Input = {
  work: string;
  schema: string;
  result: string;
  browser: string[];
  model?: string;
};
export type Provider = { invocation: (input: Input) => Invocation };
const codex: Provider = {
  invocation: (input: Input): Invocation => ({
    command: "codex",
    args: [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      input.work,
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "-c",
      `model_reasoning_effort=${JSON.stringify(CONFIG.reasoningEffort)}`,
      "--output-schema",
      input.schema,
      "-o",
      input.result,
      ...input.browser,
      ...(input.model ? ["--model", input.model] : []),
      "-",
    ],
    env: { PATH: process.env.PATH, HOME: "/tmp", CODEX_HOME: "/credential" },
  }),
};
export const select = (name: string): Provider => {
  if (name !== "codex") throw new Error("Only the Codex provider is available");
  return codex;
};
