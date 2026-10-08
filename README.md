# Quaz

Quaz runs isolated QA reviews against web apps. A project adapter prepares each app for testing. A tracker adapter stores runs, findings, comments, and evidence in a card service. These adapters serve different purposes. The app under test needs no Quaz code in production.

## Requirements

- Bun 1.4, Docker with bind mounts, and access to a card API.
- An API token that can read and write cards, comments, and attachments on one board.
- A project config like `examples/project.json`.
- A Docker host that can mount the selected output directory. With Colima on macOS, use a path under `/Users`.

## Setup

```sh
bun install --frozen-lockfile
export QUAZ_TRACKER_URL=https://your-tracker.example
export QUAZ_TRACKER_BOARD=owner/board
export QUAZ_TRACKER_TOKEN=your-api-token
export QUAZ_DB=/path/to/quaz-state.db
export QUAZ_BOOTSTRAP=empty
bun --no-env-file run qa -- --mode smoke --project /path/to/project.json --output /path/docker-can-mount
```

The tracker adapter in `src/adapters/overdew.ts` sends ordinary card API requests to Overdew. It works for every app Quaz tests. Overdew stores the work and does not run the tests. The `Tracker` interface in `src/tracker.ts` defines the required operations.

For example, a Quaz run can test RDLTR and create its finding card in Overdew. Another run can test Neologin or Surrge and use the same tracker adapter. Each tested app needs its own project config and target adapter. `projects/overdew` holds the Overdew project config and an optional target adapter for testing Overdew itself.

One Quaz image runs the controller and every worker. Run the target app separately, then set `revision` to `target` in its project config. Set `deployment.url` to a reachable revision endpoint and `deployment.revision` to its deployed commit. A `GET` request to that endpoint must return the revision in an `x-quaz-revision` header or a JSON `revision` field. Set `settings.origin` to the same origin, with `settings.entry` and `settings.ready` as paths within it. A custom adapter must return that same origin. Quaz checks the revision before, during, and after each run. Quaz does not need the target source or its image.
Remote targets receive browser measurements without source files. The source detector reports unavailable for these runs.

Source mode builds a disposable app image from a checkout on the Docker host. The controller and workers still use the same Quaz base. Set `revision` to `git` for deployed-fix checks. Keep the checkout clean and at the deployed commit. While the checkout differs from the deployment, the controller waits with backoff and logs `revision-wait`. It continues on the new revision after the checkout is updated; no restart is needed. A run that the revision change interrupts logs `run-stale` and does not count toward the worker retry limit. The default project Dockerfile supports Bun apps with a `build` script. Set `dockerfile` in the project config for other stacks.

Set `fetch` to `true` to let the controller update the checkout itself. The controller fetches the deployed commit into `root`, inside its own state volume (for example `/qa/source`). It needs `deployment.url` and `deployment.repository`. It reads `QUAZ_SOURCE_TOKEN_<OWNER>` from the Quaz 1Password Environment. The owner comes from `deployment.repository`, in uppercase, and `-` becomes `_`. Use one fine-grained GitHub token per owner, with read-only Contents access. The owning account must create the token, because fine-grained tokens cannot reach repositories where you are only a collaborator. Quaz passes the token to Git through its process environment and never stores it. Quaz resets this checkout on every sync, so keep no other files there. The host mount stays read-only.

Complete a QA card with a fix link (a pull request or commit in `deployment.repository`) and Quaz verifies the fix against the running app. Quaz reads the link only as text and never calls GitHub. It retests each such card once per deployed revision. A failed retest leaves the card alone. The third failure on three different deployed revisions in a row reopens it with evidence. Complete it without a link and Quaz treats it as won't fix: it never reopens the card or files the same issue again. Delete a card and Quaz forgets it, so the issue can return as a new card.

Use `--mode discover` for a guided review. The controller selects reported fixes for `--mode verify`, once per deployed revision. `QUAZ_DB` is the only store for run state. One process at a time owns it through an exclusive lock on `QUAZ_DB.lock`. On first start, Quaz migrates an old Overdew board document snapshot into `QUAZ_DB` once. Set `QUAZ_BOOTSTRAP=empty` for a new board; Quaz refuses it when the board already has QA cards for the project. Remove that setting after the first start.

## Development

```sh
bun --no-env-file run lint
bun --no-env-file run check
bun --no-env-file run test
```

