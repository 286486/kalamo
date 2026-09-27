import type { Geometry } from "@zibel/core";
import PathKitInit, { type PathKit } from "pathkit-wasm/bin/pathkit.js";
import wasm from "pathkit-wasm/bin/pathkit.wasm";
import { geometryOf } from "./geometry.ts";

// Skia PathOps and stroker (ADR-0034). Workers forbid compiling wasm from bytes, so the module is
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
  }).catch((e: unknown) => {
    ready = undefined; // the next call retries
    throw e;
  }));

/**
 * PathKit loaded, with the ops that run synchronously on it, for callers that cannot await inside
 * their edit (a Durable Object's Transaction).
 */
export async function loadGeometry(): Promise<Geometry> {
  return geometryOf(await pathKit());
}
