import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Inspect from "@qa/inspect";
import {
  type BrowserContext,
  chromium,
  type Page,
  type Route,
} from "playwright";

const TIMEOUT_MS: number = 30_000;
setDefaultTimeout(TIMEOUT_MS);

const EXECUTABLE: string = "/usr/bin/chromium";
const OUTSIDE_CONTROLS: number = 90;
const MOBILE_SCALE: number = 3;
const OVERFLOW_WIDTH: number = 600;
const DOCKER_OUTPUT: string = "/output";
const DOCKER_SOURCE: string =
  "/app/src/__tests__/qa-inspect.integration.test.ts";
type State = {
  width: number;
  height: number;
  scale: number;
  touch: number;
  orientation: string;
  angle: number;
  dark: boolean;
  reduced: boolean;
};
const state = async (page: Page): Promise<State> =>
  page.evaluate(
    (): State => ({
      width: Math.round(
        (visualViewport?.width ?? innerWidth) * (visualViewport?.scale ?? 1),
      ),
      height: Math.round(
        (visualViewport?.height ?? innerHeight) * (visualViewport?.scale ?? 1),
      ),
      scale: devicePixelRatio,
      touch: navigator.maxTouchPoints,
      orientation: screen.orientation.type,
      angle: screen.orientation.angle,
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    }),
  );
const HTML: string = `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="background:white;color:black">
  <main>
    ${Array.from({ length: OUTSIDE_CONTROLS }, (_, index: number): string => `<button>Outside surface ${index}</button>`).join("")}
    <button onclick="document.querySelector('#editor').showModal()">Open editor</button>
    <dialog id="editor" style="background:white;color:black">
      <h1>Selected dialog</h1>
      <label>Note title <input value="Original title"></label>
      <button>Save</button>
    </dialog>
    <section id="contrast">
      <p style="color:black;background:white">Opaque text</p>
      <p style="color:black;opacity:.1">Faded text</p>
      <div style="opacity:.5"><p>Faded ancestor</p></div>
      <div style="background-image:linear-gradient(black,black)"><p style="color:white">Gradient text</p></div>
    </section>
  </main>
</body>
</html>`;

