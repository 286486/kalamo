import { z } from "zod";
import type { BareAnchor } from "./anchor.ts";
import { ZibelError } from "./errors.ts";
import { formatPath, type Segment } from "./path.ts";
import { AppearanceInput } from "./schema.ts";

type Point = [number, number];
/** A cubic from p0 to p3; no Handles is a line. */
type Cubic = [Point, Point | null, Point | null, Point];

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Point, k: number): Point => [a[0] * k, a[1] * k];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (a: Point): Point => scale(a, 1 / (Math.hypot(a[0], a[1]) || 1));

/** Fidelity 0 (Accurate) to 100 (Smooth) as the fit's largest error in pt: 0.1, 1 and 10 (ADR-0033). */
export const fidelityTolerance = (fidelity: number) => 10 ** ((fidelity - 50) / 50);

/** Ends this close, in pt, close the path, whatever the tolerance (ADR-0033). */
const CLOSE = 1e-3;

/** A turn sharper than this, seen over twice the tolerance, is a Corner Anchor (ADR-0033). */
const CORNER = (60 * Math.PI) / 180;

/** The Pencil's corners and closing; Simplify sets both (ADR-0035). */
export interface FitOptions {
  /** A sharper turn, in radians, is a corner. */
  corner?: number;
  /** Closed or open whatever the ends; a closed Ink may end on its first point. */
  closed?: boolean;
}

const bezier = ([p0, c1, c2, p3]: Cubic, t: number): Point => {
  const [a, b, c, d] = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
  const [h1, h2] = [c1 ?? p0, c2 ?? p3];
  return [
    a * p0[0] + b * h1[0] + c * h2[0] + d * p3[0],
    a * p0[1] + b * h1[1] + c * h2[1] + d * p3[1],
  ];
};

/**
 * Fits Ink with cubic Béziers, as Illustrator's Pencil does on release: Schneider's least-squares
 * fit ("An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems 1990), split at
 * corners, every point within `tolerance` pt of the curve. A straight run between corners is a
 * line. Ends within the tolerance of each other close the path.
 */
