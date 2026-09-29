import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import { BUNDLED_FONT, type BundledFamily } from "@zibel/core";
import black from "../fonts/SourceSans3-Black.ttf";
import blackItalic from "../fonts/SourceSans3-BlackIt.ttf";
import bold from "../fonts/SourceSans3-Bold.ttf";
import boldItalic from "../fonts/SourceSans3-BoldIt.ttf";
import italic from "../fonts/SourceSans3-It.ttf";
import regular from "../fonts/SourceSans3-Regular.ttf";

// Workers forbid compiling wasm from bytes at runtime, so the module is imported statically
// and initialised once per isolate.
const ready = initWasm(wasm);

// The bundled faces (ADR-0013, ADR-0028); workerd has no system fonts to fall back on.
const sourceSans3 = [regular, italic, bold, boldItalic, black, blackItalic].map(
  (f) => new Uint8Array(f),
);
/** The files of each family but Source Sans 3, keyed by the family core names (ADR-0063, ADR-0066). */
export const LAZY_FONTS: Record<
  Exclude<BundledFamily, typeof BUNDLED_FONT>,
  () => Promise<{ default: ArrayBuffer }>[]
> = {
  "Noto Sans SC": () => [
    import("../fonts/NotoSansSC-Regular.otf"),
    import("../fonts/NotoSansSC-Bold.otf"),
  ],
  "Noto Sans KR": () => [
    import("../fonts/NotoSansKR-Regular.otf"),
    import("../fonts/NotoSansKR-Bold.otf"),
  ],
};
type LazyFamily = keyof typeof LAZY_FONTS;

// Each lazy family's files, 9 to 17 MB, load on the first render that draws in it, and only such a
// render copies them into resvg (ADR-0063, ADR-0066): a chunk in it names it, as does a text set in it.
// ponytail: sniffs the SVG, so CJK in an SVG that does not name the family, such as an exported
// file, draws .notdef; pass the families from renderSvg if svgToPng takes other SVGs.
const loaded = new Map<LazyFamily, Promise<Uint8Array[]>>();
function load(family: LazyFamily) {
  let files = loaded.get(family);
  if (!files) {
    files = Promise.all(LAZY_FONTS[family]()).then((fs) =>
      fs.map((f) => new Uint8Array(f.default)),
    );
    loaded.set(family, files);
  }
  return files;
}

/** The fonts resvg gets for `svg`: Source Sans 3, and each lazy family it names. */
export async function renderFonts(svg: string) {
  const families = (Object.keys(LAZY_FONTS) as LazyFamily[]).filter((f) => svg.includes(f));
  return {
    fontBuffers: [...sourceSans3, ...(await Promise.all(families.map(load))).flat()],
    loadSystemFonts: false,
    // Also what every family the bundle lacks falls back to (ADR-0017).
    defaultFontFamily: BUNDLED_FONT,
  };
}

async function rasterise<T>(
  svg: string,
  scale: number,
  read: (image: { asPng(): Uint8Array; pixels: Uint8Array }) => T,
): Promise<{ width: number; height: number } & T> {
  await ready;
  const font = await renderFonts(svg);
  // At 72 dpi the root's pt is one pixel per point, so zoom is pixels per point (ADR-0017).
  const resvg = new Resvg(svg, { fitTo: { mode: "zoom", value: scale }, dpi: 72, font });
  const image = resvg.render();
  try {
    return { ...read(image), width: image.width, height: image.height };
  } finally {
    image.free();
    resvg.free();
  }
}

export const svgToPng = (svg: string, scale: number) =>
  rasterise(svg, scale, (image) => ({ png: image.asPng() }));

/** Raw RGBA, row by row; for tests, since workerd cannot decode a PNG. */
export const svgToPixels = (svg: string, scale: number) =>
  rasterise(svg, scale, (image) => ({ pixels: image.pixels.slice() }));
