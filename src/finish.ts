import { createHash } from "node:crypto";
import * as Protocol from "@/qa_protocol";
import type * as State from "@/state";
import type * as Tracker from "@/tracker";

const DELETED: number = 2;
const COMPLETED: number = 1;
const ARCHIVED: number = 3;
const COMMENT_MAX: number = 4000;
const MILLISECONDS: number = 1000;
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const commentDigest = (value: string): string =>
  digest(value.replace(/\r\n?/g, "\n"));
const tags = (value: string): Set<string> =>
  new Set(
    value
      .split(",")
      .map((tag): string => tag.trim())
      .filter(Boolean),
  );
const fail = (message: string): never => {
  throw new Error(message);
};
export type Result = {
  run: Protocol.Run;
  cards: number[];
  created: number[];
  replayed: boolean;
  held?: string;
};

const evidence = (state: State.State, run: string, ids: number[]): void => {
  for (const id of ids)
    if (
      !state.db
        .query("SELECT 1 FROM qa_artifacts WHERE run=? AND attachment=?")
        .get(run, id)
    )
      fail("Evidence must belong to this QA run");
};
const attach = async (
  state: State.State,
  run: string,
  target: number,
  ids: number[],
  apply?: (action: string, change: () => Promise<unknown>) => Promise<void>,
  guard?: () => void,
): Promise<number[]> => {
  const existing: Tracker.Attachment[] =
    await state.tracker.attachments(target);
  const result: number[] = [];
  for (const id of ids) {
    guard?.();
    const source = state.db
      .query<{ path: string; digest: string; mime: string }, [string, number]>(
        "SELECT path,digest,mime FROM qa_artifacts WHERE run=? AND attachment=?",
      )
      .get(run, id);
    if (!source) throw new Error("Evidence must belong to this QA run");
    const extension: string = source.path.includes(".")
      ? `.${source.path.split(".").at(-1)}`
      : "";
    const name: string = `quaz-${digest(`${run}:${source.path}:${source.digest}:${source.mime}`).slice(0, 32)}${extension}`;
    const prior: Tracker.Attachment | undefined = existing.find(
      (item): boolean => item.name === name,
    );
    if (prior) {
      result.push(prior.id);
      continue;
    }
    const bytes: Uint8Array = await state.tracker.download(id);
    if (createHash("sha256").update(bytes).digest("hex") !== source.digest)
      fail("QA evidence changed after upload");
    let added: Tracker.Attachment;
    if (apply) {
      await apply(`attachment:${name}`, async (): Promise<void> => {
        await state.tracker.upload(target, name, bytes, source.mime);
      });
      const uploaded: Tracker.Attachment | undefined = (
        await state.tracker.attachments(target)
      ).find((item): boolean => item.name === name);
      if (!uploaded) throw new Error("QA evidence upload is unavailable");
      added = uploaded;
    } else added = await state.tracker.upload(target, name, bytes, source.mime);
    existing.push(added);
    result.push(added.id);
  }
  return result;
};
const links = (state: State.State, ids: number[]): string =>
  ids
    .map((id): string => `[Evidence](${state.tracker.attachmentUrl(id)})`)
    .join("\n");
