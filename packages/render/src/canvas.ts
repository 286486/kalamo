import {
  applyTo,
  BUNDLED_FONT,
  bundledStyle,
  childrenOf,
  clippingPath,
  crossedFrame,
  type Document,
  ellipseMatrix,
  type Fill,
  fontFace,
  glyphs,
  invert,
  type LeafNode,
  layoutText,
  type Matrix,
  MISSING_LINK_STROKE,
  type Node,
  type Rect,
  type Segment,
  shapeSegments,
  type TextNode,
  transformSegments,
} from "@zibel/core";

type Stroke = LeafNode["appearance"]["strokes"][number];

/**
 * The CanvasRenderingContext2D members drawDocument uses. Declared here because render is also
 * type-checked for workerd, which has no DOM; a browser's context satisfies it structurally.
 */
export interface Canvas2D {
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: Stroke["cap"];
  lineJoin: Stroke["join"];
  miterLimit: number;
  font: string;
  fontKerning: "auto" | "normal" | "none";
  save(): void;
  restore(): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash(segments: number[]): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
  closePath(): void;
  fill(rule?: "nonzero" | "evenodd"): void;
  clip(rule?: "nonzero" | "evenodd"): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient2D;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradient2D;
}

export interface CanvasGradient2D {
  addColorStop(offset: number, color: string): void;
}

/**
 * A paint as a canvas style, the same field `toSvg` writes (ADR-0026). With `ellipse`, an
 * elliptical radial gradient comes with its ellipse, for the caller to put in force only while it
 * fills, so the traced outline is not distorted; without, it draws as its circle.
 */
function styleOf(ctx: Canvas2D, p: Fill, ellipse: boolean): { style: unknown; m?: Matrix } {
  if (p.type === "solid") return { style: p.color };
  const g = p.gradient;
  let style: CanvasGradient2D;
  let m: Matrix | undefined;
  if (g.type === "linear") {
    style = ctx.createLinearGradient(g.start.x, g.start.y, g.end.x, g.end.y);
  } else {
    m = ellipse ? ellipseMatrix(g) : undefined;
    const [fx, fy] = m ? applyTo(invert(m), g.focus.x, g.focus.y) : [g.focus.x, g.focus.y];
    style = ctx.createRadialGradient(fx, fy, 0, g.center.x, g.center.y, g.radius);
  }
  for (const s of g.stops) style.addColorStop(s.offset, s.color);
  return { style, m };
}

/** An Image's file, decoded for the canvas, with its pixel size. */
export interface DecodedImage {
  image: unknown;
  width: number;
  height: number;
}

/**
 * Draws the Document in document coordinates: the same scene, in the same order, as `toSvg`. An
 * Image draws once `images` has its file decoded (ADR-0023).
 */
export function drawDocument(
  ctx: Canvas2D,
  doc: Document,
  images?: (id: string) => DecodedImage | undefined,
): void {
  for (const { frame, background } of doc.artboards) {
    if (!background) continue;
    ctx.fillStyle = background;
    ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
  }
  for (const n of childrenOf(doc, null)) draw(ctx, doc, n, images);
}

const ALIGN = { Min: 0, Mid: 0.5, Max: 1 } as Record<string, number>;

