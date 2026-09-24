import { z } from "zod";

export const TAG = {
  issue: "qa",
  run: "qa-run",
  pending: "needs-verification",
  verified: "verified",
  attention: "needs-attention",
} as const;
export const MAX_BYTES: number = 5 * 1024 * 1024;
export const REQUEST_MS: number = 30_000;
export const LEASE_SECONDS: number = 3600;
export const SCHEDULE_HISTORY: number = 10;
export const CATALOG_BYTES: number = 256 * 1024;
export const PUBLICATION_SECONDS: number = 180;
export const MATCHING_POLL_MS: number = 1000;
export const decision = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: z.enum(["new", "existing", "same-run", "uncertain"]),
    target: z.number().int().positive().nullable(),
    sameAs: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    reason: z.string().min(1).max(2000),
  })
  .strict();
export const decisions = z
  .object({ decisions: z.array(decision).max(10) })
  .strict();
export const matching = decisions
  .extend({ snapshot: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type Matching = z.infer<typeof matching>;
export const catalog = z
  .object({
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    cards: z.array(
      z
        .object({
          id: z.number().int().positive(),
          version: z.number().int(),
          title: z.string(),
          description: z.string(),
          checklist: z.string(),
          tags: z.string(),
          status: z.number().int(),
          comments: z.array(z.string()),
          fingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
        })
        .strict(),
    ),
  })
  .strict();
export type Catalog = z.infer<typeof catalog>;
export const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,100}$/);
export const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
export const mode = z.enum(["discover", "verify", "smoke"]);
export type Mode = z.infer<typeof mode>;
export const begin = z
  .object({
    id: key,
    project: key,
    mode,
    revision,
    scenario: z.string().min(1).max(80),
    attention: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .optional(),
  })
  .strict();
export type Begin = z.infer<typeof begin>;
export const caseSchema = z
  .object({
    flow: key,
    route: z.string().min(1).max(500),
    steps: z.array(z.string().min(1).max(2000)).min(1).max(20),
    expected: z.string().min(1).max(4000),
    acceptance: z.array(z.string().min(1).max(2000)).min(1).max(20).optional(),
    scenario: z.string().min(1).max(80),
  })
  .strict();
export type Case = z.infer<typeof caseSchema>;
export const finding = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).max(200),
    actual: z.string().min(1).max(4000),
    impact: z.string().min(1).max(4000),
    test: caseSchema,
    evidence: z.array(z.number().int().positive()).min(1),
  })
  .strict();
export type Finding = z.infer<typeof finding>;
export const finish = z
  .object({
    status: z.enum(["complete", "partial", "failed"]),
    summary: z.string().min(1).max(6000),
    report: z.record(z.string(), z.unknown()),
    findings: z.array(finding).max(10),
    matching: matching.optional(),
    evidence: z.array(z.number().int().positive()),
    verdict: z.enum(["none", "pass", "fail", "blocked", "waiting"]),
    deployment: z
      .object({ expected: revision, deployed: revision, tested: revision })
      .strict()
      .nullable(),
  })
  .strict();
export type Finish = z.infer<typeof finish>;
export type Run = Begin & {
  note_id: number;
  board_id: number;
  owner: string;
  status: string;
  expires: number;
  target: number | null;
  snapshot: number | null;
  receipt: string | null;
};
export type Ticket = {
  id: number;
  version: number;
  content: string;
  description: string;
  tags: string;
  test: Case;
  fix: string | null;
};
export type Flow = {
  key: string;
  goal: string;
  run: string;
  expires: number;
  status: string;
};
export type State = {
  flows: Flow[];
  tickets: Ticket[];
  runs: Run[];
  scheduledRevision?: string;
};
