import {
  dataUrl,
  dataUrlBytes,
  type ErrorData,
  type ImageFile,
  KalamoError,
  newId,
  resolveImages,
} from "@kalamo/core";
import { embeddedImages, parseFile, resolveLinks } from "@kalamo/io";
import { svgToPng } from "@kalamo/render";
import type { DocumentService, PathEditReceipt, RasterRequest } from "@kalamo/sync";
import type { Principal } from "./auth.ts";
import { mapImageSrc, type SrcConverter } from "./document-object.ts";
import { fetchImage } from "./fetch-image.ts";
import { normaliseImage, webpConverter } from "./normalise-image.ts";
import { checkDocuments, countCall, ownerStorage } from "./quotas.ts";
import { assertWrites, authorize, listDocuments, type Need } from "./roles.ts";

/**
 * A file for Open or Place, its images named by their hash (ADR-0023). A bitmap data URL, and each
 * WebP an SVG embeds, is converted here first, since `parseFile` reads synchronously (ADR-0100).
 */
async function parse(content: string, { name }: { name?: string } = {}) {
  const text = content.replace(/^\uFEFF/, "").trimStart();
  if (/^data:/i.test(text)) {
    const file = await normaliseImage(dataUrlBytes(text, "content"), "content");
    return resolveImages(parseFile(dataUrl(file), { name }));
  }
  const converted = new Map<string, ImageFile | KalamoError>();
  if (text.startsWith("<")) {
    const convert = webpConverter();
    for (const href of new Set(embeddedImages(text))) {
      const file = await convert(href, "src");
      if (file) converted.set(href, file);
    }
  }
  return resolveImages(parseFile(content, { name, converted }));
}

/**
 * DocumentService over one Document Durable Object per docId, acting as the Principal's Actor.
 * Every Document method authorizes the Principal first (ADR-0047).
 */
