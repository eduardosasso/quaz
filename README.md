# Quaz

Quaz runs isolated QA reviews against a web app. It keeps run history in its own SQLite database. It publishes report cards, findings, comments, and evidence through a card API. The app under test needs no Quaz code.

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
bun --no-env-file run qa -- --mode smoke --project /path/to/project.json --output /path/docker-can-mount
```

The tracker adapter in `src/adapters/overdew.ts` uses HTTP endpoints only. It does not import the tracker app. Replace this adapter to use another card service. The `Tracker` interface in `src/tracker.ts` defines the required operations.

The project config selects source files, a container adapter, scenarios, and deployment details. Quaz copies only listed sources into the image build context. Include all files needed to build the app. The default adapter reads `settings.command`, `settings.origin`, `settings.entry`, and `settings.ready`. It runs the app inside the container and checks it with Playwright. Use `settings.setup` for app data setup. The default Dockerfile expects a Bun app with `bun.lock` and a `build` script. Set `dockerfile` in the project config for another app stack.

Use `--mode discover` for a guided review. The controller selects reported fixes for `--mode verify`. Quaz stores results in `QUAZ_DB`. Use one database per tracker board.

## Development

```sh
bun --no-env-file run lint
bun --no-env-file run check
bun --no-env-file run test
```

Quaz creates cards with an idempotency key. The tracker must replay a matching request and reject a changed request. This lets Quaz retry publication after an interrupted API call.

## Reviews and image releases

Pull requests run lint, type checks, tests, and the shared Claude Code Review workflow. Merv reads those checks and can review the pull request when its GitHub App and repository allowlist include Quaz. `.merv.json` defines the same checks for Merv. It has no ship command.

On a push to `main`, validation builds and publishes `ghcr.io/eduardosasso/quaz:sha-<full-commit-sha>`. Main must require passing validation, Claude review, and Merv checks before this workflow is merged. The image records the full source SHA and package version in OCI labels. Publication does not start Quaz or install a QA schedule.

Run the **Plan version** workflow on `main` to select a stable SemVer bump from merged commits. Claude chooses major, minor, or patch and gives one reason. The workflow accepts an explicit override. A missing or invalid model answer stops the plan. Apply that plan in a normal pull request, then create an explicit `vX.Y.Z` Git tag on its merged commit. The tag workflow publishes that version tag only when it matches `package.json` and points to a commit on `main`.

The controller image does not bundle an app under test or a private review guide. A project image supplies the disposable app. The controller copies the mounted review guide into each private run directory. The extraction cutover gates remain in [draft PR #1](https://github.com/eduardosasso/quaz/pull/1).

## Codex subscription login in Docker

Quaz uses a Codex subscription login for guided reviews. It does not need an OpenAI API key. Keep the login in a dedicated Docker named volume. The controller requires that volume mounted read and write at `/auth`. It reads `/auth/auth.json` and saves refreshed credentials there after a run. The private `/qa` state volume is separate.

The controller uses `QUAZ_TRACKER_TOKEN` to reach the card API. A 1Password service account can supply that token at launch. It does not sign Codex in. Quaz gives each Codex worker a private copy of the login at `/credential`; it does not give the worker the tracker token. Claude Code OAuth is for GitHub review and release workflows, not Quaz QA workers. Merv access to this repository is a separate GitHub App setting.

Build the project image as shown below. Use that image for both login and the controller. Then start a one-off login container:

```sh
image=quaz:your-project-revision
docker volume create quaz-codex-auth
docker run --rm -it \
  --mount type=volume,src=quaz-codex-auth,dst=/auth \
  --env HOME=/auth --env CODEX_HOME=/auth \
  --entrypoint codex "$image" login --device-auth
```

Open the link shown by Codex and enter its one-time code. Verify the stored login with the same volume:

```sh
docker run --rm \
  --mount type=volume,src=quaz-codex-auth,dst=/auth \
  --env HOME=/auth --env CODEX_HOME=/auth \
  --entrypoint codex "$image" login status
```

Mount `quaz-codex-auth` at `/auth` when starting the controller. Mount another named volume at `/qa`. A review controller stops before scheduling if the auth mount or login file is missing. Docker preserves both named volumes when the containers restart or the image changes. Do not mount a host Codex home directory or copy `auth.json` into the image.

## Controller startup contract

Build a project image with `scripts/qa/image.ts`. It contains Quaz and the selected app sources. The published Quaz release image contains Quaz tools only; it cannot run a target app by itself. Keep app source and project config at the same absolute paths on the Docker host and inside the controller. Set the project config `root` to that source path. Set its `revision` to `source` for this startup path.

The controller needs a project config, a controller config, and a local project image. The controller config names the project config, for example `{"project":"/absolute/path/to/project.json","mode":"auto"}`. Build the image before starting the controller:

```sh
project_dir=/absolute/path/to/project-config
source_dir=/absolute/path/to/app-source
guide_dir=/absolute/path/to/impeccable
image=quaz:your-project-revision
bun --no-env-file scripts/qa/image.ts \
  --project "$project_dir/project.json" --tag "$image"
```

Create an Overdew personal access token in Account settings. Store it as `QUAZ_TRACKER_TOKEN` in a Quaz 1Password Environment. Copy the Environment ID from 1Password Developer settings and pass it as `QUAZ_ENVIRONMENT`. A service account can reuse an existing token if it has access to this Environment. Pass `OP_SERVICE_ACCOUNT_TOKEN` from the host secret store at container start. Both values must be present together. The controller fails if the tracker token is missing after 1Password loads the Environment. For local checks, you can pass `QUAZ_TRACKER_TOKEN` directly without either 1Password value.

```sh
docker volume create quaz-state
docker run --detach --name quaz-controller --restart unless-stopped \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=volume,src=quaz-state,dst=/qa \
  --mount type=volume,src=quaz-codex-auth,dst=/auth \
  --mount "type=bind,src=$project_dir,dst=$project_dir,readonly" \
  --mount "type=bind,src=$source_dir,dst=$source_dir,readonly" \
  --mount "type=bind,src=$guide_dir,dst=/opt/impeccable,readonly" \
  --env OP_SERVICE_ACCOUNT_TOKEN \
  --env QUAZ_ENVIRONMENT=YOUR_QUAZ_ENVIRONMENT_ID \
  --env QUAZ_TRACKER_URL=https://your-tracker.example \
  --env QUAZ_TRACKER_BOARD=owner/board \
  "$image" controller --config "$project_dir/controller.json"
```

This command starts recurring QA work. Use it only after the extraction cutover checks pass. The controller has the Docker socket, so it must run on a trusted Docker host. It gives each worker only private `/qa` run subpaths, a read-only guide copy, and a per-run `/credential` copy. The worker gets an ephemeral bridge token. It has no Docker socket, tracker token, 1Password token, or Claude token. The app server receives adapter-provided variables. Quaz removes the worker after the run and reconciles any Codex login refresh into `/auth` under a lock.

Docker image builds receive only public version and revision arguments. They do not receive Codex, 1Password, tracker, or Claude credentials. GitHub Actions uses its temporary `GITHUB_TOKEN` to publish the image. Claude review and release planning use `CLAUDE_CODE_OAUTH_TOKEN` in their jobs. Those tokens never enter the image build. The project image stages only the app sources listed in `project.json`; do not list secret files.
