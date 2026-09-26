# Legacy QA contract

This is the contract before the Quaz extraction. Its Overdew commands and paths are historical. Use `README.md` for current setup. Keep this file until each acceptance criterion has a tested Quaz replacement.

## Original document

# Disposable QA runs

The QA runner tests one small mobile flow in a disposable Docker container.
Overdew stores the run, screenshots, report, findings, claims, and verification history.
The tested project and the Overdew tracking board are separate inputs.
Codex is the first provider. Provider invocation is isolated in `scripts/qa/provider.ts`.

## Acceptance criteria

- Discovery completes critique, audit, polish, layout, typeset, and adapt criteria for one selected flow.
- All sixteen required checks need evidence. All heuristic and audit scores need measurements.
- Design review inventories the whole selected surface and compares controls by task role before technical checks.
- Design evidence names the controls, their purpose, placement, treatment, peer comparisons, and a composition tradeoff.
- A viewed screenshot supports the design judgment. The validator rejects missing controls and inadequate comparisons.
- The validator audits coverage after independently reproducing the case.
- Technical measurements use the open surface in the reviewer browser, including dialogs.
- Each phase saves separate technical evidence. Validator measurements cannot replace the reviewer's evidence.
- Evidence includes source hashes, detector results, browser measurements, and a matching execution receipt.
- A separate model process and fresh browser reproduce every published finding.
- Discovery validation restarts the app with separate data and credentials seeded from the original scenario.
- Reviewer writes never replace the validator's initial state. Both phases record their starting fixture metadata.
- The publisher requires checked reports and screenshots returned inline to both reviewers.
- Discovery reads manual and QA issues before selecting a flow. Run cards and other projects are excluded.
- A separate model compares confirmed findings by meaning against the latest complete catalog and each other.
- A board publication lease serializes final comparisons. Changed snapshots, expired leases, or uncertain matches hold publication.
- Matching issues reuse their original cards and receive evidence comments. Human fields and existing acceptance tests remain intact.
- New issues receive `qa` and `needs-verification` tags. Exact identities remain an additional integrity check.
- Verification selects completed or archived pending QA cards from the selected project.
- The expected fix, deployed revision, and tested source revision must match before browser tests run.
- Every saved acceptance criterion must be checked before a result can pass.
- Passing removes `needs-verification` and `needs-attention`, and adds `verified`.
- Failing reopens the original card and preserves `needs-verification`.
- Missing setup adds `needs-attention`. Only an actionable blocked result mentions the configured person.
- An unavailable or different deployment leaves verification pending without a mention.
- A changed card or expired claim prevents an old result from changing the card.
- A newly reproduced issue reopens its original card. Older discovery cannot undo newer verification.
- Retries preserve one run, finding, artifact, and result comment.
- Existing human tags and descriptions remain intact.
- Reports for partial, failed, empty, and successful runs remain in Overdew.
- Test containers have separate app data, accounts, browser state, and temporary files.
- Product credentials and the Overdew publishing token never enter test containers.
- Local integration and browser tests pass before installation on Omarchy.
- One image starts as a controller or a disposable worker. Workers use the controller's exact image digest.
- The controller starts at most the configured number of workers, up to ten.
- Verification has priority. Discovery rotates scenarios and waits between batches.
- Failed runs retry after a delay and stop at the configured attempt limit for that revision and target.
- A controller restart removes its orphan workers and publishes pending evidence before new work starts.
- Workers cannot read the controller journal, publishing token, runtime volume root, or Docker socket.

## Modes

`discover` selects and claims a flow, applies six guide criteria, validates candidates, and publishes confirmed findings.
`verify` claims an eligible card, checks deployment, repeats its acceptance tests, and updates the original card.
Verification tests only saved acceptance criteria. Discovery runs the full six-guide review.
`smoke` tests project infrastructure without model calls or defect creation.

Run cards use `qa-run` and `project:<id>` tags. Issue cards use `qa` and `project:<id>`.
Run cards carry reports and screenshots. Issue descriptions and verification comments link to that evidence.
The server stores atomic claims and retry receipts alongside those cards in Overdew's database.
Tags are user-visible labels; they are not concurrency locks.

