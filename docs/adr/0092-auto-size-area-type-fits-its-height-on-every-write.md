---
status: accepted
date: 2026-10-02
---

# Auto Size Area Type fits its height on every write

ADR-0089 gave the receipt `lineBounds` so an Agent can write a frame's `height` back from its lines, and left Illustrator's Auto Size to #236. Writing the height back costs the Agent a second call after every edit that changes how many lines there are. Illustrator's Area Type Options > Auto Size keeps the frame's height on its lines instead, and turns off when the height is resized by hand. This ADR adds that flag to the `TextShape` of CONTEXT.md and REQUIREMENTS F-TEXT-04 and §6.5.

## Decision

1. **A stored flag on rectangular Area Type.** `TextShape` has an optional `autoSize`. Only rectangular Area Type takes it: Point Type and a shaped frame (ADR-0078) refuse it. Off is absent and never stored, as left alignment is (ADR-0077), so existing files need no migration.
2. **The height is stored, fitted on every write.** While `autoSize` is on, `storedAutoSize` in core sets `height` on create, on every `node_update`, on `.kalamo.json` Open and on SVG import, which Opens through `parseNode`. The fitted height is the smallest that shows every line the width allows: the lowest shown line's line box bottom, or its band bottom where the strut reaches lower. That is the bottom rule Convert to Area Type uses (ADR-0079), shared through `lineBoxes` and rounded up at the third decimal. A trailing empty paragraph adds nothing, since Area Type lays out no line for it. If no line shows, the frame is one line box at the Node's size and leading. Every reader (the canvas, export, `bounds`, hit testing) keeps reading the stored `height` and needs no change.
3. **What turns it on, keeps it and turns it off.** In `node_create`, rectangular Area Type with `autoSize: true` takes `x`, `y` and `width`; `height` beside it is `INVALID_INPUT` at `height`, and `autoSize` beside `frame` or `frameNodeId`, or on Point Type, is `INVALID_INPUT` at `autoSize`. In `node_update`:
   - `autoSize: true` turns it on and fits the height at once.
   - `autoSize: false` or `null` turns it off and keeps the height.
   - `height` turns it off and writes that height, as resizing the frame does in Illustrator.
   - `height` with `autoSize: true` is `INVALID_PATCH` at `height`.
   - Writing a `frame` path turns it off.
   - `autoSize` on Point Type or a shaped frame is `INVALID_PATCH` at `autoSize`.
   - Every other edit keeps it on and refits: `width`, content, character attributes, Character Ranges, `leading` and `alignment`.
   - Beside `kind` it is refused, as every `TextShape` key is (ADR-0079). Area to Point drops the flag, and Point to Area leaves it off.
4. **Transform, duplicate and undo.** `node_transform` changes only the Node's `transform`, so the flag and `height` stay. `node_duplicate` copies the flag. Undo and redo restore the stored Node, the flag and the height with it.
5. **The receipt adds nothing.** `bounds` is the fitted frame, and `lineBounds` (ADR-0089) is unchanged. `TEXT_OVERFLOW` still warns for a unit that no height can show, a word wider than a frame narrower than four line boxes (ADR-0084).
6. **SVG writes `kalamo:autosize`.** Export writes `kalamo:autosize="true"` on the `<text>`, beside the usual `shape-inside` `<rect>` at the fitted height, so Inkscape and every other reader draw the frame Kalamo stored. Import of a `<text>` with the attribute and a plain `<rect>` frame gives Auto Size Area Type and refits the height from the content, ignoring the rect's height, so text lengthened in Inkscape comes back with a frame that holds it. On any other text it warns `UNSUPPORTED_ATTRIBUTE` and is dropped.

## Considered Options

- **SVG 2 `inline-size`.** It wraps to a width with no height, which is Auto Size's shape, but Inkscape 1.2.2 writes and reads Area Type as `shape-inside`, and an `inline-size` text has no frame to select there. The fitted `<rect>` keeps Inkscape and resvg on one path with every other Area Type (ADR-0022).
- **A height derived on read.** Not storing `height` would keep it from going stale, but every reader of `height` (the canvas, `bounds`, hit testing, export, gradients that span the bounds) would have to lay the text out first. Fitting on every write keeps the stored Node the truth, and `parseNode` refits a stale file.
- **Auto Size off on a transform's scale.** A person who scales the frame in Illustrator resizes it, which turns Auto Size off. Kalamo's `node_transform` keeps parameters and composes the matrix (ADR-0007), so it never writes `height`. Turning the flag off without changing the height would surprise more than it explains.
- **Ignoring `height` silently.** Taking a `height` beside `autoSize: true` and dropping it would hide an Agent's mistake. The refusal names the key and says to drop one.

## How it was checked

`edit.test.ts` creates Auto Size Area Type at one size, with mixed Character Range sizes and a set leading, and with whitespace alone, each against Convert to Area Type's frame or line box sums. It refits on content, `fontSize`, `width`, Character Range, `leading` and `alignment` edits; turns off on `height`, `frame`, `false` and `null`; refuses each misuse at its key, writing nothing; drops the flag converting to Point Type; keeps it through `node_transform` and `node_duplicate`; warns `TEXT_OVERFLOW` for an over-wide unit; and refits a stale height on Open. `document-object.test.ts` undoes and redoes a refit at the Durable Object seam. `write.test.ts` round-trips an Auto Size Area Type through SVG, refits lengthened content on import, and warns on the attribute on Point Type and a shaped frame. The Inkscape fixture's Latin Breaks Artboard holds an Auto Size Area Type that `pnpm roundtrip` sends through Inkscape 1.2.2.