Quaz stores each new card ID before later API writes. The Overdew adapter uses a temporary title marker to recover a card when the create response is lost. Other tracker adapters must make card creation safe to retry with the supplied key.

## Reviews and image releases

Pull requests run lint, type checks, tests, and the shared Claude Code Review workflow. Merv reads those checks and can review the pull request when its GitHub App and repository allowlist include Quaz. `.merv.json` defines the same checks for Merv. Its ship command deploys the controllers to omarchy after each merge to `main`. Merv runs `bun ship` in a ship job. `bun ship` deploys one controller for each folder in `projects/`. The image builds and pushes once. The job gets `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` from Merv's 1Password Environment. `scripts/deploy.sh` reads the Quaz service token from omarchy and the registry token from Quaz's Environment.

To add a project, add `projects/<id>/project.json` to the repository. The file holds the project fields and a `controller` key with the controller settings. Add an adapter next to it if the app needs sign-in or seed data. The target app must use `fetch: true` or `revision: target`, because the controller image has no host files. Put secrets, such as `QUAZ_SOURCE_TOKEN_<OWNER>`, in the Quaz 1Password Environment. Merge the change. Merv deploys the new controller. Set `QUAZ_PROJECT_ID` to deploy one project by hand.

On a push to `main`, validation builds and publishes `ghcr.io/eduardosasso/quaz:sha-<full-commit-sha>`. Main must require passing validation, Claude review, and Merv checks before this workflow is merged. The image records the full source SHA and package version in OCI labels. Publication does not start Quaz or install a QA schedule.

Run the **Plan version** workflow on `main` to select a stable SemVer bump from merged commits. Claude chooses major, minor, or patch and gives one reason. The workflow accepts an explicit override. A missing or invalid model answer stops the plan. Apply that plan in a normal pull request, then create an explicit `vX.Y.Z` Git tag on its merged commit. The tag workflow publishes that version tag only when it matches `package.json` and points to a commit on `main`.

The shared Quaz image holds the QA tools, runner, and pinned Impeccable skill. The same image runs in controller and worker mode for every remote target. Each project config selects a target URL and QA scenarios. [The extraction map](docs/extraction.md) records the remaining cutover proof.

## Claude subscription token

Quaz uses Claude Code for guided reviews. Run `claude setup-token` on a trusted machine. Put its output in `CLAUDE_CODE_OAUTH_TOKEN` in Quaz's 1Password Environment. The token lasts one year. Renew it before expiry. Do not put it in an image, project source, or `.env` file.

The controller reads `QUAZ_TRACKER_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` from Quaz's Environment at launch. It gives each worker a private token file under `/qa`. Only the Claude review process receives that token in its environment. Claude scrubs credentials from tool subprocesses. Raw Claude logs stay on the worker's temporary filesystem and are never tracker artifacts. The app server receives adapter-provided variables. The worker never receives the tracker or 1Password service token. Merv's Claude token remains separate.

## Subscription usage protection

Set `"usage": true` in the controller config to enable the guard. The Overdew project enables it under `controller.usage`. Existing configs keep their current behavior until this flag is enabled. Smoke tests do not use Claude and bypass the guard.

The guard reads actual five-hour and weekly meters from Claude's `rate_limit_event` metadata. It never asks the model to estimate usage. It stores samples, reservations, and observed QA consumption in `/qa/usage.json`, inside the controller's persistent volume. Use one guarded controller per Claude subscription. Separate controllers do not share this ledger.

The policy lives in `scripts/qa/config.json`, under `usage`:

- Keep at least 50% available while learning from the first 24 hours of usable idle observations.
- Forecast personal use until each reset from a weekly profile. Each hour of the week uses the busiest rate seen in that hour in any recorded week. Hours without data use the higher of the recent six-hour rate and the recorded average. Reserve that forecast plus a ten-point `margin`. The margin is the part of each window that QA never uses.
- Exclude QA intervals and reset crossings from personal usage learning. Keep 14 days of history. Concurrent personal use during QA counts conservatively toward QA consumption.
- Allow only one QA run at a time, at least one hour apart. Estimate the next run from the average recorded run, with a safety factor. Spread the spare allowance until reset. The same spare allows more frequent runs as the reset gets closer, because unused allowance expires.
- Require both meters to be less than five minutes old. Pause on missing data, expired windows, cooldowns, or storage failures. Check before each model phase and monitor its response stream. Stop that phase when a reserve is reached.
- When idle, obtain fresh metadata at most once per hour with a tool-free Haiku probe. During active runs, refresh after three minutes without a new stream reading. Share each refresh across worker requests. Pause if a refresh fails; retain the hourly retry cooldown. Each probe has a 45-second timeout and a $0.02 API-equivalent budget. This bounds probe work, not an extra subscription charge. Probe usage contributes to the account readings and counts toward QA during active runs. Logs distinguish active probes from idle probes.

