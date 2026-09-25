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
const state = (mounts: Mount[], anonymous: boolean = false): unknown => ({
  Id: "controller",
  Image: `sha256:${"a".repeat(64)}`,
  Config: { Labels: {} },
  HostConfig: {
    Mounts: mounts.map(
      (mount: Mount): Record<string, string> => ({
        Type: mount.Type,
        ...(anonymous ? {} : { Source: mount.Name }),
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

test("controller requires persistent state", () => {
  expect(Docker.user(0, 0)).toEqual({ uid: 1000, gid: 1000 });
  expect(Docker.user(501, 20)).toEqual({ uid: 501, gid: 20 });
  expect(Docker.runtime(state([volume("/qa")])).directory).toBe("/qa");
  expect(
    (): Docker.Runtime => Docker.runtime(state([volume("/qa", false)])),
  ).toThrow("writable named volume at /qa");
  expect(
    (): Docker.Runtime => Docker.runtime(state([volume("/qa")], true)),
  ).toThrow("writable named volume at /qa");
  expect(Docker.runtime(state([volume("/qa")])).volume).toBe("quaz-qa");
});

test("controller keeps a network with attached target containers", () => {
  expect(Docker.connected([{ Containers: null }])).toBe(0);
  expect(Docker.connected([{ Containers: { target: { Name: "app" } } }])).toBe(
    1,
  );
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
    provider: "claude",
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
    "/qa/temporary/credential",
    "quaz:project",
    { url: "http://qa-controller:3000", token: "bridge-token" },
  );
  const mounts: string[] = args.filter((value: string): boolean =>
    value.startsWith("type="),
  );
  expect(mounts).toHaveLength(3);
  expect(
    mounts.every((value: string): boolean => value.includes("src=quaz-state")),
  ).toBe(true);
  expect(
    mounts.some((value: string): boolean => value.includes("dst=/credential")),
  ).toBe(true);
  expect(
    mounts.some((value: string): boolean => value.includes("impeccable")),
  ).toBe(false);
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
