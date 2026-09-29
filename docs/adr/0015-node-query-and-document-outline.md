---
status: accepted
date: 2026-09-24
---

# `node_query` pages by id; `doc_outline` takes a root, types and bounds; `doc_list` reads D1

An Agent finds Documents and Nodes without loading everything (F-SEL-07, REQUIREMENTS §6.1 point 4, §6.4.1, §6.4.2). `kalamo_doc_list` lists Documents, `kalamo_doc_outline` gives the sparse tree, and `kalamo_node_query` finds Nodes by filter. `kalamo_doc_get_info` came with #8.

- **`doc_list`** takes no input and returns `{documents: [{docId, name, createdAt}]}`, newest first, from the D1 `documents` table that `doc_create` writes (#8). The Document Durable Object stays the authority. D1 is only an index, so it lists what D1 holds and reads no DO. Every Actor sees every Document until M1 adds owners.
- **`node_query` filters.** Every filter given must hold (AND); omitted filters match everything.
  - `types`: the Node's `type` is one of them.
  - `nameRegex`: a JavaScript regular expression, without flags, tested against `name` with `RegExp.test`. The schema rejects a pattern that does not compile, and caps it at 200 characters. It matches the stored `name`, not the Auto-name; an unnamed Node has the name `""`.
  - `tags`: the Node carries every listed tag.
  - `parentId`: the Node's direct parent is this id. It does not match deeper descendants, as the name says. An Agent that wants a whole subtree combines `withinRect` with the container's bounds, or walks `doc_outline`.
  - `withinRect`: the Node's `geometricBounds` lie entirely inside the rect, edges included.
  - `intersectsRect`: the Node's `geometricBounds` touch the rect, edges included. This is the browser marquee's test (#9), which moves into core so both use one function.
  - A Node without bounds, such as an empty Group or Layer, never matches `withinRect` or `intersectsRect`.
  - Hidden and locked Nodes are included. The Agent side does not follow UI selectability (F-SEL-07).
- **Paging.** Matches are sorted by id. Ids are ULIDs, a total order independent of the tree, so a page boundary survives concurrent edits. `limit` defaults to 100, at most 1000. `nextCursor` is the id of the last Node returned when more matches follow, else `null`. Passing it back as `cursor` returns the matches with a greater id. The cursor holds no server state (ADR-0006). A Node created between pages shows up in a later page only if its id sorts after the cursor, and a Node deleted between pages simply stops matching; no page repeats a Node.
- **`node_query` result:** `{rev, nodes, nextCursor}`, each entry the concise view `node_get` returns (id, type, name, parentId, visible, locked, childCount, geometricBounds). It takes `txId` like every read (ADR-0008).
- **`doc_outline`** takes `rootId`, `depth` (default 2), `types` and `includeBounds` (default true).
  - Without `rootId` the top level is the Layer list; with it, the top level is that Node's children. `depth` counts levels from the top level, so `depth: 1` returns the top level alone. An unknown `rootId` is `NODE_NOT_FOUND` with `path: "rootId"`; a leaf has no children, so its outline is empty.
  - `types` keeps an entry when its type is listed or when a listed type appears below it within `depth`. The ancestors stay, so every match keeps its place in the tree. The top-level Layers always stay when `rootId` is omitted, so the top level is still the Layer list. `childCount` is always the Node's real number of children, not the number shown. A kept entry whose children are all filtered out within `depth` still carries `children: []`, so it reads as "children, none of these types" rather than "not expanded".
  - `includeBounds: false` leaves out `bounds`. Computing a container's bounds walks its whole subtree, so a large Document's outline is cheaper without them.
  - The result is `{rev, nodes}`. The key was `layers` while the top level could only be Layers.

## Considered Options

- **Offset cursor over tree order**: returns matches in paint order, but an insert or delete between pages shifts every later offset, so pages skip or repeat Nodes. An id cursor cannot.
- **Cursor as an encoded filter plus position**: lets the server reject a cursor reused with other filters, at the cost of an encoding to version. Filters are cheap to resend, and a cursor used with other filters still returns a correct page of those filters.
- **`tags` matching any listed tag**: broadens where every other filter narrows. An Agent that wants either tag makes two calls.
- **`parentId` matching descendants**: useful, but then the name lies. A separate `ancestorId` filter can come if Agents ask for it.
- **`types` on the outline dropping a non-matching container's subtree**: a Text inside a Group would vanish under `types: ["text"]`, which is the case the filter exists for.
- **A `NAME_REGEX_INVALID` error code**: the schema rejection already names the field and the reason, so an Agent can fix the call without a new code in F-MCP-15.

## Consequences

- `node_query` runs every filter over every Node. It is linear in the Document, like `childrenOf` (a `ponytail:` scan in core). A spatial index can come when Documents grow, without changing the tool.
- `fillColor`, `strokeColor`, `hasText` and `artboardId` (§6.4.2) are left for later. They are further AND filters and do not change paging or the result.
- `doc_list` has no paging while Documents are few; it takes the same `limit` and `cursor` when it needs them.
