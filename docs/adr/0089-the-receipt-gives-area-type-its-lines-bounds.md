---
status: accepted
date: 2026-10-01
---

# The receipt gives Area Type its lines' bounds

Research 11 (#228) asked Haiku 4.5 for a justified paragraph in a 320 pt wide box with a 1 pt rectangle exactly around the text. Kalamo set the Area Type well, but the rectangle came out two lines short, and eight renders did not fix it. Nothing the Agent could read said how tall the laid-out text was: a WriteReceipt's `bounds` is Area Type's frame (ADR-0022), however little of it the lines fill, and `TEXT_OVERFLOW` says only that text did not fit (#230). This ADR adds a field to the WriteReceipt of CONTEXT.md and REQUIREMENTS §6.5.

## Decision

1. **`lineBounds` in the receipt.** A write that creates or updates Area Type gives, in its receipt's `lineBounds`, each such Node's id mapped to the bounds of its shown lines in document coordinates. `receipt` computes it for every entry point, as it computes `bounds`, so `node_create`, `node_update`, `node_transform`, `node_duplicate`, undo and the rest all give it. A receipt with no Area Type leaves the field out, so other receipts do not grow.
2. **The lines' bounds are Point Type's.** `linesBox` is the box `textBox` already gave Point Type (ADR-0013, ADR-0077, ADR-0029, ADR-0068): each line from its aligned start for its width, ascender to descender, joined with every character's cell, which counts a justified line's widened spaces, a larger Character Range, a baseline shift and a rotation. An Area Type line leaves out the whitespace that hangs at its end (ADR-0022, ADR-0087), its hard return included: that whitespace may lie past the frame's edge and draws nothing. So the box an Agent draws around the text is the box a person would draw, and Convert to Point Type (ADR-0079) bounds the same lines the same way, but for those spaces.
3. **null when no line shows.** A frame too short for the first line maps to null, beside the `TEXT_OVERFLOW` warning.
4. **Auto Size waits (#236).** Illustrator's Area Type Options has Auto Size: the frame's height follows the text, and resizing the height by hand turns it off. REQUIREMENTS F-TEXT-04 already lists it, and Kalamo should offer it for Illustrator parity. It is a stored flag with its own layout, `node_update`, SVG and browser rules, so it is its own issue. `lineBounds` is needed with it too, since an Agent's box around the text is a separate Node, and it is enough without it: an Agent writes `height` from `lineBounds` to fit the frame.

## Considered Options

- **Only the last line's bottom.** It answers this task but not a box that must also fit a short last line or a right-aligned paragraph's left edge. The lines' bounds hold the bottom and every other edge for the same field.
- **A warning, such as `TEXT_EXTENT`.** Warnings are for what went wrong, and this would come with every Area Type write.
- **Area Type's `bounds` as its lines.** `bounds` is the frame for every reader, hit testing and alignment included, and the frame is what a person selects and resizes in Illustrator.
- **A `kalamo_node_get` field.** It costs the Agent another call per text, which is what research 11 measured as Kalamo's weak point.

## How it was checked

`text.test.ts` bounds a two-line Area Type in a 200 pt frame by its lines, its hanging space left out, and a frame too short for a line by null; `document-object.test.ts` checks the receipts of create, transform and update, and that a receipt with no Area Type has no `lineBounds`. `node docs/research/11-mcp-vs-svg/run.mjs text` then reran research 11's text task once on Haiku 4.5. The Agent read `lineBounds` from the first receipt ("the text is 251.62 pt tall") and drew the rectangle in its next call: 5 tool calls, 6 turns, $0.13, against 17 calls and $0.47 in research 11. Its rectangle holds every line, with one leading to spare at the bottom that it added on purpose. One run shows a direction, not a rate.