const comment = async (
  state: State.State,
  note: number,
  body: string,
  runCard: number,
  apply?: (action: string, change: () => Promise<unknown>) => Promise<void>,
  guard?: () => void,
): Promise<void> => {
  guard?.();
  const overflow: string = `\nFull report: QA run card ${runCard}.`;
  const text: string =
    body.length > COMMENT_MAX
      ? `${body.slice(0, COMMENT_MAX - overflow.length)}${overflow}`
      : body;
  const target: Tracker.Card | null = await state.tracker.get(note);
  if (!target) throw new Error("QA comment card is unavailable");
  if (
    !target.comments.some(
      (body): boolean => commentDigest(body) === commentDigest(text),
    )
  ) {
    if (apply)
      await apply(`comment:${commentDigest(text)}`, async (): Promise<void> => {
        await state.tracker.comment(note, text);
      });
    else await state.tracker.comment(note, text);
  }
};
const actionMatches = async (
  state: State.State,
  step: string,
  card: Tracker.Card,
): Promise<boolean> => {
  if (step.startsWith("attachment:"))
    return (await state.tracker.attachments(card.id)).some(
      (item): boolean => item.name === step.slice("attachment:".length),
    );
  if (step.startsWith("comment:"))
    return card.comments.some(
      (body): boolean => commentDigest(body) === step.slice("comment:".length),
    );
  const labels: Set<string> = tags(card.tags);
  if (step === "pass")
    return (
      labels.has(Protocol.TAG.verified) &&
      !labels.has(Protocol.TAG.pending) &&
      !labels.has(Protocol.TAG.attention)
    );
  if (step === "reopen") return card.status === 0;
  if (step === "fail")
    return (
      labels.has(Protocol.TAG.pending) && !labels.has(Protocol.TAG.verified)
    );
  if (step === "blocked") return labels.has(Protocol.TAG.attention);

  throw new Error("Unknown verification action");
};
const issueCard = (
  finding: Protocol.Finding,
  run: Protocol.Run,
): { description: string; changes: Tracker.Changes } => {
  const description: string = `${finding.impact}\n\nSteps:\n${finding.test.steps.map((step, index): string => `${index + 1}. ${step}`).join("\n")}\n\nExpected: ${finding.test.expected}\nActual: ${finding.actual}\n\nRoute: ${finding.test.route}\nScenario: ${finding.test.scenario}\nSource revision: ${run.revision}\nQA run: ${run.id}`;
  const checklist: string = JSON.stringify(
    (finding.test.acceptance ?? [finding.test.expected]).map(
      (text): { text: string; done: boolean } => ({ text, done: false }),
    ),
  );

  return {
    description,
    changes: {
      title: finding.title,
      tags: `${Protocol.TAG.issue},${Protocol.TAG.pending},project:${run.project}`,
      description,
      checklist,
    },
  };
};
const match = async (
  state: State.State,
  run: Protocol.Run,
  input: Protocol.Finish,
): Promise<string | null> => {
  if (!input.findings.length) return null;
  const plan: Protocol.Matching | undefined = input.matching;
  if (!plan) throw new Error("Discovery requires a current duplicate review");
  const lease = state.db
    .query<{ run: string; expires: number }, [string]>(
      "SELECT run,expires FROM qa_publications WHERE project=?",
    )
    .get(run.project);
  if (lease?.run !== run.id || lease.expires <= Date.now())
    return "Publication lease expired. Findings remain unpublished and require a fresh duplicate review.";
  const current: Protocol.Catalog = await state.catalog(run.project);
  if (current.snapshot !== plan.snapshot)
    return "Board issues changed during duplicate review. Findings remain unpublished and require a fresh duplicate review.";
  const expected: Set<string> = new Set(
    input.findings.map((item): string => item.fingerprint),
  );
  if (
    expected.size !== input.findings.length ||
    plan.decisions.length !== expected.size
  )
    fail("Duplicate review must cover each finding exactly once");
  const seen: Set<string> = new Set();
  let mismatch: boolean = false;
  for (const choice of plan.decisions) {
    if (!expected.has(choice.fingerprint) || seen.has(choice.fingerprint))
      fail("Duplicate review contains an unknown or repeated finding");
    if (
      choice.verdict === "existing" &&
      (!choice.target ||
        choice.sameAs ||
        !current.cards.some((card): boolean => card.id === choice.target))
    )
      fail("Duplicate target is outside the reviewed issue catalog");
    if (
      choice.verdict === "same-run" &&
      (choice.target ||
        !choice.sameAs ||
        !seen.has(choice.sameAs) ||
        plan.decisions.find(
          (item): boolean => item.fingerprint === choice.sameAs,
        )?.verdict === "same-run")
    )
      fail(
        "Same-run duplicates must reference an earlier independent decision",
      );
    if (
      ["new", "uncertain"].includes(choice.verdict) &&
      (choice.target || choice.sameAs)
    )
      fail("New or uncertain findings cannot name a duplicate target");
    const exact = current.cards.find((card): boolean =>
      card.fingerprints.includes(choice.fingerprint),
    );
    if (exact && (choice.verdict !== "existing" || choice.target !== exact.id))
      mismatch = true;
    seen.add(choice.fingerprint);
  }
  if (mismatch)
    return "Duplicate review disagreed with an exact fingerprint match. Findings remain unpublished and require a fresh duplicate review.";
  return plan.decisions.some((item): boolean => item.verdict === "uncertain")
    ? "Duplicate review is uncertain. Findings remain unpublished for review."
    : null;
};

