---
status: accepted
date: 2026-09-30
---

# Area Type flows in any closed path, band by band as Inkscape lays out `shape-inside`

ADR-0022 gave Area Type a rectangular frame and left "Area Type in any closed path" for its own issue. On import, a `shape-inside` naming anything but an untransformed `<rect>` flowed in that shape's bounding box, with `UNSUPPORTED_ATTRIBUTE` `shape-inside` (#56, F-TEXT-01, F-TEXT-04). Illustrator's Area Type tool flows text in any closed path you click. Inkscape 1.2.2 flows it in whatever shape `shape-inside` names. This amends ADR-0022.

## The model

- **`frame`** on Area Type: SVG path data for a closed path in the text's own coordinates, every subpath closed with `Z`, its inside by the nonzero rule. The stored form is `formatPath`'s, to 3 decimals. With `frame`, the stored `x, y, width, height` are its bounds, also to 3 decimals, derived from the stored frame by one function (`shapedFrame`) whenever it is written, created, imported or read, so a saved file reads back unchanged. So `textBox`, `bounds` and everything that reads them are unchanged, and the bounds are the frame's, as Illustrator reports an area type object's. Without `frame`, Area Type is ADR-0022's rectangle and writes the same bytes as before, so Nodes and files need no migration. Point Type never has `frame`.
- **`node_create`** takes Area Type in one of three forms: `x, y, width, height` (the rectangle); `frame`; or `frameNodeId`. Passing `x`, `y`, `width` or `height` beside `frame` or `frameNodeId`, or both of those, is `INVALID_INPUT` at that key. Open or empty `frame` data is `INVALID_INPUT`, and malformed data is `INVALID_PATH`.
- **`frameNodeId`**, as Illustrator's Area Type tool clicks a path. It names an existing closed Live Shape or Path: a rect, ellipse, polygon, star, spiral, line or Path, the open ones among them refused below. The list is closed: any other Node type, including one added later, is refused until its issue decides otherwise. The text takes that Node's parent, stacking key and `transform`, and its outline becomes `frame`: a Path's `d`, or a Live Shape's `shapeSegments`. The Node is deleted with its Appearance, as Illustrator discards the path's paint, in the same Transaction. The receipt lists it in `deletedIds`, and undo restores it. `parentId` must be its parent.
- **Refused `frameNodeId`**, with nothing written:
  - a Layer, Group, text or Image;
  - an open outline: a line, a spiral, an ellipse with an open arc (ADR-0025), or a Path with an open subpath;
  - a Path whose `fillRule` is evenodd and where some region winds twice or more, such as a Compound Path whose hole winds the same way as its outline. Evenodd leaves the hole empty, but the frame's inside is nonzero, so the text would flow across it. An evenodd Path whose holes wind against its outline flows, because both rules give the same inside;
  - a Clipping Path. Kalamo has no Opacity Mask Node yet (F-MASK-02, M2; `CONTEXT.md` names the term only), so there is no mask to refuse. The issue that adds one refuses it here as a Clipping Path is;
  - a Node that is locked, itself or through an ancestor (the Area Type tool cannot click it either);
  - another parent;
  - a Node already consumed in the same call.

  Each is `INVALID_INPUT` at `frameNodeId` with a hint. An unknown id is `NODE_NOT_FOUND`.
- **`node_update`** writes `frame` on Area Type to reshape it, as Direct Selection on the frame does. On a shaped frame, `x`, `y`, `width` and `height` are `INVALID_PATCH`, with a hint to write `frame`. `frame: null` makes it the rectangle of its current bounds, after which they are writable again.

## The layout, measured

Measured headless on Inkscape 1.2.2 with the bundled Source Sans 3, as ADR-0022 measured the rectangle. The method was to save flowed text and read its line tspans, and to convert it to paths and query each glyph's box (`inkscape --query-all`):

