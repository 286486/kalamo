---
status: accepted
date: 2026-09-29
---

# A text clips by its glyphs, composited on the canvas

F-MASK-01 lets any vector object be a Clipping Path, text included. Filling type with a photo or a pattern is one of the commonest reasons a designer makes a Clipping Mask. ADR-0021 left text out, because the browser draws text with `fillText` and Canvas 2D cannot `clip()` by it. So `kalamo_mask_make` refuses a text with `INVALID_MASK`, and a `<clipPath>` holding a `<text>` imports unclipped with `UNSUPPORTED_ATTRIBUTE` (#49). This ADR lets a text be a Clipping Path. It amends ADR-0021 and applies ADR-0051 to text.

## What Illustrator does

In Illustrator, Object > Clipping Mask > Make with a text object on top clips the objects below to the type. The type stays live: the Type tool still edits it, and the clip follows every change to its characters, font, size, tracking and layout. Make sets the text to no Fill and no Stroke on every character, as it empties any Clipping Path's Appearance. The designer can give paint back in the Appearance panel, and it draws as any painted Clipping Path draws (ADR-0051). The clip is the filled area of the glyphs as they are laid out. A text's Stroke never widens it, and Area Type characters that overflow the frame are not drawn and do not clip. Several text objects clip as one only after Object > Compound Path > Make joins them. Adobe's help pages refuse automated fetches, so this record rests on Illustrator's documented behaviour ("only vector objects can be clipping paths"; the clipping path "changes to an object with no fill or stroke"), on its scripting DOM (`GroupItem.clipped`), and on common practice.

## The rule

- **The tree.** A text Node, Point Type or Area Type, may carry `clipping: true`. It follows every rule ADR-0021 sets for a Clipping Path: at most one per Group, none in a Layer (ADR-0053 amends this: at most one per Layer), no hiding it (`INVALID_PATCH`), `clipping` read-only to `node_update` and `node_create`, Make and Release the only writers. `doc_open` accepts `clipping` on a text. Type on a Path, when it lands, follows the same rule, since its glyphs clip in the same way.
- **What it clips.** The clip region is the union, under nonzero, of the glyphs the text draws: the same lines, the same wrapping, the same Tracking, the same Character Range `baselineShift` and `rotation`, the same face, in the text's own `transform` (ADR-0007). Area Type overflow is not drawn, so it does not clip. Spaces clip nothing. A text whose drawn glyphs cover nothing, such as one of spaces only or an Area Type whose every character overflows, clips everything away, as in Illustrator. Nothing is cached: every renderer draws the clip from the Node as stored, so an edit to `content`, `fontSize`, `fontStyle`, `tracking`, `leading`, `ranges`, `x`, `y`, `width`, `height` or `transform` changes the clip in the same Transaction, and undo restores it.
- **Make.** Make empties the text's Appearance, as it does for any Clipping Path, and also removes `fill` from each Character Range, as Illustrator sets every character to no Fill. A Range left with no attribute is dropped, which keeps `ranges` in canonical form (ADR-0029). This is still one Transaction, so undo brings the colours back. Release keeps whatever the text then has (ADR-0051).
- **Painted.** A repainted text Clipping Path draws in ADR-0051's order: its Fills behind the content, its Strokes in front and not clipped by the Group's own clip. Each paint draws as the text leaf draws it, Character Range Fills included, where the text's own Fills paint (ADR-0029).
- **Fonts.** The clip uses the face the text draws in. A `fontFamily` or `fontStyle` Kalamo does not have clips by the bundled face it draws with, and the receipt warns `FONT_MISSING` as for any text (ADR-0028). A character the face lacks clips by whatever the renderer draws for it, as the text itself does (ADR-0013). Before the browser has loaded the fonts, the canvas clips by the fallback face that it is also drawing with, and it redraws once the fonts load. The clip and the drawn text therefore always agree.

## Canvas

The canvas cannot `clip()` by type, so a text-clipped Group composites instead. It draws what the clip covers, items 1 to 3 of ADR-0051, into an offscreen layer (ADR-0044's `NewLayer`). It then draws the text's glyphs, opaque, into a second layer, masks the first with it in one `drawImage` under `globalCompositeOperation = "destination-in"`, and composites the first layer back. Drawing the glyphs straight into the first layer under `destination-in` does not work: that operation clears everything outside what it draws, so each `fillText` would erase the glyphs before it (found when implementing #49). Item 4, the Clipping Path's Strokes, draws directly and unclipped. Item 5, the container paints above Contents, takes a second layer that is masked in the same way, and only when there are such paints. The glyphs come from the same routine that draws a text leaf, so the clip is exactly the drawn type. Ancestor clips stay in force while the layer composites, as they do for any layer (ADR-0044). A Group that is also isolated draws the masked layer into its own isolation layer.

A container paint over a leaf inside a text-clipped inner Clipping Mask (ADR-0043) is masked the same way. `paintedLeaves` lists each inner clip as either an outline with its fill rule or a text. An outline clips with `clip()` and a text with a masked layer.

A full-canvas layer per text-clipped Group per frame has the cost ADR-0044 already accepts for isolated Groups. Cropping the layer to the Group's visible bounds is the upgrade if a profile asks for it.

## Hit test and bounds

A point is inside a text clip where one of its glyphs, drawn as the canvas draws it, covers that point. The browser checks this by drawing the glyphs into a one-pixel scratch canvas placed over the point and reading its alpha. Clipped content is hit only there. The same test applies to every inner text clip of a container paint's leaf. A painted text Clipping Path hits as a text leaf does, anywhere in its frame, and the Selection tool picks the Clipping Mask while Direct Selection picks the text (ADR-0051). An unpainted one hits nothing.

Bounds follow ADR-0021 and ADR-0051 unchanged. A Clipping Mask's `geometricBounds` are its Clipping Path's, which for a text is its frame (ADR-0013, ADR-0022), and its `visibleBounds` are the text's own. So the WriteReceipt, `doc_outline`, the Render Overlays and a `nodeIds` Render Scope are the same as for any other text.

## SVG

- **Export.** The `<clipPath>` holds the text as a leaf writes it (ADR-0022, ADR-0029): one `<text>` with its id, lines as `<tspan>`s, Character Ranges as nested `<tspan>`s for their `baselineShift` and `rotation`, and `fill="none"`. It has no Range `fill` and no `clip-rule`, since glyphs always clip under nonzero. The overflow `<tspan>` is `visibility:hidden`, as a leaf's is. Only Area Type overflows, and Inkscape lays Area Type out in its `shape-inside` frame, so it never draws or clips by the overflow; resvg honours `visibility`. The frame's `<defs>` goes just before the `<clipPath>`, which cannot hold it. The painted copies are `<text>` in ADR-0051's clip paint groups, written as the text leaf writes that Appearance, and the Fill copy keeps its Range Fills.
- **Import.** A `<clipPath>` holding exactly one `<text>` gives a text Clipping Path. The `<text>` is read by the text import rules, including its tspans, ranges, transform, font name and warnings. As ADR-0051 requires, its paint is ignored. The Appearance comes only from clip paint groups, and Range Fills come from the Fill copy, matched to the Clipping Path's own Ranges by character index. A `<tspan>` with `display:none` or `visibility:hidden` after the laid-out lines is read as overflow, as a leaf's is. A `<text>` that would not import as a single text Node, anything else in the `<clipPath>`, and several children still import unclipped with `UNSUPPORTED_ATTRIBUTE` `clip-path`. Inkscape's Object > Clip > Set on a text writes the clip into `<defs>` under a new id, with its transform rewritten and its tspans kept, so the leaf rule of ADR-0021 makes the Group.
- **Checked.** Inkscape 1.2.2 keeps an inline `<clipPath>` holding a `<text>` in place, with its id, when it saves. Inkscape and resvg 2.6.2 both clip by a `fill="none"` `<text>` with a rotated or shifted `<tspan>`. This was checked by hand with `inkscape --export-type` and `@resvg/resvg-wasm` on hand-written files. Implementing #49 found that Inkscape, saving Area Type, lays its characters out again in the frame: it drops a `display:none` tspan's characters, keeps a `visibility:hidden` one's as a plain line past the frame, and drops `rotate`, inside a `<clipPath>` or not. So overflow is `visibility:hidden` everywhere, and an Area Type's Range `rotation` does not survive an Inkscape save, as for any Area Type. `pnpm roundtrip` checks both text Clipping Path kinds.

`render` draws the SVG through resvg with the bundled faces (ADR-0013), so it follows this mapping.

## Considered Options

- **Glyph outlines as a `Path2D`**, parsed from the font in the browser with opentype.js or harfbuzzjs. The canvas would `clip()` and hit-test with `isPointInPath`. But this adds a second glyph source beside `fillText`, and the two disagree wherever the browser shapes or substitutes differently, which breaks ADR-0013's promise that the drawn text matches the bounds. HarfBuzz arrives with F-TEXT-09 and draws text from outlines everywhere. At that point the text clip can switch to `clip()` without changing the model or the SVG.
- **Create Outlines first** (F-TEXT-06), clipping by the outlined Paths. The type would no longer be editable, which is not Illustrator's text clip, and it would make #49 wait for a feature it does not need.
- **Hit-test by the text's frame.** Simple, but a click between two letters would pick content that is not drawn there.
- **`display:none` for overflow inside a `<clipPath>`**, as this ADR first said, on the belief that Inkscape clips by a `visibility:hidden` tspan there. It does for a positioned tspan, but only Area Type overflows, and Inkscape flows Area Type in its frame, never drawing the overflow; and its save drops a `display:none` tspan's characters, so the round trip lost them.

## Consequences

- ADR-0021's rule "a text is not a Clipping Path yet" and its `UNSUPPORTED_ATTRIBUTE` case for a text inside `<clipPath>` are replaced by this ADR.
- When this lands, CONTEXT.md's Clipping Path entry and F-MASK-01's deferred list drop the text exception.
- The render fixture's hash changes once, when the fixture gains a text Clipping Mask.
- Several texts as one Clipping Path wait for text in Compound Paths. Isolation mode (F-MASK-01) and a Layer Clipping Mask (#51) are unaffected.
