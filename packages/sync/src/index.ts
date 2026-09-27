export * from "./protocol.ts";

import type {
  Anchor,
  Artboard,
  ArtboardInput,
  ConciseView,
  FullView,
  MaskInput,
  NodeInput,
  NodeQuery,
  OutlineNode,
  OutlineOptions,
  PathEditInput,
  PathOpInput,
  Rect,
  RenderOverlay,
  RenderScope,
  TransformInput,
  UpdateInput,
  WriteReceipt,
} from "@zibel/core";

/** Accepted by every write. `intent` is stored with the Transaction (F-COLLAB-04). */
export interface WriteOptions {
  intent?: string;
  /** Apply the valid items and report the rest in the receipt's `failed` (F-MCP-16). */
  partial?: boolean;
  /** Stage the write in this open Transaction instead of committing it (ADR-0008). */
  txId?: string;
  /** Fail with REV_CONFLICT unless the committed `rev` equals this. */
  ifRev?: number;
}

/** One committed Transaction, as `doc_changes` lists it (F-MCP-14). */
export interface ChangeEntry {
  rev: number;
  txId: string;
  actor: string;
  summary: string;
  createdIds: string[];
  updatedIds: string[];
  deletedIds: string[];
  intent: string | null;
}

/** A `path_edit` receipt: the path's new `d` and its Anchors, as stored. */
export interface PathEditReceipt extends WriteReceipt {
  d: string;
  subpaths: { closed: boolean; anchors: (Anchor & { index: number })[] }[];
}

export interface DocInfo {
  docId: string;
  name: string;
  artboards: Artboard[];
  nodeCount: number;
  rev: number;
  /** Browsers subscribed over WebSocket right now (ADR-0009). */
  browsers: number;
}

/** A Document as `doc_list` lists it, from the D1 index (ADR-0015). */
export interface DocSummary {
  docId: string;
  name: string;
  createdAt: string;
}

export interface CreatedDocument {
  docId: string;
  defaultLayerId: string;
  artboards: Artboard[];
  rev: number;
}

/** A Document made from a `.zibel.json` file: `nodes` is the Layer list (ADR-0016). */
export interface OpenedDocument {
  docId: string;
  name: string;
  artboards: Artboard[];
  rev: number;
  nodes: OutlineNode[];
  /** What the file held that the Document does not, one per kind (ADR-0017). */
  warnings: WriteReceipt["warnings"];
}

/**
 * What the MCP tools (and later the browser) need from a Document, for one Actor.
 * Failures reject with a `ZibelError`.
 */
