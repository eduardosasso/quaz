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
bun --no-env-file run qa -- --mode smoke --project /path/to/project.json --output /path/docker-can-mount
```

The tracker adapter in `src/adapters/overdew.ts` sends ordinary card API requests to Overdew. It works for every app Quaz tests. Overdew stores the work and does not run the tests. The `Tracker` interface in `src/tracker.ts` defines the required operations.

For example, a Quaz run can test RDLTR and create its finding card in Overdew. Another run can test Neologin or Surrge and use the same tracker adapter. Each tested app needs its own project config and target adapter. `examples/overdew` contains an optional target adapter for testing Overdew itself.

The project config selects source files, a container adapter, scenarios, and deployment details. Quaz copies only listed sources into the image build context. Include all files needed to build the app. The default adapter reads `settings.command`, `settings.origin`, `settings.entry`, and `settings.ready`. It runs the app inside the container and checks it with Playwright. Use `settings.setup` for app data setup. The default Dockerfile expects a Bun app with `bun.lock` and a `build` script. Set `dockerfile` in the project config for another app stack.

Use `--mode discover` for a guided review. The controller selects reported fixes for `--mode verify`. The current controller also keeps execution state in `QUAZ_DB`. Use one database per tracker board until the shared-state cutover is complete. The remaining state and recovery work is listed in `docs/extraction.md`.

## Development

```sh
bun --no-env-file run lint
bun --no-env-file run check
bun --no-env-file run test
```

Quaz creates cards with an idempotency key. The tracker must replay a matching request and reject a changed request. This lets Quaz retry publication after an interrupted API call.
