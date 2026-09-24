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

The controller image does not bundle an app under test or a private review guide. A project image supplies the disposable app, and the guide is mounted when the controller runs. The extraction cutover gates remain in [draft PR #1](https://github.com/eduardosasso/quaz/pull/1).

## Codex subscription login in Docker

Quaz uses a Codex subscription login for guided reviews. It does not need an OpenAI API key. Keep the login in a dedicated Docker named volume. The controller requires that volume mounted read and write at `/auth`. It reads `/auth/auth.json` and saves refreshed credentials there after a run. The private `/qa` state volume is separate.

The controller uses `QUAZ_TRACKER_TOKEN` to reach the card API. A 1Password service account can supply that token at launch. It does not sign Codex in. Quaz gives each Codex worker a private copy of the login at `/credential`; it does not give the worker the tracker token. Claude Code OAuth is for GitHub review and release workflows, not Quaz QA workers. Merv access to this repository is a separate GitHub App setting.

Use the same Quaz image for login and for the controller. Set `image` to the exact image tag you plan to run. Then start a one-off login container:

```sh
image=ghcr.io/eduardosasso/quaz:sha-YOUR_COMMIT_SHA
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
