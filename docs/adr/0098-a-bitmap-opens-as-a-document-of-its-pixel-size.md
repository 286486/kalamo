---
status: accepted
date: 2026-10-02
---

# A bitmap opens as a Document of its pixel size

Illustrator's File > Open takes a PNG, JPEG or GIF as well as vector files: it makes a new document whose artboard is the image's size, with the image embedded in the first layer. Until #71, Kalamo's Open (ADR-0016, ADR-0017, ADR-0030) read only `.kalamo.json` and SVG text. A bitmap could only be placed into an existing Document (ADR-0023, ADR-0027). This ADR extends Open. Place, paste and a drop on the canvas do not change.

## Decision

1. **`content` carries a bitmap as a data URL.** `kalamo_doc_open`'s `content` also takes a `data:` URL of a PNG, JPEG or GIF, decoded as `node_create`'s and `image_place`'s `src` is (`readImage`). `parseFile` tells it apart from `.kalamo.json` (`{`) and SVG (`<`) by its `data:` prefix. The bytes pass `checkImage` and are typed by their magic bytes, never by the data URL's MIME type, a `Content-Type` or a file extension. So Open accepts and refuses exactly what Place does: WebP fails `INVALID_IMAGE` with Place's "Convert the image to PNG" hint (superseded by ADR-0100: a WebP opens as a PNG of its pixels), any other non-image (`data:text/plain,…`) fails `INVALID_IMAGE`, and a file over 5 MB fails `LIMIT_EXCEEDED`. `path` is `content` in every case. A refused file creates no Durable Object and no D1 row, like any bad Open. `/mcp`'s 32 MiB body cap (ADR-0049) is well above a 5 MB image in base64.
2. **A new optional `name` argument.** `kalamo_doc_open` takes the file's name, as `?name=` gives it for the browser. It names the Document the same way on both paths (decision 4).
3. **The Document's shape.** Committed as rev 1 like any Open: not undoable, one Transaction of the caller, summary `Open Document "<name>"`. It holds:
   - one Artboard `Artboard 1` at (0, 0), the image's pixel width × height at 1 pt per pixel, with no background;
   - one top-level Layer `Layer 1`;
   - in that Layer, one embedded Image with `x: 0, y: 0`, the pixel width and height, `preserveAspectRatio: "none"`, identity transform, full opacity and an empty `name`, so its Auto-name is `<Image>`.

   A GIF opens at its first frame, as Place draws it. The Artboard and Layer come from core's `createDocument` and the Image from `createNodes`, so the names and defaults match `doc_create` and Place. The Document's file row starts with the image's bytes, which count against the owner's 200 MB and the Document's 20 MB (ADR-0046, ADR-0048). The 50-Document quota applies as to any Open.
4. **Naming.** A bitmap's Document is named by `name` without its last `.png`, `.jpg`, `.jpeg` or `.gif` extension (and `.webp`, by ADR-0100), case-insensitive. With no `name`, or one that is only an extension, it is `Untitled`. An SVG keeps its rule, now also through MCP: `name` without `.svg` or `.kalamo.json` first, then `sodipodi:docname`, then `<title>`, then `Untitled`. A `.kalamo.json` keeps the name it stores.
5. **The browser sends bytes; the Worker tells a bitmap from text.** Open file (Document list, tab bar, File > Open) and a drop on the tab bar accept `image/*` as Place does, so a WebP or another image format reaches the Worker and gets Place's refusal instead of being ignored (a WebP is now converted, ADR-0100). The browser `POST`s the file's bytes unchanged to `/api/docs?name=<file name>`, the same route as before. The Worker reads the body under ADR-0049's 32 MiB cap. It treats the body as text when it starts, after a BOM and whitespace, with `<` or `{`, or when it is valid UTF-8 and does not start with `GIF8` or `RIFF`. Anything else is a bitmap: it becomes a data URL and goes through decision 1. A PNG's and a JPEG's first byte is never valid UTF-8; a GIF and a RIFF (WebP) file start with ASCII, so those two are told by their signature. A body over 5 MB that is a bitmap gets `checkImage`'s `LIMIT_EXCEEDED` with the size.

## Considered Options

- **A new tool such as `kalamo_image_open`.** It would duplicate Open's receipt, quotas and naming. Adding a tool also costs every Agent context tokens, for a case that `content` already covers.
- **Raw base64 in `content`, or a separate `bytes` argument.** Raw base64 cannot be told from other text reliably. A data URL is how every other Kalamo tool takes an image.
- **An http(s) URL, as `image_place` fetches (ADR-0027).** It is out of scope for #71. Open would then fetch from the Worker, which `image_place` already does for a Document that exists.
- **A sibling browser route such as `/api/docs/bitmap`, or choosing by `Content-Type` or extension.** The browser cannot be trusted to type a file, and ADR-0023 types bitmaps by their bytes. One route keeps Open as one entry point.
- **Treating every body that does not start with `<` or `{` as a bitmap.** A text file with neither, such as a mistyped `.json`, would fail with an image error. With the UTF-8 test, it keeps `INVALID_DOCUMENT`, which names what Open reads.
- **Strict UTF-8 alone, without the `<` / `{` test.** An SVG saved in Latin-1 is not valid UTF-8. It opened before (decoded with replacement characters), and would have become an `INVALID_IMAGE`.
- **Sizing by DPI.** Out of scope; Place also uses 1 pt per pixel. (Sizing by EXIF orientation was here; ADR-0101 does it: the Artboard is the upright size.)