export function documentService(env: Env, principal: Principal): DocumentService {
  const { actor } = principal;
  const stub = (docId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));
  const doc = async (docId: string, need: Need) => {
    await authorize(env, principal, docId, need);
    return stub(docId);
  };
  type Stub = Awaited<ReturnType<typeof doc>>;
  /** `call`'s result on the authorized Document, its error thrown. */
  const on =
    (need: Need) =>
    async <R extends PromiseLike<object>>(docId: string, call: (d: Stub) => R) =>
      unwrap<Awaited<R>>(await call(await doc(docId, need)));
  const read = on("read");
  const write = on("write");
  /** The owner's storage for a write that may store files (ADR-0048). */
  const storage = (docId: string) => ownerStorage(env, docId, principal.userId);
  /**
   * `opts` with the owner's storage when Node inputs or patches may carry a data URL, whose file
   * the write stores. ponytail: a text `data:` also matches, costing one D1 read; walk the Images if it bites.
   */
  const withStorage = async <O>(docId: string, items: unknown, opts: O) => ({
    ...opts,
    storage: JSON.stringify(items).includes('"data:') ? await storage(docId) : undefined,
  });
  /** `render` or `export` counted against the caller's day (ADR-0048), then drawn. */
  const raster = (kind: "render" | "export") => async (docId: string, req: RasterRequest) => {
    await countCall(env, principal, kind);
    const { svg, viewport } = await read(docId, (d) => d.raster(actor, req, kind === "render"));
    const { png } = await svgToPng(svg, viewport.scale);
    return { png, viewport };
  };
  // ponytail: a failed insert leaves the Document unlisted; reconcile from the DOs if that shows up.
  // The Principal's User owns what it creates, whether a browser or an Agent made it.
  const index = (docId: string, name: string, storedBytes = 0) =>
    env.DB.prepare(
      "INSERT INTO documents (id, name, created_at, owner_id, stored_bytes) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(docId, name, new Date().toISOString(), principal.userId, storedBytes)
      .run();
  return {
    create: async (input) => {
      assertWrites(principal);
      await checkDocuments(env, principal);
      const docId = newId();
      const created = unwrap(await stub(docId).create({ ...input, docId, actor }));
      await index(docId, input.name);
      return created;
    },
    open: async ({ content, name, intent }) => {
      assertWrites(principal);
      await checkDocuments(env, principal);
      // Parsed here, before any Durable Object or D1 row exists, so a bad file creates nothing.
      // A new Document holds only the file's own images.
      const parsed = await parse(content, { name });
      const { warnings, ...file } = resolveLinks(parsed, (id) => parsed.images.get(id));
      const docId = newId();
      const input = { ...file, docId, actor, intent, storage: await storage(docId) };
      const opened = unwrap(await stub(docId).open(input));
      // It stores exactly the file's images, so its row starts with their bytes.
      const bytes = [...file.images.values()].reduce((n, f) => n + f.bytes.length, 0);
      await index(docId, file.name, bytes);
      return { ...opened, warnings };
    },
    place: async (docId, { svg, name, ...opts }) => {
      const target = await doc(docId, "write");
      // Refused here, not by parseFile, whose hint is for Open.
      if (!/^\uFEFF?\s*</.test(svg)) {
        throw new KalamoError({
          code: "INVALID_DOCUMENT",
          message: "Place takes SVG; this is not an SVG file.",
          hint: "Pass the text of an .svg file. kalamo_doc_open reads a Kalamo file as a new Document.",
          path: "svg",
        });
      }
      let file: ReturnType<typeof parseFile>;
      try {
        file = await parse(svg, { name });
      } catch (e) {
        // The file is Place's `svg`, not Open's `content`.
        if (e instanceof KalamoError && e.data.path === "content") {
          throw new KalamoError({ ...e.data, path: "svg" });
        }
        throw e;
      }
      return unwrap(await target.place(file, actor, { ...opts, storage: await storage(docId) }));
    },
    // Fetched here, in the Worker, so a slow host never holds the Document's input gate (ADR-0027).
    placeImage: async (docId, { src, ...opts }) => {
      const target = await doc(docId, "write");
      const file = await fetchImage(src);
      const storing = { ...opts, storage: await storage(docId) };
      return unwrap(await target.placeImage(file, actor, storing));
    },
    list: async () => ({ documents: await listDocuments(env, principal) }),
    delete: async (docId) => {
      const target = await doc(docId, "own");
      // The index first: once no row names it, nobody reaches the Document, even if destroy fails.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM members WHERE doc_id = ?").bind(docId),
        env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(docId),
      ]);
      await target.destroy();
      return { docId, deleted: true };
    },
    info: async (docId) => read(docId, (d) => d.info()),
    // A WebP is converted here, in the Worker, never in the Durable Object (ADR-0100).
    createNodes: async (docId, nodes, opts) => {
      const target = await doc(docId, "write");
      const refusedImages: Record<string, ErrorData> = {};
      const convert = srcConverter(refusedImages);
      const converted = await each(
        nodes,
        async (n, i) => (await mapImageSrc(n, `nodes[${i}]`, convert)) as typeof n,
      );
      const withFiles = await withStorage(docId, converted, { ...opts, refusedImages });
      return unwrap(await target.createNodes(converted, actor, withFiles));
    },
    updateNodes: async (docId, updates, opts) => {
      const target = await doc(docId, "write");
      const refusedImages: Record<string, ErrorData> = {};
      const convert = srcConverter(refusedImages);
      const converted = await each(updates, async (u, i) => {
        const patch = u.patch as { src?: unknown };
        const src = await convert(patch.src, `updates[${i}].patch.src`);
        return src === patch.src ? u : { ...u, patch: { ...u.patch, src } };
      });
      const withFiles = await withStorage(docId, converted, { ...opts, refusedImages });
      return unwrap(await target.updateNodes(converted, actor, withFiles));
    },
    deleteNodes: async (docId, nodeIds, opts) =>
      write(docId, (d) => d.deleteNodes(nodeIds, actor, opts)),
    transformNodes: async (docId, input, opts) =>
      write(docId, (d) => d.transformNodes(input, actor, opts)),
    reparentNodes: async (docId, moves, opts) =>
      write(docId, (d) => d.reparentNodes(moves, actor, opts)),
    reorderNodes: async (docId, nodeIds, op, opts) =>
      write(docId, (d) => d.reorderNodes(nodeIds, op, actor, opts)),
    duplicateNodes: async (docId, input, opts) =>
      write(docId, (d) => d.duplicateNodes(input, actor, opts)),
    makeMask: async (docId, input, opts) => write(docId, (d) => d.makeMask(input, actor, opts)),
    releaseMask: async (docId, nodeIds, opts) =>
      write(docId, (d) => d.releaseMask(nodeIds, actor, opts)),
    // Workers RPC types a tuple as number[].
    pathEdit: async (docId, input, opts) =>
      (await write(docId, (d) => d.pathEdit(input, actor, opts))) as PathEditReceipt,
    pathOp: async (docId, input, opts) => write(docId, (d) => d.pathOp(input, actor, opts)),
    get: async (docId, nodeIds, detail, txId) =>
      read(docId, (d) => d.get(nodeIds, detail, actor, txId)),
    outline: async (docId, opts, txId) => read(docId, (d) => d.outline(opts, actor, txId)),
    query: async (docId, q, txId) => read(docId, (d) => d.query(q, actor, txId)),
    validate: async (docId, opts, txId) => read(docId, (d) => d.validate(opts, actor, txId)),
    begin: async (docId, label) => write(docId, (d) => d.begin(actor, label)),
    commitTx: async (docId, txId, opts) => write(docId, (d) => d.commitTx(txId, actor, opts)),
    rollback: async (docId, txId) => write(docId, (d) => d.rollback(txId, actor)),
    changes: async (docId, sinceRev, limit) => read(docId, (d) => d.changes(sinceRev, limit)),
    render: raster("render"),
    png: raster("export"),
    svg: async (docId, req) => {
      await countCall(env, principal, "export");
      return read(docId, (d) => d.svg(actor, req));
    },
    file: async (docId, txId) => {
      await countCall(env, principal, "export");
      return read(docId, (d) => d.file(actor, txId));
    },
  };
}

/** For `mapImageSrc`: a WebP data URL `src` converted to a PNG's; a refusal goes in `refused`. */
function srcConverter(refused: Record<string, ErrorData>): SrcConverter {
  const convert = webpConverter();
  return async (src, path) => {
    const file = await convert(src, path);
    if (!file) return src;
    if (!(file instanceof KalamoError)) return dataUrl(file);
    refused[path] = file.data;
    return src;
  };
}

/** `items` converted one by one, in order. */
async function each<T>(items: T[], convert: (item: T, i: number) => Promise<T>) {
  const out: T[] = [];
  for (const [i, item] of items.entries()) out.push(await convert(item, i));
  return out;
}

export function unwrap<T extends object>(result: T): Exclude<T, { error: ErrorData }> {
  if ("error" in result) throw new KalamoError(result.error as ErrorData);
  return result as Exclude<T, { error: ErrorData }>;
}
