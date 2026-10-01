export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Decodes an RGBA8 non-interlaced PNG, what resvg writes and Inkscape does with RGBA_8. Web
 * standard, so it runs in Node and in workerd alike.
 */
export async function decodePng(png: Uint8Array): Promise<Image> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (let pos = 8; pos < png.length; pos += 12 + view.getUint32(pos)) {
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const data = png.subarray(pos + 8, pos + 8 + view.getUint32(pos));
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0)
        throw new Error(
          `PNG is not RGBA8: depth ${data[8]}, colour ${data[9]}, interlace ${data[12]}`,
        );
    } else if (type === "IDAT") idat.push(data);
  }
  const inflated = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(inflated).arrayBuffer());
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1);
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? (out[row + i - 4] ?? 0) : 0;
      const b = y ? (out[row - stride + i] ?? 0) : 0;
      const c = i >= 4 && y ? (out[row - stride + i - 4] ?? 0) : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter ?? 0] ?? 0;
      out[row + i] = ((src[i] ?? 0) + predictor) & 255;
    }
  }
  return { width, height, data: out };
}

/** A pixel differs when a channel, the alpha included, is off by more than this (ADR-0017). */
const TOLERANCE = 32;
/** The share of a vector region's pixels that may differ (ADR-0017). */
export const VECTOR_BUDGET = 0.007;

/** Whether the pixel at byte `i` of two RGBA8 images differs. */
export const differs = (a: Uint8Array, b: Uint8Array, i: number) =>
  [0, 1, 2, 3].some((k) => Math.abs((a[i + k] ?? 0) - (b[i + k] ?? 0)) > TOLERANCE);

/**
 * The pixels where two RGBA8 images of `width` differ in any byte, the first ten as
 * `x,y: before → after`. Vitest's `toEqual` walks a typed array element by element, which takes
 * about 0.4 s per 400×240 image in workerd (#215).
 */
export function changedPixels(before: Uint8Array, after: Uint8Array, width: number) {
  if (before.length !== after.length) return [`${before.length} bytes → ${after.length} bytes`];
  const out: string[] = [];
  let count = 0;
  for (let i = 0; i < before.length; i += 4) {
    if ([0, 1, 2, 3].every((k) => before[i + k] === after[i + k])) continue;
    const [was, now] = [before.subarray(i, i + 4), after.subarray(i, i + 4)];
    if (++count <= 10) out.push(`${(i / 4) % width},${Math.floor(i / 4 / width)}: ${was} → ${now}`);
  }
  if (count > 10) out.push(`and ${count - 10} more`);
  return out;
}
