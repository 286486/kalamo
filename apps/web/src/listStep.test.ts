import { expect, it } from "vitest";
import { listStep } from "./listStep.ts";

const VERTICAL = { ArrowDown: 1, ArrowUp: -1 } as const;

it("steps to the next and previous item, wrapping at both ends", () => {
  expect(listStep("ArrowDown", 1, 4, VERTICAL)).toBe(2);
  expect(listStep("ArrowUp", 1, 4, VERTICAL)).toBe(0);
  expect(listStep("ArrowDown", 3, 4, VERTICAL)).toBe(0);
  expect(listStep("ArrowUp", 0, 4, VERTICAL)).toBe(3);
});

it("goes to the first item on Home and the last on End", () => {
  expect(listStep("Home", 2, 4, VERTICAL)).toBe(0);
  expect(listStep("End", 1, 4, VERTICAL)).toBe(3);
});

it("goes to the first item on next and the last on previous when none has focus", () => {
  expect(listStep("ArrowDown", -1, 4, VERTICAL)).toBe(0);
  expect(listStep("ArrowUp", -1, 4, VERTICAL)).toBe(3);
});

it("leaves keys the caller does not map to a step", () => {
  expect(listStep("ArrowLeft", 1, 4, VERTICAL)).toBeNull();
  expect(listStep("a", 1, 4, VERTICAL)).toBeNull();
  expect(listStep("ArrowLeft", 1, 4, { ...VERTICAL, ArrowLeft: -1 })).toBe(0);
});
