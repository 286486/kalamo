---
status: accepted
date: 2026-09-25
---

# Tracking is a Node attribute, and Character Ranges override fill, baseline shift and rotation

A text's character attributes live on the Node (ADR-0013, ADR-0028), so every character of a text looks the same. Playful lettering gives each letter its own colour, tilt and bounce. Today an Agent can only get that with one text Node per letter, laid out by hand: "LITTLE FRIENDS" took 52 Nodes in 13 Groups (#20). The word then stops being one text, which cannot be edited, found or named as the word. F-TEXT-02 asks for tracking, baseline shift, character rotation and colour. ADR-0013 planned for this: runs arrive as style overrides on ranges of the `content` string, so a text without overrides never needs migrating.

## The model

- **Tracking** (`tracking`) is the space added after each character, in thousandths of an em, as in Illustrator's Character panel. It may be negative, from −1000 to 10 000, which is Illustrator's range. Absent means 0. It is a Node attribute, like `fontSize`.
- **Character Ranges** (`ranges`) are a list of `{start, end, fill?, baselineShift?, rotation?}`. Each one overrides the Node's character attributes for the characters from `start` up to, but not including, `end`:
  - `start` and `end` count characters (Unicode code points, as `[...content]` counts them) of `content`, a hard return included. So `0 ≤ start < end ≤` the content's length.
  - `fill` is a colour, `#RRGGBB` or `#RRGGBBAA`. For these characters it replaces the paint of every Fill in the text's Appearance. Strokes are not affected. A text with no Fill draws no fill, whatever its ranges say.
  - `baselineShift` is in pt, positive up, as in Illustrator. It raises the characters off the baseline without moving the ones after them.
  - `rotation` is in degrees, clockwise, from −360 to 360, like every other angle in Kalamo (REQUIREMENTS §6.5). Each character turns about its own origin on the baseline, the point SVG's `rotate` turns it about. Illustrator turns a character about its centre, but SVG has no attribute for that pivot and Inkscape edits this one. The advance does not change, so the next character starts where it would have started unrotated.
- **Stored canonical.** A write may give ranges that overlap. The later range wins, attribute by attribute. The Node stores the result in canonical form: sorted by `start`, not overlapping, and adjacent ranges with the same overrides merged. A `baselineShift` or `rotation` of 0 is no override, so a later range can clear an earlier one. A range left with no overrides is dropped, and an empty list is no `ranges` at all. So every range that changes what is drawn reads back from the SVG export as `node_get` returns it, and the round trip compares them field by field. Two do not change the drawing and are lost: a `fill` on a text with no Fill, and a `fill` equal to the text's own solid Fill.
- **A content write clears the ranges.** A `node_update` that writes `content` without `ranges` removes them, as Figma resets a text's styles when its characters are set. Indices into the old content would style the wrong characters of the new one. To change both, send both. `ranges: null` clears them, and `ranges` alone replaces the whole list (RFC 7396: arrays replace).

Tracking stays a Node attribute. Tracking, font style, font size and family per range, and a stroke colour per range, wait for their own issue (see Consequences).

## Layout and bounds

`layoutText` in `core` stays the one layout (ADR-0022). Each character's advance is its advance width plus the tracking. The width of a line is the sum of its characters' advances, minus the tracking of its last character: the space after the last character is not drawn. Inkscape 1.2.2 wraps Area Type by the same width, measured headless: at 40 pt with `letter-spacing` 20, "HH" fits a 75 pt frame but not a 70 pt one, since 2 × 26.08 + 20 = 72.16. Baseline shift and rotation do not change where a line breaks.

Point Type's box is still the union of its lines (ADR-0022), each at least 0 wide, so negative tracking cannot give a negative width. It is also joined with the cell of every character. A cell is the character's advance width from its origin, from the ascender to the descender. It is raised by the character's baseline shift and turned by its rotation about the origin. So the bounds grow to hold a bounced or tilted letter, and a text without ranges measures exactly as before, plus its tracking. Area Type's bounds stay its frame, as Illustrator reports it.

## Drawing

