import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Inspect from "@qa/inspect";
import * as Review from "@qa/review";
import { z } from "zod";

const PNG: Buffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
let root: string;
const report = (): Review.Assessment => ({
  flow: {
    key: "card-create",
    title: "Create card",
    route: "/qa/board",
    goal: "Save a card",
    steps: ["Open editor", "Save title"],
    expected: "Card appears",
    actual: "Card appears",
    status: "pass",
    evidence: ["reviewer/mobile.png"],
  },
  design: {
    controls: [
      {
        name: "Title",
        purpose: "Name the card",
        location: "Body",
        treatment: "Exposed field",
      },
      {
        name: "Description",
        purpose: "Describe the card",
        location: "Body",
        treatment: "Exposed field",
      },
      {
        name: "Save",
        purpose: "Commit changes",
        location: "Footer",
        treatment: "Primary button",
      },
    ],
    comparisons: [
      {
        controls: ["Title", "Description"],
        basis: "Core content editing",
        observation: "Both fields stay exposed",
        verdict: "coherent",
        candidateId: null,
        reason: "Both are needed for the main task",
      },
    ],
    noPeers: null,
    composition: {
      observation: "Core fields precede Save",
      alternative: "Hide description behind a control",
      tradeoff: "Less space but an extra step for core content",
      verdict: "coherent",
      candidateId: null,
    },
    evidence: ["reviewer/mobile.png"],
  },
  guides: {
    critique: { status: "complete", note: "Clear action and save feedback" },
    audit: {
      status: "partial",
      note: "Names and overflow checked; performance, theming, and detector integrity unmeasured",
    },
    polish: {
      status: "complete",
      note: "Save result matches neighboring controls",
    },
    layout: { status: "complete", note: "Mobile grouping checked" },
    typeset: { status: "complete", note: "Labels match same-role text" },
    adapt: { status: "complete", note: "Touch controls fit at 390px" },
  },
  critique: [3, 3, 3, 3, null, 3, null, 3, null, null],
  audit: [2, null, null, 2, null],
  checks: Review.CHECKS.map((id) => ({
    id,
    status: "blocked",
    actual: "Not exercised",
    evidence: ["reviewer/mobile.png"],
  })),
  screenshots: ["reviewer/mobile.png"],
  candidates: [
    {
      id: "review-overflow",
      title: "Editor overflows",
      severity: "P2",
      guide: "adapt",
      impact: "Save leaves the viewport",
      steps: ["Open editor at 390px"],
      expected: "Controls fit",
      actual: "Save is clipped",
      viewport: "390x844",
      evidence: ["reviewer/mobile.png"],
      acceptance: ["Save remains visible at 390px"],
      fingerprint: "card-create:editor-overflow",
    },
  ],
  limitations: ["Only one mobile case; no physical device"],
});
const validation = (): Review.Validation => ({
  flowKey: "card-create",
  status: "complete",
  summary: "Repeated mobile editor case",
  coverage: { checked: [...Review.CHECKS], unsupported: [] },
  steps: ["Open at 390px"],
  evidence: ["validator/reproduction.png"],
  results: [
    {
      candidateId: "review-overflow",
      verdict: "confirmed",
      reason: "Save clips after repeated steps",
      steps: ["Open at 390px"],
      evidence: ["validator/reproduction.png"],
    },
  ],
  limitations: [],
});
const complete = (): Review.Assessment => {
  const value: Review.Assessment = report();
  value.guides.audit = {
    status: "complete",
    note: "All applicable scope checks measured",
  };
  value.critique = Review.HEURISTICS.map((): number => 3);
  value.audit = Review.DIMENSIONS.map((): number => 3);
  value.checks = Review.CHECKS.map((id) => ({
    id,
    status: "measured",
    actual: "Observed in this case",
    evidence: ["reviewer/events.jsonl", "reviewer/technical.json"],
  }));

  return value;
};