Final comparison includes active, completed, and archived cards, including manual cards without QA tags.
Unlabelled cards belong to the selected board context; `project:<id>` labels exclude other projects.
The catalog includes full titles, descriptions, checklists, tags, and comments. Oversized catalogs stop the run instead of hiding issues.
The catalog size and publication lease are bounded by constants in `src/qa_protocol.ts`.
Recovery can renew a lease only when the original catalog still matches. Changed or uncertain comparisons produce a partial run.
Such runs retain findings and evidence in their run report, with `needs-attention`, and create no issue cards.
A later fresh discovery must compare those findings again; this change does not automatically replay held reports.
Deploy the matching API before using new workers. Old workers cannot publish findings without a duplicate review.

## Local operation

Start Docker and install the repository's dependencies. Sign in with `codex login` for model runs.
Install Impeccable at `~/.agents/skills/impeccable`, or pass `--skill`.

```sh
# Starts a separate local Overdew tracking server, runs smoke, and leaves results available to inspect.
bun --no-env-file run qa:local --mode smoke --testers 3 --scenarios empty,typical,busy

# Same isolated setup, with one real discovery reviewer and independent validator.
bun --no-env-file run qa:local --mode discover --testers 1 --scenarios empty

# Checks discovery through verification against a separate sample app.
bun --no-env-file run qa:proof --once
```

The command prints a loopback login URL for the disposable tracking account.
Ctrl+C stops the interactive tracking server and removes its temporary database and evidence.
The proof with `--once` exports reports, screenshots, and lifecycle history, then exits and cleans up.
This does not use the normal development account or production board.
The proof uses an intentionally broken save action. It verifies reopening after a failed retest, then verifies the corrected version.
Its local version endpoint simulates deployment. It does not deploy a product.
Other discovered issues can remain pending. The proof never assumes its fixture fixes every finding.

To use an existing tracking server, inject `OVERDEW_QA_TOKEN` through your secret manager.
Set `OVERDEW_QA_URL` and `OVERDEW_QA_BOARD=workspace/board`, or use `--overdew` and `--board`.
Never put tokens in project configuration or command arguments.

```sh
bun --no-env-file run qa --mode discover --project scripts/qa/project.json --testers 2
bun --no-env-file run qa --mode verify --project /path/to/project.json --attention your-username
bun --no-env-file run qa --resume /temporary/recovery-directory
```

Other options: `--seconds`, `--scenarios`, `--skill`, `--auth`, `--model`, and `--provider codex`.
The default safety budget is thirty minutes; `--seconds` can lower it.
The budget is a ceiling, not a target. The worker returns when its checks finish.
Discovery reserves up to two minutes for final duplicate comparison. Independent validation receives one third of the remaining review time.
The worker budget includes app startup and browser/model work. Image preparation and evidence upload are measured separately.
A failed or timed-out run never counts as a successful fast review.

## Continuous Docker operation

The controller is another mode of this runner. No separate app, Compose file, or cron job is required.
It reads Overdew, fills available review slots, waits, and repeats. The host Docker engine creates sibling workers.
Only the controller receives the Docker socket. That socket gives it control of the host Docker engine.
Run this on a machine you trust with those permissions. Worker containers receive no Docker access.

Build the combined image from the project checkout. The build packages the installed Impeccable skill.
Build versions come from `scripts/qa/config.json`. The image contains Bun, Chromium, Codex, the Docker client, GitHub CLI, and the target app.

```sh
bun --no-env-file run qa:image --tag overdew-qa:local
```

Use `scripts/qa/controller.json` as the configuration. `parallel` sets capacity from one to ten.
`mode` accepts `auto`, `discover`, `verify`, or `smoke`. `auto` verifies eligible tickets before discovery.
`intervalSeconds` controls repeat discovery and verification checks. `pollSeconds` controls idle polling.
`retrySeconds` and `attempts` bound failure retries. `runs` limits a local trial; zero keeps the controller running.
Polling uses no model calls. Every actual review retains the existing bounded browser budget.

After Docker is available and credentials are supplied, one command starts the system:

```sh
docker run -d --init --name qa --restart unless-stopped --stop-timeout 120 \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=volume,src=qa-runtime,dst=/qa \
  --mount type=bind,src="$PWD/scripts/qa/controller.json",dst=/config/controller.json,readonly \
  --mount type=bind,src="$HOME/.codex",dst=/auth \
  --env OVERDEW_QA_URL --env OVERDEW_QA_BOARD --env OVERDEW_QA_TOKEN \
  overdew-qa:local
```

