import { expect, it } from "vitest";
import { normalizePath, shapeSegments } from "./path.ts";
import reference from "./spiral.inkscape.json" with { type: "json" };

// Spirals Inkscape 1.2.2 drew: the parameters (argument in degrees) and the d that object-to-path
// wrote, at its 8 significant digits (ADR-0060).
it.each(reference.map((r, i) => [i, r] as const))("draws spiral %i as Inkscape does", (_, r) => {
  const { d, ...params } = r;
  const ours = shapeSegments({ type: "spiral", ...params });
  const inkscape = normalizePath(d, "d");
  expect(ours.map((s) => s.cmd)).toEqual(inkscape.map((s) => s.cmd));
  ours.forEach((s, j) => {
    s.args.forEach((v, k) => {
      const want = inkscape[j]?.args[k] ?? Number.NaN;
      expect(Math.abs(v - want)).toBeLessThan(Math.max(0.01, Math.abs(want) * 1e-6));
    });
  });
});

it("is open, and a spiral of radius 0 is only its start", () => {
  const spiral = {
    type: "spiral",
    cx: 5,
    cy: 6,
    revolution: 3,
    expansion: 1,
    argument: 0,
    t0: 0,
  } as const;
  expect(shapeSegments({ ...spiral, radius: 40 }).some((s) => s.cmd === "Z")).toBe(false);
  expect(shapeSegments({ ...spiral, radius: 0 })).toEqual([{ cmd: "M", args: [5, 6] }]);
});
