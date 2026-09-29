---
status: accepted
date: 2026-09-26
---

# Each Document opens in its own tab, art moves between them by copy and paste, and Replace is removed

ADR-0017 brought an edited file back three ways: Open, Replace and Place. Replace merged a file into the Document it was exported from, three-way from the rev in the file. It needs a 30-day Delta Log independent of the undo stacks, a normalising round trip of the base, scope-confined deletes and a fallback when the base is gone, and it still has open bugs where the merge guesses wrong (#40, #41, #42). The user ruled on 2026-09-26 that this is too much complexity for what it buys.

Illustrator has no Replace either. A designer there opens each file in its own document tab and copies art between them. Kalamo does the same.

## Decision

**A tab is a Document.** The browser shows one tab per open Document, as Illustrator's document tabs (F-VIEW-09). There is no new container: Artboards are already the way to hold several drawings in one Document, and a Document is already what Agents address by `docId`, what undo is scoped to and what a Durable Object holds (ADR-0003). Tabs are browser state only: the open tabs are remembered per browser, the active one is the URL, and closing a tab does not delete its Document. MCP does not see tabs.

**Importing a file is Open, into a new tab.** Open (`doc_open`, and the browser's "Open file…" on the Document list and the tab bar, or a file dropped on the tab bar) makes a new Document from an SVG or `.kalamo.json` and opens it in a new tab. It keeps `z-` ids as before, so a file exported from a Document opens with the same Node ids as its source. A file dropped on the canvas, or pasted, is still Place.

**Art moves by cut, copy and paste, through the system clipboard, as SVG.** Copy writes the Selection as a nodes-scope export in the Inkscape dialect (ADR-0017, ADR-0019), which the browser already bundles for Download SVG. So one clipboard format serves Kalamo to Kalamo, across tabs and browser windows, and Kalamo to Inkscape and back. Cut is copy, then delete. Paste is Place, with one rule for a Kalamo copy: when the root's `kalamo:scope` is `nodes:<id,…>`, the listed Nodes land directly in the target Layer with new ids, in stacking order, without a wrapping Group, and the Layers and Groups that only held them are dropped, as Illustrator pastes an object copied out of a Group on its own. Layers and Groups carry no matrix (ADR-0007), so nothing moves. Paste centres the art in the view; Paste in Place (Ctrl+Shift+V) keeps its document coordinates. A cut and a paste are each one Transaction in their own Document, undone there.

**Replace is removed.** `kalamo_doc_replace`, the "Update from file…" button, `packages/io`'s merge and the Document DO's base rebuild go (#68). With them go:

- **The 30-day Delta Log.** A Transaction's delta is kept while its rev is on the undo or redo stack and dropped with it, as ADR-0011 first said.
- **`kalamo:doc` and `kalamo:rev`** on the SVG root: only Replace read them. `kalamo:scope` stays, because paste reads it.

## What the round trip is now

Kalamo → Inkscape → edit → Open in Kalamo as a new Document in a new tab. The designer copies what they want back into the original, or keeps working in the new one. An Agent is pointed at the new `docId`, or copies with `export` (nodes scope) and `svg_import`. Everything ADR-0017 requires of the round trip still holds: every structure a Document holds survives, measured by `pnpm roundtrip`, which already goes through Open.

## Considered Options

- **Keep Replace.** Rejected by the user: the merge is the most complex part of import and export, and the cases it guesses wrong are exactly the ones a person is better at deciding by looking at two tabs.
- **Sheets inside one Document, like Excel's workbook.** Each sheet would need its own Layers, Artboards, undo and render scope, which is a second Document inside the first, while Artboards already cover several drawings in one Document. Agents would address `docId` plus a sheet everywhere.
- **A private clipboard format (`.kalamo.json` Nodes as a web custom format).** Exact, but it pastes only into Kalamo, needs its own image transport, and duplicates what the SVG dialect already carries losslessly. SVG is what Inkscape and other editors paste.
- **Paste every SVG ungrouped.** A pasted file from elsewhere has no Selection to recover and its Layers mean something; placing it as one Group stays the rule for it, as ADR-0017 decided.

## Consequences

- MCP: `kalamo_doc_replace` is removed. `doc_open` is how an Agent brings back an edited file.
- ADR-0017's Replace section and its Delta Log consequence, and ADR-0011's note on 30-day deltas, are superseded. Other ADRs that mention Replace's merge describe what was.
- #40, #41 and #42 are closed as not planned.
- The clipboard paste of a Kalamo copy and Paste in Place are new (#70). Document tabs are new (#69). Opening a bitmap as a new Document, as Illustrator's File > Open does, is #71.
- CONTEXT.md drops Replace, adds Document Tab and Copy, and changes Delta Log, Round Trip, Open and Place. REQUIREMENTS F-IO-01, F-IO-04, F-IO-05, F-IO-10, F-HIST-01, new F-VIEW-09, §6.4, §9 and decision 45 change to match.
