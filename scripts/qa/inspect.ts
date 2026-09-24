import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import CONFIG from "@qa/config.json";
import type { Page } from "playwright";
import { z } from "zod";

const ROOT: string = "/app";
const OUTPUT: string = "/output";
const LIMIT: number = 500;
const TIMEOUT: number = 15_000;
const DETECTOR_BYTES: number = 8 * 1024 * 1024;
const FONT_WAIT_MS: number = 2000;
const TEXT_SCALE: number = 2;
export const VIEWPORTS = {
  narrow: { width: 320, height: 844 },
  mobile: { width: 390, height: 844 },
  landscape: { width: 844, height: 390 },
  desktop: { width: 1440, height: 900 },
} as const;
export const CONDITIONS: string[] = [
  ...Object.keys(VIEWPORTS),
  "light",
  "dark",
  "reduced-motion",
  "text-200-percent",
];
const dimensionsSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});
const measurementSchema = z
  .object({
    url: z.string().url(),
    viewport: dimensionsSchema,
    document: dimensionsSchema,
    surface: z.object({
      selector: z.string().min(1),
      text: z.string(),
      count: z.number().int().positive(),
      truncated: z.literal(false),
    }),
    media: z.object({
      dark: z.boolean(),
      reduced: z.boolean(),
      landscape: z.boolean(),
    }),
    fonts: z.enum(["loaded", "loading"]),
    background: z.string(),
    performance: z.object({
      navigation: z
        .array(
          z
            .object({
              duration: z.number().nonnegative(),
              domContentLoadedEventEnd: z.number().nonnegative(),
            })
            .passthrough(),
        )
        .min(1),
      paint: z.array(z.record(z.string(), z.unknown())),
      resources: z.array(
        z.object({
          name: z.string(),
          duration: z.number().nonnegative(),
          bytes: z.number().nonnegative(),
          decoded: z.number().nonnegative(),
        }),
      ),
    }),
    elements: z
      .array(
        z
          .object({
            tag: z.string().min(1),
            text: z.string(),
            rect: dimensionsSchema.extend({ x: z.number(), y: z.number() }),
            contrast: z.number().min(1).max(21.1).nullable(),
            clipped: z.boolean(),
            size: z.string(),
            originalSize: z.number().nonnegative().nullable(),
            font: z.string(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
const metadataSchema = z.object({
  runId: z.string(),
  commit: z.string(),
  origin: z.string(),
  sourceAvailable: z.boolean(),
});
export const bindingSchema = z
  .object({
    runId: z.string().min(1),
    revision: z.string().min(7),
    flow: z.string().min(1),
    url: z.string().url(),
    selector: z.string().min(1),
    detector: z.object({
      status: z.enum(["complete", "unavailable"]),
      files: z.array(
        z.object({
          path: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      ),
      findings: z.array(z.unknown()),
    }),
    measurements: z
      .array(z.object({ condition: z.string(), data: measurementSchema }))
      .length(CONDITIONS.length),
  })
  .superRefine((value, context): void => {
    if (
      (value.detector.status === "complete" &&
        value.detector.files.length === 0) ||
      (value.detector.status === "unavailable" &&
        (value.detector.files.length > 0 || value.detector.findings.length > 0))
    )
      context.addIssue({
        code: "custom",
        message: "Detector status does not match source evidence",
      });
    for (const condition of CONDITIONS) {
      const entries = value.measurements.filter(
        (entry): boolean => entry.condition === condition,
      );
      if (entries.length !== 1)
        context.addIssue({
          code: "custom",
          message: `Missing or repeated measurement: ${condition}`,
        });
    }
    for (const entry of value.measurements) {
      const expected =
        VIEWPORTS[entry.condition as keyof typeof VIEWPORTS] ??
        VIEWPORTS.mobile;
      if (
        entry.data.viewport.width !== expected.width ||
        entry.data.viewport.height !== expected.height ||
        entry.data.url !== value.url ||
        entry.data.surface.selector !== value.selector
      )
        context.addIssue({
          code: "custom",
          message: `Measurement does not match its surface or viewport: ${entry.condition}`,
        });
      if (
        entry.condition === "text-200-percent" &&
        entry.data.elements.some(
          (element): boolean =>
            element.originalSize === null ||
            Math.abs(
              Number.parseFloat(element.size) -
                element.originalSize * TEXT_SCALE,
            ) > 0.1,
        )
      )
        context.addIssue({
          code: "custom",
          message: "Text did not scale to 200 percent",
        });
      if (entry.condition === "landscape" && !entry.data.media.landscape)
        context.addIssue({
          code: "custom",
          message: "Landscape media is not active",
        });
      if (entry.condition === "dark" && !entry.data.media.dark)
        context.addIssue({
          code: "custom",
          message: "Dark media is not active",
        });
      if (entry.condition === "light" && entry.data.media.dark)
        context.addIssue({
          code: "custom",
          message: "Light media is not active",
        });
      if (entry.condition === "reduced-motion" && !entry.data.media.reduced)
        context.addIssue({
          code: "custom",
          message: "Reduced motion is not active",
        });
    }
  });
export const source = async (
  root: string,
  paths: string[],
): Promise<string[]> => {
  if (!paths.length || paths.length > 8)
    throw new Error("Choose one to eight source files for the selected flow");
  return await Promise.all(
    paths.map(async (path: string): Promise<string> => {
      const full: string = await realpath(resolve(root, path));
      const local: string = relative(await realpath(root), full);
      if (
        isAbsolute(local) ||
        local.startsWith("..") ||
        !/\.(tsx?|jsx?|css|html|vue|svelte|astro)$/.test(local)
      )
        throw new Error("Inspection requires project source files");
      return full;
    }),
  );
};
export const measure = async (
  page: Page,
  selector: string,
): Promise<z.infer<typeof measurementSchema>> => {
  await page.evaluate(async (fontWait: number): Promise<void> => {
    await new Promise<void>((resolve): void => {
      requestAnimationFrame((): void => resolve());
    });
    await Promise.race([
      document.fonts.ready,
      new Promise<void>((resolve): void => {
        setTimeout(resolve, fontWait);
      }),
    ]);
  }, FONT_WAIT_MS);
  return measurementSchema.parse(
    await page.evaluate(
      ({
        limit,
        selector,
        scale,
      }: {
        limit: number;
        selector: string;
        scale: number;
      }) => {
        const roots: HTMLElement[] = Array.from(
          document.querySelectorAll<HTMLElement>(selector),
        ).filter(
          (element): boolean =>
            !!element.getBoundingClientRect().width &&
            !!element.getBoundingClientRect().height,
        );
        if (roots.length !== 1)
          throw new Error("Inspection needs exactly one visible surface");
        const root: HTMLElement = roots[0];
        const text = (element: HTMLElement): string =>
          (element.getAttribute("aria-label") ?? element.innerText ?? "")
            .trim()
            .slice(0, 100);
        const visible: HTMLElement[] = [
          root,
          ...Array.from(
            root.querySelectorAll<HTMLElement>(
              "button,a,input,textarea,select,h1,h2,h3,p,label,[role],[contenteditable],main,header,nav",
            ),
          ),
        ].filter((element): boolean => {
          const rect: DOMRect = element.getBoundingClientRect();
          return (
            !!(rect.width && rect.height) &&
            getComputedStyle(element).visibility !== "hidden"
          );
        });
        if (visible.length > limit)
          throw new Error(
            "Selected surface exceeds inspection limit; choose a smaller visible root",
          );
        const nodes: HTMLElement[] = visible;
        const canvas: HTMLCanvasElement = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const painter: CanvasRenderingContext2D | null = canvas.getContext(
          "2d",
          {
            willReadFrequently: true,
          },
        );
        if (!painter)
          throw new Error("Color measurement requires a canvas context");
        const colors = (value: string): number[] => {
          painter.clearRect(0, 0, 1, 1);
          painter.fillStyle = value;
          painter.fillRect(0, 0, 1, 1);
          const rgba: number[] = Array.from(
            painter.getImageData(0, 0, 1, 1).data,
          );
          return [rgba[0], rgba[1], rgba[2], rgba[3] / 255];
        };
        const luminance = (rgb: number[]): number =>
          rgb
            .slice(0, 3)
            .reduce((total: number, part: number, index: number): number => {
              const channel: number = part / 255;
              return (
                total +
                (channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4) *
                  [0.2126, 0.7152, 0.0722][index]
              );
            }, 0);
        return {
          url: location.href,
          viewport: {
            width: Math.round(
              (visualViewport?.width ?? innerWidth) *
                (visualViewport?.scale ?? 1),
            ),
            height: Math.round(
              (visualViewport?.height ?? innerHeight) *
                (visualViewport?.scale ?? 1),
            ),
          },
          layoutViewport: {
            width: innerWidth,
            height: innerHeight,
            scale: visualViewport?.scale ?? 1,
          },
          surface: {
            selector,
            text: text(root),
            count: nodes.length,
            truncated: false,
          },
          media: {
            dark: matchMedia("(prefers-color-scheme: dark)").matches,
            reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
            landscape: matchMedia("(orientation: landscape)").matches,
          },
          document: {
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          },
          fonts: document.fonts.status,
          theme: document.documentElement.className,
          background: getComputedStyle(document.body).backgroundColor,
          performance: {
            navigation: performance
              .getEntriesByType("navigation")
              .map((entry): unknown => entry.toJSON()),
            paint: performance
              .getEntriesByType("paint")
              .map((entry): unknown => entry.toJSON()),
            resources: performance
              .getEntriesByType("resource")
              .map((entry): unknown => {
                const item = entry as PerformanceResourceTiming;
                return {
                  name: item.name,
                  duration: item.duration,
                  bytes: item.transferSize,
                  decoded: item.decodedBodySize,
                };
              }),
          },
          elements: nodes.map((element): Record<string, unknown> => {
            const style: CSSStyleDeclaration = getComputedStyle(element);
            const rect: DOMRect = element.getBoundingClientRect();
            let ancestor: HTMLElement | null = element;
            let unsupported: boolean = false;
            while (ancestor) {
              const computed: CSSStyleDeclaration = getComputedStyle(ancestor);
              if (
                Number(computed.opacity) !== 1 ||
                computed.backgroundImage !== "none" ||
                computed.filter !== "none" ||
                computed.mixBlendMode !== "normal" ||
                computed.backdropFilter !== "none"
              )
                unsupported = true;
              ancestor = ancestor.parentElement;
            }
            let background: HTMLElement | null = element;
            while (
              background &&
              (colors(getComputedStyle(background).backgroundColor)[3] ?? 1) ===
                0
            )
              background = background.parentElement;
            const bg: CSSStyleDeclaration | null = background
              ? getComputedStyle(background)
              : null;
            const foreground: number[] = colors(style.color);
            const ground: number[] = colors(
              bg?.backgroundColor ?? "rgb(255,255,255)",
            );
            const opaque: boolean =
              !unsupported &&
              foreground.length >= 3 &&
              (foreground[3] ?? 1) === 1 &&
              (ground[3] ?? 1) === 1 &&
              (!bg || bg.backgroundImage === "none");
            const a: number = luminance(foreground);
            const b: number = luminance(ground);
            return {
              tag: element.tagName,
              role: element.getAttribute("role"),
              text: text(element),
              rect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
              font: style.fontFamily,
              size: style.fontSize,
              originalSize: element.dataset.qaSize
                ? Number.parseFloat(element.dataset.qaSize) / scale
                : null,
              weight: style.fontWeight,
              lineHeight: style.lineHeight,
              color: style.color,
              background: bg?.backgroundColor,
              contrast: opaque
                ? (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
                : null,
              contrastScope:
                "Computed opaque colors only; gradients, opacity and occlusion require visual confirmation",
              clipped: element.scrollWidth > element.clientWidth,
              position: style.position,
              overflow: style.overflow,
              transition: style.transition,
              animation: style.animation,
              willChange: style.willChange,
              outline: style.outline,
              shadow: style.boxShadow,
            };
          }),
        };
      },
      { limit: LIMIT, selector, scale: TEXT_SCALE },
    ),
  );
};

export const capture = async (
  page: Page,
  selector: string,
): Promise<{
  measurements: Array<{
    condition: string;
    data: z.infer<typeof measurementSchema>;
  }>;
  errors: string[];
}> => {
  const measurements: Array<{
    condition: string;
    data: z.infer<typeof measurementSchema>;
  }> = [];
  const viewport = page.viewportSize();
  if (!viewport)
    throw new Error("Inspection requires the native QA browser session");
  const original = await page.evaluate(() => ({
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  const errors: string[] = [];
  const failure = (error: Error): void => {
    errors.push(error.message);
  };
  page.on("pageerror", failure);
  try {
    for (const [condition, size] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(size);
      measurements.push({ condition, data: await measure(page, selector) });
    }
    await page.setViewportSize(VIEWPORTS.mobile);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      measurements.push({
        condition: colorScheme,
        data: await measure(page, selector),
      });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    measurements.push({
      condition: "reduced-motion",
      data: await measure(page, selector),
    });
    // Measure the enlarged layout instead of an intermediate transition frame.
    await page.evaluate((scale: number): void => {
      for (const element of document.querySelectorAll<HTMLElement>("*")) {
        element.dataset.qaTransition = element.style.getPropertyValue(
          "transition-property",
        );
        element.dataset.qaTransitionPriority =
          element.style.getPropertyPriority("transition-property");
        element.style.setProperty("transition-property", "none", "important");
      }
      for (const element of document.querySelectorAll<HTMLElement>("*")) {
        const size: number = parseFloat(getComputedStyle(element).fontSize);
        element.dataset.qaOriginalSize =
          element.style.getPropertyValue("font-size");
        element.dataset.qaOriginalPriority =
          element.style.getPropertyPriority("font-size");
        element.dataset.qaSize = `${size * scale}px`;
      }
      for (const element of document.querySelectorAll<HTMLElement>(
        "[data-qa-size]",
      ))
        element.style.setProperty(
          "font-size",
          element.dataset.qaSize ?? "",
          "important",
        );
    }, TEXT_SCALE);
    measurements.push({
      condition: "text-200-percent",
      data: await measure(page, selector),
    });
    return { measurements, errors };
  } finally {
    await page.evaluate((): void => {
      for (const element of document.querySelectorAll<HTMLElement>(
        "[data-qa-size]",
      )) {
        element.style.setProperty(
          "font-size",
          element.dataset.qaOriginalSize ?? "",
          element.dataset.qaOriginalPriority ?? "",
        );
        delete element.dataset.qaSize;
        delete element.dataset.qaOriginalSize;
        delete element.dataset.qaOriginalPriority;
      }
      // Restore sizes before transitions so cleanup does not animate the page.
      document.documentElement.getBoundingClientRect();
      for (const element of document.querySelectorAll<HTMLElement>(
        "[data-qa-transition]",
      )) {
        element.style.setProperty(
          "transition-property",
          element.dataset.qaTransition ?? "",
          element.dataset.qaTransitionPriority ?? "",
        );
        delete element.dataset.qaTransition;
        delete element.dataset.qaTransitionPriority;
      }
    });
    await page.setViewportSize(viewport);
    await page.emulateMedia({
      colorScheme: original.dark ? "dark" : "light",
      reducedMotion: original.reduced ? "reduce" : "no-preference",
    });
    page.off("pageerror", failure);
  }
};

export const inspect = async (
  page: Page,
  flow: string,
  selector: string,
  paths: string[],
  phase: "reviewer" | "validator" = "reviewer",
): Promise<Record<string, unknown>> => {
  const url: string = page.url();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flow ?? ""))
    throw new Error(
      "Supply the claimed flow key, current URL, surface selector and source files",
    );
  const metadata = metadataSchema.parse(
    JSON.parse(await readFile(join(OUTPUT, "metadata.json"), "utf8")),
  );
  if (new URL(url).origin !== metadata.origin)
    throw new Error("Inspection must stay in the disposable app");
  if (!metadata.sourceAvailable && paths.length)
    throw new Error("Remote target has no local source files");
  const files: string[] = metadata.sourceAvailable
    ? await source(ROOT, paths)
    : [];
  const findings: unknown[] = metadata.sourceAvailable
    ? z.array(z.unknown()).parse(
        JSON.parse(
          await new Promise((resolve, reject): void => {
            execFile(
              join(CONFIG.controller.skill, "scripts/impeccable"),
              ["detect", "--json", ...files],
              { cwd: ROOT, timeout: TIMEOUT, maxBuffer: DETECTOR_BYTES },
              (error, stdout, stderr): void => {
                if (error && error.code !== 2) {
                  reject(
                    new Error(
                      `Impeccable detector fails: ${stderr || error.message}`,
                    ),
                  );
                  return;
                }
                resolve(stdout);
              },
            );
          }),
        ),
      )
    : [];
  const { measurements, errors } = await capture(page, selector);
  const result = bindingSchema.parse({
    runId: metadata.runId,
    revision: metadata.commit,
    flow,
    url,
    selector,
    detector: {
      status: metadata.sourceAvailable ? "complete" : "unavailable",
      files: await Promise.all(
        files.map(async (path: string) => ({
          path: relative(ROOT, path),
          sha256: createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        })),
      ),
      findings,
    },
    measurements,
  });
  const encoded: string = JSON.stringify({ ...result, errors });
  await writeFile(join(OUTPUT, phase, "technical.json"), encoded);
  return {
    evidence: `${phase}/technical.json`,
    sha256: createHash("sha256").update(encoded).digest("hex"),
    flow,
    url,
    selector,
    detector: {
      status: result.detector.status,
      files: result.detector.files,
      count: findings.length,
      findings: findings.slice(0, 12),
    },
    measurements: measurements.map((item) => ({
      condition: item.condition,
      data: {
        viewport: item.data.viewport,
        document: item.data.document,
        fonts: item.data.fonts,
        background: item.data.background,
        elements: (item.data.elements as Array<Record<string, unknown>>)
          .filter(
            (element): boolean =>
              Number((element.rect as Record<string, unknown>).width) < 44 ||
              (element.contrast !== null && Number(element.contrast) < 4.5) ||
              !!element.clipped,
          )
          .slice(0, 4)
          .map((element) => ({
            text: element.text,
            rect: element.rect,
            contrast: element.contrast,
            clipped: element.clipped,
          })),
      },
    })),
    errors,
    note: `Read ${phase}/technical.json for full runtime measurements and available detector evidence.`,
  };
};
