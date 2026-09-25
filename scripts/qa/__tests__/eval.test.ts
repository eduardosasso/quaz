import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Eval from "@qa/eval";
import * as Model from "@qa/eval-model";

const sample: Eval.Case = {
  id: "sample",
  split: "calibration",
  images: ["image.png"],
  context: "One saved image",
  scope: "Visible layout",
  expected: [],
  cautions: [],
};
const review: Eval.Review = {
  surfaces: [{ image: 1, consistency: "Coherent", composition: "Coherent" }],
  findings: [],
  limitations: [],
};
const input: Model.Input = {
  model: "opus",
  effort: "medium",
  seconds: 300,
  images: [Buffer.from("image")],
  prompt: "Grade this review",
  schema: Eval.gradeSchema,
  directory: "/tmp/judge-1",
};
const valid: Eval.Grade = { expected: [], findings: [], unsupported: [] };

test("retries an invalid visual grade once", async (): Promise<void> => {
  const directories: string[] = [];
  const runner: Eval.Runner = async (value: Model.Input): Promise<unknown> => {
    directories.push(value.directory);

    return directories.length === 1
      ? {
          ...valid,
          unsupported: [{ quote: "invented", reason: "No evidence" }],
        }
      : valid;
  };
  expect(await Eval.judge(runner, input, sample, review)).toEqual(valid);
  expect(directories).toEqual(["/tmp/judge-1", "/tmp/judge-1-retry"]);
});

test("does not retry a judge connection failure", async (): Promise<void> => {
  let calls: number = 0;
  const runner: Eval.Runner = async (): Promise<unknown> => {
    calls++;
    throw new Error("Connection failed");
  };
  await expect(Eval.judge(runner, input, sample, review)).rejects.toThrow(
    "Connection failed",
  );
  expect(calls).toBe(1);
});

test("retries a schema-invalid judge response once", async (): Promise<void> => {
  let calls: number = 0;
  const runner: Eval.Runner = async (): Promise<unknown> => {
    calls++;
    if (calls === 1) throw new Model.InvalidOutputError("Invalid schema");

    return valid;
  };
  expect(await Eval.judge(runner, input, sample, review)).toEqual(valid);
  expect(calls).toBe(2);
});

test("stops after two invalid judge responses", async (): Promise<void> => {
  let calls: number = 0;
  const runner: Eval.Runner = async (): Promise<unknown> => {
    calls++;
    throw new Model.InvalidOutputError("Invalid schema");
  };
  await expect(Eval.judge(runner, input, sample, review)).rejects.toThrow(
    "Invalid schema",
  );
  expect(calls).toBe(2);
});

test("keeps a valid unsupported verdict without retry", async (): Promise<void> => {
  let calls: number = 0;
  const unsupported: Eval.Grade = {
    ...valid,
    unsupported: [{ quote: "Coherent", reason: "Unproved claim" }],
  };
  const runner: Eval.Runner = async (): Promise<unknown> => {
    calls++;

    return unsupported;
  };
  expect(await Eval.judge(runner, input, sample, review)).toEqual(unsupported);
  expect(calls).toBe(1);
});

test("audits each saved-image review before judging", async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), "quaz-visual-audit-"));
  const seen: string[] = [];
  try {
    await writeFile(join(root, "image.png"), "image");
    await writeFile(
      join(root, "suite.json"),
      JSON.stringify({
        version: "test",
        model: "opus",
        effort: "medium",
        cases: [sample],
      }),
    );
    const runner: Eval.Runner = async (
      value: Model.Input,
    ): Promise<unknown> => {
      seen.push(value.directory);
      if (value.directory.endsWith("/reviewer"))
        return {
          ...review,
          surfaces: [
            { ...review.surfaces[0], composition: "Draft composition" },
          ],
        };
      if (value.directory.endsWith("/audit")) {
        expect(value.prompt).toContain("Draft composition");

        return {
          ...review,
          surfaces: [
            { ...review.surfaces[0], composition: "Audited composition" },
          ],
        };
      }
      expect(value.prompt).toContain("Audited composition");
      expect(value.prompt).not.toContain("Draft composition");

      return valid;
    };
    const result: Eval.Report = await Eval.execute(
      { suite: join(root, "suite.json"), output: join(root, "report") },
      runner,
    );
    expect(
      result.attempts.every(
        (attempt): boolean => attempt.status === "complete",
      ),
    ).toBe(true);
    expect(
      seen.filter((directory): boolean => directory.endsWith("/audit")),
    ).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
