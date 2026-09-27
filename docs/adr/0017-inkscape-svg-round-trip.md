---
status: accepted
date: 2026-09-24
---

# SVG is the editing round trip, and Inkscape is the editor it targets

Import and export are core features: a designer takes what an Agent drew, finishes it in a desktop editor and brings it back (#24). The editor is **Inkscape**. Its native format is SVG with the `inkscape:` and `sodipodi:` namespaces, so Zibel can write a file Inkscape treats as its own, and its CLI lets us test the round trip. Native `.ai` stays a non-goal (§1.4); an `.ai` saved PDF-compatible reaches Zibel by opening it in Inkscape and saving SVG.

## What "complete" means

Zibel's model is the source of truth. Everything a Document can hold survives **Zibel → Inkscape → edit → Zibel** structurally: Layers with names, visibility and lock; Artboards; Live Shape parameters; text and font names; Appearance; opacity and blend mode; `tags` and `meta`.

When a designer uses something in Inkscape that Zibel cannot represent, that is a gap in Zibel, and Zibel gains it. This covers model features (gradients (ADR-0026), compound paths with fill rule, clipping masks, images, multi-line text) and Inkscape's shape parameters: a star's or polygon's `rounded`, `randomized` and twist (`arg2 − arg1 ≠ π / points`; ADR-0024), an ellipse's start and end angles with slice, chord and open arc types (ADR-0025), and Inkscape's spiral parameters when the spiral Live Shape arrives. #24 closes only when those exist. Until one lands, its content imports as a Path or solid Fill with a warning.

What Zibel will not model imports as its visible geometry with one warning per kind: Live Path Effects (their output `d`, not `inkscape:original-d`), `flowRoot`, 3D boxes, and SVG filters until Effects exist (F-APP-10). F-IO-01's "keep unsupported elements as raw XML fragments" is dropped: an opaque node type would be unreadable by Agents and undrawable by Canvas2D, and every feature it would carry is on the roadmap.

Every new node type or Appearance feature ships with its SVG export mapping, its import mapping and a round-trip fixture, in the same issue.

## One serializer, written in Inkscape's dialect

`toSvg` has one output, used by `render` and by `export`. The editable form renders to the same pixels as today's, and browsers and resvg ignore the editor namespaces, so there is no plain flavour and no mode. A plain export can become an F-IO-06 option when someone needs one.

| Zibel | SVG |
|---|---|
| Document | root `viewBox` is the export's first page and `width`/`height` are the same numbers in `pt`, so one user unit is one pt: at doc scope the frame of the Artboard at (0,0), else of the first Artboard, at artboard scope that Artboard's, at nodes or rect scope the scope's rect (below). `xmlns:zibel="https://zibel.dev/ns/svg"`; `zibel:doc` (docId), `zibel:rev` (the exported rev) and `zibel:scope` (`doc`, `artboard:<id>`, `nodes:<id,…>` or `rect:<x,y,w,h>`) |
| Artboard | `<inkscape:page x y width height id="z-<id>" inkscape:label>` in `<sodipodi:namedview inkscape:document-units="pt">`, user units. A doc-scope file lists every Artboard, an artboard-scope file only its own, a nodes- or rect-scope file none, so its viewport is its only page. Inkscape has no per-page background, so a background is a locked `<rect zibel:artboard="<id>">` that import turns back into the Artboard's `background` |
| Layer | `<g inkscape:groupmode="layer" inkscape:label>` |
| Any Node | `id="z-<ULID>"` (an XML id cannot start with a digit); name → `inkscape:label`; hidden → `style="display:none"`, written, not dropped; locked → `sodipodi:insensitive="true"`; `opacity` and `mix-blend-mode` in `style`; `tags` and `meta` as JSON → `zibel:tags`, `zibel:meta`, each left out when empty |
| Leaf with ≤ 1 Fill and ≤ 1 Stroke | one element with both `fill` and `stroke`; no Fill is `fill="none"`, so an empty Appearance is still an element |
| Appearance stack | a `<g zibel:stack="true">` of paints, read back as one Node; the paints carry no id |
| Container Appearance | `<g zibel:paint>` groups of outline copies inside the container's `<g>`, around its children (ADR-0043) |
| Colour with alpha | `fill="#RRGGBB" fill-opacity`, `stroke="#RRGGBB" stroke-opacity`, likewise Artboard and render backgrounds, opacity at 3 decimals, which recovers every alpha byte: Inkscape 1.2 draws `#RRGGBBAA` as black. Import reads both forms |
| `rect`, `ellipse`, `line` | `<rect rx ry>` (the clamped radius, left out at 0), `<circle>` when width equals height, else `<ellipse>`, `<line>`. An ellipse with other than the default angles and arc type is `<path sodipodi:type="arc">` with `sodipodi:cx/cy/rx/ry/start/end/arc-type` and a `d` that matches them (ADR-0025) |
| `polygon`, `star` | `<path sodipodi:type="star">` with `sodipodi:sides/cx/cy/r1/r2/arg1/arg2`, `inkscape:flatsided/rounded/randomized` and a `d` that matches them, because Inkscape rebuilds the shape from the parameters on load. `arg1 = −π/2` (first vertex up, radians, clockwise) plus `angle`, and `arg2 = arg1 + π/sides` plus `twist`, at full precision; a polygon is `flatsided="true"` with `r2` its inradius; `rounded` and `randomized` as set (amended by ADR-0024) |
| `text` | `<text>` with the Node's `fontFamily`; lines, Area Type and `leading` per ADR-0022 |

**Why the `viewBox` is the first page** (checked headless on Inkscape 1.2.2, #25). Page `x`/`y` are absolute user units, like element coordinates. But Inkscape binds the page at literal (0,0) to the root viewport and rewrites its width and height to the `viewBox`'s on save, whatever the `viewBox` origin; with no page at (0,0) it rewrites none. With `viewBox = docRect` and Artboard 1 at (0,0), the default layout, every Document with two Artboards would lose Artboard 1's size on the first save. So at doc scope the `viewBox` is the Artboard at (0,0), whose page Inkscape resizes to itself, or, when no Artboard sits there, the first Artboard, and no page is rewritten; the pages come back as written. This is Inkscape's own multi-page layout. A doc-scope SVG therefore shows only that Artboard in a browser; `render` and PNG `export` still cover every Artboard (ADR-0014), since they pass their own rect. Inkscape writes the viewport page's height as `200.00002` for 200 pt, px-to-pt roundoff that Replace's 3-decimal rounding absorbs. With a non-zero `viewBox` origin, 1.2.2's multi-page PDF export assigns items to pages in another space than it draws them in; the SVG it saves is unaffected.

resvg reads the root's `pt` at 72 dpi, so it still draws one pixel per point at scale 1. Native `<rect rx>`, `<circle>` and `<ellipse>` draw the exact outline, where the `<path>` written before rounded its control points to 3 decimals, so the change moved a few antialiased edge pixels once (3 pixels by at most 16/255 on the fixture Document at 1x).

Inkscape keeps unknown-namespace attributes, `data-*` and existing ids on save, which is what makes the `zibel:` attributes and the id mapping hold. Its XML tree is its model (`src/xml/repr-io.cpp`), unknown elements are kept as XML (`src/object/sp-factory.cpp`), ids are kept unless they clash (`src/object/sp-object.cpp`), and the default preference `incorrect_attributes_remove` is 0 (`src/preferences-skeleton.h`), per Inkscape 1.4.x.

## Import

- **Parser:** `@xmldom/xmldom` (MIT, no dependencies, `getAttributeNS`). It does not expand DTD entities and never fetches, so entity bombs and external entities cannot happen. Sanitising strips `<script>`, event attributes and `foreignObject` and caps data URLs (§7.5). A file that is not well-formed XML or has no `<svg>` root is `INVALID_DOCUMENT`, with `path` locating the element, as for `.zibel.json` (ADR-0016). saxes, sax and linkedom fail the licence list (§8.4); HTMLRewriter builds no tree.
- **Paths** normalise to absolute `M L C Q Z` in `core/path.ts`, next to `parsePath`: relative commands and `H V S T` fold, `A` becomes cubics. `node_create` still accepts only canonical `d`.
- **Transforms.** Inkscape keeps `transform` on a moved `<g>`. A Layer or Group never carries a matrix (ADR-0007), so ancestor transforms compose into each leaf. Inkscape's default "optimized" transforms also bake a move into `x`/`d`; import takes those values as they are.
- **Styles:** presentation attributes, `style`, `<style>` classes and inheritance resolve to Appearance; any CSS colour converts to `#RRGGBB[AA]`, folding `fill-opacity` and `stroke-opacity` into alpha. Units convert to pt from the root `width`/`height` and `viewBox` (Inkscape defaults to mm).
- **Structure:** `inkscape:groupmode="layer"` → Layer, other `<g>` → Group; `<inkscape:page>`, else the root `viewBox`, → Artboards; `sodipodi:insensitive` with any value → locked.
- **Stars:** `arg1`, `arg2`, `rounded` and `randomized` map to `angle`, `twist`, `rounded` and `randomized`, and a randomized star is neither baked nor rounded (ADR-0024, which replaced folding `arg1 ≠ −π/2` into `transform`). `sodipodi:type="arc"` maps to the ellipse's `startAngle`, `endAngle` and `arcType` (ADR-0025).
- **Ids:** `z-<ULID>` maps back to that Node. Any other id (Inkscape gives new and duplicated objects ids like `path123`) is a new Node with a new ULID. A `<g zibel:stack>` the designer ungrouped comes back as separate Nodes.
- **Text:** `<text>` with `<tspan sodipodi:role="line">` → Text. The font name is kept whatever it is (below).

The importer (`packages/io`, #26) settles the rest:

- **Size.** An SVG over 5 MB, counted as 5 × 1024 × 1024 UTF-16 code units (`content.length`), is `LIMIT_EXCEEDED` before parsing; Replace and Place measure the same way. ADR-0023 excludes the text of `data:` URLs from the count and caps each embedded image instead. `.zibel.json` stays uncapped (ADR-0016). Layers and Groups nested deeper than 256 levels are `LIMIT_EXCEEDED` too: the walk and core's own walks recurse.
- **Units.** px and unitless lengths are one pt, as Illustrator opens SVG; Inkscape's 96 dpi (0.75 pt per px) is not followed. User units scale by root `width` ÷ `viewBox` width; the `viewBox` origin is not subtracted, so a Zibel export's coordinates come back unchanged. Lengths with units inside the file (`stroke-width="1mm"`) convert by the same table.
- **Baking.** A leaf's composed matrix (ancestors, root scale, its own) that is a move plus a uniform scale bakes into its parameters, Stroke widths and dashes, leaving `transform` identity. The test allows a writer's rounding (#110): with `s` = √|det|, the matrix passes ADR-0043's similarity test, `|b|` and `|c|` are each below 1e-6 × `s`, and `a` and `d` are positive, so a turn, flip, skew or uneven scale a person could enter in Illustrator keeps its matrix. ADR-0043 gives the reason for 1e-6. The baked scale is `s` and the move is `e`, `f`. Any other matrix is stored at 6 decimals with the parameters in the leaf's own units. Numbers round to 3 decimals, which also absorbs Inkscape's `200.00002`. Export writes matrices at the 6 decimals they are stored in, so a turned Node opens with its own matrix. A container's Stroke does not bake: it scales by √|det| of its composed matrix under any transform (ADR-0043).
- **SVG defaults, not Zibel's.** An unstated `fill` is black and `stroke` none; an unstated `stroke-miterlimit` is SVG's 4 for a miter join, where it shows, and Zibel's 10 for other joins. The cascade is inherited value, presentation attribute, `<style>` rule (simple selectors only), `style` attribute.
- **Structure.** Content at the root outside any layer goes into one Layer named `Layer 1`, made where the first such element appears; a file with no content still gets it. A layer group inside a Group is a Group. Sibling indexes are `a0, a1, …` in document order, as `node_create` gives them.
- **Markers.** A `<rect zibel:artboard>` sets that Artboard's background only when the page is in the file, and is never a Node. Export marks the `background` option's rect `zibel:background="true"`, and import drops it.
- **Name.** The file name (browser Open), else `sodipodi:docname` without `.svg`, which export now writes, else the root `<title>`, else `Untitled`.
- **Stacks.** A `<g zibel:stack>` is one Node: its id, name, lock, tags, meta, opacity and blend from the `<g>`, its geometry from the first paint, then every Fill, then every Stroke, in order.
- **Container Appearance.** A Layer's or Group's `<g zibel:paint>` children are its Fills and Strokes, and the copies inside are ignored (ADR-0043).
- **Text.** A `<text>` is one Node, its lines joined (ADR-0022, which superseded one Node per line tspan). Whitespace collapses unless `xml:space="preserve"`. The first family of `font-family` is kept, unquoted; `text-anchor` middle or end moves `x` by the measured width.
- **Warnings** are `{code, nodeId?, message}`, once per kind: `UNSUPPORTED_ELEMENT` (per tag), `UNSUPPORTED_ATTRIBUTE` (per property: `clip-path` where ADR-0021 cannot hold it, `mask`, `filter`, markers; `fill-rule` is kept since ADR-0018), `PATH_EFFECT_FLATTENED`, `BOX3D_AS_PATHS`, `UNSUPPORTED_PAINT`, `STAR_AS_PATH`, `ARC_AS_PATH`, `DUPLICATE_ID`, `INVALID_TAGS_META`, `INVALID_PATH` (the element is dropped), `INVALID_TRANSFORM` (an unreadable transform is ignored, one that scales to nothing drops the element) and `FONT_MISSING` (per font). `clip-path`, `mask` and `filter` warn on a Layer or Group as on a leaf.
- **Checked like a file.** The importer's result goes through the `.zibel.json` validator before the Durable Object sees it, so an importer bug fails the Open instead of storing a corrupt Document.

## Three ways in

> Replace is removed by ADR-0030: an edited file comes back through Open, into a new tab, and art moves between Documents by copy and paste. The Replace rows and steps below, the 30-day Delta Log and `zibel:doc` / `zibel:rev` describe what was.

| | Illustrator | Tool | Result |
|---|---|---|---|
| **Open** | File > Open | `doc_open(content)`, SVG or `.zibel.json` detected by content | a new Document; SVG Layers and pages become Layers and Artboards; ids from `z-` kept |
| **Replace** | — | `doc_replace(docId, content, baseRev?, ifRev?, intent?)`, SVG or `.zibel.json` | the same Document updated by a three-way merge, one undoable Transaction of the calling Actor |
| **Place** | File > Place, paste | `svg_import(docId, svg, parentId, position?, fit?)` | one Group under `parentId`; SVG Layers become Groups, pages are ignored, all ids are new |

**Replace** is the round trip's main path, because a designer may work for an hour while Agents keep writing. It accepts a file only when it came from this Document: an SVG whose `zibel:doc` is this docId, or a `.zibel.json` (which carries no docId, ADR-0016; its ids must overlap the Document's). Any other file is refused as `INVALID_DOCUMENT` with a hint to Open or Place it, because replacing with it would delete every Node in scope.

1. **Base.** `baseRev`, else the SVG's `zibel:rev`. The Document at that rev is rebuilt by applying, newest first, the inverse delta of every Transaction committed since. That needs a delta for **every** rev, not only for those on the undo and redo stacks, which today lose their deltas on undo and on redo-clear (ADR-0011). So every committed Transaction's delta is kept in a rev-indexed log independent of the stacks, pruned only when older than 30 days; the stacks keep their 200-entry limit and point into it. This supersedes ADR-0011's "older ones drop off with their delta rows".
2. **Normalise the base** by exporting it with the file's `zibel:scope` and importing that, and compare the file with the result, not with the raw base. Both sides are then rounded to export precision (3 decimals; `d` compared as parsed, rounded segments) before the per-property diff: export rounds, Inkscape rewrites `d` in relative form at its own precision, and re-absolutising reintroduces float error, so without this every Path would look edited.
3. **Apply only what the file changed** onto the current Document. Deletions are confined to the Nodes the scoped export of the base contained, so a file exported from one Artboard can never delete Nodes elsewhere. A property both sides changed takes the file's value; a Node deleted in the Document since the base stays deleted and is reported (ADR-0004: per-property last writer wins, delete beats edit). Artboards merge the same way once Artboard edits exist and are logged (F-VIEW-06); until then they are compared with the current Document.
4. **Fallback.** No base (a `.zibel.json` without `baseRev`, or a log pruned past the base): compare the file with the current Document exported at the same scope, and warn that concurrent edits in that scope may be overwritten.

**Place** (#29) reads the SVG as Open does, with the same 5 MB cap and warnings; a `.zibel.json` is `INVALID_DOCUMENT`, since its Nodes can be written with `node_create` or opened. Every Layer becomes a Group that keeps its name, visibility, lock, opacity, blend, tags and meta. Every Node gets a new ULID, `z-` ids included, so placing a file twice, or placing a file exported from the same Document, never collides. Artboards and page backgrounds are dropped. The file's top-level Layers go, in order, into one new Group, named as Open would name the Document and stacked above `parentId`'s children; `parentId` follows `node_create`'s rule.

- **`position: {x, y}`** is where the centre of the Group's geometric bounds lands, in document coordinates. Default: the centre of the parent's Artboard, the one the parent's geometric bounds overlap most, else the first Artboard. Illustrator's Place and paste centre the art in the view; an MCP call has no view, and the Artboard is where an Agent draws.
- **`fit: true`** first scales the Group uniformly, Strokes included, so its geometric bounds fit inside the parent's Artboard, up or down. Default false: the file's size in pt is kept. The move and the scale compose into each leaf, like `node_transform` (ADR-0007).
- A file with no content places an empty Group where it is.
- One Transaction. The receipt's `createdIds` start with the Group, and `nodes` is its outline to depth 2.

In the browser, paste (text starting with `<`, as `text/plain` or `image/svg+xml`) and dropping an `.svg` file on the canvas Place with `position` at the centre of the canvas and no `fit`. The parent is the nearest Layer holding the first selected Node, else the top Layer, which is the top of the Layers panel. A dropped file passes its name.

Browser: Open, Replace and Place send the file over HTTP to the Worker, which parses it with the same code the MCP tools use and hands the Document model to the Durable Object, as `doc_open` already does (ADR-0016). They are not WebSocket Commands (ADR-0010): a 5 MB file does not belong in a gesture message. They run as the User Actor. The toolbar gets "Download SVG" beside the `.zibel.json` download and "Update from file…" (Replace); the Document list gets "Open file" (`.svg`, `.zibel.json`); dropping an SVG on the canvas or pasting SVG text is Place, at the viewport centre. Replace is only ever an explicit button.

## Fonts

`fontFamily` becomes any string, kept as written. A family Zibel does not have renders in the bundled font (ADR-0013), on the canvas as in `render`, with a `FONT_MISSING` warning on `node_create`, `node_update` and Open, and export writes the original name back, so the file shows the right font in Inkscape (F-TEXT-11, the "record the original name" part). Font upload and embedding are separate work.

## Testing

`pnpm roundtrip` (#27): for each Document in `fixtures/documents/`, export SVG through a local Worker, re-save it with `inkscape --export-type=svg` (Inkscape SVG), Open the result, and check that it has no warnings and that its `.zibel.json` equals the original's field by field: name, Artboards, every Node by id (type, parameters, `d`, name, visibility, lock, tags, meta, Appearance, font) and each parent's child order. It prints the first difference, such as `nodes[<id>].locked: false, want true`. Both files are named after the Document, because Inkscape writes `sodipodi:docname` from the file it read.

The pixel check compares resvg's PNG of the whole Document with Inkscape's PNG of a rect-scope export of the same rect, drawn with `-C -d 72` so one pt is one pixel (`--export-area` takes px, not user units). Both are on opaque white, since transparent pixels carry different RGB in the two renderers. A pixel differs when a channel differs by more than 32/255. Inkscape draws text in the bundled Source Sans 3 through a `FONTCONFIG_FILE`.

Differing pixels are counted by region, built from the Document resvg draws (the original, or the reopened edit), with no per-fixture configuration (#113). Each pixel belongs to the first Artboard in Document order that holds it, or to "outside Artboards". There it is in the text region of a drawn text or Image when it lies in that Node's `visibleBounds`, grown by 2 pt for antialiasing and by half the widest Stroke on the Node or on a container above it (a container Stroke outlines the text's glyphs), scaled by that container's matrix. Every other pixel is in the Artboard's vector region. A case fails when any region's differing pixels exceed its budget as a share of its area:

- **Vector: 0.7%**, twice the worst baseline, 0.35% on Stars with no edit. A 15 × 15 pt shape is over 1% of a 120 × 120 pt Artboard.
- **Text and Image: 15%.** The worst baseline is 8.7%, on the two-line Point Type "Point" / "Type". Hinting and antialiasing differ by about 19 px per small glyph, and a region grows with its glyphs, so a longer text costs no budget. Twice the baseline (17%) would let a hidden "Italic" (16.7%) through.
- A missing link's frame is in no region: Inkscape draws its own broken-image icon where Zibel draws a crossed frame (ADR-0042).

One text region per Artboard, the union of its texts, was measured and rejected: hiding a whole word on a crowded Artboard (Bold, Italic, Spin, "Round & trip") stayed under a 10% budget, because one word is a small share of all the text there. Per-glyph budgets were rejected too, because the region's area already grows with its glyphs.

Each case prints its worst region against its budget, or every region over budget as `<Artboard> <vector|text> [<text>] <n> px of <area> (<share> of <budget>)`, and writes `diff.png` beside `resvg.png` and `inkscape.png`: differing pixels in magenta over a faded copy of resvg's.

Two sensitivity probes keep the budgets honest: a 6-point star of 12 pt radius on Stars, and the one-word text "Bold" on Type. For each, resvg draws a copy of the Document with the probe hidden, and it is checked against Inkscape's no-edit PNG with the original's regions. The run fails unless the probe's own region goes over budget (measured: star 2.04% of 0.7%, Bold 31.8% of 15%). A looser budget, or a fixture change that buries a probe, fails `pnpm roundtrip`.

The check sees what resvg and Inkscape draw differently from the same file: `#RRGGBBAA` stops (Gradients vector 21%), or Inkscape falling back from the bundled font (every text region). A writer regression that both renderers draw the same way, such as dropping a container's paint copies of text, is seen only by the structural check when Open reads it back differently, and otherwise by the `io` write tests and `fixtures/compositing.ts`. Dropping `font-kerning:none` is not detected: Source Sans 3 kerning at these sizes stays within antialiasing.

The edit target of the edit passes has no painted ancestor. Export draws a container's Appearance as copies of its descendants (ADR-0043), and Inkscape transforms only the edited Group's `<g>`, so a painted ancestor's copies would stay where the Group was, while resvg draws the reopened Document with them redrawn where it went. That cost about 800 px per edit case (#113). The nested case, a painted Group in a painted Layer, stays covered by the `Area` Group.

It needs Inkscape ≥ 1.2 (Ubuntu 24.04 ships 1.2.2) and Node, so it runs outside `pnpm check`: locally, skipping when `inkscape` is missing, and as its own CI job.

Inkscape is GPL. It is only an external program here: no Inkscape source is copied or ported. Its shape formulas (star rounding, randomisation) are implemented from its documentation and observed output, and the round-trip check is what proves they match.

## Considered Options

- **Illustrator as the editor.** Its native format is private (AIPrivateData inside a PDF container, no public spec), so the round trip would go through SVG or PDF and lose Layers on the way, and nothing could test it in CI.
- **Two SVG flavours, or a render mode on `toSvg`.** Unneeded, because the editable form renders identically.
- **Raw XML fragments for unsupported content.** Rejected above.
- **Downgrade what Zibel lacks** (gradient → solid, drop rounding). Loses the designer's work; the user ruled that such losses are Zibel's gaps to close.
- **Open only, or Replace by overwriting.** Open gives a new docId, so Agents lose the Document they were working on; overwriting drops what Agents wrote meanwhile.
- **fast-xml-parser, txml, htmlparser2.** fast-xml-parser does not decode numeric character references by default and needs order-preserving options; txml decodes nothing and trims whitespace; htmlparser2 brings four dependencies. xmldom gives a standard DOM with namespaces and safe entity handling.

## Consequences

- MCP surface: `doc_open` accepts SVG; `doc_replace` and `svg_import` are new. `svg_import` is capped at 5 MB (§6.7).
- ADR-0013's one-font rule now holds for rendering only; the schema keeps any `fontFamily`. ADR-0013's "one `<text>` per Fill, then one per Stroke" gives way to the one-element rule above for a single Fill and Stroke.
- ADR-0011's deltas are kept for every rev for 30 days, not only for the 200 on the stacks: storage grows with edit volume rather than staying bounded by stack depth.
- `INVALID_DOCUMENT` now also covers SVG (F-MCP-15).
- New dependency `@xmldom/xmldom` in a new `packages/io`.
- After an Inkscape save, elements Zibel wrote without an id carry Inkscape's auto ids; import ignores them unless they are the only id on a new object.
- A moved object may come back with new `x`/`d` and identity `transform`; `doc_changes` shows both properties changed, which is what happened.
- F-IO-01, F-IO-03, F-IO-04, F-IO-05, F-IO-06, F-DRAW-01, F-DRAW-03, F-TEXT-11, §6.4, §7.2, §9 and Appendix A change to match (REQUIREMENTS decision 38).
