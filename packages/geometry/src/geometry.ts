/// <reference path="./pathkit.d.ts" />
import type { Geometry, OffsetStyle, Segment, StrokeStyle } from "@zibel/core";
import { ZibelError } from "@zibel/core";
import type { PathKit, SkPath } from "pathkit-wasm/bin/pathkit.js";

/** The ops on a loaded PathKit, for the Worker's loader and the browser's. */
export const geometryOf = (pk: PathKit): Geometry => ({
  outlineStroke: (segments, stroke) => outlineStroke(pk, segments, stroke),
  offsetPath: (segments, style) => offsetPath(pk, segments, style),
});

/**
 * Object > Path > Offset Path: the fill grown or shrunk by `distance`, an open subpath filled as if
 * closed. The fill united with (or minus) a stroke twice as wide, so self-overlaps resolve as Skia
 * resolves them.
 */
function offsetPath(pk: PathKit, segments: Segment[], style: OffsetStyle): Segment[] {
  if (style.distance === 0) return segments; // Skia would stroke a hairline and shrink the path.
  const path = skPath(pk, segments);
  path.setFillType(style.fillRule === "evenodd" ? pk.FillType.EVENODD : pk.FillType.WINDING);
  const stroke = path.copy();
  const owned: SkPath[] = [path, stroke];
  try {
    const ok =
      stroke.stroke({
        width: 2 * Math.abs(style.distance),
        join: pk.StrokeJoin[style.join.toUpperCase() as "MITER" | "ROUND" | "BEVEL"],
        cap: pk.StrokeCap.BUTT,
        miter_limit: style.miterLimit,
      }) && path.op(stroke, style.distance > 0 ? pk.PathOp.UNION : pk.PathOp.DIFFERENCE);
    if (!ok) throw failed("offset");
    return fromCmds(path.toCmds(), pk);
  } finally {
    for (const p of owned) p.delete();
  }
}

/**
 * Object > Path > Outline Stroke: the area `stroke` paints along `segments`, dashes included, as
 * non-overlapping contours that fill the same under nonzero and evenodd.
 */
function outlineStroke(pk: PathKit, segments: Segment[], stroke: StrokeStyle): Segment[] {
  const path = skPath(pk, segments);
  const owned: SkPath[] = [path];
  try {
    const dashed = stroke.dash.length > 0 ? dash(pk, path, stroke.dash, owned) : path;
    const ok =
      dashed?.stroke({
        width: stroke.width,
        join: pk.StrokeJoin[stroke.join.toUpperCase() as "MITER" | "ROUND" | "BEVEL"],
        cap: pk.StrokeCap[stroke.cap.toUpperCase() as "BUTT" | "ROUND" | "SQUARE"],
        miter_limit: stroke.miterLimit,
      }) && dashed.simplify();
    if (!ok) throw failed("outline the Stroke of");
    return fromCmds(ok.toCmds(), pk);
  } finally {
    for (const p of owned) p.delete();
  }
}

/**
 * The dashes of `pattern` along `path`, as SVG lays them from each subpath's start. PathKit dashes
 * with one dash and gap, so each dash of the pattern is its own pass, `on` then the rest of the
 * period off, started where that dash begins; the passes' dashes together are the pattern's.
 */
function dash(pk: PathKit, path: SkPath, pattern: number[], owned: SkPath[]): SkPath | null {
  const even = pattern.length % 2 === 0 ? pattern : [...pattern, ...pattern]; // as SVG repeats it
  const period = even.reduce((a, b) => a + b, 0);
  if (period <= 0) return path; // SVG draws such a pattern solid
  const out = pk.NewPath();
  owned.push(out);
  let start = 0;
  for (let i = 0; i < even.length; i += 2) {
    const on = even[i] as number;
    const pass = path.copy();
    owned.push(pass);
    if (!pass.dash(on, period - on, (period - start) % period)) return null;
    out.addPath(pass);
    start += on + (even[i + 1] as number);
  }
  return out;
}

const failed = (what: string) =>
  new ZibelError({
    code: "BOOLEAN_FAILED",
    message: `Skia PathOps could not ${what} this path.`,
    hint: "Check d for non-finite numbers or degenerate segments.",
  });

function skPath(pk: PathKit, segments: Segment[]): SkPath {
  const V = {
    M: pk.MOVE_VERB,
    L: pk.LINE_VERB,
    Q: pk.QUAD_VERB,
    C: pk.CUBIC_VERB,
    Z: pk.CLOSE_VERB,
  };
  return pk.FromCmds(segments.map((s) => [V[s.cmd], ...s.args]));
}

/** Skia verbs to core Segments. Conics (Skia's round joins and caps) become cubics. */
function fromCmds(cmds: number[][], pk: PathKit): Segment[] {
  const out: Segment[] = [];
  let [x, y] = [0, 0];
  for (const [verb, ...a] of cmds) {
    const n = a as number[];
    if (verb === pk.MOVE_VERB) out.push({ cmd: "M", args: n });
    else if (verb === pk.LINE_VERB) out.push({ cmd: "L", args: n });
    else if (verb === pk.QUAD_VERB) out.push({ cmd: "Q", args: n });
    else if (verb === pk.CUBIC_VERB) out.push({ cmd: "C", args: n });
    else if (verb === pk.CLOSE_VERB) out.push({ cmd: "Z", args: [] });
    else if (verb === pk.CONIC_VERB) {
      // The standard cubic for a conic: exact at the ends and tangents, and for a quarter circle
      // it is the usual 0.5523 kappa.
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, w = 1] = n;
      const k = (4 * w) / (3 * (1 + w));
      out.push({
        cmd: "C",
        args: [x + (x1 - x) * k, y + (y1 - y) * k, x2 + (x1 - x2) * k, y2 + (y1 - y2) * k, x2, y2],
      });
      [x, y] = [x2, y2];
      continue;
    }
    if (n.length >= 2) [x, y] = [n[n.length - 2] as number, n[n.length - 1] as number];
  }
  return out;
}
