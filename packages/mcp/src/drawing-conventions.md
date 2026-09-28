# Drawing with Zibel

Read this once before your first write. Tool descriptions cover each call; this covers what holds across all of them.

## Coordinates

- Units are points (pt). The origin is the top-left of the Document; x grows right, y down.
- Every tool input (except a transformed Node's own parameters, below) and every `geometricBounds`, `visibleBounds` and `worldTransform` is in document coordinates. Artboards are regions of that one plane, not Nodes: read their placement from `artboards[].frame` in `zibel_doc_create` or `zibel_doc_get_info`, and add `frame.x` / `frame.y` to draw on an Artboard that is not at the origin.
- Angles are degrees, clockwise on screen. A `matrix` is `[a, b, c, d, e, f]` with SVG semantics.
- `zibel_node_transform` never rewrites a shape's parameters or a path's `d`: it gives the Node a `transform`. After that, the `x`, `y` or `d` you read with `zibel_node_get` (detail `full`) and write with `zibel_node_update` are in the Node's own coordinates; read where it is from `geometricBounds`. Layers and Groups never carry a transform, so creating Nodes inside a moved Group still takes document coordinates.

## Colours

- `#RRGGBB` or `#RRGGBBAA` only, case-insensitive: `#FF8800`, `#FF880080` for half opacity. No `rgb()`, no names, no 0–1 floats. An `INVALID_COLOR` hint gives the hex form of what you probably meant.
- Omit `appearance` for a white Fill and a 1 pt black Stroke (text: a black Fill, no Stroke). `{}` paints nothing.
- A Layer or Group takes an `appearance` too, and paints nothing without one. Its Fills and Strokes paint the outline of every visible Live Shape and path inside it, and the glyphs of every text, nested Groups and Clipping Masks included, on top of what each paints itself: each paint goes over all of them, in stacking order, before the next. `contents` places the children in that stack: it counts the paints, from the first Fill up through the Strokes, drawn below them. `{"strokes": [{"color": "#000000", "width": 6}], "contents": 1}` draws one outline around the union of overlapping shapes; with `contents` 0 (the default) the Stroke sits over every shape. A container's Strokes grow its `visibleBounds`, not its `geometricBounds`, and scale with `zibel_node_transform` like a leaf's. Inside a Clipping Mask they paint only within its Clipping Path. A container Fill paints a text's glyphs in its own colour, leaving the text's `ranges` fills to the text's own Fills. Images get no container paint. A container gradient is one field across all its children, in document coordinates: its geometry left out spans the container's `geometricBounds` (an empty container needs it given), it moves, turns and scales with `zibel_node_transform` on the container, and moving one child slides the child through it.
- On `zibel_node_update`, a `fills` or `strokes` list you send replaces that list entirely, so include every Fill or Stroke you want to keep; a list you omit is kept.
- A Fill or Stroke can be a gradient instead of a `color`: `{"type": "gradient", "gradient": {...}}`, linear or radial, with at least 2 Color Stops `{"offset": 0–1, "color": "#RRGGBB[AA]"}`; a stop's alpha is its opacity, and beyond the first and last stop the colour holds. Positions are in the Node's own coordinates, so they move, turn and scale with `zibel_node_transform`, and stay put when you edit its parameters or `d`.
  - Linear: `{"type": "linear", "stops": [...], "start": {"x": 0, "y": 50}, "end": {"x": 200, "y": 50}}`. Leave out `start` and `end` to span the Node's bounds, left to right, or along `angle` (degrees clockwise, 90 is top to bottom; not stored).
  - Radial: `{"type": "radial", "stops": [...], "center": {"x": 100, "y": 50}, "radius": 100, "aspectRatio": 0.5, "angle": 30, "focus": {"x": 120, "y": 50}}`. All but `stops` may be left out: `center` is the bounds' centre, `radius` Illustrator's default, `aspectRatio` (the radius across `angle`) 1, `angle` 0, `focus` (where the first stop sits) the centre.
  - What you left out is stored filled in; `zibel_node_get` with detail `full` shows where it landed. A gradient does not change bounds.

## Path data (`d`)

- Absolute `M`, `L`, `C`, `Q` and `Z` only, uppercase. Numbers are stored with at most 3 decimals. Write `H` and `V` as `L`, `S` as `C`, `T` as `Q`, and arcs `A` as `C`.
- Start with `M x y`. Extra pairs after `M` are implicit `L`. `Z` closes the subpath.
- Example, a closed triangle and a curve: `M 0 0 L 100 0 L 50 80 Z M 0 100 C 30 60 70 140 100 100`.
- To cut a hole, make a Compound Path: put the hole as another subpath of the same `d` and set `fillRule: "evenodd"`, e.g. `M 0 0 L 100 0 L 100 100 L 0 100 Z M 30 30 L 70 30 L 70 70 L 30 70 Z`. Under the default `nonzero`, an inner subpath is a hole only when it winds the other way.
- Prefer a Live Shape (`rect`, `ellipse`, `line`, `polygon`, `star`) to a path when one fits: its parameters stay editable.
- Only tool input is held to these commands: an SVG opened with `zibel_doc_open` may use any path data, and it is stored in this form.

## Structure

- A Document holds Artboards and Layers. Layers hold Groups and shapes; Groups hold Groups and shapes.
- Every Node you create needs `parentId`, the id of a Layer or Group, never an Artboard. A Layer's parent is the root (omit `parentId`) or another Layer. `zibel_doc_create` returns `defaultLayerId` for your first Nodes.
- Build Layers first, one per part of the picture (background, content, labels), then Groups inside them, then shapes. A `group` can carry its `children` inline in the same `zibel_node_create` call.
- Ids come from the server. Give each item a `clientKey` and read its new id from the receipt's `keyMap`.
- Give Layers and Groups a `name`. `tags` and `meta` are yours: use them to find Nodes again with `zibel_node_query`.
- Children are painted bottom to top in the order you create them.

## Clipping Masks

- To show artwork only inside a shape, draw the shape as a sibling of the artwork, then call `zibel_mask_make` with the shape as `clipNodeId` and the artwork as `contentIds`. They move into a new Group, the Clipping Mask, whose `geometricBounds` are the shape's.
- The shape becomes the Group's Clipping Path: it clips and is never painted, so it loses its Fills and Strokes, and it cannot be hidden. A text cannot clip yet.
- `clipping` is read-only to `zibel_node_update`: release with `zibel_mask_release`, which keeps the Group and leaves the shape unpainted.

## Workflow

1. Before a round of writes, call `zibel_doc_changes` with the `rev` you last saw (or `zibel_doc_get_info` the first time) to learn what a person changed since.
2. Create the skeleton: Layers and named, empty Groups.
3. Fill it in batches, one `zibel_node_create` per part.
4. Check with `zibel_render` and `overlays: ["bounds", "ids"]`, then fix what is off.
5. Guard key writes with `ifRev` set to the `rev` you last read: if anyone committed since, the write fails with `REV_CONFLICT` and changes nothing. Then call `zibel_doc_changes`, look at what changed, and retry.

## Transactions

- Use one when several writes should land and undo as one step, or when `zibel_doc_get_info` shows `browsers` above 0 and a person should not watch a half-built drawing.
- `zibel_tx_begin` returns a `txId`. Pass it to every write and to the reads (`zibel_node_get`, `zibel_node_query`, `zibel_doc_outline`, `zibel_render`, `zibel_export`) to see your uncommitted work. Nobody else sees it until `zibel_tx_commit`; put `intent` there. `zibel_tx_rollback` discards it.
- A Transaction rolls back after 5 minutes without a call carrying its `txId`.
- If someone deleted a Node you edited meanwhile, the commit fails with `NODE_GONE` and the Transaction stays open: roll it back and redo the work.

## Checking what you drew

- `zibel_render` returns a PNG of the whole Document, one Artboard, some Nodes or a rect. It lowers the scale to fit `maxSize` (default 1600 px); `viewport` maps pixels back to document coordinates.
- `zibel_export` with `format: "svg"` returns the drawing as SVG text when you need exact geometry.

## Saving and opening

- `zibel_export` with `format: "zibel_json"` returns the whole Document as `.zibel.json` text, the file to save.
- `zibel_doc_open` with that text as `content` makes a new Document with its own docId; every Node and Artboard keeps its id. A file that fails validation creates nothing, and `INVALID_DOCUMENT` (or the usual colour, path or parent code) names the `path` inside the file.
- `zibel_doc_open` also takes SVG text, told apart by content: Zibel's own `zibel_export` SVG, a file saved in Inkscape, or plain SVG 1.1, at most 5 MB outside its embedded images (else `LIMIT_EXCEEDED`). Layers, pages, names, locks and `z-<id>` ids come back; units become pt, with px counting as pt. Clipping comes back as Clipping Masks, and embedded PNG, JPEG and GIF images as Images. Linear and radial gradients come back as gradients. What Zibel cannot hold yet (a clip it cannot hold, masks, filters, linked or WebP images and `<use>` are dropped) is listed once per kind in `warnings`; it never fails the open.
- A file edited elsewhere, such as an export saved in Inkscape, comes back with `zibel_doc_open` as a new Document; keep working in it, or move Nodes into the original with `zibel_export` (`format: "svg"`, `scope: {nodeIds}`) and `zibel_svg_import`.
- To add an SVG to a Document you are working on, use `zibel_svg_import`: it places the file as one new Group under the Layer or Group you name, with its layers as Groups and every id new, centred on the parent's Artboard or on `position`, and scaled to fit that Artboard with `fit: true`.

## Text

- Point Type (`kind: "point"`, the default) starts its first baseline at `x, y` and breaks lines only at `\n` in `content`.
- Area Type (`kind: "area"` with `width` and `height`) wraps `content` at spaces inside the frame `x, y, width, height`. Text that does not fit, including a word wider than the frame, is not drawn, and the receipt warns `TEXT_OVERFLOW`: enlarge the frame or shorten the content.
- `leading` is the distance between baselines in pt; omit it for Auto, 120% of `fontSize`. `node_update` with `leading: null` returns to Auto.
- `fontFamily` takes any font name and keeps it, so export writes it back. Only Source Sans 3 is bundled: another font renders and measures in it, and the receipt warns `FONT_MISSING`.
- `fontStyle` is the style name, default `Regular`: Regular, Italic, Bold, Bold Italic, Black and Black Italic are bundled. Use them for weight and slant instead of faking bold with a Stroke. Thin, ExtraLight, Light, Medium, Semibold and ExtraBold (and their Italics) are kept and exported, but render in the nearest bundled face, and the receipt warns `FONT_MISSING`.
- `tracking` is the space after each character, in 1/1000 em (Illustrator's Character panel), from -1000 to 10000.
- For per-letter colour, bounce or tilt, write one text with `ranges`, not one Node per letter: `{"content": "LITTLE", "tracking": 100, "ranges": [{"start": 0, "end": 1, "fill": "#E63946", "rotation": -8}, {"start": 1, "end": 2, "fill": "#F4A261", "baselineShift": 3}]}`. `start` and `end` count characters of `content` (a `\n` counts), `end` exclusive. `fill` replaces every Fill's colour for those characters, `baselineShift` raises them in pt, and `rotation` turns each one clockwise about its own baseline origin. Overlapping ranges are merged, the later winning, and `zibel_node_get` returns them sorted and merged.
- A `zibel_node_update` that writes `content` without `ranges` clears the ranges, since their indices would land on other characters. To change both, send both.

## Images

- Place a PNG, JPEG or GIF with `zibel_node_create` `{type: "image", src, x, y}`, `src` being a `data:` URL of the file. A GIF shows its first frame. WebP is refused with `INVALID_IMAGE`: convert it to PNG first. A file is at most 5 MB.
- For a file on the web, `zibel_image_place` with its http(s) URL fetches it on the server, so the bytes never cost you tokens. It centres the Image on the parent's Artboard unless you give `frame`.
- To trace a reference, place it with `asTemplate: true`: a locked Template Layer beneath your Layer, the Image at 50% opacity. Draw on your own Layer above it. It still renders and exports: hide or delete the Template Layer before `zibel_export`.
- The receipt and `zibel_node_get` give the Image's `src` as an id, the file's SHA-256, never the bytes. Pass that id as `src` to place the same file again without resending it.
- Omit `width` and `height` for the file's pixel size, one pt per pixel, or give both. `preserveAspectRatio` is SVG's: `none` (the default) stretches the file to the frame, `xMidYMid meet` fits it inside, `xMidYMid slice` fills the frame and crops the rest.
- To crop to any shape, draw the shape over the Image and call `zibel_mask_make`. An Image cannot be the clip, and has no `appearance`.
- To swap the file (Relink), `zibel_node_update` the Image's `src` with a `data:` URL or an image id; the frame, `preserveAspectRatio`, transform, name and Clipping Mask stay. `file` names a linked file, and `file: null` embeds a linked Image, which needs `src` first or in the same patch.

## Reading a Document

Go from coarse to fine: `zibel_doc_outline` for the Layer tree, `zibel_node_query` to find Nodes by type, name, tags, parent or area, and `zibel_node_get` for the properties of the few you will change.

## Errors

- A failed call returns `{code, message, hint, path}`: `hint` says what to do next and `path` names the field.
- Arguments the input schema rejects, unknown names included, return `INVALID_INPUT`: `path` names the field and `hint` the closest known name, or what to send. A misspelled argument fails the call; it is never ignored.
- A hosted beta Quota's `LIMIT_EXCEEDED` also carries `limit: {name, limit, used, resetsAt?}`: `name` is `documents` (50 you own), `storage` (200 MB of image files across the Documents you own), `document_storage` (20 MB in one Document), `render` or `export` (500 and 200 calls per UTC day, every export format counted; `resetsAt` is when the count resets) or `connections`. Tell the user the numbers; do not retry a daily limit before `resetsAt`.
- Common mistakes: an Artboard id as `parentId` (`INVALID_PARENT`), `rgb()` or named colours (`INVALID_COLOR`), lowercase or `H`/`V`/`A` path commands (`INVALID_PATH`), `transform` in a `zibel_node_update` patch (`INVALID_PATCH`: use `zibel_node_transform`), `parentId` in a patch (`INVALID_PATCH`: a Node cannot move to another parent yet), `clipping` in a patch (`INVALID_PATCH`: use `zibel_mask_make` or `zibel_mask_release`).

## Limits

- 2000 Nodes per `zibel_node_create`, counting inline children; 1000 per `zibel_node_update`, `zibel_node_delete` or `zibel_node_get`.
- Rendered images at most 4096 px on their longer side.
- Image files at most 5 MB each; an SVG at most 5 MB outside its embedded images.
- Pages of at most 1000 entries for `zibel_node_query` and `zibel_doc_changes`.
