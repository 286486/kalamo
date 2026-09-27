/// <reference path="./pathkit.d.ts" />
import type { Geometry } from "@zibel/core";
import PathKitInit from "pathkit-wasm/bin/pathkit.js";
import wasm from "pathkit-wasm/bin/pathkit.wasm?url";
import { geometryOf } from "./geometry.ts";

let ready: Promise<Geometry> | undefined;

/**
 * PathKit in the browser, for previews the Document DO commits (ADR-0034): the web app imports this
 * lazily, so the wasm is fetched on the first preview that needs it.
 */
export const loadGeometry = () =>
  (ready ??= PathKitInit({ locateFile: () => wasm })
    .then(geometryOf)
    .catch((e: unknown) => {
      ready = undefined; // the next call retries
      throw e;
    }));
