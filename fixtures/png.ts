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
