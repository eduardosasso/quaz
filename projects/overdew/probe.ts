import * as Adapter from "@overdew/adapter";
import { chromium } from "playwright";
import { z } from "zod";

const scenario: "empty" | "typical" | "busy" = z
  .enum(["empty", "typical", "busy"])
  .parse(process.env.QUAZ_SCENARIO);
const prepared = await Adapter.prepare({
  directory: `/tmp/quaz-${scenario}`,
  runId: "isolated-target-proof",
  testerId: "tester-1",
  scenario,
  revision: "a".repeat(40),
  settings: {},
});
const app = Bun.spawn(prepared.command, {
  cwd: "/app",
  env: { ...process.env, ...prepared.env },
  stdout: "pipe",
  stderr: "pipe",
});
try {
  let ready: boolean = false;
  for (let attempt: number = 0; attempt < 100; attempt++) {
    try {
      const response: Response = await fetch(
        `${prepared.origin}${prepared.ready}`,
      );
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      if (app.exitCode !== null) break;
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Disposable app did not become ready");
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const result = await Adapter.smoke(
    prepared,
    browser,
    `/tmp/quaz-${scenario}/output`,
  );
  const counts: Record<typeof scenario, { boards: number; cards: number }> = {
    empty: { boards: 0, cards: 0 },
    typical: { boards: 2, cards: 8 },
    busy: { boards: 6, cards: 120 },
  };
  if (
    !result.authenticated ||
    !result.persisted ||
    JSON.stringify(result.initialCounts) !== JSON.stringify(counts[scenario])
  )
    throw new Error(`Disposable ${scenario} smoke failed`);

  process.stdout.write(
    `${JSON.stringify({ scenario, counts: result.initialCounts, evidence: result.evidence })}\n`,
  );
} finally {
  app.kill();
  await app.exited;
}
