---
status: accepted
date: 2026-09-24
---

# `.kalamo.json` is the Document's content, sorted and versioned; `doc_open` takes the text and makes a new Document

A Document leaves Kalamo with `kalamo_export` `format: "kalamo_json"` and comes back with `kalamo_doc_open` (F-DOC-01, F-DOC-06, F-IO-05, #13). The runtime store stays the Durable Object's SQLite (ADR-0003); the file is only an import and export format (REQUIREMENTS §8).

- **Content.** The file is one JSON object: `version`, `name`, `artboards` and `nodes`, each Node exactly as stored, with its id, `parentId` and `index` (ADR-0002). It leaves out the docId, `rev` and the Transaction log: they belong to one running Document, not to the artwork. Opening a file makes a new Document whose history starts at the open, so carrying them would only be misleading. The model has no timestamps yet; when `createdAt / updatedAt` arrive they stay out of the file for the same reason.
- **Readable and diffable.** `nodes` is sorted by id, and every object's keys are sorted, except the top level, which reads `version`, `name`, `artboards`, `nodes`. Indentation is two spaces, with a final newline. The same Document always serialises to the same bytes, however its Nodes were created or edited, so export, open, export gives identical text and a file under git shows only real changes. Ids are ULIDs, so id order is roughly creation order.
- **Schema version.** `version` is an integer, 1 today. On load, before validation, core runs the `up` migration of each older version in turn, as tldraw does: a migration takes the raw JSON of version n and returns version n + 1. There are none yet; tests pass their own list to prove the hook. A version with no migration path, or one newer than this build knows, fails; there is no downgrade (F-DOC-06). Migrations stay in core, so the Worker and the browser load files the same way.
- **Validation.** After migration, the file must satisfy what core enforces on every write: the Node shapes, colours (`INVALID_COLOR`), path data (`INVALID_PATH`) and the tree rules of ADR-0005 (`INVALID_PARENT`, via the same check `node_create` runs). Ids are unique, every `parentId` names a Node in the file, `index` is a valid fractional-index key and unique among siblings, there are 1 to 1000 Artboards and at least one top-level Layer. Unknown keys are rejected rather than dropped, so nothing in the file is lost silently. Anything else wrong, including text that is not JSON, is the new code `INVALID_DOCUMENT`. Every error carries `path` into the file, such as `nodes[3].appearance.fills[0].color`. Parsing happens in the Worker before any Durable Object or D1 row exists, so a bad file creates nothing.
- **`doc_open`** takes `content`, the file's text, and optional `intent`. It does not take a path: the Worker has no filesystem, and an Agent reads its local file and passes the text. It creates a Document with a new docId, keeping every Node id and Artboard id, so a script that names ids keeps working on the copy. The open is committed as rev 1, one Transaction of the calling Actor whose summary is `Open Document "<name>"`; like `doc_create` it is not undoable (ADR-0011). The Document is listed in D1 like a created one. The result is `{docId, name, artboards, rev, nodes}`, where `nodes` is the top level of `doc_outline`, the Layer list with bounds, so the Agent has Layer ids to write into.
- **`export` `kalamo_json`** returns the file as text content and `{}` as structured content. It is always the whole Document: `scope`, `scale` and `background` do not apply to it and are ignored. It takes `txId` like every read, and then includes that Transaction's uncommitted edits.
- **Browser download.** The viewer's toolbar has a button that saves the Document it shows as `<name>.kalamo.json`. It serialises the Document the browser already holds with the same core function, so no request is needed and the file equals what `export` returns at the same rev.

## Considered Options

- **Keep the docId in the file**: F-DOC-01 lists `id` as a Document property, but on open it would be ignored, and two exports of Documents with the same artwork would differ in a field nobody can use. Leaving it out makes the round trip byte-identical.
- **Keep `rev` and history**: a reopened Document would start from someone else's rev with no log behind it, breaking `doc_changes` and `ifRev`. History export can come with `history_list` if it is ever wanted.
- **Keys in stored order**: readable, but the order depends on how a Node was created or patched, and a Node read back through the schema comes out in schema order, so export, open, export would differ. Sorting is the one order both sides agree on without a hand-kept list.
- **New ids on open**: avoids nothing, since the new Document is its own Durable Object and no id can collide; keeping them lets the file and the Document be compared by id.
- **Reject `scope` with `kalamo_json`**: stricter, but the field is optional and the description says it does not apply; failing on it would only cost the Agent a retry.

## Consequences

- `INVALID_DOCUMENT` joins the error codes (F-MCP-15).
- The current version is one past the last migration in core's list, so adding a migration is the only way to bump it.
- `assertParent` stops at a cycle above the parent. `node_create` could never meet one, since its parents already sit in a valid tree, but a file can carry `A.parentId = B, B.parentId = A`.
- A file has no format cap of its own: it is bounded by ADR-0049's 32 MiB request cap, and its images by ADR-0046. There is no Node count cap yet.
- Dragging a file into the browser (the rest of F-IO-05) and opening by `docId` or `url` are left for later issues.