Supply the three `OVERDEW_QA_*` variables through your secret manager before startup.
For private fix PRs, also supply a scoped `GH_TOKEN` to the controller. Neither token enters workers.
The `/auth` directory needs an existing Codex login and must allow credential refresh.
Mount the directory, rather than one file, because refresh replaces `auth.json` atomically.
Smoke mode does not require a Codex login. The default Docker command starts controller mode.
The controller automatically creates its network and starts workers with `worker` mode from its pinned image.

`qa-runtime` only holds private credentials during a run, pending uploads, an ownership lock, and the tracking destination.
It is not a second ticket database. Published run files disappear after Overdew acknowledges them.
Keep this volume across controller restarts. Use a separate volume for another tracking board or project.
Only one controller can own a volume. Each controller's `parallel` limit applies to that controller.

The tracking server must include the controller API update. The controller rejects an older server's truncated history.
Recent attempts are retained per mode and ticket, so unrelated runs cannot reset a ticket's retry limit.
Review history remains in Overdew. Fixing the target and starting a new image revision permits a fresh retry budget.

The controller tests the app revision packaged in its image. It does not fetch or update app source while running.
For deployed-fix checks, build from a clean Git checkout with the project set to `revision: "git"`.
Mount a project file with `root: "/app"`, the correct adapter, and its deployment URL; point the controller configuration at it.
Rebuild and replace the controller image when the target app changes. A mismatched revision stays pending in Overdew.

```sh
docker logs -f qa
docker stop qa
```

## Controller validation

```sh
bun --no-env-file run qa:image --tag overdew-qa:controller-test
bun --no-env-file run qa:controller:proof
```

The proof uses a disposable local tracking account and real sibling Docker containers. It makes no model calls.
It checks parallel browser runs, unique accounts, exact image reuse, evidence hashes, an abrupt controller process failure,
orphan cleanup, publication recovery, and a two-attempt worker failure limit. Logs and screenshots remain under `artifacts/qa`.
Use `--parallel 10 --runs 12` to test ten simultaneous environments on a host with enough memory.
Add `--discover` to include one real Codex review, using the local Codex login.
That check requires separate initial fixtures, completed independent reproduction, and a tagged ticket for each confirmed finding.
Incomplete guide coverage or reproduction fails this discovery proof. Failed proof evidence is exported before cleanup.
The proof removes its containers, network, volume, and temporary tracking database.

## Project boundary

`project.json` names a project, its source root, Dockerfile, source inputs, adapter, context files, and scenarios.
Optional settings go only to the project's adapter. The runner does not assume Overdew routes or account behavior.
The adapter contract is in `scripts/qa/project.ts`. Each preparation receives a fresh directory for all mutable app data.
It returns the app command, fresh session, entry route, and readiness route. The adapter must use the supplied directory.
Both review phases receive the same run identity and scenario, preserving logical fixture names in separate databases.
The worker stops the reviewer's app before preparing the validator's app. It replaces browser authentication before replay.
It also supplies the project's smoke checks. `overdew.ts` is the first adapter.
Another project supplies its own adapter and an image containing the shared worker and browser runtime.
The small notes fixture exists only to test this boundary; it is not another product.

Use `revision: "source"` for disposable local tests. It hashes configured source files and adapter settings.
Use `revision: "git"` for deployed-fix verification. This requires a clean checkout at the deployed commit.
The project must expose a version endpoint returning `{ "revision": "<full commit SHA>" }`.
Configure it as `deployment.url`. The Overdew adapter's target provides `/api/version` from `KAMAL_VERSION`.
If `deployment.repository` is set, the runner resolves the latest matching merged GitHub PR linked in the card or comments.
Otherwise the expected fix revision can be recorded through the board's QA API.
An absent, unmerged, mismatched, or unreachable deployment blocks verification.
A disposable replay of a deployed revision does not prove production configuration or external integrations.

## Evidence, recovery, and credentials

Successful runs delete temporary host artifacts after Overdew acknowledges publication.
An interrupted upload retains a temporary recovery descriptor and evidence until `--resume` completes.
Recovery starts before run creation. Lost startup responses and interrupted builds preserve a retry path.
This spool is not a second coverage database or ticket ledger.
Run and artifact receipts make a lost HTTP response safe to retry.
Credentials never enter reports, project configuration, or images.
Each Codex process receives a private credential directory. Refreshed credentials use a process lock and conflict detection.
An unexpected concurrent refresh preserves the newer host credential and reports an error.
That error does not prevent publication of the completed review and its evidence.
No API key fallback is supplied. Claude support, automatic app-image updates, and Omarchy installation remain outside this slice.

