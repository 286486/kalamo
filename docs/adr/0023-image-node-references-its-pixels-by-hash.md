---
status: accepted
date: 2026-09-25
---

# An image is a framed Node that references its file by SHA-256, stored once per Document

Placed images (F-IO-02, F-DOC-03 `image`, #32) are one of the Kalamo gaps ADR-0017 lists: Inkscape embeds bitmaps, so a round trip needs a Node that holds one. The bytes are the hard part. A Node is one SQLite row, and a Durable Object caps a row at 2 MB (`docs/research/04-cloudflare-limits.md`). The Delta Log copies a Node's full before and after on every edit (ADR-0017), and `node_get`, `doc_changes` and the WebSocket all carry Nodes. So the pixels cannot live inside the Node.

## The model

- **Image** (`type: "image"`) is a leaf with a frame `x, y, width, height` in its own coordinates, as `rect` has, plus `preserveAspectRatio` and `src`. `transform`, `opacity`, `blendMode`, visibility, lock, `tags` and `meta` work as on every Node. It has no Appearance; its geometric and visible bounds are the frame, as for Area Type.
- **`src`** is the lowercase hex SHA-256 of the image file's bytes, 64 characters. The Document stores each file once under that id, so two Images of one photo share it, and the Delta Log copies 64 characters rather than megabytes.
- **`preserveAspectRatio`** is SVG's attribute, `none` or an alignment `x(Min|Mid|Max)Y(Min|Mid|Max)` optionally followed by `meet` or `slice`. It defaults to `none` at create: the file stretches to the frame, as a scaled image does in Illustrator, and the default frame has the file's own proportions anyway. It is SVG's name because nothing in Illustrator matches it, and it is what Inkscape's file carries.
- **Formats.** PNG, JPEG and GIF, recognized by their magic bytes, never by the data URL's declared type; a GIF draws its first frame. Anything else fails `INVALID_IMAGE`, a new error code. **WebP is refused too**, with a hint to convert it to PNG: neither resvg-wasm (2.6.2 and 2.7.0-alpha.2, VP8, VP8L and VP8X all measured) nor Inkscape 1.2.2 draws it, so a stored WebP would be invisible in `render` and in the editor. It joins once a renderer draws it. (Superseded by ADR-0100: a WebP is converted to a PNG of its pixels at every entry.)
- **Size.** A file over 5 MB (5 × 1024 × 1024 bytes, F-MCP-06c's bitmap quota) fails `LIMIT_EXCEEDED`.
- **Crop is a Clipping Mask** (ADR-0021), as Illustrator's non-destructive crop and Inkscape's Object > Clip > Set both are. There is no `crop` field. Illustrator's Crop Image, which discards pixels, is raster editing (§1.4).
- **Embedded only.** Every Image carries its bytes; F-DOC-03's `embedded` flag and linked files wait for a Links issue, since the Worker cannot read a designer's disk and an Inkscape link names a path on it. (Superseded by ADR-0042: an Image may be linked.)

## Storage

The Document Durable Object keeps an `images` table, one row per id with its MIME type and pixel size, and the bytes in 1 MiB chunks under the 2 MB row cap. An image is stored before the write that references it, and a write whose `src` names no stored image fails `INVALID_IMAGE`. Stored bytes never change, so undo, redo, Replace's rebuilt base and the Delta Log need nothing new. Rows are not deleted yet: a Document keeps every image it has held. (Superseded by ADR-0046: the bytes live in R2, a file nothing names is swept, and a Document holds at most 20 MB of them.)

This supersedes, for now, F-MCP-06b's "bitmaps always in R2". R2 is not bound until the hosted M1, and SQLite keeps the image and the Node that names it in one Durable Object. Moving the bytes to R2 later changes where the table lives, not the model, since the ids are content hashes.

## MCP and the browser

- `node_create` takes `type: "image"` with `src`, either a `data:` URL of the file (base64, or percent-encoded) or the id of an image already in the Document, which copies an Image without resending its bytes; `x`, `y`; `width` and `height`, both or neither, defaulting to the file's pixel size at one pt per pixel, the unit rule of ADR-0017; and `preserveAspectRatio`.
- `node_update` writes `x`, `y`, `width`, `height` and `preserveAspectRatio`. `src` is read-only: Illustrator's Relink waits for Links. (Superseded by ADR-0042: `src` and `file` become writable.)
- `node_get` returns `src` as the id, never the bytes. `render` shows the pixels.
- `image_place` (§6.4.3), which fetches a URL, stays for its own issue, with its SSRF rules (§7.5).
- The Worker serves `GET /api/docs/<docId>/images/<src>` with the stored MIME type and an immutable cache header, since an id always names the same bytes. The canvas fetches each `src` once, decodes it with `createImageBitmap`, which yields a GIF's first frame, draws nothing until it arrives, and applies `preserveAspectRatio` itself. The Layers panel's Auto-name is `<Image>`, as Illustrator names an embedded image.
- The browser's Download SVG and Download `.kalamo.json` embed the bytes it fetched for the canvas, so they still equal `export` at the same rev (ADR-0016).
- **Paste and drop** (F-IO-04, #62) place a bitmap as Illustrator's paste does: an Image at the file's pixel size, centred in the viewport, in the parent ADR-0017's Place picks. The browser POSTs the file's bytes to `/api/docs/<docId>/place-image?parentId=…&x=…&y=…`, where `x`, `y` is the centre in document coordinates. The Worker runs the create checks, turns the centre into a frame from the pixel size, and writes the Image as the User Actor in one Transaction, over HTTP like Place, not the WebSocket (ADR-0017). A missing or unreadable centre falls back to the Artboard's, as `image_place` does. A paste holding SVG text still Places the SVG; otherwise its first `image/*` file is placed, and a drop does the same with its first `.svg` or `image/*` file. The browser does not filter formats: a WebP or a file over 5 MB reaches the Worker and its `INVALID_IMAGE` or `LIMIT_EXCEEDED` message and hint become the notice.

## Files

**`.kalamo.json`** gains a top-level `images`, after `nodes`: an object from id to `data:<mime>;base64,…`, sorted by id, holding exactly the ids some Node's `src` names, and left out when empty, so files without images do not change. Open checks that every `src` has an entry, and that every entry holds a supported file of at most 5 MB whose SHA-256 is its key, else `INVALID_DOCUMENT` with a `path` such as `images.<id>`. `version` stays 1: a file without `images` is still valid.

**SVG:**

| Kalamo | SVG |
|---|---|
| Image | `<image x y width height preserveAspectRatio xlink:href="data:<mime>;base64,…">`, with `transform`, id and style as for any leaf; the root declares `xmlns:xlink` |

Inkscape 1.2.2 draws an `<image>` only through `xlink:href`: given SVG 2's plain `href`, it keeps the attribute on save and draws nothing (measured headless with PNG, JPEG and GIF). resvg draws either. Inkscape keeps `preserveAspectRatio` and the data URL's bytes on save.

Import:

- An `<image>` whose `xlink:href` or `href` is a `data:` URL becomes an Image. Its bytes go through the create checks, and its `src` is their SHA-256, so a file exported from the Document maps back to the images it already holds. Missing `width` or `height` take the file's pixel size. A missing `preserveAspectRatio` is SVG's default, `xMidYMid meet`, not Kalamo's `none`; a leading `defer` is dropped. The frame bakes a move and uniform scale as a `rect`'s parameters do, and keeps any other matrix (ADR-0017).
- An `<image>` that links a file or URL is dropped with the warning `LINKED_IMAGE_DROPPED`: the Worker fetches nothing. (Superseded by ADR-0042: it becomes a linked Image.) One that fails the create checks, a WebP or a file over 5 MB among them, is dropped with the warning `INVALID_IMAGE`.
- A `clip-path` on an `<image>`, as Inkscape's Set Clip writes a crop, imports as a Clipping Mask of its own, like any clipped leaf (ADR-0021).
- **Size.** ADR-0017's 5 MB cap on an SVG now counts only the text outside its `data:` URLs, and each embedded file is capped as above. Otherwise a Document holding one image of 4 MB would export an SVG that Replace refuses.

`render` writes the same SVG, and resvg draws its data URLs.

`preserveAspectRatio` is stored in one spelling, `none` or `<align> <meet|slice>`: `node_create`, `node_update` and import all bring a value to it, dropping `defer` and adding ` meet` to a bare alignment. Replace's normalising round trip (ADR-0017 step 2) maps each data URL it has just written back to its id, so it reads the Document's images but never hashes them again.

## Considered Options

- **The data URL inside the Node.** One image near 1.5 MB would pass the 2 MB row cap, the Delta Log would copy it on every move, and `node_get` would pour base64 into an Agent's context.
- **R2 now.** Right for the hosted service, but there is no bucket until M1, and an image in R2 and its Node in SQLite can disagree after a failure.
- **Transcode WebP to PNG on the way in.** Illustrator does keep an embedded image's pixels rather than its file, but it needs a WebP decoder and a PNG encoder in the Worker, for a format nothing downstream draws. Refusing is reversible; a follow-up can add it. (ADR-0100 does.)
- **A `crop` rectangle on the Node.** SVG 1.1 has no source rectangle for `<image>`, so it would export as a clip anyway, and Inkscape would give it back as one.
- **`href` without `xlink:`.** SVG 2's spelling, but Inkscape 1.2.2 does not draw it.
- **Pixel size from the file's density (pHYs, JFIF).** Illustrator and Inkscape both do this, but Kalamo already counts a px as one pt everywhere (ADR-0017), and the frame is editable.

## Consequences

- MCP: `node_create` gains `image`; `INVALID_IMAGE` joins the error codes, and `LINKED_IMAGE_DROPPED` and `INVALID_IMAGE` the import warnings.
- An Agent that sends a large image in `src` pays for its base64 in tokens. `image_place` from a URL is the fix.
- A Document's images count against nothing yet, and their rows are never deleted. Both wait for M1's quotas, with R2. (Superseded by ADR-0046.)
- A JPEG's EXIF orientation is not handled. Renderers may disagree on a rotated photo. (Superseded by ADR-0101: every entry stores the orientation as 1 and moves it into the Image's transform.)
- Inkscape 1.2.2 draws the empty bands of a `meet` Image with the file's edge pixels stretched into them, where SVG, resvg and the canvas leave them transparent (measured with `pnpm roundtrip`). The file keeps `meet`, so the structure survives; the round-trip fixture uses `slice`, which has no bands, so the pixel check compares what both draw.
- F-DOC-03's `image` row, F-IO-02, F-MCP-06b, §6.4.3, §7.5 and decision 42 change to match (REQUIREMENTS).
