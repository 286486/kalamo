import {
  checkImage,
  dataUrlBytes,
  type ImageFile,
  isWebp,
  KalamoError,
  MAX_IMAGE_BYTES,
} from "@kalamo/core";
import wasm from "./webp/webp.wasm";

/** The most pixels a WebP may have, 4096 × 2048 (ADR-0100): what fits the decoder's memory cap. */
export const MAX_WEBP_PIXELS = 8 * 1024 * 1024;

const invalid = (message: string, path: string, hint: string) =>
  new KalamoError({ code: "INVALID_IMAGE", message, hint, path });
const damaged = (path: string) =>
  invalid(
    "The WebP is damaged: libwebp cannot decode it.",
    path,
    "Re-save the image and place it again.",
  );

/**
 * A file as an Image stores it (ADR-0100): a WebP is decoded and stored as a lossless PNG of the
 * same pixels; anything else is checked as it is. Worker-only, before the Document Durable Object.
 */
export async function normaliseImage(
  bytes: Uint8Array<ArrayBuffer>,
  path: string,
): Promise<ImageFile> {
  if (!isWebp(bytes) || bytes.length > MAX_IMAGE_BYTES) return checkImage(bytes, path);
  const header = webpHeader(bytes);
  if (!header) throw damaged(path);
  const { width, height } = header;
  if (header.animated) {
    throw invalid(
      "The WebP is animated; Kalamo places a still image.",
      path,
      "Export one frame as PNG or GIF and place that.",
    );
  }
  if (width * height > MAX_WEBP_PIXELS) {
    throw new KalamoError({
      code: "LIMIT_EXCEEDED",
      message: `The WebP is ${width} × ${height} pixels; the limit is ${MAX_WEBP_PIXELS} pixels (4096 × 2048).`,
      hint: "Scale the image down before placing it.",
      path,
    });
  }
  const png = await oneAtATime(() =>
    encodePng(decodeWebp(bytes, width, height, path), width, path),
  );
  return checkImage(png, path);
}

/**
 * `src` converted when it is a data URL of a WebP, or the error that refuses it; undefined for
 * anything else, which the synchronous readers check as they always have (ADR-0100).
 */
export async function convertWebp(
  src: unknown,
  path: string,
): Promise<ImageFile | KalamoError | undefined> {
  if (typeof src !== "string" || !src.startsWith("data:")) return undefined;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = dataUrlBytes(src, path);
  } catch {
    return undefined; // readImage refuses it with the same error
  }
  if (!isWebp(bytes)) return undefined;
  return normaliseImage(bytes, path).catch((e: unknown) => {
    if (e instanceof KalamoError) return e;
    throw e;
  });
}

/** The pixel size and animation flag from a WebP's first chunk, or undefined when it is none. */
export function webpHeader(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = String.fromCharCode(...b.subarray(12, 16));
  const u24 = (i: number) => view.getUint16(i, true) + ((b[i + 2] ?? 0) << 16);
  if (tag === "VP8 " && b.length >= 30) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
      animated: false,
    };
  }
  if (tag === "VP8L" && b.length >= 25) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  if (tag === "VP8X" && b.length >= 30) {
    return { width: u24(24) + 1, height: u24(27) + 1, animated: ((b[20] ?? 0) & 0x02) !== 0 };
  }
  return undefined;
}

// ponytail: one conversion at a time per isolate, so two never hold the decoder's 80 MiB at once
// beside pathkit's 32 MiB (ADR-0100); a WebP waits for the one before it.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const turn = queue.then(run, run);
  queue = turn.catch(() => {});
  return turn;
}

interface Decoder {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  WebPDecodeRGBAInto(
    data: number,
    size: number,
    out: number,
    outSize: number,
    stride: number,
  ): number;
  WebPGetDecoderVersion(): number;
}

/**
 * A fresh decoder (ADR-0100), dropped after one file: wasm memory never shrinks, and a damaged
 * file leaves nothing behind for the next. Instantiating the compiled module is cheap.
 */
export function decoder(): Decoder {
  const imports = { env: { emscripten_notify_memory_growth() {} } };
  const d = new WebAssembly.Instance(wasm, imports).exports as unknown as Decoder;
  d._initialize();
  return d;
}

/** The WebP's RGBA, decoded by libwebp, as a view of the decoder's memory. */
function decodeWebp(bytes: Uint8Array, width: number, height: number, path: string) {
  const d = decoder();
  const size = width * height * 4;
  const input = d.malloc(bytes.length);
  const out = input && d.malloc(size);
  if (!out) throw damaged(path);
  new Uint8Array(d.memory.buffer, input, bytes.length).set(bytes);
  if (!d.WebPDecodeRGBAInto(input, bytes.length, out, size, width * 4)) throw damaged(path);
  return new Uint8Array(d.memory.buffer, out, size);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * RGBA8 pixels `width` wide as a PNG (ADR-0100): 8-bit RGB when every pixel is opaque, else RGBA,
 * not interlaced, every row Paeth-filtered, one IDAT of `CompressionStream("deflate")`'s zlib
 * stream. Over 5 MB it fails `LIMIT_EXCEEDED`; past that only the length is kept.
 */
export async function encodePng(rgba: Uint8Array, width: number, path: string) {
  const height = rgba.length / 4 / width;
  let opaque = true;
  for (let i = 3; i < rgba.length && opaque; i += 4) opaque = rgba[i] === 255;
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const rowAt = (y: number) => {
    if (!opaque) return rgba.subarray(y * stride, (y + 1) * stride);
    const row = new Uint8Array(stride);
    for (let i = y * width * 4, o = 0; o < stride; i += 4, o += 3) {
      row[o] = rgba[i] ?? 0;
      row[o + 1] = rgba[i + 1] ?? 0;
      row[o + 2] = rgba[i + 2] ?? 0;
    }
    return row;
  };
  const zlib = new CompressionStream("deflate");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reading = (async () => {
    const reader = zlib.readable.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      length += r.value.length;
      if (length <= MAX_IMAGE_BYTES) chunks.push(r.value);
    }
  })();
  const writer = zlib.writable.getWriter();
  let prev: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = rowAt(y);
    const line = new Uint8Array(stride + 1);
    line[0] = 4; // Paeth
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (row[i - bpp] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      line[i + 1] = (row[i] ?? 0) - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
    await writer.write(line);
    prev = row;
  }
  await writer.close();
  await reading;
  if (length > MAX_IMAGE_BYTES) {
    throw new KalamoError({
      code: "LIMIT_EXCEEDED",
      message: `The WebP was converted to a PNG of ${length} bytes; the limit is ${MAX_IMAGE_BYTES} (5 MB).`,
      hint: "Scale the image down, or place it as a JPEG.",
      path,
    });
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", await new Blob(chunks).bytes()),
    ...chunk("IEND", new Uint8Array()),
  ];
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

/** A PNG chunk: length, type, data, CRC of type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const typed = new Uint8Array(4 + data.length);
  typed.set(Array.from(type, (c) => c.charCodeAt(0)));
  typed.set(data, 4);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(typed));
  return [len, typed, crc];
}
