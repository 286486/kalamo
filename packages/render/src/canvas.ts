import {
  applyTo,
  bundledStyle,
  childrenOf,
  clippingPath,
  containerAppearance,
  crossedFrame,
  type Document,
  ellipseMatrix,
  type Fill,
  fontFace,
  fontFamilies,
  type Glyph,
  glyphs,
  hasGlyph,
  invert,
  type LeafNode,
  layoutText,
  type Matrix,
  MISSING_LINK_STROKE,
  mapPaint,
  type Node,
  notdefBox,
  type PaintedLeaf,
  paintedLeaves,
  type Rect,
  type Segment,
  scaleOf,
  shapeSegments,
  type TextNode,
  transformSegments,
  unscaledStroke,
  worldTransform,
} from "@kalamo/core";

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
  drawImage(image: unknown, x: number, y: number): void;
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
  readonly canvas: { width: number; height: number };
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number };
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
 * A fresh, transparent canvas the target's device size, with the image the target's `drawImage`
 * takes to composite it. Render cannot make one: it is type-checked for workerd, which has no DOM.
 */
export type NewLayer = () => { ctx: Canvas2D; image: unknown };

/** What every Node of one drawDocument call draws from. */
interface Scene {
  doc: Document;
  layer: NewLayer;
  images: ((id: string) => DecodedImage | undefined) | undefined;
  /**
   * Isolation Mode's coverage: the isolated Node and the containers above it, each of which draws
   * only its child on the way down, in its transform and clip, without its own paint, opacity or
   * mode.
   */
  subtree?: { id: string; above: Set<string> };
  /** Isolation Mode's rest: the isolated Node it leaves out. */
  without?: string;
  /** Isolation Mode's whole Document: it draws up to and including this Node, then nothing. */
  until?: { id: string; done: boolean };
}

/** Whether a child of the Document or of a container above the subtree draws: the way down to it. */
const onPath = (scene: Scene, n: Node) =>
  !scene.subtree || n.id === scene.subtree.id || scene.subtree.above.has(n.id);

/**
 * Draws the Document in document coordinates: the same scene, in the same order, as `toSvg`. A
 * translucent or blended Node that paints more than once composes in a `layer` first, as SVG does
 * (ADR-0044). An Image draws once `images` has its file decoded (ADR-0023). With `isolated`, the
 * browser's Isolation Mode (ADR-0057): wherever that Node's shape is, the Document's pixels up to
 * and including it; elsewhere, everything but it, washed halfway to white (#131).
 */
