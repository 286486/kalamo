/// <reference path="./base64.d.ts" />
import { KalamoError } from "./errors.ts";
import type { Segment } from "./path.ts";
import type { Matrix, Rect } from "./schema.ts";

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
  "src is a data: URL of a PNG, JPEG, GIF or WebP (stored as PNG), or the id of an image already in the Document.";
const invalid = (message: string, path: string, hint = HINT) =>
  new KalamoError({ code: "INVALID_IMAGE", message, hint, path });

/** A data URL's bytes, base64 or percent-encoded. */
export function dataUrlBytes(src: string, path: string): Uint8Array<ArrayBuffer> {
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
  checkImage(dataUrlBytes(src, path), path);

/** A PNG, JPEG or GIF of at most 5 MB, typed by its bytes (ADR-0023). */
export function checkImage(bytes: Uint8Array<ArrayBuffer>, path: string): ImageFile {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new KalamoError({
      code: "LIMIT_EXCEEDED",
      message: `The image is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES} (5 MB).`,
      hint: "Scale the image down or compress it before placing it.",
      path,
    });
  }
  const info = sniff(bytes);
  if (info && info.width > 0 && info.height > 0) return { ...info, bytes };
  throw isWebp(bytes)
    ? invalid(
        "The image is a WebP, which no Kalamo file holds: Kalamo converts a WebP to PNG on the way in (ADR-0100).",
        path,
        "Place or open the WebP file itself, and Kalamo stores it as a PNG.",
      )
    : invalid("The image is not a PNG, JPEG, GIF or WebP, or its header is damaged.", path);
}

/**
 * An EXIF orientation (TIFF 6.0): what is done to the stored pixels to show them upright. 1 as
 * stored, 2 mirrored left to right, 3 turned 180°, 4 mirrored top to bottom, 5 mirrored across the
 * top-left to bottom-right diagonal, 6 turned 90° clockwise, 7 mirrored across the other diagonal,
 * 8 turned 90° counter-clockwise. 5 to 8 swap width and height.
 */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** An APP1 block that holds Exif starts `Exif\0\0`. */
const EXIF = [0x45, 0x78, 0x69, 0x66, 0, 0];

/**
 * Where a JPEG's IFD0 Orientation value sits and what it is, when it is 2 to 8 (ADR-0101). Reads
 * the first APP1 Exif block before SOS and IFD0's first `0x0112` entry, a SHORT of count 1, and
 * nothing else; every offset is checked against that block, so damaged EXIF gives undefined.
 */
