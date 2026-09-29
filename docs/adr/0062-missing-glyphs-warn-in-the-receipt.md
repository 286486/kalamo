---
status: accepted
date: 2026-09-29
---

# Missing glyphs warn in the receipt

ADR-0013 lets a character the bundled font lacks render as a `.notdef` box and measure as its advance, with no signal: an Agent that writes Chinese learns it only if it renders and looks. This ADR adds a receipt warning for it (#18). It amends ADR-0013's `.notdef` consequence and ADR-0017's warning list.

## Decision

- **`MISSING_GLYPHS`, one per text.** A write that creates or updates Nodes (`node_create`, `node_update`, the browser `create` and `update` Commands) warns `{code: "MISSING_GLYPHS", nodeId, message}` for each text whose `content` holds a character the face it draws in has no advance for. `\n` is a hard return, not a glyph. The write still succeeds. It sits beside `FONT_MISSING` and `TEXT_OVERFLOW`, and like them it re-checks every updated text.
- **The drawing face decides.** The check reads `SOURCE_SANS_3.faces[bundledStyle(fontStyle)]`, the table `advanceOf` measures with, not `fontFamily`. Every text draws in Source Sans 3, so a text in a family Kalamo lacks can warn both `FONT_MISSING` and `MISSING_GLYPHS`. Character Ranges do not change a character's face and do not affect it. The six bundled faces cover the same 1614 code points, and a core test fails if a regenerated table diverges.
- **The message names the characters.** Each distinct missing character once, in order of first appearance, at most 20, then "and N more", followed by what happens: `Source Sans 3 has no glyphs for 小, 动, 物; they render as .notdef boxes and measure as its width.`
- **One per file on Open and Place.** `parseFile` (`doc_open`, `svg_import`, Place) follows ADR-0017's one-per-font rule: a single `MISSING_GLYPHS` naming the union of every text's missing characters, on the first text that has one, so a CJK poster does not warn per text. Place counts again over the Nodes it places (#162): a Kalamo copy leaves behind the text Clipping Path that only leads to a listed Node, so its `MISSING_GLYPHS` names the placed texts' characters, and its `FONT_MISSING` the faces they use, each on a placed text, in file order as Open counts them. A future reader warning kept once per key with a `nodeId` is aggregated the same way.

MCP stays stateless (ADR-0006): this is a receipt field, nothing is pushed.

## Consequences

- Bundling a CJK font (#159) removes the warning for the characters it covers without a contract change: the check follows the face tables. Amended by ADR-0063: the check reads every face a text falls back to, and the message names both bundled families.
- The browser shows nothing yet; the warning is in the receipt only.
