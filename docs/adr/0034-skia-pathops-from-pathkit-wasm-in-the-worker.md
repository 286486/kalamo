---
status: accepted
date: 2026-09-27
---

# Path geometry is Skia PathOps and stroker from `pathkit-wasm`, run in the Worker

Outline Stroke, Offset Path and Divide Objects Below (F-PATH-03), and later Pathfinder and `compound_shape` (F-BOOL-01..06), need robust path booleans and stroking that keep curves as curves. ADR-0001 names Skia PathOps. REQUIREMENTS §8 leaves open whether it comes through CanvasKit or a separately compiled PathOps build (#77).

## Decision

**`packages/geometry` wraps `pathkit-wasm` 1.0.0**: Skia's PathOps, stroker and simplifier compiled to WebAssembly (BSD-3-Clause, the same code CanvasKit ships).

- **It runs in the Worker, in the Document Durable Object.** Path commands are core edits the Durable Object commits, and the browser does not apply edits locally (ADR-0010). The web app does not import `packages/geometry`. If it did, the Vite build would already fail on the `.wasm` import; `check:bundle` also greps the web bundle for PathKit, as a backstop for `pathkit.js`. If a browser preview later needs the geometry (the Offset Path dialog's Preview, a `compound_shape` recomputed during a drag), the same package loads there as a lazy chunk of about 147 KB gzipped. That change updates this ADR and `check:bundle`.
- **Loading.** The `.wasm` is imported statically and passed to Emscripten's `instantiateWasm` hook, as `render` does for resvg. Workers refuse to compile WebAssembly from bytes. The module is instantiated on the first geometry call, not at import, because its heap starts at 32 MiB of the isolate's 128 MB.
- **Interface.** `Segment[]` in and `Segment[]` out, in core's absolute M, L, C, Q and Z. Skia emits quadratics, which stay `Q`. Round joins and caps come out as conics, which become cubics (`4w / 3(1 + w)` along each handle, which gives the usual 0.5523 for a quarter circle). When Skia reports a failure, the op throws `BOOLEAN_FAILED` (F-MCP-15) rather than returning bad geometry (F-BOOL-06).
- **Offset Path** is the op wired first. For a positive distance it is the fill united with a stroke of twice the distance, and for a negative one the fill minus that stroke, with the join and miter limit passed through. Illustrator's Offset Path has the same parameters. A zero distance returns the path unchanged. Offset on an open path is unspecified for now: the input is filled as if closed.

## Measurements

The fixtures are two overlapping circles (four cubics each) united, two squares sharing an edge, the same squares 1e-7 apart, a circle offset by ±10, a ten-point star offset by +5 with miter joins, an open S-curve outlined 10 wide, and a self-intersecting figure 8. Sizes are for the files that would ship. Gzip is `gzip -9`. The Node times are from Node 24.

| Option | Version, date | License | Ships (raw / gzip) | Initial wasm memory | In workerd | Fixtures |
|---|---|---|---|---|---|---|
| **`pathkit-wasm`** | 1.0.0, 2022-02-03 | BSD-3 | 324 KB + 33 KB JS / 135 KB + 12 KB | 32 MiB | runs through `instantiateWasm` | all correct, see below |
| `canvaskit-wasm` | 0.42.0, 2026-08-18 | BSD-3 | 7.32 MB + 121 KB JS / 2.94 MB + 37 KB | **128 MiB** | fails: its loader has no `instantiateWasm` hook and reads the `.wasm` through `node:fs` under `nodejs_compat` | the same output as PathKit, at float precision |
| `clipper2-wasm` | 0.4.0, 2026-05-18 | BSL-1.0 | 214 KB + 54 KB JS / 82 KB + 14 KB | 16 MiB | fails: embind builds invokers with `new Function`, which workerd forbids | polylines only, so every curve needs refitting |
| `paper` + `paperjs-offset` | 0.12.18, 2024-07-17; 2.2.1 | MIT | 208 KB + 59 KB / 70 KB + 12 KB | none (JS) | runs | 1e-7 squares stay two rectangles; the figure 8 is not resolved; the S-curve outline has two contours and a degenerate segment |
| `path-bool` (PathBool.js) | 1.0.4, 2026-09-09 | MIT | 501 KB unpacked | none (JS) | not tried | booleans only, no stroke or offset; README says "early stages" |

PathKit on the fixtures:

- The union of the circles is one contour of 8 cubics.
- Both pairs of squares, touching and 1e-7 apart, unite into one rectangle.
- The circle offset by +10 and by −10 is 8 quadratics. Its bounds are exact at `d`'s 3 decimals.
- The star offset has 10 correct miters (the top tip at y = −16.68), plus one collinear point where the contour starts.
- The S-curve outline is one contour of 16 quadratics and 2 lines.
- The figure 8 simplifies into its two lobes.
- In Node, loading PathKit and running all eight fixtures takes 11 ms. Compiling the wasm takes 1 ms and instantiating it 7 ms. CanvasKit takes 12 ms to compile and 47 ms to instantiate.

## Considered Options

- **CanvasKit's `Path.makeStroked` and `Path.MakeFromOp`.** CanvasKit is maintained and gives the same geometry, and Skia recommends it since removing PathKit. But its module declares 128 MiB of initial memory, which is the whole isolate, and its loader cannot take a precompiled module, so it cannot run in a Worker. For a browser that only needs geometry it is also 22 times larger. It stays the Render V2 candidate for the browser (REQUIREMENTS §8), where geometry would come with it.
- **A fresh PathOps WASM build.** Emscripten with Skia's `src/pathops` and `SkStroke`, which are still maintained (a PathOps commit landed on 2026-09-18). Skia deleted PathKit's build and bindings on 2025-10-21, so this means a Skia checkout, our own bindings and a pinned emsdk in CI. That is kept as the upgrade path behind the same `Segment[]` interface, for when PathKit's frozen 2022 PathOps shows a bug that upstream has fixed, or float64 becomes necessary.
- **Clipper2 plus curve refitting.** It is robust on polygons, but it cannot load in workerd, and flattening then refitting turns a circle's four cubics into an approximation with more Anchors and a tolerance.
- **Paper.js with `paperjs-offset`.** It keeps curves as cubics and runs in workerd, but it fails three of the fixtures. REQUIREMENTS §2 already notes its long-standing edge-case bugs (ADR-0001), and its last release was 2024.
- **A TypeScript port (PathBool.js), `bezier-js`, `flatten-js`, `martinez`, `polygon-clipping`.** PathBool.js has booleans but no stroker. `bezier-js` offsets single curves without resolving overlaps. `flatten-js` handles only lines and arcs. `martinez` and `polygon-clipping` handle only polygons. None of them covers Outline Stroke and Offset Path.

## Consequences

- PathKit computes in float32. A coordinate stays within 0.0005 pt, so exact at `d`'s 3 decimals, up to ±4,096 pt, and within 0.001 pt up to ±16,384 pt, about Illustrator's largest canvas. Far from the origin the third decimal can be off by one. This is the first gap in "geometry in float64" (REQUIREMENTS §7), and a reason for the fresh build if it matters.
- `pathkit-wasm` will get no more releases. A PathOps bug we hit is worked around in `packages/geometry` or triggers the fresh build described above, and the version stays pinned.
- Output has more Anchors than Illustrator's: Skia approximates an offset circle with 8 quadratics where Illustrator uses 4 cubics, and contours can keep a collinear point. Simplify (F-PATH-03) or a later refit can reduce them. The geometry itself is correct.
- `BOOLEAN_FAILED` is added to core's error codes. It does not yet carry the geometric diagnostics F-MCP-15 asks for, only a message and a hint.
- The Worker bundle grows by 357 KB once `apps/edge` imports `packages/geometry`, well under the 64 MiB limit (research 04). An isolate that runs a geometry op holds PathKit's 32 MiB heap next to resvg's.
- NOTICE lists PathKit.
