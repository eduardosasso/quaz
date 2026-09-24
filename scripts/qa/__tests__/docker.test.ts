import { expect, test } from "bun:test";
import * as Docker from "@qa/docker";
import * as Runner from "@qa/run";
import type * as Protocol from "@/qa_protocol";

type Mount = {
  Type: string;
  Name: string;
  Destination: string;
  RW: boolean;
};
const state = (mounts: Mount[], anonymousAuth: boolean = false): unknown => ({
  Id: "controller",
  Image: `sha256:${"a".repeat(64)}`,
  Config: { Labels: {} },
  HostConfig: {
    Mounts: mounts.map(
      (mount: Mount): Record<string, string> => ({
        Type: mount.Type,
        ...(anonymousAuth && mount.Destination === "/auth"
          ? {}
          : { Source: mount.Name }),
        Target: mount.Destination,
      }),
    ),
    Binds: null,
  },
  Mounts: mounts,
});
const volume = (destination: string, writable: boolean = true): Mount => ({
  Type: "volume",
  Name: `quaz-${destination.slice(1)}`,
  Destination: destination,
  RW: writable,
});

test("real reviews require a persistent Codex login volume", () => {
  const runtime: unknown = state([volume("/qa")]);
  expect((): Docker.Runtime => Docker.runtime(runtime, true)).toThrow(
    "writable named volume at /auth",
  );
  expect(Docker.runtime(runtime).directory).toBe("/qa");
  expect(
    (): Docker.Runtime =>
      Docker.runtime(state([volume("/qa"), volume("/auth", false)]), true),
  ).toThrow("writable named volume at /auth");
  expect(
    (): Docker.Runtime =>
      Docker.runtime(
        state([volume("/qa"), { ...volume("/auth"), Name: "quaz-qa" }]),
        true,
      ),
  ).toThrow("separate volumes");
  expect(
    (): Docker.Runtime =>
      Docker.runtime(state([volume("/qa"), volume("/auth")], true), true),
  ).toThrow("writable named volume at /auth");
  expect(
    Docker.runtime(state([volume("/qa"), volume("/auth")]), true).volume,
  ).toBe("quaz-qa");
});

test("worker receives only run-scoped mounts and bridge access", () => {
  const run: Protocol.Run = {
    id: "qa-run",
    project: "sample",
    mode: "discover",
    revision: "a".repeat(64),
    scenario: "empty",
    note_id: 1,
    board_id: 1,
    owner: "quaz",
    status: "claimed",
    expires: 1,
    target: null,
    snapshot: null,
    receipt: null,
  };
  const input: Runner.Options = {
    mode: "discover",
    testers: 1,
    scenarios: ["empty"],
    seconds: 90,
    project: "/config/project.json",
    url: "https://tracker.example",
    board: "owner/board",
    skill: "/opt/impeccable",
    auth: "/auth/auth.json",
    provider: "codex",
    runtime: {
      image: `sha256:${"a".repeat(64)}`,
      revision: "a".repeat(64),
      volume: "quaz-state",
      directory: "/qa",
      network: "qa-private",
      owner: "controller",
    },
  };
  const args: string[] = Runner.container(
    input,
    run,
    "/qa/temporary/qa-run",
    "/qa/temporary/guide",
    "/qa/temporary/credential",
    "quaz:project",
    { url: "http://qa-controller:3000", token: "bridge-token" },
  );
  const mounts: string[] = args.filter((value: string): boolean =>
    value.startsWith("type="),
  );
  expect(mounts).toHaveLength(4);
  expect(
    mounts.every((value: string): boolean => value.includes("src=quaz-state")),
  ).toBe(true);
  expect(
    mounts.some((value: string): boolean => value.includes("dst=/credential")),
  ).toBe(true);
  expect(
    mounts.some((value: string): boolean =>
      value.includes("dst=/opt/impeccable,readonly"),
    ),
  ).toBe(true);
  expect(args).toContain("QA_BRIDGE_TOKEN=bridge-token");
  expect(
    args.some((value: string): boolean =>
      /OP_SERVICE_ACCOUNT_TOKEN|QUAZ_TRACKER_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|docker.sock/.test(
        value,
      ),
    ),
  ).toBe(false);
  const smoke: string[] = Runner.container(
    { ...input, mode: "smoke" },
    { ...run, mode: "smoke" },
    "/qa/temporary/qa-run",
    "/qa/temporary/guide",
    "/qa/temporary/credential",
    "quaz:project",
    { url: "http://qa-controller:3000", token: "bridge-token" },
  );
  expect(
    smoke.some((value: string): boolean => value.includes("dst=/credential")),
  ).toBe(false);
  expect(
    smoke.some((value: string): boolean =>
      value.includes("dst=/opt/impeccable"),
    ),
  ).toBe(false);
});
