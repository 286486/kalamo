---
status: accepted
date: 2026-09-25
---

# image_place fetches an image URL in the Worker, and asTemplate makes a locked Template Layer

Since #32 an Agent places an image only through `node_create` with a data URL, paying for the base64 in tokens (ADR-0023). §6.4.3's `image_place` fixes that: the Worker fetches the file. F-ILL-04 adds its reference-image workflow: place a photo on a Template Layer and trace it.

## The tool

`kalamo_image_place {docId, src, parentId, frame?, asTemplate?}` plus `intent`, `txId` and `ifRev`, returning a `WriteReceipt`. It is Illustrator's File > Place for a bitmap.

- **`src`** is an `http:` or `https:` URL, or a `data:` URL as `node_create` takes. A local path, or any other scheme, fails `INVALID_IMAGE` with a hint to send the file as a data URL: the Worker cannot read the Agent's disk. §6.4.3's path is dropped.
- **`embed` is dropped.** Every Image is embedded (ADR-0023); a linked Image waits for Links.
- **`frame`** is `{x, y, width?, height?}` in the parent's coordinates, width and height both or neither, as `node_create`'s image takes them; the size defaults to the file's pixels at 1 pt per pixel. Without `frame`, the Image is centred on the parent's Artboard, as `svg_import` places a Group (ADR-0017).
- The file passes ADR-0023's checks: PNG, JPEG or GIF by magic bytes, never by `Content-Type`; WebP refused (superseded by ADR-0100: converted to PNG); at most 5 MB stored.
- **Annotations:** `openWorldHint: true`, since the tool can reach any public host. Annotations are per tool, so it is true for a data URL too. `destructiveHint` and `idempotentHint` are false, as for `node_create`.
- One Transaction; `createdIds` lists the Template Layer, if any, then the Image.

## Fetching

The Worker, not the Document Durable Object, fetches the file, then hands the checked bytes to the Durable Object, which stores them and writes the Node. A slow host then never holds the Document's input gate.

- **Size.** The response body is read up to 20 MB (§7.5); past that the read stops and the call fails `LIMIT_EXCEEDED`. A file between 5 and 20 MB is read whole and fails ADR-0023's 5 MB check, so the error gives its size.
- **Time.** The fetch and the body read together get 10 s, then `FETCH_FAILED`.
- **SSRF.** Only http and https, on any port. The host must not be `localhost`, a `.localhost` name, or an IP literal in a loopback, private, link-local, carrier-grade NAT, benchmarking, multicast, reserved or unspecified range, including an IPv4 address mapped into IPv6 or NAT64. The WHATWG URL parser has already rewritten `0x7f.1` and `2130706433` to `127.0.0.1`, so one check covers them. Redirects are followed by hand, at most 5, and every `Location` goes through the same check. A refused host fails `FETCH_FAILED`.
- **Errors.** `FETCH_FAILED` is a new error code: a refused host, a network error, a timeout, a status other than 2xx, or too many redirects. The message says which, and the status when there is one.

A DNS name that resolves to a private address passes the check. Resolving it first (DNS over HTTPS) would not close the gap: the name can resolve again differently for the fetch itself (DNS rebinding). The network under the Worker is the guard that holds. Cloudflare's edge does not route a Worker's fetch to private addresses. A self-hosted workerd keeps its default `internet` network, `allow = ["public"]`, which excludes private and local addresses. Only `wrangler dev` reaches the LAN, and that is a developer's own machine.

§7.5 also asks for "an allowlist or user confirmation". User confirmation would need elicitation, which ADR-0006 rules out. `openWorldHint` lets the client ask the user under its own policy instead. An allowlist waits for M1's per-user settings.

## Template Layer

F-ILL-04 is Illustrator's Place with **Template** checked. Illustrator puts the image on a new Layer beneath the current one, named `Template <file name>`, locks the Layer and dims the image to 50%. `asTemplate: true` does the same:

- The new Layer goes directly beneath `parentId`'s Layer, or beneath the Layer that holds `parentId` when it is a Group, as its sibling. Its name is `Template <file name>`: the last segment of the URL's path, decoded, else the host, or `Image` for a data URL.
- The Layer is `locked`, so a person cannot move the reference by accident. Locks bind the canvas, not MCP writes, so the Agent can still adjust the Image.
- The Image gets `opacity: 0.5`.
- Without `frame`, the Image is centred on `parentId`'s Artboard, as it would be without `asTemplate`.

Illustrator's template layer also does not print. Kalamo has no `template` flag on a Layer yet, so the Template Layer still exports and renders like any other Layer; an Agent that does not want the reference in `export` hides or deletes it. The flag, which should keep the Layer in `render` and out of `export`, waits for its own issue. (Done by ADR-0099: `asTemplate` sets the Layer's `template`, and `export` leaves it out.)

## Considered Options

- **Fetch in the Durable Object.** One RPC fewer, but a Durable Object handles one input at a time, so a 10 s fetch would stall every other Actor's writes.
- **A `template` flag on Layer now.** It is Illustrator's model, but it needs non-printing semantics in `export`, `render`, the canvas, the Layers panel and the SVG round trip. Inkscape has no template layer, so the SVG would need a Kalamo attribute.
- **Resolve DNS names and check every address.** It adds a DNS-over-HTTPS dependency and still loses to DNS rebinding (above).
- **Keep `embed` and refuse `false`.** A parameter with one legal value only adds a way to fail.

## Consequences

- MCP: `kalamo_image_place` joins the tools, the first with `openWorldHint: true`; `FETCH_FAILED` joins the error codes. `DocumentService` gains `placeImage`.
- CONTEXT.md gains **Template Layer**.
- §6.4.3's row, §6.1 item 7 and §7.5 change to match (REQUIREMENTS).
- The non-printing `template` flag, and fetching over the browser's paste or drop of a URL, are follow-up issues.
