const SAFE_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
]);

export const describe = (
  error: unknown,
  privateData: boolean = false,
): string =>
  privateData
    ? error instanceof Error && SAFE_NAMES.has(error.name)
      ? error.name
      : "Error"
    : String(error);
