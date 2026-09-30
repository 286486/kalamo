---
status: accepted
date: 2026-09-30
---

# `node_update` converts Point Type to Area Type and back, keeping every shown line in place

ADR-0022 fixed a text's kind after create. To change it, an Agent had to create a text of the other kind and delete the old one. That lost the id, and the Agent had to work out a frame or the hard returns by hand. Illustrator has Type > Convert to Area Type and Convert to Point Type, which keep the characters, their attributes and where each line sits (#57, F-TEXT-04). This ADR adds them and amends ADR-0022's "Kind is fixed".

## The surface

- **`kind` in a `node_update` patch** converts a text. No tool is added: REQUIREMENTS §6.4 routes text edits through `node_update`, and the patch names the kind the caller wants. `NodePatch` advertises `kind` (`point` / `area`) with no default, so the SDK never inserts it. Another value is `INVALID_PATCH`.
- A patch whose `kind` is the text's own kind leaves the kind alone. The rest of the patch applies as usual.
- **A converting patch may also carry keys that do not lay out the text**: `name`, `visible`, `locked`, `opacity`, `blendMode`, `appearance`, `tags` and `meta`. Any key of `TextShape` is `INVALID_PATCH` at that key, with a hint to convert first and edit in a second update. Those keys are `content`, `ranges`, `x`, `y`, `width`, `height`, `frame`, `leading`, `fontFamily`, `fontStyle`, `fontSize`, `tracking` and `alignment`. Two updates in one call may convert a text and then edit it.
- The conversion is one Transaction. It keeps the Node's id, `transform`, content, character attributes and Character Ranges, except where the rules below change them. Undo restores the Node exactly. `node_create` still makes the kind it is given.
- The receipt lists the Node in `updatedIds`, with its new bounds. Converted numbers are stored to 3 decimals, as the file writes them (REQUIREMENTS §6.5), so an export Opens back as the same Node. A line can then move by up to 0.0005 pt.

## Convert to Area Type

The frame is a rectangle chosen so that ADR-0022's Area layout gives Point Type's lines at the same baselines:

- **`width`** is the widest line by ADR-0029's rule, trailing whitespace not counted. Greedy wrapping also measures each unit alone and each unit-ending prefix of a line (ADR-0064), and with negative tracking one of those can be wider than the whole line, so the widest of those counts too. It is rounded up at the third decimal, so no line wraps. If every line is empty or all spaces, the width is `fontSize`.
- **`height`** is the sum of the line boxes (ADR-0022, ADR-0064, ADR-0068): each line's leading, plus what CJK adds above and below the strut. So no line overflows, and Point to Area never warns `TEXT_OVERFLOW`. With one size and a set leading, that is `lines × leading`.
- **`y`** is the first baseline less ADR-0022's first-baseline offset, which is the first line box's ascent.
- **`x`** is Point Type's `x` for left and justify, less half the width for center, and less the width for right. Each line then aligns where it did (ADR-0077). A justified Point Type line ends at a hard return or is the last line, so Area Type does not widen it either.
- Each hard return still ends a paragraph and each line fits the width, so the Area layout breaks at the same places.
- Illustrator frames the point text's bounding box instead. Kalamo's Area Type puts its first baseline where Inkscape does (ADR-0022), not at Illustrator's First Baseline: Ascent, so a bounding-box frame would move every line. The frame is chosen to keep the lines.

## Convert to Point Type

- **Every soft wrap becomes a hard return.** A line that breaks at a space ends in the whitespace its last unit carried, which hangs and draws nothing. That last whitespace character becomes `\n`, so the code-point count and every Character Range stay the same. A line that breaks between CJK characters (ADR-0064) has no whitespace to replace, so a `\n` is inserted after it. Each range after the insertion shifts by one, and a range across it grows by one.
- **`x, y`** is the first shown line's anchor and baseline. For left and justify, the anchor is the line's start. For center, it is the line's middle, and for right, its end. With a rectangle frame every line keeps its place, since Point Type aligns each line about `x` as the frame aligned it. `width`, `height` and `frame` are removed.
- **Justify.** Point Type lays out justify as left (ADR-0077), so a justified line that Area Type widened loses its added word spacing.
- **A shaped frame** (ADR-0078). Point Type has one `x`, so every line aligns about the first line's anchor, and lines move sideways. Point Type also stacks one line per leading. So two spans on one band, or a band with no span, move later lines down too.
- **Overflow.** Illustrator warns that converting deletes the overflowed text, and deletes it on OK. Kalamo deletes it without the dialog, since undo restores it. The overflow is cut from `content`. If the last shown line ends in a hard return, that is cut too, or Point Type would add an empty line. Character Ranges are clipped to the new length and stored canonical (`canonicalRanges`). The receipt warns `TEXT_DISCARDED`, naming the Node and how many characters were deleted, so an Agent sees what it lost.
- **Nothing shows.** If no line of the frame shows, Point Type would hold no content, which the schema refuses. The patch is then `INVALID_PATCH` at `kind`, with a hint to enlarge the frame first.

## Known limit

Point Type stacks each line one of its own leadings below the one before (ADR-0068). A rectangle frame also adds what CJK rises above or drops below the strut (ADR-0064). So in a text whose lines hold CJK taller than its first family's box, the lines after the first move by that amount in either direction. Changing how either kind lays out is out of scope. A text whose characters all draw in its first family converts in place.

## Consequences

- `core`: `areaFrame` and `pointType` in `text.ts` compute the conversions from `layoutText`'s lines. `updateNodes` applies them before the patch's other keys, and returns the `TEXT_DISCARDED` warnings beside the Nodes.
- MCP: `kalamo_node_update` documents `kind`. The old hint, "A text's kind is fixed", is gone.
- SVG: each kind writes and reads its ADR-0022 form unchanged, so the round-trip fixture does not change.
- The browser has no Type menu or Type tool yet, so the Type > Convert menu items wait for them. Type on a Path, threaded text, Area Type Options and Auto Size are out of scope.
