import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CONFIG from "@qa/config.json";
import * as Project from "@qa/project";
import * as Review from "@qa/review";
import * as Runner from "@qa/run";
import * as Worker from "@qa/worker";
import * as Protocol from "@/qa_protocol";

const PROJECT_FILE: string = join(import.meta.dir, "fixtures/qa-project.json");
const options = (args: string[]): Runner.Options =>
  Runner.options(["--project", PROJECT_FILE, ...args]);

describe("QA runner configuration", (): void => {
  test("project context stays in staged app files", (): void => {
    const project = {
      id: "sample",
      root: "/app",
      sources: ["PRODUCT.md"],
      scenarios: ["empty"],
    };
    expect(
      Project.schema.safeParse({
        ...project,
        context: ["/app/PRODUCT.md"],
      }).success,
    ).toBe(true);
    for (const path of [
      "/app/../credential/auth.json",
      "/app/PRODUCT.md/../../credential/auth.json",
      "/app/secret.txt",
    ])
      expect(
        Project.schema.safeParse({ ...project, context: [path] }).success,
      ).toBe(false);
    expect(
      Project.schema.safeParse({
        ...project,
        sources: ["uploads"],
        context: ["/app/uploads/brief.md"],
      }).success,
    ).toBe(false);
  });

  test("empty data is available without fixtures", (): void => {
    expect(
      options(["--scenarios", "empty", "--testers", "2"]).scenarios,
    ).toEqual(["empty"]);
    expect(
      options(["--scenarios", "empty,typical,busy", "--testers", "3"]).testers,
    ).toBe(3);
  });

  test("review budget stays inside the claim lease", (): void => {
    expect(options([]).seconds).toBe(CONFIG.seconds);
    expect(CONFIG.maxSeconds + CONFIG.cleanupSeconds).toBeLessThan(
      Protocol.LEASE_SECONDS,
    );
    expect(options(["--seconds", "120"]).seconds).toBe(120);
    expect(
      (): Runner.Options =>
        options(["--seconds", String(CONFIG.maxSeconds + 1)]),
    ).toThrow();
  });

  test("longer runs reserve proportional time for independent validation", (): void => {
    const standard = Worker.allocation((CONFIG.seconds * 2) / 3);
    const extended = Worker.allocation(CONFIG.maxSeconds);
    expect(standard.validator).toBeGreaterThanOrEqual(400);
    expect(extended.validator).toBeGreaterThan(standard.validator);
    for (const seconds of [
      CONFIG.minSeconds,
      CONFIG.seconds,
      CONFIG.maxSeconds,
    ]) {
      const phases = Worker.allocation(seconds);
      expect(phases.reviewer + phases.validator).toBe(seconds);
      expect(phases.reviewer).toBeGreaterThan(phases.validator);
    }
  });

  test("rejects invalid plans before starting containers", (): void => {
    for (const args of [
      ["--testers", "0"],
      ["--testers", "2.5"],
      ["--testers", "100"],
      ["--scenarios", "production"],
      ["--scenarios", ""],
      ["--seconds", "NaN"],
      ["--mode", "publish"],
    ])
      expect((): Runner.Options => options(args)).toThrow();
  });
});

