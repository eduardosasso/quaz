export const map = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Pool limit must be a positive integer");
  const results: R[] = new Array(items.length);
  const failures: unknown[] = [];
  let next: number = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length && !failures.length) {
      const index: number = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  if (failures.length) throw failures[0];

  return results;
};
