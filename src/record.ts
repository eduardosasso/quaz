import { z } from "zod";
import * as Protocol from "@/qa_protocol";
import type * as Tracker from "@/tracker";

const PREFIX: string = "quaz-record-";
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