export interface DocumentService {
  create(input: {
    name: string;
    artboards: ArtboardInput[];
    intent?: string;
  }): Promise<CreatedDocument>;
  /** A new Document from `.zibel.json` text, keeping its Node and Artboard ids (ADR-0016). */
  /** `name` is the file's name, for an SVG that names no Document. */
  open(input: { content: string; name?: string; intent?: string }): Promise<OpenedDocument>;
  /**
   * Place (ADR-0017): an SVG as one new Group under `parentId`, every id new, centred on
   * `position` (default the parent's Artboard) after `fit` scales it to that Artboard, or where it
   * is with `inPlace`. A Zibel copy's Nodes go into `parentId` without the Group (ADR-0030).
   * `name` is the file's name. `nodes` is the outline of what went into `parentId`, to depth 2.
   */
  place(
    docId: string,
    input: {
      svg: string;
      parentId: string;
      position?: { x: number; y: number };
      fit?: boolean;
      inPlace?: boolean;
      name?: string;
    } & Pick<WriteOptions, "txId" | "ifRev" | "intent">,
  ): Promise<WriteReceipt & { nodes: OutlineNode[] }>;
  /**
   * Place for a bitmap (ADR-0027): `src` is an http(s) URL, fetched by the server, or a data URL.
   * The Image is framed by `frame`, else centred on the parent's Artboard at its pixel size;
   * `asTemplate` puts it on a new locked Template Layer beneath the parent's Layer, at 50%.
   */
  placeImage(
    docId: string,
    input: {
      src: string;
      parentId: string;
      frame?: { x: number; y: number; width?: number; height?: number };
      asTemplate?: boolean;
    } & Pick<WriteOptions, "txId" | "ifRev" | "intent">,
  ): Promise<WriteReceipt>;
  /** Every Document, newest first. */
  list(): Promise<{ documents: DocSummary[] }>;
  info(docId: string): Promise<DocInfo>;
  createNodes(docId: string, nodes: NodeInput[], opts?: WriteOptions): Promise<WriteReceipt>;
  updateNodes(docId: string, updates: UpdateInput[], opts?: WriteOptions): Promise<WriteReceipt>;
  deleteNodes(docId: string, nodeIds: string[], opts?: WriteOptions): Promise<WriteReceipt>;
  transformNodes(docId: string, input: TransformInput, opts?: WriteOptions): Promise<WriteReceipt>;
  /** Illustrator's Clipping Mask > Make and Release (ADR-0021). */
  makeMask(docId: string, input: MaskInput, opts?: WriteOptions): Promise<WriteReceipt>;
  releaseMask(docId: string, nodeIds: string[], opts?: WriteOptions): Promise<WriteReceipt>;
  /** Anchor edits on one path (REQUIREMENTS §6.4); a Live Shape is converted first, with a warning. */
  pathEdit(docId: string, input: PathEditInput, opts?: WriteOptions): Promise<PathEditReceipt>;
  /** The Object > Path commands (REQUIREMENTS §6.4): convert_to_path so far (ADR-0032). */
  pathOp(docId: string, input: PathOpInput, opts?: WriteOptions): Promise<WriteReceipt>;
  /** Reads take `txId` to see that open Transaction's uncommitted edits. */
  get(
    docId: string,
    nodeIds: string[],
    detail: "concise" | "full",
    txId?: string,
  ): Promise<{ rev: number; nodes: (ConciseView | FullView)[] }>;
  outline(
    docId: string,
    opts: OutlineOptions,
    txId?: string,
  ): Promise<{ rev: number; nodes: OutlineNode[] }>;
  query(
    docId: string,
    q: NodeQuery,
    txId?: string,
  ): Promise<{ rev: number; nodes: ConciseView[]; nextCursor: string | null }>;
  /** A PNG of the scope, and the Viewport mapping its pixels back (ADR-0014). */
  render(docId: string, req: RasterRequest): Promise<{ png: Uint8Array; viewport: Viewport }>;
  /** The SVG of the scope, the artwork only. */
  svg(docId: string, req: RenderRequest): Promise<{ svg: string; docRect: Rect }>;
  /** The whole Document as `.zibel.json` text (ADR-0016). */
  file(docId: string, txId?: string): Promise<{ text: string }>;
  begin(docId: string, label?: string): Promise<{ txId: string; rev: number }>;
  commitTx(
    docId: string,
    txId: string,
    opts?: { ifRev?: number; intent?: string },
  ): Promise<WriteReceipt>;
  rollback(docId: string, txId: string): Promise<{ txId: string; rev: number }>;
  changes(
    docId: string,
    sinceRev: number,
    limit?: number,
  ): Promise<{ rev: number; changes: ChangeEntry[] }>;
}

/** What `render` and `export` draw (ADR-0014). */
export interface RenderRequest {
  /** Omitted: the whole Document, every Artboard. */
  scope?: RenderScope;
  /** A parsed `#RRGGBB` or `#RRGGBBAA` filling the whole scope beneath everything. */
  background?: string;
  /** See this open Transaction's uncommitted edits. */
  txId?: string;
}

export interface RasterRequest extends RenderRequest {
  /** Pixels per point. */
  scale: number;
  /** Lower `scale` until the longer side is at most this many pixels. */
  maxSize?: number;
  overlays?: RenderOverlay[];
}

/** Maps rendered pixels back to document coordinates (F-MCP-11). */
export interface Viewport {
  docRect: Rect;
  pixelSize: { width: number; height: number };
  scale: number;
}
