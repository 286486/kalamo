---
status: accepted
date: 2026-10-03
---

# The Pen's path_join connects Endpoints that meet

ADR-0037 sends a Pen continuation onto another open path's Endpoint as one browser `path_join`: a `path_edit` that ends the continued path on the other Endpoint, then a `path_op` Join of the two at a tolerance of 0.05. It did not say what happens when the two Endpoints no longer meet. Browser commands carry no `rev` (ADR-0010). So if another Actor's `node_transform`, another tab or a stale browser moved one of the paths between the browser reading the Document and the Document DO applying the command, the edit ended on where the Endpoint had been. Join then bridged the gap with a straight segment the person never drew, and nothing told them (#303). #301 drops a held Pen finish whose paths the browser sees move apart, but a `path_join` already sent cannot be dropped by the browser.

## Sources

- Research 06 §1: with the Pen, clicking the endpoint of another open path while drawing connects the two paths. The click is on the Endpoint, so the paths meet where they are connected.
- Research 06, Object > Path > Join and the Control panel's Connect selected end points: coincident Endpoints merge into one Anchor; Endpoints apart get a straight segment. That is a separate command the person chooses with both Endpoints in view.
- Illustrator is single-user. A move cannot come between the Pen's click on an Endpoint and the connection, so it never connects Endpoints that are apart.

## Decision

**The browser `path_join` means "connect coincident Endpoints", not a general Join.** In the same write, after its `path_edit` applies to the Document as the command finds it, the Document DO checks that Join would merge the two Endpoints its `anchors` names rather than add a segment: that they are within the Join's tolerance as Join measures it, in the topmost path's coordinates with the tolerance scaled to them. Core's `endpointsMeet` is the check and shares that frame with Join, so the two agree under a non-uniform scale or a skew. Paths moved together, by one move or by equal separate moves, still meet and are joined as before.

**Endpoints apart reject the whole command with a new code, `ENDPOINTS_APART`.** Nothing is written, and no Transaction, `rev` or history entry is recorded, as for `NOTHING_TO_CHANGE` (ADR-0109).

**The browser tells it apart by the code.** On a `rejected` with `ENDPOINTS_APART`, the rejection settles the finish's preview as any rejection does, and the notice is the one #301 shows when the browser sees the paths move apart first: a path the Pen was connecting to moved before the connection was made. It names no one, since the browser cannot tell who moved the path. It is not the notice for another Actor's edit to a held finish's path, and not the server's message.

**MCP Join is unchanged.** `path_op` Join, and `path_edit` followed by `path_op` Join in an Agent's Transaction, still add a straight segment between Endpoints apart, as Object > Path > Join does. Only the browser command checks.

## Considered Options

- **Keep the Join and accept the segment.** Rejected: it stores geometry the person did not draw, with no notice. The Pen's connect never makes a segment in Illustrator.
- **Re-place the person's Anchors on the moved Endpoint on the server.** Rejected: the command carries a finished `set_d`, not the person's Anchors in each path's own coordinates, so the server would guess which path the drawing belongs to. #301 drops the same case in the browser instead of guessing.
- **Check a `rev` on `path_join`.** Rejected: ADR-0010 keeps browser commands without a `rev`, and any unrelated edit would then refuse the connection.

## Consequences

- `ENDPOINTS_APART` is a browser-only code. No Agent tool returns it, as no tool returns `NOTHING_TO_CHANGE`.
- The person redraws the connection where the paths are now. Dropping costs a redo, never another Actor's move.