## Validation

### Local visual prompt eval

`qa:eval` compares design review prompts with fixed screenshots, recorded browser evidence, and hidden criteria.
It uses Bun, Zod, and the existing Codex login. No new service or eval library is required.
It does not publish tickets or change a deployed image.
`scripts/qa/design.md` holds the shared product design criteria. The browser reviewer, independent validator, and default eval read that file.
The live worker also applies all six Impeccable guides. Its role, flow selection, response schema, and evidence rules remain in `QA.md`.
The live report includes a structured `design` assessment. Short guide notes cannot replace its comparisons.
The reviewer captures the ordinary state before failure injection or technical inspection.
The validator audits the inventory and comparisons after independently reproducing candidates.
Unknown design judgments or unsupported design evidence keep the run partial. A coherent design can produce zero findings.
Both live prompts include the design text and hash. `guidance.json` records its source and hash.
The eval adds image-specific output rules. It does not give those rules or hidden labels to the live worker.
Use `--prompt` to try a candidate file without changing the shared guidance.

```sh
bun --no-env-file run qa:eval \
  --suite artifacts/qa/evals/suite-v4.json \
  --output artifacts/qa/evals/baseline

bun --no-env-file run qa:eval \
  --suite artifacts/qa/evals/suite-v4.json \
  --prompt path/to/candidate.md \
  --baseline artifacts/qa/evals/baseline/report.json \
  --output artifacts/qa/evals/candidate
```

Each output directory must be new. Keep private screenshots, rubrics, and reports under gitignored `artifacts/`.
The current private suite has seven cases in `artifacts/qa/evals/suite-v4.json`.
Five calibration cases cover the two owner examples, a simple form, starter clipping, header overflow, and metadata contrast.
A separate calibration case preserves the missed ordinary mobile card and its neutral recorded interactions.
Run this case at the live worker's reasoning effort as well. Saved-image success does not establish live detection.
The header and contrast cases share one scene. They move together into calibration after a failed reserved run informs a change.
Two new holdout scenes come from an independent author who does not read the review prompt or prior examples.
These synthetic desktop scenes test a coherent dispatch view and a visible text collision in a purchase order.
Their screenshots, criteria, and hashes are frozen before model evaluation. They test visual judgment, not live behavior.
`past-sources.json` records local ticket receipts, source hashes, and browser event identifiers for the three historical issues.
No saved verified fix exists for these issues. Their fix pairs stay pending; different text sizes do not count as fixes.
Those private fixtures are not shipped with the repository. A fresh checkout needs a local suite.
The suite shape is `suiteSchema` in `scripts/qa/eval.ts`:

```json
{
  "version": "product-calibration-1",
  "model": "YOUR_CODEX_MODEL",
  "effort": "medium",
  "cases": [{
    "id": "surface-a",
    "split": "calibration",
    "images": ["fixtures/01.png"],
    "context": "Neutral task context supplied to the reviewer.",
    "scope": "Hidden scope for judging the review.",
    "expected": [{"id": "concern-a", "image": 1, "criterion": "The visible relationship that a finding must identify."}],
    "cautions": ["Do not infer unseen behavior."]
  }]
}
```

Image numbers start at one. Paths resolve beside the suite file. Use `expected: []` when no target concern is expected.
This does not certify the whole image as flawless. Include coherent screens to measure false alarms.
Keep issue hints out of `context`. Neutral recorded browser observations may be included there.
Extract raw measurements only. Full browser transcripts can contain diagnoses and must stay hidden.
Saved observations test evidence interpretation. They do not test whether the agent chooses the right browser actions.
Cases used to tune a prompt remain calibration cases.
Add unseen examples as `holdout`; do not tune against those results.
The default run selects calibration only. Run the reserved cases after freezing a candidate:

```sh
bun --no-env-file run qa:eval \
  --suite artifacts/qa/evals/suite-v4.json \
  --split holdout \
  --output artifacts/qa/evals/holdout-new
```

Use `--split all` only for an explicit full evaluation. Comparisons require the same selected split.
An identical image cannot cross calibration and holdout. Keep related screenshots from one scene together as well.
Adding cases or changing recorded observations requires a new baseline. Earlier reports remain available.

