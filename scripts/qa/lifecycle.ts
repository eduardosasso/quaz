import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Client } from "@qa/client";
import * as Duplicates from "@qa/duplicates";
import * as Project from "@qa/project";
import * as Review from "@qa/review";
import { z } from "zod";
import * as Protocol from "@/qa_protocol";

export type Plan = {
  ticket: Protocol.Ticket | null;
  deployment: Protocol.Finish["deployment"];
  result: Protocol.Finish | null;
};
export const result = (
  summary: string,
  verdict: Protocol.Finish["verdict"] = "none",
  status: Protocol.Finish["status"] = "complete",
): Protocol.Finish => ({
  status,
  summary,
  report: { summary },
  findings: [],
  evidence: [],
  verdict,
  deployment: null,
});
export const deployed = Project.deployed;
const resolveFix = async (
  client: Client,
  ticket: Protocol.Ticket,
  project: Project.Project,
): Promise<string | null> => {
  if (!project.deployment?.repository) return ticket.fix;
  const comments: string[] = await client.comments(ticket.id);
  const text: string = `${ticket.description}\n${JSON.stringify(comments)}`;
  const pattern: RegExp =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
  const links: Array<RegExpMatchArray> = Array.from(
    text.matchAll(pattern),
  ).filter((match): boolean => match[1] === project.deployment?.repository);
  const link: RegExpMatchArray | undefined = links.at(-1);
  if (!link) return ticket.fix;
  const child = Bun.spawn(
    [
      "gh",
      "pr",
      "view",
      link[2],
      "--repo",
      link[1],
      "--json",
      "state,mergeCommit",
    ],
    { stdout: "pipe", stderr: "pipe", timeout: Protocol.REQUEST_MS },
  );
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error("Cannot read the fix pull request");
  const data: unknown = JSON.parse(output);
  if (
    !data ||
    typeof data !== "object" ||
    !("state" in data) ||
    data.state !== "MERGED" ||
    !("mergeCommit" in data) ||
    !data.mergeCommit ||
    typeof data.mergeCommit !== "object" ||
    !("oid" in data.mergeCommit)
  )
    return null;
  const revision: string = Protocol.revision.parse(data.mergeCommit.oid);
  await client.request(`/cards/${ticket.id}/fix`, "PUT", { revision });
  return revision;
};
export const plan = async (
  client: Client,
  run: Protocol.Run,
  project: Project.Project,
  tickets?: number[],
): Promise<Plan> => {
  const state: Protocol.State = await client.request(
    `/state?project=${encodeURIComponent(project.id)}`,
  );
  if (run.mode !== "verify")
    return { ticket: null, deployment: null, result: null };
  for (const candidate of state.tickets) {
    if (tickets && !tickets.includes(candidate.id)) continue;
    const fix: string | null = await resolveFix(client, candidate, project);
    const ticket: Protocol.Ticket = { ...candidate, fix };
    const claim = await client.request<{ accepted: boolean }>(
      `/runs/${run.id}/claim`,
      "POST",
      {
        key: `ticket-${ticket.id}`,
        goal: ticket.test.expected.slice(0, 500),
        ticket: ticket.id,
      },
    );
    if (!claim.accepted) continue;
    if (!fix)
      return {
        ticket,
        deployment: null,
        result: result(
          "A merged fix PR or expected fix revision is missing.",
          "blocked",
          "partial",
        ),
      };
    if (!project.deployment)
      return {
        ticket,
        deployment: null,
        result: result(
          "This project needs a deployment version URL.",
          "blocked",
          "partial",
        ),
      };
    let revision: string | null;
    try {
      revision = await deployed(project);
    } catch {
      return {
        ticket,
        deployment: null,
        result: result(
          "The deployment version is temporarily unavailable.",
          "waiting",
          "partial",
        ),
      };
    }
    if (revision !== fix)
      return {
        ticket,
        deployment: null,
        result: result(
          "The deployed revision does not match the expected fix.",
          "waiting",
          "partial",
        ),
      };
    if (run.revision !== revision)
      return {
        ticket,
        deployment: null,
        result: result(
          "The test image does not contain the deployed fix revision.",
          "waiting",
          "partial",
        ),
      };
    return {
      ticket,
      deployment: { expected: fix, deployed: revision, tested: run.revision },
      result: null,
    };
  }
  return {
    ticket: null,
    deployment: null,
    result: result("No completed QA card is available for verification."),
  };
};