describe.skipIf(!existsSync(EXECUTABLE))("QA browser inspection", (): void => {
  let profile: string;
  let server: Bun.Server<undefined>;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async (): Promise<void> => {
    profile = await mkdtemp(join(tmpdir(), "qa-inspect-browser-"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response =>
        new Response(HTML, { headers: { "Content-Type": "text/html" } }),
    });
    context = await chromium.launchPersistentContext(profile, {
      executablePath: EXECUTABLE,
      headless: true,
      viewport: Inspect.VIEWPORTS.mobile,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: MOBILE_SCALE,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    page = context.pages()[0];
  });

  afterAll(async (): Promise<void> => {
    await context?.close();
    server?.stop(true);
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  beforeEach(async (): Promise<void> => {
    await page.setViewportSize(Inspect.VIEWPORTS.mobile);
    await page.emulateMedia({
      colorScheme: "light",
      reducedMotion: "no-preference",
    });
    await page.goto(server.url.toString());
    await page.evaluate(async (): Promise<void> => {
      await document.fonts.ready;
    });
  });

  test("inspection restores native dialog, touch and browser state", async (): Promise<void> => {
    const draft: string = "Unsaved dialog draft";
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Open editor" }).tap();
    await page.getByLabel("Note title").fill(draft);
    const original: State = await state(page);
    expect(original.scale).toBe(MOBILE_SCALE);
    expect(original.dark).toBe(true);
    expect(original.reduced).toBe(true);
    const originalStyle: string = await page
      .getByRole("dialog")
      .evaluate((element: HTMLElement): string => element.style.cssText);
    const capture = await Inspect.capture(page, "#editor");
    expect(
      capture.measurements.map((measurement): string => measurement.condition),
    ).toEqual(Inspect.CONDITIONS);
    const result = capture.measurements[1].data;
    expect(result.surface.selector).toBe("#editor");
    expect(result.surface.text).toContain("Selected dialog");
    expect(
      result.elements.some((element): boolean =>
        element.text.includes("Outside surface"),
      ),
    ).toBe(false);
    expect(await page.getByLabel("Note title").inputValue()).toBe(draft);
    expect(await page.getByRole("dialog").isVisible()).toBe(true);
    expect(await state(page)).toEqual(original);
    expect(
      await page
        .getByRole("dialog")
        .evaluate((element: HTMLElement): string => element.style.cssText),
    ).toBe(originalStyle);
    expect(
      await page
        .locator(
          "[data-qa-size],[data-qa-original-size],[data-qa-original-priority]",
        )
        .count(),
    ).toBe(0);
    await page.getByRole("button", { name: "Save", exact: true }).tap();
    expect(await page.getByLabel("Note title").inputValue()).toBe(draft);
  });

  test("mobile overflow keeps the configured viewport", async (): Promise<void> => {
    await page
      .locator("main")
      .evaluate((element: HTMLElement, width: number): void => {
        element.style.width = `${width}px`;
      }, OVERFLOW_WIDTH);
    const result = await Inspect.measure(page, "#contrast");
    expect(result.viewport).toEqual(Inspect.VIEWPORTS.mobile);
    expect(result.document.width).toBeGreaterThan(
      Inspect.VIEWPORTS.mobile.width,
    );
  });

  test("text scaling settles transitions and preserves important styles", async (): Promise<void> => {
    await page.getByRole("button", { name: "Open editor" }).tap();
    const field = page.getByLabel("Note title");
    const original: string = await field.evaluate(
      (element: HTMLElement): string => {
        element.style.setProperty("font-size", "16px", "important");
        element.style.setProperty(
          "transition",
          "font-size 10s linear",
          "important",
        );
        return element.style.cssText;
      },
    );
    const capture = await Inspect.capture(page, "#editor");
    const enlarged = capture.measurements.find(
      (entry): boolean => entry.condition === "text-200-percent",
    );
    expect(enlarged).toBeDefined();
    for (const element of enlarged?.data.elements ?? [])
      expect(Number.parseFloat(element.size)).toBeCloseTo(
        (element.originalSize ?? 0) * 2,
        1,
      );
    const before = capture.measurements.find(
      (entry): boolean => entry.condition === "mobile",
    );
    expect(
      before?.data.elements.find((element): boolean => element.tag === "INPUT")
        ?.transition,
    ).toContain("10s");
    expect(
      await field.evaluate(
        (element: HTMLElement): string => element.style.cssText,
      ),
    ).toBe(original);
    expect(
      await field.evaluate(
        (element: HTMLElement): string => getComputedStyle(element).fontSize,
      ),
    ).toBe("16px");
    expect(
      await field.evaluate(
        (element: HTMLElement): number => element.getAnimations().length,
      ),
    ).toBe(0);
    expect(
      await page
        .locator("[data-qa-transition],[data-qa-transition-priority]")
        .count(),
    ).toBe(0);
  });

  test.skipIf(process.env.QA_INSPECT_DOCKER_TEST !== "1")(
    "validator inspection preserves reviewer evidence",
    async (): Promise<void> => {
      const metadata: string = join(DOCKER_OUTPUT, "metadata.json");
      const reviewer: string = join(DOCKER_OUTPUT, "reviewer");
      const validator: string = join(DOCKER_OUTPUT, "validator");
      if ([metadata, reviewer, validator].some(existsSync))
        throw new Error("The inspection regression requires empty QA output");
      try {
        await mkdir(reviewer, { recursive: true });
        await mkdir(validator, { recursive: true });
        await writeFile(
          metadata,
          JSON.stringify({
            runId: "phase-inspection-test",
            commit: "a".repeat(40),
            origin: server.url.origin,
            sourceAvailable: true,
          }),
        );
        await page.getByRole("button", { name: "Open editor" }).tap();
        const first = await Inspect.inspect(
          page,
          "dialog-inspection",
          "#editor",
          [DOCKER_SOURCE],
          "reviewer",
        );
        const original: string = await readFile(
          join(reviewer, "technical.json"),
          "utf8",
        );
        await page
          .getByRole("heading", { name: "Selected dialog" })
          .evaluate((element: HTMLElement): void => {
            element.textContent = "Validator dialog";
          });
        const second = await Inspect.inspect(
          page,
          "dialog-inspection",
          "#editor",
          [DOCKER_SOURCE],
          "validator",
        );
        const independent = Inspect.bindingSchema.parse(
          JSON.parse(await readFile(join(validator, "technical.json"), "utf8")),
        );
        expect(first.evidence).toBe("reviewer/technical.json");
        expect(second.evidence).toBe("validator/technical.json");
        expect(await readFile(join(reviewer, "technical.json"), "utf8")).toBe(
          original,
        );
        expect(independent.measurements[0].data.surface.text).toContain(
          "Validator dialog",
        );
      } finally {
        await rm(metadata, { force: true });
        await rm(reviewer, { recursive: true, force: true });
        await rm(validator, { recursive: true, force: true });
      }
    },
  );

  test("contrast excludes opacity and gradients", async (): Promise<void> => {
    const result = await Inspect.measure(page, "#contrast");
    const contrast = (text: string): number | null | undefined =>
      result.elements.find((element): boolean => element.text === text)
        ?.contrast;
    expect(contrast("Opaque text")).toBeGreaterThan(20);
    expect(contrast("Faded text")).toBeNull();
    expect(contrast("Faded ancestor")).toBeNull();
    expect(contrast("Gradient text")).toBeNull();
  });

  test("landscape has a short height and active orientation", async (): Promise<void> => {
    await page.setViewportSize(Inspect.VIEWPORTS.landscape);
    const result = await Inspect.measure(page, "#contrast");
    expect(result.viewport).toEqual({ width: 844, height: 390 });
    expect(result.media.landscape).toBe(true);
  });

  test("pending font remains a measured loading state", async (): Promise<void> => {
    const url: string = new URL("held.woff2", server.url).href;
    const request = Promise.withResolvers<Route>();
    await page.route(url, (route: Route): void => request.resolve(route));
    await page.addStyleTag({
      content: `@font-face { font-family: "QA Held"; src: url("${url}"); font-display: swap; }
        #contrast { font-family: "QA Held", sans-serif; }`,
    });
    const held: Route = await request.promise;
    try {
      expect(await page.evaluate((): string => document.fonts.status)).toBe(
        "loading",
      );
      const result = await Inspect.measure(page, "#contrast");
      expect(result.fonts).toBe("loading");
      expect(result.elements.length).toBeGreaterThan(0);
      expect(result.surface.selector).toBe("#contrast");
    } finally {
      await held.abort();
      await page.unroute(url);
      await page.evaluate(async (): Promise<void> => {
        await document.fonts.ready;
      });
    }
  });
});