Each case runs twice, with two independent grades per review. Two model calls run in parallel at most.
Reviewers receive neutral context, recorded observations, the candidate prompt, and images. Graders also receive the hidden rubric.
Grades match meaning and cite exact review text. Unexpected supported findings do not count as false alarms.
Missing issues, false alarms, unsupported claims, uncertain grades, or grader disagreement prevent a pass.
Invalid or interrupted attempts also prevent a pass. There are no automatic retries or baseline replacements.
Rerun calibration after each change to the design prompt, review rules, or review logic. Freeze the candidate before running holdout.
A grading disagreement needs investigation; do not weaken expected criteria or retry until a run passes.
Labels and visible hierarchy can support a qualified reading of an intended role. They cannot prove an action works.
Grade that distinction explicitly. Keep failed reports and create a new baseline after correcting grading rules.
Changing the runner or grading rules requires a new baseline. Keep earlier failures available.
These model evals run explicitly with `qa:eval`; ordinary unit tests do not spend model credits or assess visual judgment.
Passing evals permits a live browser trial. It does not prove autonomous exploration or the full ticket lifecycle.

Reports preserve input hashes, prompts, image copies, model settings, raw responses, events, and timing.
Comparisons reject changes to images, rubric, judge, runtime, model settings, or repeat count.
They flag regressions per case and repetition. Improvements elsewhere cannot cancel a regression.
`--repeats N` increases review repetitions. `--seconds N` changes the per-call timeout, initially 300 seconds.
Model aliases can change upstream. Pin a model snapshot when available and remeasure after model updates.

### Verification judgment eval

`qa:eval:verify` checks saved acceptance decisions with the live verification prompt and response schema.
It uses the same six guide excerpts as the worker. The eval replaces browser work with recorded evidence.
It does not open cards, start agents, or publish results.

```sh
bun --no-env-file run qa:eval:verify \
  --suite scripts/qa/fixtures/verification/suite.json \
  --skill /path/to/impeccable \
  --output artifacts/qa/verification-evals/run-1
```

The committed screenshots contain only disposable QA accounts. Their source revisions and hashes are in `provenance.json`.
The suite tests readable identity, hidden identity, clipped actions, explicit full names, missing measurements, and the historical no-concealment contract.
The readable-identity case accepts a shortened name when a distinct, complete handle identifies the row.
The full-name and historical cases still fail. The verifier cannot weaken saved requirements to accept a fix.
No existing card or acceptance criterion changes when this eval runs.
The historical third check has two defensible readings. Its label requires independent rubric review instead of forcing either boolean.
The overall failure and the failed name check remain mandatory. This ambiguity never becomes an automatic green result.
Exit codes are 0 for pass, 1 for failure, and 2 for rubric review. Interrupted reports remain incomplete.

Each case runs twice in fresh model processes at the suite's reasoning effort. The supplied suite uses the worker's current low effort.
At most two independent model calls run at once, using the same limit as the design eval.
This overlaps waiting time without reducing checks or increasing the number of calls.
Reports keep stable case order. Serialized, atomic writes preserve completed results while other calls remain active.
Case IDs, expected verdicts, and check labels stay outside the model prompt.
The scorer checks every saved criterion, its result, the verdict, completion state, and evidence names.
An explicit `labels.checks` review object records an ambiguous item and its reason. Every criterion must still appear in the model response.
Missing evidence must remain blocked. Model errors fail the attempt and appear in the report.
Review explanations independently too; exact verdict scoring does not prove that the reasoning is correct.
All six related cases are calibration. They do not establish general accuracy or live browser skill.

Use `--prompt criteria.md` to test alternative verification guidance without editing the worker.
An empty file measures the previous instruction without the added judgment guidance.
Each run preserves the inputs, image hashes, instructions, model settings, responses, event logs, and timing.
Use a new output directory for every run. Compare runs only with matching fixtures, labels, model settings, and runtime.

This measures review of saved evidence, not fresh browser exploration, current production behavior, or general accuracy.
The prompt adapts Impeccable, Product Design Review, and better-layout criteria; it does not execute full skill commands.

```sh
bun --no-env-file run lint
bun --no-env-file run check
bun --no-env-file test --isolate src/__tests__/qa-*.test.ts
bun --no-env-file run test
```

Use a fresh-context validator to challenge lifecycle races, stale results, deployment proof, evidence, and cleanup.
The local browser proof must use real Docker containers and a separate Overdew tracking server.
Chromium mobile emulation does not prove physical-phone keyboards or Safari behavior.
The six guides supply scoped review criteria; the runner does not execute six full Impeccable command workflows.
