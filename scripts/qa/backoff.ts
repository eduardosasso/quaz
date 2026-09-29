import CONFIG from "@qa/config.json";

export const MILLISECONDS: number = 1000;
export type Pacing = {
  now: () => number;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  log: (event: Record<string, unknown>) => void;
};

export const delay = (attempt: number, seconds: number): number =>
  Math.min(
    seconds * 2 ** Math.max(attempt - 1, 0),
    CONFIG.controller.maxBackoffSeconds,
  ) * MILLISECONDS;

export const wait = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((finish): void => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      finish();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
};