beforeEach(async (): Promise<void> => {
  root = await mkdtemp(join(tmpdir(), "qa-review-test-"));
  await mkdir(join(root, "reviewer"));
  await mkdir(join(root, "validator"));
  await writeFile(join(root, "reviewer/mobile.png"), PNG);
  await writeFile(join(root, "validator/reproduction.png"), PNG);
  await writeFile(
    join(root, "card.tsx"),
    "export const Card = () => <main>Card</main>;",
  );
  await writeFile(
    join(root, "metadata.json"),
    JSON.stringify({
      runId: "case-run",
      commit: "a".repeat(40),
      origin: "http://127.0.0.1:3001",
    }),
  );
  await writeFile(
    join(root, "reviewer/technical.json"),
    JSON.stringify({
      runId: "case-run",
      revision: "a".repeat(40),
      flow: "card-create",
      url: "http://127.0.0.1:3001/qa/board",
      selector: "main",
      detector: {
        status: "complete",
        files: [
          {
            path: "card.tsx",
            sha256: new Bun.CryptoHasher("sha256")
              .update(await readFile(join(root, "card.tsx")))
              .digest("hex"),
          },
        ],
        findings: [],
      },
      measurements: Inspect.CONDITIONS.map((condition) => ({
        condition,
        data: {
          url: "http://127.0.0.1:3001/qa/board",
          viewport:
            Inspect.VIEWPORTS[condition as keyof typeof Inspect.VIEWPORTS] ??
            Inspect.VIEWPORTS.mobile,
          document: { width: 390, height: 844 },
          surface: {
            selector: "main",
            text: "Card",
            count: 1,
            truncated: false,
          },
          media: {
            dark: condition === "dark",
            reduced: condition === "reduced-motion",
            landscape: condition === "landscape",
          },
          fonts: "loaded",
          background: "white",
          performance: {
            navigation: [{ duration: 5, domContentLoadedEventEnd: 4 }],
            paint: [],
            resources: [],
          },
          elements: [
            {
              tag: "MAIN",
              text: "Card",
              rect: { x: 0, y: 0, width: 390, height: 100 },
              contrast: 21,
              clipped: false,
              size: condition === "text-200-percent" ? "32px" : "16px",
              originalSize: condition === "text-200-percent" ? 16 : null,
              font: "sans-serif",
            },
          ],
        },
      })),
    }),
  );
  await writeFile(
    join(root, "reviewer/events.jsonl"),
    [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "mobile",
          tool: "browser_click",
          status: "completed",
          error: null,
          arguments: { element: "Save" },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "mobile",
          tool: "browser_run_code_unsafe",
          status: "completed",
          error: null,
          arguments: {
            code: 'async (page) => await page.qaInspect("card-create", "main", ["card.tsx"])',
          },
          result: {
            content: [
              {
                type: "text",
                text:
                  "### Result\n" +
                  JSON.stringify({
                    evidence: "reviewer/technical.json",
                    sha256: new Bun.CryptoHasher("sha256")
                      .update(
                        await readFile(join(root, "reviewer/technical.json")),
                      )
                      .digest("hex"),
                    flow: "card-create",
                    url: "http://127.0.0.1:3001/qa/board",
                    selector: "main",
                  }),
              },
            ],
          },
        },
      }),
    ].join("\n"),
  );
});
afterEach(async (): Promise<void> => {
  await rm(root, { recursive: true, force: true });
});