export function fitInk(ink: Point[], tolerance: number, opts: FitOptions = {}): Segment[] {
  const pts = ink.filter((p, i) => i === 0 || dist(p, ink[i - 1] as Point) > 1e-9);
  const ends = dist(pts[0] as Point, pts.at(-1) as Point) <= CLOSE;
  const closed = opts.closed ?? (pts.length > 3 && ends);
  if (closed && ends) pts.pop();
  const corner = opts.corner ?? CORNER;
  const n = pts.length;
  const at = (i: number) => pts[closed ? (i + n) % n : i] as Point;
  const reach = 2 * tolerance;

  /** The unit direction from point i towards the first point `reach` away, stepping by `dir`. */
  const toward = (i: number, dir: 1 | -1, stop: number): Point | null => {
    for (let j = i + dir; dir > 0 ? j <= stop : j >= stop; j += dir) {
      if (dist(at(j), at(i)) >= reach) return unit(sub(at(j), at(i)));
    }
    return null;
  };

  // Corners: turns sharper than `corner`, the sharpest of each run.
  const turn = (i: number) => {
    const back = toward(i, -1, closed ? i - n + 1 : 0);
    const ahead = toward(i, 1, closed ? i + n - 1 : n - 1);
    return back && ahead ? Math.acos(Math.max(-1, Math.min(1, -dot(back, ahead)))) : 0;
  };
  const turns = pts.map((_, i) => (closed || (i > 0 && i < n - 1) ? turn(i) : 0));
  const corners = turns.flatMap((t, i) => {
    if (t <= corner) return [];
    const run = (dir: 1 | -1) => {
      for (let j = i + dir; closed || (j >= 0 && j < n); j += dir) {
        const k = (j + n) % n;
        if (k === i || dist(at(j), at(i)) >= reach) return true;
        if ((turns[k] ?? 0) > t || ((turns[k] ?? 0) === t && k < i)) return false;
      }
      return true;
    };
    return run(-1) && run(1) ? [i] : [];
  });

  // Pieces between corners, as index ranges over `at` (a closed path's wrap past n).
  const cuts = closed ? corners : [0, ...corners, n - 1];
  let pieces: [number, number][] = cuts.slice(1).map((c, k) => [cuts[k] as number, c]);
  if (closed)
    pieces = cuts.length ? [...pieces, [cuts.at(-1) as number, cuts[0] as number]] : halves();
  pieces = pieces.map(([a, b]) => [a, b > a ? b : b + n]);

  /** A smooth loop splits at the point farthest from its start, so no piece has coincident ends. */
  function halves(): [number, number][] {
    const d = pts.map((p) => dist(p, pts[0] as Point));
    const far = d.indexOf(Math.max(...d));
    return [
      [0, far],
      [far, 0],
    ];
  }
  const loop = closed && !corners.length;
  /** The tangent through point i of a smooth loop, pointing back along it. */
  const center = (i: number) => {
    const back = toward(i, -1, i + 1 - n);
    const ahead = toward(i, 1, i + n - 1);
    return back && ahead ? unit(sub(back, ahead)) : null;
  };

  const cubics: Cubic[] = [];
  for (const [first, last] of pieces) {
    const run = Array.from({ length: last - first + 1 }, (_, k) => at(first + k));
    const [p0, p3] = [run[0] as Point, run.at(-1) as Point];
    const chord = unit(sub(p3, p0));
    const off = (p: Point) => Math.abs((p[0] - p0[0]) * chord[1] - (p[1] - p0[1]) * chord[0]);
    if (!loop && run.every((p) => off(p) <= tolerance)) {
      cubics.push([p0, null, null, p3]);
      continue;
    }
    // A smooth loop's pieces share a tangent where they meet.
    const c1 = loop ? center(first) : null;
    const t1 = c1 ? scale(c1, -1) : (toward(first, 1, last) ?? chord);
    const t2 = (loop ? center(last) : null) ?? toward(last, -1, first) ?? scale(chord, -1);
    fitCubic(run, t1, t2, cubics);
  }

  const out: Segment[] = [{ cmd: "M", args: [...(pts[0] as Point)] }];
  if (closed && corners.length) out[0] = { cmd: "M", args: [...at(corners[0] as number)] };
  // Z draws a closing line.
  if (closed && !cubics.at(-1)?.[1]) cubics.pop();
  for (const [, c1, c2, p3] of cubics) {
    out.push(c1 && c2 ? { cmd: "C", args: [...c1, ...c2, ...p3] } : { cmd: "L", args: [...p3] });
  }
  if (closed) out.push({ cmd: "Z", args: [] });
  return out;

  /** One cubic within the tolerance, reparameterized up to 4 times, else the worst point. */
  function fitOne(run: Point[], t1: Point, t2: Point): Cubic | number {
    const tol2 = tolerance * tolerance;
    const [p0, p3] = [run[0] as Point, run.at(-1) as Point];
    if (run.length === 2) {
      const d = dist(p0, p3) / 3;
      return [p0, add(p0, scale(t1, d)), add(p3, scale(t2, d)), p3];
    }
    let u = chordLengths(run);
    let cubic = generate(run, u, t1, t2);
    let [error, split] = maxError(run, cubic, u);
    for (let k = 0; k < 4 && error > tol2 && error <= 4 * tol2; k++) {
      u = u.map((t, i) => newton(cubic, run[i] as Point, t));
      cubic = generate(run, u, t1, t2);
      [error, split] = maxError(run, cubic, u);
    }
    return error <= tol2 ? cubic : split;
  }

  /**
   * Each cubic as long as one fits, found by bisection. Schneider splits at the worst point
   * instead, which is rarely where the Anchors belong and gives about half again as many.
   */
  function fitCubic(run: Point[], t1: Point, t2: Point, into: Cubic[]): void {
    const back = (k: number) =>
      k === run.length - 1 ? t2 : unit(sub(run[k - 1] as Point, run[k + 1] as Point));
    let [i, ti] = [0, t1];
    while (i < run.length - 1) {
      const fit = (j: number) => fitOne(run.slice(i, j + 1), ti, back(j));
      let [lo, hi] = [i + 1, run.length - 1];
      let best = fit(hi);
      if (typeof best === "number") {
        best = fit(lo) as Cubic;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          const cubic = fit(mid);
          if (typeof cubic === "number") hi = mid;
          else [lo, best] = [mid, cubic];
        }
        hi = lo;
      }
      into.push(best);
      [i, ti] = [hi, scale(back(hi), -1)];
    }
  }
}

