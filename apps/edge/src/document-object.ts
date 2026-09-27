import { DurableObject } from "cloudflare:workers";
import {
  type Artboard,
  type ArtboardInput,
  bounds,
  type ConciseView,
  commitTransaction,
  convertToPath,
  createDocument,
  createNodes,
  type Document,
  dataUrl,
  deleteNodes,
  type ErrorData,
  editPath,
  type Failed,
  type FullView,
  fontWarnings,
  type ImageFile,
  type ImageInfo,
  type ImageSource,
  imageId,
  type MaskInput,
  makeMask,
  type Node,
  type NodeInput,
  type NodeQuery,
  newId,
  nodeView,
  type OutlineNode,
  type OutlineOptions,
  outline,
  overflowWarnings,
  overlay,
  type PathEditInput,
  type PathOpInput,
  placeImage,
  placeNodes,
  queryNodes,
  type Rect,
  readImage,
  releaseMask,
  revert,
  serializeDocument,
  type TransformInput,
  type TxRow,
  transformNodes,
  type UpdateInput,
  union,
  updateNodes,
  type WriteReceipt,
  ZibelError,
} from "@zibel/core";
import { type OpenedFile, scopeRect, svgRect, toSvg } from "@zibel/io";
import { fit, renderSvg } from "@zibel/render";
import {
  type ChangeEntry,
  ClientMessage,
  type Command,
  type CreatedDocument,
  type DocInfo,
  type DocumentMessage,
  type OpenedDocument,
  type PathEditReceipt,
  type RasterRequest,
  type RejectedMessage,
  type RenderRequest,
  type TxMessage,
  type Viewport,
  type WriteOptions,
} from "@zibel/sync";

/** RPC results carry errors as data: Workers RPC keeps only the message of a thrown error. */
export type Result<T> = T | { error: ErrorData };

/** A Transaction rolls back after this long without a call carrying its `txId` (F-HIST-02). */
const TX_IDLE_MS = 5 * 60_000;

/** Every browser acts as this one Actor until OAuth (ADR-0010). */
const USER = "user";

/** Transactions the undo stack keeps (F-HIST-01). */
const UNDO_DEPTH = 200;

/** An image file is stored in rows of this many bytes, under SQLite's 2 MB row cap (ADR-0023). */
const CHUNK = 1024 * 1024;

/**
 * How a commit moves the undo and redo stacks (ADR-0011): an edit pushes onto the undo stack and
 * clears redo; an undo or redo pops `popped` and pushes onto `stack`. `label` names the edit in
 * both directions.
 */
type Step = { label: string; stack: "undo" | "redo"; popped?: number };

/** A browser command's write also names the command its broadcast answers. */
type Options = WriteOptions & { commandId?: string };

const ENDED = {
  committed: "committed",
  rolled_back: "rolled back",
  expired: "expired after 5 minutes idle",
} as const;

interface Change {
  created?: Node[];
  updated?: Node[];
  deletedIds?: string[];
}

/**
 * The authoritative store for one Document (ADR-0003). Nodes and the Transaction log are SQLite rows.
 * ponytail: every call reloads the Document from SQLite; cache it in memory when Documents get large.
 */
