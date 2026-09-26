import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as Review from "@qa/review";
import * as Eval from "@qa/verify-eval";

const sample = (): Eval.Case => ({
  id: "hidden-identifier",
  images: ["screen.png"],
  test: {
    expected: "Each item can be identified.",
    acceptance: ["Each row shows a distinct identifier."],
    steps: ["Inspect the recorded rows."],
  },
  observations: "The supplied screenshot records the selected rows.",
  labels: { verdict: "pass", checks: [true] },
});
const result = (): Review.Verification => ({
  status: "complete",
  verdict: "pass",
  expected: sample().test.expected,
  summary: "Both handles remain visible.",
  checks: [
    {
      criterion: sample().test.acceptance[0],
      passed: true,
      actual: "Distinct handles are visible.",
    },
  ],
  steps: ["Reviewed the recorded rows."],
  evidence: ["validator/image-1.png"],
});
let directory: string | undefined;
afterEach(async (): Promise<void> => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("verifier receives criteria and evidence without answer labels or case hints", (): void => {
  const value: string = Eval.prompt(sample(), "Worker policy");
  expect(value).toContain(Review.VERIFICATION_SCOPE);
  expect(value).toContain(Review.verificationPrompt({ test: sample().test }));
  expect(value).toContain(
    "Copy the supplied expected string exactly into expected",
  );
  expect(value).toContain(
    "Copy each supplied acceptance string exactly into checks[].criterion",
  );
  expect(value).toContain(sample().observations);
  expect(value).not.toContain(sample().id);
  expect(value).not.toContain('"labels"');
  expect(value).not.toContain('"verdict":"pass"');
  const changed: Eval.Case = sample();
  changed.labels = { verdict: "fail", checks: [false] };
  expect(Eval.prompt(changed, "Worker policy")).toBe(value);
});

test("scoring rejects false passes and false failures", (): void => {
  expect(Eval.problems(sample(), result())).toEqual([]);
  const failed: Review.Verification = {
    ...result(),
    verdict: "fail",
    checks: [{ ...result().checks[0], passed: false }],
  };
  expect(Eval.problems(sample(), failed)).toHaveLength(2);
  const broken: Eval.Case = {
    ...sample(),
    labels: { verdict: "fail", checks: [false] },
  };
  expect(Eval.problems(broken, failed)).toEqual([]);
  expect(Eval.problems(broken, result())).toHaveLength(2);
});

test("scoring rejects altered criteria and invented evidence", (): void => {
  expect(
    Eval.problems(sample(), { ...result(), expected: "A weaker outcome" }),
  ).toContain("changed expected result");
  for (const checks of [
    [],
    [...result().checks, ...result().checks],
    [{ ...result().checks[0], criterion: "Easier check" }],
  ])
    expect(Eval.problems(sample(), { ...result(), checks })).toContain(
      "changed or missing acceptance criteria",
    );
  expect(
    Eval.problems(sample(), {
      ...result(),
      evidence: ["validator/invented.png"],
    }),
  ).toContain("invented evidence path");
  expect(
    Eval.problems(sample(), {
      ...result(),
      evidence: ["validator/observations.json"],
    }),
  ).toContain("missing image evidence");
});

test("missing evidence stays blocked", (): void => {
  const blocked: Eval.Case = {
    ...sample(),
    labels: { verdict: "blocked", checks: [false] },
  };
  const value: Review.Verification = {
    ...result(),
    status: "blocked",
    verdict: "blocked",
    checks: [
      {
        ...result().checks[0],
        passed: false,
        actual: "The identifier is outside the saved image.",
      },
    ],
  };
  expect(Eval.problems(blocked, value)).toEqual([]);
  expect(Eval.problems(blocked, { ...value, status: "complete" })).toContain(
    "blocked evidence marked complete",
  );
  expect(Eval.problems(blocked, { ...value, verdict: "fail" })).toContain(
    "expected blocked, received fail",
  );
  expect(Eval.problems(sample(), { ...result(), status: "partial" })).toContain(
    "non-blocked verdict requires complete evidence",
  );
});

test("suite rejects contradictory or incomplete labels", (): void => {
  const suite = {
    version: "1",
    model: "stub",
    effort: "low",
    cases: [sample()],
  };
  expect(Eval.suiteSchema.safeParse(suite).success).toBe(true);
  expect(
    Eval.suiteSchema.safeParse({ ...suite, cases: [sample(), sample()] })
      .success,
  ).toBe(false);
  for (const labels of [
    { verdict: "pass", checks: [false] },
    { verdict: "fail", checks: [true] },
    { verdict: "blocked", checks: [] },
  ])
    expect(Eval.caseSchema.safeParse({ ...sample(), labels }).success).toBe(
      false,
    );
});

test("ambiguous checklist labels require review without relaxing the verdict", (): void => {
  const value: Eval.Case = {
    ...sample(),
    labels: {
      verdict: "fail",
      checks: [
        false,
        { review: "Identity can refer to a full name or a distinct handle." },
      ],
    },
  };
  value.test = {
    ...value.test,
    acceptance: [...value.test.acceptance, "Identity stays visible."],
  };
  expect(Eval.caseSchema.safeParse(value).success).toBe(true);
  const failure: Review.Verification = {
    ...result(),
    verdict: "fail",
    checks: [
      { ...result().checks[0], passed: false },
      {
        criterion: value.test.acceptance[1],
        passed: true,
        actual: "A distinct handle stays visible.",
      },
    ],
  };
  expect(Eval.problems(value, failure)).toEqual([]);
  expect(Eval.problems(value, { ...failure, verdict: "pass" })).toContain(
    "expected fail, received pass",
  );
  expect(Eval.prompt(value, "policy")).not.toContain("Identity can refer");
  const report: Eval.Report = {
    fingerprint: "test",
    complete: true,
    limits: "test",
    attempts: [
      {
        case: value.id,
        repeat: 1,
        problems: [],
        reviews: Eval.reviews(value),
        result: failure,
      },
    ],
  };
  expect(Eval.exitCode(report)).toBe(2);
  report.attempts[0].problems.push("wrong verdict");
  expect(Eval.exitCode(report)).toBe(1);
  expect(Eval.exitCode({ ...report, complete: false, attempts: [] })).toBe(1);
});

test("runs repeat independently and preserve model errors and frozen inputs", async (): Promise<void> => {
  directory = await mkdtemp(join(tmpdir(), "qa-verify-eval-"));
  const suite: string = join(directory, "suite.json");
  const output: string = join(directory, "nested", "output");
  await writeFile(join(directory, "screen.png"), "image bytes");
  await writeFile(
    suite,
    JSON.stringify({
      version: "1",
      model: "stub",
      effort: "low",
      cases: [sample()],
    }),
  );
  let calls: number = 0;
  const report: Eval.Report = await Eval.execute(
    { suite, output, policy: "Worker policy" },
    async (input): Promise<unknown> => {
      calls++;
      expect(input.schema).toBe(Review.verificationSchema);
      expect(input.images[0].toString()).toBe("image bytes");
      expect(input.prompt).not.toContain(sample().id);
      if (input.directory.endsWith(`${sample().id}-1`))
        throw new Error("model connection failed");

      return result();
    },
  );
  expect(calls).toBe(2);
  expect(report.complete).toBe(true);
  expect(report.attempts[0].problems).toEqual(["model connection failed"]);
  expect(report.attempts[1].problems).toEqual([]);
  expect(
    JSON.parse(await readFile(join(output, "report.json"), "utf8")),
  ).toEqual(report);
  expect(
    await readFile(
      join(output, "hidden-identifier-2/validator/image-1.png"),
      "utf8",
    ),
  ).toBe("image bytes");
  const inputs = JSON.parse(
    await readFile(join(output, "inputs.json"), "utf8"),
  );
  expect(inputs.images[0][0]).toMatch(/^[a-f0-9]{64}$/);
  expect(inputs.suite.cases[0].labels).toEqual(sample().labels);
  await expect(
    Eval.execute(
      { suite, output, policy: "Worker policy" },
      async (): Promise<unknown> => result(),
    ),
  ).rejects.toThrow("EEXIST");
  await expect(
    Eval.execute({
      suite,
      output: join(directory, "one"),
      policy: "Worker policy",
      repeats: 1,
    }),
  ).rejects.toThrow();
});

test("parallel calls stay bounded and preserve out-of-order results", async (): Promise<void> => {
  directory = await mkdtemp(join(tmpdir(), "qa-verify-parallel-"));
  const suite: string = join(directory, "suite.json");
  const output: string = join(directory, "output");
  await writeFile(join(directory, "screen.png"), "image bytes");
  await writeFile(
    suite,
    JSON.stringify({
      version: "1",
      model: "stub",
      effort: "low",
      cases: [sample(), { ...sample(), id: "second" }],
    }),
  );
  const first: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  const progressed: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  let calls: number = 0;
  let active: number = 0;
  let maximum: number = 0;
  const completed: number[] = [];
  const invoked: string[] = [];
  const pending: Promise<Eval.Report> = Eval.execute(
    { suite, output, policy: "policy" },
    async (input): Promise<unknown> => {
      const call: number = ++calls;
      invoked.push(basename(input.directory));
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (call === 1) await first.promise;
        const snapshot: Eval.Report = JSON.parse(
          await readFile(join(output, "report.json"), "utf8"),
        );
        expect(snapshot.complete).toBe(false);
        expect(snapshot.attempts).toHaveLength(4);
        expect(Eval.exitCode(snapshot)).toBe(1);
        if (call === 4) progressed.resolve();
        if (call === 3) throw new Error("one model attempt fails");

        return { ...result(), summary: `call ${call}` };
      } finally {
        completed.push(call);
        active--;
      }
    },
  );
  const deadline: ReturnType<typeof setTimeout> = setTimeout(
    (): void =>
      progressed.reject(
        new Error("Parallel lane cannot advance while the first call waits"),
      ),
    1000,
  );
  try {
    await progressed.promise;
  } finally {
    clearTimeout(deadline);
    first.resolve();
    await pending;
  }
  const report: Eval.Report = await pending;
  expect(maximum).toBe(2);
  expect(calls).toBe(4);
  expect(completed).toEqual([2, 3, 4, 1]);
  expect(report.complete).toBe(true);
  expect(
    report.attempts.map(
      (attempt): string => `${attempt.case}/${attempt.repeat}`,
    ),
  ).toEqual([
    "hidden-identifier/1",
    "hidden-identifier/2",
    "second/1",
    "second/2",
  ]);
  for (const attempt of report.attempts) {
    const call: number =
      invoked.indexOf(`${attempt.case}-${attempt.repeat}`) + 1;
    if (call === 3)
      expect(attempt.problems).toEqual(["one model attempt fails"]);
    else expect(attempt.result?.summary).toBe(`call ${call}`);
  }
  expect(Eval.exitCode(report)).toBe(1);
  expect(
    JSON.parse(await readFile(join(output, "report.json"), "utf8")),
  ).toEqual(report);
  const inputs = JSON.parse(
    await readFile(join(output, "inputs.json"), "utf8"),
  );
  expect(inputs.parallel).toBe(2);
});
