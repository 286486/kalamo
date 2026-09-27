import type { Document } from "@zibel/core";
import type { DecodedImage } from "@zibel/render/canvas";

/** A decoded file and its data URL, which the downloads embed. */
export interface CachedImage extends DecodedImage {
  dataUrl: string;
}

/** What the cache does outside itself; the browser's by default, a test's in workerd. */
interface ImageIO {
  fetch: (url: string) => Promise<Response>;
  decode: (blob: Blob) => Promise<DecodedImage>;
  read: (blob: Blob) => Promise<string>;
}

const browserIO: ImageIO = {
  fetch: (url) => fetch(url),
  // A GIF decodes to its first frame, as resvg and Inkscape draw it (ADR-0023).
  decode: async (blob) => {
    const image = await createImageBitmap(blob);
    return { image, width: image.width, height: image.height };
  },
  read: (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }),
};

const srcs = (doc: Document) =>
  new Set(
    [...doc.nodes.values()].flatMap((n) =>
      n.type === "image" && n.src !== undefined ? [n.src] : [],
    ),
  );

export type ImageCache = ReturnType<typeof imageCache>;

/**
 * The files one Document's Images name, fetched once each from the Worker (ADR-0023). `onLoad`
 * runs as each arrives, so the canvas redraws with it.
 */
export function imageCache(docId: string, onLoad: () => void, io: ImageIO = browserIO) {
  const loaded = new Map<string, CachedImage>();
  const loading = new Map<string, Promise<CachedImage>>();
  /** Files that failed, not fetched again on every redraw; a download still retries them. */
  const failed = new Set<string>();
  const load = (id: string): Promise<CachedImage> => {
    const known = loaded.get(id);
    if (known) return Promise.resolve(known);
    let promise = loading.get(id);
    if (!promise) {
      promise = (async () => {
        const res = await io.fetch(`/api/docs/${docId}/images/${id}`);
        if (!res.ok) throw new Error(`Image ${id}: ${res.status}`);
        const blob = await res.blob();
        const [decoded, dataUrl] = await Promise.all([io.decode(blob), io.read(blob)]);
        const entry = { ...decoded, dataUrl };
        loaded.set(id, entry);
        onLoad();
        return entry;
      })().finally(() => loading.delete(id));
      loading.set(id, promise);
    }
    return promise;
  };
  return {
    get: (id: string) => loaded.get(id),
    /** Starts fetching every file the Document's Images name that is not here yet. */
    want(doc: Document) {
      for (const id of srcs(doc)) {
        if (loaded.has(id) || failed.has(id)) continue;
        load(id).catch((e) => {
          failed.add(id);
          console.warn(e);
        });
      }
    },
    /** Every file the Document's Images name, for a download. */
    ready: (doc: Document) =>
      Promise.all(
        [...srcs(doc)].map((id) => {
          failed.delete(id);
          return load(id);
        }),
      ),
  };
}