- **Bands.** Line *k*'s baseline is ADR-0022's first baseline, `y + (leading − fontSize)/2 + fontSize · ascent`, plus *k* leadings, with `y` the frame's top. That is a text of one size: #200's amendment below sizes each band by its own line. Its band is ADR-0022's line box less a tenth of the leading at the top and at the bottom. At 12 px with line-height 1.2 that is 8.8098 above the baseline and 2.7102 below; at line-height 2 it is 12.6498 and 6.5502. Two frames with a slanted left edge measured it: a line starts where the edge is at its band's bottom (6.48 at baseline 10.2498) or at its top (199.28). On a rectangle the band is exactly ADR-0022's "shows while 90% of its leading fits" rule, which it therefore generalises.
- **Spans.** A band's spans are the maximal stretches the frame's inside covers across the whole band. Between the places where an edge crosses the band, the band is wholly inside or outside. Curves are flattened in 32 pieces per Bézier.
- **Filling.** Words fill a band's spans left to right, greedily at spaces and between CJK characters, with ADR-0022's width rules: trailing whitespace hangs, and tracking after the last character does not count (ADR-0029). Each span is its own `TextLine` with its own `x`. A U-frame's two arms each take their words, the right span from exactly `x` 200, as measured glyph by glyph.
- **Too narrow.** A span too narrow for the next word is skipped, and the word goes to the next span on the band. A band with no span it fits is skipped, and the next band is one of its leadings lower. Under a 5 pt notch 33.3 pt deep, the first line is on the fourth band, at 53.4498.
- **Hard returns.** A hard return ends the span: the next paragraph starts in the next span, on the same band if one is left. On a U-frame's arm band, a paragraph ending in the left span goes on in the right span.
- **Overflow.** What fits no band above the frame's bottom overflows. It is not drawn, and it warns `TEXT_OVERFLOW`, as before.
- **Alignment** (ADR-0077) aligns each line within its own span.
- **Circle.** Inkscape's lines on a circle carry the same words on the same bands. Its line starts are up to 0.56 pt inside Kalamo's near the top, where the circle is flattest, consistent with a coarser flattening than Kalamo's. A star's band broke one word differently, because Kalamo's unshaped width of "brown fox" (50.256 pt) exceeds the 49.896 pt span that Inkscape's shaped width fits: ADR-0013's known difference.

Inkscape writes its saved fallback as one tspan per band, joining a band's spans in one run from the first span's start, which draws the second span's words in the wrong place elsewhere. Kalamo writes one positioned tspan per span. The round trip compares a band's spans joined.

## Amendment (#200): each band sized by its own line

Every band used to be the Node's own size and leading tall, so a line holding a larger Character Range stepped as a line of the Node's size and overlapped the line above. Now each band steps and is sized as its own line, as Illustrator stacks a line in any frame by its own leading. Inkscape 1.2.2 settles what Illustrator's documentation leaves open. The evidence is in `docs/research/09-shaped-bands.md`.

- **Step.** A band's baseline is ADR-0080's: the first is ADR-0022's for the first band's size and leading, and each later one is the band's leading below the one before. With a set leading that is the Node's leading. With Auto it is 120 % of the largest size the band tried, below. `layoutText` uses the rectangle frame's stacking step, `stack`, for both.
- **Strip.** A band's spans come from its line box less a tenth of that box's height at its top and its bottom. The box reaches half the band's leading above and below the text's first family's em box at the band's largest size (ADR-0080), and at least as far below the baseline as the Node's own line box does. Inkscape's CSS line box holds the text's strut, which under a set leading reaches lower than a larger size's box: for 40 pt in a 20 pt text at leading 30, 25.16 above and 9.92 below, less 3.508 each. At Auto, and for a band of one size, the tenth is a tenth of the leading, as before.
- **Fit.** A band is first sized by its first unbreakable unit. Its spans take units greedily as before. When a unit it tries is larger than the band's size, the band is resized by it and refilled from its first unit, and this repeats until no unit it tries is larger. The unit that ends the band, the one that fits no span left, counts as tried. Inkscape sizes a line by a run as soon as it measures it, before it knows whether it fits, and keeps that size when the run moves to the next line. So a larger word that does not fit still makes the line before it taller: four 20 pt words that fit a 20 pt band are three once a 40 pt word after them sizes it. The size only grows, so the loop ends.
- **Skipping and overflow** are ADR-0078's, per band. A band with no span wide enough for its next unit is skipped one of its own leadings lower, the leading that unit gives it. What fits no band whose strip starts above the frame's bottom overflows and warns `TEXT_OVERFLOW`.
- **Unchanged.** Alignment within a span, hard returns and the SVG form. A text whose characters are all one size lays out exactly as before.

**Measured.** Inkscape 1.2.2 drew four frames (a U, a triangle, a slanted edge and a neck) with six texts under Auto and leading 30: a 40 pt heading, a 40 pt word third, fourth or fifth on a line, and `字` at 20 or 30 pt. In 46 of the 48 cases Kalamo puts the same words on every line. A baseline is Inkscape's until a taller line comes. Inkscape stacks each line box from the bottom of the one before. It keeps a line's top when a word makes it taller, and it skips a band by its line box, not its leading. So the following lines can sit up to one band apart there: a line after a taller one, a line that a larger Latin word makes taller, and a line after a band skipped under a set leading. That is ADR-0068's model difference, and in a triangle it changed one line's words at Auto. Inkscape's box for a larger CJK run under ADR-0080's run `line-height` is shorter below the baseline than a Source Sans 3 box of its size, 32.54 tall rather than 36 at 30 pt, so its band is wider in a narrowing frame. That changed one other line's words. A CJK line at the Node's size steps by the Node's leading in every frame.

