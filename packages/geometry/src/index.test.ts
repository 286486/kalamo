import {
  formatNumber,
  formatPath,
  parsePath,
  pathBounds,
  type Segment,
  ZibelError,
} from "@zibel/core";
import { describe, expect, it } from "vitest";
import { offsetPath } from "./index.ts";

const K = 0.5522847498;
/** A circle as four cubics, the way core draws an ellipse. */
function circle(cx: number, cy: number, r: number): Segment[] {
  const c = r * K;
  return parsePath(
    `M ${cx + r} ${cy} C ${cx + r} ${cy + c} ${cx + c} ${cy + r} ${cx} ${cy + r} ` +
      `C ${cx - c} ${cy + r} ${cx - r} ${cy + c} ${cx - r} ${cy} ` +
      `C ${cx - r} ${cy - c} ${cx - c} ${cy - r} ${cx} ${cy - r} ` +
      `C ${cx + c} ${cy - r} ${cx + r} ${cy - c} ${cx + r} ${cy} Z`,
    "d",
  );
}
/** Bounds at the 3 decimals `d` keeps (REQUIREMENTS §6.5); Skia computes in float32. */
const bounds = (s: Segment[]) =>
  Object.fromEntries(Object.entries(pathBounds(s) ?? {}).map(([k, v]) => [k, formatNumber(v)]));
const cmds = (s: Segment[]) => new Set(s.map((x) => x.cmd));
const square = parsePath("M 0 0 L 100 0 L 100 100 L 0 100 Z", "d");

describe("offsetPath in workerd (ADR-0034)", () => {
  it("grows a circle and keeps it curved", async () => {
    const out = await offsetPath(circle(50, 50, 40), { distance: 10, join: "round" });
    expect(bounds(out)).toEqual({ x: "0", y: "0", width: "100", height: "100" });
    expect(cmds(out).has("L")).toBe(false);
  });

  it("shrinks a circle with a negative distance", async () => {
    const out = await offsetPath(circle(50, 50, 40), { distance: -10, join: "round" });
    expect(bounds(out)).toEqual({ x: "20", y: "20", width: "60", height: "60" });
  });

  it("mitres a square's corners", async () => {
    const out = await offsetPath(square, { distance: 5, join: "miter", miterLimit: 4 });
    expect(bounds(out)).toEqual({ x: "-5", y: "-5", width: "110", height: "110" });
    expect(cmds(out)).toEqual(new Set(["M", "L", "Z"]));
  });

  it("bevels corners past the miter limit", async () => {
    const out = await offsetPath(square, { distance: 5, join: "miter", miterLimit: 1 });
    expect(formatPath(out)).toBe(
      "M 100 -5 L 0 -5 L -5 0 L -5 100 L 0 105 L 100 105 L 105 100 L 105 0 L 100 -5 Z",
    );
  });

  it("rounds corners with cubics", async () => {
    const out = await offsetPath(square, { distance: 5, join: "round" });
    expect(cmds(out).has("C")).toBe(true);
    expect(formatPath(out)).toMatch(/^M /);
  });

  it("returns the path unchanged for a zero distance", async () => {
    expect(await offsetPath(square, { distance: 0, join: "miter" })).toEqual(square);
  });

  it("returns no segments when the shape shrinks away", async () => {
    expect(await offsetPath(square, { distance: -60, join: "miter" })).toEqual([]);
  });

  it("fails with BOOLEAN_FAILED instead of bad geometry", async () => {
    const bad: Segment[] = [...square.slice(0, 2), { cmd: "L", args: [Number.NaN, 1] }];
    await expect(offsetPath(bad, { distance: 5, join: "miter" })).rejects.toThrow(ZibelError);
  });
});