describe("compact QA schema", (): void => {
  test("design concerns cannot disappear before ticket validation", async (): Promise<void> => {
    const input: Review.Assessment = report();
    input.design.comparisons[0].verdict = "concern";
    await expect(Review.assessment(input, root)).rejects.toThrow(
      "must link to an existing candidate",
    );
    input.design.comparisons[0].candidateId = "missing";
    await expect(Review.assessment(input, root)).rejects.toThrow(
      "must link to an existing candidate",
    );
    input.design.comparisons[0].candidateId = input.candidates[0].id;
    await expect(Review.assessment(input, root)).resolves.toEqual(input);
    input.design.composition.verdict = "concern";
    await expect(Review.assessment(input, root)).rejects.toThrow(
      "must link to an existing candidate",
    );
    input.design.composition.candidateId = input.candidates[0].id;
    await expect(Review.assessment(input, root)).resolves.toEqual(input);
  });
  test("coherent and unknown judgments cannot imply a design candidate", async (): Promise<void> => {
    for (const verdict of ["coherent", "unknown"] as const) {
      const input: Review.Assessment = report();
      input.design.comparisons[0].verdict = verdict;
      input.design.comparisons[0].candidateId = input.candidates[0].id;
      await expect(Review.assessment(input, root)).rejects.toThrow(
        "other judgments use null",
      );
    }
  });
  test("guide summaries cannot replace design comparisons", async (): Promise<void> => {
    const { design: omitted, ...input } = report();
    expect(omitted.comparisons).toHaveLength(1);
    await expect(Review.assessment(input, root)).rejects.toThrow();
  });
  test("design comparisons reference distinct observed controls", async (): Promise<void> => {
    for (const names of [
      ["Title", "Missing"],
      ["Title", "Title"],
    ]) {
      const input: Review.Assessment = report();
      input.design.comparisons[0].controls = names;
      await expect(Review.assessment(input, root)).rejects.toThrow(
        "inventoried controls",
      );
    }
  });
  test("design inventory rejects repeated controls", async (): Promise<void> => {
    const input: Review.Assessment = report();
    input.design.controls.push(input.design.controls[0]);
    await expect(Review.assessment(input, root)).rejects.toThrow(
      "control names must be distinct",
    );
  });
  test("a surface without peers needs a reason, not a fabricated comparison", async (): Promise<void> => {
    const input: Review.Assessment = report();
    input.design.controls = [input.design.controls[2]];
    input.design.comparisons = [];
    await expect(Review.assessment(input, root)).rejects.toThrow(
      "Explain absent design peers",
    );
    input.design.noPeers = "Only the primary action is present";
    input.candidates = [];
    expect((await Review.assessment(input, root)).candidates).toEqual([]);
  });
  test("design evidence must exist", async (): Promise<void> => {
    const input: Review.Assessment = report();
    input.design.evidence = ["reviewer/absent.png"];
    await expect(Review.assessment(input, root)).rejects.toThrow();
  });
  test("output schemas avoid nonstandard string formats", (): void => {
    for (const schema of [Review.assessmentSchema, Review.validationSchema])
      expect(JSON.stringify(z.toJSONSchema(schema))).not.toContain('"format"');
    expect(
      Review.flowSchema.safeParse({ ...report().flow, route: "dashboard" })
        .success,
    ).toBe(false);
    expect(
      Review.flowSchema.safeParse({ ...report().flow, route: "/dashboard" })
        .success,
    ).toBe(true);
  });
  test("one mobile case and image are sufficient", async (): Promise<void> => {
    const value: Review.Assessment = await Review.assessment(report(), root);
    expect(value.screenshots).toEqual(["reviewer/mobile.png"]);
    expect(value.critique).toHaveLength(10);
    expect(value.audit).toHaveLength(5);
  });

  test("evidence schema rejects observations presented as file paths", (): void => {
    const input: Review.Assessment = report();
    input.flow.evidence = ["DOM bounding rectangle: x=318, y=320"];
    expect(Review.assessmentSchema.safeParse(input).success).toBe(false);
    input.flow.evidence = ["reviewer/events.jsonl"];
    expect(Review.assessmentSchema.safeParse(input).success).toBe(true);
    input.candidates[0].evidence = ["Account box=326,36,40,40"];
    expect(Review.assessmentSchema.safeParse(input).success).toBe(false);
  });
  test("requires all six guides", async (): Promise<void> => {
    const input: Review.Assessment = report();
    const { adapt: omitted, ...guides } = input.guides;
    expect(omitted.status).toBe("complete");
    await expect(
      Review.assessment({ ...input, guides }, root),
    ).rejects.toThrow();
  });
  test("rejects a whole guide marked inapplicable", async (): Promise<void> => {
    const input: Review.Assessment = report();
    await expect(
      Review.assessment(
        {
          ...input,
          guides: {
            ...input.guides,
            audit: { status: "not-applicable", note: "skipped" },
          },
        },
        root,
      ),
    ).rejects.toThrow();
  });
  test("rejects broad screenshot reports", async (): Promise<void> => {
    const input: Review.Assessment = report();
    input.screenshots = Array.from(
      { length: Review.MAX_SCREENSHOTS + 1 },
      (): string => "reviewer/mobile.png",
    );
    await expect(Review.assessment(input, root)).rejects.toThrow();
  });
  test("rejects unsupported numeric scores", async (): Promise<void> => {
    const input: Review.Assessment = report();
    input.critique[0] = 5;
    await expect(Review.assessment(input, root)).rejects.toThrow();
  });
  test("scores require shared case evidence", async (): Promise<void> => {
    const input: Review.Assessment = report();
    input.flow.status = "blocked";
    input.flow.evidence = [];
    await expect(Review.assessment(input, root)).rejects.toThrow(
      "scores lack shared case evidence",
    );
  });
  test("totals exclude every unmeasured criterion", (): void => {
    expect(Review.score([3, null], ["status", "recovery"])).toEqual({
      total: 3,
      maximum: 4,
      unscored: ["recovery"],
    });
  });
});

