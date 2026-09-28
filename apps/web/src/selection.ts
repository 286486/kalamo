import {
  bounds,
  childrenOf,
  clippingPath,
  containerAppearance,
  type Document,
  formatPath,
  frameShape,
  type ImageNode,
  isLiveShape,
  type LeafClip,
  type LeafNode,
  leafClip,
  lockedIn,
  type MaskInput,
  type Node,
  paintedLeaves,
  type Rect,
  type ShapeNode,
  scaleOf,
  shapeSegments,
  type TextNode,
  touches,
  transformSegments,
  worldTransform,
} from "@zibel/core";
import { drawClipGlyphs } from "@zibel/render/canvas";
import { inScope } from "./isolation.ts";

/**
 * What Illustrator's Selection tool picks for `node`: its outermost ancestor below a Layer, or below
 * the isolated Node `scope` (ADR-0057, ADR-0058), so a click inside a Group selects the Group; an
 * isolated leaf itself. Null for a Layer, and for a Node outside `scope`.
 */
export function objectOf(doc: Document, node: Node, scope: string | null): Node | null {
  if (node.type === "layer" || !inScope(doc, node, scope)) return null;
  if (node.id === scope) return node;
  let object = node;
  for (let p = doc.nodes.get(node.parentId ?? ""); p && p.type !== "layer" && p.id !== scope; ) {
    object = p;
    p = doc.nodes.get(p.parentId ?? "");
  }
  return object;
}

/**
 * Where Place and new art go (ADR-0017): the nearest Layer in the isolated Group or sub-Layer
 * `scope` (ADR-0057, ADR-0058) holding the first selected Node, else `scope` itself, else the top
 * Layer. An isolated leaf holds none: new art first leaves it (`forNewArt`).
 */
export function placeParent(
  doc: Document,
  selection: string[],
  scope: string | null,
): string | undefined {
  for (let n = doc.nodes.get(selection[0] ?? ""); n; n = doc.nodes.get(n.parentId ?? "")) {
    if (n.id === scope || (n.type === "layer" && inScope(doc, n, scope))) return n.id;
  }
  return scope ?? childrenOf(doc, null).at(-1)?.id;
}

/**
 * Every selectable object (visible and unlocked, as is everything above it) in the Document, or in
 * the Layer or isolated Node `parentId`, in draw order: an isolated leaf is its own only object.
 */
export function objects(doc: Document, parentId: string | null = null): Node[] {
  const walk = (n: Node): Node[] => {
    if (!n.visible || n.locked) return [];
    return n.type === "layer" ? childrenOf(doc, n.id).flatMap(walk) : [n];
  };
  // A Group's objects are its children; a Layer root is walked into; a leaf root is its own.
  const root = doc.nodes.get(parentId ?? "");
  return root && root.type !== "group" ? walk(root) : childrenOf(doc, parentId).flatMap(walk);
}

/**
 * Visible and unlocked, itself and every ancestor: what a canvas gesture may move or delete. A Layers
 * panel row can select a Node that is not (ADR-0012).
 */
export function editable(doc: Document, node: Node | undefined): boolean {
  if (!node) return false;
  for (let n: Node | undefined = node; n; n = doc.nodes.get(n.parentId ?? "")) {
    if (!n.visible || n.locked) return false;
  }
  return true;
}

/**
 * The object whose topmost selectable leaf is painted at (x, y) in document coordinates, within
 * `tolerance` pt of its outline, or null; with `leaf`, that leaf itself, as Direct Selection
 * picks. Hidden and locked Nodes let the click through. With the isolated Node `scope`
 * (ADR-0057, ADR-0058), only what is in it hits, inside its ancestors' clips, and its own unpainted
 * Clipping Path hits on its outline, or a text one on its frame's edges.
 */
