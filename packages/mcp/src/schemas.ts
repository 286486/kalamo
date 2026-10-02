import { Rect, ValidateRule, WriteReceipt } from "@kalamo/core";
import { ROLES } from "@kalamo/sync";
import { z } from "zod";

const Artboards = z.array(
  z.object({ id: z.string(), name: z.string(), frame: Rect, background: z.string().optional() }),
);

export const CreatedDocumentOutput = z.object({
  docId: z.string(),
  defaultLayerId: z.string(),
  artboards: Artboards,
  rev: z.number().int(),
});

export const DocListOutput = z.object({
  documents: z.array(
    z.object({
      docId: z.string(),
      name: z.string(),
      createdAt: z.string(),
      role: z.enum(ROLES),
    }),
  ),
});

export const DocDeleteOutput = z.object({ docId: z.string(), deleted: z.literal(true) });

export const DocInfoOutput = z.object({
  docId: z.string(),
  name: z.string(),
  artboards: Artboards,
  nodeCount: z.number().int(),
  rev: z.number().int(),
  browsers: z.number().int(),
});

const OutlineNode = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  bounds: Rect.nullable().optional(),
  childCount: z.number().int(),
  visible: z.boolean(),
  locked: z.boolean(),
  get children() {
    return z.array(OutlineNode).optional();
  },
});

export const OpenedDocumentOutput = z.object({
  docId: z.string(),
  name: z.string(),
  artboards: Artboards,
  rev: z.number().int(),
  nodes: z.array(OutlineNode),
  warnings: WriteReceipt.shape.warnings,
});

/** svg_import's receipt: `nodes` is the placed Group's outline to depth 2. */
const XY = z.tuple([z.number(), z.number()]);
export const PathEditOutput = WriteReceipt.extend({
  d: z.string(),
  subpaths: z.array(
    z.object({
      closed: z.boolean(),
      anchors: z.array(
        z.object({
          index: z.number().int(),
          anchor: XY,
          handleIn: XY.nullable(),
          handleOut: XY.nullable(),
          type: z.enum(["corner", "smooth"]),
        }),
      ),
    }),
  ),
});

export const PlacedOutput = WriteReceipt.extend({ nodes: z.array(OutlineNode) });

export const DuplicateOutput = WriteReceipt.extend({
  copies: z
    .record(z.string(), z.array(z.string()))
    .describe("Each source id's new top-level ids, in order k = 1…count."),
  geometricBounds: z
    .record(z.string(), Rect.nullable())
    .describe("Each new top-level id's geometricBounds, in document coordinates."),
});

export const OutlineOutput = z.object({ rev: z.number().int(), nodes: z.array(OutlineNode) });

export const ValidateOutput = z.object({
  rev: z.number().int(),
  issues: z.array(
    z.object({
      rule: ValidateRule,
      nodeId: z.string(),
      message: z.string(),
      hint: z.string().optional(),
    }),
  ),
});

const Viewport = z.object({
  docRect: Rect,
  pixelSize: z.object({ width: z.number().int(), height: z.number().int() }),
  scale: z.number(),
});

export const RenderOutput = z.object({ viewport: Viewport });

/** svg: docRect, its viewBox; png: viewport. */
export const ExportOutput = z.object({ docRect: Rect.optional(), viewport: Viewport.optional() });

/** A `node_get` entry: the concise fields typed; `full` adds the stored and derived properties. */
const NodeView = z.looseObject({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  visible: z.boolean(),
  locked: z.boolean(),
  childCount: z.number().int(),
  geometricBounds: Rect.nullable(),
});

export const NodeGetOutput = z.object({ rev: z.number().int(), nodes: z.array(NodeView) });

export const NodeQueryOutput = NodeGetOutput.extend({ nextCursor: z.string().nullable() });

export const TxOutput = z.object({ txId: z.string(), rev: z.number().int() });

export const ChangesOutput = z.object({
  rev: z.number().int(),
  changes: z.array(
    z.object({
      rev: z.number().int(),
      txId: z.string(),
      actor: z.string(),
      summary: z.string(),
      createdIds: z.array(z.string()),
      updatedIds: z.array(z.string()),
      deletedIds: z.array(z.string()),
      intent: z.string().nullable(),
    }),
  ),
});