describe("QA evidence", (): void => {
  test("rejects missing screenshots", async (): Promise<void> => {
    await rm(join(root, "reviewer/mobile.png"));
    await expect(Review.assessment(report(), root)).rejects.toThrow();
  });
  test("rejects text renamed as an image", async (): Promise<void> => {
    await writeFile(join(root, "reviewer/mobile.png"), "not a screenshot");
    await expect(Review.assessment(report(), root)).rejects.toThrow(
      "not a valid PNG",
    );
  });
  test("rejects headers without image data", async (): Promise<void> => {
    await writeFile(join(root, "reviewer/mobile.png"), PNG.subarray(0, 8));
    await expect(Review.assessment(report(), root)).rejects.toThrow(
      "Incomplete PNG",
    );
  });
  test("rejects corrupt image data", async (): Promise<void> => {
    const corrupt: Buffer = Buffer.from(PNG);
    corrupt[corrupt.length - 1] = 0;
    await writeFile(join(root, "reviewer/mobile.png"), corrupt);
    await expect(Review.assessment(report(), root)).rejects.toThrow(
      "Corrupt PNG",
    );
  });
  test("rejects evidence outside the output directory", async (): Promise<void> => {
    const outside: string = await mkdtemp(join(tmpdir(), "qa-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "private");
      await symlink(join(outside, "secret.txt"), join(root, "secret.txt"));
      await expect(Review.evidence(root, "secret.txt")).rejects.toThrow(
        "escapes",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  test("rejects duplicate candidate IDs", async (): Promise<void> => {
    const input: Review.Assessment = report();
    input.candidates.push({ ...input.candidates[0] });
    await expect(Review.assessment(input, root)).rejects.toThrow(
      "Candidate IDs",
    );
  });
});

describe("QA independent validation", (): void => {
  test("accepts repeated candidates", async (): Promise<void> => {
    expect(
      (
        await Review.validation(
          validation(),
          root,
          "card-create",
          report().candidates,
        )
      ).results[0].verdict,
    ).toBe("confirmed");
  });
  test("requires a fresh validator screenshot", async (): Promise<void> => {
    const input: Review.Validation = validation();
    input.results[0].evidence = ["reviewer/mobile.png"];
    await expect(
      Review.validation(input, root, "card-create", report().candidates),
    ).rejects.toThrow("fresh validator screenshot");
  });
  test("rejects traversal disguised as validator evidence", async (): Promise<void> => {
    const input: Review.Validation = validation();
    input.results[0].evidence = ["validator/../reviewer/mobile.png"];
    await expect(
      Review.validation(input, root, "card-create", report().candidates),
    ).rejects.toThrow("fresh validator screenshot");
  });
  test("requires independent evidence with zero candidates", async (): Promise<void> => {
    const input: Review.Validation = {
      ...validation(),
      results: [],
      evidence: ["reviewer/mobile.png"],
    };
    await expect(
      Review.validation(input, root, "card-create", []),
    ).rejects.toThrow("fresh validator screenshot");
  });
  test("requires a verdict for every candidate", async (): Promise<void> => {
    await expect(
      Review.validation(
        { ...validation(), results: [] },
        root,
        "card-create",
        report().candidates,
      ),
    ).rejects.toThrow("Candidate verdicts");
  });
  test("rejects another flow", async (): Promise<void> => {
    await expect(
      Review.validation(validation(), root, "card-move", report().candidates),
    ).rejects.toThrow("different flow");
  });
});

describe("QA coverage", (): void => {
  test("unknown design comparisons cannot complete", (): void => {
    const input: Review.Assessment = complete();
    input.design.comparisons[0].verdict = "unknown";
    expect(Review.coverage(input, validation()).status).toBe("partial");
  });
  test("unsupported design evidence cannot complete", (): void => {
    const input: Review.Validation = validation();
    input.coverage.unsupported = ["design"];
    expect(Review.coverage(complete(), input).status).toBe("partial");
  });
  test("complete checks accept measured source and execution evidence", async (): Promise<void> => {
    expect(await Review.assessment(complete(), root, root)).toEqual(complete());
  });
  test("native inspection permits whitespace in its expression", async (): Promise<void> => {
    const path: string = join(root, "reviewer/events.jsonl");
    const entries = (await readFile(path, "utf8"))
      .split("\n")
      .map((line): { item: { arguments?: { code?: string } } } =>
        JSON.parse(line),
      );
    for (const entry of entries) {
      if (entry.item.arguments?.code)
        entry.item.arguments.code = `async (page) =>\n await page.qaInspect("card-create", "main", ["card.tsx"]);`;
    }
    await writeFile(
      path,
      entries.map((entry): string => JSON.stringify(entry)).join("\n"),
    );
    expect(await Review.assessment(complete(), root, root)).toEqual(complete());
  });
  test("other browser code cannot forge an inspection receipt", async (): Promise<void> => {
    const path: string = join(root, "reviewer/events.jsonl");
    const entries = (await readFile(path, "utf8"))
      .split("\n")
      .map((line): { item: { arguments?: { code?: string } } } =>
        JSON.parse(line),
      );
    for (const entry of entries) {
      if (entry.item.arguments?.code)
        entry.item.arguments.code = `async (page) => { return {}; /* ${entry.item.arguments.code} */ }`;
    }
    await writeFile(
      path,
      entries.map((entry): string => JSON.stringify(entry)).join("\n"),
    );
    await expect(Review.assessment(complete(), root, root)).rejects.toThrow(
      "inspection receipt",
    );
  });
  test("screenshot-only events cannot establish interactions", async (): Promise<void> => {
    await writeFile(
      join(root, "reviewer/events.jsonl"),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "mobile",
          tool: "browser_take_screenshot",
          status: "completed",
          error: null,
          arguments: {},
        },
      }),
    );
    await expect(Review.assessment(complete(), root, root)).rejects.toThrow(
      "successful browser interactions",
    );
  });
  test("empty technical data cannot establish completion", async (): Promise<void> => {
    const path: string = join(root, "reviewer/technical.json");
    const artifact = JSON.parse(await readFile(path, "utf8"));
    artifact.measurements = [{ condition: "invented", data: {} }];
    await writeFile(path, JSON.stringify(artifact));
    await expect(Review.assessment(complete(), root, root)).rejects.toThrow();
  });
  test("source edits invalidate a measured hash", async (): Promise<void> => {
    await writeFile(join(root, "card.tsx"), "Changed source");
    await expect(Review.assessment(complete(), root, root)).rejects.toThrow(
      "source hash",
    );
  });
  test("artifact changes invalidate the execution receipt", async (): Promise<void> => {
    const path: string = join(root, "reviewer/technical.json");
    const artifact = JSON.parse(await readFile(path, "utf8"));
    artifact.detector.findings = ["invented"];
    await writeFile(path, JSON.stringify(artifact));
    await expect(Review.assessment(complete(), root, root)).rejects.toThrow(
      "inspection receipt",
    );
  });
  test("square viewport cannot establish landscape", async (): Promise<void> => {
    const artifact = Inspect.bindingSchema.parse(
      JSON.parse(await readFile(join(root, "reviewer/technical.json"), "utf8")),
    );
    const landscape = artifact.measurements.find(
      (entry): boolean => entry.condition === "landscape",
    );
    if (!landscape) throw new Error("Missing landscape fixture");
    landscape.data.viewport.height = 844;
    expect(Inspect.bindingSchema.safeParse(artifact).success).toBe(false);
  });
  test("guide labels and scores cannot replace required checks", (): void => {
    const value = complete();
    value.checks = [];
    expect(Review.coverage(value, validation()).status).toBe("partial");
  });
  test("unsupported checks cannot complete", (): void => {
    const value = validation();
    value.coverage.unsupported = ["recovery"];
    expect(Review.coverage(complete(), value).status).toBe("partial");
  });
  test("technical evidence cannot come from another flow", async (): Promise<void> => {
    const value = complete();
    value.flow.key = "different-flow";
    await expect(Review.assessment(value, root)).rejects.toThrow(
      "another review",
    );
  });
  test("measured interactions require browser evidence", async (): Promise<void> => {
    const value = complete();
    value.checks = value.checks.map((check) =>
      check.id === "recovery"
        ? { ...check, evidence: ["reviewer/mobile.png"] }
        : check,
    );
    await expect(Review.assessment(value, root)).rejects.toThrow(
      "browser interaction evidence",
    );
  });
  test("complete requires review and independent validation", (): void => {
    expect(Review.coverage(complete(), validation()).status).toBe("complete");
  });
  test("partial guides keep coverage partial", (): void => {
    const input: Review.Assessment = complete();
    input.guides.layout.status = "partial";
    expect(Review.coverage(input, validation()).status).toBe("partial");
  });
  test("unmeasured scores keep coverage partial", (): void => {
    const input: Review.Assessment = complete();
    input.audit[1] = null;
    expect(Review.coverage(input, validation()).status).toBe("partial");
  });
  test("blocked core cases keep coverage partial", (): void => {
    const input: Review.Assessment = complete();
    input.flow.status = "blocked";
    expect(Review.coverage(input, validation()).status).toBe("partial");
  });
  test("blocked zero-candidate validation cannot pass", (): void => {
    expect(
      Review.coverage(complete(), {
        ...validation(),
        status: "blocked",
        results: [],
      }).status,
    ).toBe("partial");
  });
  test("unfinished zero-candidate validation cannot pass", (): void => {
    expect(
      Review.coverage(complete(), {
        ...validation(),
        status: "partial",
        results: [],
      }).status,
    ).toBe("partial");
  });
  test("inconclusive candidates keep coverage partial", (): void => {
    const input: Review.Validation = validation();
    input.results[0].verdict = "inconclusive";
    expect(Review.coverage(complete(), input).status).toBe("partial");
  });
});

describe("QA image delivery", (): void => {
  const event = (
    path: string,
    image: boolean = true,
    server: string = "mobile",
    completed: boolean = true,
  ): string =>
    JSON.stringify({
      type: completed ? "item.completed" : "item.started",
      item: {
        type: "mcp_tool_call",
        server,
        tool: "browser_take_screenshot",
        status: completed ? "completed" : "in_progress",
        error: null,
        result: {
          content: [
            {
              type: "text",
              text: `### Result\n- [Screenshot of viewport](${path})\n### Ran Playwright code`,
            },
            ...(image
              ? [
                  {
                    type: "image",
                    data: PNG.toString("base64"),
                    mimeType: "image/png",
                  },
                ]
              : []),
          ],
        },
      },
    });
  test("accepts one linked mobile image response", (): void => {
    expect((): void =>
      Review.visualAssessment(event("reviewer/mobile.png"), report()),
    ).not.toThrow();
  });
  test("measured design requires its own viewed image reference", (): void => {
    const input: Review.Assessment = complete();
    input.design.evidence = ["reviewer/events.jsonl"];
    expect((): void =>
      Review.visualAssessment(event("reviewer/mobile.png"), input),
    ).toThrow("Design judgment lacks a viewed screenshot");
    input.design.evidence.push("reviewer/mobile.png");
    expect((): void =>
      Review.visualAssessment(event("reviewer/mobile.png"), input),
    ).not.toThrow();
  });
  test("rejects saved images returned as text only", (): void => {
    expect((): void =>
      Review.visualAssessment(event("reviewer/mobile.png", false), report()),
    ).toThrow("not returned to the reviewer as an image");
  });
  test("requires the claimed path to match its image response", (): void => {
    expect((): void =>
      Review.visualAssessment(event("reviewer/other.png"), report()),
    ).toThrow("not returned");
  });
  test("requires mobile session evidence", (): void => {
    expect((): void =>
      Review.visualAssessment(
        event("reviewer/mobile.png", true, "desktop"),
        report(),
      ),
    ).toThrow("not returned");
  });
  test("ignores incomplete screenshot calls", (): void => {
    expect((): void =>
      Review.visualAssessment(
        event("reviewer/mobile.png", true, "mobile", false),
        report(),
      ),
    ).toThrow("not returned");
  });
  test("accepts known absolute container links", (): void => {
    expect((): void =>
      Review.visualAssessment(event("/output/reviewer/mobile.png"), report()),
    ).not.toThrow();
  });
  test("rejects traversal in generated links", (): void => {
    expect((): void =>
      Review.visualValidation(
        event("validator/../validator/reproduction.png"),
        validation(),
      ),
    ).toThrow("lacks a screenshot");
  });
  test("each confirmed candidate needs image-returned evidence", (): void => {
    const input: Review.Validation = validation();
    input.results[0].evidence = ["validator/unviewed.png"];
    expect((): void =>
      Review.visualValidation(event("validator/reproduction.png"), input),
    ).toThrow("lacks a screenshot");
  });
  test("zero-candidate validation still needs an inline image", (): void => {
    expect((): void =>
      Review.visualValidation(event("validator/reproduction.png", false), {
        ...validation(),
        results: [],
      }),
    ).toThrow("lacks a screenshot");
  });
});
