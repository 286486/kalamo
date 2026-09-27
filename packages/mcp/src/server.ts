import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ArtboardInput,
  Color,
  FreehandStrokeInput,
  freehandPath,
  imageFrame,
  MaskInput,
  NodeInput,
  NodeQuery,
  NodeType,
  PathEditInput,
  PathOpInput,
  parseColor,
  RenderOverlay,
  RenderScope,
  TransformInput,
  UpdateInput,
  WriteReceipt,
  ZibelError,
} from "@zibel/core";
import type { DocumentService, Viewport } from "@zibel/sync";
import { z } from "zod";
import conventions from "./drawing-conventions.md";
import {
  ChangesOutput,
  CreatedDocumentOutput,
  DocInfoOutput,
  DocListOutput,
  ExportOutput,
  NodeGetOutput,
  NodeQueryOutput,
  OpenedDocumentOutput,
  OutlineOutput,
  PathEditOutput,
  PlacedOutput,
  RenderOutput,
  TxOutput,
} from "./schemas.ts";

const CONVENTIONS = "skill://zibel/drawing-conventions";
const docId = z.string().describe("Document id returned by zibel_doc_create.");
const intent = z
  .string()
  .max(500)
  .optional()
  .describe("One sentence on what this write is for, shown to people editing the Document.");
const txId = z
  .string()
  .describe("Transaction id from zibel_tx_begin. Only the Actor that began it can use it.");
const readTxId = txId
  .optional()
  .describe("Transaction id from zibel_tx_begin: also show its uncommitted edits.");
const ifRev = z
  .number()
  .int()
  .optional()
  .describe(
    "Fail with REV_CONFLICT, changing nothing, unless the Document's committed rev equals this: set it to the rev you last read so you never overwrite someone else's newer edit.",
  );
/** Accepted by every Node write (§6.4). */
const writeFields = {
  intent,
  txId: txId
    .optional()
    .describe(
      "Transaction id from zibel_tx_begin. The write stays invisible to others until zibel_tx_commit, and the receipt's rev stays the committed rev. intent is then ignored: give it to zibel_tx_commit.",
    ),
  ifRev,
  partial: z
    .boolean()
    .default(false)
    .describe(
      "false: one bad item fails the call and changes nothing. true: apply the valid items and list the others in the receipt's failed.",
    ),
};
const coordinates = `A Live Shape's parameters, a path's d and a text's x, y are in the Node's own coordinates, mapped to the Document by its transform; geometricBounds says where it is (${CONVENTIONS}).`;
const edit = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const scopes =
  "scope is one of {artboardId}, {nodeIds} or {rect: {x, y, width, height}} in document coordinates; omitted, the whole Document (every Artboard). An Artboard or rect draws everything inside it. nodeIds draws only those Nodes and what they contain, framed by their visibleBounds, with no Artboard background.";
const scope = RenderScope.optional();
const scale = z.number().positive().max(4).default(1);
const background = Color.optional().describe(
  "Fills the whole image beneath everything; otherwise pixels outside every Artboard are transparent.",
);
/** Parses `background` here, so a bad colour is INVALID_COLOR with a hint (§6.5). */
const color = (value: unknown) =>
  value === undefined ? undefined : parseColor(value, "background");

