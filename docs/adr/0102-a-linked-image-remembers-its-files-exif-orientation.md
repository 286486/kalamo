---
status: accepted
date: 2026-10-02
---

# A linked Image remembers its file's EXIF orientation, and its SVG export undoes it

ADR-0101 stores an EXIF-oriented JPEG with its orientation value rewritten to 1 and composes the orientation into the Image's `transform`. That is right for every renderer that draws the stored pixels. A linked Image (ADR-0042) is exported in SVG's `link` mode as `xlink:href="<file>"`, though, and the user's file on disk still carries its tag. Inkscape 1.2.2 applies the tag, then the exported `transform` applies the orientation again: the photo turns or mirrors twice. ADR-0101 decision 12 recorded this limitation. This ADR fixes it (#252, the last part of #59).

Illustrator shows a placed photo upright once, whether it is linked or embedded. Kalamo must do the same in every viewer that reads its SVG.

Measured on `main` at 36d216c with Inkscape 1.2.2 headless, using #251's `orientedJpeg` fixtures written to disk with an SVG `<image xlink:href="oN.jpg">` beside each, rendered with `--export-area-page`. Quadrant colours were sampled in the upright box (top left, top right, bottom left, bottom right) and compared with `UPRIGHT_QUADRANTS`:

| o | export before this ADR (stored frame, composed transform) | upright box, no orientation transform | expected |
|---|---|---|---|
| 2 | RGBY | GRYB | GRYB |
| 5 | RGBY | RBGY | RBGY |
| 6 | YBGR | BRYG | BRYG |
| 7 | RGBY | YGBR | YGBR |
| 8 | YBGR | GYRB | GYRB |

The defect was real for every orientation other than 1, and writing the upright box makes Inkscape match `render`. Inkscape 1.2.2 also keeps an extra `kalamo:` attribute on an `<image>` when it saves.

## Decision

1. **The model.** `ImageNode.fileOrientation?: 2 | 3 | 4 | 5 | 6 | 7 | 8` is the EXIF orientation of the file that the stored pixels came from. It is valid only when the Image has both `file` and `src`. When it is absent, the linked file is upright or its orientation is unknown. The name follows Illustrator's `file`, and CONTEXT.md avoids "link". An embedded Image never has the field. A missing link never has it either: it has no pixels to orient, and its frame is already the box it shows.
2. **The Agent surface.** `node_get` `full` returns `fileOrientation` when it is present. `node_create` and `node_update` do not accept it, because it is derived from bytes, as `src`'s hash is. They refuse it as they refuse any unknown key: `INVALID_INPUT` at `nodes[i].fileOrientation`, and `INVALID_PATCH` at `updates[i].patch.fileOrientation`. The only description change is one clause in `kalamo_node_get`, within ADR-0088's budget.
3. **Set, keep and clear.**
   - **Set** to the orientation `neutraliseOrientation` read, when it is 2 to 8, wherever a data-URL file lands on an Image that has a `file`, or gets one in the same write. That covers `node_create` with `file` and a data-URL `src` (inline `children` too), `node_update` `src` (with or without `file` in the patch), and the `relink-image` route on a linked Image. The orientations already reach core as `orientations` (ADR-0101 decision 9), so `imageOf` in `createNodes` and `patched` in `updateNodes` record the field beside `orientedImage`.
   - **Cleared** by a Relink to an upright file. It is also cleared by `src` given as an image id: the stored bytes say 1, and the orientation of the user's file is unknown. Embed clears it (`file: null`, and the `embed` WebSocket command). Embed changes neither the pixels nor the transform, so the Image shows the same box.
   - **Kept** by `file` alone, for example a Relink to a renamed path. An embedded Image being linked has no field, so none appears. It is also kept by Duplicate, by undo and redo, by transforms, and by Copy and Paste within the Document, through the SVG attribute in decision 5. A paste into another Document arrives as a missing link, with the upright box and no field. A later Relink to the oriented file then composes its orientation, as ADR-0101 decision 7 says.
   - ADR-0101's rule that an orientation already composed into the transform stays is unchanged. The field describes the file, not the transform. The export removes exactly one orientation matrix, algebraically, whatever else the transform holds.
