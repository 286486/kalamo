import type { Segment } from "./path.ts";
import type { Shape } from "./schema.ts";

type Point = [number, number];
type Spiral = Extract<Shape, { type: "spiral" }>;

/** Samples per fitted piece, and a piece's step as a share of one turn (ADR-0060). */
const SAMPLES = 8;
const STEP = 1 / 4;
/** Inkscape's fit accepts a cubic within this many units of every sample. */
const TOLERANCE = 3;

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];

/**
 * A spiral as Inkscape 1.2.2 draws it (ADR-0060): the curve r = radius·t^expansion at
 * θ = 2π·revolution·t + argument, for t from t0 to 1, cut into pieces a quarter turn long, each
 * sampled at 8 points and fitted with one cubic by Schneider's least squares, the ends' tangents
 * fixed. Always open.
 */
export function spiralSegments(shape: Spiral): Segment[] {
  // Inkscape holds the parameters as float32 and computes in double.
  const f = Math.fround;
  const [cx, cy, radius, revolution, expansion, t0] = [
    f(shape.cx),
    f(shape.cy),
    f(shape.radius),
    f(shape.revolution),
    f(shape.expansion),
    f(shape.t0),
  ];
  const argument = f((shape.argument * Math.PI) / 180);
  const point = (t: number): Point => {
    const r = radius * t ** expansion;
    const a = 2 * Math.PI * revolution * t + argument;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  /** The unit direction the curve runs at t. */
  const tangent = (t: number): Point => {
    const a = 2 * Math.PI * revolution * t + argument;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    if (expansion === 0) return [-s, c];
    if (t === 0) return [c, s];
    // (expansion, 2π·revolution·t) turned by a: the derivative over radius·t^(expansion − 1).
    const [u, v] = [expansion, 2 * Math.PI * revolution * t];
    const l = Math.hypot(u, v);
    return [(u * c - v * s) / l, (u * s + v * c) / l];
  };

  const out: Segment[] = [{ cmd: "M", args: point(t0) }];
  /** Fits the piece from t, `dstep` between samples; returns where the next piece starts. */
  const piece = (t: number, dstep: number, hat1: Point): [number, Point] => {
    const pts: Point[] = [];
    let d = t;
    // A sample equal to the one before it is skipped short of the end, and the step after it doubles.
    for (let i = 0; i <= SAMPLES; d += dstep, i++) {
      const p = point(d);
      const last = pts[i - 1];
      if (last && p[0] === last[0] && p[1] === last[1] && d < 1) {
        i--;
        d += dstep;
      } else pts[i] = p;
    }
    const next = d - 2 * dstep;
    const [tx, ty] = tangent(next);
    const hat2: Point = [-tx, -ty];
    const cubics = fit(pts.slice(0, SAMPLES), hat1, hat2);
    if (cubics) out.push(...cubics.map((c): Segment => ({ cmd: "C", args: c.slice(1).flat() })));
    else out.push(...pts.slice(1, SAMPLES).map((p): Segment => ({ cmd: "L", args: [...p] })));
    return [next, [tx, ty]];
  };
  const tstep = STEP / revolution;
  let t = t0;
  let hat = tangent(t0);
  while (t < 1 - tstep) [t, hat] = piece(t, tstep / (SAMPLES - 1), hat);
  // A rest shorter than 1e-5 of the curve is left undrawn, as Inkscape leaves it.
  if (1 - t > 1e-5) piece(t, (1 - t) / (SAMPLES - 1), hat);
  return out;
}

const bezier = (q: Point[], u: number, k: 0 | 1) => {
  const m = 1 - u;
  const [p0, p1, p2, p3] = q as [Point, Point, Point, Point];
  return m * m * m * p0[k] + 3 * m * m * u * p1[k] + 3 * m * u * u * p2[k] + u * u * u * p3[k];
};
const at = (q: Point[], u: number): Point => [bezier(q, u, 0), bezier(q, u, 1)];

/**
 * Schneider's fit ("An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems 1990)
 * of cubics from the first point to the last, leaving along `hat1` and arriving against `hat2`:
 * chord-length parameters, then Newton steps and refits while the worst point is within 3
 * tolerances, then a split at the worst point, `depth` more times at most (5 cubics). Null when
 * that fails; empty when the points have no length.
 */
function fit(pts: Point[], hat1: Point, hat2: Point, depth = 4): Point[][] | null {
  const n = pts.length;
  const [p0, p3] = [pts[0] as Point, pts[n - 1] as Point];
  if (n === 2) {
    const l = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 3;
    return [
      [
        p0,
        [p0[0] + hat1[0] * l, p0[1] + hat1[1] * l],
        [p3[0] + hat2[0] * l, p3[1] + hat2[1] * l],
        p3,
      ],
    ];
  }
  const lengths = [0];
  for (let i = 1; i < n; i++) {
    const [a, b] = [pts[i - 1] as Point, pts[i] as Point];
    lengths.push((lengths[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lengths[n - 1] as number;
  if (total === 0) return [];
  let u = lengths.map((l) => l / total);

  const generate = (): Point[] => {
    let [c00, c01, c11, x0, x1] = [0, 0, 0, 0, 0];
    pts.forEach((p, i) => {
      const t = u[i] as number;
      const m = 1 - t;
      const [b0, b1, b2, b3] = [m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t];
      const a1: Point = [hat1[0] * b1, hat1[1] * b1];
      const a2: Point = [hat2[0] * b2, hat2[1] * b2];
      const rest = sub(p, [
        p0[0] * (b0 + b1) + p3[0] * (b2 + b3),
        p0[1] * (b0 + b1) + p3[1] * (b2 + b3),
      ]);
      c00 += dot(a1, a1);
      c01 += dot(a1, a2);
      c11 += dot(a2, a2);
      x0 += dot(a1, rest);
      x1 += dot(a2, rest);
    });
    const det = c00 * c11 - c01 * c01;
    let l1 = (x0 * c11 - x1 * c01) / det;
    let l2 = (c00 * x1 - c01 * x0) / det;
    // Schneider's fallback for a degenerate solve or a Handle pointing backwards.
    if (!(l1 >= 1e-6 && l2 >= 1e-6)) l1 = l2 = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 3;
    return [
      p0,
      [p0[0] + hat1[0] * l1, p0[1] + hat1[1] * l1],
      [p3[0] + hat2[0] * l2, p3[1] + hat2[1] * l2],
      p3,
    ];
  };
  /** One Newton-Raphson step of each inner point's parameter towards its nearest on q. */
  const reparameterize = (q: Point[]) => {
    const [, q1, q2] = q as [Point, Point, Point, Point];
    const [a, b, c] = [sub(q1, p0), sub(q2, q1), sub(p3, q2)];
    u = u.map((t, i) => {
      if (i === 0 || i === n - 1) return t;
      const m = 1 - t;
      const d1: Point = [
        3 * (m * m * a[0] + 2 * m * t * b[0] + t * t * c[0]),
        3 * (m * m * a[1] + 2 * m * t * b[1] + t * t * c[1]),
      ];
      const d2: Point = [
        6 * (m * (b[0] - a[0]) + t * (c[0] - b[0])),
        6 * (m * (b[1] - a[1]) + t * (c[1] - b[1])),
      ];
      const diff = sub(at(q, t), pts[i] as Point);
      const den = dot(d1, d1) + dot(diff, d2);
      const v = den > 0 ? t - dot(diff, d1) / den : t;
      const w = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : t;
      // A step that lands farther from the point is not taken.
      const far = (x: number) => Math.hypot(...sub(at(q, x), pts[i] as Point));
      return far(w) > far(t) ? t : w;
    });
  };
  /** The worst inner point's distance to q at its parameter, over the tolerance, and where. */
  const error = (q: Point[]): [number, number] => {
    let [worst, split] = [0, 0];
    pts.forEach((p, i) => {
      if (i === 0 || i === n - 1) return;
      const d = Math.hypot(...sub(at(q, u[i] as number), p));
      if (d > worst) [worst, split] = [d, i];
    });
    return [worst / TOLERANCE, split];
  };

  let q = generate();
  reparameterize(q);
  let [e, split] = error(q);
  if (e <= 3) {
    for (let k = 0; k < 4 && e > 1; k++) {
      q = generate();
      reparameterize(q);
      [e, split] = error(q);
    }
  }
  if (e <= 1) return [q];
  if (depth === 0) return null;
  // The tangent through the split point, from the point before it to the one after.
  const [bx, by] = sub(pts[split - 1] as Point, pts[split + 1] as Point);
  const l = Math.hypot(bx, by);
  const back: Point = [bx / l, by / l];
  const left = fit(pts.slice(0, split + 1), hat1, back, depth - 1);
  const right = left && fit(pts.slice(split), [-back[0], -back[1]], hat2, depth - left.length);
  return left && right && [...left, ...right];
}
