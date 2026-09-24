import { createHash } from "node:crypto";
import { z } from "zod";
import * as Protocol from "@/qa_protocol";
import type * as Tracker from "@/tracker";

const PREFIX: string = "quaz-record-";
const MIME: string = "application/json";
const schema = z
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
  fingerprint?: string;
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
  const value: Record = schema.parse(JSON.parse(new TextDecoder().decode(raw)));
  if (value.card !== card)
    throw new Error("Quaz record belongs to another card");

  return value;
};

export const save = async (
  tracker: Tracker.Tracker,
  card: number,
  changes: Changes,
): Promise<Record> => {
  const prior: Record | null = await load(tracker, card);
  if (prior && prior.project !== changes.project)
    throw new Error("Quaz record belongs to another project");
  const next: Record = schema.parse({
    version: 1,
    card,
    project: changes.project,
    fingerprints: [
      ...new Set([
        ...(prior?.fingerprints ?? []),
        ...(changes.fingerprint ? [changes.fingerprint] : []),
      ]),
    ],
    test: changes.test === undefined ? (prior?.test ?? null) : changes.test,
    fix: changes.fix === undefined ? (prior?.fix ?? null) : changes.fix,
    lastResult:
      changes.lastResult === undefined
        ? (prior?.lastResult ?? null)
        : changes.lastResult,
  });
  const bytes: Uint8Array = new TextEncoder().encode(JSON.stringify(next));
  const hash: string = createHash("sha256").update(bytes).digest("hex");
  const name: string = `${PREFIX}${hash}.json`;
  const existing: Tracker.Attachment[] = await tracker.attachments(card);
  if (!existing.some((entry): boolean => entry.name === name))
    await tracker.upload(card, name, bytes, MIME);

  return next;
};
