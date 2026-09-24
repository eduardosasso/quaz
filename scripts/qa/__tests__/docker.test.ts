import { expect, test } from "bun:test";
import * as Docker from "@qa/docker";

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
