import {
  formatNumber,
  formatPath,
  parsePath,
  pathBounds,
  type Segment,
  type StrokeStyle,
  ZibelError,
} from "@zibel/core";
import { svgToPixels } from "@zibel/render";
import { describe, expect, it } from "vitest";
import { loadGeometry, offsetPath } from "./index.ts";

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

describe("outlineStroke in workerd", () => {
  const style: StrokeStyle = { width: 10, cap: "butt", join: "miter", miterLimit: 10, dash: [] };
  /**
   * Alpha of `paint` on a 200 × 100 canvas at 8 pixels per point, one byte per pixel. resvg flattens
   * a Stroke's round caps before it zooms: at 2 a dot is 1.4% off a true circle, at 8 0.3%.
   */
  const alpha = async (paint: string) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${paint}</svg>`;
    const { pixels } = await svgToPixels(svg, 8);
    return pixels.filter((_, i) => i % 4 === 3);
  };
  /** How far the outline filled differs from the path stroked, as a share of the stroke's ink. */
  const diff = async (d: string, stroke: Partial<StrokeStyle>, rule = "nonzero") => {
    const s = { ...style, ...stroke };
    const outline = (await loadGeometry()).outlineStroke(parsePath(d, "d"), s);
    const dash = s.dash.length > 0 ? ` stroke-dasharray="${s.dash.join(" ")}"` : "";
    const stroked = await alpha(
      `<path d="${d}" fill="none" stroke="#000" stroke-width="${s.width}" stroke-linecap="${s.cap}" stroke-linejoin="${s.join}" stroke-miterlimit="${s.miterLimit}"${dash}/>`,
    );
    const filled = await alpha(
      `<path d="${formatPath(outline)}" fill="#000" fill-rule="${rule}"/>`,
    );
    let [ink, off] = [0, 0];
    stroked.forEach((a, i) => {
      ink += a;
      off += Math.abs(a - (filled[i] ?? 0));
    });
    return { outline, share: off / ink };
  };
  const sCurve = "M 20 80 C 20 20 100 20 100 50 C 100 80 180 80 180 20";
  const zigzag = "M 20 80 L 60 20 L 100 80 L 140 20 L 180 80";

  it("outlines a 10 pt open path as a closed path that paints what the Stroke paints", async () => {
    const { outline, share } = await diff(sCurve, {});
    expect(share).toBeLessThan(0.01);
    expect(outline.at(-1)?.cmd).toBe("Z");
    expect(cmds(outline).has("L") && (cmds(outline).has("Q") || cmds(outline).has("C"))).toBe(true);
  });

  it("keeps caps, joins and the miter limit", async () => {
    for (const stroke of [
      { cap: "round", join: "round" },
      { cap: "square", join: "bevel" },
      { join: "miter", miterLimit: 1 },
      { join: "miter", miterLimit: 10 },
    ] satisfies Partial<StrokeStyle>[]) {
      expect((await diff(zigzag, stroke)).share, JSON.stringify(stroke)).toBeLessThan(0.01);
    }
  });

  // On straight segments: along a curve resvg and Skia measure length a little apart, so dashes
  // drift by a fraction of a point.
  it("outlines each dash, the pattern repeated as SVG repeats it", async () => {
    for (const dash of [[12, 6], [12, 6, 3, 6], [9], [0, 8]]) {
      expect((await diff(zigzag, { dash, cap: "round" })).share, JSON.stringify(dash)).toBeLessThan(
        0.01,
      );
    }
  });

  it("outlines a closed path as a ring that fills alike under nonzero and evenodd", async () => {
    const ring = formatPath(circle(100, 50, 30));
    expect((await diff(ring, {}, "nonzero")).share).toBeLessThan(0.01);
    expect((await diff(ring, {}, "evenodd")).share).toBeLessThan(0.01);
  });
});
