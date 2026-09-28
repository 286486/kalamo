---
status: accepted
date: 2026-09-29
---

# Request bodies are capped where the Worker reads them

Open file (`POST /api/docs`) and Place (`POST /api/docs/:id/place`) read the body with `request.text()`, and place-image and relink-image with `request.arrayBuffer()`, before `parseFile` or `checkImage` applies its 5 MB limit (#38). The platform accepts bodies up to 100 MB and an isolate has 128 MB, so one signed-in User could exhaust the isolate and fail every request that shares it. The docs also disagreed on how large a `.zibel.json` may be: ADR-0016 and ADR-0017 called it uncapped, and F-MCP-06c's table listed a 20 MB "document JSON" that ADR-0046 enforces as 20 MB of stored image files.

## Decision

- **One reader.** `readCapped` in the edge app reads a `Request` or `Response` body under a cap in bytes and throws the caller's `LIMIT_EXCEEDED` ZibelError past it. A declared `Content-Length` over the cap is refused without reading. Otherwise the stream is counted and cancelled at the first chunk past the cap, so a missing or understated length bounds memory as well. A truthful declared length is read into one buffer of that size. The URL fetcher (ADR-0027) uses the same reader with its 20 MB and its own message.
- **Open and Place: 32 MiB** (`MAX_REQUEST_BYTES`, 33,554,432 bytes). It is the Durable Object RPC ceiling ADR-0016 already names, so no new product limit is added. The largest Document Zibel holds has 20 MB of images (ADR-0046), about 26.7 MB as base64 in its own `.zibel.json`, which leaves about 6 MB for Nodes: every Document still exports and reopens.
- **place-image and relink-image: 5 MiB** (`MAX_IMAGE_BYTES`). The body is exactly the file, so the transport cap is the format cap.
- **Both modes.** Neither cap is a beta quota: both apply in dev and GitHub mode, neither is in `QUOTAS`, and the error carries no `ErrorData.limit` (ADR-0048).
- **`/api` refusal.** HTTP 400 `LIMIT_EXCEEDED` through the existing `failure`. The message states the cap, and the declared size when there is one. `path` is `content` for Open, `svg` for Place, `file` for bitmaps. Open and Place hint "Split the drawing into several files, or remove embedded images"; the bitmap routes keep `checkImage`'s hint. Authentication, the origin check and, for bitmaps, `authorize` run before the body is touched.
- **Units.** SVG's 5 MB counts UTF-16 code units outside data URLs (ADR-0017, ADR-0023); the request cap counts bytes on the wire. They are separate checks, and the request cap runs first.
- **`/mcp` (#125).** The same 32 MiB cap, after the principal check and before the SDK reads the body. No request id can be known without the body, so the answer is HTTP 413 with `{ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message", "data": { "code": "LIMIT_EXCEEDED", "message", "hint" } } }`.

## Considered Options

- **A WAF body-size rule.** Works only when the operator configures it, and covers neither dev mode nor `wrangler dev`.
- **Per-format caps before parsing.** They run after the read, which is the problem.
- **20 MiB.** A Document at the 20 MB image cap could not reopen from its own export.

## Consequences

- `.zibel.json` has no format cap of its own; it is bounded by this 32 MiB request cap and its images by ADR-0046.
- The runtime pulls one chunk of a streamed body as it hands the request over, read or not; "unread" means no further.
- There is still no Node count cap.