export const publish = async (
  state: State.State,
  id: string,
  input: Protocol.Finish,
): Promise<Result> => {
  const run: Protocol.Run = state.run(id);
  const receipt: string = digest(input);
  if (run.receipt) {
    if (run.receipt !== receipt) fail("QA run already has a different result");
    const previous = state.db
      .query<{ result: string }, [string]>(
        "SELECT result FROM qa_runs WHERE id=?",
      )
      .get(id);
    const saved = JSON.parse(previous?.result ?? "{}") as {
      cards: number[];
      created: number[];
      held?: string;
    };
    return {
      run,
      cards: saved.cards ?? [],
      created: saved.created ?? [],
      replayed: true,
      ...(saved.held ? { held: saved.held } : {}),
    };
  }
  const pending = state.db
    .query<
      {
        publish: string | null;
        publish_lease: number | null;
        publish_held: string | null;
        publish_target_version: number | null;
        publish_target_step: string | null;
      },
      [string]
    >(
      "SELECT publish,publish_lease,publish_held,publish_target_version,publish_target_step FROM qa_runs WHERE id=?",
    )
    .get(id);
  if (pending?.publish && pending.publish !== receipt)
    fail("QA run is publishing a different result");
  if (pending?.publish_lease && pending.publish_lease > Date.now())
    fail("QA run publication is already active; retry after the lease");
  if (!pending?.publish && run.status !== "running") fail("QA run is finished");
  evidence(state, id, input.evidence);
  for (const finding of input.findings) evidence(state, id, finding.evidence);
  if (run.mode !== "discover" && input.findings.length)
    fail("Only discovery can publish findings");
  if (run.mode !== "verify" && input.verdict !== "none")
    fail("Only verification can change a card");
  const expired: boolean = run.expires <= Date.now();
  let held: string | null = pending?.publish
    ? (pending.publish_held ?? null)
    : run.mode === "discover" && !expired
      ? await match(state, run, input)
      : null;
  const refresh = (): boolean => {
    const now: number = Date.now();
    if (run.expires <= now) return false;
    const lease = state.db
      .query(
        "UPDATE qa_publications SET expires=MIN(?,?) WHERE project=? AND run=? AND expires>?",
      )
      .run(
        run.expires,
        now + Protocol.PUBLICATION_SECONDS * MILLISECONDS,
        run.project,
        id,
        now,
      );

    return lease.changes === 1;
  };
  if (run.mode === "discover" && input.findings.length && !held && !expired) {
    if (!refresh())
      held =
        "Publication lease expired. Findings remain unpublished and require a fresh duplicate review.";
  }
  const renew = (): void => {
    if (!refresh()) fail("Discovery publication lease expired");
  };
  if (run.mode === "verify" && ["pass", "fail"].includes(input.verdict)) {
    const finding = run.target ? state.finding(run.target) : null;
    const proof = input.deployment;
    if (
      input.status !== "complete" ||
      !input.evidence.length ||
      !proof ||
      proof.expected !== finding?.fix ||
      proof.deployed !== proof.expected ||
      proof.tested !== run.revision ||
      proof.tested !== proof.deployed
    )
      fail("Verification needs completed tests of the deployed fix revision");
  }
  state.db
    .query(
      "UPDATE qa_runs SET status='publishing',publish=?,publish_lease=?,publish_held=?,publish_target_version=COALESCE(publish_target_version,?) WHERE id=?",
    )
    .run(
      receipt,
      Date.now() + Protocol.PUBLICATION_SECONDS * MILLISECONDS,
      held,
      run.snapshot,
      id,
    );
  try {
    const cards: number[] = [];
    const created: number[] = [];
    let status: string = held ? "partial" : input.status;
    if (run.mode === "verify" && input.verdict !== "none") {
      let target: Tracker.Card | null = run.target
        ? await state.tracker.get(run.target)
        : null;
      let step: string | null = pending?.publish_target_step ?? null;
      if (
        pending?.publish &&
        step &&
        !step.endsWith(":done") &&
        target &&
        target.version ===
          (pending.publish_target_version ?? run.snapshot ?? -1) + 1 &&
        (await actionMatches(state, step, target))
      ) {
        state.db
          .query(
            "UPDATE qa_runs SET publish_target_version=?,publish_target_step=? WHERE id=?",
          )
          .run(target.version, `${step}:done`, id);
        step = `${step}:done`;
      }
      const version: number | null =
        state.db
          .query<{ publish_target_version: number | null }, [string]>(
            "SELECT publish_target_version FROM qa_runs WHERE id=?",
          )
          .get(id)?.publish_target_version ?? null;
      const owned = state.db
        .query(
          "SELECT 1 FROM qa_flows WHERE project=? AND key=? AND run=? AND expires>?",
        )
        .get(run.project, `ticket-${run.target}`, id, Date.now());
      const valid: boolean = Boolean(
        target &&
          (pending?.publish
            ? target.version === version
            : target.version === run.snapshot &&
              [COMPLETED, ARCHIVED].includes(target.status) &&
              tags(target.tags).has(Protocol.TAG.pending)) &&
          target.status !== DELETED &&
          owned &&
          !expired,
      );
      if (!valid) status = "superseded";
      else if (target) {
        const targetId: number = target.id;
        const apply = async (
          action: string,
          change: () => Promise<unknown>,
        ): Promise<void> => {
          if (step === `${action}:done`) return;
          if (action === "reopen" && (step === "fail" || step === "fail:done"))
            return;
          const before: Tracker.Card | null = await state.tracker.get(targetId);
          if (!before)
            throw new Error("QA card is unavailable during publication");
          const expected: number | null =
            state.db
              .query<{ publish_target_version: number | null }, [string]>(
                "SELECT publish_target_version FROM qa_runs WHERE id=?",
              )
              .get(id)?.publish_target_version ?? null;
          if (before.version !== expected)
            throw new Error("Verification card changed during publication");
          state.db
            .query("UPDATE qa_runs SET publish_target_step=? WHERE id=?")
            .run(action, id);
          step = action;
          await change();
          const after: Tracker.Card | null = await state.tracker.get(targetId);
          if (
            !after ||
            after.version !== before.version + 1 ||
            !(await actionMatches(state, action, after))
          )
            throw new Error("Verification card changed during publication");
          state.db
            .query(
              "UPDATE qa_runs SET publish_target_version=?,publish_target_step=? WHERE id=?",
            )
            .run(after.version, `${action}:done`, id);
          step = `${action}:done`;
          target = after;
        };
        const finding = state.finding(target.id);
        const proof = input.deployment;
        const copied: number[] = await attach(
          state,
          id,
          targetId,
          input.evidence,
          apply,
        );
        const signature: string = digest({
          verdict: input.verdict,
          summary: input.summary,
          fix: finding?.fix,
        });
        if (input.verdict === "fail" || signature !== finding?.last_result) {
          const report: string = `QA ${input.verdict}\nRun: ${id}\n${proof ? `Deployed and tested revision: ${proof.tested}\n` : ""}${links(state, copied)}\n${input.summary}`;
          await comment(state, targetId, report, run.note_id, apply);
          state.db
            .query("UPDATE qa_findings SET last_result=? WHERE note_id=?")
            .run(signature, target.id);
        }
        if (input.verdict === "pass") {
          await apply(
            "pass",
            async (): Promise<Tracker.Card> =>
              state.tracker.update(targetId, {
                tagsAdd: Protocol.TAG.verified,
                tagsRemove: `${Protocol.TAG.pending},${Protocol.TAG.attention}`,
              }),
          );
          state.db
            .query(
              "UPDATE qa_findings SET verified_through=(SELECT rowid FROM qa_runs WHERE id=?) WHERE note_id=?",
            )
            .run(id, target.id);
        }
        if (input.verdict === "fail") {
          await apply(
            "reopen",
            async (): Promise<void> => state.tracker.reopen(targetId),
          );
          await apply(
            "fail",
            async (): Promise<Tracker.Card> =>
              state.tracker.update(targetId, {
                tagsAdd: Protocol.TAG.pending,
                tagsRemove: Protocol.TAG.verified,
              }),
          );
        }
        if (input.verdict === "blocked") {
          await apply(
            "blocked",
            async (): Promise<Tracker.Card> =>
              state.tracker.update(targetId, {
                tagsAdd: Protocol.TAG.attention,
              }),
          );
        }
        cards.push(target.id);
      }
    }
    const destinations: Map<string, number> = new Map();
    if (run.mode === "discover" && !expired && !held)
      for (const choice of input.matching?.decisions ?? []) {
        renew();
        const finding: Protocol.Finding | undefined = input.findings.find(
          (entry): boolean => entry.fingerprint === choice.fingerprint,
        );
        if (!finding)
          throw new Error("Duplicate review names an unknown finding");
        const owned = state.db
          .query(
            "SELECT 1 FROM qa_flows WHERE project=? AND key=? AND run=? AND expires>?",
          )
          .get(run.project, finding.test.flow, id, Date.now());
        if (!owned) fail("Discovery no longer owns its flow");
        const target: number | undefined =
          choice.verdict === "same-run"
            ? destinations.get(choice.sameAs ?? "")
            : (choice.target ?? undefined);
        const staged = state.db
          .query<{ note_id: number }, [string, string]>(
            "SELECT note_id FROM qa_pending_findings WHERE run=? AND fingerprint=?",
          )
          .get(id, finding.fingerprint);
        const stale = state.db
          .query<{ note_id: number }, [string, string]>(
            "SELECT note_id FROM qa_findings WHERE project=? AND fingerprint=?",
          )
          .get(run.project, finding.fingerprint);
        if (
          stale &&
          stale.note_id !== target &&
          stale.note_id !== staged?.note_id
        ) {
          const old = await state.tracker.get(stale.note_id);
          if (old && old.status !== DELETED)
            fail("Finding identity belongs to an existing card");
          state.db
            .query("DELETE FROM qa_findings WHERE project=? AND fingerprint=?")
            .run(run.project, finding.fingerprint);
        }
        const draft = issueCard(finding, run);
        if (target) {
          const prior: Tracker.Card | null = await state.tracker.get(target);
          if (!prior || prior.status === DELETED)
            throw new Error("Duplicate card is unavailable");
          const abandoned = state.db
            .query(
              "SELECT 1 FROM qa_pending_findings WHERE note_id=? AND run<>?",
            )
            .get(target, id);
          if (abandoned && !tags(prior.tags).has(Protocol.TAG.issue)) {
            renew();
            await state.tracker.update(target, draft.changes);
          }
          const copied: number[] = await attach(
            state,
            id,
            target,
            finding.evidence,
            undefined,
            renew,
          );
          renew();
          state.db
            .query(
              "INSERT OR IGNORE INTO qa_findings (project,fingerprint,note_id,test) VALUES (?,?,?,?)",
            )
            .run(
              run.project,
              finding.fingerprint,
              target,
              JSON.stringify(finding.test),
            );
          const newer = state.db
            .query<{ verified_through: number }, [number]>(
              "SELECT verified_through FROM qa_findings WHERE note_id=?",
            )
            .get(target);
          const sequence =
            state.db
              .query<{ seq: number }, [string]>(
                "SELECT rowid AS seq FROM qa_runs WHERE id=?",
              )
              .get(id)?.seq ?? 0;
          const wasClosed: boolean =
            [COMPLETED, ARCHIVED].includes(prior.status) ||
            tags(prior.tags).has(Protocol.TAG.verified);
          if (wasClosed && (newer?.verified_through ?? 0) < sequence) {
            renew();
            state.db.transaction((): void => {
              state.db
                .query(
                  "INSERT OR IGNORE INTO qa_reopenings (run,note_id) VALUES (?,?)",
                )
                .run(id, target);
              state.db
                .query(
                  "UPDATE qa_findings SET fix=NULL,last_result=NULL WHERE note_id=?",
                )
                .run(target);
            })();
          }
          const closed: boolean = Boolean(
            state.db
              .query("SELECT 1 FROM qa_reopenings WHERE run=? AND note_id=?")
              .get(id, target),
          );
          if (closed) {
            if ([COMPLETED, ARCHIVED].includes(prior.status)) {
              renew();
              await state.tracker.reopen(target);
            }
            if (
              !tags(prior.tags).has(Protocol.TAG.pending) ||
              tags(prior.tags).has(Protocol.TAG.verified) ||
              tags(prior.tags).has(Protocol.TAG.attention)
            ) {
              renew();
              await state.tracker.update(target, {
                tagsAdd: Protocol.TAG.pending,
                tagsRemove: `${Protocol.TAG.verified},${Protocol.TAG.attention}`,
              });
            }
          }
          const report: string = `QA ${closed ? "reproduces this issue again" : "adds supporting evidence"}.\nRun: ${id}\n${links(state, copied)}\nTested revision: ${run.revision}\nActual: ${finding.actual}\nExpected: ${finding.test.expected}\nMatch: ${choice.reason}`;
          await comment(state, target, report, run.note_id, undefined, renew);
          destinations.set(finding.fingerprint, target);
          if (!cards.includes(target)) cards.push(target);
          continue;
        }
        let noteId: number | undefined = staged?.note_id;
        if (!noteId) {
          const key: string = `quaz-finding-${digest(`${run.project}:${finding.fingerprint}`)}`;
          renew();
          state.db
            .query(
              "INSERT OR IGNORE INTO qa_create_intents (run,fingerprint,key) VALUES (?,?,?)",
            )
            .run(id, finding.fingerprint, key);
          const note: Tracker.Card = await state.tracker.create(
            finding.title,
            key,
          );
          noteId = note.id;
          renew();
          state.db.transaction((): void => {
            state.db
              .query(
                "INSERT OR IGNORE INTO qa_pending_findings (run,fingerprint,note_id) VALUES (?,?,?)",
              )
              .run(id, finding.fingerprint, note.id);
            state.db
              .query(
                "DELETE FROM qa_create_intents WHERE run=? AND fingerprint=?",
              )
              .run(id, finding.fingerprint);
          })();
        }
        renew();
        await state.tracker.update(noteId, draft.changes);
        const copied: number[] = await attach(
          state,
          id,
          noteId,
          finding.evidence,
          undefined,
          renew,
        );
        renew();
        await state.tracker.update(noteId, {
          description: `${draft.description}\n\n${links(state, copied)}`,
        });
        renew();
        state.db
          .query(
            "INSERT OR IGNORE INTO qa_findings (project,fingerprint,note_id,test) VALUES (?,?,?,?)",
          )
          .run(
            run.project,
            finding.fingerprint,
            noteId,
            JSON.stringify(finding.test),
          );
        destinations.set(finding.fingerprint, noteId);
        cards.push(noteId);
        created.push(noteId);
      }
    if (expired) status = "superseded";
    await state.tracker.update(run.note_id, {
      description: `Run ${id}\nProject: ${run.project}\nMode: ${run.mode}\nRevision: ${run.revision}\nStatus: ${status}\n\n${held ?? input.summary}\n\nReport:\n\n\`\`\`json\n${JSON.stringify({ ...input.report, ...(held ? { publication: { held, findings: input.findings, matching: input.matching } } : {}) }, null, 2)}\n\`\`\``,
      ...(input.status === "failed" || held
        ? { tagsAdd: Protocol.TAG.attention }
        : {}),
    });
    await state.tracker.complete(run.note_id);
    const result: { cards: number[]; created: number[]; held?: string } = {
      cards,
      created,
      ...(held ? { held } : {}),
    };
    state.db.transaction((): void => {
      state.db
        .query(
          "UPDATE qa_runs SET status=?,receipt=?,result=?,expires=0,publish=NULL,publish_lease=NULL WHERE id=?",
        )
        .run(status, receipt, JSON.stringify(result), id);
      state.db
        .query("UPDATE qa_flows SET expires=0,status=? WHERE run=?")
        .run(status, id);
      state.db
        .query("DELETE FROM qa_publications WHERE project=? AND run=?")
        .run(run.project, id);
      state.db.query("DELETE FROM qa_pending_findings WHERE run=?").run(id);
      state.db.query("DELETE FROM qa_reopenings WHERE run=?").run(id);
    })();
    return {
      run: state.run(id),
      cards,
      created,
      replayed: false,
      ...(held ? { held } : {}),
    };
  } catch (error: unknown) {
    state.db.query("UPDATE qa_runs SET publish_lease=0 WHERE id=?").run(id);
    throw error;
  }
};