/**
 * Object > Path > Simplify (research §5, ADR-0035): the subpath traced as Ink and refitted within
 * `tolerance`, keeping as corners the turns whose angle is at most `cornerAngle` degrees (180° is
 * straight on); `toLines` fits straight segments only. Null for a subpath with no length.
 */
export function simplifySubpath(
  { closed, anchors }: { closed: boolean; anchors: BareAnchor[] },
  tolerance: number,
  cornerAngle: number,
  toLines: boolean,
): Segment[] | null {
  const n = anchors.length;
  const cubics = Array.from({ length: closed ? n : n - 1 }, (_, i): Cubic => {
    const [a, b] = [anchors[i] as BareAnchor, anchors[(i + 1) % n] as BareAnchor];
    return [a.anchor, a.handleOut, b.handleIn, b.anchor];
  });
  // The control polygon's length bounds the curve's.
  const lengths = cubics.map(([p0, c1, c2, p3]) => {
    const [h1, h2] = [c1 ?? p0, c2 ?? p3];
    return dist(p0, h1) + dist(h1, h2) + dist(h2, p3);
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 1e-9) return null;
  // Points half the tolerance apart, at least 16 and at most 10,000 along the subpath.
  const step = Math.min(Math.max(tolerance / 2, total / 10000), total / 16);
  const ink: Point[] = [(anchors[0] as BareAnchor).anchor];
  cubics.forEach((cubic, i) => {
    const k = Math.max(1, Math.ceil((lengths[i] as number) / step));
    for (let j = 1; j <= k; j++) ink.push(bezier(cubic, j / k));
  });
  if (!toLines) {
    return fitInk(ink, tolerance, { closed, corner: Math.PI * (1 - cornerAngle / 180) - 1e-9 });
  }
  const kept = straighten(ink, tolerance);
  if (closed) kept.pop();
  return [
    { cmd: "M", args: [...(kept[0] as Point)] },
    ...kept.slice(1).map((p): Segment => ({ cmd: "L", args: [...p] })),
    ...(closed ? [{ cmd: "Z" as const, args: [] }] : []),
  ];
}

/** Douglas–Peucker: the fewest of the points, ends kept, whose polyline passes within `tolerance` of every one. */
function straighten(pts: Point[], tolerance: number): Point[] {
  const toChord = (p: Point, a: Point, b: Point) => {
    const ab = sub(b, a);
    const t = dot(ab, ab) ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab))) : 0;
    return dist(p, add(a, scale(ab, t)));
  };
  const keep = [0, pts.length - 1];
  const todo: [number, number][] = [[0, pts.length - 1]];
  for (let range = todo.pop(); range; range = todo.pop()) {
    const [a, b] = range;
    let [far, worst] = [tolerance, -1];
    for (let i = a + 1; i < b; i++) {
      const d = toChord(pts[i] as Point, pts[a] as Point, pts[b] as Point);
      if (d > far) [far, worst] = [d, i];
    }
    if (worst < 0) continue;
    keep.push(worst);
    todo.push([a, worst], [worst, b]);
  }
  return keep.sort((x, y) => x - y).map((i) => pts[i] as Point);
}

/** Each point's parameter by the distance along the polyline. */
function chordLengths(run: Point[]): number[] {
  const u = [0];
  for (let i = 1; i < run.length; i++) {
    u.push((u[i - 1] as number) + dist(run[i] as Point, run[i - 1] as Point));
  }
  const total = u.at(-1) as number;
  return u.map((t) => t / total);
}

