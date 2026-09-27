---
status: accepted
date: 2026-09-23
---

# Browsers submit gestures as commands on the same WebSocket; each commits one Transaction as the User Actor or is rejected

A browser sends `{type: "command", id, command}` on the socket it subscribed with (ADR-0009). `id` is chosen by the browser; `command` is one gesture as a core edit: `{type: "transform", input}` with a `node_transform` input, or `{type: "delete", nodeIds}`. The Document Durable Object handles each message on its own, in arrival order, and either commits it as one Transaction attributed to the fixed Actor `user` and broadcasts the usual `tx` message, carrying `commandId: id`, to every browser; or sends only that browser `{type: "rejected", id, error}` with the same `ErrorData` an Agent gets. So every command gets exactly one answer, and the browser that sent it can tell which one.

A command that names a Node the Document no longer has is rejected as a whole with `NODE_GONE`, listing those ids, and changes nothing (delete beats edit, ADR-0004). The browser only knows the Nodes the DO sent it, so a missing one was deleted after the browser saw it. A delete that names an already deleted Node is rejected the same way, and the browser, which has already dropped that Node, can press Delete again.

A message that is not valid JSON or not a command of this shape is a client bug: the DO closes that socket with code 1007, and the browser reconnects and gets the whole Document again.

The browser does not apply its own edits locally. While a drag is in flight it draws a preview (core's `transformNodes` on a copy of the Document), and it keeps that preview after the pointer is released until the answer to its command arrives, so a committed move does not flicker and a rejected one snaps back.

Selection stays in the browser (CONTEXT.md). The Selection tool selects objects, the way Illustrator's does: a click on a Node inside a Group selects the outermost Group below the Layer. Only visible, unlocked objects are hit, marqueed or selected by Select All and Inverse; a marquee takes every object whose bounds it touches.

## Considered Options

- **A second channel (HTTP POST per gesture)**: needs its own auth story and loses the ordering the socket gives for free.
- **Optimistic local apply with rebase**: faster on a slow link, but the browser would need to reorder its own `rev`s against broadcasts, which ADR-0009 avoided; a local DO answers in milliseconds.
- **`NODE_NOT_FOUND` for a missing target**: correct for an Agent that may send any id, but the browser can only send ids it received, so the only cause is a delete.
- **A delete of a gone Node as a no-op**: agrees with ADR-0008's "both deletes agree", but a command with no effect would need an answer that is neither a Transaction nor an error.

## Consequences

- Every browser acts as `user`: two tabs are one Actor until OAuth (M1). ADR-0047 keeps `user` in dev mode and records a signed-in browser as its User Actor `user_<userId>` in GitHub mode.
- `doc_changes` shows browser gestures like any other Transaction, with an empty `intent`.
- New gestures (Layers panel toggles in #10, undo and redo in #11) are new `command` types, not new message types.