/** Where SVG's `preserveAspectRatio` puts a file of `size` pixels in `frame`. */
export function imagePlacement(
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

function draw(
  ctx: Canvas2D,
  doc: Document,
  n: Node,
  images: ((id: string) => DecodedImage | undefined) | undefined,
) {
  if (!n.visible) return;
  ctx.save();
  // ponytail: opacity multiplies into globalAlpha, and a blend mode sets globalCompositeOperation,
  // per paint, so overlapping children (or a Fill under a Stroke) show through or blend with each
  // other where SVG composites the container first; draw translucent or blended containers to an
  // offscreen layer when that difference matters.
  ctx.globalAlpha *= n.opacity;
  // Canvas2D takes the CSS names `toSvg` writes as mix-blend-mode. A normal Node keeps the mode it
  // draws in, so a blended container's children blend too.
  if (n.blendMode !== "normal") ctx.globalCompositeOperation = n.blendMode;
  ctx.transform(...n.transform);
  if (n.type === "layer" || n.type === "group") {
    // A Clipping Mask's children draw only inside its Clipping Path, which never paints (ADR-0021).
    const clip = clippingPath(doc, n);
    if (clip) {
      trace(ctx, transformSegments(shapeSegments(clip), clip.transform));
      ctx.clip(clip.type === "path" && clip.fillRule === "evenodd" ? "evenodd" : "nonzero");
    }
    for (const c of childrenOf(doc, n.id)) if (c !== clip) draw(ctx, doc, c, images);
  } else if (n.type === "image") {
    const file = n.src === undefined ? undefined : images?.(n.src);
    if (n.src === undefined) {
      // A missing link, as `toSvg` draws it (ADR-0042): traced in place, then stroked in device
      // space so it stays one device pixel at any zoom.
      trace(ctx, crossedFrame(n));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = MISSING_LINK_STROKE;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.stroke();
    } else if (file) {
      if (n.preserveAspectRatio.endsWith("slice")) {
        ctx.beginPath();
        ctx.rect(n.x, n.y, n.width, n.height);
        ctx.clip();
      }
      const r = imagePlacement(n, file, n.preserveAspectRatio);
      ctx.drawImage(file.image, r.x, r.y, r.width, r.height);
    }
  } else {
    if (n.type === "text") {
      // Every font renders in the bundled face its bounds are measured in (ADR-0017, ADR-0028).
      const { weight, italic } = fontFace(bundledStyle(n.fontStyle));
      ctx.font = [
        italic && "italic",
        weight !== 400 && weight,
        `${n.fontSize}px`,
        `"${BUNDLED_FONT}"`,
      ]
        .filter(Boolean)
        .join(" ");
      // Unkerned, like the SVG, so the drawn width is the advance sum (ADR-0013).
      ctx.fontKerning = "none";
    } else {
      trace(ctx, shapeSegments(n));
    }
    for (const f of n.appearance.fills) {
      // ponytail: the ellipse would distort glyphs, so text draws an elliptical radial gradient as
      // its circle; SVG draws it exactly. Draw glyph outlines when Create Outlines lands.
      const { style, m } = styleOf(ctx, f, n.type !== "text");
      ctx.fillStyle = style;
      if (m) {
        ctx.save();
        ctx.transform(...m);
      }
      if (n.type === "text") text(ctx, n, (t, x, y) => ctx.fillText(t, x, y), style);
      else if (n.type === "path" && n.fillRule === "evenodd") ctx.fill("evenodd");
      else ctx.fill();
      if (m) ctx.restore();
    }
    for (const s of n.appearance.strokes) {
      // ponytail: the ellipse would also scale the pen, so a Stroke draws an elliptical radial
      // gradient as its circle; SVG draws it exactly. Stroke to an offscreen layer when it matters.
      ctx.strokeStyle = styleOf(ctx, s, false).style;
      ctx.lineWidth = s.width;
      ctx.lineCap = s.cap;
      ctx.lineJoin = s.join;
      ctx.miterLimit = s.miterLimit;
      ctx.setLineDash(s.dash);
      if (n.type === "text") text(ctx, n, (t, x, y) => ctx.strokeText(t, x, y));
      else ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Paints a text's shown lines, so overflowing Area Type is not drawn (ADR-0022). With tracking or
 * ranges each character paints on its own at its origin, raised by its baseline shift and turned
 * about the origin by its rotation, in its range's fill when `fill` is the Fill's style (ADR-0029).
 */
function text(
  ctx: Canvas2D,
  n: TextNode,
  paint: (text: string, x: number, y: number) => void,
  fill?: unknown,
) {
  if (!n.tracking && !n.ranges) {
    for (const l of layoutText(n).lines) paint(l.text, l.x, l.y);
    return;
  }
  let style = fill;
  for (const g of glyphs(n)) {
    if (g.char === "\n") continue;
    if (fill !== undefined && (g.fill ?? fill) !== style) {
      style = g.fill ?? fill;
      ctx.fillStyle = style;
    }
    const turned = g.rotation || g.baselineShift;
    if (turned) {
      const a = ((g.rotation ?? 0) * Math.PI) / 180;
      const [cos, sin] = [Math.cos(a), Math.sin(a)];
      const y = g.y - (g.baselineShift ?? 0);
      ctx.save();
      ctx.transform(cos, sin, -sin, cos, g.x - cos * g.x + sin * g.y, y - sin * g.x - cos * g.y);
    }
    paint(g.char, g.x, g.y);
    if (turned) ctx.restore();
  }
}

function trace(ctx: Canvas2D, segments: Segment[]) {
  ctx.beginPath();
  for (const { cmd, args: a } of segments) {
    if (cmd === "M") ctx.moveTo(...(a as [number, number]));
    else if (cmd === "L") ctx.lineTo(...(a as [number, number]));
    else if (cmd === "C")
      ctx.bezierCurveTo(...(a as [number, number, number, number, number, number]));
    else if (cmd === "Q") ctx.quadraticCurveTo(...(a as [number, number, number, number]));
    else ctx.closePath();
  }
}
