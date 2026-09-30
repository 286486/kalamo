// Midpoints drawn as SVG, Inkscape and Canvas2D can: extra stops along the blend curve (ADR-0081).
import type { ColorStop, Gradient } from "./schema.ts";

/** A stop as drawn: a Color Stop, or one inserted along a midpoint's blend curve. */
export type DrawnStop = ColorStop & { simulated?: true };

/** Each channel's largest distance from the curve between inserted stops, before 8-bit rounding. */
export const MIDPOINT_TOLERANCE = 0.5 / 255;
/** The most stops inserted between two Color Stops; past it the tolerance loosens. */
export const MIDPOINT_CAP = 32;

/** The blend curve's exponent: u^p is 0.5 at the midpoint `m`. */
const exponent = (m: number) => Math.log(0.5) / Math.log(m);

/** How much of the next stop's colour is mixed in, `u` of the way there, with midpoint `m`. */
export const blend = (u: number, m = 0.5) => (m === 0.5 ? u : u ** exponent(m));

const channels = (c: string) =>
  [1, 3, 5, 7].map((i) => (i < c.length ? Number.parseInt(c.slice(i, i + 2), 16) : 255));

/** `a` and `b` mixed, `w` of the way to `b`, each channel and the alpha alike. */
export function mix(a: string, b: string, w: number): string {
  const [ca, cb] = [channels(a), channels(b)];
  const out = ca.map((v, k) => Math.round(v + ((cb[k] as number) - v) * w));
  const hex = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();
  return `#${out.slice(0, 3).map(hex).join("")}${out[3] === 255 ? "" : hex(out[3] as number)}`;
}

/** The farthest u^p strays from its chord over [a, b]: where its slope is the chord's. */
function chordError(a: number, b: number, p: number): number {
  const [wa, wb] = [a ** p, b ** p];
  const slope = (wb - wa) / (b - a);
  const u = Math.min(b, Math.max(a, (slope / p) ** (1 / (p - 1))));
  return Math.abs(u ** p - (wa + slope * (u - a)));
}

/** The fractions of a span, 0 and 1 left out, where stops keep u^p within `tol` of its chords. */
function breaks(p: number, tol: number): number[] {
  const out: number[] = [];
  for (let a = 0; chordError(a, 1, p) > tol; ) {
    // The chord's error only grows with its length, so the longest within `tol` is bisected for.
    let [lo, hi] = [a, 1];
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (chordError(a, mid, p) <= tol) lo = mid;
      else hi = mid;
    }
    out.push(lo);
    a = lo;
  }
  return out;
}

/**
 * The stops a gradient is drawn with: its Color Stops, and between a stop with a midpoint and the
 * next, stops along the blend curve, so the straight blends every renderer draws between them
 * stay within MIDPOINT_TOLERANCE of it (ADR-0081). With every midpoint 0.5, the stops themselves.
 */
export function drawnStops(g: Pick<Gradient, "stops">): DrawnStop[] {
  if (g.stops.every((s) => (s.midpoint ?? 0.5) === 0.5)) return g.stops;
  return g.stops.flatMap((s, i) => {
    const next = g.stops[i + 1];
    const span = next ? next.offset - s.offset : 0;
    if (!next || s.midpoint === undefined || s.midpoint === 0.5 || span === 0) return [s];
    const [ca, cb] = [channels(s.color), channels(next.color)];
    const reach = Math.max(...ca.map((v, k) => Math.abs((cb[k] as number) - v))) / 255;
    if (reach === 0) return [s];
    const p = exponent(s.midpoint);
    let us = breaks(p, MIDPOINT_TOLERANCE / reach);
    for (let tol = MIDPOINT_TOLERANCE / reach; us.length > MIDPOINT_CAP; ) {
      tol *= 2;
      us = breaks(p, tol);
    }
    const inserted: DrawnStop[] = [];
    for (const u of us) {
      const offset = Math.round((s.offset + u * span) * 1e6) / 1e6;
      // Next to its stop the curve is so steep a break can round onto a neighbour's offset; it is
      // left out rather than make a hard edge less than 1e-6 wide.
      if (offset <= (inserted.at(-1)?.offset ?? s.offset) || offset >= next.offset) continue;
      inserted.push({ offset, color: mix(s.color, next.color, u ** p), simulated: true });
    }
    return [s, ...inserted];
  });
}

/** The colour a gradient's stops blend to at `t`, 0 to 1, midpoints included. */
export function colorAt(stops: ColorStop[], t: number): string {
  const [first] = stops;
  if (!first) return "#000000";
  if (t <= first.offset) return first.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const [s, next] = [stops[i] as ColorStop, stops[i + 1] as ColorStop];
    if (t < next.offset) {
      return mix(s.color, next.color, blend((t - s.offset) / (next.offset - s.offset), s.midpoint));
    }
  }
  return (stops.at(-1) as ColorStop).color;
}
