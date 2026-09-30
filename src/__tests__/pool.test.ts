import { expect, test } from "bun:test";
import * as Pool from "@/pool";

const LIMIT: number = 3;
const ITEMS: number[] = Array.from({ length: 10 }, (_, index): number => index);

test("preserves order", async () => {
  const results: number[] = await Pool.map(
    ITEMS,
    LIMIT,
    async (item: number): Promise<number> => {
      await Bun.sleep((ITEMS.length - item) % LIMIT);

      return item * 2;
    },
  );
  expect(results).toEqual(ITEMS.map((item): number => item * 2));
});

test("never exceeds the limit", async () => {
  let flying: number = 0;
  let peak: number = 0;
  await Pool.map(ITEMS, LIMIT, async (): Promise<void> => {
    peak = Math.max(peak, ++flying);
    await Bun.sleep(1);
    flying--;
  });
  expect(peak).toBe(LIMIT);
});

test("rejects with the first error", async () => {
  const started: number[] = [];
  let flying: number = 0;
  const outcome: Promise<number[]> = Pool.map(
    ITEMS,
    LIMIT,
    async (item: number): Promise<number> => {
      started.push(item);
      flying++;
      await Bun.sleep(item === 1 ? 1 : 5);
      flying--;
      if (item >= 1 && item <= 2) throw new Error(`failed ${item}`);

      return item;
    },
  );
  await expect(outcome).rejects.toThrow("failed 1");
  expect(flying).toBe(0);
  expect(started.length).toBeLessThan(ITEMS.length);
});

test("returns an empty list for no items", async () => {
  expect(
    await Pool.map([], LIMIT, async (item: never): Promise<never> => item),
  ).toEqual([]);
});

test("rejects a limit below one", async () => {
  await expect(
    Pool.map(ITEMS, 0, async (item: number): Promise<number> => item),
  ).rejects.toThrow("positive integer");
});