const files = async (root: string, prefix: string = ""): Promise<string[]> => {
  const found: string[] = [];
  for (const name of await readdir(join(root, prefix))) {
    const path: string = prefix ? `${prefix}/${name}` : name;
    const details = await lstat(join(root, path));
    if (details.isSymbolicLink())
      throw new Error("QA artifacts must not be links");
    if (details.isDirectory()) found.push(...(await files(root, path)));
    else if (
      /\.(png|json|jsonl|log|md|txt|ya?ml)$/.test(name) &&
      !name.endsWith("schema.json") &&
      !name.startsWith("events.raw") &&
      name !== "recovery.json" &&
      name !== "project.json" &&
      name !== "assignment.json"
    )
      found.push(path);
  }
  return found.sort();
};
export const artifacts = async (
  client: Client,
  run: string,
  directory: string,
): Promise<Map<string, number>> => {
  const ids: Map<string, number> = new Map();
  for (const path of await files(directory)) {
    const raw: Buffer = await readFile(join(directory, path));
    if (!raw.length) continue;
    const compressed: boolean =
      path.endsWith(".jsonl") || raw.byteLength > Protocol.MAX_BYTES;
    const bytes: Uint8Array = compressed ? gzipSync(raw) : raw;
    if (bytes.byteLength > Protocol.MAX_BYTES)
      throw new Error(
        `Artifact exceeds the tracking board's file limit: ${path}`,
      );
    const mime: string = compressed
      ? "application/gzip"
      : path.endsWith(".png")
        ? "image/png"
        : path.endsWith(".json")
          ? "application/json"
          : "text/plain";
    ids.set(
      path,
      await client.upload(run, compressed ? `${path}.gz` : path, bytes, mime),
    );
  }
  return ids;
};
export const fingerprint = Duplicates.fingerprint;
export const publication = async (
  report: Record<string, unknown>,
  run: Protocol.Run,
  directory: string,
  ids: Map<string, number>,
  selection: Plan,
  sourceRoot?: string,
): Promise<Protocol.Finish> => {
  const evidence: number[] = [...ids.values()];
  if (run.mode === "smoke")
    return {
      ...result("Configured project smoke check passed."),
      report,
      evidence,
    };
  if (run.mode === "verify") {
    const check: Review.Verification = await Review.verification(
      report.verification,
      directory,
    );
    if (!selection.ticket) throw new Error("Verification has no claimed card");
    if (
      check.status === "complete" &&
      check.expected !== selection.ticket.test.expected
    )
      throw new Error("Verifier changed the acceptance test");
    const expected: string[] = selection.ticket.test.acceptance ?? [
      selection.ticket.test.expected,
    ];
    if (
      check.status === "complete" &&
      (check.checks.length !== expected.length ||
        expected.some(
          (criterion: string): boolean =>
            !check.checks.some(
              (entry): boolean => entry.criterion === criterion,
            ),
        ))
    )
      throw new Error("Verifier did not check every acceptance criterion");
    Review.visualVerification(
      await readFile(join(directory, "validator/events.jsonl"), "utf8"),
      check,
    );
    return {
      status: check.status === "complete" ? "complete" : "partial",
      summary: check.summary,
      report,
      findings: [],
      evidence: check.evidence.map((path): number => {
        const id = ids.get(path);
        if (!id) throw new Error("Missing verifier evidence");
        return id;
      }),
      verdict: check.status === "complete" ? check.verdict : "blocked",
      deployment: selection.deployment,
    };
  }
  const audit = z
    .object({
      status: z.enum(["complete", "skipped"]),
      reason: z.string().optional(),
    })
    .strict()
    .safeParse(report.audit);
  if (!audit.success || audit.data.status !== "complete")
    return {
      ...result(
        "Visual audit is incomplete; findings remain unpublished.",
        "none",
        "partial",
      ),
      report,
      evidence,
    };
  const assessment: Review.Assessment = await Review.assessment(
    report.assessment,
    directory,
    sourceRoot,
  );
  const validation: Review.Validation = await Review.validation(
    report.validation,
    directory,
    assessment.flow.key,
    assessment.candidates,
  );
  Review.visualAssessment(
    await readFile(join(directory, "reviewer/events.jsonl"), "utf8"),
    assessment,
  );
  Review.visualValidation(
    await readFile(join(directory, "validator/events.jsonl"), "utf8"),
    validation,
  );
  if (validation.status === "blocked")
    return {
      ...result(
        "Independent validation is blocked; candidate findings remain unpublished.",
        "none",
        "partial",
      ),
      report,
      evidence,
    };
  const findings: Protocol.Finding[] = assessment.candidates.flatMap(
    (candidate): Protocol.Finding[] => {
      const confirmed = validation.results.find(
        (value): boolean =>
          value.candidateId === candidate.id && value.verdict === "confirmed",
      );
      if (!confirmed) return [];
      const paths: string[] = [
        ...new Set([...candidate.evidence, ...confirmed.evidence]),
      ];
      const linked: number[] = paths.map((path): number => {
        const id = ids.get(path);
        if (!id) throw new Error("Missing finding evidence");
        return id;
      });
      return [
        {
          fingerprint: fingerprint(
            run.project,
            assessment.flow.key,
            candidate.title,
            candidate.expected,
          ),
          title: candidate.title,
          actual: candidate.actual,
          impact: candidate.impact,
          test: {
            flow: assessment.flow.key,
            route: assessment.flow.route,
            steps: candidate.steps,
            expected: candidate.expected,
            scenario: run.scenario,
            acceptance: candidate.acceptance,
          },
          evidence: linked,
        },
      ];
    },
  );
  if (findings.length && !report.matching)
    return {
      ...result(
        `Confirmed findings remain unpublished: ${String(report.matchingError ?? "the duplicate review is missing")}`,
        "none",
        "partial",
      ),
      report: { ...report, unpublished: findings },
      evidence,
    };
  const matching: Protocol.Matching | undefined = findings.length
    ? Protocol.matching.parse(report.matching)
    : undefined;
  if (
    matching &&
    (matching.decisions.length !== findings.length ||
      matching.decisions.some(
        (choice, index): boolean =>
          choice.fingerprint !== findings[index]?.fingerprint,
      ))
  )
    throw new Error("Duplicate review does not cover the confirmed findings");
  return {
    status: Review.coverage(assessment, validation).status,
    summary: `Reviewed ${assessment.flow.title}. ${findings.length} independently confirmed finding(s).`,
    report,
    findings,
    ...(matching ? { matching } : {}),
    evidence,
    verdict: "none",
    deployment: null,
  };
};
