import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as Docker from "@qa/docker";
import * as Image from "@qa/image";
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
  expect(
    Docker.runtime({
      ...(state([volume("/qa")]) as Record<string, unknown>),
      HostConfig: { Binds: ["quaz-qa:/qa"] },
    }).volume,
  ).toBe("quaz-qa");
});

test("controller keeps a network with attached target containers", () => {
  expect(Docker.connected([{ Containers: null }])).toBe(0);
  expect(Docker.connected([{ Containers: { target: { Name: "app" } } }])).toBe(
    1,
  );
});

test("runner provenance identifies Quaz and its worker image", () => {
  const image: string = `sha256:${"b".repeat(64)}`;
  expect(Runner.provenance(image)).toEqual({
    source: Image.source(),
    image,
  });
});

test("worker receives only run-scoped mounts and bridge access", () => {
  const run: Protocol.Run = {
    id: "qa-run",
    project: "sample",
    mode: "discover",
    revision: "a".repeat(64),
    runner: null,
    scenario: "empty",
    note_id: null,
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
      container: "controller",
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

const FULL_ID: string = "f".repeat(64);
const ENVIRONMENT: string[] = ["KAMAL_CONTAINER_NAME", "HOSTNAME"];

describe("controller container reference", (): void => {
  const saved: Record<string, string | undefined> = {};
  let calls: string[][];
  const docker = (reply: (args: string[]) => string): void => {
    spyOn(Bun, "spawn").mockImplementation(((command: string[]): unknown => {
      const args: string[] = command.slice(1);
      calls.push(args);

      return {
        stdout: new Response(reply(args)).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn);
  };
  const inspected = (id: string): string =>
    JSON.stringify([{ ...(state([volume("/qa")]) as object), Id: id }]);
  const attached = (containers: Record<string, unknown>): string =>
    JSON.stringify([{ Containers: containers }]);
  beforeEach((): void => {
    for (const key of ENVIRONMENT) saved[key] = process.env[key];
    calls = [];
    spyOn(Bun, "file").mockReturnValue({
      exists: async (): Promise<boolean> => true,
    } as unknown as ReturnType<typeof Bun.file>);
  });
  afterEach((): void => {
    for (const key of ENVIRONMENT)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    mock.restore();
  });

  test("kamal container name finds the controller", async (): Promise<void> => {
    process.env.KAMAL_CONTAINER_NAME = "quaz-web-abc";
    process.env.HOSTNAME = "quaz-host-1234";
    docker((): string => inspected(FULL_ID));
    const found: Docker.Runtime = await Docker.inspect();
    expect(calls).toEqual([["inspect", "quaz-web-abc"]]);
    expect(found.container).toBe(FULL_ID);
  });

  test("hostname fallback", async (): Promise<void> => {
    delete process.env.KAMAL_CONTAINER_NAME;
    process.env.HOSTNAME = "abc123";
    docker((): string => inspected(FULL_ID));
    await Docker.inspect();
    expect(calls).toEqual([["inspect", "abc123"]]);
  });

  test("network and release use the container id", async (): Promise<void> => {
    const value: Pick<Docker.Runtime, "container" | "network" | "owner"> = {
      container: FULL_ID,
      network: "qa-private",
      owner: "controller",
    };
    docker((args: string[]): string =>
      args[1] === "inspect" ? attached({}) : "net",
    );
    await Docker.network(value);
    await Docker.release(value);
    expect(calls).toContainEqual([
      "network",
      "connect",
      "--alias",
      "qa-controller",
      "qa-private",
      FULL_ID,
    ]);
    expect(calls).toContainEqual([
      "network",
      "disconnect",
      "qa-private",
      FULL_ID,
    ]);
  });

  test("network skips connect when the container id is attached", async (): Promise<void> => {
    docker((args: string[]): string =>
      args[1] === "inspect" ? attached({ [FULL_ID]: { Name: "c" } }) : "net",
    );
    await Docker.network({
      container: FULL_ID,
      network: "qa-private",
      owner: "controller",
    });
    expect(calls.some((args: string[]): boolean => args[1] === "connect")).toBe(
      false,
    );
  });
});