**Considered.** Sizing a band by the characters it holds, not those it tries. That is closer to Illustrator's rule for the step, but it breaks lines where Inkscape does not whenever a larger word ends a line, and the round trip's line check would fail on them. Following Inkscape's line box for the step as well. Rejected, since ADR-0080 follows Illustrator.

## Everything that reads the frame

`worldSegments` returns a text's shaped frame instead of its rectangle. So a container's Appearance paints it as its outline (ADR-0043), a text Clipping Path's frame bounds its clip (ADR-0052), and hit tests and bounds follow. The canvas and `render` draw each line where `layoutText` puts it.

## SVG

- **Export.** A shaped frame writes `<defs><path id="area-z-<id>" d="…"/></defs>` just before the text, where the `<rect>` goes. `shape-inside` names it, and the rest of ADR-0022's Area Type row is unchanged. A rectangle frame still writes the `<rect>`.
- **Import.** A `shape-inside` naming a `<circle>`, `<ellipse>`, `<polygon>`, a `<polyline>` that ends where it starts, a `<path>` whose every subpath ends with `Z`, or a transformed `<rect>` imports as Area Type. A polyline cannot write `Z`, so ending at its first point is how it is closed. Its outline goes through the shape's own `transform` and the text's baked scale, and becomes `frame`, with no warning. A plain `<rect>` stays a rectangle frame. A missing reference, an open shape (an unclosed path or polyline, a `<line>`), an evenodd shape where some region winds twice (by the rule `frameNodeId` uses, read from the shape's own `fill-rule`), a `<use>` and a list of shapes still import as Point Type, with `UNSUPPORTED_ATTRIBUTE` `shape-inside`. Import and `frameNodeId` check the frame with the same function, so they accept the same shapes.

## Considered Options

- **A frame that references its source Node** instead of consuming it. Rejected: Illustrator turns the path into the frame and drops its paint, and a reference would dangle when the Node is deleted or edited.
- **Store only `frame` and derive the bounds on read.** Rejected: `textBox`, bounds and every caller already read `x, y, width, height`. Stored bounds keep them unchanged, and parsing the frame keeps them honest.
- **The band as the whole line box.** Rejected: Inkscape's band is 10% of the leading shorter at each end, measured on slanted frames and on the notch step. That is also the rectangle's measured 0.9 threshold.
- **A hard return starts the next band.** Rejected: Inkscape continues in the next span of the band.
- **One tspan per band, as Inkscape saves.** Rejected: renderers would draw the second span's words straight after the first's.
- **Close an open path with a straight line between its ends**, as Illustrator's Area Type tool does and as SVG fills an open path. Deferred: #56 refuses open outlines, both at `frameNodeId` and on import. Relaxing it changes both together, and a spiral or an open arc then becomes a frame.
- **Store the fill rule with the frame.** Rejected for now: nonzero alone keeps the layout's inside test and the exported `<path>` simple. An evenodd frame that would differ is refused rather than filled wrongly.
- **Illustrator's inset spacing, First Baseline options, threading and several shapes in one `shape-inside`.** Out of scope for #56.

## Consequences

- `TextShape` gains `frame`. The `node_create` text item gains `frameNodeId`, and takes `x` and `y` optionally for it. `createNodes` returns `deletedIds`, which the Durable Object's receipt carries.
- `layoutText` has a band and span branch for a shaped frame. The rectangle's branch is untouched, and its tests pass unchanged. Since #200 each band is sized by its line and stacked by the rectangle's step. Since ADR-0083 the rectangle lays out through the same filler, one span per band.
- `pnpm roundtrip` carries a Shaped Area Type Artboard, with Area Type in a circle and in a concave U-frame. Both come back from Inkscape 1.2.2 equal, `frame` included, and Inkscape's reflowed bands match the layout's. Each region is within the 15% text budget. #200 adds a Shaped Mixed Sizes Artboard: a U-frame with an 18 pt heading range and CJK in a 10 pt text, at 8.11 %, and a triangle at leading 14 with a 20 pt first line and CJK, at 2.28 %, of the 25 % `mixed-size text` budget.
- The browser has no Area Type tool yet; when it does, clicking a path will call the same core edit.
