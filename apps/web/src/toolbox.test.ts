import { expect, it } from "vitest";
import { nextTap } from "./toolbox.ts";

it("counts a press close in time and space as the next click, and far ones as a first", () => {
  const first = nextTap(null, 100, 100, 1000);
  expect(first.count).toBe(1);
  const second = nextTap(first, 110, 108, 1400);
  expect(second.count).toBe(2);
  expect(nextTap(second, 110, 108, 1800).count).toBe(3);
  expect(nextTap(first, 100, 100, 1600).count).toBe(1);
  expect(nextTap(first, 120, 100, 1100).count).toBe(1);
  // The limits themselves still count.
  expect(nextTap(first, 116, 100, 1500).count).toBe(2);
  expect(nextTap(first, 116.1, 100, 1100).count).toBe(1);
  expect(nextTap(first, 100, 100, 1500.1).count).toBe(1);
});
