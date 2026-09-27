import { describe, expect, it } from "vitest";
import { toAnchors } from "./anchor.ts";
import type { ZibelError } from "./errors.ts";
import { fidelityTolerance, fitInk, freehandPath } from "./fit.ts";
import { formatPath, parsePath, type Segment } from "./path.ts";

type Point = [number, number];

const pair = (args: number[], k: number): Point => [args[k] ?? 0, args[k + 1] ?? 0];

/** Points along each segment of `d`, dense enough to measure distances to the curve. */
function trace(segments: Segment[]): Point[] {
  const out: Point[] = [];
  let at: Point = [0, 0];
  let start: Point = [0, 0];
  for (const { cmd, args } of segments) {
    const end = cmd === "Z" ? start : pair(args, args.length - 2);
    const [c1, c2]: [Point, Point] = cmd === "C" ? [pair(args, 0), pair(args, 2)] : [at, end];
    if (cmd === "M") start = end;
    else
      for (let k = 0; k <= 400; k++) {
        const t = k / 400;
        const [a, b, c, d] = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
        out.push([
          a * at[0] + b * c1[0] + c * c2[0] + d * end[0],
          a * at[1] + b * c1[1] + c * c2[1] + d * end[1],
        ]);
      }
    at = end;
  }
  return out;
}

/** The farthest any point lies from the curve. */
const maxError = (points: Point[], segments: Segment[]) => {
  const curve = trace(segments);
  return Math.max(
    ...points.map((p) => Math.min(...curve.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))),
  );
};

const curves = (segments: Segment[]) => segments.filter((s) => s.cmd === "C" || s.cmd === "L");

const circle = (n: number, r: number): Point[] =>
  Array.from({ length: n + 1 }, (_, k) => [
    200 + r * Math.cos((2 * Math.PI * k) / n),
    200 + r * Math.sin((2 * Math.PI * k) / n),
  ]);

/** A hand-drawn wave: a sine with seeded jitter. */
const wave = (): Point[] => {
  let seed = 7;
  const jitter = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647 - 0.5) * 1.5;
  };
  return Array.from({ length: 300 }, (_, k) => [k + jitter(), 40 * Math.sin(k / 30) + jitter()]);
};

describe("fitInk", () => {
  it("fits a sampled circle at Fidelity 50 with at most 8 smooth cubics within 1 pt", () => {
    const points = circle(120, 100);
    const segments = fitInk(points, fidelityTolerance(50));
    expect(segments.at(-1)?.cmd).toBe("Z");
    expect(curves(segments).length).toBeLessThanOrEqual(8);
    expect(curves(segments).every((s) => s.cmd === "C")).toBe(true);
    expect(maxError(points, segments)).toBeLessThanOrEqual(1);
    const [loop] = toAnchors(parsePath(formatPath(segments), "d"));
    expect(loop?.closed).toBe(true);
    expect(loop?.anchors.every((a) => a.type === "smooth")).toBe(true);
  });

  it("keeps a Corner Anchor at a sharp corner, and straight runs become lines", () => {
    const points: Point[] = [
      ...Array.from({ length: 50 }, (_, k): Point => [2 * k, 0]),
      ...Array.from({ length: 51 }, (_, k): Point => [100, 2 * k]),
    ];
    expect(formatPath(fitInk(points, 1))).toBe("M 0 0 L 100 0 L 100 100");
  });

  it("closes a square with Z and no Anchor doubled on the first", () => {
    const side = (a: Point, b: Point) =>
      Array.from(
        { length: 20 },
        (_, k): Point => [a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20],
      );
    const points = [
      ...side([0, 0], [100, 0]),
      ...side([100, 0], [100, 100]),
      ...side([100, 100], [0, 100]),
      ...side([0, 100], [0, 0]),
      [0, 0] as Point,
    ];
    expect(formatPath(fitInk(points, 1))).toBe("M 0 0 L 100 0 L 100 100 L 0 100 Z");
  });

  it("keeps a corner where a curve meets a line", () => {
    // A half circle arriving at (100, 0) heading up, then a line heading right.
    const arc = Array.from({ length: 61 }, (_, k): Point => {
      const a = Math.PI - (Math.PI * k) / 60;
      return [50 + 50 * Math.cos(a), 50 * Math.sin(a)];
    });
    const line = Array.from({ length: 50 }, (_, k): Point => [102 + 2 * k, 0]);
    const points = [...arc, ...line];
    const segments = fitInk(points, 1);
    expect(maxError(points, segments)).toBeLessThanOrEqual(1);
    expect(segments.at(-1)).toEqual({ cmd: "L", args: [200, 0] });
    const anchors = toAnchors(parsePath(formatPath(segments), "d"))[0]?.anchors ?? [];
    const inner = anchors.slice(1, -1);
    expect(inner.filter((a) => a.type === "corner").map((a) => a.anchor)).toEqual([[100, 0]]);
  });

  it("fits a straight stroke as one line", () => {
    const points = Array.from({ length: 30 }, (_, k): Point => [k * 4, k * 2]);
    expect(formatPath(fitInk(points, 0.1))).toBe("M 0 0 L 116 58");
  });

  it("stays within the tolerance on hand-drawn Ink, with fewer Anchors as Fidelity rises", () => {
    const points = wave();
    const counts = [0, 25, 50, 75, 100].map((fidelity) => {
      const tolerance = fidelityTolerance(fidelity);
      const segments = fitInk(points, tolerance);
      expect(maxError(points, segments)).toBeLessThanOrEqual(tolerance);
      return curves(segments).length;
    });
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1] ?? 0);
    }
    expect(counts[0]).toBeGreaterThan(counts.at(-1) ?? 0);
  });

  it("drops repeated points", () => {
    expect(
      formatPath(
        fitInk(
          [
            [0, 0],
            [0, 0],
            [10, 0],
            [10, 0],
          ],
          1,
        ),
      ),
    ).toBe("M 0 0 L 10 0");
  });
});

describe("fidelityTolerance", () => {
  it("rises from Accurate to Smooth, 1 pt in the middle", () => {
    const steps = Array.from({ length: 101 }, (_, f) => fidelityTolerance(f));
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1] ?? 0);
    expect(fidelityTolerance(50)).toBe(1);
  });
});

describe("freehandPath", () => {
  it("is a path with the Pencil's default Appearance, a 1 pt black Stroke and no Fill", () => {
    const item = freehandPath({
      parentId: "p",
      points: [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 10, y: 0 },
      ],
      tool: "pencil",
    });
    expect(item).toEqual({
      type: "path",
      parentId: "p",
      d: "M 0 0 L 10 0",
      appearance: { fills: [], strokes: [{ color: "#000000" }] },
    });
  });

  it("keeps the appearance given", () => {
    const appearance = { fills: [{ color: "#ff0000" }], strokes: [] };
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(freehandPath({ parentId: "p", points, tool: "pencil", appearance }).appearance).toEqual(
      appearance,
    );
  });

  it("refuses Ink without two distinct points", () => {
    const points = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    try {
      freehandPath({ parentId: "p", points, tool: "pencil" });
      expect.unreachable();
    } catch (e) {
      expect((e as ZibelError).data).toMatchObject({ code: "INVALID_PATH", path: "points" });
    }
  });
});