export class DocumentObject extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS doc (id TEXT PRIMARY KEY, name TEXT NOT NULL, rev INTEGER NOT NULL, artboards TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tx_log (
        rev INTEGER PRIMARY KEY, tx_id TEXT NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL,
        created_ids TEXT NOT NULL, updated_ids TEXT NOT NULL, deleted_ids TEXT NOT NULL,
        intent TEXT
      );
      -- ponytail: ended tx rows are kept for TX_EXPIRED and never pruned; prune with history_list.
      CREATE TABLE IF NOT EXISTS tx (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, label TEXT, deadline INTEGER NOT NULL, ended TEXT
      );
      CREATE TABLE IF NOT EXISTS tx_nodes (
        tx_id TEXT NOT NULL, node_id TEXT NOT NULL, base TEXT, working TEXT,
        PRIMARY KEY (tx_id, node_id)
      );
      -- The Delta Log (ADR-0011): each committed Transaction's Node copies before and after, while
      -- its rev is on the undo or redo stack.
      CREATE TABLE IF NOT EXISTS tx_delta (
        rev INTEGER NOT NULL, node_id TEXT NOT NULL, before TEXT, after TEXT,
        PRIMARY KEY (rev, node_id)
      );
      CREATE TABLE IF NOT EXISTS history (rev INTEGER PRIMARY KEY, stack TEXT NOT NULL, label TEXT NOT NULL);
      -- Image files by SHA-256 (ADR-0023). Never changed; not deleted yet.
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_chunks (
        id TEXT NOT NULL, n INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (id, n)
      );
    `);
  }

  create(input: {
    docId: string;
    name: string;
    artboards: ArtboardInput[];
    actor: string;
    intent?: string;
  }): Result<CreatedDocument> {
    return guard(() => {
      const { doc, defaultLayerId } = createDocument({
        id: input.docId,
        name: input.name,
        artboards: input.artboards,
      });
      const rev = this.init(doc, input.actor, `Create Document "${doc.name}"`, input.intent);
      return { docId: doc.id, defaultLayerId, artboards: doc.artboards, rev };
    });
  }

  /** A new Document from a parsed file, keeping its ids (ADR-0016) and its image files. */
  open(input: {
    docId: string;
    name: string;
    artboards: Artboard[];
    nodes: Node[];
    images: Map<string, ImageFile>;
    actor: string;
    intent?: string;
  }): Result<Omit<OpenedDocument, "warnings">> {
    return guard(() => {
      const doc: Document = {
        id: input.docId,
        name: input.name,
        version: 1,
        rev: 0,
        artboards: input.artboards,
        nodes: new Map(input.nodes.map((n) => [n.id, n])),
        images: input.images,
      };
      this.storeImages(input.images);
      const rev = this.init(doc, input.actor, `Open Document "${doc.name}"`, input.intent);
      const nodes = outline(doc, { depth: 1 });
      return { docId: doc.id, name: doc.name, artboards: doc.artboards, rev, nodes };
    });
  }

  /** Stores a new Document and commits its Nodes as rev 1. */
  private init(doc: Document, actor: string, summary: string, intent: string | undefined) {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO doc (id, name, rev, artboards) VALUES (?, ?, 0, ?)",
        doc.id,
        doc.name,
        JSON.stringify(doc.artboards),
      );
      // Not undoable: undo stops at the Document's creation (ADR-0011).
      return this.commit(actor, summary, intent, { created: [...doc.nodes.values()] }, null);
    }).rev;
  }

  /**
   * A browser subscribes by upgrading to a WebSocket (ADR-0009). Nothing awaits between load and
   * accept, so no commit can slip in before the Document message.
   */
  override fetch(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const doc = guard(() => this.load());
    if ("error" in doc) return Response.json(doc.error, { status: 404 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const msg: DocumentMessage = {
      type: "document",
      rev: doc.rev,
      name: doc.name,
      artboards: doc.artboards,
      nodes: [...doc.nodes.values()],
    };
    server.send(JSON.stringify(msg));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Completes the close handshake a browser starts, so it leaves getWebSockets. */
  override webSocketClose(ws: WebSocket) {
    ws.close();
  }

  /**
   * One browser gesture: commits it as one Transaction of the User Actor, or answers that browser
   * alone with `rejected` (ADR-0010).
   */
  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    let json: unknown;
    try {
      json = JSON.parse(data as string);
    } catch {}
    const parsed = ClientMessage.safeParse(json);
    // A malformed message is a client bug; the browser reconnects and gets the Document again.
    if (!parsed.success) return ws.close(1007, "Expected a command message.");
    const { id, command } = parsed.data;
    const result =
      command.type === "undo" || command.type === "redo"
        ? this[command.type](USER, { commandId: id })
        : this.edit(command, id);
    if ("error" in result) {
      const msg: RejectedMessage = { type: "rejected", id, error: result.error };
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * A create, transform, delete, update, Clipping Mask or path command from a browser. The browser only names
   * Nodes it was sent, so a missing one was deleted: delete beats edit (ADR-0010).
   */
  private edit(
    command: Exclude<Command, { type: "undo" | "redo" }>,
    commandId: string,
  ): Result<WriteReceipt> {
    const nodeIds =
      command.type === "create"
        ? command.nodes.flatMap((n) => n.parentId ?? [])
        : command.type === "transform"
          ? command.input.nodeIds
          : command.type === "update"
            ? [command.nodeId]
            : command.type === "mask_make"
              ? [command.input.clipNodeId, ...command.input.contentIds]
              : command.type === "path_edit"
                ? [command.input.nodeId]
                : command.type === "path_op"
                  ? command.input.nodeIds
                  : command.nodeIds;
    // The socket was accepted for an existing Document, so load() cannot throw DOC_NOT_FOUND.
    const { nodes } = this.load();
    const gone = nodeIds.filter((n) => !nodes.has(n));
    if (gone.length > 0) {
      return {
        error: {
          code: "NODE_GONE",
          message: `Someone deleted ${gone.join(", ")} before this ${command.type} arrived.`,
          hint: "Deleted Nodes do not come back; nothing was changed.",
          path: "nodeIds",
          nodeIds: gone,
        },
      };
    }
    if (command.type === "create") {
      // No image data URLs to store first, unlike this.createNodes: a browser places images by HTTP.
      return this.write(USER, { commandId }, "Create", (doc) => {
        const { nodes, keyMap, failed } = createNodes(doc, command.nodes);
        const warnings = [...fontWarnings(nodes), ...overflowWarnings(nodes)];
        return { created: nodes, keyMap, warnings, failed };
      });
    }
    if (command.type === "transform")
      return this.transformNodes(command.input, USER, { commandId });
    if (command.type === "update") {
      return this.updateNodes([{ nodeId: command.nodeId, patch: command.patch }], USER, {
        commandId,
      });
    }
    if (command.type === "mask_make") return this.makeMask(command.input, USER, { commandId });
    if (command.type === "mask_release") {
      return this.releaseMask(command.nodeIds, USER, { commandId });
    }
    if (command.type === "path_edit") return this.pathEdit(command.input, USER, { commandId });
    if (command.type === "path_op") return this.pathOp(command.input, USER, { commandId });
    return this.deleteNodes(command.nodeIds, USER, { commandId });
  }

  /** Sends to every browser. Called after the SQLite transaction, so a dead socket cannot undo a write. */
  private broadcast(msg: TxMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // A socket that is closing; the runtime drops it from getWebSockets.
      }
    }
  }

  info(): Result<DocInfo> {
    return guard(() => {
      const { id, name, rev, artboards, nodes } = this.load();
      return {
        docId: id,
        name,
        artboards,
        nodeCount: nodes.size,
        rev,
        browsers: this.ctx.getWebSockets().length,
      };
    });
  }

  /**
   * Stores the file of every Image given as a data URL first, so core sees only ids (ADR-0023).
   * With `partial`, an item whose file is refused fails alone, under its own index.
   */
  async createNodes(
    inputs: NodeInput[],
    actor: string,
    opts: WriteOptions = {},
  ): Promise<Result<WriteReceipt>> {
    const kept: number[] = [];
    const refused: Failed[] = [];
    const ready: NodeInput[] = [];
    for (const [i, input] of inputs.entries()) {
      try {
        ready.push((await this.ingest(input, `nodes[${i}]`)) as NodeInput);
        kept.push(i);
      } catch (e) {
        if (!(e instanceof ZibelError)) throw e;
        if (!opts.partial) return { error: e.data };
        refused.push({ index: i, ...e.data });
      }
    }
    const [first] = refused;
    if (ready.length === 0 && first) {
      const { index: _, ...error } = first;
      return { error };
    }
    // Core numbers what it was given; put back each item's own index.
    const own = (f: Failed): Failed => {
      const index = kept[f.index] ?? f.index;
      return {
        ...f,
        index,
        ...(f.path && { path: f.path.replace(/^nodes\[\d+\]/, `nodes[${index}]`) }),
      };
    };
    return this.write(actor, opts, "Create", (doc) => {
      const { nodes, keyMap, failed } = createNodes(doc, ready, opts);
      return {
        created: nodes,
        keyMap,
        warnings: [...fontWarnings(nodes), ...overflowWarnings(nodes)],
        failed: [...refused, ...failed.map(own)].sort((a, b) => a.index - b.index),
      };
    });
  }

  /** `input` with each Image's data URL, inline children's too, stored and replaced by its id. */
  private async ingest(input: unknown, path: string): Promise<unknown> {
    if (typeof input !== "object" || input === null) return input;
    const item = input as { type?: unknown; src?: unknown; children?: unknown };
    if (item.type === "image" && typeof item.src === "string" && item.src.startsWith("data:")) {
      const file = readImage(item.src, `${path}.src`);
      const id = await imageId(file.bytes);
      this.storeImages(new Map([[id, file]]));
      return { ...item, src: id };
    }
    if (Array.isArray(item.children)) {
      const children = [];
      for (const [k, c] of item.children.entries()) {
        children.push(await this.ingest(c, `${path}.children[${k}]`));
      }
      return { ...item, children };
    }
    return input;
  }

  /** Stores files the Document does not hold yet; a stored id always names the same bytes. */
  private storeImages(files: Map<string, ImageFile>) {
    this.ctx.storage.transactionSync(() => {
      for (const [id, { mime, width, height, bytes }] of files) {
        const inserted = this.sql.exec(
          "INSERT OR IGNORE INTO images (id, mime, width, height) VALUES (?, ?, ?, ?)",
          id,
          mime,
          width,
          height,
        ).rowsWritten;
        if (!inserted) continue;
        for (let n = 0; n * CHUNK < bytes.length; n++) {
          const chunk = bytes.slice(n * CHUNK, (n + 1) * CHUNK);
          this.sql.exec("INSERT INTO image_chunks VALUES (?, ?, ?)", id, n, chunk.buffer);
        }
      }
    });
  }

  /** An image file's type and bytes, for the Worker to serve. */
  image(id: string): Result<{ mime: string; bytes: Uint8Array }> {
    return guard(() => this.bytesOf(id));
  }

  private bytesOf(id: string): { mime: ImageInfo["mime"]; bytes: Uint8Array<ArrayBuffer> } {
    const row = this.sql
      .exec<{ mime: ImageInfo["mime"] }>("SELECT mime FROM images WHERE id = ?", id)
      .toArray()[0];
    if (!row) {
      throw new ZibelError({
        code: "INVALID_IMAGE",
        message: `No image with id ${id} in the Document.`,
        hint: "Use the src of an Image in this Document, as node_get returns it.",
        path: "src",
      });
    }
    const chunks = this.sql
      .exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM image_chunks WHERE id = ? ORDER BY n", id)
      .toArray()
      .map((r) => new Uint8Array(r.bytes));
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { mime: row.mime, bytes };
  }

  /** The Document's image files as data URLs, for the SVG and .zibel.json writers. */
  private images: ImageSource = (id) => {
    const { mime, bytes } = this.bytesOf(id);
    return dataUrl({ mime, bytes, width: 0, height: 0 });
  };

  updateNodes(updates: UpdateInput[], actor: string, opts: Options = {}): Result<WriteReceipt> {
    return this.write(actor, opts, "Update", (doc) => {
      const { nodes, failed } = updateNodes(doc, updates, opts);
      return {
        updated: nodes,
        warnings: [...fontWarnings(nodes), ...overflowWarnings(nodes)],
        failed,
      };
    });
  }

  transformNodes(input: TransformInput, actor: string, opts: Options = {}): Result<WriteReceipt> {
    return this.write(actor, opts, "Transform", (doc) => {
      const { nodes, warnings, failed } = transformNodes(doc, input, opts);
      return { updated: nodes, warnings, failed };
    });
  }

  deleteNodes(nodeIds: string[], actor: string, opts: Options = {}): Result<WriteReceipt> {
    return this.write(actor, opts, "Delete", (doc) => deleteNodes(doc, nodeIds, opts));
  }

  makeMask(input: MaskInput, actor: string, opts: Options = {}): Result<WriteReceipt> {
    return this.write(actor, opts, "Make Clipping Mask", (doc) => {
      const { group, updated } = makeMask(doc, input);
      return { created: [group], updated, failed: [], summary: "Make Clipping Mask" };
    });
  }

  releaseMask(nodeIds: string[], actor: string, opts: Options = {}): Result<WriteReceipt> {
    return this.write(actor, opts, "Release Clipping Mask", (doc) => {
      const { nodes, failed } = releaseMask(doc, nodeIds);
      return { updated: nodes, failed, summary: "Release Clipping Mask" };
    });
  }

  pathEdit(input: PathEditInput, actor: string, opts: Options = {}): Result<PathEditReceipt> {
    let edited: ReturnType<typeof editPath> | undefined;
    const result = this.write(actor, opts, "Edit Path", (doc) => {
      edited = editPath(doc, input);
      return {
        updated: [edited.node],
        warnings: edited.warnings,
        failed: [],
        summary: "Edit Path",
      };
    });
    if ("error" in result || !edited) return result as Result<PathEditReceipt>;
    return { ...result, d: edited.node.d, subpaths: edited.subpaths };
  }

  pathOp(input: PathOpInput, actor: string, opts: Options = {}): Result<WriteReceipt> {
    return this.write(actor, opts, "Convert to Path", (doc) => ({
      ...convertToPath(doc, input.nodeIds),
      failed: [],
      summary: "Convert to Path",
    }));
  }

  /**
   * Runs one edit on a freshly loaded Document and commits it as one Transaction, or with `txId`
   * stages it in that Transaction's overlay (ADR-0008). Core throws before changing anything it
   * rejects, so a failure never reaches SQLite.
   */
  private write(
    actor: string,
    opts: Options,
    verb: string,
    edit: (doc: Document) => Change & {
      keyMap?: Record<string, string>;
      warnings?: WriteReceipt["warnings"];
      failed: Failed[];
      /** Replaces the summary made from `verb`. */
      summary?: string;
      skipped?: string[];
    },
    step?: Step,
  ): Result<WriteReceipt> {
    return guard(() => {
      const committed = this.load();
      const doc = this.view(committed, actor, opts.txId);
      this.checkRev(committed, opts.ifRev);
      // Core edits store new Node objects in doc.nodes, so a copy of the Map keeps the Document before.
      const before = { ...doc, nodes: new Map(doc.nodes) };
      const {
        keyMap,
        warnings,
        failed,
        created = [],
        updated = [],
        deletedIds = [],
        skipped,
        ...rest
      } = edit(doc);
      const change = { created, updated, deletedIds };
      const label = rest.summary ?? summary(verb, change);
      const { txId, rev } = this.ctx.storage.transactionSync(() =>
        opts.txId
          ? this.stage(opts.txId, committed.rev, change)
          : this.commit(actor, label, opts.intent, change, step),
      );
      return this.receipt(before, doc, change, {
        txId,
        rev,
        actor,
        opts,
        keyMap,
        warnings,
        skipped,
        failed: opts.partial ? failed : undefined,
      });
    });
  }

  /**
   * The WriteReceipt of a write, and its `tx` broadcast unless it was staged in a Transaction.
   * `bounds` covers the created and updated Nodes after the write and the deleted Nodes before it
   * (CONTEXT.md, WriteReceipt), whichever entry point made the change.
   */
  private receipt(
    before: Document,
    after: Document,
    change: { created: Node[]; updated: Node[]; deletedIds: string[] },
    meta: {
      txId: string;
      rev: number;
      actor: string;
      opts: Options;
      keyMap?: Record<string, string>;
      warnings?: WriteReceipt["warnings"];
      skipped?: string[];
      failed?: Failed[];
    },
  ): WriteReceipt {
    const { created, updated, deletedIds } = change;
    const { txId, rev, actor, opts, skipped = [] } = meta;
    if (!opts.txId) {
      const { intent = null, commandId } = opts;
      const skippedIds = skipped.length > 0 ? skipped : undefined;
      this.broadcast({ type: "tx", rev, txId, actor, intent, ...change, commandId, skippedIds });
    }
    return {
      txId,
      rev,
      createdIds: created.map((n) => n.id),
      updatedIds: updated.map((n) => n.id),
      deletedIds,
      keyMap: meta.keyMap ?? {},
      bounds: union([
        ...[...created, ...updated].map((n) => bounds(after, n)),
        ...deletedIds.map((id) => bounds(before, before.nodes.get(id) as Node)),
      ]),
      warnings: meta.warnings ?? [],
      ...(meta.failed && { failed: meta.failed }),
    };
  }

  /** Reads see the overlay of `txId` when given (ADR-0008); `rev` is always the committed one. */
  get(
    nodeIds: string[],
    detail: "concise" | "full",
    actor: string,
    txId?: string,
  ): Result<{ rev: number; nodes: (ConciseView | FullView)[] }> {
    return guard(() => {
      const doc = this.view(this.load(), actor, txId);
      const nodes = nodeIds.map((id, i) => {
        const node = doc.nodes.get(id);
        if (!node) {
          throw new ZibelError({
            code: "NODE_NOT_FOUND",
            message: `No Node with id ${id}.`,
            hint: "Use doc_outline or the ids from a WriteReceipt.",
            path: `nodeIds[${i}]`,
          });
        }
        return nodeView(doc, node, detail);
      });
      return { rev: doc.rev, nodes };
    });
  }

  outline(
    opts: OutlineOptions,
    actor: string,
    txId?: string,
  ): Result<{ rev: number; nodes: OutlineNode[] }> {
    return guard(() => {
      const doc = this.view(this.load(), actor, txId);
      return { rev: doc.rev, nodes: outline(doc, opts) };
    });
  }

  query(
    q: NodeQuery,
    actor: string,
    txId?: string,
  ): Result<{ rev: number; nodes: ConciseView[]; nextCursor: string | null }> {
    return guard(() => {
      const doc = this.view(this.load(), actor, txId);
      return { rev: doc.rev, ...queryNodes(doc, q) };
    });
  }

  /** The SVG of a Render Scope, as `export` returns it (ADR-0014). */
  svg(actor: string, req: RenderRequest): Result<{ svg: string; docRect: Rect }> {
    return guard(() => {
      const doc = this.view(this.load(), actor, req.txId);
      const rect = svgRect(doc, req.scope);
      return {
        svg: toSvg(doc, rect, {
          scope: req.scope,
          background: req.background,
          images: this.images,
        }),
        docRect: rect,
      };
    });
  }

  /** The whole Document as `.zibel.json` text, as `export` returns it (ADR-0016). */
  file(actor: string, txId?: string): Result<{ text: string }> {
    return guard(() => ({
      text: serializeDocument(this.view(this.load(), actor, txId), this.images),
    }));
  }

  /**
   * The SVG to rasterise at `req.scale`: fitted to whole pixels and `maxSize`, with overlays.
   * The Worker rasterises it, so PNG encoding never blocks this Document's writes.
   */
  raster(actor: string, req: RasterRequest): Result<{ svg: string; viewport: Viewport }> {
    return guard(() => {
      const doc = this.view(this.load(), actor, req.txId);
      const {
        rect: docRect,
        scale,
        pixelSize,
      } = fit(scopeRect(doc, req.scope), req.scale, req.maxSize);
      const svg = renderSvg(doc, docRect, {
        scope: req.scope,
        background: req.background,
        overlays: req.overlays,
        scale,
        images: this.images,
      });
      return { svg, viewport: { docRect, pixelSize, scale } };
    });
  }

  async begin(actor: string, label?: string): Promise<Result<{ txId: string; rev: number }>> {
    const result = guard(() => {
      const { rev } = this.load();
      const txId = newId();
      this.sql.exec(
        "INSERT INTO tx (id, actor, label, deadline) VALUES (?, ?, ?, ?)",
        txId,
        actor,
        label ?? null,
        Date.now() + TX_IDLE_MS,
      );
      return { txId, rev };
    });
    await this.schedule();
    return result;
  }

  /** Applies the overlay onto the Document as committed now: one `rev`, one log row. */
  commitTx(
    txId: string,
    actor: string,
    opts: { ifRev?: number; intent?: string } = {},
  ): Result<WriteReceipt> {
    return guard(() => {
      const doc = this.load();
      const { label } = this.openTx(txId, actor);
      this.checkRev(doc, opts.ifRev);
      const before = { ...doc, nodes: new Map(doc.nodes) };
      const change = commitTransaction(doc, this.rows(txId));
      const { rev } = this.ctx.storage.transactionSync(() => {
        this.end(txId, "committed");
        const text = label ?? summary("Commit", change);
        return this.commit(actor, text, opts.intent, change, undefined, txId);
      });
      return this.receipt(before, doc, change, { txId, rev, actor, opts });
    });
  }

  /**
   * Place for a bitmap (ADR-0027): stores the file the Worker fetched and checked, then writes its
   * Image, on a new Template Layer with `asTemplate`, in one Transaction.
   */
  async placeImage(
    file: ImageFile & { name: string },
    actor: string,
    opts: Options & {
      parentId: string;
      frame?: { x: number; y: number; width?: number; height?: number };
      asTemplate?: boolean;
    },
  ): Promise<Result<WriteReceipt>> {
    const { name, ...image } = file;
    const src = await imageId(image.bytes);
    this.storeImages(new Map([[src, image]]));
    return this.write(actor, opts, "Place", (doc) => ({
      created: placeImage(doc, { src, name }, opts).created,
      failed: [],
    }));
  }

  /**
   * Place (ADR-0017): an SVG's Nodes as one new Group under `opts.parentId`, or a Zibel copy's Nodes
   * directly there (ADR-0030), all with new ids, in one Transaction. `nodes` is the outline of what
   * was put in the parent, to depth 2.
   */
  place(
    file: OpenedFile & { format: "svg" | "zibel_json" },
    actor: string,
    opts: Options & {
      parentId: string;
      position?: { x: number; y: number };
      fit?: boolean;
      inPlace?: boolean;
    },
  ): Result<WriteReceipt & { nodes: OutlineNode[] }> {
    let nodes: OutlineNode[] = [];
    if (file.format === "svg") this.storeImages(file.images);
    const receipt = this.write(actor, opts, "Place", (doc) => {
      if (file.format !== "svg") {
        throw new ZibelError({
          code: "INVALID_DOCUMENT",
          message: "Place takes SVG; this is a .zibel.json file.",
          hint: "Write its Nodes with zibel_node_create, or open it as a new Document with zibel_doc_open.",
          path: "svg",
        });
      }
      const { placedIds, created } = placeNodes(doc, file, opts);
      const placed = new Set(placedIds);
      nodes = outline(doc, { rootId: opts.parentId, depth: 2 }).filter((n) => placed.has(n.id));
      return { created, warnings: file.warnings, failed: [] };
    });
    return "error" in receipt ? receipt : { ...receipt, nodes };
  }

  /** Commits the inverse of the latest undoable Transaction (ADR-0011). */
  undo(actor: string, opts: Options = {}): Result<WriteReceipt> {
    return this.step("undo", actor, opts);
  }

  /** Commits the inverse of the latest undo, when no edit came after it. */
  redo(actor: string, opts: Options = {}): Result<WriteReceipt> {
    return this.step("redo", actor, opts);
  }

  private step(kind: "undo" | "redo", actor: string, opts: Options): Result<WriteReceipt> {
    const top = this.sql
      .exec<{ rev: number; label: string }>(
        "SELECT rev, label FROM history WHERE stack = ? ORDER BY rev DESC LIMIT 1",
        kind,
      )
      .toArray()[0];
    if (!top) {
      return {
        error: {
          code: kind === "undo" ? "NOTHING_TO_UNDO" : "NOTHING_TO_REDO",
          message: `Nothing to ${kind}.`,
          hint:
            kind === "undo"
              ? `Everything since the Document was created, or the latest ${UNDO_DEPTH} Transactions, is undone.`
              : "Redo follows an undo; a Transaction committed since then clears it.",
        },
      };
    }
    const parse = (json: string | null) => (json === null ? null : (JSON.parse(json) as Node));
    const delta = this.sql
      .exec<{ node_id: string; before: string | null; after: string | null }>(
        "SELECT node_id, before, after FROM tx_delta WHERE rev = ?",
        top.rev,
      )
      .toArray()
      .map((r) => ({ id: r.node_id, before: parse(r.before), after: parse(r.after) }));
    const verb = kind === "undo" ? "Undo" : "Redo";
    const stack = kind === "undo" ? "redo" : "undo";
    return this.write(
      actor,
      opts,
      verb,
      (doc) => {
        const { skipped, ...change } = revert(doc, delta);
        const gone = skipped.length > 0 ? `; skipped, deleted since: ${skipped.join(", ")}` : "";
        return {
          ...change,
          skipped,
          failed: [],
          summary: `${verb} "${top.label}"${gone}`,
        };
      },
      { label: top.label, stack, popped: top.rev },
    );
  }

  rollback(txId: string, actor: string): Result<{ txId: string; rev: number }> {
    return guard(() => {
      const { rev } = this.load();
      this.openTx(txId, actor);
      this.end(txId, "rolled_back");
      return { txId, rev };
    });
  }

  /** Rolls back every Transaction past its deadline, then waits for the next one. */
  override async alarm(): Promise<void> {
    const due = this.sql
      .exec<{ id: string }>("SELECT id FROM tx WHERE ended IS NULL AND deadline <= ?", Date.now())
      .toArray();
    for (const { id } of due) this.end(id, "expired");
    await this.schedule();
  }

  /** Committed Transactions after `sinceRev`, oldest first, and the current `rev`. */
  changes(sinceRev: number, limit = 100): Result<{ rev: number; changes: ChangeEntry[] }> {
    return guard(() => ({ rev: this.load().rev, changes: this.log(sinceRev, limit) }));
  }

  /** Throws REV_CONFLICT unless `ifRev` is absent or equals the committed `rev`. */
  private checkRev(doc: Document, ifRev: number | undefined) {
    if (ifRev === undefined || ifRev === doc.rev) return;
    // ponytail: unbounded when ifRev is far behind; cap the ids if a conflict ever gets large.
    const nodeIds = [
      ...new Set(
        this.log(ifRev, -1).flatMap((c) => [...c.createdIds, ...c.updatedIds, ...c.deletedIds]),
      ),
    ];
    throw new ZibelError({
      code: "REV_CONFLICT",
      message: `The Document is at rev ${doc.rev}, not ${ifRev}.`,
      hint: `Call zibel_doc_changes with sinceRev: ${ifRev} to see what changed, then retry with ifRev: ${doc.rev}.`,
      path: "ifRev",
      rev: doc.rev,
      nodeIds,
    });
  }

  /** `limit` -1 means all. */
  private log(sinceRev: number, limit: number): ChangeEntry[] {
    return this.sql
      .exec<Record<string, string | number | null>>(
        "SELECT * FROM tx_log WHERE rev > ? ORDER BY rev LIMIT ?",
        sinceRev,
        limit,
      )
      .toArray()
      .map((r) => ({
        rev: r.rev as number,
        txId: r.tx_id as string,
        actor: r.actor as string,
        summary: r.summary as string,
        createdIds: JSON.parse(r.created_ids as string),
        updatedIds: JSON.parse(r.updated_ids as string),
        deletedIds: JSON.parse(r.deleted_ids as string),
        intent: (r.intent as string | null) ?? null,
      }));
  }

  /** The Document as `txId` sees it, extending that Transaction's deadline; `doc` without it. */
  private view(doc: Document, actor: string, txId: string | undefined): Document {
    if (txId === undefined) return doc;
    this.openTx(txId, actor);
    return overlay(doc, this.rows(txId));
  }

  /** Resolves an open Transaction of `actor` and extends its deadline. */
  private openTx(txId: string, actor: string): { label: string | null } {
    const tx = this.sql
      .exec<{ actor: string; label: string | null; deadline: number; ended: string | null }>(
        "SELECT actor, label, deadline, ended FROM tx WHERE id = ?",
        txId,
      )
      .toArray()[0];
    if (!tx || tx.actor !== actor) {
      throw new ZibelError({
        code: "TX_NOT_FOUND",
        message: `No Transaction ${txId} of yours in this Document.`,
        hint: "Use the txId from your zibel_tx_begin on this Document, or begin a new one.",
        path: "txId",
      });
    }
    // The alarm may run late; a Transaction past its deadline is expired whether it ran or not.
    if (!tx.ended && tx.deadline <= Date.now()) {
      this.end(txId, "expired");
      tx.ended = "expired";
    }
    if (tx.ended) {
      let how: string = ENDED[tx.ended as keyof typeof ENDED];
      if (tx.ended === "committed") {
        const log = this.sql.exec<{ rev: number }>("SELECT rev FROM tx_log WHERE tx_id = ?", txId);
        how += ` at rev ${log.one().rev}`;
      }
      throw new ZibelError({
        code: "TX_EXPIRED",
        message: `Transaction ${txId} has ended.`,
        hint: `It was ${how}. Begin a new Transaction with zibel_tx_begin, or write without txId.`,
        path: "txId",
      });
    }
    this.sql.exec("UPDATE tx SET deadline = ? WHERE id = ?", Date.now() + TX_IDLE_MS, txId);
    return { label: tx.label };
  }

  private rows(txId: string): TxRow[] {
    const parse = (json: string | null) => (json === null ? null : (JSON.parse(json) as Node));
    return this.sql
      .exec<{ node_id: string; base: string | null; working: string | null }>(
        "SELECT node_id, base, working FROM tx_nodes WHERE tx_id = ? ORDER BY rowid",
        txId,
      )
      .toArray()
      .map((r) => ({ id: r.node_id, base: parse(r.base), working: parse(r.working) }));
  }

  /**
   * Records the edit in the overlay. `base` is taken from the committed Node on first touch only.
   * Call inside transactionSync.
   */
  private stage(txId: string, rev: number, change: Required<Change>) {
    const upsert = (id: string, working: string | null) =>
      this.sql.exec(
        `INSERT INTO tx_nodes (tx_id, node_id, base, working)
         VALUES (?, ?, (SELECT json FROM nodes WHERE id = ?), ?)
         ON CONFLICT (tx_id, node_id) DO UPDATE SET working = excluded.working`,
        txId,
        id,
        id,
        working,
      );
    for (const n of [...change.created, ...change.updated]) upsert(n.id, JSON.stringify(n));
    for (const id of change.deletedIds) upsert(id, null);
    return { txId, rev };
  }

  private end(txId: string, how: keyof typeof ENDED) {
    this.sql.exec("UPDATE tx SET ended = ? WHERE id = ?", how, txId);
    this.sql.exec("DELETE FROM tx_nodes WHERE tx_id = ?", txId);
  }

  /** Points the alarm at the earliest open deadline, or clears it. */
  private async schedule() {
    const { next } = this.sql
      .exec<{ next: number | null }>("SELECT MIN(deadline) AS next FROM tx WHERE ended IS NULL")
      .one();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private load(): Document {
    const row = this.sql
      .exec<{ id: string; name: string; rev: number; artboards: string }>("SELECT * FROM doc")
      .toArray()[0];
    if (!row) {
      throw new ZibelError({
        code: "DOC_NOT_FOUND",
        message: "Document not found.",
        hint: "Create one with zibel_doc_create, or check the docId.",
        path: "docId",
      });
    }
    const nodes = new Map<string, Node>();
    for (const { json } of this.sql.exec<{ json: string }>("SELECT json FROM nodes")) {
      const node = JSON.parse(json) as Node;
      nodes.set(node.id, node);
    }
    const images = new Map<string, ImageInfo>();
    const rows = this.sql.exec<{ id: string; mime: string; width: number; height: number }>(
      "SELECT id, mime, width, height FROM images",
    );
    for (const { id, ...info } of rows) images.set(id, info as ImageInfo);
    return {
      id: row.id,
      name: row.name,
      version: 1,
      rev: row.rev,
      artboards: JSON.parse(row.artboards),
      nodes,
      images,
    };
  }

  /**
   * Writes the changed Nodes, bumps `rev` once, logs the Transaction and, unless `step` is null,
   * records its delta and moves the undo stacks (default: an edit). Call inside transactionSync.
   */
  private commit(
    actor: string,
    summary: string,
    intent: string | undefined,
    change: Change,
    step: Step | null = { label: summary, stack: "undo" },
    txId = newId(),
  ) {
    const { created = [], updated = [], deletedIds = [] } = change;
    const rev = this.sql
      .exec<{ rev: number }>("UPDATE doc SET rev = rev + 1 RETURNING rev")
      .one().rev;
    if (step) {
      // Before the nodes are written, so `before` is the committed copy. A Node both updated and
      // deleted (an overlay that edits a child and deletes its Group) is one row, deleted.
      const gone = new Set(deletedIds);
      const after = new Map([...created, ...updated].map((n) => [n.id, n]));
      for (const id of new Set([...after.keys(), ...deletedIds])) {
        this.sql.exec(
          "INSERT INTO tx_delta VALUES (?, ?, (SELECT json FROM nodes WHERE id = ?), ?)",
          rev,
          id,
          id,
          gone.has(id) ? null : JSON.stringify(after.get(id)),
        );
      }
    }
    for (const node of [...created, ...updated]) {
      this.sql.exec(
        "INSERT OR REPLACE INTO nodes (id, json) VALUES (?, ?)",
        node.id,
        JSON.stringify(node),
      );
    }
    for (const id of deletedIds) this.sql.exec("DELETE FROM nodes WHERE id = ?", id);
    const ids = (nodes: Node[]) => JSON.stringify(nodes.map((n) => n.id));
    // Columns named: a Document made while the Delta Log kept 30 days has an unused `at` column and index.
    this.sql.exec(
      `INSERT INTO tx_log (rev, tx_id, actor, summary, created_ids, updated_ids, deleted_ids, intent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rev,
      txId,
      actor,
      summary,
      ids(created),
      ids(updated),
      JSON.stringify(deletedIds),
      intent ?? null,
    );
    if (step) this.push(rev, step);
    return { txId, rev };
  }

  /** Moves the stacks for the Transaction just committed at `rev`, and drops unreachable deltas. */
  private push(rev: number, { label, stack, popped }: Step) {
    if (popped === undefined) this.sql.exec("DELETE FROM history WHERE stack = 'redo'");
    else this.sql.exec("DELETE FROM history WHERE rev = ?", popped);
    this.sql.exec("INSERT INTO history VALUES (?, ?, ?)", rev, stack, label);
    this.sql.exec(
      `DELETE FROM history WHERE stack = 'undo' AND rev NOT IN
         (SELECT rev FROM history WHERE stack = 'undo' ORDER BY rev DESC LIMIT ?)`,
      UNDO_DEPTH,
    );
    this.sql.exec("DELETE FROM tx_delta WHERE rev NOT IN (SELECT rev FROM history)");
  }
}

function summary(verb: string, { created = [], updated = [], deletedIds = [] }: Change) {
  const count = created.length + updated.length + deletedIds.length;
  return `${verb} ${count} ${count === 1 ? "Node" : "Nodes"}`;
}

function guard<T>(fn: () => T): Result<T> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ZibelError) return { error: e.data };
    throw e;
  }
}
