import { type Segment, ZibelError } from "@zibel/core";
import PathKitInit, { type PathKit, type SkPath } from "pathkit-wasm/bin/pathkit.js";
import wasm from "pathkit-wasm/bin/pathkit.wasm";

// Skia PathOps and stroker (ADR-0033). Workers forbid compiling wasm from bytes, so the module is
// imported statically and handed to Emscripten's instantiateWasm hook. Instantiated on first use:
// its heap starts at 32 MiB of the isolate's 128 MB.
let ready: Promise<PathKit> | undefined;
const pathKit = () =>
  (ready ??= PathKitInit({
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(wasm, imports);
      done(instance, wasm);
      return instance.exports;
    },
  }));

export interface OffsetOptions {
  /** Points; negative shrinks. */
  distance: number;
  join: "miter" | "round" | "bevel";
  miterLimit?: number;
  fillRule?: "nonzero" | "evenodd";
}

/**
 * Object > Path > Offset Path on a closed path: the fill grown or shrunk by `distance`. The fill
 * united with (or minus) a stroke twice as wide, so self-overlaps resolve as Skia resolves them.
 */
export async function offsetPath(segments: Segment[], opts: OffsetOptions): Promise<Segment[]> {
  const pk = await pathKit();
  const V = {
    M: pk.MOVE_VERB,
    L: pk.LINE_VERB,
    Q: pk.QUAD_VERB,
    C: pk.CUBIC_VERB,
    Z: pk.CLOSE_VERB,
  };
  const path = pk.FromCmds(segments.map((s) => [V[s.cmd], ...s.args]));
  path.setFillType(opts.fillRule === "evenodd" ? pk.FillType.EVENODD : pk.FillType.WINDING);
  const stroke = path.copy();
  const owned: SkPath[] = [path, stroke];
  try {
    const ok =
      stroke.stroke({
        width: 2 * Math.abs(opts.distance),
        join: pk.StrokeJoin[opts.join.toUpperCase() as "MITER" | "ROUND" | "BEVEL"],
        cap: pk.StrokeCap.BUTT,
        miter_limit: opts.miterLimit ?? 4,
      }) && path.op(stroke, opts.distance > 0 ? pk.PathOp.UNION : pk.PathOp.DIFFERENCE);
    if (!ok) {
      throw new ZibelError({
        code: "BOOLEAN_FAILED",
        message: "Skia PathOps could not offset this path.",
        hint: "Check d for non-finite numbers or degenerate segments.",
      });
    }
    return fromCmds(path.toCmds(), pk);
  } finally {
    for (const p of owned) p.delete();
  }
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