export function drawDocument(
  ctx: Canvas2D,
  doc: Document,
  layer: NewLayer,
  images?: (id: string) => DecodedImage | undefined,
  isolated?: string | null,
): void {
  const scene: Scene = { doc, layer, images };
  const drawAll = (target: Canvas2D, without?: string, until?: Scene["until"]) => {
    for (const { frame, background } of doc.artboards) {
      if (!background) continue;
      target.fillStyle = background;
      target.fillRect(frame.x, frame.y, frame.width, frame.height);
    }
    for (const n of childrenOf(doc, null)) draw(target, n, { ...scene, without, until });
  };
  if (isolated == null || !doc.nodes.has(isolated)) {
    drawAll(ctx);
    return;
  }
  const above = new Set<string>();
  for (let n = doc.nodes.get(isolated); n?.parentId; n = doc.nodes.get(n.parentId)) {
    above.add(n.parentId);
  }
  // ponytail: Isolation Mode draws the Document three times through two full-canvas layers per
  // frame; crop them to the isolated Node's device bounds if it shows up in a profile.
  const { a, b, c, d, e, f } = ctx.getTransform();
  // How much the isolated Node's shape covers each pixel, in its ancestors' transforms and clips.
  const coverage = layer();
  coverage.ctx.setTransform(a, b, c, d, e, f);
  const inside = { ...scene, subtree: { id: isolated, above } };
  for (const n of childrenOf(doc, null)) if (onPath(inside, n)) draw(coverage.ctx, n, inside);
  // The Document over a copy of the canvas, as it draws outside Isolation Mode up to and including
  // the isolated Node, kept where the Node covers: artwork above it is in the washed rest.
  const kept = layer();
  kept.ctx.drawImage(ctx.canvas, 0, 0);
  kept.ctx.setTransform(a, b, c, d, e, f);
  drawAll(kept.ctx, undefined, { id: isolated, done: false });
  kept.ctx.setTransform(1, 0, 0, 1, 0, 0);
  kept.ctx.globalCompositeOperation = "destination-in";
  kept.ctx.drawImage(coverage.image, 0, 0);
  // The rest, washed, cut out where it covers, then the two added: exact where it covers fully.
  drawAll(ctx, isolated);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(coverage.image, 0, 0);
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(kept.image, 0, 0);
  ctx.restore();
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

/** Whether one paint of `n` could show through or blend with another of its own (ADR-0044). */
const paintsMoreThanOnce = (n: Node) =>
  n.type === "layer" ||
  n.type === "group" ||
  n.type === "text" ||
  (n.type !== "image" && n.appearance.fills.length + n.appearance.strokes.length > 1);

function draw(ctx: Canvas2D, n: Node, scene: Scene) {
  if (!n.visible || n.id === scene.without || scene.until?.done) return;
  drawNode(ctx, n, scene);
  if (scene.until && n.id === scene.until.id) scene.until.done = true;
}

function drawNode(ctx: Canvas2D, n: Node, scene: Scene) {
  // Coverage is the isolated Node's shape: nothing in it takes an opacity or mode.
  const opacity = scene.subtree ? 1 : n.opacity;
  const mode = scene.subtree || n.blendMode === "normal" ? "source-over" : n.blendMode;
  if ((opacity < 1 || mode !== "source-over") && paintsMoreThanOnce(n)) {
    // An isolated group: its contents compose on their own, then composite once in its opacity and
    // mode, in device pixels, inside every ancestor's clip.
    // ponytail: a layer covers the whole canvas; crop it to the Node's visible bounds in device space
    // if many translucent containers show up in a profile.
    const { ctx: into, image } = scene.layer();
    const { a, b, c, d, e, f } = ctx.getTransform();
    into.setTransform(a, b, c, d, e, f);
    paint(into, n, scene);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = mode;
    ctx.drawImage(image, 0, 0);
    ctx.restore();
    return;
  }
  // One paint composites the same directly as through a layer. Canvas2D takes the CSS names
  // `toSvg` writes as mix-blend-mode. Every Node is entered in 1 and source-over, so a plain
  // container's children blend with what is below it.
  ctx.save();
  ctx.globalAlpha = opacity;
  if (mode !== "source-over") ctx.globalCompositeOperation = mode;
  paint(ctx, n, scene);
  ctx.restore();
}

/** Draws `n` in `ctx`'s opacity and mode, its children each in their own; leaves `ctx` changed. */
function paint(ctx: Canvas2D, n: Node, scene: Scene) {
  const { doc, images } = scene;
  ctx.transform(...n.transform);
  if (n.type === "layer" || n.type === "group") {
    // A Clipping Mask draws everything inside its Clipping Path but that path's own Strokes
    // (ADR-0021, ADR-0051); a text clips through a layer, since Canvas2D cannot clip by glyphs
    // (ADR-0052).
    const clip = clippingPath(doc, n);
    const clipped = (draws: (ctx: Canvas2D) => void) => {
      if (!clip) return draws(ctx);
      if (clip.type === "text") return masked(ctx, scene, [clip], draws);
      ctx.save();
      trace(ctx, transformSegments(shapeSegments(clip), clip.transform));
      ctx.clip(clip.type === "path" && clip.fillRule === "evenodd" ? "evenodd" : "nonzero");
      draws(ctx);
      ctx.restore();
    };
    // Its Appearance paints every leaf's outline, in document coordinates since a container
    // carries identity (ADR-0007), one paint over all of them before the next, the first
    // `contents` below the children (ADR-0043).
    // Above a subtree, a container draws only its child on the way down.
    const passing = scene.subtree?.above.has(n.id) ?? false;
    const { fills, strokes, contents } = passing
      ? { fills: [], strokes: [], contents: 0 }
      : containerAppearance(n);
    const leaves = fills.length + strokes.length > 0 ? paintedLeaves(doc, n) : [];
    /**
     * Paints every leaf in the paint `style` sets, each inside its inner Clipping Masks; a text in
     * its glyphs, placed by its transform, which `glyphs` is given.
     */
    const over = (
      ctx: Canvas2D,
      style: (ctx: Canvas2D) => void,
      glyphs: (ctx: Canvas2D, t: TextNode, m: Matrix) => void,
      shape: (ctx: Canvas2D, l: PaintedLeaf) => void,
    ) => {
      for (const l of leaves) {
        ctx.save();
        for (const c of l.clips) {
          if (c.text) continue;
          trace(ctx, c.segments);
          ctx.clip(c.fillRule);
        }
        const texts = l.clips.flatMap((c) => (c.text ? [c.text] : []));
        masked(ctx, scene, texts, (ctx) => {
          style(ctx);
          if (l.node.type === "text") {
            const m = worldTransform(doc, l.node);
            ctx.transform(...m);
            font(ctx, l.node);
            glyphs(ctx, l.node, m);
          } else {
            trace(ctx, l.segments);
            shape(ctx, l);
          }
        });
        ctx.restore();
      }
    };
    // No range fills on a text: a container Fill paints every glyph in its own colour. A gradient
    // is in document coordinates, so a text, drawn in its transform, takes it mapped back through it.
    // ponytail: an elliptical radial draws as its circle on text and Strokes, as on a leaf.
    const paints = [
      ...fills.map((f) => (ctx: Canvas2D) => {
        over(
          ctx,
          (ctx) => {
            ctx.fillStyle = styleOf(ctx, f, false).style;
          },
          (ctx, t, m) => {
            if (f.type === "gradient") {
              ctx.fillStyle = styleOf(ctx, mapPaint(f, invert(m)), false).style;
            }
            text(ctx, t, "fill");
          },
          (ctx, l) => {
            if (f.type === "gradient") {
              const { style, m } = styleOf(ctx, f, true);
              ctx.fillStyle = style;
              if (m) ctx.transform(...m);
            }
            ctx.fill(l.fillRule);
          },
        );
      }),
      ...strokes.map((s) => (ctx: Canvas2D) => {
        over(
          ctx,
          (ctx) => pen(ctx, s),
          (ctx, t, m) => {
            const k = scaleOf(m);
            if (k !== 1 || s.type === "gradient")
              pen(ctx, mapPaint(unscaledStroke(s, k), invert(m)));
            text(ctx, t, "stroke");
          },
          (ctx) => ctx.stroke(),
        );
      }),
    ];
    // The Clipping Path's Fills and its Strokes are two parts, each in its opacity and mode, with
    // the content between them.
    const part = (ctx: Canvas2D, c: LeafNode, list: "fills" | "strokes") => {
      const appearance = { fills: [], strokes: [], [list]: c.appearance[list] };
      if (c.appearance[list].length > 0) draw(ctx, { ...c, appearance }, scene);
    };
    const children = childrenOf(doc, n.id).filter(
      (c) => c !== clip && (!passing || onPath(scene, c)),
    );
    clipped((ctx) => {
      for (const p of paints.slice(0, contents)) p(ctx);
      if (clip && !passing) part(ctx, clip, "fills");
      for (const c of children) draw(ctx, c, scene);
    });
    if (clip && !passing) part(ctx, clip, "strokes");
    if (contents < paints.length && !scene.until?.done) {
      clipped((ctx) => {
        for (const p of paints.slice(contents)) p(ctx);
      });
    }
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
    if (n.type === "text") font(ctx, n);
    else {
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
      if (n.type === "text") text(ctx, n, "fill", style);
      else if (n.type === "path" && n.fillRule === "evenodd") ctx.fill("evenodd");
      else ctx.fill();
      if (m) ctx.restore();
    }
    for (const s of n.appearance.strokes) {
      // ponytail: the ellipse would also scale the pen, so a Stroke draws an elliptical radial
      // gradient as its circle; SVG draws it exactly. Stroke to an offscreen layer when it matters.
      pen(ctx, s);
      if (n.type === "text") text(ctx, n, "stroke");
      else ctx.stroke();
    }
  }
}

/**
 * Runs `draws` through the glyphs of every text in `texts` (ADR-0052): into a layer, which keeps
 * only what each text's glyphs cover, composited back in `ctx`'s opacity, mode and clip. A text's
 * glyphs draw into a layer of their own and mask with one destination-in drawImage, since each
 * fillText under destination-in would clear what the text's other glyphs drew. A text that draws no
 * glyph keeps nothing.
 */
function masked(ctx: Canvas2D, scene: Scene, texts: TextNode[], draws: (ctx: Canvas2D) => void) {
  if (texts.length === 0) return draws(ctx);
  if (texts.some((t) => !layoutText(t).lines.some((l) => l.text.trim()))) return;
  // ponytail: layers cover the whole canvas; crop them to the Clipping Mask's visible bounds in
  // device space if text clips show up in a profile.
  const { ctx: into, image } = scene.layer();
  const { a, b, c, d, e, f } = ctx.getTransform();
  into.setTransform(a, b, c, d, e, f);
  into.save();
  draws(into);
  into.restore();
  into.setTransform(1, 0, 0, 1, 0, 0);
  into.globalCompositeOperation = "destination-in";
  for (const t of texts) {
    const { ctx: mask, image: glyphs } = scene.layer();
    mask.setTransform(a, b, c, d, e, f);
    drawClipGlyphs(mask, t, worldTransform(scene.doc, t));
    into.drawImage(glyphs, 0, 0);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

/**
 * Draws the glyphs a text Clipping Path clips by, opaque and in no paint of its own, at its
 * transform `m`: the same lines, faces and characters its leaf draws (ADR-0052).
 */
export function drawClipGlyphs(ctx: Canvas2D, t: TextNode, m: Matrix): void {
  ctx.save();
  ctx.transform(...m);
  font(ctx, t);
  ctx.fillStyle = "#000000";
  text(ctx, t, "fill");
  ctx.restore();
}

/** Sets `ctx` to draw the text's glyphs. */
function font(ctx: Canvas2D, n: TextNode) {
  // Every font renders in the bundled faces its bounds are measured in, each character in the first
  // family that has it (ADR-0017, ADR-0028, ADR-0063).
  const { weight, italic } = fontFace(bundledStyle(n.fontStyle));
  const families = fontFamilies(n).map((f) => `"${f}"`);
  ctx.font = [italic && "italic", weight !== 400 && weight, `${n.fontSize}px`, families.join(", ")]
    .filter(Boolean)
    .join(" ");
  // Unkerned, like the SVG, so the drawn width is the advance sum (ADR-0013).
  ctx.fontKerning = "none";
}

/** Sets `ctx` to draw the Stroke `s`. */
function pen(ctx: Canvas2D, s: Stroke) {
  ctx.strokeStyle = styleOf(ctx, s, false).style;
  ctx.lineWidth = s.width;
  ctx.lineCap = s.cap;
  ctx.lineJoin = s.join;
  ctx.miterLimit = s.miterLimit;
  ctx.setLineDash(s.dash);
}

/**
 * Fills or strokes a text's shown lines, so overflowing Area Type is not drawn (ADR-0022). With
 * tracking or ranges each character paints on its own at its origin, raised by its baseline shift
 * and turned about the origin by its rotation, in its range's fill when `fill` is the Fill's style
 * (ADR-0029). A character no bundled face has paints as the first face's `.notdef` box at its
 * origin, traced, since `fillText` would draw it in a system font (ADR-0065); a line holding one
 * paints the characters around it in runs from their first character's origin.
 */
function text(ctx: Canvas2D, n: TextNode, how: "fill" | "stroke", fill?: unknown) {
  const paint = (t: string, x: number, y: number) =>
    how === "fill" ? ctx.fillText(t, x, y) : ctx.strokeText(t, x, y);
  const box = (x: number, y: number) => {
    trace(ctx, notdefBox(n, x, y));
    if (how === "fill") ctx.fill();
    else ctx.stroke();
  };
  if (!n.tracking && !n.ranges) {
    let placed: Glyph[] | undefined;
    let k = 0;
    for (const l of layoutText(n).lines) {
      const chars = [...l.text];
      if (chars.every((ch) => hasGlyph(n, ch))) paint(l.text, l.x, l.y);
      else {
        placed ??= glyphs(n);
        let run: Glyph[] = [];
        const flush = () => {
          if (run[0]) paint(run.map((g) => g.char).join(""), run[0].x, run[0].y);
          run = [];
        };
        for (const g of placed.slice(k, k + chars.length)) {
          if (hasGlyph(n, g.char)) run.push(g);
          else {
            flush();
            box(g.x, g.y);
          }
        }
        flush();
      }
      k += chars.length;
    }
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
    if (hasGlyph(n, g.char)) paint(g.char, g.x, g.y);
    else box(g.x, g.y);
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