4. **SVG export, `link` mode only.** An Image with `fileOrientation` o is written as `orientedImage(image, inverseOrientation(o))`: the upright frame, the shown `preserveAspectRatio`, and `transform × M(o)⁻¹`. The `<image>` also carries `kalamo:fileOrientation="o"` beside `kalamo:src`. `inverseOrientation` maps 6 to 8 and 8 to 6, and every other orientation to itself. The `draw` mode (`render`, `export` PNG) is unchanged: it writes the neutral stored pixels with the composed transform. Embedded Images, and linked Images without the field, are written byte for byte as before.
5. **SVG import.** In `doc_open`, `svg_import` and the browser's Place and paste, a linked `<image>` whose `kalamo:src` resolves to pixels the target Document holds, and whose `kalamo:fileOrientation` is an integer from 2 to 8, is composed in `resolveLinks` with `orientedImage(box, o)`. That turns the frame, transform and `preserveAspectRatio` back into the stored pixels' terms, and the Image keeps the field. An unsized `<image>` of that kind takes the upright pixel size. When the link stays missing, or the attribute is absent or invalid, the box is imported as written, with no field. That is the behaviour before this ADR, so exports from before it load exactly as they did, including oriented ones written between #251 and this ADR. Nothing reads or fetches the linked file.
6. **`.kalamo.json`.** It saves `fileOrientation` when present, and `version` stays 1. Files without the field load unchanged. A value other than an integer from 2 to 8, or the field on an Image without both `file` and `src`, fails `INVALID_DOCUMENT` with `path` `nodes[i].fileOrientation`, as the other Image fields name theirs. Existing Documents are not rewritten.

### Why the export and the import are each one call

`orientedImage(image, o)` turns the frame about its centre, maps the alignment through the turn, and multiplies the orientation matrix in before the Image's transform: `T' = T × R(o)`, where `R(o)` is the linear part `L(o)` (one of ADR-0101 decision 4's eight matrices) about the frame's centre `c`. Applying it again with `inverseOrientation(o)` turns the frame back about the same centre, which the first turn kept. So:

- `T × R(o) × R(o⁻¹) = T`, because `L(o) × L(o⁻¹)` is the identity (`[0,1,-1,0] × [0,-1,1,0]` for 6 and 8, and every other `L(o)` is its own inverse), and both turns fix `c`.
- The frame's width and height swap twice for 5 to 8, and never for 1 to 4.
- Each stored axis's alignment is mapped through `L(o)` and back.

A core test checks `orientedImage(orientedImage(image, o), inverseOrientation(o))` equals `image` exactly, for all 8 orientations × {`none`, `xMinYMax meet`, `xMaxYMin slice`}, with an arbitrary rotation and scale as `T`. The export is therefore `T_user`, the transform the user added on top, and the import is the stored Image back.

### Verified

- Inkscape 1.2.2 headless, all 8 orientations, each with no transform and with a user mirror on top, the oriented file written beside the SVG: Inkscape's quadrants match `render`'s in all 16 cases.
- `pnpm roundtrip`'s fixture holds linked Images of an orientation-6 JPEG and of an orientation-7 one mirrored by the user, with the user's files written beside each SVG Inkscape reads. Their fields come back equal, and their Image regions are 0% off, within the 15% budget. With the export's inverse removed, the round trip fails at 53%.

## Considered Options

- **Write the stored frame and the composed transform, and strip the tag in a copy of the user's file.** Kalamo never writes the user's files (ADR-0042).
- **Write the upright box without remembering the orientation.** Kalamo cannot tell which part of a transform came from Exif (ADR-0101 decision 7), so it would not know what to undo.
- **Keep the orientation in the image file record (`doc.images`, R2) instead of on the Node.** One stored file can be linked from files with different orientations (ADR-0101 decision 1 stores them once). The orientation belongs to the linked Image, not to the pixels.
- **Read the linked file on import to learn its orientation.** Kalamo fetches nothing (ADR-0042).
- **Let Agents set the field.** A wrong value would turn the photo in Inkscape and nowhere else, where no Agent can see it.

## Consequences

- A linked photo from an oriented JPEG shows upright once in Kalamo, `render`, the canvas and Inkscape, and survives export, Inkscape's save, and re-import into the Document that holds its pixels.
- ADR-0042 is amended: the model gains `fileOrientation`, SVG `link` mode writes the upright box and `kalamo:fileOrientation`, import composes it back, and `.kalamo.json` saves it. ADR-0101 decision 9's "kept nowhere" gains this exception, and its decision 12 is resolved here.
- CONTEXT.md's Image and Embed entries, and REQUIREMENTS F-DOC-03's `image` row and F-IO-02, change to match.
