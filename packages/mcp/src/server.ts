import {
  ArtboardInput,
  Color,
  DuplicateInput,
  FreehandStrokeInput,
  freehandPath,
  imageFrame,
  KalamoError,
  MaskFields,
  MaskInput,
  NodeInput,
  NodeQuery,
  NodeType,
  PathEditInput,
  PathOpInput,
  parseColor,
  RenderOverlay,
  RenderScope,
  ReorderOp,
  ReparentInput,
  TransformBatchInput,
  TransformFields,
  TransformInput,
  UpdateInput,
  WriteReceipt,
} from "@kalamo/core";
import type { DocumentService, Viewport } from "@kalamo/sync";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CallToolResult,
  isJSONRPCRequest,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { exclusive, parseArgs } from "./args.ts";
import conventions from "./drawing-conventions.md";
import {
  ChangesOutput,
  CreatedDocumentOutput,
  DocDeleteOutput,
  DocInfoOutput,
  DocListOutput,
  DuplicateOutput,
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

interface ToolConfig {
  title: string;
  description: string;
  outputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
}
/** A tool's input schema as `tool` parses it: its object, or its shape, rejecting unknown keys. */
type Strict<S> = S extends z.ZodRawShape ? z.ZodObject<S, z.core.$strict> : S;

const CONVENTIONS = "skill://kalamo/drawing-conventions";
const docId = z.string().describe("Document id returned by kalamo_doc_create.");
const intent = z
  .string()
  .max(500)
  .optional()
  .describe("One sentence on what this write is for, shown to people editing the Document.");
const txId = z
  .string()
  .describe("Transaction id from kalamo_tx_begin. Only the Actor that began it can use it.");
const readTxId = txId
  .optional()
  .describe("Transaction id from kalamo_tx_begin: also show its uncommitted edits.");
const ifRev = z
  .number()
  .int()
  .optional()
  .describe(
    "Fail with REV_CONFLICT, changing nothing, unless the committed rev still equals this, the rev you last read.",
  );
/** Accepted by every Node write (§6.4). */
const writeFields = {
  intent,
  txId: txId
    .optional()
    .describe(
      "From kalamo_tx_begin: others see the write, and rev moves, only at kalamo_tx_commit, which takes the intent instead.",
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
    { name: "kalamo", version: "0.0.0" },
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

  /** Runs a tool handler, maps KalamoError to an error result and logs one line per call (§7.7). */
  const run = async (tool: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    const start = Date.now();
    let result: CallToolResult;
    let code: string | null = null;
    try {
      result = await fn();
    } catch (e) {
      if (!(e instanceof KalamoError)) throw e;
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

  /**
   * Registers a tool whose arguments Kalamo parses, strictly: the SDK advertises the real schema
   * through `.meta()` but validates only that the arguments are an object, so a bad argument is
   * INVALID_INPUT like any other error and is logged by `run` (ADR-0050). Named schemas are written
   * once under the tool's `$defs` (ADR-0088).
   */
  const tool = <S extends z.ZodRawShape | z.ZodObject>(
    name: string,
    { inputSchema, ...config }: ToolConfig & { inputSchema: S },
    handler: (args: z.output<Strict<S>>) => Promise<CallToolResult>,
  ) => {
    const real = (
      inputSchema instanceof z.ZodObject
        ? inputSchema.strict()
        : z.strictObject(inputSchema as z.ZodRawShape)
    ) as Strict<S>;
    // Schemas core names with an id (Node, Appearance, Fill…) are written once under $defs (#229).
    const advertised = z.toJSONSchema(real, {
      target: "draft-2020-12",
      io: "input",
      // zod bounds every int to the safe integers, which costs tokens and tells an Agent nothing.
      override: ({ jsonSchema: s }) => {
        if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
        if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
      },
    });
    server.registerTool(
      name,
      { ...config, inputSchema: z.looseObject({}).meta(advertised) },
      (raw) => run(name, () => handler(parseArgs(name, real, raw) as z.output<Strict<S>>)),
    );
  };

  tool(
    "kalamo_doc_create",
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
    async (args) => json(await service.create(args)),
  );

  tool(
    "kalamo_doc_open",
    {
      title: "Open Document",
      description: [
        "Make a new Document from a file's text: .kalamo.json as kalamo_export returns it with format kalamo_json, or SVG (Inkscape, Kalamo's own export or plain SVG 1.1, at most 5 MB outside its embedded images, each image at most 5 MB), told apart by content. Pass the file's content, not a path.",
        "The new Document gets its own docId and starts at rev 1. Ids from .kalamo.json, and z-<id> ids from SVG, are kept; SVG layers and pages become Layers and Artboards, units become pt (px counts as pt). nodes is its Layer list, as kalamo_doc_outline returns it at depth 1.",
        "Embedded PNG, JPEG and GIF images come back as Images. A linked image (an href that is not a data: URL) comes back as a linked Image with file set to the href and no pixels, a missing link, and warnings says IMAGE_LINK_MISSING; nothing is fetched. One without width or height is dropped with INVALID_IMAGE, since nothing gives its size. SVG content Kalamo cannot hold yet (patterns, mesh gradients, filters, masks, WebP) imports as close as it can, or is dropped, and warnings lists each kind once. A Kalamo gradient whose inserted stops (kalamo:simulated) were edited, as in Inkscape, keeps the stops as drawn and warns SIMULATED_STOP_KEPT. A file that is not valid fails with a path into it and creates nothing.",
      ].join(" "),
      inputSchema: {
        content: z.string().min(1).describe("The whole .kalamo.json or .svg text."),
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
    async (args) => json(await service.open(args)),
  );

  tool(
    "kalamo_node_create",
    {
      title: "Create Nodes",
      description: [
        "Create Nodes in one atomic write: one bad item fails the call and creates nothing.",
        "The schema describes each field, parentId included.",
        "Types:",
        "layer {name, appearance}: parent is the root or another Layer.",
        "group {children, appearance}: children are nodes of any type but layer, without parentId, created inside the Group.",
        "rect {x, y, width, height, radius}.",
        "ellipse {x, y, width, height, startAngle, endAngle, arcType}: the angles are parametric, so a stretched pie keeps its share of the outline.",
        "line {x1, y1, x2, y2}.",
        "polygon {cx, cy, radius, sides, angle, rounded, randomized} and star {cx, cy, outerRadius, innerRadius, points, angle, twist, rounded, randomized}, as Inkscape's.",
        "spiral {cx, cy, radius, revolution, expansion, argument, t0}: Inkscape's, always open, r = radius·t^expansion at 2π·revolution·t + argument, turning clockwise from the center out; mirror it with kalamo_node_transform for a counterclockwise one.",
        "path {d, fillRule}.",
        `text {x, y, content, fontFamily, fontStyle, fontSize, leading, tracking, alignment, ranges}: Point Type from its first baseline, breaking only at \\n. kind "area" makes Area Type, framed by x, y, width, height, by frame (closed path data) or by frameNodeId (a closed shape it takes the place of), wrapping as ${CONVENTIONS} says; what does not fit is not drawn and warns TEXT_OVERFLOW. Regular, Italic, Bold, Bold Italic, Black and Black Italic are bundled; another fontStyle, or a fontFamily that is not bundled, renders in the nearest bundled face and warns FONT_MISSING, and characters no bundled font has render as .notdef boxes and warn MISSING_GLYPHS. ranges are Character Ranges over content's code points: fill, stroke, baselineShift, rotation, tracking, fontStyle, fontFamily and fontSize for some characters, a later range winning attribute by attribute.`,
        "image {src, file, x, y, width, height, preserveAspectRatio}: give src, file or both; an Image with file and no src is a missing link, drawn as its frame and both diagonals. An image has no appearance; crop one with kalamo_mask_make.",
        "appearance {fills, strokes}: omitted, a white Fill and a 1 pt black Stroke, or on text a black Fill and no Stroke. A layer's or group's appearance {fills, strokes, contents} paints the outline of every visible descendant, and contents is how many of its paints draw below the children; omitted, nothing.",
        "A Fill or Stroke may be {type: \"gradient\", gradient}: linear {stops, start, end} or radial {stops, center, radius, aspectRatio, angle, focus}, at least 2 stops {offset, color, midpoint}, in the Node's own coordinates; geometry left out spans the Node's bounds, and on a container the children's.",
        "At most 2000 Nodes per call, counting inline children. tags and meta are yours.",
        `Coordinates, colours, d, container paint and defaults: ${CONVENTIONS}.`,
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
    async ({ docId, nodes, ...opts }) => json(await service.createNodes(docId, nodes, opts)),
  );

  tool(
    "kalamo_svg_import",
    {
      title: "Place SVG",
      description: [
        "Place an SVG into a Document, as Illustrator's File > Place: one new Group under parentId (a Layer or Group), above its other children, named from the SVG's sodipodi:docname or <title>, else Untitled (rename it with kalamo_node_update). Pass the file's content, not a path; at most 5 MB outside its embedded images, each image at most 5 MB.",
        "SVG layers become Groups, pages and page backgrounds are dropped, and every Node gets a new id, so placing a file twice, or one exported from this Document, never collides. Units become pt, with px counting as pt.",
        "position is where the centre of the Group's geometricBounds lands, in document coordinates; default the centre of the parent's Artboard, the one the parent overlaps most, else the first. fit: true first scales the Group uniformly, Strokes included, to fit that Artboard.",
        "A Kalamo copy, the SVG kalamo_export writes at scope {nodeIds}, is pasted instead, as Illustrator's Edit > Paste: the Nodes it lists, and anything added beside them since, go directly under parentId in stacking order without the Group, with the Layers and Groups that only held them dropped.",
        "One Transaction. createdIds starts with what went under parentId, the Group or the pasted Nodes, and nodes is their outline to depth 2. Embedded images become Images and linked ones linked Images, as kalamo_doc_open reads them; a linked image copied from this Document (kalamo:src) keeps its pixels, and takes their size when it has no width or height; the rest are missing links and warn IMAGE_LINK_MISSING, and an unsized one is dropped with INVALID_IMAGE. warnings lists once per kind what Kalamo cannot hold yet, and SIMULATED_STOP_KEPT, as kalamo_doc_open does. A .kalamo.json is INVALID_DOCUMENT.",
      ].join(" "),
      inputSchema: {
        docId,
        svg: z.string().min(1).describe("The whole .svg text."),
        parentId: z.string().describe("A Layer or Group id to place the new Group in."),
        position: z
          .strictObject({ x: z.number(), y: z.number() })
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
    async ({ docId, ...input }) => json(await service.place(docId, input)),
  );

  tool(
    "kalamo_image_place",
    {
      title: "Place Image",
      description: [
        "Place a PNG, JPEG or GIF as an Image, as Illustrator's File > Place, so its bytes never pass through you.",
        "src is a public http or https URL, which the server fetches: at most 10 s and 20 MB read, following at most 5 redirects; localhost and private, loopback or link-local addresses are refused, and any fetch that fails is FETCH_FAILED. src may instead be a data: URL. A local path is refused: the server cannot read your disk.",
        "The format comes from the file's bytes, not its Content-Type; WebP is refused (convert it to PNG), and a file over 5 MB is LIMIT_EXCEEDED.",
        "frame {x, y, width, height} is as kalamo_node_create's image takes it, width and height both or neither (default the file's pixel size at 1 pt per pixel); omitted, the Image is centred on the parent's Artboard.",
        "asTemplate: true makes a Template Layer for a reference to trace: a new locked Layer named Template <file name>, directly beneath the Layer holding parentId, with the Image at 50% opacity. It still renders and exports: hide or delete it before kalamo_export.",
        "One Transaction; createdIds lists the Template Layer, if any, then the Image.",
      ].join(" "),
      inputSchema: {
        docId,
        src: z.string().min(1).describe("An http(s) URL of the file, or a data: URL."),
        parentId: z.string().describe("A Layer or Group id to place the Image in."),
        frame: z
          .strictObject({
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
    async ({ docId, ...input }) => json(await service.placeImage(docId, input)),
  );

  tool(
    "kalamo_node_update",
    {
      title: "Update Nodes",
      description: [
        "Change Nodes with one JSON Merge Patch (RFC 7396) each: objects merge, null deletes a key, arrays and everything else replace, so fills, strokes and ranges are sent whole; a gradient's geometry left out spans the Node's bounds after the patch.",
        "Every Node writes name, visible, locked, opacity (0-1), blendMode, tags and meta. A Live Shape or path writes its parameters as kalamo_node_create takes them, and appearance. A layer or group writes appearance with contents, which must stay within its fills and strokes after the merge, and appearance: null removes it.",
        "A text writes content, fontFamily, fontStyle, fontSize, leading (null for Auto), tracking, alignment (null for left), ranges (writing content without them clears them), x, y and appearance; an Area Type also width and height, or frame, closed path data, and frame: null makes it the rectangle of its bounds. A shaped Area Type refuses x, y, width and height, its frame's bounds. kind converts Point Type and Area Type, keeping the id and every shown line; a patch with kind carries only name, visible, locked, opacity, blendMode, appearance, tags and meta.",
        "An image writes x, y, width, height, preserveAspectRatio, src (Relink, keeping the frame unless the patch sets it) and file; file: null Embeds a linked image, failing INVALID_IMAGE without src, and src: null is refused.",
        `How kind converts and src Relinks: ${CONVENTIONS}.`,
        "transform, type, parentId, index and bounds are read-only: use kalamo_node_transform, kalamo_node_reparent and kalamo_node_reorder.",
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
    async ({ docId, updates, ...opts }) => json(await service.updateNodes(docId, updates, opts)),
  );

  tool(
    "kalamo_node_delete",
    {
      title: "Delete Nodes",
      description:
        "Delete Nodes and everything inside them. The receipt's deletedIds lists every removed id, descendants included; bounds is where they were. A Document keeps at least one top-level Layer: a delete that would remove the last one fails with LAST_LAYER and changes nothing (with partial, only that entry fails). To clear a Document, delete the Layer's contents, or create another top-level Layer first.",
      inputSchema: {
        docId,
        nodeIds: z.array(z.string()).min(1).max(1000),
        ...writeFields,
      },
      outputSchema: WriteReceipt.shape,
      annotations: edit,
    },
    async ({ docId, nodeIds, ...opts }) => json(await service.deleteNodes(docId, nodeIds, opts)),
  );

  tool(
    "kalamo_node_transform",
    {
      title: "Transform Nodes",
      description: [
        "Move, rotate, scale, skew or reflect Nodes about a reference point (the pivot, as in Illustrator's Transform panel), in document coordinates.",
        "Several parts compose as: scale, then skew, then rotate, all about the pivot, then translate. matrix [a, b, c, d, e, f] replaces rotate, skew and scale; [-1, 0, 0, 1, 0, 0] reflects across the pivot.",
        "pivot is center (default), topLeft, top, topRight, left, right, bottomLeft, bottom or bottomRight of the targets' geometricBounds, or {x, y}. With each: true every target turns about its own pivot; otherwise all share one.",
        "Transforming a Layer or Group transforms every Node inside it; updatedIds lists those Nodes. Live Shapes keep their parameters and gain a transform.",
        "scaleStrokes (default true) scales Stroke widths with the shape. The receipt's bounds are the new bounds.",
        "To give Nodes different transforms in one call, send transforms: [{nodeIds, rotate, ...}, ...] instead of those fields: each entry applies in order, its pivot taken from the bounds the entries before it left, all in one Transaction; with partial, a failing entry is skipped whole and listed in failed by its index.",
      ].join(" "),
      inputSchema: { docId, ...TransformFields.shape, ...writeFields },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ docId, intent, partial, txId, ifRev, ...input }) => {
      exclusive(
        "kalamo_node_transform",
        input,
        "transforms",
        Object.keys(TransformInput.shape),
        (k) => `Put ${k} inside each entry of transforms that needs it.`,
      );
      const schema = input.transforms ? TransformBatchInput : TransformInput;
      const transform = parseArgs("kalamo_node_transform", schema, input);
      return json(await service.transformNodes(docId, transform, { intent, partial, txId, ifRev }));
    },
  );

  tool(
    "kalamo_node_reparent",
    {
      title: "Reparent Nodes",
      description: [
        "Move Nodes, with everything inside them, to another Layer or Group, or restack them within their own: each move is {nodeId, parentId, index?, before?, after?}. parentId is a Layer or Group id, or null to make a Layer top-level; a Layer's parent is the root or a Layer, and every other Node's a Layer or Group.",
        "Position, at most one of: index, a 0-based position among the parent's other children, bottom first as kalamo_doc_outline lists them (0 is the bottom, their count the top); before: a sibling id, to land directly below it; after: a sibling id, to land directly above it. With none the Node goes on top. The same parentId with a new position restacks the Node.",
        "Nothing moves on the canvas: Layers and Groups have no transform, so geometry and geometricBounds stay.",
        "A Clipping Path moved to another parent stops clipping and keeps its appearance, so a Group or Layer never holds two; restacked in its own parent it keeps clipping. A Node moved into a Clipping Mask is clipped wherever it lands. A Group left empty, or holding only its Clipping Path, stays.",
        "Moves apply in order, each to the Document the ones before it left, in one Transaction: one receipt, one undo step. updatedIds lists each moved Node once, with its final place; bounds covers them. With partial, a failing move is skipped and listed in failed by its index.",
      ].join(" "),
      inputSchema: {
        docId,
        moves: z.array(ReparentInput).min(1).max(1000),
        ...writeFields,
      },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ docId, moves, ...opts }) => json(await service.reparentNodes(docId, moves, opts)),
  );

  tool(
    "kalamo_node_reorder",
    {
      title: "Reorder Nodes",
      description: [
        "Restack Nodes in their own parent, as Illustrator's Object > Arrange does; a Node never changes parent (kalamo_node_reparent moves it to another). op: front puts them on top of their siblings, back at the bottom, forward and backward one sibling up or down, overlapping or not.",
        "Several Nodes in one parent keep their order among themselves: a run of adjacent ones moves as a block, and one already at the top (front, forward) or bottom (back, backward) stays, so the next one closes up to it. Nodes in different parents are each restacked in their own. Any Node can be restacked, Layers included; a Clipping Path keeps clipping, since its place in its Clipping Mask does not matter.",
        "One Transaction: one receipt, one undo step. updatedIds lists the Nodes that moved; a Node already where op puts it is left out, and if none moves the receipt lists none. With partial, an unknown id is skipped and listed in failed by its index. Geometry does not change, only what paints over what.",
      ].join(" "),
      inputSchema: {
        docId,
        nodeIds: z.array(z.string()).min(1).max(1000),
        op: ReorderOp,
        ...writeFields,
      },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ docId, nodeIds, op, ...opts }) =>
      json(await service.reorderNodes(docId, nodeIds, op, opts)),
  );

  /** The write options of a tool without partial. */
  const txWrite = { intent, txId: writeFields.txId, ifRev };
  // index, before and after are the browser's, for Alt-drag (ADR-0076); layerSuffix is its
  // Layers panel Duplicate's (#195).
  const duplicateFields = DuplicateInput.omit({
    index: true,
    before: true,
    after: true,
    layerSuffix: true,
  }).shape;
  tool(
    "kalamo_node_duplicate",
    {
      title: "Duplicate Nodes",
      description: [
        "Copy Nodes, each with everything inside it, as new Nodes with new ids, as Illustrator's Alt-drag copy does. A copy keeps everything else: name, visibility, lock, opacity, blend mode, transform, appearance, Live Shape and compound_shape parameters, text, tags, meta, and an image's pixels (src, shared, not stored twice) and linked file.",
        "Without targetParentId each copy goes directly above its own original, in the original's parent; a Layer's copy stays a Layer. With targetParentId (a Layer or Group, or null for the top level, Layers only) every copy goes there on top, as one block in the originals' stacking order; a Layer into a Group, or a parent inside a copied Node, is INVALID_PARENT and nothing is written.",
        "count (1 to 100, default 1) copies of each Node; offset {x, y} moves copy k by k × offset, as repeating Transform Again after an Alt-drag would, and the copies stack upward in that order. A Node named together with its ancestor is copied once, through the ancestor, and so is a repeated id.",
        "A Clipping Path copied on its own stops clipping, so no Group or Layer gets two; a Clip Group or clipped Layer copied whole keeps its Clipping Path and still clips. Locks do not stop an Agent.",
        "One Transaction: one receipt, one undo step. createdIds lists every new Node, descendants included; copies maps each source id to its new top-level ids in order k = 1…count, and geometricBounds gives where each of them landed, in document coordinates.",
      ].join(" "),
      inputSchema: { docId, ...duplicateFields, ...txWrite },
      outputSchema: DuplicateOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => json(await service.duplicateNodes(...splitTxWrite(args))),
  );

  tool(
    "kalamo_mask_make",
    {
      title: "Make Clipping Mask",
      description: [
        "Clip Nodes by a shape, as Illustrator's Object > Clipping Mask > Make: a new Group, the Clipping Mask, takes the place of the topmost of them and holds clipNodeId and contentIds in their stacking order; the content draws only inside the clip Node, which becomes the Group's Clipping Path and loses its Fills and Strokes. An appearance given to it later with kalamo_node_update draws its Fills behind the content and its Strokes over it, unclipped.",
        "The clip Node is a Live Shape, a path or a text, which clips by its glyphs, and every Node listed shares its parent. The Group's geometricBounds are the Clipping Path's. Move the clip or the content with kalamo_node_transform; kalamo_mask_release undoes the clip.",
        "Or give layerId alone, as Illustrator's Layers panel button: the Layer's topmost child becomes its Clipping Path, losing its Fills and Strokes, and clips everything else in the Layer, sublayers and Nodes created in it later included. Nothing moves and no Group is made. INVALID_MASK when the Layer is already clipped, is empty, or its topmost child is hidden or is a Group, Layer or image.",
        "One Transaction. createdIds is the Group, none for a Layer; updatedIds the Nodes moved into it, or the Layer's new Clipping Path.",
      ].join(" "),
      inputSchema: { docId, ...MaskFields.shape, ...txWrite },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const [id, input, opts] = splitTxWrite(args);
      exclusive(
        "kalamo_mask_make",
        input,
        "layerId",
        ["clipNodeId", "contentIds"],
        () => "Send layerId alone, or clipNodeId and contentIds without it.",
      );
      const mask = parseArgs("kalamo_mask_make", MaskInput, input);
      return json(await service.makeMask(id, mask, opts));
    },
  );

  tool(
    "kalamo_mask_release",
    {
      title: "Release Clipping Mask",
      description:
        "Stop Clipping Masks clipping, as Illustrator's Object > Clipping Mask > Release. List each by its Group's or Layer's id or its Clipping Path's id. The Group or Layer and its Nodes stay; the former Clipping Path keeps its appearance, which is empty unless one was given to it with kalamo_node_update.",
      inputSchema: { docId, nodeIds: z.array(z.string()).min(1).max(1000), ...txWrite },
      outputSchema: WriteReceipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ docId, nodeIds, ...opts }) => json(await service.releaseMask(docId, nodeIds, opts)),
  );

  tool(
    "kalamo_path_edit",
    {
      title: "Edit Path",
      description: [
        "Edit a path's Anchors, as Illustrator's Direct Selection, Pen and Anchor Point tools do: ops apply in order, each to the result so far, in one Transaction; one bad op fails the call and changes nothing.",
        "An Anchor is {index, anchor: [x, y], handleIn: [x, y] | null, handleOut: [x, y] | null, type: corner | smooth}. Positions are in the path's own coordinates, the same as its d, not document coordinates once the path has a transform (see geometricBounds). An Anchor is smooth when its two Handles lie on one line through it, else corner; the type is derived, not stored.",
        "Each M in d starts a subpath; ops name one by subpath (default 0) and an Anchor by its index in it, from 0. A closed subpath's closing segment runs from its last Anchor to its first; a C that returns to the first Anchor before Z is that closing segment, while an L back is its own Anchor.",
        "Ops: move_anchor {index, to} moves an Anchor and its Handles. set_handles {index, handleIn, handleOut} sets a Handle, or retracts it with null; an omitted one stays; an open subpath's first Anchor has no handleIn and its last no handleOut. set_point_type {index, type}: corner retracts both Handles, smooth lines them up, pulling out a missing one along the neighbouring Anchors; an Endpoint is always corner. add_anchor {segment, t} splits the segment from Anchor segment to the next at curve parameter t (0 to 1) without changing its shape. remove_anchor {index} joins its neighbours. close joins the last Anchor to the first; open cuts the closing segment at the first Anchor, keeping the outline. reverse {subpath} reverses one subpath, or every one when omitted. set_d {d} replaces d as a whole.",
        "A Live Shape (rect, ellipse, line, polygon, star, spiral) is converted to a path first, as kalamo_path_op convert_to_path does, and warnings says so (CONVERTED_TO_PATH); its Anchors are those of the d kalamo_node_get shows for it. To keep it live, edit its parameters with kalamo_node_update instead.",
        "Returns the receipt, the new d and every subpath's Anchors as stored, with at most 3 decimals.",
      ].join(" "),
      inputSchema: { docId, ...PathEditInput.shape, ...txWrite },
      outputSchema: PathEditOutput.shape,
      annotations: edit,
    },
    async (args) => json(await service.pathEdit(...splitTxWrite(args))),
  );

  tool(
    "kalamo_path_op",
    {
      title: "Path Operation",
      description: [
        "Run a path operation on nodeIds, in one Transaction, as Illustrator's Object > Path menu does; the fields say which op reads them.",
        `Live Shapes, Clipping Paths, new paths and failures: ${CONVENTIONS}.`,
        "convert_to_path: Object > Shape > Expand Shape; each Live Shape becomes a path with the same outline, keeping its id, place, name, transform and appearance, and a path is left as it is.",
        "reverse: each subpath's Anchors in reverse order, a closed one keeping its first. add_anchors: an Anchor at the middle of every segment, the outline unchanged. Remove chosen Anchors with kalamo_path_edit remove_anchor.",
        "join: with anchors naming two open Endpoints, connects them, closing the subpath when they are its two ends; without, joins the paths' open subpaths, closest Endpoints first, into the topmost path, which keeps its id and appearance while the others are deleted, and closes a single open path. Endpoints within tolerance merge into one Corner Anchor keeping both Handles; farther ones get a straight segment.",
        "average: moves the anchors, or every Anchor of nodeIds, to their mean position along axis, Handles with them.",
        "simplify: refits each subpath with as few Anchors as stay within tolerance, the fit kalamo_freehand_stroke uses; ends stay put and closed subpaths closed.",
        "outline_stroke: each Stroke becomes a path filled with its paint, outlining its width, cap, join, miter limit and dashes. A path with one Stroke and no Fill becomes that outline, keeping its id; otherwise a new Group takes its place, opacity and blend mode (first in createdIds), holding the path with only its Fills and each outlined Stroke above it.",
        "offset: adds a path below each path or Live Shape, its fill grown by distance; an open path is offset as if closed.",
        "divide_below: the one path or Live Shape in nodeIds cuts every filled path and Live Shape it overlaps below it in paint order, in any Layer or Group, and is deleted. The part outside keeps the id (updatedIds) and the part inside is a new path just above it; unfilled paths, texts and images are left as they are.",
        "split_into_grid: replaces each closed path or Live Shape with rows × cols rects over its geometric bounds, each in its stacking place with no transform and the topmost shape's appearance (createdIds row by row from the top left); open paths and lines are left as they are.",
        "clean_up: removes the Stray Points, unpainted shapes and empty texts the fields choose, over the whole Document.",
      ].join(" "),
      inputSchema: { docId, ...PathOpInput.shape, ...txWrite },
      outputSchema: WriteReceipt.shape,
      annotations: edit,
    },
    async (args) => json(await service.pathOp(...splitTxWrite(args))),
  );

  tool(
    "kalamo_freehand_stroke",
    {
      title: "Freehand Stroke",
      description: [
        "Draw with Illustrator's Pencil: points is the Ink in drawing order, in document coordinates, and it is fitted with cubic Béziers into one new path under parentId (a Layer or Group), above its other children, in one Transaction.",
        "A higher fidelity gives fewer Anchors. A turn sharper than 60° becomes a Corner Anchor, a straight run between corners a line, and every other Anchor is Smooth. The path closes only when the last point repeats the first (within 0.001 pt).",
        "createdIds is the path; read its d and Anchors with kalamo_node_get or kalamo_path_edit.",
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
    async (args) => {
      const [docId, input, write] = splitTxWrite(args);
      const item = freehandPath(input);
      try {
        return json(await service.createNodes(docId, [item], write));
      } catch (e) {
        if (!(e instanceof KalamoError)) throw e;
        throw new KalamoError({ ...e.data, path: e.data.path?.replace(/^nodes\[0\]\./, "") });
      }
    },
  );

  tool(
    "kalamo_node_get",
    {
      title: "Get Nodes",
      description: [
        "Read Nodes by id, in document coordinates.",
        "concise (default): id, type, name, parentId, visible, locked, childCount and geometricBounds.",
        "full adds every stored property (Live Shape parameters, text content and font, an image's frame, src id and linked file, never its bytes, appearance, transform, opacity, blendMode, tags, meta), the outline d and closed of a Live Shape or path (a text or image has none), visibleBounds (including Strokes) and worldTransform.",
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
    async ({ docId, nodeIds, detail, txId }) =>
      json(await service.get(docId, nodeIds, detail, txId)),
  );

  tool(
    "kalamo_node_query",
    {
      title: "Query Nodes",
      description: [
        "Node Query: the Nodes matching every filter given, without reading the whole Document; with none, every Node matches, hidden and locked ones included.",
        'types: any of these. nameRegex: tested against the stored name (unnamed is ""). tags: carries every one. parentId: direct children only. withinRect: geometricBounds entirely inside; intersectsRect: touching. Rects are {x, y, width, height} in document coordinates; a Layer or Group with nothing in it has no bounds and never matches them.',
        "Returns the concise view of kalamo_node_get, sorted by id, limit per page (default 100, max 1000). While more follow, nextCursor is set: pass it back as cursor with the same filters for the next page; null means the last page.",
      ].join(" "),
      inputSchema: { docId, ...NodeQuery.shape, txId: readTxId },
      outputSchema: NodeQueryOutput.shape,
      annotations: read,
    },
    async ({ docId, txId, ...q }) => json(await service.query(docId, q, txId)),
  );

  tool(
    "kalamo_doc_outline",
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
    async ({ docId, txId, ...opts }) => json(await service.outline(docId, opts, txId)),
  );

  tool(
    "kalamo_render",
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
    async ({ docId, background, ...req }) => {
      const { png, viewport } = await service.render(docId, {
        ...req,
        background: color(background),
      });
      return image(png, viewport);
    },
  );

  tool(
    "kalamo_export",
    {
      title: "Export",
      description: [
        "Export the artwork of part of the Document, returned inline: svg as text content with docRect, its viewBox; png as image content with viewport, as kalamo_render returns it.",
        "svg is Inkscape SVG. Without a scope its viewBox is one Artboard, the one at (0, 0) or else the first, which Inkscape uses as its viewport page; every Artboard is still written, the others as pages outside the viewBox.",
        scopes,
        "No overlays and no maxSize: a png is scale pixels per point, at most 4096 px on its longer side.",
        "kalamo_json is the whole Document as a .kalamo.json file in text content, which kalamo_doc_open reads back; scope, scale and background do not apply to it.",
      ].join(" "),
      inputSchema: {
        docId,
        format: z.enum(["svg", "png", "kalamo_json"]),
        scope,
        scale: scale.describe("png only: pixels per point."),
        background,
        txId: readTxId,
      },
      outputSchema: ExportOutput.shape,
      annotations: read,
    },
    async ({ docId, format, scale, background, ...req }) => {
      if (format === "kalamo_json") {
        const { text } = await service.file(docId, req.txId);
        return { structuredContent: {}, content: [{ type: "text", text }] };
      }
      const opts = { ...req, background: color(background) };
      if (format === "png") {
        const { png, viewport } = await service.png(docId, { ...opts, scale });
        return image(png, viewport);
      }
      const { svg, docRect } = await service.svg(docId, opts);
      return { structuredContent: { docRect }, content: [{ type: "text", text: svg }] };
    },
  );

  tool(
    "kalamo_doc_list",
    {
      title: "List Documents",
      description:
        "The Documents you own or that are shared with you, newest first: docId, name, createdAt and your role. An owner or editor can write; a viewer, or any Agent connected read-only, can only read, and its writes fail with PERMISSION_DENIED. Use kalamo_doc_get_info on one for its Artboards and rev.",
      inputSchema: {},
      outputSchema: DocListOutput.shape,
      annotations: read,
    },
    async () => json(await service.list()),
  );

  tool(
    "kalamo_doc_delete",
    {
      title: "Delete Document",
      description:
        "Delete a Document you own, for everyone it is shared with. It cannot be undone: nothing is kept, and later calls with the docId fail with DOC_NOT_FOUND. Only the owner can delete; anyone else gets PERMISSION_DENIED.",
      inputSchema: { docId },
      outputSchema: DocDeleteOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ docId }) => json(await service.delete(docId)),
  );

  tool(
    "kalamo_doc_get_info",
    {
      title: "Document info",
      description:
        "A Document's name, Artboards, Node count, current committed rev and how many browsers have it open right now. Call it before writing to learn the rev to pass as ifRev and whether a person is watching.",
      inputSchema: { docId },
      outputSchema: DocInfoOutput.shape,
      annotations: read,
    },
    async ({ docId }) => json(await service.info(docId)),
  );

  tool(
    "kalamo_doc_changes",
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
    async ({ docId, sinceRev, limit }) => json(await service.changes(docId, sinceRev, limit)),
  );

  tool(
    "kalamo_tx_begin",
    {
      title: "Begin Transaction",
      description: [
        "Start a Transaction to make several writes one step that people see, and undo, at once.",
        "Pass the returned txId to each write, and to node_get, node_query, doc_outline, render and export to see your uncommitted work; nobody else sees it until kalamo_tx_commit.",
        "It rolls back after 5 minutes without a call carrying its txId. label becomes the summary in kalamo_doc_changes. rev is the committed rev, for ifRev.",
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
    async ({ docId, label }) => json(await service.begin(docId, label)),
  );

  tool(
    "kalamo_tx_commit",
    {
      title: "Commit Transaction",
      description: [
        "Apply every write of the Transaction at once: rev goes up by one and the receipt lists every created, updated and deleted id.",
        "Properties someone else changed meanwhile are kept unless the Transaction changed the same property. If someone deleted a Node the Transaction edited, or a Layer or Group it created Nodes in, the commit fails with NODE_GONE listing them and the Transaction stays open for kalamo_tx_rollback. If the merge would break a tree rule (a cycle with moves someone committed meanwhile, a Layer in a Group, two Clipping Paths in one Layer or Group, or no top-level Layer left once deletes meet deletes made meanwhile), it fails the same way with TREE_CONFLICT. A Node created on top of a parent someone else also added to meanwhile goes above theirs.",
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
    async ({ docId, txId, ifRev, intent }) =>
      json(await service.commitTx(docId, txId, { ifRev, intent })),
  );

  tool(
    "kalamo_tx_rollback",
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
    async ({ docId, txId }) => json(await service.rollback(docId, txId)),
  );

  // MCP lets tools/call omit arguments, but the SDK validates before any Kalamo code and rejects
  // undefined as text. Fill in {} on each incoming message, after connect installs the SDK's
  // handler, so parseArgs answers as for any other call (ADR-0050).
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await connect(transport);
    const dispatch = transport.onmessage;
    transport.onmessage = (message, extra) =>
      dispatch?.(
        isJSONRPCRequest(message) &&
          message.method === "tools/call" &&
          message.params?.arguments === undefined
          ? { ...message, params: { ...message.params, arguments: {} } }
          : message,
        extra,
      );
  };

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

/** A txWrite tool's arguments as the service takes them: docId, the operation input as given, then the write options given. */
const splitTxWrite = <T extends { docId: string; intent?: string; txId?: string; ifRev?: number }>({
  docId,
  intent,
  txId,
  ifRev,
  ...input
}: T) => {
  const write = Object.entries({ intent, txId, ifRev }).filter(([, v]) => v !== undefined);
  return [docId, input, Object.fromEntries(write) as Pick<T, "intent" | "txId" | "ifRev">] as const;
};