- **SVG** (`render` and export). Tracking is `letter-spacing` on the `<text>`, in user units: tracking × `fontSize` / 1000. Each line tspan holds one nested `<tspan>` for each run of characters with the same overrides, and a run with none stays bare text, so a text without ranges writes the same bytes as before: `fill` (with `fill-opacity` for an `#RRGGBBAA` colour, and `fill-opacity="1"` for an opaque one when the element's own Fill is translucent, since `fill-opacity` inherits), `baseline-shift` as a length, and `rotate` as a single angle, which SVG applies to every character of the tspan. `fill` goes only into the elements that paint a Fill. A Stroke's element, `fill="none"`, gets no `fill`. Area Type's shown lines and its hidden overflow are split the same way. resvg supports all three attributes, and `render`'s tests check that its ink lies inside the bounds. Inkscape 1.2.2 keeps them as written when it saves, and draws them the same way.
- **Canvas.** A text with no tracking and no ranges still draws each line with one `fillText`. Otherwise every character is drawn on its own, at the origin `layoutText` gives it: translated, raised by its shift, turned by its rotation, in its range's fill. That needs no `ctx.letterSpacing`, which older Safari lacks.

## SVG import

- `letter-spacing` on the text, or on its first line tspan, becomes `tracking`: a length divided by the font size, times 1000. `normal` is 0. A baked scale scales both, so tracking needs no scaling.
- Each character's computed `fill`, `baseline-shift` and `rotate` are compared with the Node's:
  - Fill: a solid fill different from the text's own becomes a range `fill`.
  - Baseline shift: `baseline-shift` lengths on the tspans around a character add up, as SVG draws them, and scale with the text.
  - Rotation: a character takes its rotation from the nearest element that gives one for it. That element is the text or a tspan whose `rotate` list covers the character's index in it, the last angle of the list applying to the characters after its end, as SVG says. Inkscape's Text toolbar writes a list per character.
  - Where whitespace collapses (no `xml:space="preserve"` or `white-space: pre`), a run keeps its first character's attributes, so the ranges follow the characters that remain.
  - The per-character result is stored in canonical form.
- These cannot be represented yet, so each one warns `UNSUPPORTED_ATTRIBUTE` and imports as the text's own value:
  - a tspan fill that is a gradient or `none`, or any fill on a text with no Fill;
  - `baseline-shift` `super`, `sub` or a percentage;
  - a nested tspan whose `letter-spacing`, `font-family`, `font-weight`, `font-style`, `font-size` or `stroke` differs from its line's.

## Considered Options

- **Runs as the stored `content`**, `[{text, style}]`, as REQUIREMENTS §6.5 sketched it. ADR-0013 already rejected this. Every reader would unwrap an array, and the string plus range overrides grows into rich text without changing the texts that have none.
- **Ranges that keep their indices across a content write.** Illustrator shifts styles as characters are typed, but a whole-content write has no edit to follow. Kept indices would silently colour the wrong letters of the new text, and cut ranges would do the same at its end.
- **Tracking per range now.** Illustrator allows it and Inkscape writes it on tspans. #20 asks for Node tracking, and the "LITTLE FRIENDS" case needs none per range. It is one of the attributes the next issue brings together.
- **Trailing tracking in the width**, as CSS `letter-spacing` puts space after the last character too. Inkscape does not count it when it wraps, so Area Type would break lines differently in the two editors.
- **Illustrator's centre pivot for rotation.** SVG would need `dx`/`dy` per character to fake it, and Inkscape would show those as manual kerning.
- **`dy` for baseline shift.** It is supported everywhere, but it moves every character after it, so each shifted run needs a matching `dy` back. Inkscape shows it as a vertical shift, not a baseline shift. `baseline-shift` says what is meant, and resvg and Inkscape both draw it. Firefox does not draw `baseline-shift`, but it only matters when an exported file is opened there directly.

## Consequences

- MCP: `node_create` and `node_update` take `tracking` and `ranges` on a text. `node_get` `full` returns them. The drawing conventions show one text with per-letter fills, shifts and rotations in place of one Node per letter.
- `.kalamo.json` and stored Nodes need no migration: absent `tracking` is 0, and absent `ranges` is none.
- Replace merges `ranges` together with `content` (see #28's three-way merge). A file that changed the content brings its own ranges.
- The canvas draws a rotated character with a gradient Fill by turning the gradient with it, where SVG keeps the gradient still. Solid fills, which is what ranges set, look the same.
- A follow-up issue brings tracking, font style, font size, font family and stroke colour per range. Until then Inkscape files that set those on part of a text import them with the text's own value and a warning.
