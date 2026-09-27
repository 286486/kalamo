/// <reference path="./base64.d.ts" />
import { ZibelError } from "./errors.ts";
import type { Segment } from "./path.ts";
import type { Rect } from "./schema.ts";

/** F-MCP-06c's bitmap quota (ADR-0023). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** An image's id: the lowercase hex SHA-256 of its file. */
export const IMAGE_ID = /^[0-9a-f]{64}$/;

export interface ImageInfo {
  mime: "image/png" | "image/jpeg" | "image/gif";
  width: number;
  height: number;
}
export interface ImageFile extends ImageInfo {
  bytes: Uint8Array<ArrayBuffer>;
}
/** The most characters a linked Image's `file` holds. */
export const MAX_FILE_LENGTH = 2048;

/** The grey a missing link's crossed frame is stroked in (ADR-0042). */
export const MISSING_LINK_STROKE = "#999999";

/**
 * A missing link's outline, as Illustrator draws an unresolved placed file: its frame and both
 * diagonals, in the Image's own coordinates (ADR-0042).
 */
export function crossedFrame({ x, y, width, height }: Rect): Segment[] {
  const [l, t, r, b] = [x, y, x + width, y + height];
  return [
    { cmd: "M", args: [l, t] },
    { cmd: "L", args: [r, t] },
    { cmd: "L", args: [r, b] },
    { cmd: "L", args: [l, b] },
    { cmd: "Z", args: [] },
    { cmd: "M", args: [l, t] },
    { cmd: "L", args: [r, b] },
    { cmd: "M", args: [r, t] },
    { cmd: "L", args: [l, b] },
  ];
}

/** Why `file` cannot name a linked Image's file, or undefined when it can (ADR-0042). */
export function fileProblem(file: string): string | undefined {
  if (file.trim() === "") return "A linked Image's file is empty.";
  if (/^\s*data:/i.test(file))
    return "A linked Image's file is a data: URL; pass it as src instead.";
  if (file.length > MAX_FILE_LENGTH)
    return `A linked Image's file is ${file.length} characters; the limit is ${MAX_FILE_LENGTH}.`;
  return undefined;
}

/** An image's file as a data URL, by id; the bytes stay out of the Document (ADR-0023). */
export type ImageSource = (id: string) => string | undefined;

const HINT =
  "src is a data: URL of a PNG, JPEG or GIF, or the id of an image already in the Document; WebP is not drawn yet, convert it to PNG.";
const invalid = (message: string, path: string, hint = HINT) =>
  new ZibelError({ code: "INVALID_IMAGE", message, hint, path });

function decode(src: string, path: string): Uint8Array<ArrayBuffer> {
  const match = /^data:([^,]*),/.exec(src);
  if (!match) throw invalid("An image's src is not a data: URL.", path);
  const body = src.slice(match[0].length);
  try {
    if (match[1]?.endsWith(";base64")) return Uint8Array.fromBase64(body.replace(/\s/g, ""));
  } catch {
    throw invalid("An image's data: URL does not decode.", path);
  }
  // Percent-encoded: each %XX is one byte, not UTF-8.
  if (/%(?![0-9a-f]{2})|[^\0-\xff]/i.test(body)) {
    throw invalid("An image's data: URL does not decode.", path);
  }
  const latin1 = body.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return Uint8Array.from(latin1, (c) => c.charCodeAt(0));
}

/** Width and height from the header, or undefined when the bytes are not that format. */
function sniff(b: Uint8Array): ImageInfo | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  // The signature, then the IHDR chunk, which holds the size.
  if (at(0, 137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82) && b.length >= 24) {
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (at(0, 71, 73, 70, 56) && (at(4, 55, 97) || at(4, 57, 97)) && b.length >= 10) {
    return { mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (at(0, 0xff, 0xd8)) {
    // Walk the segments to the first start-of-frame, which carries the size.
    for (let i = 2; i + 9 <= b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: "image/jpeg", width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return undefined;
}

/** A PNG, JPEG or GIF from a data URL, typed by its bytes, never by the URL (ADR-0023). */
export const readImage = (src: string, path: string): ImageFile =>
  checkImage(decode(src, path), path);

/** A PNG, JPEG or GIF of at most 5 MB, typed by its bytes (ADR-0023). */
export function checkImage(bytes: Uint8Array<ArrayBuffer>, path: string): ImageFile {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ZibelError({
      code: "LIMIT_EXCEEDED",
      message: `The image is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES} (5 MB).`,
      hint: "Scale the image down or compress it before placing it.",
      path,
    });
  }
  const info = sniff(bytes);
  if (info && info.width > 0 && info.height > 0) return { ...info, bytes };
  const webp = String.fromCharCode(...bytes.slice(0, 4), ...bytes.slice(8, 12)) === "RIFFWEBP";
  throw webp
    ? invalid(
        "WebP is not drawn by resvg or Inkscape 1.2 yet.",
        path,
        "Convert the image to PNG and place that.",
      )
    : invalid("The image is not a PNG, JPEG or GIF, or its header is damaged.", path);
}

export async function imageId(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const dataUrl = (file: ImageFile) => `data:${file.mime};base64,${file.bytes.toBase64()}`;

/** The files as an `ImageSource`. */
export const imageSource =
  (files: Map<string, ImageFile>): ImageSource =>
  (id) => {
    const file = files.get(id);
    return file && dataUrl(file);
  };

/**
 * SVG's `preserveAspectRatio` in the one spelling the Document stores: `none` or
 * `<align> <meet|slice>`; `defer` is dropped. Undefined when it is not one.
 */
export function preserveAspectRatio(value: string): string | undefined {
  const m = /^(?:defer\s+)?(none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(meet|slice))?$/.exec(
    value.trim(),
  );
  if (!m) return undefined;
  return m[1] === "none" ? "none" : `${m[1]} ${m[2] ?? "meet"}`;
}
