import { expect, test } from "bun:test";
import * as Release from "@release";

test("stable release bumps", (): void => {
  expect(Release.next("1.2.3", "major")).toBe("2.0.0");
  expect(Release.next("1.2.3", "minor")).toBe("1.3.0");
  expect(Release.next("1.2.3", "patch")).toBe("1.2.4");
  expect((): string => Release.next("1.2.3-beta", "patch")).toThrow();
});

test("release decision requires a complete model answer", (): void => {
  expect(
    Release.parseDecision(
      JSON.stringify({
        structured_output: {
          bump: "minor",
          reason: "Add a compatible project adapter.",
        },
      }),
    ),
  ).toEqual({ bump: "minor", reason: "Add a compatible project adapter." });
  for (const output of [
    "{}",
    JSON.stringify({
      is_error: true,
      structured_output: { bump: "patch", reason: "Fix." },
    }),
    JSON.stringify({ structured_output: { bump: "patch" } }),
    JSON.stringify({ structured_output: { bump: "urgent", reason: "Fix." } }),
  ])
    expect(
      (): ReturnType<typeof Release.parseDecision> =>
        Release.parseDecision(output),
    ).toThrow();
});
