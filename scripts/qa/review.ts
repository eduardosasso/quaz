import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { crc32, inflateSync } from "node:zlib";
import * as Inspect from "@qa/inspect";
import { z } from "zod";

export const DESIGN_PATH: string = resolve(import.meta.dir, "design.md");
export type Design = { path: string; content: string; sha256: string };
export const design = async (path: string = DESIGN_PATH): Promise<Design> => {
  const content: string = await readFile(path, "utf8");
  if (!content.trim()) throw new Error("Empty design review guidance");

  return {
    path,
    content,
    sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
  };
};

export const GUIDES = [
  "critique",
  "audit",
  "polish",
  "layout",
  "typeset",
  "adapt",
] as const;
export const HEURISTICS = [
  "status",
  "real-world",
  "control",
  "consistency",
  "prevention",
  "recognition",
  "efficiency",
  "minimalism",
  "recovery",
  "help",
] as const;
export const DIMENSIONS = [
  "accessibility",
  "performance",
  "theming",
  "responsive",
  "integrity",
] as const;
export const CHECKS = [
  "journey",
  "design",
  "navigation",
  "prevention",
  "recovery",
  "persistence",
  "states",
  "keyboard",
  "contrast",
  "motion",
  "performance",
  "theming",
  "integrity",
  "layout",
  "typography",
  "adapt",
] as const;
const INTERACTION_CHECKS: readonly string[] = [
  "navigation",
  "prevention",
  "recovery",
  "persistence",
  "states",
  "keyboard",
];
export const MAX_SCREENSHOTS: number = 3;
const evidenceSchema = z.array(
  z
    .string()
    .regex(/^(reviewer|validator)\/[^\s]+$/)
    .describe(
      "An existing file path relative to /output, such as reviewer/page-123.png. Never put observations or measurements here.",
    ),
);
const scoreSchema = z.number().int().min(0).max(4).nullable();
const guideSchema = z
  .object({
    status: z.enum(["complete", "partial", "blocked"]),
    note: z.string().min(1),
  })
  .strict();
const guidesSchema = z
  .object({
    critique: guideSchema,
    audit: guideSchema,
    polish: guideSchema,
    layout: guideSchema,
    typeset: guideSchema,
    adapt: guideSchema,
  })
  .strict();
export const flowSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().min(1),
    route: z.string().regex(/^\//),
    goal: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    expected: z.string().min(1),
    actual: z.string().min(1),
    status: z.enum(["pass", "fail", "blocked"]),
    evidence: evidenceSchema,
  })
  .strict();
export const candidateSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    guide: z.enum(GUIDES),
    impact: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    expected: z.string().min(1),
    actual: z.string().min(1),
    viewport: z.string().min(1),
    evidence: evidenceSchema.min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    fingerprint: z.string().min(1),
  })
  .strict();
