# QA extraction map

This map uses Overdew main `482e2ed8` after PR #207. Quaz began at `98896a7`.
The current branch is a cutover candidate. The gaps below keep Overdew PR #208 in draft.

| Overdew source | Quaz destination | State |
| --- | --- | --- |
| `src/qa_protocol.ts` | `src/qa_protocol.ts` | Moved; Quaz owns QA tags, modes, schemas, and limits. |
| `src/qa.ts` | `src/state.ts`, `src/finish.ts`, `src/record.ts` | Adapted; run execution stays local. Ticket facts now have generic card-file records. Historical import and parallel publication need proof. |
| `src/qa_api.ts` | `scripts/qa/client.ts`, `src/adapters/overdew.ts`, `src/tracker.ts` | Replaced; Quaz uses generic card, comment, and file APIs. |
| `scripts/qa/client.ts`, `controller.ts`, `docker.ts`, `entry.ts`, `lifecycle.ts`, `run.ts`, `worker.ts` | Same paths | Moved or adapted for the independent service and target project. |
| `scripts/qa/coverage.ts`, `duplicates.ts`, `eval-model.ts`, `eval.ts`, `inspect.ts`, `provider.ts`, `review.ts`, `verify-eval.ts` | Same paths | Moved. |
| `scripts/qa/QA.md`, `design.md` | Same paths | Moved. The PR #207 verifier guidance is included. |
| `scripts/qa/config.json` | Same path | Adapted for Quaz image and controller defaults. |
| `scripts/qa/fixtures/verification/{01.png,02.png,provenance.json,suite.json}` | Same paths | Moved unchanged. |
| `scripts/qa/image.ts` | Same path | Adapted for a separate Quaz build context. |
| `scripts/qa/Dockerfile`, `Dockerfile.dockerignore` | Root `Dockerfile`, `.dockerignore`, `examples/overdew/Dockerfile` | Separate Quaz and app build contexts. The Overdew image builds; controller proof remains open. |
| `scripts/qa/project.ts`, `project.json`, `overdew.ts`, `fixture.ts` | `scripts/qa/project.ts`, `command.ts`, `examples/project.json`, `examples/overdew/adapter.ts`, `fixture.ts`, and project JSON files | The project contract is generic. The optional Overdew target adapter prepares disposable login and empty, typical, busy fixtures. |
| `scripts/qa/local.ts`, `proof.ts`, `controller-proof.ts`, `controller.json` | `examples/overdew/probe.ts`, `proof.ts`, `controller.json`; controller proof pending | Disposable browser smoke is codified. Full run, publication, and controller restart proof remain open. |
| `docs/qa.md` | `docs/legacy-contract.md`, this map, `README.md` | Original acceptance contract retained. Current command documentation needs completion. |
| `src/__tests__/qa-{controller,duplicates,eval-model,eval-split,eval,inspect.integration,orchestration,review,runner,verify-eval}.test.ts` | Same paths | Moved or adapted; tests pass. |
| `src/__tests__/fixtures/qa-target.ts` | Same path | Moved sample target. |
| `src/__tests__/qa-fixture.test.ts`, `qa-lifecycle.integration.test.ts`, `qa-proof.test.ts` | Replacement integration tests pending | These exercise disposable Overdew setup and full lifecycle. They are not covered by unit tests. |
| Generic tags, search, files, colors, card status, and agent comment wake | Overdew product modules and tests | Remain in Overdew. Quaz treats QA as ordinary labels and uses generic APIs. |

## Required cutover proof

- Every old finding has an exact card ID, fingerprint, saved test, fix state, and evidence mapping. Missing data stops migration.
- A fresh Quaz database finds old pending cards and avoids duplicate findings through generic cards and files.
- Disposable Overdew empty, typical, and busy scenarios work, including authenticated browser use and evidence uploads.
- Discovery, verification, blocked results, failure reopening, stale-result rejection, and retries keep the original cards and evidence.
- One controller image runs workers without sharing the publishing token, Docker socket, or mutable app data.
- Every run records separate app revision and Quaz runner provenance, including the target adapter and Dockerfile.
- The latest Overdew main, Quaz tests, and an independent validator pass before cutover.

No production migration or controller installation has run from this branch.

## App and tracker boundary

Quaz can test any app with a project config and a target adapter. The target adapter starts a disposable app revision and prepares test data. `examples/overdew` is one optional target adapter; RDLTR, Neologin, and Surrge can provide their own.

The `Tracker` interface stores run and finding cards, comments, and evidence. `src/adapters/overdew.ts` translates that interface to Overdew's generic HTTP API. This adapter is independent of the tested app. The same Overdew board can track work from several projects through `project:*` labels and machine records. Overdew does not interpret Quaz modes or QA labels.

The current local SQLite still owns run history, flow claims, publication leases, and successful-verification order. Card files now preserve new finding tests and fix revisions, but that is not sufficient for a fresh controller. Old cards have no machine record. The app revision does not include the adapter or Dockerfile, so runner provenance needs a separate field. These gaps block cutover.
