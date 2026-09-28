---
status: accepted
date: 2026-09-27
---

# Image files live in R2, swept once nothing names them, within a 20 MB Document quota

ADR-0023 kept every image file in the Document Durable Object's SQLite, in 1 MiB chunks, and never deleted one. F-MCP-06b puts bitmaps in R2. A Document kept every file it had ever held, a failed Place left its files stored (#66), and nothing enforced F-MCP-06c's 20 MB Document size (#63). This ADR supersedes ADR-0023's Storage section and its consequence that images count against nothing and are never deleted. The model, the ids, the MCP surface and the file formats of ADR-0023 and ADR-0042 stand.

## Decision

- **Where the bytes live.** An R2 bucket bound as `IMAGES` holds one object per file per Document, at `docs/<docId>/images/<src>`, with the stored MIME type as its content type. A Document never shares an object with another Document. A photo placed in two Documents is stored twice, but deletion and accounting stay inside one Durable Object, with no reference counts across Documents. `wrangler dev` and the Workers test pool emulate the bucket locally.
- **Metadata stays in SQLite.** The `images` table keeps one row per id with MIME type, pixel size and byte `size`. Core still sees `doc.images` filled from the rows, so a `src` that names no row fails `INVALID_IMAGE` as before.
- **Write order.** A write that carries files runs in three steps:
  1. The write is rehearsed: it runs whole inside a SQLite transaction that is then rolled back. A write that would fail for a bad `parentId`, an `ifRev` conflict, an invalid Node or the quota fails here and uploads nothing, so a refused Place leaves no row and no object (#66).
  2. The files are uploaded to R2.
  3. The write runs again, and each new file's row is inserted in the same SQLite transaction as the Nodes that name it.

  With `partial`, a file that only failed items name gets no row, and its object is swept like an orphan. A write can still fail at step 3 if the Document changed during the upload. Its objects are then left without rows, and it asks for a sweep one grace period later. A row never exists without its object. The Document can end up with an extra object, never with a missing one.
- **Reading bytes.** The SVG and `.zibel.json` writers take a synchronous image source. For `export`, `render` and `file`, the Durable Object therefore fetches the objects of every Image in the Document from R2 in parallel, then hands the writers a map.
- **Image route.** `GET /api/docs/:docId/images/:src` checks the id's shape, then streams the object from R2 in the Worker, with its content type and the immutable cache header. The Durable Object is not called, so a large file never holds the Document's input gate. A missing object answers 404. The route stays unauthenticated until OAuth (ADR-0009); ADR-0047 puts it behind the session in GitHub mode.
- **Liveness.** A file is live while its id is the `src` of a Node row, of an open Transaction's staged base or working copy, of a Delta Log before or after copy, or of a write between its upload and its commit. Every other file is garbage.
- **Sweep.** Three events ask the Durable Object's alarm, which already drives Transaction deadlines, to sweep a minute later: a commit that drops Delta Log rows (the undo stack passes 200 Transactions, or an edit clears the redo stack), a rolled-back or expired Transaction that had staged Nodes, and a write that failed after its upload. The minute's delay makes a burst of edits one sweep, and the sweep never runs on the write path. The sweep deletes the rows of garbage files in one SQLite transaction, then their objects. It then lists the Document's R2 prefix and deletes every object with no row that was uploaded more than an hour ago; for a younger one it asks for another sweep once that one is an hour old. That hour covers a write whose upload finished but whose row is not in yet. An upload waits for a running sweep's deletes, so it never lands before one of them. A failed delete leaves an object with no row, which the next sweep deletes; a sweep that fails asks for another a minute later. Sweeping twice gives the same result.
- **Quota.** The sizes of the files a Document stores, live or held by undo history, sum to at most 20 MB (20 × 1024 × 1024 bytes). F-MCP-06c's quota table gives a Document 20 MB, stated for its JSON; this quota takes the same number for its image files, and the JSON has no cap of its own beyond ADR-0049's 32 MiB request cap. The check runs inside the write's SQLite transaction, over the rows that write inserts. A file the Document already holds is free, so copying an Image always passes. Past the limit, the write fails `LIMIT_EXCEEDED`. The message gives the stored total, the new files' size and the limit. The hint says to delete unused Images, and that a deleted Image's file keeps counting until 200 more Transactions push it out of undo history or an edit clears the redo stack. Open of a file whose images pass the limit fails the same way, and uploads nothing.
- **Per-Document total.** The `storedImageBytes` RPC method answers the same sum. ADR-0048's per-owner 200 MB quota sums it over the owner's Documents.
- **Migration.** A Durable Object that still has an `image_chunks` table copies each file to R2, records its size and drops the table before it handles its first request. Only local `.wrangler/state` has such Documents.

## Considered Options

- **Keep the chunks in SQLite.** No moving parts, but every Durable Object carries megabytes that R2 stores more cheaply, against F-MCP-06b.
- **Insert the row, then upload.** The row would exist without its object while the upload runs, or for good if the upload failed, and the Image would not draw. Upload first can only leave an extra object, which the sweep deletes.
- **Upload without a rehearsal.** A refused write would leave an object that the image route serves until the next sweep, an hour or more later. The rehearsal runs the edit twice, which costs CPU but no I/O.
- **Count only the files that live Nodes name.** That is what a person sees, but not what the Document occupies in R2, and not what the per-user quota will sum. A deleted Image would free space that undo can still claim back.
- **Share objects across Documents by content hash.** Stores a photo once, but needs reference counts across Durable Objects. The keys are content hashes, so this can come later.
- **Proxy the image route through the Durable Object.** One place checks the rows, but each file's bytes would pass through the Document's input gate.

## Consequences

- An orphan left by a write that failed after its upload is served by the image route until it is swept.
- `export`, `render` and `file` fetch every Image's file, in scope or not.
- A Document may hold at most 20 MB of image files, and deleting an Image does not free its bytes until undo history lets it go.
- A Document's Node JSON has no 20 MB cap; ADR-0049's 32 MiB request cap bounds its `.zibel.json`.
- F-MCP-06b, F-MCP-06c and decision 42 change to match (REQUIREMENTS).