export function hitTest(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  x: number,
  y: number,
  tolerance: number,
  { leaf = false, scope }: { leaf?: boolean; scope: string | null },
): string | null {
  let found: Node | null = null;
  const hit = (n: Node) => {
    if (inScope(doc, n, scope)) found = n;
  };
  const walk = (parentId: string | null) => {
    for (const n of childrenOf(doc, parentId)) {
      if (!n.visible || n.locked) continue;
      if (n.type === "layer" || n.type === "group") {
        // Outside its Clipping Path, a Clipping Mask draws only that path's Strokes (ADR-0051).
        const clip = clippingPath(doc, n);
        const inClip = !clip || within(ctx, doc, leafClip(doc, n.id, clip), x, y);
        // A painted Clipping Path hits as a leaf does, its Fill anywhere it clips; a text anywhere
        // in its frame, as a text leaf does (ADR-0052).
        const painted = clip && !clip.locked ? clip.appearance : { fills: [], strokes: [] };
        const inFrame = clip?.type === "text" && paintedAt(ctx, doc, clip, x, y, tolerance);
        // Its Appearance hits as the leaf it paints, in draw order around the children
        // (ADR-0043); a leaf locked below it, or a point outside the leaf's inner Clipping Masks,
        // lets the click through.
        const { fills, strokes, contents } = containerAppearance(n);
        const leaves =
          fills.length + strokes.length > 0
            ? paintedLeaves(doc, n)
                .filter((l) => !lockedIn(doc, l.node))
                .filter((l) => l.clips.every((c) => within(ctx, doc, c, x, y)))
                .map((l) => ({ ...l, path: new Path2D(formatPath(l.segments)) }))
            : [];
        type Leaf = (typeof leaves)[number];
        // A text's paint hits anywhere in its frame, as the text itself does.
        const inside = (l: Leaf) => ctx.isPointInPath(l.path, x, y, l.fillRule);
        const paints = [
          ...fills.map(() => inside),
          ...strokes.map((s) => (l: Leaf) => {
            if (l.node.type === "text") return inside(l);
            ctx.lineWidth = Math.max(s.width, tolerance);
            return ctx.isPointInStroke(l.path, x, y);
          }),
        ];
        const paintsAt = (some: typeof paints) => {
          for (const p of some) for (const l of leaves) if (p(l)) hit(l.node);
        };
        if (inClip) paintsAt(paints.slice(0, contents));
        if (clip && painted.fills.length > 0 && (clip.type === "text" ? inFrame : inClip)) {
          hit(clip);
        }
        if (inClip) walk(n.id);
        if (clip?.type === "text") {
          if (inFrame && painted.strokes.length > 0) hit(clip);
        } else if (clip && painted.strokes.length > 0) {
          ctx.lineWidth = Math.max(widest(doc, clip), tolerance);
          if (ctx.isPointInStroke(outline(doc, clip), x, y)) hit(clip);
        }
        if (inClip) paintsAt(paints.slice(contents));
        if (n.id === scope && clip?.visible && !clip.locked && unpainted(clip)) {
          ctx.lineWidth = tolerance;
          const edge = clip.type === "text" ? frameOf(doc, clip) : outline(doc, clip);
          if (edge && ctx.isPointInStroke(edge, x, y)) hit(clip);
        }
      } else if (!("clipping" in n && n.clipping) && paintedAt(ctx, doc, n, x, y, tolerance)) {
        hit(n);
      }
    }
  };
  ctx.save();
  // The path and the point are both in document coordinates.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  walk(null);
  ctx.restore();
  const top = found as Node | null;
  return top && (leaf ? top.id : (objectOf(doc, top, scope)?.id ?? null));
}

const unpainted = (n: LeafNode) => n.appearance.fills.length + n.appearance.strokes.length === 0;

/** A text's frame, its bounds, as a path in document coordinates. */
function frameOf(doc: Document, t: TextNode): Path2D | null {
  const b = bounds(doc, t);
  if (!b) return null;
  const [x0, y0, x1, y1] = [b.x, b.y, b.x + b.width, b.y + b.height];
  return new Path2D(`M${x0} ${y0} L${x1} ${y0} L${x1} ${y1} L${x0} ${y1} Z`);
}

/**
 * Inside a Fill, or on the outline (painted or not, as Illustrator hits an unpainted Path); a
 * text anywhere inside its bounds; an Image anywhere inside its frame.
 */
function paintedAt(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  n: LeafNode | ImageNode,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  if (n.type === "text") {
    const b = bounds(doc, n);
    return !!b && b.x <= x && x <= b.x + b.width && b.y <= y && y <= b.y + b.height;
  }
  if (n.type === "image") return ctx.isPointInPath(outline(doc, n), x, y);
  const path = outline(doc, n);
  if (n.appearance.fills.length > 0 && ctx.isPointInPath(path, x, y, ruleOf(n))) return true;
  ctx.lineWidth = Math.max(widest(doc, n), tolerance);
  return ctx.isPointInStroke(path, x, y);
}

/** Inside a Clipping Path: its outline under its fill rule, or where a text's glyphs draw. */
const within = (ctx: CanvasRenderingContext2D, doc: Document, c: LeafClip, x: number, y: number) =>
  c.text
    ? glyphsAt(doc, c.text, x, y)
    : ctx.isPointInPath(new Path2D(formatPath(c.segments)), x, y, c.fillRule);

// ponytail: one pixel read back per test, exact to a document unit at any zoom; hit-test glyph
// outlines as Path2D once HarfBuzz draws text (F-TEXT-09).
let scratch: OffscreenCanvasRenderingContext2D | null | undefined;

/**
 * Whether a text's glyphs, drawn as the canvas draws them, cover (x, y) in document coordinates:
 * drawn into one scratch pixel centred on the point, its alpha read back (ADR-0052).
 */
