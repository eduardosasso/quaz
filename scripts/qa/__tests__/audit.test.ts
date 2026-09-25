import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as Audit from "@qa/audit";
import * as Review from "@qa/review";
import * as Worker from "@qa/worker";

const evidence: string[] = ["reviewer/screen.png"];
const functional: Review.Candidate = {
  id: "review-functional",
  title: "Save fails",
  severity: "P2",
  guide: "audit",
  impact: "The note is lost",
  steps: ["Save the note"],
  expected: "The note persists",
  actual: "The note disappears",
  viewport: "390x844",
  evidence,
  acceptance: ["The note persists"],
  fingerprint: "save-fails",
};
const visual: Review.Candidate = {
  ...functional,
  id: "review-visual",
  title: "Footer choices scatter",
  guide: "layout",
  fingerprint: "footer-scatter",
};
const original: Review.Assessment = Review.assessmentSchema.parse({
  flow: {
    key: "note",
    title: "Note",
    route: "/notes",
    goal: "Save a note",
    steps: ["Open notes"],
    expected: "A note saves",
    actual: "The note is visible",
    status: "pass",
    evidence,
  },
  design: {
    controls: [
      {
        name: "Tag",
        purpose: "Classify",
        location: "Footer",
        treatment: "Text",
      },
      {
        name: "Save",
        purpose: "Commit",
        location: "Footer",
        treatment: "Button",
      },
    ],
    comparisons: [
      {
        controls: ["Tag", "Save"],
        basis: "Footer grouping",
        observation: "Controls use different treatments",
        verdict: "coherent",
        reason: "They serve different tasks",
        candidateId: null,
      },
    ],
    noPeers: null,
    composition: {
      observation: "Choices scatter",
      alternative: "The spacing may be intentional",
      tradeoff: "A compact footer takes less space",
      verdict: "concern",
      candidateId: visual.id,
    },
    evidence,
  },
  guides: Object.fromEntries(
    Review.GUIDES.map(
      (name: string): [string, { status: string; note: string }] => [
        name,
        { status: "complete", note: "Checked" },
      ],
    ),
  ),
  critique: Review.HEURISTICS.map((): null => null),
  audit: Review.DIMENSIONS.map((): null => null),
  checks: Review.CHECKS.map((id) => ({
    id,
    status: "blocked",
    actual: "Not checked",
    evidence,
  })),
  screenshots: evidence,
  candidates: [functional, visual],
  limitations: ["One image only"],
});

test("visual audit keeps existing candidates and accepts a revised design", () => {
  const result: Review.Assessment = Audit.merge(original, {
    design: {
      ...original.design,
      composition: {
        ...original.design.composition,
        verdict: "coherent",
        candidateId: null,
      },
    },
    candidates: [functional, visual],
    limitations: ["One image only", "A live check is needed"],
  });
  expect(result.flow).toEqual(original.flow);
  expect(result.checks).toEqual(original.checks);
  expect(result.candidates).toEqual([functional, visual]);
  expect(result.design.composition.candidateId).toBeNull();
});

test("visual audit cannot change a functional candidate", () => {
  expect(() =>
    Audit.merge(original, {
      design: original.design,
      candidates: [
        { ...functional, actual: "Something else happened" },
        visual,
      ],
      limitations: original.limitations,
    }),
  ).toThrow("Visual audit changed existing candidate review-functional");
});

test("visual audit cannot remove a design-linked functional candidate", () => {
  expect(() =>
    Audit.merge(original, {
      design: original.design,
      candidates: [functional],
      limitations: original.limitations,
    }),
  ).toThrow("Visual audit changed existing candidate review-visual");
});

test("new visual candidate needs an attached screenshot", () => {
  expect(() =>
    Audit.merge(original, {
      design: original.design,
      candidates: [
        functional,
        visual,
        { ...visual, id: "review-new", evidence: ["reviewer/unseen.png"] },
      ],
      limitations: original.limitations,
    }),
  ).toThrow("Visual audit candidate lacks an attached screenshot: review-new");
});

test("visual audit design needs an attached screenshot", () => {
  expect(() =>
    Audit.merge(original, {
      design: { ...original.design, evidence: ["reviewer/unseen.png"] },
      candidates: [functional, visual],
      limitations: original.limitations,
    }),
  ).toThrow("Visual audit design lacks an attached screenshot");
});

test("runtime audit preserves candidates for independent validation", () => {
  const prompt: string = Audit.prompt(
    "image 1 is reviewer/screen.png",
    original,
    "runtime",
  );
  expect(prompt).toContain("Preserve every existing candidate exactly");
  expect(prompt).toContain("image 1 is reviewer/screen.png");
});

test("short runs keep their reviewer time", () => {
  expect(Worker.visualAllocation(40)).toEqual({ reviewer: 40, audit: 0 });
  expect(Worker.visualAllocation(600)).toEqual({ reviewer: 480, audit: 120 });
});

test("an early Claude exit does not crash a large image write", async () => {
  const child = spawn("true", [], { stdio: ["pipe", "ignore", "ignore"] });
  const closed: Promise<void> = new Promise((resolve): void => {
    child.once("close", (): void => resolve());
  });
  const failure: () => Error | undefined = Worker.sendFrame(
    child,
    "image".repeat(1_600_000),
  );
  await closed;
  expect(failure()).toBeUndefined();
});