Limits apply when Claude reports usage. An in-flight request can exceed a threshold before it returns. This guard reduces QA consumption but cannot guarantee unused subscription capacity. It does not control your other applications. A paused or interrupted review cannot verify a fix.

For rollout, first run the new image with a separate temporary ledger and inspect `usage-probe` and `usage-decision` logs. Enable the controller flag only after both meters and pause behavior are confirmed. Preserve the existing image digest and configs for rollback. Disabling the flag restores the previous schedule; stopping the controller keeps QA paused. Never delete the ledger to clear a limit.

## Controller startup contract

Build or pull the shared Quaz image. Set `QUAZ_BASE_IMAGE` to a registry image with an `@sha256:` digest to use a published image. The published image must match a clean Quaz checkout at the same commit. Keep the project config at the same absolute path on the Docker host and inside the controller. For source mode, mount the complete target checkout at the project config's `root`. The deployment preflight checks declared source files, any custom Dockerfile, and a clean Git checkout. When a deployment URL is set, its revision must match that checkout. For remote mode, the target app must be reachable from the worker's Docker network.

The controller needs a project config and a controller config. The controller config names the project config, for example `{"project":"/absolute/path/to/project.json","mode":"auto"}`. Build the shared image before starting the controller:

```sh
project_dir=/absolute/path/to/project-config
image=$(bun --no-env-file -e 'import * as Image from "./scripts/qa/image.ts"; console.log(await Image.base())')
```

Create an Overdew personal access token in Account settings. Store it as `QUAZ_TRACKER_TOKEN` in a Quaz 1Password Environment. Copy the Environment ID from 1Password Developer settings and pass it as `QUAZ_ENVIRONMENT`. A service account can reuse an existing token if it has access to this Environment. Pass `OP_SERVICE_ACCOUNT_TOKEN` from the host secret store at container start. Both values must be present together. The controller fails if the tracker token is missing after 1Password loads the Environment. For local checks, you can pass `QUAZ_TRACKER_TOKEN` directly without either 1Password value.

```sh
docker volume create quaz-state
docker run --detach --name quaz-controller --restart unless-stopped \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=volume,src=quaz-state,dst=/qa \
  --mount "type=bind,src=$project_dir,dst=$project_dir,readonly" \
  --env OP_SERVICE_ACCOUNT_TOKEN \
  --env QUAZ_ENVIRONMENT=oideewasrzxrhplsrtvqlozjna \
  --env QUAZ_TRACKER_URL=https://your-tracker.example \
  --env QUAZ_TRACKER_BOARD=owner/board \
  --env QUAZ_BOOTSTRAP=empty \
  "$image" controller --config "$project_dir/controller.json"
```

The `--config` file is a project file with a `controller` key, or a controller file. A controller file holds a `project` path and the controller settings. The command above uses a controller file.

This command starts recurring QA work. The controller retries failures inside the process with backoff, so 1Password loads the Environment once per start. After a failed exit, the entry point waits with backoff before it reads 1Password again. After five failed exits in a row, it logs `controller-halted` and stops reading 1Password until the container is recreated. Each fatal stop logs one `controller-fatal` event. Keep the `unless-stopped` policy: Docker does not restart `on-failure` containers after a host reboot. Use it only after the extraction cutover checks pass. The controller has the Docker socket, so it must run on a trusted Docker host. It gives each worker only private `/qa` run subpaths and a per-run `/credential` token. The worker gets an ephemeral bridge token. It has no Docker socket, tracker token, or 1Password token. Quaz removes the worker and its token file after the run.

Docker image builds receive only public version and revision arguments. They do not receive 1Password, tracker, or Claude credentials. GitHub Actions uses its temporary `GITHUB_TOKEN` to publish the shared image. Claude review and release planning use a separate `CLAUDE_CODE_OAUTH_TOKEN` in their jobs. Those tokens never enter the image build.
