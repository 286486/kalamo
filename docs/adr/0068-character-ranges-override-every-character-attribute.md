---
status: accepted
date: 2026-09-29
---

# Character Ranges override stroke, tracking, font style, family and size too

ADR-0029 let a Character Range override `fill`, `baselineShift` and `rotation`, and left the rest of Illustrator's Character panel on the Node. An Inkscape file that sets any other character attribute on part of a text imported it in the text's own value, with `UNSUPPORTED_ATTRIBUTE` (#67). Per #24 that is a Kalamo gap to close. Illustrator's Character panel sets every one of these per character, and Inkscape writes them on tspans inside a line. This ADR amends ADR-0029's model, layout, drawing and import sections, and ADR-0028's "the style of a range arrives with runs".

## The model

A Character Range is `{start, end, fill?, stroke?, baselineShift?, rotation?}`, as ADR-0029 describes it, plus the overrides below. The later range still wins attribute by attribute, and ranges are still stored sorted, not overlapping, and with adjacent equal runs merged.

- **`stroke`** is a colour, `#RRGGBB` or `#RRGGBBAA`, parsed as range `fill` is. For these characters it replaces the paint of every Stroke in the text's Appearance. The Stroke's width, dash and joins do not change. A text with no Stroke draws none, whatever its ranges say. The name mirrors range `fill` and Illustrator's character stroke colour. A text that becomes a Clipping Path loses its range strokes with its range fills (ADR-0052, `unfilledRanges`).

**An override equal to the Node's own value is no override.** For the overrides that repeat a Node attribute (tracking, font style, family and size, below), `canonicalRanges` drops a value equal to the Node's, as it drops a `baselineShift` or `rotation` of 0. So a later range can clear an earlier one by writing the Node's value, and every stored override changes what is drawn. It is dropped against the Node's attributes after the write, so a `node_update` that sets the Node's `fontSize` to a range's `fontSize` also removes that range's override. A `fill` or `stroke` equal to the text's own solid paint is still kept, as ADR-0029 keeps it: the Node has no single colour to compare it with, since its Appearance can hold several paints.

## Drawing

- **SVG.** A run's nested `<tspan>` carries `stroke`, with `stroke-opacity` for an `#RRGGBBAA` colour, only in the elements that paint a Stroke, never in a Fill's element or a container paint's copy (ADR-0043). An opaque range stroke writes `stroke-opacity="1"` where the element's own Stroke is translucent, since `stroke-opacity` inherits. A painted text Clipping Path writes its range strokes in the copy that paints its Strokes (ADR-0051), and import reads them back from there.
- **Canvas.** The per-character path of ADR-0029 strokes each character in its range's stroke colour. A container Stroke still paints every glyph in its own colour.

## SVG import

- A tspan's solid `stroke`, or a different `stroke-opacity`, that differs from the text's own Stroke becomes a range `stroke`, as a tspan `fill` becomes a range `fill`.
- These still warn `UNSUPPORTED_ATTRIBUTE` and import as the text's own paint: a tspan `stroke` that is a gradient or `none`, any `stroke` on a text with no Stroke (`stroke` `none`, or `stroke-width` 0), and a tspan `stroke-width`, `stroke-dasharray`, `stroke-linecap`, `stroke-linejoin` or `stroke-miterlimit` that differs from its line's.

## Considered Options

- **`strokeColor`**, or a whole Stroke per range. Illustrator's character stroke also has its own weight, but a range width, dash or join is out of scope for #67, and `stroke` next to `fill` reads as the pair SVG and Illustrator show.
- **Dropping a `fill` or `stroke` equal to the Node's paint.** A text can have several Fills and Strokes, and a gradient one, so "the Node's colour" is not defined.

## Consequences

- MCP: `node_create` and `node_update` take the new keys in `ranges`, and `node_get` `full` returns them. `.kalamo.json` and stored Nodes need no migration: the new keys are optional.
- The round-trip fixture has a Character Ranges Artboard with a text for each new override.