/** A fresh server per request: MCP is stateless (ADR-0006). */
export function createMcpServer(service: DocumentService, actor: string): McpServer {
  const server = new McpServer(
    { name: "zibel", version: "0.0.0" },
    { instructions: `Before your first write, read the resource ${CONVENTIONS}.` },
  );

  // The SDK advertises resources.listChanged but never sends it; no resources/subscribe (ADR-0006).
  server.registerResource(
    "drawing-conventions",
    CONVENTIONS,
    {
      title: "Drawing conventions",
      description:
        "Coordinates, colours, path d, Layer-first structure, Transactions and the write-check workflow. Read before your first write.",
      mimeType: "text/markdown",
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: conventions }] }),
  );

  /** Runs a tool handler, maps ZibelError to an error result and logs one line per call (§7.7). */
  const run = async (tool: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    const start = Date.now();
    let result: CallToolResult;
    let code: string | null = null;
    try {
      result = await fn();
    } catch (e) {
      if (!(e instanceof ZibelError)) throw e;
      code = e.data.code;
      result = { isError: true, content: [{ type: "text", text: JSON.stringify(e.data) }] };
    }
    const out = result.structuredContent ?? {};
    const ids = (k: string) => (Array.isArray(out[k]) ? out[k].length : 0);
    console.log(
      JSON.stringify({
        actor,
        tool,
        ms: Date.now() - start,
        nodes: ids("createdIds") + ids("updatedIds") + ids("deletedIds"),
        code,
        rev: typeof out.rev === "number" ? out.rev : null,
      }),
    );
    return result;
  };

  server.registerTool(
    "zibel_doc_create",
    {
      title: "Create Document",
      description: `Create a Document with one or more Artboards. Returns docId and the id of its default Layer, which is the parent for your first Nodes. Read ${CONVENTIONS} before your first write.`,
      inputSchema: {
        name: z.string().min(1),
        artboards: z.array(ArtboardInput).min(1).max(1000),
        intent,
      },
      outputSchema: CreatedDocumentOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => run("zibel_doc_create", async () => json(await service.create(args))),
  );

  server.registerTool(
    "zibel_doc_open",
    {
      title: "Open Document",
      description: [
        "Make a new Document from a file's text: .zibel.json as zibel_export returns it with format zibel_json, or SVG (Inkscape, Zibel's own export or plain SVG 1.1, at most 5 MB outside its embedded images, each image at most 5 MB), told apart by content. Pass the file's content, not a path.",
        "The new Document gets its own docId and starts at rev 1. Ids from .zibel.json, and z-<id> ids from SVG, are kept; SVG layers and pages become Layers and Artboards, units become pt (px counts as pt). nodes is its Layer list, as zibel_doc_outline returns it at depth 1.",
        "Embedded PNG, JPEG and GIF images come back as Images; a linked image is dropped with LINKED_IMAGE_DROPPED. SVG content Zibel cannot hold yet (patterns, mesh gradients, filters, masks, WebP) imports as close as it can, or is dropped, and warnings lists each kind once. A file that is not valid fails with a path into it and creates nothing.",
      ].join(" "),
      inputSchema: {
        content: z.string().min(1).describe("The whole .zibel.json or .svg text."),
        intent,
      },
      outputSchema: OpenedDocumentOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => run("zibel_doc_open", async () => json(await service.open(args))),
  );

  server.registerTool(
    "zibel_node_create",
    {
      title: "Create Nodes",
      description: [
        "Create Nodes in one atomic write: one bad item fails the call and creates nothing.",
        "Each node needs parentId, the id of a Layer or Group, never an Artboard; a layer omits it to sit at the Document root.",
        "Types:",
        "layer {name}: parent is the root or another Layer.",
        "group {children}: children are nodes of any type but layer, without parentId, created inside the Group.",
        "rect {x, y, width, height, radius}: radius is the corner radius.",
        "ellipse {x, y, width, height, startAngle, endAngle, arcType}: x, y, width, height is its bounding box. startAngle and endAngle cut a pie, in degrees clockwise from 3 o'clock, default 0 and 360 for the whole ellipse; they are parametric, so a stretched pie keeps its share of the outline. arcType closes the ends: slice through the center (default), chord straight across, open not at all.",
        "line {x1, y1, x2, y2}.",
        "polygon {cx, cy, radius, sides, angle, rounded, randomized}: radius is center to vertex.",
        "star {cx, cy, outerRadius, innerRadius, points, angle, twist, rounded, randomized}.",
        "On both, angle turns the first vertex, in degrees clockwise from straight up; a star's twist turns its inner vertices clockwise off the half step, in degrees; rounded is Inkscape's rounding, the handle length at each vertex as a fraction of the edge (0 sharp); randomized is Inkscape's jitter, as a fraction of the larger radius (0 regular). rounded and randomized are -10 to 10, all default 0.",
        "path {d, fillRule}: SVG path data with absolute M, L, C, Q and Z only. Several subpaths with fillRule evenodd cut holes (a Compound Path); default nonzero.",
        "text {x, y, content, fontSize, leading, tracking, ranges}: Point Type; x, y is where the baseline of the first character starts, and content breaks only at \\n. With kind \"area\" and width, height it is Area Type: x, y, width, height is its frame, content wraps at spaces, and what does not fit is not drawn and warns TEXT_OVERFLOW. fontSize is in pt, default 12; leading is the distance between baselines in pt, omitted for Auto (120% of fontSize). fontFamily is any font name, kept as written; only Source Sans 3 is bundled, so others render in it and the receipt warns FONT_MISSING. fontStyle is the Illustrator style name, default Regular: Regular, Italic, Bold, Bold Italic, Black and Black Italic are bundled; Thin, ExtraLight, Light, Medium, Semibold, ExtraBold and their Italics are kept but render in the nearest bundled face and warn FONT_MISSING. tracking is the space after each character in 1/1000 em, -1000 to 10000, default 0. ranges are Character Ranges [{start, end, fill, baselineShift, rotation}] over content's characters (code points, \\n included), end exclusive; a later range wins attribute by attribute, and they are stored canonical. fill replaces every Fill's colour for those characters; baselineShift raises them in pt; rotation turns each in degrees clockwise about its baseline origin.",
        "image {src, x, y, width, height, preserveAspectRatio}: src is a data: URL of a PNG, JPEG or GIF file (WebP is refused: convert it to PNG), or the src id of an Image already in the Document, which reuses its file without resending it; x, y, width, height is its frame, width and height both or neither, default the file's pixel size at 1 pt per pixel; preserveAspectRatio is SVG's, default none (stretch to the frame). An image has no appearance; crop one with zibel_mask_make.",
        "Live Shapes, paths and text take appearance {fills: [{color}], strokes: [{color, width, cap, join, miterLimit, dash}]}; omit it for a white Fill and a 1 pt black Stroke, or on text a black Fill and no Stroke.",
        'A Fill or Stroke may instead be {type: "gradient", gradient}, with gradient {type: "linear", stops, start, end} or {type: "radial", stops, center, radius, aspectRatio, angle, focus}; stops are at least 2 {offset 0-1, color}, the color\'s alpha is the stop\'s opacity. Positions are in the Node\'s own coordinates and move with zibel_node_transform. Leave the geometry out to span the Node\'s bounds: linear left to right, or along angle (degrees clockwise, not stored); radial from the center with Illustrator\'s radius. aspectRatio scales the radius across angle; focus is where the first stop sits. zibel_node_get detail full returns the full geometry.',

        "Give each node a clientKey to find its new id in the receipt's keyMap.",
        "At most 2000 Nodes per call, counting inline children.",
        "Also accepts tags and meta (any JSON) on each node.",
        `Coordinates, colours, d and defaults: ${CONVENTIONS}.`,
      ].join(" "),
      inputSchema: { docId, nodes: z.array(NodeInput).min(1), ...writeFields },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, nodes, ...opts }) =>
      run("zibel_node_create", async () => json(await service.createNodes(docId, nodes, opts))),
  );

  server.registerTool(
    "zibel_svg_import",
    {
      title: "Place SVG",
      description: [
        "Place an SVG into a Document, as Illustrator's File > Place: one new Group under parentId (a Layer or Group), above its other children, named from the SVG's sodipodi:docname or <title>, else Untitled (rename it with zibel_node_update). Pass the file's content, not a path; at most 5 MB outside its embedded images, each image at most 5 MB.",
        "SVG layers become Groups, pages and page backgrounds are dropped, and every Node gets a new id, so placing a file twice, or one exported from this Document, never collides. Units become pt, with px counting as pt.",
        "position is where the centre of the Group's geometricBounds lands, in document coordinates; default the centre of the parent's Artboard, the one the parent overlaps most, else the first. fit: true first scales the Group uniformly, Strokes included, to fit that Artboard.",
        "A Zibel copy, the SVG zibel_export writes at scope {nodeIds}, is pasted instead, as Illustrator's Edit > Paste: the Nodes it lists, and anything added beside them since, go directly under parentId in stacking order without the Group, with the Layers and Groups that only held them dropped.",
        "One Transaction. createdIds starts with what went under parentId, the Group or the pasted Nodes, and nodes is their outline to depth 2. Embedded images become Images; warnings lists once per kind what Zibel cannot hold yet, as zibel_doc_open does. A .zibel.json is INVALID_DOCUMENT.",
      ].join(" "),
      inputSchema: {
        docId,
        svg: z.string().min(1).describe("The whole .svg text."),
        parentId: z.string().describe("A Layer or Group id to place the new Group in."),
        position: z
          .object({ x: z.number(), y: z.number() })
          .optional()
          .describe("Where the Group's centre lands, in document coordinates."),
        fit: z
          .boolean()
          .default(false)
          .describe("Scale uniformly, Strokes included, to fit the parent's Artboard."),
        intent,
        txId: writeFields.txId,
        ifRev,
      },
      outputSchema: PlacedOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, ...input }) =>
      run("zibel_svg_import", async () => json(await service.place(docId, input))),
  );

  server.registerTool(
    "zibel_image_place",
    {
      title: "Place Image",
      description: [
        "Place a PNG, JPEG or GIF as an Image, as Illustrator's File > Place, so its bytes never pass through you.",
        "src is a public http or https URL, which the server fetches: at most 10 s and 20 MB read, following at most 5 redirects; localhost and private, loopback or link-local addresses are refused, and any fetch that fails is FETCH_FAILED. src may instead be a data: URL. A local path is refused: the server cannot read your disk.",
        "The format comes from the file's bytes, not its Content-Type; WebP is refused (convert it to PNG), and a file over 5 MB is LIMIT_EXCEEDED.",
        "frame {x, y, width, height} is as zibel_node_create's image takes it, width and height both or neither (default the file's pixel size at 1 pt per pixel); omitted, the Image is centred on the parent's Artboard.",
        "asTemplate: true makes a Template Layer for a reference to trace: a new locked Layer named Template <file name>, directly beneath the Layer holding parentId, with the Image at 50% opacity. It still renders and exports: hide or delete it before zibel_export.",
        "One Transaction; createdIds lists the Template Layer, if any, then the Image.",
      ].join(" "),
      inputSchema: {
        docId,
        src: z.string().min(1).describe("An http(s) URL of the file, or a data: URL."),
        parentId: z.string().describe("A Layer or Group id to place the Image in."),
        frame: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
          })
          .superRefine(imageFrame)
          .optional()
          .describe("The Image's frame in the parent's coordinates."),
        asTemplate: z
          .boolean()
          .default(false)
          .describe("Put it on a new locked Template Layer, at 50% opacity."),
        intent,
        txId: writeFields.txId,
        ifRev,
      },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ docId, ...input }) =>
      run("zibel_image_place", async () => json(await service.placeImage(docId, input))),
  );

  server.registerTool(
    "zibel_node_update",
    {
      title: "Update Nodes",
      description: [
        "Change Nodes with one JSON Merge Patch (RFC 7396) each: objects merge, null deletes a key, arrays and everything else replace.",
        "Writable on every Node: name, visible, locked, opacity (0-1), blendMode (stored, not rendered yet), tags, meta. A Live Shape or path also takes its parameters (see zibel_node_create) and appearance; a path takes d; a text takes content, fontFamily, fontStyle, fontSize, leading (null for Auto), tracking, ranges, x, y and appearance, and an Area Type also width and height; a text's kind is fixed. Writing content without ranges clears them, ranges: null clears them, and ranges replaces the whole list. An image takes x, y, width, height and preserveAspectRatio; its src is read-only.",
        "fills and strokes replace as a whole list, so send every Fill or Stroke you want to keep; a gradient's geometry left out is taken from the Node's bounds after the patch.",
        "Move, rotate or scale with zibel_node_transform; transform, type, parentId and derived bounds are read-only.",
        coordinates,
      ].join(" "),
      inputSchema: {
        docId,
        updates: z.array(UpdateInput).min(1).max(1000),
        ...writeFields,
      },
      outputSchema: WriteReceipt.shape,
      annotations: edit,
    },
    ({ docId, updates, ...opts }) =>
      run("zibel_node_update", async () => json(await service.updateNodes(docId, updates, opts))),
  );

  server.registerTool(
    "zibel_node_delete",
    {
      title: "Delete Nodes",
      description:
        "Delete Nodes and everything inside them. The receipt's deletedIds lists every removed id, descendants included; bounds is where they were.",
      inputSchema: {
        docId,
        nodeIds: z.array(z.string()).min(1).max(1000),
        ...writeFields,
      },
      outputSchema: WriteReceipt.shape,
      annotations: edit,
    },
    ({ docId, nodeIds, ...opts }) =>
      run("zibel_node_delete", async () => json(await service.deleteNodes(docId, nodeIds, opts))),
  );

  server.registerTool(
    "zibel_node_transform",
    {
      title: "Transform Nodes",
      description: [
        "Move, rotate, scale, skew or reflect Nodes about a reference point (the pivot, as in Illustrator's Transform panel), in document coordinates.",
        "Several parts compose as: scale, then skew, then rotate, all about the pivot, then translate. matrix [a, b, c, d, e, f] replaces rotate, skew and scale; [-1, 0, 0, 1, 0, 0] reflects across the pivot.",
        "pivot is center (default), topLeft, top, topRight, left, right, bottomLeft, bottom or bottomRight of the targets' geometricBounds, or {x, y}. With each: true every target turns about its own pivot; otherwise all share one.",
        "Transforming a Layer or Group transforms every Node inside it; updatedIds lists those Nodes. Live Shapes keep their parameters and gain a transform.",
        "scaleStrokes (default true) scales Stroke widths with the shape. The receipt's bounds are the new bounds.",
      ].join(" "),
      inputSchema: TransformInput.safeExtend({ docId, ...writeFields }),
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, intent, partial, txId, ifRev, ...input }) =>
      run("zibel_node_transform", async () =>
        json(await service.transformNodes(docId, input, { intent, partial, txId, ifRev })),
      ),
  );

  /** The write options of a tool without partial. */
  const txWrite = { intent, txId: writeFields.txId, ifRev };
  server.registerTool(
    "zibel_mask_make",
    {
      title: "Make Clipping Mask",
      description: [
        "Clip Nodes by a shape, as Illustrator's Object > Clipping Mask > Make: a new Group, the Clipping Mask, takes the place of the topmost of them and holds clipNodeId and contentIds in their stacking order; the content draws only inside the clip Node, which becomes the Group's Clipping Path and loses its Fills and Strokes.",
        "The clip Node is a Live Shape or path (not a text), and every Node listed shares its parent. The Group's geometricBounds are the Clipping Path's. Move the clip or the content with zibel_node_transform; zibel_mask_release undoes the clip.",
        "One Transaction. createdIds is the Group; updatedIds the Nodes moved into it.",
      ].join(" "),
      inputSchema: { docId, ...MaskInput.shape, ...txWrite },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, intent, txId, ifRev, ...input }) =>
      run("zibel_mask_make", async () =>
        json(await service.makeMask(docId, input, { intent, txId, ifRev })),
      ),
  );

  server.registerTool(
    "zibel_mask_release",
    {
      title: "Release Clipping Mask",
      description:
        "Stop Clipping Masks clipping, as Illustrator's Object > Clipping Mask > Release. List each by its Group id or its Clipping Path's id. The Group and its Nodes stay; the former Clipping Path keeps no Fill or Stroke until you give it an appearance with zibel_node_update.",
      inputSchema: { docId, nodeIds: z.array(z.string()).min(1).max(1000), ...txWrite },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, nodeIds, ...opts }) =>
      run("zibel_mask_release", async () => json(await service.releaseMask(docId, nodeIds, opts))),
  );

  server.registerTool(
    "zibel_path_edit",
    {
      title: "Edit Path",
      description: [
        "Edit a path's Anchors, as Illustrator's Direct Selection, Pen and Anchor Point tools do: ops apply in order, each to the result so far, in one Transaction; one bad op fails the call and changes nothing.",
        "An Anchor is {index, anchor: [x, y], handleIn: [x, y] | null, handleOut: [x, y] | null, type: corner | smooth}. Positions are in the path's own coordinates, the same as its d, not document coordinates once the path has a transform (see geometricBounds). An Anchor is smooth when its two Handles lie on one line through it, else corner; the type is derived, not stored.",
        "Each M in d starts a subpath; ops name one by subpath (default 0) and an Anchor by its index in it, from 0. A closed subpath's closing segment runs from its last Anchor to its first; a C that returns to the first Anchor before Z is that closing segment, while an L back is its own Anchor.",
        "Ops: move_anchor {index, to} moves an Anchor and its Handles. set_handles {index, handleIn, handleOut} sets a Handle, or retracts it with null; an omitted one stays; an open subpath's first Anchor has no handleIn and its last no handleOut. set_point_type {index, type}: corner retracts both Handles, smooth lines them up, pulling out a missing one along the neighbouring Anchors; an Endpoint is always corner. add_anchor {segment, t} splits the segment from Anchor segment to the next at curve parameter t (0 to 1) without changing its shape. remove_anchor {index} joins its neighbours. close joins the last Anchor to the first; open cuts the closing segment at the first Anchor, keeping the outline. reverse {subpath} reverses one subpath, or every one when omitted. set_d {d} replaces d as a whole.",
        "A Live Shape (rect, ellipse, line, polygon, star) is converted to a path first, as zibel_path_op convert_to_path does, and warnings says so (CONVERTED_TO_PATH); its Anchors are those of the d zibel_node_get shows for it. To keep it live, edit its parameters with zibel_node_update instead.",
        "Returns the receipt, the new d and every subpath's Anchors as stored, with at most 3 decimals.",
      ].join(" "),
      inputSchema: { docId, ...PathEditInput.shape, ...txWrite },
      outputSchema: PathEditOutput.shape,
      annotations: edit,
    },
    ({ docId, nodeId, ops, ...opts }) =>
      run("zibel_path_edit", async () =>
        json(await service.pathEdit(docId, { nodeId, ops }, opts)),
      ),
  );

  server.registerTool(
    "zibel_path_op",
    {
      title: "Path Operation",
      description: [
        "Run a path operation on Nodes, in one Transaction.",
        "op convert_to_path turns each Live Shape (rect, ellipse, line, polygon, star) into a path with the same outline, as Illustrator's Object > Shape > Expand Shape: it keeps its id, parent, stacking order, name, transform and appearance, and its parameters give way to d and fillRule. A path is left as it is; any other Node fails the call. zibel_path_edit converts a Live Shape by itself, so convert first only to keep the shape as a path without editing it.",
      ].join(" "),
      inputSchema: { docId, ...PathOpInput.shape, ...txWrite },
      outputSchema: WriteReceipt.shape,
      annotations: edit,
    },
    ({ docId, nodeIds, op, ...opts }) =>
      run("zibel_path_op", async () => json(await service.pathOp(docId, { nodeIds, op }, opts))),
  );

  server.registerTool(
    "zibel_freehand_stroke",
    {
      title: "Freehand Stroke",
      description: [
        "Draw with Illustrator's Pencil: points is the Ink in drawing order, in document coordinates, and it is fitted with cubic Béziers into one new path under parentId (a Layer or Group), above its other children, in one Transaction.",
        "fidelity is the Pencil's Fidelity, 0 Accurate to 100 Smooth (default 50): every point lies within 0.1 pt of the path at 0, 1 pt at 50 and 10 pt at 100, so a higher value gives fewer Anchors. A turn sharper than 60° becomes a Corner Anchor, a straight run between corners a line, and every other Anchor is Smooth. The path closes only when the last point repeats the first (within 0.001 pt).",
        "pressure is accepted and ignored, as the Pencil draws at a fixed width. appearance is as zibel_node_create takes it; omitted, a 1 pt black Stroke and no Fill.",
        "createdIds is the path; read its d and Anchors with zibel_node_get or zibel_path_edit.",
      ].join(" "),
      inputSchema: { docId, ...FreehandStrokeInput.shape, ...txWrite },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, intent, txId, ifRev, ...input }) =>
      run("zibel_freehand_stroke", async () => {
        const item = freehandPath(input);
        try {
          return json(await service.createNodes(docId, [item], { intent, txId, ifRev }));
        } catch (e) {
          if (!(e instanceof ZibelError)) throw e;
          throw new ZibelError({ ...e.data, path: e.data.path?.replace(/^nodes\[0\]\./, "") });
        }
      }),
  );

  server.registerTool(
    "zibel_node_get",
    {
      title: "Get Nodes",
      description: [
        "Read Nodes by id, in document coordinates.",
        "concise (default): id, type, name, parentId, visible, locked, childCount and geometricBounds.",
        "full adds every stored property (Live Shape parameters, text content and font, an image's frame and src id, never its bytes, appearance, transform, opacity, blendMode, tags, meta), the outline d and closed of a Live Shape or path (a text or image has none), visibleBounds (including Strokes) and worldTransform.",
        "A Point Type's geometricBounds run from its first line's ascender to its last line's descender, as wide as its widest line; an Area Type's are its frame.",
        coordinates,
      ].join(" "),
      inputSchema: {
        docId,
        nodeIds: z.array(z.string()).min(1).max(1000),
        detail: z.enum(["concise", "full"]).default("concise"),
        txId: readTxId,
      },
      outputSchema: NodeGetOutput.shape,
      annotations: read,
    },
    ({ docId, nodeIds, detail, txId }) =>
      run("zibel_node_get", async () => json(await service.get(docId, nodeIds, detail, txId))),
  );

  server.registerTool(
    "zibel_node_query",
    {
      title: "Query Nodes",
      description: [
        "Node Query: the Nodes matching every filter given, without reading the whole Document; with none, every Node matches, hidden and locked ones included.",
        'types: any of these. nameRegex: tested against the stored name (unnamed is ""). tags: carries every one. parentId: direct children only. withinRect: geometricBounds entirely inside; intersectsRect: touching. Rects are {x, y, width, height} in document coordinates; a Layer or Group with nothing in it has no bounds and never matches them.',
        "Returns the concise view of zibel_node_get, sorted by id, limit per page (default 100, max 1000). While more follow, nextCursor is set: pass it back as cursor with the same filters for the next page; null means the last page.",
      ].join(" "),
      inputSchema: { docId, ...NodeQuery.shape, txId: readTxId },
      outputSchema: NodeQueryOutput.shape,
      annotations: read,
    },
    ({ docId, txId, ...q }) =>
      run("zibel_node_query", async () => json(await service.query(docId, q, txId))),
  );

  server.registerTool(
    "zibel_doc_outline",
    {
      title: "Document outline",
      description: [
        "Sparse tree of the Document in nodes: the top level is the Layer list, or with rootId that Node's children. Each entry has id, type, name, bounds, childCount, visible and locked; children appear down to depth levels, counting the top level as 1.",
        "types keeps entries of those types and the containers above them, plus every top-level Layer; childCount stays the real count, and children: [] means none of those types within depth.",
        "includeBounds: false leaves bounds out, which is cheaper for a large Document.",
      ].join(" "),
      inputSchema: {
        docId,
        rootId: z.string().optional(),
        depth: z.number().int().min(1).default(2),
        types: z.array(NodeType).min(1).optional(),
        includeBounds: z.boolean().default(true),
        txId: readTxId,
      },
      outputSchema: OutlineOutput.shape,
      annotations: read,
    },
    ({ docId, txId, ...opts }) =>
      run("zibel_doc_outline", async () => json(await service.outline(docId, opts, txId))),
  );

  server.registerTool(
    "zibel_render",
    {
      title: "Render",
      description: [
        "Render part of the Document to a PNG so you can see what you drew.",
        scopes,
        "overlays draw aids over the artwork, a fixed pixel size at any scale: bounds boxes each Node's geometricBounds, ids labels each Node with its id at the top-left corner of those bounds (Layers get neither), artboards outlines every Artboard.",
        "When the image's longer side would pass maxSize (default 1600 px), the scale is lowered to fit; read the scale actually used from viewport.scale.",
        "viewport maps pixels back to document coordinates: docX = docRect.x + px / scale, docY = docRect.y + py / scale.",
      ].join(" "),
      inputSchema: {
        docId,
        scope,
        scale: scale.describe("Pixels per point, before maxSize."),
        maxSize: z
          .number()
          .int()
          .positive()
          .default(1600)
          .describe(
            "Longest side in pixels; the scale is lowered to fit. An image over 4096 px fails with LIMIT_EXCEEDED.",
          ),
        background,
        overlays: z.array(RenderOverlay).default([]),
        txId: readTxId,
      },
      outputSchema: RenderOutput.shape,
      annotations: read,
    },
    ({ docId, background, ...req }) =>
      run("zibel_render", async () => {
        const { png, viewport } = await service.render(docId, {
          ...req,
          background: color(background),
        });
        return image(png, viewport);
      }),
  );

  server.registerTool(
    "zibel_export",
    {
      title: "Export",
      description: [
        "Export the artwork of part of the Document, returned inline: svg as text content with docRect, its viewBox; png as image content with viewport, as zibel_render returns it.",
        "svg is Inkscape SVG. Without a scope its viewBox is one Artboard, the one at (0, 0) or else the first, which Inkscape uses as its viewport page; every Artboard is still written, the others as pages outside the viewBox.",
        scopes,
        "No overlays and no maxSize: a png is scale pixels per point, at most 4096 px on its longer side.",
        "zibel_json is the whole Document as a .zibel.json file in text content, which zibel_doc_open reads back; scope, scale and background do not apply to it.",
      ].join(" "),
      inputSchema: {
        docId,
        format: z.enum(["svg", "png", "zibel_json"]),
        scope,
        scale: scale.describe("png only: pixels per point."),
        background,
        txId: readTxId,
      },
      outputSchema: ExportOutput.shape,
      annotations: read,
    },
    ({ docId, format, scale, background, ...req }) =>
      run("zibel_export", async () => {
        if (format === "zibel_json") {
          const { text } = await service.file(docId, req.txId);
          return { structuredContent: {}, content: [{ type: "text", text }] };
        }
        const opts = { ...req, background: color(background) };
        if (format === "png") {
          const { png, viewport } = await service.render(docId, { ...opts, scale });
          return image(png, viewport);
        }
        const { svg, docRect } = await service.svg(docId, opts);
        return { structuredContent: { docRect }, content: [{ type: "text", text: svg }] };
      }),
  );

  server.registerTool(
    "zibel_doc_list",
    {
      title: "List Documents",
      description:
        "Every Document, newest first: docId, name and createdAt. Use zibel_doc_get_info on one for its Artboards and rev.",
      inputSchema: {},
      outputSchema: DocListOutput.shape,
      annotations: read,
    },
    () => run("zibel_doc_list", async () => json(await service.list())),
  );

  server.registerTool(
    "zibel_doc_get_info",
    {
      title: "Document info",
      description:
        "A Document's name, Artboards, Node count, current committed rev and how many browsers have it open right now. Call it before writing to learn the rev to pass as ifRev and whether a person is watching.",
      inputSchema: { docId },
      outputSchema: DocInfoOutput.shape,
      annotations: read,
    },
    ({ docId }) => run("zibel_doc_get_info", async () => json(await service.info(docId))),
  );

  server.registerTool(
    "zibel_doc_changes",
    {
      title: "Document changes",
      description: [
        "What was committed after sinceRev, oldest first, by any Actor (people and Agents): each entry has rev, txId, actor, summary, intent and the created, updated and deleted Node ids. rev is the Document's current committed rev.",
        "Call it before a round of writes to see what a person changed since your last read, then pass that rev as ifRev.",
      ].join(" "),
      inputSchema: {
        docId,
        sinceRev: z.number().int().min(0),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      outputSchema: ChangesOutput.shape,
      annotations: read,
    },
    ({ docId, sinceRev, limit }) =>
      run("zibel_doc_changes", async () => json(await service.changes(docId, sinceRev, limit))),
  );

  server.registerTool(
    "zibel_tx_begin",
    {
      title: "Begin Transaction",
      description: [
        "Start a Transaction to make several writes one step that people see, and undo, at once.",
        "Pass the returned txId to each write, and to node_get, node_query, doc_outline, render and export to see your uncommitted work; nobody else sees it until zibel_tx_commit.",
        "It rolls back after 5 minutes without a call carrying its txId. label becomes the summary in zibel_doc_changes. rev is the committed rev, for ifRev.",
      ].join(" "),
      inputSchema: { docId, label: z.string().min(1).max(200).optional() },
      outputSchema: TxOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, label }) =>
      run("zibel_tx_begin", async () => json(await service.begin(docId, label))),
  );

  server.registerTool(
    "zibel_tx_commit",
    {
      title: "Commit Transaction",
      description: [
        "Apply every write of the Transaction at once: rev goes up by one and the receipt lists every created, updated and deleted id.",
        "Properties someone else changed meanwhile are kept unless the Transaction changed the same property. If someone deleted a Node the Transaction edited, or a Layer or Group it created Nodes in, the commit fails with NODE_GONE listing them and the Transaction stays open for zibel_tx_rollback.",
      ].join(" "),
      inputSchema: { docId, txId, ifRev, intent },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, txId, ifRev, intent }) =>
      run("zibel_tx_commit", async () =>
        json(await service.commitTx(docId, txId, { ifRev, intent })),
      ),
  );

  server.registerTool(
    "zibel_tx_rollback",
    {
      title: "Roll back Transaction",
      description:
        "Discard every uncommitted write of the Transaction; the Document stays as it is committed. Later calls with the txId return TX_EXPIRED.",
      inputSchema: { docId, txId },
      outputSchema: TxOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ docId, txId }) =>
      run("zibel_tx_rollback", async () => json(await service.rollback(docId, txId))),
  );

  return server;
}

const image = (png: Uint8Array, viewport: Viewport): CallToolResult => ({
  structuredContent: { viewport },
  content: [{ type: "image", data: png.toBase64(), mimeType: "image/png" }],
});

/** A structured result plus the same JSON as text, for clients that ignore structuredContent. */
const json = (result: object): CallToolResult => ({
  structuredContent: result as Record<string, unknown>,
  content: [{ type: "text", text: JSON.stringify(result) }],
});