describe("QA reviewer context", (): void => {
  let directory: string;
  const rule: string = "Exit actions such as Cancel use links, not buttons.";
  const fixture = { counts: { boards: 2, cards: 8 } };
  beforeAll(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), "qa-guidance-"));
    await mkdir(join(directory, "reference"));
    await writeFile(join(directory, "SKILL.md"), "Test guide package");
    await writeFile(join(directory, "DESIGN.md"), rule);
    const sections: string = [
      "### Assessment A: Design Review",
      "Inspect the user goal.",
      "### Assessment B:",
      "#### Cognitive Load Checklist",
      "Check visible choices.",
      "#### The Working Memory Rule",
      "### Heuristics Scoring Guide",
      "Use actual score anchors.",
      "#### Issue Severity",
      "## Diagnostic Scan",
      "Measure touch targets.",
      "## Generate Report",
      "## 4. Polish the whole path",
      "Compare states.",
      "## 5. Verify and finish",
      "## Set the spatial thesis",
      "Check grouping.",
      "## Live-mode signature params",
      "## Set the system",
      "Check labels.",
      "## Live-mode signature params",
      "### Mobile Adaptation",
      "Check scroll and reach.",
      "### Tablet Adaptation",
    ].join("\n");
    for (const name of Review.GUIDES)
      await writeFile(join(directory, "reference", `${name}.md`), sections);
  });
  afterAll(
    async (): Promise<void> =>
      await rm(directory, { recursive: true, force: true }),
  );

  const instructions = async (
    scenario: string,
    metadata: Record<string, unknown>,
  ) =>
    Worker.instructions({
      policy: join(import.meta.dir, "../../scripts/qa/QA.md"),
      skill: directory,
      context: [join(directory, "DESIGN.md")],
      contextRoot: directory,
      scenario,
      fixture: metadata,
    });

  test("both roles receive the same product rules and six guide criteria", async (): Promise<void> => {
    const value = await instructions("typical", fixture);
    for (const prompt of [value.reviewer, value.validator]) {
      expect(prompt).toContain(rule);
      expect(prompt).toContain(JSON.stringify(fixture));
      expect(prompt).toContain("Assigned scenario: typical");
      for (const name of Review.GUIDES)
        expect(prompt).toContain(`<criteria guide="${name}"`);
      expect(prompt).not.toContain(
        "Test a small first-use action for an empty account.",
      );
    }
    expect(value.reviewer.split("Your role is")[0]).toBe(
      value.validator.split("Your role is")[0],
    );
    expect(value.validator).toContain("Do not read the reviewer's screenshots");
    expect(value.guidance).toMatchObject({ scenario: "typical", fixture });
  });

  test("both live roles use the shared design criteria without eval output rules", async (): Promise<void> => {
    const design: Review.Design = await Review.design();
    const value = await instructions("typical", fixture);
    for (const prompt of [value.reviewer, value.validator]) {
      expect(prompt.split(design.content)).toHaveLength(2);
      expect(prompt).not.toContain(
        "Give zero to two priority findings per image",
      );
      expect(prompt).toContain("No finding quota applies");
      expect(prompt).toContain("design.comparisons");
      expect(prompt.indexOf(design.content)).toBeGreaterThan(
        prompt.indexOf(rule),
      );
      expect(prompt).toContain(
        "A working flow can still have a supported design concern",
      );
    }
    expect(value.guidance).toMatchObject({
      design: { path: design.path, sha256: design.sha256 },
    });
    expect(value.validator).toContain(
      "Keep unverified intent or behavior inconclusive",
    );
  });

  test("missing or empty design guidance fails closed", async (): Promise<void> => {
    const empty: string = join(directory, "empty.md");
    await writeFile(empty, " \n\t");
    await expect(Review.design(empty)).rejects.toThrow(
      "Empty design review guidance",
    );
    await expect(
      Review.design(join(directory, "missing.md")),
    ).rejects.toThrow();
  });

  test("custom scenarios keep their own fixture state", async (): Promise<void> => {
    const metadata = { savedArticles: 17 };
    const value = await instructions("reading-list", metadata);
    expect(value.validator).toContain("Assigned scenario: reading-list");
    expect(value.validator).toContain(JSON.stringify(metadata));
    expect(value.guidance).toMatchObject({
      scenario: "reading-list",
      fixture: metadata,
    });
  });

  test("linked product context cannot escape the app", async (): Promise<void> => {
    const outside: string = await mkdtemp(join(tmpdir(), "qa-outside-"));
    try {
      const file: string = join(outside, "private.txt");
      await writeFile(file, "private fixture");
      const link: string = join(directory, "outside.md");
      await symlink(file, link);
      await expect(
        Worker.instructions({
          policy: join(import.meta.dir, "../../scripts/qa/QA.md"),
          skill: directory,
          context: [link],
          contextRoot: directory,
          scenario: "empty",
          fixture: {},
        }),
      ).rejects.toThrow("Product context escapes the app directory");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("linked product context cannot use writable app files", async (): Promise<void> => {
    const uploads: string = join(directory, "uploads");
    await mkdir(uploads, { recursive: true });
    const file: string = join(uploads, "brief.md");
    await writeFile(file, "writable fixture");
    const link: string = join(directory, "writable.md");
    await symlink(file, link);
    await expect(
      Worker.instructions({
        policy: join(import.meta.dir, "../../scripts/qa/QA.md"),
        skill: directory,
        context: [link],
        contextRoot: directory,
        scenario: "empty",
        fixture: {},
      }),
    ).rejects.toThrow("Product context cannot use writable app files");
  });
});
