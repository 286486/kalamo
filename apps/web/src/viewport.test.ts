import { expect, it } from "vitest";
import { fit, toDoc, zoomAt, zoomStep } from "./viewport.ts";

it("keeps the document point under the cursor while zooming", () => {
  const v = { x: 30, y: -20, scale: 1.5 };
  const before = toDoc(v, 200, 120);
  const after = zoomAt(v, 3, 200, 120);
  expect(after.scale).toBe(4.5);
  const p = toDoc(after, 200, 120);
  expect(p.x).toBeCloseTo(before.x);
  expect(p.y).toBeCloseTo(before.y);
});

it("clamps zoom to Illustrator's range", () => {
  expect(zoomAt({ x: 0, y: 0, scale: 1 }, 1e6, 0, 0).scale).toBe(64);
  expect(zoomAt({ x: 0, y: 0, scale: 1 }, 1e-6, 0, 0).scale).toBeCloseTo(0.0313);
});

it("fits a rect inside the screen with a margin, centred", () => {
  const v = fit({ x: 100, y: 50, width: 200, height: 100 }, 1000, 400, 20);
  expect(v.scale).toBe(3.6); // (400 - 2 * 20) / 100
  expect(toDoc(v, 500, 200)).toEqual({ x: 200, y: 100 });
});

it("steps through Illustrator's zoom levels", () => {
  expect(zoomStep(1, 1)).toBe(1.5);
  expect(zoomStep(1, -1)).toBeCloseTo(2 / 3);
  expect(zoomStep(1.2, 1)).toBe(1.5);
  expect(zoomStep(1.2, -1)).toBe(1);
  expect(zoomStep(64, 1)).toBe(64);
  expect(zoomStep(0.0313, -1)).toBe(0.0313);
});
