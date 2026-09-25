import { createHash } from "node:crypto";
import { z } from "zod";
import * as Protocol from "@/qa_protocol";
import type * as Tracker from "@/tracker";

const PREFIX: string = "quaz-record-";
export const MIME: string = "application/json";
const finding = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    test: Protocol.caseSchema.nullable(),
    fix: Protocol.revision.nullable(),
    lastResult: z.string().nullable(),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(2),
    card: z.number().int().positive(),
    project: Protocol.key,
    findings: z.array(finding).min(1),
  })
  .strict();
const legacy = z
  .object({
    version: z.literal(1),
    card: z.number().int().positive(),
    project: Protocol.key,
    fingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
    test: Protocol.caseSchema.nullable(),
    fix: Protocol.revision.nullable(),
    lastResult: z.string().nullable(),
  })
  .strict();
export type Record = z.infer<typeof schema>;
export type Changes = {
  project: string;
  fingerprint: string;
  test?: Protocol.Case | null;
  fix?: string | null;
  lastResult?: string | null;
};

export const load = async (
  tracker: Tracker.Tracker,
  card: number,
): Promise<Record | null> => {
  const files: Tracker.Attachment[] = (await tracker.attachments(card))
    .filter(
      (entry): boolean =>
        entry.name.startsWith(PREFIX) && entry.name.endsWith(".json"),
    )
    .sort((left, right): number => right.id - left.id);
  if (!files.length) return null;
  const raw: Uint8Array = await tracker.download(files[0].id);
  const parsed: z.infer<typeof schema> | z.infer<typeof legacy> = z
    .discriminatedUnion("version", [schema, legacy])
    .parse(JSON.parse(new TextDecoder().decode(raw)));
  const value: Record =
    parsed.version === 2
      ? parsed
      : {
          version: 2,
          card: parsed.card,
          project: parsed.project,
          findings: parsed.fingerprints.map(
            (fingerprint): z.infer<typeof finding> => ({
              fingerprint,
              test: parsed.test,
              fix: parsed.fix,
              lastResult: parsed.lastResult,
            }),
          ),
        };
  if (value.card !== card)
    throw new Error("Quaz record belongs to another card");

  return value;
};

export const save = async (
  tracker: Tracker.Tracker,
  card: number,
  changes: Changes,
  write?: (name: string, bytes: Uint8Array) => Promise<void>,
): Promise<Record> => {
  const prior: Record | null = await load(tracker, card);
  if (prior && prior.project !== changes.project)
    throw new Error("Quaz record belongs to another project");
  const existing: z.infer<typeof finding> | undefined = prior?.findings.find(
    (entry): boolean => entry.fingerprint === changes.fingerprint,
  );
  const updated: z.infer<typeof finding> = finding.parse({
    fingerprint: changes.fingerprint,
    test: changes.test === undefined ? (existing?.test ?? null) : changes.test,
    fix: changes.fix === undefined ? (existing?.fix ?? null) : changes.fix,
    lastResult:
      changes.lastResult === undefined
        ? (existing?.lastResult ?? null)
        : changes.lastResult,
  });
  const next: Record = schema.parse({
    version: 2,
    card,
    project: changes.project,
    findings: [
      ...(prior?.findings.filter(
        (entry): boolean => entry.fingerprint !== changes.fingerprint,
      ) ?? []),
      updated,
    ],
  });
  const bytes: Uint8Array = new TextEncoder().encode(JSON.stringify(next));
  const hash: string = createHash("sha256").update(bytes).digest("hex");
  const name: string = `${PREFIX}${hash}.json`;
  const files: Tracker.Attachment[] = await tracker.attachments(card);
  if (!files.some((entry): boolean => entry.name === name)) {
    if (write) await write(name, bytes);
    else await tracker.upload(card, name, bytes, MIME);
  }

  return next;
};
