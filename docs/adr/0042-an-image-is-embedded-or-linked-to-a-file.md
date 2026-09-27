---
status: accepted
date: 2026-09-27
---

# An Image is embedded or linked to a file, and a linked Image may hold a copy of its pixels

Inkscape and Illustrator SVGs often link their photos (`xlink:href="photo.png"`) rather than embed them. ADR-0023 made every Image embedded, so import drops those `<image>`s with `LINKED_IMAGE_DROPPED`, and nothing in Zibel can hold the reference to write it back (F-IO-02 "link or embed", #60, spec #97). This ADR supersedes ADR-0023's "Embedded only" and "`src` is read-only" points. The rest of ADR-0023 stands: content-hash ids, the `images` table and its chunks, and "stored before the write that names it".

## The model

- **`file`**, optional on an Image, is the linked file's path or URL as the SVG wrote it: relative, absolute, `file:` or `http(s):`. It is a non-empty string that is not a `data:` URL, at most 2048 characters. Anything else fails `INVALID_IMAGE`, since a data URL belongs in `src` and its checks. The name is Illustrator's PlacedItem `file`. `link` would clash with CONTEXT.md, which avoids "Link" because of Connectors.
- An Image without `file` is **embedded**, as before. One with `file` is **linked**. F-DOC-03's `embedded` flag is derived from `file` being absent, not stored, because a stored boolean could contradict `file`.
- **`src` becomes optional.** Only a linked Image may lack it, so every Image has `src`, `file` or both. A linked Image without `src` is a **missing link**. A linked Image with `src` draws those stored pixels. Zibel never checks them against the file on disk, because the Worker cannot read the disk. Illustrator's "modified" link state therefore does not exist here.
- Why keep pixels on a linked Image at all: without them, every linked Image would be a crossed frame in `render`, and an Agent could never see it.

## MCP

- `node_create` image takes `file`. `src` may then be left out, and `width` and `height` are required, because a missing link has no pixel size to default to. `file` together with `src` makes a linked Image with pixels. Embedded creation is unchanged.
- `node_get` `full` returns `file` when present and `src` when present, never bytes. An Agent finds the Images that need relinking as those with `file` and no `src`.
- `node_update` of `src` and `file` (Relink and Embed) is #101. `image_place` stays embed-only (ADR-0027).
- `doc_open` and `svg_import` read linked `<image>`s (below). `LINKED_IMAGE_DROPPED` is gone; the import warning `IMAGE_LINK_MISSING` joins, reported once per import.

## SVG

The writer takes a choice of how a linked Image is drawn, so one SVG writer serves both uses, as ADR-0023 has `render` write the same SVG as `export`:

- **`link`**, the default, is used by `export` SVG, Download SVG and Copy. It writes `<image … xlink:href="<file>">`, with `xlink:` because Inkscape 1.2.2 draws nothing for a plain `href` (ADR-0023). A linked Image with pixels also carries `zibel:src="<id>"`, so a paste into the same Document gets its pixels back. The pixels themselves are never written. An embedded Image is written as before.
- **`draw`** is used by `render` and `export` PNG. It writes a linked Image's stored pixels as a data URL, as for an embedded one. A missing link is drawn the way Illustrator draws an unresolved placed file: its frame and both diagonals in a grey (`#999999`) one-pixel stroke, with the Image's id, opacity and visibility. The Image's transform is applied to the points rather than written as `transform`, so the stroke stays one pixel however the Image is scaled. resvg does not honour `vector-effect: non-scaling-stroke` (measured: a 2x Image drew a 2 px line).

Inkscape 1.2.2 keeps a relative `xlink:href`, the frame, `preserveAspectRatio` and `zibel:src` on save, even when the file is not beside the SVG (measured headless). It shows its own broken-image icon where Zibel draws the crossed frame. `pnpm roundtrip` checks this with a missing link to `photos/red.png`. Saved into another folder, Inkscape rewrites a relative href against that folder (`../photos/red.png`), so the round trip saves over its input.

Import (#99):

- An `<image>` whose `xlink:href` or `href` is not a `data:` URL becomes a linked Image with `file` set to the trimmed href. The frame, transform and `preserveAspectRatio` follow the embedded `<image>` rules (ADR-0023). An empty href, or one `file` refuses, is dropped with `INVALID_IMAGE`. Nothing is fetched, so `doc_open` and `svg_import` stay closed-world. `sodipodi:absref` is neither read nor written.
- A `zibel:src` holding an image id is offered as the Image's `src`, and is kept only when the target Document holds that image. For Open that is the file's own embedded images; for Place, which Copy and Paste use, the Document's images once the file's are stored. So a linked Image pasted into its own Document keeps its pixels, and one pasted into another Document arrives as a missing link.
- Every linked Image that comes in without pixels makes the warning `IMAGE_LINK_MISSING`. One without `width` or `height` takes the missing size from its resolved pixels, and is dropped with `INVALID_IMAGE` when there are none, since nothing else gives its size.

## `.zibel.json`

An Image may carry `file`, and may omit `src` when it does. `images` still holds exactly the ids some `src` names. Open checks that every Image has `src` or `file` and that `file` is valid, and runs the existing `images.<id>` checks. A failure is `INVALID_DOCUMENT` with a `path`. `version` stays 1, and existing files load unchanged.

## Considered Options

- **A stored `embedded` boolean beside `file`.** F-DOC-03 names it, but the two fields could disagree.
- **Linked Images without pixels only.** This is simpler, but `render` could then never show a linked photo, and an Agent would work blind.
- **Checking the stored pixels against the linked file.** The Worker cannot read a designer's disk, and fetching `http(s)` links needs ADR-0027's SSRF rules. This waits for its own issue.
- **SVG 2's plain `href`.** Inkscape 1.2.2 does not draw it.

## Consequences

- `ImageNode.src` is optional in core. Every reader of `src` handles a missing link, and the canvas draws nothing for one until #100 draws its crossed frame.
- No new error codes. `INVALID_IMAGE` also covers an invalid `file`.
- A Links panel, Unembed that writes the file to disk, fetching linked `http(s)` files, `sodipodi:absref`, and resolving relative paths against the SVG's location are out of scope (#97).
- F-DOC-03's `image` row, F-IO-02, the `node_create` row and §10.2 change to match (REQUIREMENTS).