/** The least-squares cubic with the ends and tangent directions fixed. */
function generate(run: Point[], u: number[], t1: Point, t2: Point): Cubic {
  const [p0, p3] = [run[0] as Point, run.at(-1) as Point];
  const c = [
    [0, 0],
    [0, 0],
  ] as [[number, number], [number, number]];
  const x = [0, 0];
  run.forEach((p, i) => {
    const t = u[i] as number;
    const [b0, b1, b2, b3] = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
    const a1 = scale(t1, b1);
    const a2 = scale(t2, b2);
    c[0][0] += dot(a1, a1);
    c[0][1] += dot(a1, a2);
    c[1][1] += dot(a2, a2);
    const rest = sub(p, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
    x[0] = (x[0] as number) + dot(a1, rest);
    x[1] = (x[1] as number) + dot(a2, rest);
  });
  c[1][0] = c[0][1];
  const det = c[0][0] * c[1][1] - c[1][0] * c[0][1];
  let a = det ? ((x[0] as number) * c[1][1] - c[0][1] * (x[1] as number)) / det : 0;
  let b = det ? (c[0][0] * (x[1] as number) - c[1][0] * (x[0] as number)) / det : 0;
  // Schneider's fallback when the solve is degenerate or points a Handle backwards; also when a
  // Handle outreaches the chord, a loop that meets each point at its parameter but nowhere near.
  const length = dist(p0, p3);
  if (!(a >= 1e-6 * length && b >= 1e-6 * length && a <= length && b <= length)) {
    a = b = length / 3;
  }
  return [p0, add(p0, scale(t1, a)), add(p3, scale(t2, b)), p3];
}

/** The largest squared distance from a point to the cubic at its parameter, and where. */
function maxError(run: Point[], cubic: Cubic, u: number[]): [number, number] {
  let [error, split] = [0, Math.floor(run.length / 2)];
  for (let i = 1; i < run.length - 1; i++) {
    const d = dist(bezier(cubic, u[i] as number), run[i] as Point) ** 2;
    if (d > error) [error, split] = [d, i];
  }
  return [error, split];
}

/** One Newton-Raphson step towards the parameter nearest p. */
function newton(cubic: Cubic, p: Point, t: number): number {
  const [p0, c1, c2, p3] = cubic;
  const [h1, h2] = [c1 ?? p0, c2 ?? p3];
  // The first and second derivatives at t.
  const [a, b, c] = [sub(h1, p0), sub(h2, h1), sub(p3, h2)];
  const d1 = scale(add(add(scale(a, (1 - t) ** 2), scale(b, 2 * (1 - t) * t)), scale(c, t * t)), 3);
  const d2 = scale(add(scale(sub(b, a), 1 - t), scale(sub(c, b), t)), 6);
  const diff = sub(bezier(cubic, t), p);
  const den = dot(d1, d1) + dot(diff, d2);
  // Clamped: past an end, the error would be measured on the curve extended.
  return den ? Math.min(1, Math.max(0, t - dot(diff, d1) / den)) : t;
}

const coordinate = z.number().min(-1e6).max(1e6).describe("In pt, within ±1,000,000.");

/** `freehand_stroke` (REQUIREMENTS §6.4, F-FREE-06): Ink an Agent draws, fitted as the Pencil does. */
export const FreehandStrokeInput = z.object({
  parentId: z.string().describe("A Layer or Group id to draw the path in."),
  points: z
    .array(
      z.object({
        x: coordinate,
        y: coordinate,
        pressure: z.number().min(0).max(1).optional().describe("0 to 1; the Pencil ignores it."),
      }),
    )
    .min(2)
    .max(10000)
    .describe("The Ink in drawing order, in document coordinates."),
  tool: z.literal("pencil"),
  fidelity: z
    .number()
    .min(0)
    .max(100)
    .default(50)
    .describe(
      "Illustrator's Pencil Fidelity: 0 Accurate (within 0.1 pt of every point) to 100 Smooth (within 10 pt); 50 is within 1 pt.",
    ),
  appearance: AppearanceInput.optional().describe(
    "Omit for the Pencil's default, a 1 pt black Stroke and no Fill.",
  ),
});
export type FreehandStrokeInput = z.input<typeof FreehandStrokeInput>;

/** The path item `node_create` takes for the fitted Ink. */
export function freehandPath(raw: FreehandStrokeInput) {
  const { parentId, points, fidelity, appearance } = FreehandStrokeInput.parse(raw);
  const ink = points.map(({ x, y }): Point => [x, y]);
  if (ink.every((p) => dist(p, ink[0] as Point) <= 1e-9)) {
    throw new ZibelError({
      code: "INVALID_PATH",
      message: "The Ink has no two distinct points.",
      hint: "Give at least two points apart.",
      path: "points",
    });
  }
  return {
    type: "path" as const,
    parentId,
    d: formatPath(fitInk(ink, fidelityTolerance(fidelity))),
    appearance: appearance ?? { fills: [], strokes: [{ color: "#000000" }] },
  };
}
