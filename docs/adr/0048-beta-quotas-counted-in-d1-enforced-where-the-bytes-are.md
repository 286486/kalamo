---
status: accepted
date: 2026-09-28
---

# Beta quotas: counted in D1, storage enforced inside the Document's transaction

The M1 hosted beta is free and has hard per-User quotas (F-MCP-06c, #117), so one account cannot use up the Cloudflare budget. ADR-0046 already limits a Document to 20 MB of image files and a bitmap to 5 MB. This ADR records the rest (#121): which User each quota counts against, where it is counted, and what the caller sees.

## Decision

- **GitHub mode only.** The limits are constants in the edge app (`QUOTAS`). Dev mode, the test pool, `pnpm bench` and `pnpm roundtrip` enforce none of them. ADR-0046's 20 MB per Document and ADR-0023's 5 MB per bitmap stay in both modes.
- **One error shape.** Every quota fails `LIMIT_EXCEEDED`. The message states the limit and the usage, and the hint says what to do next. `ErrorData.limit` carries `{ name, limit, used, resetsAt? }`, with `name` one of `documents`, `storage`, `document_storage`, `render`, `export` or `connections`. The field is additive. ADR-0046's 20 MB error carries it too, as `document_storage`.
- **50 owned Documents, against the owner.** Create, Open and `doc_open` count the caller's rows in `documents` by `owner_id` before they make the Durable Object. Documents shared with the caller do not count, so collaboration costs a Member nothing. The count and the insert are separate statements, so two concurrent creates can overshoot by one. That is accepted for a beta.
- **500 `render` and 200 `export` per UTC day, against the caller.** Before it calls the Durable Object, each call runs one atomic D1 upsert on `usage (user_id, day, kind, n)`: `INSERT … ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n`. `day` is the UTC date. A result over the limit fails with `resetsAt`, the next 00:00 UTC. A call that is refused, or that fails later for another reason, still counts, which keeps the counter a single statement with no race. Every export format counts as an export, including `kalamo_json` and a `png`: `DocumentService.png` is the export's PNG, so it is counted apart from `render`. Browser downloads are serialized by the browser and never reach these calls. A viewer's render counts against the viewer, so a viewer cannot use up the owner's quota. All of one User's Agents share the User's count.
- **200 MB of stored files, against the owner.** `documents.stored_bytes` holds each Document's ADR-0046 total. For every write that can store files (`node_create` or `node_update` carrying a data URL, `image_place`, Open, Place, place-image and relink-image), the Worker sums `stored_bytes` over the owner's other Documents and passes the Durable Object `{ used, limit }`. The Durable Object fails the write inside its SQLite transaction, where ADR-0046 already checks the 20 MB, when its own bytes plus the new files pass either limit. It checks the owner's first, and the message and `limit.name` say which limit was hit. The rehearsal of ADR-0046 runs the same check, so a refused write uploads nothing. A file the Document already holds is free, so copying an Image never hits either limit. Storage counts against the owner, whoever uploads: an editor's Place spends the owner's 200 MB.
- **Write-back.** After a commit or a sweep that changes its bytes, the Durable Object writes its total to its `documents` row through the D1 binding. A failed write-back is logged and never fails the write; the next change corrects the row. An opened Document's row starts with its file's image bytes, since the row is inserted after the Durable Object stores them.
- **20 browser connections per Document, against the Document.** F-MCP-06c lists it among the per-user quotas, but a connection limit is naturally a Document's: it bounds the fan-out of one Durable Object's broadcasts. In GitHub mode the Worker passes the limit to the Durable Object with the socket's Actor, User and Role. The Durable Object accepts a socket past the limit without hibernation, so it never counts, sends it `{ type: "rejected", id: "", error }` and closes it with 4029. An HTTP error on the upgrade would hide the reason from the browser (ADR-0047). The browser shows "Too many open tabs on this Document" and does not reconnect.

## Considered Options

- **Durable Object per User for counters.** Exact under concurrency, but another hop on every render and every create. One D1 statement is atomic for the daily counts, and the Document count tolerates an overshoot of one.
- **Check and then increment the daily count.** Two statements race, and a refused call would not count. The single upsert is simpler and never lets a burst through.
- **Let the Durable Object read the owner's storage from D1 itself.** It would need ownership and the auth mode, which the Worker already has. The Worker passes the budget, and the Durable Object enforces it where the bytes are counted.
- **Refuse the 21st socket with HTTP 429.** The browser sees only a 1006 close and cannot tell it from a network failure.
- **Count connections per User.** One person's tabs would be limited across Documents, which bounds nothing a Durable Object pays for.

## Consequences

- Concurrent writes to two Documents of one owner can together pass 200 MB, since each checks the other's last written total. Accepted for the beta.
- The migration starts every existing row at 0 stored bytes, correct only while no GitHub-mode Worker has stored files; a row catches up at its Document's next change in stored bytes.
- Fonts, exports and snapshots are not in R2 yet. They join the storage sum when they move there.
- Per-user overrides and paid tiers (M3) change the constants into a lookup.
