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
  type LeafNode,
  lockedIn,
  type MaskInput,
  type Node,
  paintedLeaves,
  type Rect,
  type ShapeNode,
  scaleOf,
  shapeSegments,
  touches,
  transformSegments,
  worldTransform,
} from "@zibel/core";

/**
 * What Illustrator's Selection tool picks for `node`: its outermost ancestor below a Layer, so a
 * click inside a Group selects the Group. Null for a Layer.
 */
export function objectOf(doc: Document, node: Node): Node | null {
  if (node.type === "layer") return null;
  let object = node;
  for (let p = doc.nodes.get(node.parentId ?? ""); p && p.type !== "layer"; ) {
    object = p;
    p = doc.nodes.get(p.parentId ?? "");
  }
  return object;
}

/**
 * Where Place puts pasted or dropped art (ADR-0017): the nearest Layer holding the first selected
 * Node, else the top Layer.
 */
export function placeParent(doc: Document, selection: string[]): string | undefined {
  for (let n = doc.nodes.get(selection[0] ?? ""); n; n = doc.nodes.get(n.parentId ?? "")) {
    if (n.type === "layer") return n.id;
  }
  return childrenOf(doc, null).at(-1)?.id;
}

/**
 * Every selectable object (visible and unlocked, as is everything above it) in the Document, or in
 * the Layer `layerId`, in draw order.
 */
export function objects(doc: Document, layerId: string | null = null): Node[] {
  const walk = (parentId: string | null): Node[] =>
    childrenOf(doc, parentId).flatMap((n) => {
      if (!n.visible || n.locked) return [];
      return n.type === "layer" ? walk(n.id) : [n];
    });
  return walk(layerId);
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
 * picks. Hidden and locked Nodes let the click through.
 */
export function hitTest(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  x: number,
  y: number,
  tolerance: number,
  leaf = false,
): string | null {
  let hit: Node | null = null;
  const walk = (parentId: string | null) => {
    for (const n of childrenOf(doc, parentId)) {
      if (!n.visible || n.locked) continue;
      if (n.type === "layer" || n.type === "group") {
        // Outside its Clipping Path, a Clipping Mask draws only that path's Strokes (ADR-0051).
        const clip = clippingPath(doc, n);
        const inClip = !clip || ctx.isPointInPath(outline(doc, clip), x, y, ruleOf(clip));
        // A painted Clipping Path hits as a leaf does, its Fill anywhere it clips.
        const painted = clip && !clip.locked ? clip.appearance : { fills: [], strokes: [] };
        const stroked = () => {
          if (!clip || painted.strokes.length === 0) return false;
          ctx.lineWidth = Math.max(widest(doc, clip), tolerance);
          return ctx.isPointInStroke(outline(doc, clip), x, y);
        };
        // Its Appearance hits as the leaf it paints, in draw order around the children
        // (ADR-0043); a leaf locked below it, or a point outside the leaf's inner Clipping Masks,
        // lets the click through.
        const { fills, strokes, contents } = containerAppearance(n);
        const leaves =
          fills.length + strokes.length > 0
            ? paintedLeaves(doc, n)
                .filter((l) => !lockedIn(doc, l.node))
                .filter((l) =>
                  l.clips.every((c) =>
                    ctx.isPointInPath(new Path2D(formatPath(c.segments)), x, y, c.fillRule),
                  ),
                )
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
          for (const p of some) for (const l of leaves) if (p(l)) hit = l.node;
        };
        if (inClip) {
          paintsAt(paints.slice(0, contents));
          if (painted.fills.length > 0) hit = clip ?? hit;
          walk(n.id);
        }
        if (stroked()) hit = clip ?? hit;
        if (inClip) paintsAt(paints.slice(contents));
      } else if (!("clipping" in n && n.clipping) && paintedAt(ctx, doc, n, x, y, tolerance)) {
        hit = n;
      }
    }
  };
  ctx.save();
  // The path and the point are both in document coordinates.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  walk(null);
  ctx.restore();
  return hit && (leaf ? (hit as Node).id : (objectOf(doc, hit)?.id ?? null));
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

/** The selectable objects whose bounds touch `rect`. */
export function marquee(doc: Document, rect: Rect): string[] {
  return objects(doc)
    .filter((n) => {
      const b = bounds(doc, n);
      return !!b && touches(b, rect);
    })
    .map((n) => n.id);
}

export const inverse = (doc: Document, selection: string[]) =>
  objects(doc)
    .map((n) => n.id)
    .filter((id) => !selection.includes(id));

/**
 * Object > Clipping Mask > Make on the Selection: the topmost selected Node clips the others, as
 * Illustrator picks it. Null without two editable Nodes; core rejects what cannot be clipped.
 */
export function maskInput(doc: Document, selection: string[]): MaskInput | null {
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