function glyphsAt(doc: Document, t: TextNode, x: number, y: number): boolean {
  scratch ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  if (!scratch) return false;
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.clearRect(0, 0, 1, 1);
  scratch.setTransform(1, 0, 0, 1, 0.5 - x, 0.5 - y);
  drawClipGlyphs(scratch, t, worldTransform(doc, t));
  return (scratch.getImageData(0, 0, 1, 1).data[3] ?? 0) > 0;
}

/** A shape's widest Stroke, in document coordinates. */
const widest = (doc: Document, n: LeafNode) =>
  Math.max(0, ...n.appearance.strokes.map((s) => s.width)) * scaleOf(worldTransform(doc, n));

/** A shape's outline, or an Image's frame, in document coordinates. */
const outline = (doc: Document, n: ShapeNode | ImageNode) =>
  new Path2D(
    formatPath(
      transformSegments(
        shapeSegments(n.type === "image" ? frameShape(n) : n),
        worldTransform(doc, n),
      ),
    ),
  );

const ruleOf = (n: ShapeNode) =>
  n.type === "path" && n.fillRule === "evenodd" ? "evenodd" : "nonzero";

/** A click or marquee's `ids` applied to the Selection: replace; Shift toggles; Alt+Shift removes. */
export function combine(
  selection: string[],
  ids: string[],
  { shift, alt }: { shift: boolean; alt: boolean },
): string[] {
  if (!shift) return ids;
  const out = selection.filter((id) => !ids.includes(id));
  return alt ? out : [...out, ...ids.filter((id) => !selection.includes(id))];
}

/** The selectable objects, in the isolated Node `scope` if any, whose bounds touch `rect`. */
export function marquee(doc: Document, rect: Rect, scope: string | null): string[] {
  return objects(doc, scope)
    .filter((n) => {
      const b = bounds(doc, n);
      return !!b && touches(b, rect);
    })
    .map((n) => n.id);
}

export const inverse = (doc: Document, selection: string[], scope: string | null) =>
  objects(doc, scope)
    .map((n) => n.id)
    .filter((id) => !selection.includes(id));

/**
 * Object > Clipping Mask > Make on the Selection: the topmost selected Node clips the others, as
 * Illustrator picks it. Null without two editable Nodes; core rejects what cannot be clipped.
 */
export function maskInput(
  doc: Document,
  selection: string[],
): Extract<MaskInput, { clipNodeId: string }> | null {
  const ids = selection.filter((id) => editable(doc, doc.nodes.get(id)));
  if (ids.length < 2) return null;
  let clipNodeId = "";
  const walk = (parentId: string | null) => {
    for (const n of childrenOf(doc, parentId)) {
      if (ids.includes(n.id)) clipNodeId = n.id;
      walk(n.id);
    }
  };
  walk(null);
  return { clipNodeId, contentIds: ids.filter((id) => id !== clipNodeId) };
}

/** Object > Clipping Mask > Release on the Selection: its editable Clipping Masks and Clipping Paths. */
export const releasable = (doc: Document, selection: string[]) =>
  selection.filter((id) => {
    const n = doc.nodes.get(id);
    return !!n && editable(doc, n) && (("clipping" in n && n.clipping) || !!clippingPath(doc, n));
  });

/** Object > Relink… on the Selection: its one Image, however it is linked (ADR-0042). */
export function relinkable(doc: Document, selection: string[]): string | undefined {
  const [id, ...rest] = selection;
  return rest.length === 0 && doc.nodes.get(id ?? "")?.type === "image" ? id : undefined;
}

/**
 * Object > Embed on the Selection: its linked Images with pixels, not locked themselves or through
 * an ancestor; a hidden one embeds (ADR-0042).
 */
export const embeddable = (doc: Document, selection: string[]) =>
  selection.filter((id) => {
    const n = doc.nodes.get(id);
    return n?.type === "image" && n.file !== undefined && n.src !== undefined && !lockedIn(doc, n);
  });

/** Object > Shape > Expand Shape on the Selection: its editable Live Shapes (ADR-0032). */
export const expandable = (doc: Document, selection: string[]) =>
  selection.filter((id) => {
    const n = doc.nodes.get(id);
    return !!n && editable(doc, n) && isLiveShape(n);
  });

/**
 * Object > Path on the Selection: its editable paths and Live Shapes, and those inside its Groups,
 * as Illustrator applies a path command to a Group's paths.
 */
export function pathTargets(doc: Document, selection: string[]): string[] {
  const walk = (n: Node | undefined): string[] => {
    if (!n || !n.visible || n.locked) return [];
    if (n.type === "path" || isLiveShape(n)) return [n.id];
    return childrenOf(doc, n.id).flatMap(walk);
  };
  const ids = selection.filter((id) => editable(doc, doc.nodes.get(id)));
  return [...new Set(ids.flatMap((id) => walk(doc.nodes.get(id))))];
}
