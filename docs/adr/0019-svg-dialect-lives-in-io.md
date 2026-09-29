---
status: accepted
date: 2026-09-24
---

# The Inkscape SVG dialect lives in `packages/io`, writer and reader together

ADR-0017 fixed one SVG dialect for export and import. The writer landed in `packages/render` (`toSvg`) and the reader in `packages/io` (`parseSvg`). The two packages depend only on `core`, so every mapping rule has two halves that share nothing: the `kalamo:` namespace string, the `z-<ULID>` id mapping, `kalamo:scope`, star `arg1`/`arg2`/`r2`, colour alpha as `fill-opacity`, stroke defaults, and the `kalamo:stack` / `kalamo:artboard` / `kalamo:background` markers. Adding `fillRule` (#30) took one commit in each package. io's tests paste render's output in as literals, and they keep passing when render changes. Replace's normalising round trip, `parseSvg(toSvg(…))`, sits in the Document Durable Object only because neither package can import the other (#45).

**`packages/io` owns the dialect**: writing, reading, and the normalising round trip Replace compares against (ADR-0017 step 2).

- **One place per fact.** A shared module defines each fact of the dialect once and gives both directions: namespaces and marker names, id ↔ `z-` id, Render Scope ↔ `kalamo:scope`, star and polygon parameters ↔ `sodipodi:` attributes, colour ↔ paint plus `-opacity`, stroke defaults. The writer and the reader import it, and neither restates it.
- **The writer stays light.** The writer and the shared module do not import `@xmldom/xmldom`. The writer is published as its own subpath export, so the browser's Download SVG (`apps/web`) does not bundle the XML parser.
- **`render` keeps drawing.** `render` depends on `io`, not the other way round, and writes its SVG with io's writer, so `render` and `export` still share one serializer (ADR-0017), with render's far-Node cull and far-layer bound (amended by ADR-0054 and ADR-0055). Render Overlays (ADR-0014) are a `render` concern. The dialect knows nothing about them, and `render` adds them to the SVG it gets from io. Rasterising (`svgToPng`, `fit`, `MAX_RENDER_SIDE`) and Canvas2D (`drawDocument`) stay in `render`.
- **One test surface.** io's tests write each Document in `fixtures/documents/` and read it back equal, in-process. These round-trip tests replace hand-copied export strings. `pnpm roundtrip` stays the check against the real Inkscape.

## Considered Options

- **A new `packages/svg`.** That would leave `io` with only `parseFile`, which is a format sniff and a size check: a shallow module. `io` already means import and export in REQUIREMENTS §8.
- **The reader moves into `render`.** `render` would gain xmldom, and its name would describe only half of what it did. The browser imports `render/canvas`, and every change to import would touch a package the browser depends on.
- **Keep the split and share only constants through `core`.** That fixes the duplicated strings, but not the rest: the inverse functions would still live apart, and the round trip would still have no home short of the Durable Object.

## Consequences

- Dependency order: `core` ← `io` ← `render`. `apps/edge` no longer composes the round trip: it calls io's `replaceFile` (#47), which holds `normalise`.
- REQUIREMENTS §8 (the package diagram and the tree) move "SVG 序列化" from `render` to `io`, and F-MCP-02's "core 的 SVG 序列化结果" becomes io's.
- Replace's merge rules can move beside the round trip they depend on (#47).
