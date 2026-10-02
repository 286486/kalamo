---
status: accepted
date: 2026-10-03
---

# Direct Selection waits for a Reverse Path Direction press in flight

ADR-0109 renumbered the Direct Selection's Anchors and segments at a Reverse Path Direction press, to where the reverse would put them, and #272 numbered them back on a rejection. Until the answer came, the browser still hit-tested and edited its committed Document, which was not yet reversed. So a key the person clicked in that window was numbered against the old Document, and #272 flipped it with the others on a rejection. A drag, a Delete or a convert in the window worked out its `path_edit` from keys and a Document that disagreed. Its indices were then applied after the reverse if the press was accepted, and without it if the press was rejected. Either way, some outcome edited a point the person did not choose (#274).

## Sources

- Adobe, *Select anchor points to modify paths in Illustrator* (helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/select-anchor-points-in-paths.html): the Direct Selection tool selects the anchor points and segments under the pointer, and the next edit acts on those.
- Illustrator runs a command to its end before it takes the next input. A click or a drag after a press of Reverse Path Direction in the Attributes panel meets the reversed path, so nothing in Illustrator sees the press half done. Kalamo's window between the press and its answer has no counterpart there.
- ADR-0010: browser commands carry no `rev`, and the Document DO applies one socket's commands in order. Ops such as `move_anchor`, `set_handles`, `set_point_type` and `remove_anchor` name an Anchor by its index, and Delete's `set_d` writes each subpath's direction. Neither kind gives the same result before and after a reverse.

## Decision

**The keys stay numbered as the committed Document runs until the press is answered.** The press sends `path_reverse` and draws its preview, but it changes no key. Hit-tests, the keys and every preview then agree with the Document they were worked out from, so a click in the window selects the Anchor or segment under the pointer. The press's preview is drawn on the Document's canvas only. The Direct Selection overlay draws the committed Anchors, at the same places, so a chosen Anchor shows where it is.

**The answer numbers the keys.** When the press's Transaction arrives, or the Document sent on reconnect, each key on a subpath the press named is renumbered if that message turned the subpath the other way. A rejection turns nothing, so it changes no key. A key clicked in the window is renumbered with the rest, so it still names the point it named. Another Actor's edit to a path still clears its keys (ADR-0109). Its Transaction is a different message, so it never renumbers a key.

**An edit waits for the answer.** While a press is in flight, a Direct Selection drag's release, Delete (Edit > Clear), Object > Path > Remove Anchor Points, the Anchors bar's Convert buttons and another Reverse Path Direction press are held. Once the press is answered, rejected or settled by a reconnect, each runs in order on the Document and keys as they then are, as if it had come just after the press. A drag still being made when the answer comes renumbers what it holds, the Anchors, the Handle or the segment, from then on. A held edit sends nothing until it runs, so its preview stays on screen until then.

## Considered Options

- **Renumber at the press and hit-test the reversed preview (ADR-0109 as built).** Accepted presses would be right if the browser hit-tested and edited the preview. Rejected: a rejected press still has to renumber every edit sent in the window. Delete's `set_d` cannot be renumbered, since its new subpaths do not map one to one onto the old ones.
- **Send the edit at once, with a reverse before and after its ops.** Rejected for the same reason: it holds only for ops that keep every subpath, and Delete and Remove Anchor Points do not.
- **Refuse Direct Selection edits while a press is in flight.** Rejected: the person sees a reversed path and a chosen Anchor and gets nothing, and the window can be long on a slow socket.
- **Hold every input on the canvas, not just edits.** Rejected: a click selects correctly without waiting, and panning or zooming would stall for the window.

## Consequences

- On a slow socket, an edit made in the window lands a round trip late. Its preview shows until then.
- While the socket is down with a press in flight, held edits wait for the Document sent on reconnect. A tab switch drops them, as it drops every preview.
- Other tools that edit by Anchor index, such as the Anchor Point tools, the Curvature tool and Join, are not held. They work out an edit from the committed Document and send it at once, so in the window an accepted press can still put it on another Anchor (#274) until they are held too.
