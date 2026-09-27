import {
  bounds,
  type Document,
  formatNumber,
  type ImageSource,
  type Node,
  type Rect,
  type RenderOverlay,
  type RenderScope,
  ZibelError,
} from "@zibel/core";
import { attrs, esc, toSvg } from "@zibel/io/write";

/** The longest side `render` and `export` rasterise (REQUIREMENTS §7). */
export const MAX_RENDER_SIDE = 4096;

/**
 * The scale, pixel size and rect of an image of `rect` at `scale`, lowered to fit `maxSize`.
 * resvg rounds the pixel size and stretches the drawing to it, so the rect widens to whole pixels
 * (by less than one) to keep `scale` the exact zoom drawn.
 */
export function fit(rect: Rect, scale: number, maxSize?: number) {
  const long = Math.max(rect.width, rect.height);
  const used = maxSize !== undefined && long * scale > maxSize ? maxSize / long : scale;
  // The epsilon keeps float noise such as 2000 × 0.8 = 1600.0000000000002 from adding a pixel.
  const px = (side: number) => Math.max(1, Math.ceil(side * used - 1e-6));
  if (px(long) > MAX_RENDER_SIDE) {
    const fits = Math.floor((MAX_RENDER_SIDE / long) * 100) / 100;
    const viaMaxSize = maxSize !== undefined && maxSize > MAX_RENDER_SIDE;
    throw new ZibelError({
      code: "LIMIT_EXCEEDED",
      message: `The image would be ${px(long)} px on its longest side; the limit is ${MAX_RENDER_SIDE}.`,
      hint: viaMaxSize
        ? `Use maxSize <= ${MAX_RENDER_SIDE} (default 1600), or scale <= ${fits}.`
        : `Use scale <= ${fits}, or a smaller scope.`,
      path: viaMaxSize ? "maxSize" : "scale",
    });
  }
  const pixelSize = { width: px(rect.width), height: px(rect.height) };
  const widen = (side: number, pixels: number) =>
    Math.abs(pixels / used - side) < 1e-9 ? side : pixels / used;
  return {
    rect: {
      ...rect,
      width: widen(rect.width, pixelSize.width),
      height: widen(rect.height, pixelSize.height),
    },
    scale: used,
    pixelSize,
  };
}

export interface RenderOptions {
  /** The Render Scope drawn (default: the Document). */
  scope?: RenderScope;
  /** A colour filling the whole rect beneath everything. */
  background?: string;
  /** Render Overlays drawn over the artwork, sized in pixels at `scale` (ADR-0014). */
  overlays?: RenderOverlay[];
  scale?: number;
  /** The file of each Image by id (ADR-0023). */
  images?: ImageSource;
}

/** The SVG `render` rasterises: io's, as `export` writes it (ADR-0019), with Render Overlays on top. */
export function renderSvg(doc: Document, rect?: Rect, opts: RenderOptions = {}): string {
  const { overlays: on, scale = 1, ...svg } = opts;
  return toSvg(doc, rect, {
    ...svg,
    linked: "draw",
    hairline: 1 / scale,
    trailer: on?.length ? (drawn) => overlays(doc, drawn, new Set(on), scale) : undefined,
  });
}

// Magenta boxes and labels, cyan Artboard edges: colours artwork rarely uses, and neither is the
// default black Stroke.
const BOX = "#FF00FF";
const EDGE = "#00AEEF";

/** Artboard edges, then boxes, then id labels on top, each a fixed pixel size at `scale`. */
function overlays(doc: Document, drawn: Node[], on: Set<RenderOverlay>, scale: number): string {
  const px = (v: number) => formatNumber(v / scale);
  const outline = (r: Rect, stroke: string) =>
    `<rect${attrs({
      x: formatNumber(r.x),
      y: formatNumber(r.y),
      width: formatNumber(r.width),
      height: formatNumber(r.height),
      fill: "none",
      stroke,
      "stroke-width": px(1),
    })}/>`;
  const boxes = drawn.flatMap((n) => {
    const b = bounds(doc, n);
    return b ? [{ n, b }] : [];
  });
  // Inside the top-left corner, so a Node at the image's edge keeps its label; a white halo
  // under the text reads on any colour.
  const label = ({ n, b }: { n: Node; b: Rect }) =>
    [
      { fill: "none", stroke: "#FFFFFF", "stroke-width": px(3), "stroke-linejoin": "round" },
      { fill: BOX },
    ]
      .map(
        (paint) =>
          `<text${attrs({
            x: formatNumber(b.x + 2 / scale),
            y: formatNumber(b.y + 11 / scale),
            "font-family": "Source Sans 3",
            "font-size": px(11),
            ...paint,
          })}>${esc(n.id)}</text>`,
      )
      .join("");
  return [
    ...(on.has("artboards") ? doc.artboards.map((a) => outline(a.frame, EDGE)) : []),
    ...(on.has("bounds") ? boxes.map(({ b }) => outline(b, BOX)) : []),
    ...(on.has("ids") ? boxes.map(label) : []),
  ].join("");
}
