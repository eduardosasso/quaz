import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Eval from "@qa/eval";
import type * as Model from "@qa/eval-model";
import * as Review from "@qa/review";

type Suite = ReturnType<typeof Eval.suiteSchema.parse>;
type Fixture = {
  root: string;
  suite: string;
  prompt: string;
  cases: Suite["cases"];
};

const PRIVATE: string = "PRIVATE_LABEL_SENTINEL";
const CALIBRATION_IMAGE: string = "calibration image bytes";
const HOLDOUT_IMAGE: string = "holdout image bytes";
const directories: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    directories
      .splice(0)
      .map(
        (directory: string): Promise<void> =>
          rm(directory, { recursive: true, force: true }),
      ),
  );
});

const sample = (
  id: string,
  split: Eval.Case["split"],
  image: string,
): Eval.Case => ({
  id,
  split,
  images: [image],
  context: `${split} recorded browser observation: viewport width 390`,
  scope: `${PRIVATE} scope`,
  expected: [
    { id: "hidden-concern", image: 1, criterion: `${PRIVATE} criterion` },
  ],
  cautions: [`${PRIVATE} caution`],
});

const fixture = async (): Promise<Fixture> => {
  const root: string = await mkdtemp(join(tmpdir(), "qa-eval-split-"));
  directories.push(root);
  const suite: string = join(root, "suite.json");
  const prompt: string = join(root, "prompt.md");
  const cases: Eval.Case[] = [
    sample("calibration-case", "calibration", "calibration.png"),
    sample("holdout-header", "holdout", "holdout.png"),
    sample("holdout-contrast", "holdout", "holdout-copy.png"),
  ];
  const value: Suite = {
    version: "split-test",
    model: "test-model",
    effort: "medium",
    cases,
  };
  await Promise.all([
    writeFile(suite, JSON.stringify(value)),
    writeFile(prompt, "Review the saved evidence."),
    writeFile(join(root, "calibration.png"), CALIBRATION_IMAGE),
    writeFile(join(root, "holdout.png"), HOLDOUT_IMAGE),
    writeFile(join(root, "holdout-copy.png"), HOLDOUT_IMAGE),
  ]);

  return { root, suite, prompt, cases };
};

const runner = (calls: Model.Input[]): Eval.Runner => {
  return async (input: Model.Input): Promise<unknown> => {
    calls.push(input);
    if (input.schema === Eval.reviewSchema)
      return {
        surfaces: [
          {
            image: 1,
            consistency: "No visible exception",
            composition: "One task group",
          },
        ],
        findings: [],
        limitations: ["Saved observations only"],
      } satisfies Eval.Review;

    return {
      expected: [
        {
          id: "hidden-concern",
          found: false,
          finding: null,
          quote: "",
          reason: "No matching finding",
        },
      ],
      findings: [],
      unsupported: [],
    } satisfies Eval.Grade;
  };
};

test("default execution excludes holdout evidence and hidden labels", async (): Promise<void> => {
  const source: Fixture = await fixture();
  const calls: Model.Input[] = [];
  const output: string = join(source.root, "default");
  const report: Eval.Report = await Eval.execute(
    { suite: source.suite, prompt: source.prompt, output },
    runner(calls),
  );
  expect(report.cases).toEqual(["calibration-case"]);
  expect(report.attempts).toHaveLength(2);
  expect(calls).toHaveLength(6);
  for (const input of calls) {
    expect(
      input.images.map((image: Buffer): string => image.toString()),
    ).toEqual([CALIBRATION_IMAGE]);
    if (input.schema !== Eval.reviewSchema) continue;
    expect(input.prompt).toContain(source.cases[0].context);
    expect(input.prompt).not.toContain(PRIVATE);
    expect(input.prompt).not.toContain("hidden-concern");
    expect(input.prompt).not.toContain("holdout");
  }
  const inputs: string = await readFile(join(output, "inputs.json"), "utf8");
  expect(inputs).not.toContain("holdout-header");
  expect(inputs).not.toContain("holdout-contrast");
});

test("eval defaults to the same design guidance as live review", async (): Promise<void> => {
  const source: Fixture = await fixture();
  const design: Review.Design = await Review.design();
  const calls: Model.Input[] = [];
  const output: string = join(source.root, "shared");
  const report: Eval.Report = await Eval.execute(
    { suite: source.suite, output },
    runner(calls),
  );
  expect(report.prompt).toBe(design.sha256);
  expect(await readFile(join(output, "reviewer.md"), "utf8")).toBe(
    design.content,
  );
  const reviewers: Model.Input[] = calls.filter(
    (input: Model.Input): boolean => input.schema === Eval.reviewSchema,
  );
  expect(reviewers).toHaveLength(2);
  for (const input of reviewers) {
    expect(input.prompt.split(design.content)).toHaveLength(2);
    expect(input.prompt).toContain("No tools or outside context");
    expect(input.prompt).not.toContain(PRIVATE);
  }
});

