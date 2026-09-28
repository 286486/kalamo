import { DurableObject } from "cloudflare:workers";
import {
  type Artboard,
  type ArtboardInput,
  bounds,
  type ConciseView,
  commitTransaction,
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
  type Geometry,
  type ImageFile,
  type ImageInfo,
  type ImageSource,
  imageId,
  lockedIn,
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
  PATH_OP_TEXT,
  type PathEditInput,
  type PathOpInput,
  pathOp,
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
import { loadGeometry } from "@zibel/geometry";
import { type OpenedFile, resolveLinks, scopeRect, svgRect, toSvg } from "@zibel/io";
import { fit, renderSvg } from "@zibel/render";
import {
  ACCESS_CHANGED,
  type ChangeEntry,
  ClientMessage,
  type Command,
  type CreatedDocument,
  DOC_DELETED,
  type DocInfo,
  type DocumentMessage,
  type OpenedDocument,
  type PathEditReceipt,
  type RasterRequest,
  type RejectedMessage,
  type RenderRequest,
  ROLES,
  type Role,
  type TxMessage,
  type Viewport,
  type WriteOptions,
} from "@zibel/sync";
import { ACTOR_HEADER, ROLE_HEADER, USER_HEADER } from "./auth.ts";

type EditCommand = Exclude<Command, { type: "undo" | "redo" }>;
type EditEntry<C> = {
  nodeIds: (command: C) => string[];
  run: (
    command: C,
    actor: string,
    commandId: string,
  ) => Result<WriteReceipt> | Promise<Result<WriteReceipt>>;
};

/**
 * What a browser socket keeps across hibernation: the Actor and User the Worker authenticated it
 * as, and their Role on this Document (ADR-0047).
 */
interface Attachment {
  actor: string;
  userId: string;
  role: Role;
}

/** RPC results carry errors as data: Workers RPC keeps only the message of a thrown error. */
export type Result<T> = T | { error: ErrorData };

/** A Transaction rolls back after this long without a call carrying its `txId` (F-HIST-02). */
const TX_IDLE_MS = 5 * 60_000;

/** Transactions the undo stack keeps (F-HIST-01). */
const UNDO_DEPTH = 200;

/** The image files one Document may store: F-MCP-06c's 20 MB Document size (ADR-0046). */
const MAX_DOCUMENT_IMAGE_BYTES = 20 * 1024 * 1024;

/** An object with no row this old is a failed write's upload, not one whose write is in flight. */
const ORPHAN_GRACE_MS = 60 * 60_000;

/** How long after a change that may free image files the alarm sweeps, so a burst is swept once. */
const SWEEP_DELAY_MS = 60_000;

/** The storage.kv key of when the alarm next sweeps image files. */
const SWEEP_AT = "sweepAt";

/** A file's R2 key: one object per file per Document (ADR-0046). */
export const imageKey = (docId: string, src: string) => `docs/${docId}/images/${src}`;

/** Image files by id, as a write carries them before they are stored. */
type Files = Map<string, ImageFile>;
/** An image file's row. */
type StoredImage = ImageInfo & { size: number };

/** Thrown where a rehearsed write would commit, so its SQLite transaction rolls back. */
const REHEARSED = Symbol("rehearsed");

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

/** One edit on a loaded Document, as `write` runs it. */
type Edit = (doc: Document) => Change & {
  keyMap?: Record<string, string>;
  warnings?: WriteReceipt["warnings"];
  failed: Failed[];
  /** Replaces the summary made from `verb`. */
  summary?: string;
  skipped?: string[];
};

/**
 * The authoritative store for one Document (ADR-0003). Nodes and the Transaction log are SQLite rows.
 * ponytail: every call reloads the Document from SQLite; cache it in memory when Documents get large.
 */
export class DocumentObject extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private pathKit?: Geometry;

  /** PathKit, instantiated on the first op that needs it (ADR-0034); no other event runs meanwhile. */
  private async geometry(): Promise<Geometry> {
    this.pathKit ??= await this.ctx.blockConcurrencyWhile(loadGeometry);
    return this.pathKit;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.schema();
    const legacy = this.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'image_chunks'");
    if (legacy.toArray().length > 0) void ctx.blockConcurrencyWhile(() => this.migrate());
  }

  /** Creates the tables, in a new Document and again after destroy() deleted them. */
  private schema() {
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
      -- Image files by SHA-256, their bytes in R2 (ADR-0046). A row never exists without its object.
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
    `);
  }

  /** Moves the files a Document stored in SQLite chunks (ADR-0023) to R2, before any request. */
  private async migrate() {
    const sized = this.sql.exec("SELECT 1 FROM pragma_table_info('images') WHERE name = 'size'");
    if (sized.toArray().length === 0) {
      this.sql.exec("ALTER TABLE images ADD COLUMN size INTEGER NOT NULL DEFAULT 0");
    }
    const docId = this.sql.exec<{ id: string }>("SELECT id FROM doc").toArray()[0]?.id;
    const rows = this.sql.exec<{ id: string; mime: ImageInfo["mime"] }>(
      "SELECT id, mime FROM images",
    );
    for (const { id, mime } of rows.toArray()) {
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
      if (docId) await this.upload(docId, new Map([[id, { mime, width: 0, height: 0, bytes }]]));
      this.sql.exec("UPDATE images SET size = ? WHERE id = ?", bytes.length, id);
    }
    this.sql.exec("DROP TABLE image_chunks");
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

  /**
   * A new Document from a parsed file, keeping its ids (ADR-0016) and its image files: rehearsed,
   * so a file over the image quota uploads nothing, then its files uploaded and the Document stored.
   */
  async open(input: {
    docId: string;
    name: string;
    artboards: Artboard[];
    nodes: Node[];
    images: Map<string, ImageFile>;
    actor: string;
    intent?: string;
  }): Promise<Result<Omit<OpenedDocument, "warnings">>> {
    const run = (rehearse: boolean) =>
      guard(() => {
        const doc: Document = {
          id: input.docId,
          name: input.name,
          version: 1,
          rev: 0,
          artboards: input.artboards,
          nodes: new Map(input.nodes.map((n) => [n.id, n])),
          images: input.images,
        };
        const summary = `Open Document "${doc.name}"`;
        const files = sizes(input.images);
        const rev = this.init(doc, input.actor, summary, input.intent, { files, rehearse });
        const nodes = outline(doc, { depth: 1 });
        return { docId: doc.id, name: doc.name, artboards: doc.artboards, rev, nodes };
      });
    const refused = rehearsal(() => run(true));
    if (refused) return refused;
    await this.upload(input.docId, input.images);
    return run(false);
  }

  /** Stores a new Document, with rows for `files`, and commits its Nodes as rev 1. */
  private init(
    doc: Document,
    actor: string,
    summary: string,
    intent: string | undefined,
    { files, rehearse }: { files?: Map<string, StoredImage>; rehearse?: boolean } = {},
  ) {
    return this.ctx.storage.transactionSync(() => {
      if (files) this.addFiles(files);
      this.sql.exec(
        "INSERT INTO doc (id, name, rev, artboards) VALUES (?, ?, 0, ?)",
        doc.id,
        doc.name,
        JSON.stringify(doc.artboards),
      );
      // Not undoable: undo stops at the Document's creation (ADR-0011).
      const committed = this.commit(
        actor,
        summary,
        intent,
        { created: [...doc.nodes.values()] },
        null,
      );
      if (rehearse) throw REHEARSED;
      return committed;
    }).rev;
  }

  /**
   * A browser subscribes by upgrading to a WebSocket (ADR-0009), as the Actor the Worker sets
   * (ADR-0047). Nothing awaits between load and accept, so no commit can slip in before the
   * Document message.
   */
  override fetch(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const actor = request.headers.get(ACTOR_HEADER);
    const userId = request.headers.get(USER_HEADER);
    const role = request.headers.get(ROLE_HEADER) as Role | null;
    if (!actor || !userId || !role || !ROLES.includes(role)) {
      return new Response("Expected the Worker's Actor, User and Role headers.", { status: 400 });
    }
    const doc = guard(() => this.load());
    if ("error" in doc) return Response.json(doc.error, { status: 404 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    // Kept on the socket, so it outlives hibernation.
    server.serializeAttachment({ actor, userId, role } satisfies Attachment);
    const msg: DocumentMessage = {
      type: "document",
      rev: doc.rev,
      name: doc.name,
      artboards: doc.artboards,
      nodes: [...doc.nodes.values()],
      role,
    };
    server.send(JSON.stringify(msg));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Completes the close handshake a browser starts, so it leaves getWebSockets. */
  override webSocketClose(ws: WebSocket) {
    ws.close();
  }

  /**
   * One browser gesture: commits it as one Transaction of the socket's User Actor, or answers that browser
   * alone with `rejected` (ADR-0010).
   */
  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    let json: unknown;
    try {
      json = JSON.parse(data as string);
    } catch {}
    const parsed = ClientMessage.safeParse(json);
    // A malformed message is a client bug; the browser reconnects and gets the Document again.
    if (!parsed.success) return ws.close(1007, "Expected a command message.");
    const { id, command } = parsed.data;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    // A socket accepted before its Actor or Role was kept: the browser reconnects and gets both.
    if (!attachment?.role) return ws.close(1012, "Reconnect.");
    const { actor, role } = attachment;
    if (role === "viewer") {
      const error: ErrorData = {
        code: "PERMISSION_DENIED",
        message: "You are a viewer of this Document: you can read it but not change it.",
        hint: "As a viewer, you can select, zoom and download. Ask the owner to make you an editor.",
      };
      ws.send(JSON.stringify({ type: "rejected", id, error } satisfies RejectedMessage));
      return;
    }
    const result =
      command.type === "undo" || command.type === "redo"
        ? this[command.type](actor, { commandId: id })
        : await this.edit(command, actor, id);
    if ("error" in result) {
      const msg: RejectedMessage = { type: "rejected", id, error: result.error };
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Each browser edit Command: the Nodes it names, and how it runs as a Transaction of the User
   * Actor. A new Command is one entry.
   */
  private readonly edits: {
    [T in EditCommand["type"]]: EditEntry<Extract<EditCommand, { type: T }>>;
  } = {
    create: {
      nodeIds: (c) => c.nodes.flatMap((n) => n.parentId ?? []),
      // No image data URLs to store first, unlike this.createNodes: a browser places images by HTTP.
      run: (c, actor, commandId) =>
        this.write(actor, { commandId }, "Create", (doc) => {
          const { nodes, keyMap, failed } = createNodes(doc, c.nodes);
          const warnings = [...fontWarnings(nodes), ...overflowWarnings(nodes)];
          return { created: nodes, keyMap, warnings, failed };
        }),
    },
    transform: {
      nodeIds: (c) => c.input.nodeIds,
      run: (c, actor, commandId) => this.transformNodes(c.input, actor, { commandId }),
    },
    update: {
      nodeIds: (c) => [c.nodeId],
      run: (c, actor, commandId) =>
        this.updateNodes([{ nodeId: c.nodeId, patch: c.patch }], actor, { commandId }),
    },
    delete: {
      nodeIds: (c) => c.nodeIds,
      run: (c, actor, commandId) => this.deleteNodes(c.nodeIds, actor, { commandId }),
    },
    embed: {
      nodeIds: (c) => c.nodeIds,
      run: (c, actor, commandId) =>
        this.write(actor, { commandId }, "Embed", (doc) => {
          const updates = c.nodeIds.map((nodeId) => ({ nodeId, patch: { file: null } }));
          return { updated: updateNodes(doc, updates).nodes, failed: [] };
        }),
    },
    mask_make: {
      nodeIds: (c) => [c.input.clipNodeId, ...c.input.contentIds],
      run: (c, actor, commandId) => this.makeMask(c.input, actor, { commandId }),
    },
    mask_release: {
      nodeIds: (c) => c.nodeIds,
      run: (c, actor, commandId) => this.releaseMask(c.nodeIds, actor, { commandId }),
    },
    path_edit: {
      nodeIds: (c) => [c.input.nodeId],
      run: (c, actor, commandId) => this.pathEdit(c.input, actor, { commandId }),
    },
    path_op: {
      nodeIds: (c) => c.input.nodeIds ?? [],
      run: (c, actor, commandId) => this.pathOp(c.input, actor, { commandId }),
    },
    path_join: {
      nodeIds: (c) => [c.edit.nodeId, ...(c.join.nodeIds ?? [])],
      run: (c, actor, commandId) =>
        this.write(actor, { commandId }, PATH_OP_TEXT.join.summary, (doc) => {
          const { warnings } = editPath(doc, c.edit);
          const joined = pathOp(doc, c.join);
          return {
            ...joined,
            warnings: [...warnings, ...joined.warnings],
            failed: [],
            summary: PATH_OP_TEXT.join.summary,
          };
        }),
    },
  };

  /**
   * A browser edit Command. The browser only names Nodes it was sent, so a missing one was
   * deleted: delete beats edit (ADR-0010).
   */
  private edit(
    command: EditCommand,
    actor: string,
    commandId: string,
  ): Result<WriteReceipt> | Promise<Result<WriteReceipt>> {
    // The entry matches command.type, which TypeScript cannot correlate across the union.
    const entry = this.edits[command.type] as EditEntry<EditCommand>;
    const nodeIds = entry.nodeIds(command);
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
    return entry.run(command, actor, commandId);
  }

  /** Closes the User's sockets after their Role changed, so they reconnect as the new Role. */
  disconnect(userId: string) {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.userId === userId) ws.close(ACCESS_CHANGED, "Your access changed.");
    }
  }

  /** Deletes the Document: its storage, its image files and every socket. */
  async destroy() {
    const docId = this.sql.exec<{ id: string }>("SELECT id FROM doc").toArray()[0]?.id;
    for (const ws of this.ctx.getWebSockets()) ws.close(DOC_DELETED, "The Document was deleted.");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.schema();
    if (!docId) return;
    const prefix = imageKey(docId, "");
    for (let cursor: string | undefined; ; ) {
      const page = await this.env.IMAGES.list({ prefix, cursor });
      if (page.objects.length > 0) await this.env.IMAGES.delete(page.objects.map((o) => o.key));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
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
   * The file of every Image given as a data URL is stored with the write, so core sees only ids
   * (ADR-0023). With `partial`, an item whose file is refused fails alone, under its own index.
   */
  async createNodes(
    inputs: NodeInput[],
    actor: string,
    opts: WriteOptions = {},
  ): Promise<Result<WriteReceipt>> {
    const files: Files = new Map();
    const ingested = await this.ingestAll(
      inputs,
      "nodes",
      opts,
      async (input, path) => (await this.ingest(input, path, files)) as NodeInput,
    );
    if ("error" in ingested) return ingested;
    const { ready, merge } = ingested;
    return this.writeFiles(files, actor, opts, "Create", (doc) => {
      const { nodes, keyMap, failed } = createNodes(doc, ready, opts);
      return {
        created: nodes,
        keyMap,
        warnings: [...fontWarnings(nodes), ...overflowWarnings(nodes)],
        failed: merge(failed),
      };
    });
  }

  /**
   * Runs `ingest` on each item; with `partial`, an item it refuses fails alone. `merge` adds those
   * to what core, numbering only the ready items, reports, with each item's own index put back.
   */
  private async ingestAll<T>(
    items: T[],
    key: "nodes" | "updates",
    opts: WriteOptions,
    ingest: (item: T, path: string) => Promise<T>,
  ): Promise<{ ready: T[]; merge: (failed: Failed[]) => Failed[] } | { error: ErrorData }> {
    const kept: number[] = [];
    const refused: Failed[] = [];
    const ready: T[] = [];
    for (const [i, item] of items.entries()) {
      try {
        ready.push(await ingest(item, `${key}[${i}]`));
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
    const own = (f: Failed): Failed => {
      const index = kept[f.index] ?? f.index;
      return {
        ...f,
        index,
        ...(f.path && {
          path: f.path.replace(new RegExp(`^${key}\\[\\d+\\]`), `${key}[${index}]`),
        }),
      };
    };
    const merge = (failed: Failed[]) =>
      [...refused, ...failed.map(own)].sort((a, b) => a.index - b.index);
    return { ready, merge };
  }

  /** `input` with each Image's data URL, inline children's too, put in `files` and replaced by its id. */
  private async ingest(input: unknown, path: string, files: Files): Promise<unknown> {
    if (typeof input !== "object" || input === null) return input;
    const item = input as { type?: unknown; src?: unknown; children?: unknown };
    if (item.type === "image" && typeof item.src === "string" && item.src.startsWith("data:")) {
      return { ...item, src: await hashed(readImage(item.src, `${path}.src`), files) };
    }
    if (Array.isArray(item.children)) {
      const children = [];
      for (const [k, c] of item.children.entries()) {
        children.push(await this.ingest(c, `${path}.children[${k}]`, files));
      }
      return { ...item, children };
    }
    return input;
  }

  /**
   * A write that stores `files` (ADR-0046). It is rehearsed first, so a write that would fail
   * uploads nothing (#66). Then the files go to R2, and their rows go in with the write that names
   * them. A write that fails after all, since the Document changed during the upload, leaves
   * objects without rows, which a later sweep deletes.
   */
  private async writeFiles(
    files: Files,
    actor: string,
    opts: Options,
    verb: string,
    edit: Edit,
  ): Promise<Result<WriteReceipt>> {
    if (files.size === 0) return this.write(actor, opts, verb, edit);
    const stored = sizes(files);
    const refused = rehearsal(() =>
      this.write(actor, opts, verb, edit, { files: stored, rehearse: true }),
    );
    if (refused) return refused;
    this.inFlight.add(files);
    let committed = false;
    try {
      await this.sweeping;
      await this.upload(this.load().id, files);
      const receipt = this.write(actor, opts, verb, edit, { files: stored });
      committed = !("error" in receipt);
      return receipt;
    } finally {
      this.inFlight.delete(files);
      if (!committed) this.markSweep(Date.now() + ORPHAN_GRACE_MS);
    }
  }

  /** The files of writes between upload and commit, which the sweep keeps. */
  private inFlight = new Set<Files>();
  /** The sweep running now; an upload waits for its deletes, so it never lands before one. */
  private sweeping: Promise<void> = Promise.resolve();

  private async upload(docId: string, files: Files) {
    await Promise.all(
      [...files].map(([id, { mime, bytes }]) =>
        this.env.IMAGES.put(imageKey(docId, id), bytes, { httpMetadata: { contentType: mime } }),
      ),
    );
  }

  /**
   * Rows for the files the Document does not hold yet, within F-MCP-06c's 20 MB, which counts
   * every stored file, live or held by undo history. Call inside transactionSync.
   */
  private addFiles(files: Map<string, StoredImage>) {
    let adding = 0;
    for (const [id, { mime, width, height, size }] of files) {
      const inserted = this.sql.exec(
        "INSERT OR IGNORE INTO images (id, mime, width, height, size) VALUES (?, ?, ?, ?, ?)",
        id,
        mime,
        width,
        height,
        size,
      ).rowsWritten;
      if (inserted) adding += size;
    }
    const total = this.storedImageBytes();
    if (adding === 0 || total <= MAX_DOCUMENT_IMAGE_BYTES) return;
    throw new ZibelError({
      code: "LIMIT_EXCEEDED",
      message: `The Document stores ${total - adding} bytes of image files; ${adding} more would pass its limit of ${MAX_DOCUMENT_IMAGE_BYTES} (${MAX_DOCUMENT_IMAGE_BYTES / 1024 / 1024} MB).`,
      hint: `Delete Images the Document no longer needs. A deleted Image's file keeps counting while undo history holds it: until ${UNDO_DEPTH} more Transactions push it out, or an edit after an undo clears the redo stack.`,
    });
  }

  /** The bytes of the image files the Document stores, live or held by undo history (ADR-0046). */
  storedImageBytes(): number {
    return this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM images").one().n;
  }

  /**
   * The image files `doc`'s Images name, fetched from R2 in parallel, for the SVG and .zibel.json
   * writers, which read them synchronously.
   * ponytail: fetches every Image's file, in scope or not; collect from the scope if that bites.
   */
  private async images(doc: Document): Promise<ImageSource> {
    const ids = new Set(
      [...doc.nodes.values()].flatMap((n) => (n.type === "image" && n.src ? [n.src] : [])),
    );
    const urls = new Map(
      await Promise.all(
        [...ids].map(async (id) => {
          const object = await this.env.IMAGES.get(imageKey(doc.id, id));
          const info = doc.images.get(id);
          const bytes = object && new Uint8Array(await object.arrayBuffer());
          return [id, bytes && info ? dataUrl({ ...info, bytes }) : undefined] as const;
        }),
      ),
    );
    return (id) => urls.get(id);
  }

  /** Relink (ADR-0042): a patch's data URL `src` is stored first, as for createNodes. */
  async updateNodes(
    updates: UpdateInput[],
    actor: string,
    opts: Options = {},
  ): Promise<Result<WriteReceipt>> {
    const files: Files = new Map();
    const ingested = await this.ingestAll(updates, "updates", opts, async (u, path) => {
      const src = (u.patch as { src?: unknown }).src;
      if (typeof src !== "string" || !src.startsWith("data:")) return u;
      const file = readImage(src, `${path}.patch.src`);
      return { ...u, patch: { ...u.patch, src: await hashed(file, files) } };
    });
    if ("error" in ingested) return ingested;
    const { ready, merge } = ingested;
    return this.writeFiles(files, actor, opts, "Update", (doc) => {
      const { nodes, failed } = updateNodes(doc, ready, opts);
      return {
        updated: nodes,
        warnings: [...fontWarnings(nodes), ...overflowWarnings(nodes)],
        failed: merge(failed),
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

  async pathOp(
    input: PathOpInput,
    actor: string,
    opts: Options = {},
  ): Promise<Result<WriteReceipt>> {
    const geometry = ["outline_stroke", "offset", "divide_below"].includes(input.op)
      ? await this.geometry()
      : undefined;
    const { summary } = PATH_OP_TEXT[input.op];
    return this.write(actor, opts, summary, (doc) => ({
      ...pathOp(doc, input, geometry),
      failed: [],
      summary,
    }));
  }

  /**
   * Runs one edit on a freshly loaded Document and commits it as one Transaction, or with `txId`
   * stages it in that Transaction's overlay (ADR-0008). Core throws before changing anything it
   * rejects, so a failure never reaches SQLite. `files`, uploaded already, are the edit's to name
   * and get their rows in the same SQLite transaction; `rehearse` rolls it all back at the end.
   */
  private write(
    actor: string,
    opts: Options,
    verb: string,
    edit: Edit,
    {
      step,
      files = new Map(),
      rehearse,
    }: { step?: Step; files?: Map<string, StoredImage>; rehearse?: boolean } = {},
  ): Result<WriteReceipt> {
    return guard(() => {
      const committed = this.load();
      const doc = this.view(committed, actor, opts.txId);
      this.checkRev(committed, opts.ifRev);
      for (const [id, { size: _, ...info }] of files) doc.images.set(id, info);
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
      // With `partial`, a file only failed items named gets no row; its object is swept.
      const srcs = new Set(
        [...created, ...updated].flatMap((n) => (n.type === "image" && n.src ? [n.src] : [])),
      );
      const named = new Map([...files].filter(([id]) => srcs.has(id)));
      if (named.size < files.size && !rehearse) this.markSweep(Date.now() + ORPHAN_GRACE_MS);
      const label = rest.summary ?? summary(verb, change);
      const { txId, rev, pruned } = this.ctx.storage.transactionSync(() => {
        this.addFiles(named);
        const written = opts.txId
          ? { ...this.stage(opts.txId, committed.rev, change), pruned: false }
          : this.commit(actor, label, opts.intent, change, step);
        if (rehearse) throw REHEARSED;
        return written;
      });
      if (pruned) this.markSweep();
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
  async svg(actor: string, req: RenderRequest): Promise<Result<{ svg: string; docRect: Rect }>> {
    const doc = guard(() => this.view(this.load(), actor, req.txId));
    if ("error" in doc) return doc;
    const images = await this.images(doc);
    return guard(() => {
      const rect = svgRect(doc, req.scope);
      return {
        svg: toSvg(doc, rect, { scope: req.scope, background: req.background, images }),
        docRect: rect,
      };
    });
  }

  /** The whole Document as `.zibel.json` text, as `export` returns it (ADR-0016). */
  async file(actor: string, txId?: string): Promise<Result<{ text: string }>> {
    const doc = guard(() => this.view(this.load(), actor, txId));
    if ("error" in doc) return doc;
    const images = await this.images(doc);
    return guard(() => ({ text: serializeDocument(doc, images) }));
  }

  /**
   * The SVG to rasterise at `req.scale`: fitted to whole pixels and `maxSize`, with overlays.
   * The Worker rasterises it, so PNG encoding never blocks this Document's writes.
   */
  async raster(
    actor: string,
    req: RasterRequest,
  ): Promise<Result<{ svg: string; viewport: Viewport }>> {
    const doc = guard(() => this.view(this.load(), actor, req.txId));
    if ("error" in doc) return doc;
    const images = await this.images(doc);
    return guard(() => {
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
        images,
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
    const files: Files = new Map();
    const src = await hashed(image, files);
    return this.writeFiles(files, actor, opts, "Place", (doc) => ({
      created: placeImage(doc, { src, name }, opts).created,
      failed: [],
    }));
  }

  /**
   * Object > Relink… (ADR-0042): the file the Worker checked becomes the Image's pixels, its frame
   * kept; a linked Image is renamed `name`. A hidden Image relinks, as in Illustrator's Links panel.
   */
  async relinkImage(
    file: ImageFile & { name?: string },
    actor: string,
    opts: Options & { nodeId: string },
  ): Promise<Result<WriteReceipt>> {
    const { name, ...image } = file;
    const files: Files = new Map();
    const src = await hashed(image, files);
    return this.writeFiles(files, actor, opts, "Relink", (doc) => {
      const node = doc.nodes.get(opts.nodeId);
      const refuse = (message: string, hint: string) =>
        new ZibelError({ code: "INVALID_IMAGE", message, hint, path: "nodeId" });
      if (node && node.type !== "image") {
        throw refuse(`${opts.nodeId} is a ${node.type}, not an Image.`, "Select one Image.");
      }
      if (lockedIn(doc, node))
        throw refuse("The Image or its Layer is locked.", "Unlock it first.");
      const linked = node?.type === "image" && node.file !== undefined;
      const patch = { src, ...(linked && name && { file: name }) };
      return { updated: updateNodes(doc, [{ nodeId: opts.nodeId, patch }]).nodes, failed: [] };
    });
  }

  /**
   * Place (ADR-0017): an SVG's Nodes as one new Group under `opts.parentId`, or a Zibel copy's Nodes
   * directly there (ADR-0030), all with new ids, in one Transaction. `nodes` is the outline of what
   * was put in the parent, to depth 2.
   */
  async place(
    file: OpenedFile,
    actor: string,
    opts: Options & {
      parentId: string;
      position?: { x: number; y: number };
      fit?: boolean;
      inPlace?: boolean;
    },
  ): Promise<Result<WriteReceipt & { nodes: OutlineNode[] }>> {
    let nodes: OutlineNode[] = [];
    const receipt = await this.writeFiles(file.images, actor, opts, "Place", (doc) => {
      // A Zibel copy's linked Images keep their pixels only in the Document that holds them.
      const resolved = resolveLinks(file, (id) => doc.images.get(id));
      const { placedIds, created } = placeNodes(doc, resolved, opts);
      const placed = new Set(placedIds);
      nodes = outline(doc, { rootId: opts.parentId, depth: 2 }).filter((n) => placed.has(n.id));
      return { created, warnings: resolved.warnings, failed: [] };
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
      { step: { label: top.label, stack, popped: top.rev } },
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

  /**
   * Rolls back every Transaction past its deadline and sweeps the image files when a sweep is
   * pending, even one not due yet, then waits for the next deadline or sweep.
   */
  override async alarm(): Promise<void> {
    const due = this.sql
      .exec<{ id: string }>("SELECT id FROM tx WHERE ended IS NULL AND deadline <= ?", Date.now())
      .toArray();
    for (const { id } of due) this.end(id, "expired");
    if (this.ctx.storage.kv.delete(SWEEP_AT)) {
      const sweep = this.sweep();
      this.sweeping = sweep.catch(() => {});
      try {
        await sweep;
      } catch (e) {
        // Swept again later, and the alarm still serves the Transaction deadlines.
        console.error("Image sweep failed", e);
        this.markSweep();
      }
    }
    await this.schedule();
  }

  /** Has the alarm sweep the image files at `at`, or earlier when a sweep is already due by then. */
  private markSweep(at = Date.now() + SWEEP_DELAY_MS) {
    const due = this.ctx.storage.kv.get<number>(SWEEP_AT);
    if (due !== undefined && due <= at) return;
    this.ctx.storage.kv.put(SWEEP_AT, at);
    void this.schedule();
  }

  /**
   * Deletes every image file that no Node, open Transaction, Delta Log row or write in flight
   * names: its row, then its object. Then deletes the objects with no row that are older than the
   * grace period, which failed writes left. A failed delete leaves an object with no row, which
   * the next sweep deletes, so sweeping twice gives the same result.
   */
  private async sweep() {
    const docId = this.sql.exec<{ id: string }>("SELECT id FROM doc").toArray()[0]?.id;
    if (!docId) return;
    const kept = new Set([...this.inFlight].flatMap((files) => [...files.keys()]));
    const garbage = this.ctx.storage.transactionSync(() => {
      const ids = this.sql
        .exec<{ id: string }>(
          `SELECT id FROM images WHERE id NOT IN (SELECT src FROM (
             SELECT json_extract(json, '$.src') AS src FROM nodes
             UNION SELECT json_extract(base, '$.src') FROM tx_nodes
             UNION SELECT json_extract(working, '$.src') FROM tx_nodes
             UNION SELECT json_extract(before, '$.src') FROM tx_delta
             UNION SELECT json_extract(after, '$.src') FROM tx_delta
           ) WHERE src IS NOT NULL)`,
        )
        .toArray()
        .map((r) => r.id)
        .filter((id) => !kept.has(id));
      for (const id of ids) this.sql.exec("DELETE FROM images WHERE id = ?", id);
      return ids;
    });
    const held = new Set(
      this.sql
        .exec<{ id: string }>("SELECT id FROM images")
        .toArray()
        .map((r) => r.id),
    );
    const prefix = imageKey(docId, "");
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    const keys = new Set(garbage.map((id) => imageKey(docId, id)));
    for (let cursor: string | undefined; ; ) {
      const page = await this.env.IMAGES.list({ prefix, cursor });
      for (const { key, uploaded } of page.objects) {
        const id = key.slice(prefix.length);
        if (held.has(id) || kept.has(id)) continue;
        if (uploaded.getTime() < cutoff) keys.add(key);
        else this.markSweep(uploaded.getTime() + ORPHAN_GRACE_MS);
      }
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    const all = [...keys];
    // R2 deletes at most 1000 keys per call.
    for (let i = 0; i < all.length; i += 1000) await this.env.IMAGES.delete(all.slice(i, i + 1000));
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
    const dropped = this.sql.exec("DELETE FROM tx_nodes WHERE tx_id = ?", txId).rowsWritten;
    // A dropped overlay may have named the only copy of a file; a committed one is in the Nodes.
    if (dropped > 0 && how !== "committed") this.markSweep();
  }

  /** Points the alarm at the earliest open deadline or due sweep, or clears it. */
  private async schedule() {
    const { deadline } = this.sql
      .exec<{ deadline: number | null }>(
        "SELECT MIN(deadline) AS deadline FROM tx WHERE ended IS NULL",
      )
      .one();
    const next = Math.min(
      deadline ?? Infinity,
      this.ctx.storage.kv.get<number>(SWEEP_AT) ?? Infinity,
    );
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
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
    const pruned = step ? this.push(rev, step) : false;
    return { txId, rev, pruned };
  }

  /**
   * Moves the stacks for the Transaction just committed at `rev`, and drops unreachable deltas:
   * true when it dropped any, which may free image files.
   */
  private push(rev: number, { label, stack, popped }: Step): boolean {
    if (popped === undefined) this.sql.exec("DELETE FROM history WHERE stack = 'redo'");
    else this.sql.exec("DELETE FROM history WHERE rev = ?", popped);
    this.sql.exec("INSERT INTO history VALUES (?, ?, ?)", rev, stack, label);
    this.sql.exec(
      `DELETE FROM history WHERE stack = 'undo' AND rev NOT IN
         (SELECT rev FROM history WHERE stack = 'undo' ORDER BY rev DESC LIMIT ?)`,
      UNDO_DEPTH,
    );
    return (
      this.sql.exec("DELETE FROM tx_delta WHERE rev NOT IN (SELECT rev FROM history)").rowsWritten >
      0
    );
  }
}

function summary(verb: string, { created = [], updated = [], deletedIds = [] }: Change) {
  const count = created.length + updated.length + deletedIds.length;
  return `${verb} ${count} ${count === 1 ? "Node" : "Nodes"}`;
}

/** `files` with each file's size in place of its bytes, as its row holds it. */
const sizes = (files: Files) =>
  new Map<string, StoredImage>(
    [...files].map(([id, { bytes, ...info }]) => [id, { ...info, size: bytes.length }]),
  );

/** Puts a checked file in `files` and returns its id. */
async function hashed(file: ImageFile, files: Files): Promise<string> {
  const id = await imageId(file.bytes);
  files.set(id, file);
  return id;
}

/** A rehearsed write's refusal, or undefined when it reached REHEARSED, where it would commit. */
function rehearsal(fn: () => Result<object>): { error: ErrorData } | undefined {
  try {
    const result = fn();
    return "error" in result ? result : undefined;
  } catch (e) {
    if (e === REHEARSED) return undefined;
    throw e;
  }
}

function guard<T>(fn: () => T): Result<T> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ZibelError) return { error: e.data };
    throw e;
  }
}
