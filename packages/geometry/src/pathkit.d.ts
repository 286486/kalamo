// The part of pathkit-wasm 1.0.0 that geometry uses; the package ships no types.
declare module "pathkit-wasm/bin/pathkit.js" {
  interface Enum {
    readonly value: number;
  }
  export interface SkPath {
    copy(): SkPath;
    setFillType(type: Enum): void;
    stroke(opts: { width: number; join: Enum; cap: Enum; miter_limit: number }): SkPath | null;
    op(other: SkPath, op: Enum): SkPath | null;
    /** Keeps the dashes of an `on`, `off` pattern started `phase` into it. */
    dash(on: number, off: number, phase: number): SkPath | null;
    /** Resolves self-overlaps into non-overlapping contours. */
    simplify(): SkPath | null;
    addPath(other: SkPath): SkPath;
    /** `[verb, ...numbers]` per verb; numbers are float32. */
    toCmds(): number[][];
    delete(): void;
  }
  export interface PathKit {
    FromCmds(cmds: number[][]): SkPath;
    NewPath(): SkPath;
    MOVE_VERB: number;
    LINE_VERB: number;
    QUAD_VERB: number;
    CONIC_VERB: number;
    CUBIC_VERB: number;
    CLOSE_VERB: number;
    PathOp: { UNION: Enum; DIFFERENCE: Enum; INTERSECT: Enum };
    StrokeJoin: { MITER: Enum; ROUND: Enum; BEVEL: Enum };
    StrokeCap: { BUTT: Enum; ROUND: Enum; SQUARE: Enum };
    FillType: { WINDING: Enum; EVENODD: Enum };
  }
  export default function PathKitInit(
    opts:
      | {
          instantiateWasm(
            imports: WebAssembly.Imports,
            done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
          ): WebAssembly.Exports;
        }
      | { locateFile(file: string): string },
  ): Promise<PathKit>;
}

declare module "pathkit-wasm/bin/pathkit.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

/** Vite's URL of the file, for the browser's loader. */
declare module "pathkit-wasm/bin/pathkit.wasm?url" {
  const url: string;
  export default url;
}