function orientationTag(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  for (let i = 2; i + 4 <= b.length; ) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1] ?? 0;
    // Fill bytes, then the markers that carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    // Start of scan or end of image: no Exif comes after.
    if (marker === 0xda || marker === 0xd9) return undefined;
    const end = i + 2 + view.getUint16(i + 2);
    if (end > b.length || end < i + 4) return undefined;
    const tiff = i + 10;
    if (marker !== 0xe1 || tiff > end || !EXIF.every((x, k) => b[i + 4 + k] === x)) {
      i = end;
      continue;
    }
    if (tiff + 8 > end) return undefined;
    const order = view.getUint16(tiff);
    if (order !== 0x4949 && order !== 0x4d4d) return undefined;
    const little = order === 0x4949;
    if (view.getUint16(tiff + 2, little) !== 42) return undefined;
    const ifd = tiff + view.getUint32(tiff + 4, little);
    if (ifd + 2 > end) return undefined;
    const count = view.getUint16(ifd, little);
    for (let k = 0, e = ifd + 2; k < count && e + 12 <= end; k++, e += 12) {
      if (view.getUint16(e, little) !== 0x0112) continue;
      const value = view.getUint16(e + 8, little);
      const valid =
        view.getUint16(e + 2, little) === 3 &&
        view.getUint32(e + 4, little) === 1 &&
        value >= 2 &&
        value <= 8;
      return valid ? { at: e + 8, little, value: value as Orientation } : undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * A file stored upright (ADR-0101): a JPEG's EXIF orientation, and its bytes with that value
 * rewritten to 1 and nothing else changed; any other file, or a JPEG without a readable
 * orientation, is orientation 1 and returned as it is. Never throws.
 */
export function neutraliseOrientation(file: ImageFile): {
  file: ImageFile;
  orientation: Orientation;
} {
  const tag = file.mime === "image/jpeg" ? orientationTag(file.bytes) : undefined;
  if (!tag) return { file, orientation: 1 };
  const bytes = file.bytes.slice();
  new DataView(bytes.buffer).setUint16(tag.at, 1, tag.little);
  return { file: { ...file, bytes }, orientation: tag.value };
}

/** The file's size as it shows upright: 5 to 8 swap width and height. */
export const uprightSize = (
  { width, height }: { width: number; height: number },
  o: Orientation,
) => (o >= 5 ? { width: height, height: width } : { width, height });

/** Where each orientation sends the stored pixels' x and y axes, as a Matrix's a, b, c, d. */
const TURNS: Record<Orientation, [number, number, number, number]> = {
  1: [1, 0, 0, 1],
  2: [-1, 0, 0, 1],
  3: [-1, 0, 0, -1],
  4: [1, 0, 0, -1],
  5: [0, 1, 1, 0],
  6: [0, 1, -1, 0],
  7: [0, -1, -1, 0],
  8: [0, -1, 1, 0],
};
const FLIP: Record<string, string> = { Min: "Max", Mid: "Mid", Max: "Min" };

/**
 * An Image of a file stored with orientation `o`, shown upright in `box` (ADR-0101): its frame,
 * the box turned back about its centre; the matrix that turns the frame onto the box, which applies
 * before the Image's own transform; and `preserveAspectRatio` with its alignment turned back with
 * it, so the pixels land in the box where the alignment says.
 */
export function orientImage(
  box: Rect,
  o: Orientation,
  preserveAspectRatio: string,
): { frame: Rect; matrix: Matrix; preserveAspectRatio: string } {
  const [a, b, c, d] = TURNS[o];
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  const { width, height } = uprightSize(box, o);
  const frame = { x: cx - width / 2, y: cy - height / 2, width, height };
  const matrix: Matrix = [a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy];
  if (preserveAspectRatio === "none") return { frame, matrix, preserveAspectRatio };
  const [align = "xMidYMid", how = "meet"] = preserveAspectRatio.split(" ");
  const [x, y] = [align.slice(1, 4), align.slice(5, 8)];
  // The stored x axis lands along a ≠ 0 ? the shown x : the shown y, reversed when negative.
  const along = (p: number, q: number, same: string, other: string) =>
    p !== 0 ? (p > 0 ? same : FLIP[same]) : q > 0 ? other : FLIP[other];
  return {
    frame,
    matrix,
    preserveAspectRatio: `x${along(a, b, x, y)}Y${along(d, c, y, x)} ${how}`,
  };
}

/** Whether the bytes start as a WebP does, `RIFF....WEBP` (ADR-0023: by bytes, never by name). */
export const isWebp = (b: Uint8Array) =>
  String.fromCharCode(...b.subarray(0, 4), ...b.subarray(8, 12)) === "RIFFWEBP";

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

const ALIGN = { Min: 0, Mid: 0.5, Max: 1 } as Record<string, number>;

/**
 * Where SVG's `preserveAspectRatio`, as `preserveAspectRatio()` spells it, puts a box of `size` in
 * `frame`: an Image's file in its frame, or a nested `<svg>`'s viewBox in its viewport.
 */
export function aspectPlacement(
  frame: Rect,
  size: { width: number; height: number },
  preserveAspectRatio: string,
): Rect {
  const { x, y } = frame;
  if (preserveAspectRatio === "none") return { x, y, width: frame.width, height: frame.height };
  const [align = "xMidYMid", how] = preserveAspectRatio.split(" ");
  const k = (how === "slice" ? Math.max : Math.min)(
    frame.width / size.width,
    frame.height / size.height,
  );
  const [width, height] = [size.width * k, size.height * k];
  return {
    x: x + (frame.width - width) * (ALIGN[align.slice(1, 4)] ?? 0.5),
    y: y + (frame.height - height) * (ALIGN[align.slice(5, 8)] ?? 0.5),
    width,
    height,
  };
}