const judgmentSchema = z.enum(["coherent", "concern", "unknown"]);
export const designSchema = z
  .object({
    controls: z
      .array(
        z
          .object({
            name: z.string().min(1),
            purpose: z.string().min(1),
            location: z.string().min(1),
            treatment: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    comparisons: z.array(
      z
        .object({
          controls: z.array(z.string().min(1)).min(2),
          basis: z.string().min(1),
          observation: z.string().min(1),
          verdict: judgmentSchema,
          reason: z.string().min(1),
          candidateId: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    noPeers: z.string().min(1).nullable(),
    composition: z
      .object({
        observation: z.string().min(1),
        alternative: z.string().min(1),
        tradeoff: z.string().min(1),
        verdict: judgmentSchema,
        candidateId: z.string().min(1).nullable(),
      })
      .strict(),
    evidence: evidenceSchema.min(1),
  })
  .strict();
export const assessmentSchema = z
  .object({
    flow: flowSchema,
    design: designSchema,
    guides: guidesSchema,
    critique: z.array(scoreSchema).length(HEURISTICS.length),
    audit: z.array(scoreSchema).length(DIMENSIONS.length),
    checks: z.array(
      z
        .object({
          id: z.enum(CHECKS),
          status: z.enum(["measured", "blocked"]),
          actual: z.string().min(1),
          evidence: evidenceSchema.min(1),
        })
        .strict(),
    ),
    screenshots: evidenceSchema.min(1).max(MAX_SCREENSHOTS),
    candidates: z.array(candidateSchema),
    limitations: z.array(z.string().min(1)),
  })
  .strict();
export const validationSchema = z
  .object({
    flowKey: z.string().min(1),
    status: z.enum(["complete", "partial", "blocked"]),
    summary: z.string().min(1),
    coverage: z
      .object({
        checked: z.array(z.enum(CHECKS)),
        unsupported: z.array(z.enum(CHECKS)),
      })
      .strict(),
    steps: z.array(z.string().min(1)).min(1),
    evidence: evidenceSchema.min(1),
    results: z.array(
      z
        .object({
          candidateId: z.string().min(1),
          verdict: z.enum(["confirmed", "rejected", "inconclusive"]),
          reason: z.string().min(1),
          steps: z.array(z.string().min(1)).min(1),
          evidence: evidenceSchema,
        })
        .strict(),
    ),
    limitations: z.array(z.string().min(1)),
  })
  .strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export const checkedEvidence = (
  checks: Assessment["checks"],
): Assessment["checks"] =>
  checks.map((check): Assessment["checks"][number] =>
    check.status === "measured" && INTERACTION_CHECKS.includes(check.id)
      ? {
          ...check,
          evidence: [...new Set([...check.evidence, "reviewer/events.jsonl"])],
        }
      : check,
  );
export type Candidate = z.infer<typeof candidateSchema>;
export type Validation = z.infer<typeof validationSchema>;
export const verificationSchema = z
  .object({
    status: z.enum(["complete", "partial", "blocked"]),
    verdict: z.enum(["pass", "fail", "blocked"]),
    expected: z.string().min(1),
    summary: z.string().min(1),
    checks: z
      .array(
        z
          .object({
            criterion: z.string().min(1),
            passed: z.boolean(),
            actual: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    steps: z.array(z.string().min(1)).min(1),
    evidence: evidenceSchema.min(1),
  })
  .strict();
export type Verification = z.infer<typeof verificationSchema>;
export type Score = z.infer<typeof scoreSchema>;
type Phase = "reviewer" | "validator";
const screenshotEvent = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.literal("mcp_tool_call"),
    server: z.literal("mobile"),
    tool: z.literal("browser_take_screenshot"),
    status: z.literal("completed"),
    error: z.null(),
    result: z.object({ content: z.array(z.unknown()) }),
  }),
});
const imageContent = z.object({
  type: z.literal("image"),
  data: z.string().min(1),
  mimeType: z.string().regex(/^image\//),
});
const textContent = z.object({ type: z.literal("text"), text: z.string() });
const SCREENSHOT_LINK: RegExp =
  /^- \[Screenshot of [^\]\r\n]+\]\(([^)\r\n]+)\)$/gm;
const SCREENSHOT_NAME: RegExp = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*\.png$/;
const CONTAINER_OUTPUT: string = "/output/";

const viewed = (log: string, phase: Phase): string[] =>
  log
    .split("\n")
    .filter((line: string): boolean => line.trim().length > 0)
    .flatMap((line: string): string[] => {
      const event = screenshotEvent.safeParse(JSON.parse(line) as unknown);
      if (
        !event.success ||
        !event.data.item.result.content.some(
          (item: unknown): boolean => imageContent.safeParse(item).success,
        )
      )
        return [];
      const links: string[] = event.data.item.result.content.flatMap(
        (item: unknown): string[] => {
          const content = textContent.safeParse(item);
          if (!content.success) return [];

          return Array.from(
            content.data.text.matchAll(SCREENSHOT_LINK),
            (match: RegExpExecArray): string => match[1] ?? "",
          );
        },
      );

      return links.flatMap((link: string): string[] => {
        const path: string = link.startsWith(CONTAINER_OUTPUT)
          ? link.slice(CONTAINER_OUTPUT.length)
          : link;
        const [folder, filename, extra]: string[] = path.split("/");
        if (
          folder !== phase ||
          !filename ||
          extra !== undefined ||
          !SCREENSHOT_NAME.test(filename)
        )
          return [];

        return [path];
      });
    });

export const visualAssessment = (log: string, value: Assessment): void => {
  const images: string[] = viewed(log, "reviewer");
  for (const path of value.screenshots) {
    if (!images.includes(path))
      throw new Error(
        `Mobile screenshot was not returned to the reviewer as an image: ${path}`,
      );
  }
  if (
    value.checks.some(
      (check): boolean => check.id === "design" && check.status === "measured",
    ) &&
    !images.some((path: string): boolean =>
      value.design.evidence.includes(path),
    )
  )
    throw new Error("Design judgment lacks a viewed screenshot");
};

export const visualValidation = (log: string, value: Validation): void => {
  const images: string[] = viewed(log, "validator");
  const groups: string[][] = [
    value.evidence,
    ...value.results
      .filter((result): boolean => result.verdict === "confirmed")
      .map((result): string[] => result.evidence),
  ];
  for (const references of groups) {
    if (!images.some((path: string): boolean => references.includes(path)))
      throw new Error(
        "Validator evidence lacks a screenshot returned to the reviewer as an image",
      );
  }
};

export const score = (
  entries: Score[],
  names: readonly string[],
): { total: number; maximum: number; unscored: string[] } => ({
  total: entries.reduce(
    (total: number, entry: Score): number => total + (entry ?? 0),
    0,
  ),
  maximum: entries.filter((entry: Score): boolean => entry !== null).length * 4,
  unscored: names.filter(
    (_, index: number): boolean => entries[index] === null,
  ),
});

export const coverage = (
  review: Assessment,
  validation: Validation,
): {
  status: "complete" | "partial";
  guides: Assessment["guides"];
  scores: {
    critique: ReturnType<typeof score>;
    audit: ReturnType<typeof score>;
  };
} => {
  const complete: boolean =
    CHECKS.every(
      (id): boolean =>
        review.checks.filter(
          (check): boolean => check.id === id && check.status === "measured",
        ).length === 1,
    ) &&
    CHECKS.every((id): boolean => validation.coverage.checked.includes(id)) &&
    validation.coverage.unsupported.length === 0 &&
    validation.status === "complete" &&
    review.design.composition.verdict !== "unknown" &&
    review.design.comparisons.every(
      (comparison): boolean => comparison.verdict !== "unknown",
    ) &&
    review.flow.status !== "blocked" &&
    GUIDES.every(
      (name): boolean => review.guides[name].status === "complete",
    ) &&
    [...review.critique, ...review.audit].every(
      (entry): boolean => entry !== null,
    ) &&
    validation.results.every(
      (result): boolean => result.verdict !== "inconclusive",
    );

  return {
    status: complete ? "complete" : "partial",
    guides: review.guides,
    scores: {
      critique: score(review.critique, HEURISTICS),
      audit: score(review.audit, DIMENSIONS),
    },
  };
};

const exact = (
  actual: string[],
  expected: readonly string[],
  label: string,
): void => {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== expected.length ||
    expected.some((name: string): boolean => !actual.includes(name))
  )
    throw new Error(`${label} must appear exactly once`);
};

export const evidence = async (root: string, name: string): Promise<string> => {
  if (isAbsolute(name))
    throw new Error(`Evidence paths must be relative: ${name}`);
  const directory: string = await realpath(root);
  const path: string = await realpath(resolve(directory, name));
  const inside: string = relative(directory, path);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error(`Evidence escapes the output directory: ${name}`);
  const details = await stat(path);
  if (!details.isFile() || details.size === 0)
    throw new Error(`Evidence is missing or empty: ${name}`);

  return path;
};

const PNG_SIGNATURE: string = "89504e470d0a1a0a";
const PNG_HEADER_BYTES: number = 8;
const PNG_CHUNK_OVERHEAD: number = 12;
const PNG_IHDR_BYTES: number = 13;
const PNG_MAX_PIXELS: number = 32_000_000;
const PNG_CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  4: 2,
  6: 4,
};

const screenshot = async (root: string, name: string): Promise<void> => {
  const path: string = await evidence(root, name);
  const image: Buffer = Buffer.from(await Bun.file(path).arrayBuffer());
  if (image.subarray(0, PNG_HEADER_BYTES).toString("hex") !== PNG_SIGNATURE)
    throw new Error(`Screenshot is not a valid PNG: ${name}`);
  let offset: number = PNG_HEADER_BYTES;
  let width: number = 0;
  let height: number = 0;
  let channels: number = 0;
  let ended: boolean = false;
  const data: Buffer[] = [];
  while (offset + PNG_CHUNK_OVERHEAD <= image.length) {
    const length: number = image.readUInt32BE(offset);
    const end: number = offset + PNG_CHUNK_OVERHEAD + length;
    if (end > image.length)
      throw new Error(`Truncated PNG screenshot: ${name}`);
    const type: string = image.toString("ascii", offset + 4, offset + 8);
    if (
      crc32(image.subarray(offset + 4, end - 4)) !== image.readUInt32BE(end - 4)
    )
      throw new Error(`Corrupt PNG screenshot: ${name}`);
    const bytes: Buffer = image.subarray(offset + 8, end - 4);
    if (offset === PNG_HEADER_BYTES && type !== "IHDR")
      throw new Error(`PNG header is missing: ${name}`);
    if (type === "IHDR") {
      if (
        offset !== PNG_HEADER_BYTES ||
        length !== PNG_IHDR_BYTES ||
        bytes[8] !== 8 ||
        bytes[10] !== 0 ||
        bytes[11] !== 0 ||
        bytes[12] !== 0
      )
        throw new Error(`Unsupported PNG screenshot: ${name}`);
      width = bytes.readUInt32BE(0);
      height = bytes.readUInt32BE(4);
      channels = PNG_CHANNELS[bytes[9]] ?? 0;
    }
    if (type === "IDAT") data.push(bytes);
    if (type === "IEND") {
      ended = length === 0 && end === image.length;
      break;
    }
    offset = end;
  }
  if (
    !ended ||
    !width ||
    !height ||
    !channels ||
    width * height > PNG_MAX_PIXELS ||
    data.length === 0
  )
    throw new Error(`Incomplete PNG screenshot: ${name}`);
  const stride: number = width * channels + 1;
  const pixels: Buffer = inflateSync(Buffer.concat(data), {
    maxOutputLength: height * stride,
  });
  if (pixels.length !== height * stride)
    throw new Error(`Invalid PNG image data: ${name}`);
  for (let row: number = 0; row < height; row++) {
    if (pixels[row * stride] > 4)
      throw new Error(`Invalid PNG row filter: ${name}`);
  }
};

const events = (log: string): unknown[] =>
  log
    .split("\n")
    .filter((line): boolean => !!line.trim())
    .map((line): unknown => JSON.parse(line));
const interactionSchema = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.literal("mcp_tool_call"),
    server: z.literal("mobile"),
    tool: z.string(),
    status: z.literal("completed"),
    error: z.null(),
    arguments: z.record(z.string(), z.unknown()),
  }),
});
export const interactionActions = (log: string): string[] =>
  events(log).flatMap((event): string[] => {
    const parsed = interactionSchema.safeParse(event);
    if (!parsed.success) return [];
    const { tool, arguments: args } = parsed.data.item;
    if (tool === "browser_click") return ["click"];
    if (tool === "browser_fill_form") return ["fill"];
    if (tool === "browser_press_key") return ["press"];
    if (tool === "browser_navigate") return ["goto"];
    if (tool === "browser_navigate_back") return ["goBack"];
    if (!["browser_run_code", "browser_run_code_unsafe"].includes(tool))
      return [];

    return Array.from(
      String(args.code ?? "").matchAll(
        /\.(click|fill|press|reload|goto|goBack|check)\(/g,
      ),
      (match): string => match[1],
    );
  });
export const interactionSupport = (
  checks: Assessment["checks"],
  log: string,
): void => {
  const measured = checks.filter(
    (check): boolean =>
      INTERACTION_CHECKS.includes(check.id) && check.status === "measured",
  );
  if (!measured.length) return;
  const actions: string[] = interactionActions(log);
  if (actions.length < measured.length)
    throw new Error("Measured checks lack distinct browser actions");
  if (
    measured.some((check): boolean => check.id === "keyboard") &&
    !actions.includes("press")
  )
    throw new Error("Measured keyboard check lacks a key action");
  if (
    measured.some((check): boolean => check.id === "persistence") &&
    !actions.some((action): boolean =>
      ["reload", "goto", "goBack"].includes(action),
    )
  )
    throw new Error("Measured persistence check lacks a return action");
};
const inspectionEvent = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.literal("mcp_tool_call"),
    server: z.literal("mobile"),
    tool: z.enum(["browser_run_code", "browser_run_code_unsafe"]),
    status: z.literal("completed"),
    error: z.null(),
    arguments: z.object({ code: z.string() }),
    result: z.object({ content: z.array(z.unknown()) }),
  }),
});
export const technical = async (
  root: string,
  value: Assessment,
  sourceRoot: string,
): Promise<void> => {
  const path: string = "reviewer/technical.json";
  const encoded: string = await readFile(await evidence(root, path), "utf8");
  const result = Inspect.bindingSchema.parse(JSON.parse(encoded));
  const metadata = z
    .object({ runId: z.string(), commit: z.string(), origin: z.string() })
    .parse(JSON.parse(await readFile(resolve(root, "metadata.json"), "utf8")));
  if (
    result.runId !== metadata.runId ||
    result.revision !== metadata.commit ||
    result.flow !== value.flow.key ||
    new URL(result.url).origin !== metadata.origin
  )
    throw new Error("Technical evidence belongs to another review");
  const paths: string[] = result.detector.files.length
    ? await Inspect.source(
        sourceRoot,
        result.detector.files.map((file): string => file.path),
      )
    : [];
  for (const [index, path] of paths.entries()) {
    const digest: string = new Bun.CryptoHasher("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (digest !== result.detector.files[index].sha256)
      throw new Error("Technical source hash does not match the app");
  }
  const digest: string = new Bun.CryptoHasher("sha256")
    .update(encoded)
    .digest("hex");
  const receipt: boolean = events(
    await readFile(resolve(root, "reviewer/events.jsonl"), "utf8"),
  ).some((event): boolean => {
    const parsed = inspectionEvent.safeParse(event);
    if (!parsed.success) return false;
    const expression = parsed.data.item.arguments.code
      .trim()
      .match(
        /^async\s*\(\s*page\s*\)\s*=>\s*(?:await\s+)?page\.qaInspect\(([\s\S]*)\)\s*;?$/,
      );
    if (!expression) return false;
    let args: unknown;
    try {
      args = JSON.parse(`[${expression[1]}]`);
    } catch {
      return false;
    }
    const invocation = z
      .tuple([
        z.literal(result.flow),
        z.literal(result.selector),
        z.array(z.string()),
      ])
      .safeParse(args);
    if (
      !invocation.success ||
      invocation.data[2].length !== result.detector.files.length
    )
      return false;
    if (
      result.detector.files.some(
        (file, index): boolean =>
          relative(
            sourceRoot,
            resolve(
              sourceRoot,
              invocation.data[2][index].replace(/^\/app\//, ""),
            ),
          ) !== file.path,
      )
    )
      return false;
    return parsed.data.item.result.content.some((content): boolean => {
      const text = textContent.safeParse(content);
      if (!text.success) return false;
      const resultText = text.data.text.match(
        /### Result\n([\s\S]*?)(?:\n### |$)/,
      );
      if (!resultText) return false;
      try {
        return z
          .object({
            evidence: z.literal("reviewer/technical.json"),
            sha256: z.literal(digest),
            flow: z.literal(result.flow),
            url: z.literal(result.url),
            selector: z.literal(result.selector),
          })
          .safeParse(JSON.parse(resultText[1])).success;
      } catch {
        return false;
      }
    });
  });
  if (!receipt)
    throw new Error(
      "Technical evidence lacks its successful inspection receipt",
    );
};

export const assessment = async (
  input: unknown,
  root: string,
  sourceRoot: string = resolve(import.meta.dir, "../.."),
): Promise<Assessment> => {
  const parsed: Assessment = assessmentSchema.parse(input);
  const value: Assessment = {
    ...parsed,
    checks: checkedEvidence(parsed.checks),
  };
  const controls: string[] = value.design.controls.map(
    (control): string => control.name,
  );
  if (new Set(controls).size !== controls.length)
    throw new Error("Design control names must be distinct");
  for (const comparison of value.design.comparisons) {
    if (
      new Set(comparison.controls).size !== comparison.controls.length ||
      comparison.controls.some(
        (name: string): boolean => !controls.includes(name),
      )
    )
      throw new Error(
        "Design comparisons must reference distinct inventoried controls",
      );
  }
  if (
    (value.design.comparisons.length === 0) !==
    (value.design.noPeers !== null)
  )
    throw new Error(
      "Explain absent design peers only when no comparison exists",
    );
  for (const judgment of [
    ...value.design.comparisons,
    value.design.composition,
  ]) {
    if (
      judgment.verdict === "concern"
        ? !value.candidates.some(
            (candidate): boolean => candidate.id === judgment.candidateId,
          )
        : judgment.candidateId !== null
    )
      throw new Error(
        "Each design concern must link to an existing candidate; other judgments use null",
      );
  }
  exact(
    value.checks.map((check): string => check.id),
    CHECKS,
    "Required checks",
  );
  interactionSupport(
    value.checks,
    await readFile(resolve(root, "reviewer/events.jsonl"), "utf8"),
  );
  if (
    value.checks.some(
      (check): boolean =>
        ["performance", "theming", "integrity"].includes(check.id) &&
        check.status === "measured",
    )
  ) {
    const path: string = "reviewer/technical.json";
    await technical(root, value, sourceRoot);
    for (const id of ["performance", "theming", "integrity"]) {
      const check = value.checks.find((entry): boolean => entry.id === id);
      if (check?.status === "measured" && !check.evidence.includes(path))
        throw new Error(`${id} lacks its measured technical evidence`);
    }
  }
  exact(
    value.candidates.map((candidate): string => candidate.id),
    [...new Set(value.candidates.map((candidate): string => candidate.id))],
    "Candidate IDs",
  );
  if (new Set(value.screenshots).size !== value.screenshots.length)
    throw new Error("Screenshot references must be distinct");
  if (value.flow.status !== "blocked" && value.flow.evidence.length === 0)
    throw new Error("Executed case lacks evidence");
  if (
    [...value.critique, ...value.audit].some(
      (entry): boolean => entry !== null,
    ) &&
    value.flow.evidence.length === 0
  )
    throw new Error("Numeric scores lack shared case evidence");
  const references: string[] = [
    ...value.flow.evidence,
    ...value.design.evidence,
    ...value.candidates.flatMap((candidate): string[] => candidate.evidence),
    ...value.checks.flatMap((check): string[] => check.evidence),
  ];
  await Promise.all(
    [...new Set(references)].map(
      (name: string): Promise<string> => evidence(root, name),
    ),
  );
  await Promise.all(
    value.screenshots.map(
      (name: string): Promise<void> => screenshot(root, name),
    ),
  );

  return value;
};

const validatorScreenshot = async (
  root: string,
  references: string[],
): Promise<void> => {
  const directory: string = await realpath(resolve(root, "validator"));
  for (const name of references.filter((value: string): boolean =>
    value.endsWith(".png"),
  )) {
    const canonical: string = relative(directory, await evidence(root, name));
    if (
      canonical === ".." ||
      canonical.startsWith(`..${sep}`) ||
      isAbsolute(canonical)
    )
      continue;
    await screenshot(root, name);

    return;
  }
  throw new Error("Independent review lacks a fresh validator screenshot");
};

export const verification = async (
  input: unknown,
  root: string,
): Promise<Verification> => {
  const value: Verification = verificationSchema.parse(input);
  await Promise.all(
    value.evidence.map((name: string): Promise<string> => evidence(root, name)),
  );
  await validatorScreenshot(root, value.evidence);
  if (
    value.verdict === "pass" &&
    (value.status !== "complete" ||
      value.checks.some((check): boolean => !check.passed))
  )
    throw new Error("Incomplete acceptance tests cannot pass");
  if (
    value.verdict === "fail" &&
    value.checks.every((check): boolean => check.passed)
  )
    throw new Error("Failure needs a failed acceptance check");
  return value;
};
export const visualVerification = (log: string, value: Verification): void => {
  if (
    !viewed(log, "validator").some((path: string): boolean =>
      value.evidence.includes(path),
    )
  )
    throw new Error("Verification needs an inspected screenshot");
};

export const validation = async (
  input: unknown,
  root: string,
  flowKey: string,
  candidates: Candidate[],
): Promise<Validation> => {
  const value: Validation = validationSchema.parse(input);
  if (value.flowKey !== flowKey)
    throw new Error("Validator reviewed a different flow");
  exact(
    value.results.map((result): string => result.candidateId),
    candidates.map((candidate): string => candidate.id),
    "Candidate verdicts",
  );
  await Promise.all(
    value.evidence.map((name: string): Promise<string> => evidence(root, name)),
  );
  await validatorScreenshot(root, value.evidence);
  for (const result of value.results) {
    await Promise.all(
      result.evidence.map(
        (name: string): Promise<string> => evidence(root, name),
      ),
    );
    if (result.verdict === "confirmed")
      await validatorScreenshot(root, result.evidence);
  }

  return value;
};