test("a candidate override does not change the shared guidance", async (): Promise<void> => {
  const source: Fixture = await fixture();
  const before: Review.Design = await Review.design();
  const calls: Model.Input[] = [];
  const report: Eval.Report = await Eval.execute(
    {
      suite: source.suite,
      prompt: source.prompt,
      output: join(source.root, "candidate"),
    },
    runner(calls),
  );
  expect(report.prompt).not.toBe(before.sha256);
  expect(await Review.design()).toEqual(before);
  for (const input of calls.filter(
    (input: Model.Input): boolean => input.schema === Eval.reviewSchema,
  )) {
    expect(input.prompt).toContain("Review the saved evidence.");
    expect(input.prompt).not.toContain(before.content);
  }
});

test("explicit holdout and all selections keep duplicate scenes together", async (): Promise<void> => {
  const source: Fixture = await fixture();
  for (const split of ["holdout", "all"] as const) {
    const calls: Model.Input[] = [];
    const report: Eval.Report = await Eval.execute(
      {
        suite: source.suite,
        prompt: source.prompt,
        output: join(source.root, split),
        split,
      },
      runner(calls),
    );
    const selected: Eval.Case[] = source.cases.filter(
      (entry: Eval.Case): boolean => split === "all" || entry.split === split,
    );
    expect(report.cases).toEqual(
      selected.map((entry: Eval.Case): string => entry.id),
    );
    expect(report.attempts).toHaveLength(selected.length * 2);
    expect(calls).toHaveLength(selected.length * 6);
    if (split === "holdout")
      expect(
        calls.every(
          (input: Model.Input): boolean =>
            input.images[0].toString() === HOLDOUT_IMAGE,
        ),
      ).toBe(true);
  }
});

test("same bytes under different paths cannot cross splits", async (): Promise<void> => {
  const source: Fixture = await fixture();
  await writeFile(join(source.root, "holdout-copy.png"), CALIBRATION_IMAGE);
  const calls: Model.Input[] = [];
  const output: string = join(source.root, "rejected");
  await expect(
    Eval.execute(
      { suite: source.suite, prompt: source.prompt, output },
      runner(calls),
    ),
  ).rejects.toThrow("both calibration and holdout");
  expect(calls).toHaveLength(0);
  await expect(access(output)).rejects.toThrow();
});

test("split mismatch rejects a baseline before model calls or output creation", async (): Promise<void> => {
  const source: Fixture = await fixture();
  const baseline: string = join(source.root, "baseline");
  await Eval.execute(
    { suite: source.suite, prompt: source.prompt, output: baseline },
    runner([]),
  );
  for (const split of ["holdout", "all"] as const) {
    const calls: Model.Input[] = [];
    const output: string = join(source.root, `candidate-${split}`);
    await expect(
      Eval.execute(
        {
          suite: source.suite,
          prompt: source.prompt,
          output,
          baseline: join(baseline, "report.json"),
          split,
        },
        runner(calls),
      ),
    ).rejects.toThrow("Incompatible baseline");
    expect(calls).toHaveLength(0);
    await expect(access(output)).rejects.toThrow();
  }
});

test("recorded evidence changes invalidate a baseline while prompt changes remain comparable", async (): Promise<void> => {
  const source: Fixture = await fixture();
  const baseline: string = join(source.root, "baseline");
  const original: Eval.Report = await Eval.execute(
    { suite: source.suite, prompt: source.prompt, output: baseline },
    runner([]),
  );
  await writeFile(
    source.prompt,
    "Review saved evidence and state the uncertainty.",
  );
  const candidate: Eval.Report = await Eval.execute(
    {
      suite: source.suite,
      prompt: source.prompt,
      output: join(source.root, "new-prompt"),
      baseline: join(baseline, "report.json"),
    },
    runner([]),
  );
  expect(candidate.prompt).not.toBe(original.prompt);
  expect(candidate.fingerprint).toBe(original.fingerprint);
  expect(Eval.compare(original, candidate)).toEqual([]);
  const suite: Suite = Eval.suiteSchema.parse(
    JSON.parse(await readFile(source.suite, "utf8")),
  );
  suite.cases[0].context = "Recorded browser observation: viewport width 844";
  await writeFile(source.suite, JSON.stringify(suite));
  const calls: Model.Input[] = [];
  const output: string = join(source.root, "new-evidence");
  await expect(
    Eval.execute(
      {
        suite: source.suite,
        prompt: source.prompt,
        output,
        baseline: join(baseline, "report.json"),
      },
      runner(calls),
    ),
  ).rejects.toThrow("Incompatible baseline");
  expect(calls).toHaveLength(0);
  await expect(access(output)).rejects.toThrow();
});
