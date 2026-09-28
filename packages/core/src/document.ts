import { generateKeyBetween } from "fractional-indexing";
import { ulid } from "ulid";
import type { z } from "zod";
import { parseColor } from "./color.ts";
import { collect, type Failed, ZibelError } from "./errors.ts";
import { fileProblem, MAX_FILE_LENGTH, preserveAspectRatio } from "./image.ts";
import { applyTo, IDENTITY, multiply, scaleOf, transformSegments } from "./matrix.ts";
import { formatPath, parsePath, pathBounds, type Segment, shapeSegments } from "./path.ts";
import {
  type Appearance,
  AppearanceInput,
  type Artboard,
  type ArtboardInput,
  type ChildInput,
  type ColorStop,
  type ContainerAppearance,
  type ContainerAppearanceInput,
  type Document,
  type Fill,
  type Gradient,
  type GroupNode,
  ImageShape,
  imageFrame,
  imagePixels,
  type LayerNode,
  type LeafNode,
  type Matrix,
  type Node,
  NodeInput,
  type NodeQuery,
  type Rect,
  Shape,
  type ShapeNode,
  type Stroke,
  type TextNode,
  TextShape,
  textFrame,
} from "./schema.ts";
import { canonicalRanges, textBox } from "./text.ts";

/** Server-generated ULID for Documents, Nodes, Artboards and Transactions. */
export const newId = () => ulid();

const ARTBOARD_GAP = 20;

const base = (parentId: string | null, index: string) => ({
  id: newId(),
  parentId,
  index,
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: "normal" as const,
  transform: [...IDENTITY] as Matrix,
  tags: [] as string[],
  meta: {} as Record<string, unknown>,
});

/** A new Document with its Artboards and one default Layer to draw into. */
export function createDocument(input: { id: string; name: string; artboards: ArtboardInput[] }): {
  doc: Document;
  defaultLayerId: string;
} {
  let nextX = 0;
  const artboards = input.artboards.map((a, i): Artboard => {
    const x = a.x ?? nextX;
    nextX = x + a.width + ARTBOARD_GAP;
    return {
      id: newId(),
      name: a.name ?? `Artboard ${i + 1}`,
      frame: { x, y: a.y ?? 0, width: a.width, height: a.height },
      ...(a.background !== undefined && {
        background: parseColor(a.background, `artboards[${i}].background`),
      }),
    };
  });
  const layer: LayerNode = {
    ...base(null, generateKeyBetween(null, null)),
    type: "layer",
    name: "Layer 1",
  };
  const doc: Document = {
    id: input.id,
    name: input.name,
    version: 1,
    rev: 0,
    artboards,
    nodes: new Map([[layer.id, layer]]),
    images: new Map(),
  };
  return { doc, defaultLayerId: layer.id };
}

/** Most Nodes one `node_create` may add, counting inline Group children (REQUIREMENTS §6.5). */
export const MAX_NODES_PER_CREATE = 2000;

const countNodes = (items: { children?: unknown[] }[]): number =>
  items.reduce(
    (n, item) => n + 1 + countNodes((item.children ?? []) as { children?: unknown[] }[]),
    0,
  );

interface Out {
  nodes: Node[];
  keyMap: Record<string, string>;
  /** Containers whose Appearance waits for their children. */
  painted: { node: LayerNode | GroupNode; appearance: ContainerAppearanceInput; path: string }[];
}

/**
 * Validates every input first, then adds all Nodes, so a bad item leaves the Document unchanged.
 * Returns the new Nodes depth first in input order (a Group before its inline children), and the
 * `clientKey` → id map for the WriteReceipt.
 */
export function createNodes(
  doc: Document,
  inputs: NodeInput[],
  { partial = false } = {},
): { nodes: Node[]; keyMap: Record<string, string>; failed: Failed[] } {
  const lastIndex = new Map<string | null, string | null>();
  const nextIndex = (parentId: string | null) => {
    const prev = lastIndex.has(parentId)
      ? (lastIndex.get(parentId) ?? null)
      : (childrenOf(doc, parentId).at(-1)?.index ?? null);
    const index = generateKeyBetween(prev, null);
    lastIndex.set(parentId, index);
    return index;
  };
  const add = (
    input: z.output<typeof NodeInput> | ChildInput,
    parentId: string | null,
    path: string,
    out: Out,
  ) => {
    const at = {
      ...base(parentId, nextIndex(parentId)),
      ...(input.tags && { tags: input.tags }),
      ...(input.meta && { meta: input.meta }),
    };
    const name = input.name ?? "";
    let node: Node;
    if (input.type === "layer" || input.type === "group") {
      const container: LayerNode | GroupNode = { ...at, type: input.type, name };
      // Painted once its inline children are in, so a gradient spans them (ADR-0043).
      if ("appearance" in input && input.appearance) {
        out.painted.push({
          node: container,
          appearance: input.appearance,
          path: `${path}.appearance`,
        });
      }
      node = container;
    } else if (input.type === "text") {
      const { ranges, ...parsed } = TextShape.superRefine(textFrame).parse(input);
      const canonical = canonicalRanges(ranges, `${path}.ranges`);
      // Measured with its ranges, so a default gradient spans the bounds they give.
      const text = { ...parsed, ...(canonical && { ranges: canonical }) };
      const appearance = paint(
        input.appearance ?? defaultTypeAppearance(),
        `${path}.appearance`,
        text,
      );
      node = { ...at, ...text, name, appearance };
    } else if (input.type === "image") {
      node = { ...at, ...imageOf(doc, input, path), name };
    } else {
      // Parsing with the Shape schema keeps the parameters and drops clientKey, name and the rest.
      const shape = Shape.parse(input);
      if (shape.type === "path") shape.d = formatPath(parsePath(shape.d, `${path}.d`));
      const appearance = paint(
        input.appearance ?? defaultAppearance(),
        `${path}.appearance`,
        shape,
      );
      node = { ...at, ...shape, name, appearance };
    }
    out.nodes.push(node);
    if (input.clientKey !== undefined) out.keyMap[input.clientKey] = node.id;
    if (input.type === "group") {
      input.children.forEach((child, k) => {
        if (child.type === "layer") {
          throw new ZibelError({
            code: "INVALID_PARENT",
            message: "A Group never contains a Layer.",
            hint: "Create the Layer on its own with a Layer id as parentId (or none for the root), then put Groups in it.",
            path: `${path}.children[${k}].type`,
          });
        }
        add(child, node.id, `${path}.children[${k}]`, out);
      });
    }
  };
  const count = countNodes(inputs as { children?: unknown[] }[]);
  if (count > MAX_NODES_PER_CREATE) {
    throw new ZibelError({
      code: "LIMIT_EXCEEDED",
      message: `${count} Nodes counting inline children; one node_create adds at most ${MAX_NODES_PER_CREATE}.`,
      hint: `Split into several node_create calls of at most ${MAX_NODES_PER_CREATE} Nodes each, e.g. one per Layer or Group: create the Group first, then its children with its id as parentId.`,
      path: "nodes",
    });
  }
  const { ok, failed } = collect(inputs, partial, (raw, i) => {
    // Each item collects into its own lists, so a failure halfway through a Group leaves no trace.
    const out: Out = { nodes: [], keyMap: {}, painted: [] };
    const input = NodeInput.parse(raw);
    assertParent(doc, input, input.parentId, `nodes[${i}].parentId`);
    add(input, input.parentId, `nodes[${i}]`, out);
    if (out.painted.length > 0) {
      const view = {
        ...doc,
        nodes: new Map([...doc.nodes, ...out.nodes.map((n) => [n.id, n] as const)]),
      };
      for (const { node, appearance, path } of out.painted) {
        node.appearance = paintContainer(appearance, path, () => bounds(view, node));
      }
    }
    return { nodes: out.nodes, keyMap: out.keyMap };
  });
  for (const item of ok) for (const node of item.nodes) doc.nodes.set(node.id, node);
  return {
    nodes: ok.flatMap((item) => item.nodes),
    keyMap: Object.assign({}, ...ok.map((item) => item.keyMap)),
    failed,
  };
}

/**
 * The tree rules (ADR-0005): a Layer's parent is the root or a Layer; every other Node's parent is a
 * Layer or Group; an Artboard is never a parent; no Node is its own ancestor.
 */
export function assertParent(
  doc: Document,
  child: { type: Node["type"]; id?: string },
  parentId: string | null,
  path: string,
): void {
  const invalid = (message: string, hint: string) =>
    new ZibelError({ code: "INVALID_PARENT", message, hint, path });
  if (parentId === null) {
    if (child.type === "layer") return;
    throw invalid(
      `A ${child.type} cannot sit at the Document root; only a Layer can.`,
      "Use a Layer id as parentId; doc_create returns the default Layer id.",
    );
  }
  const parent = doc.nodes.get(parentId);
  if (!parent) {
    if (doc.artboards.some((a) => a.id === parentId)) {
      throw invalid(
        "An Artboard is not a Node and cannot be a parent.",
        "Use a Layer id as parentId; position the Node inside the Artboard's frame instead.",
      );
    }
    throw new ZibelError({
      code: "NODE_NOT_FOUND",
      message: `No Node with id ${parentId}.`,
      hint: "Use doc_outline to list Layer ids; doc_create returns the default Layer id.",
      path,
    });
  }
  if (child.type === "layer" && parent.type !== "layer") {
    throw invalid(
      `A Layer's parent is the Document root or another Layer, never a ${parent.type}.`,
      "Omit parentId for a top-level Layer, or use a Layer id.",
    );
  }
  if (parent.type !== "layer" && parent.type !== "group") {
    throw invalid(
      `A ${parent.type} cannot contain other Nodes.`,
      "parentId must be a Layer or Group.",
    );
  }
  // A file can carry a cycle above the parent that never reaches the child (ADR-0016).
  const seen = new Set<string>();
  for (
    let p: Node | undefined = parent;
    p;
    p = p.parentId ? doc.nodes.get(p.parentId) : undefined
  ) {
    if (p.id === child.id) {
      throw invalid(
        "The parent is the Node itself or one of its descendants, which would make a cycle.",
        "Choose a parent outside this Node's subtree.",
      );
    }
    if (seen.has(p.id)) {
      throw invalid(
        `The parent's ancestors form a cycle through ${p.id}.`,
        "Every chain of parentId must end at a top-level Layer.",
      );
    }
    seen.add(p.id);
  }
}

/** Refuses a linked Image's `file` that cannot name a file (ADR-0042). */
export function checkFile(file: string, path: string) {
  const problem = fileProblem(file);
  if (!problem) return;
  throw new ZibelError({
    code: "INVALID_IMAGE",
    message: problem,
    hint: `file is the linked file's path or URL, at most ${MAX_FILE_LENGTH} characters; pass a data: URL as src.`,
    path,
  });
}

/** The stored image `src` names, which the Durable Object stored before the write (ADR-0023). */
export function imageInfo(doc: Document, src: string, path: string) {
  const info = doc.images.get(src);
  if (info) return info;
  throw new ZibelError({
    code: "INVALID_IMAGE",
    message: src.startsWith("data:")
      ? "The image's data: URL was not read into the Document."
      : `No image with id ${src} in the Document.`,
    hint: "src is a data: URL of a PNG, JPEG or GIF, or the id of an image already in the Document; node_get shows an Image's src id.",
    path,
  });
}

/** An Image's parameters, its `src` an id the Document holds (ADR-0023, ADR-0042). */
function imageOf(doc: Document, input: unknown, path: string) {
  const { src, file, width, height, ...rest } = ImageShape.superRefine(imageFrame)
    .superRefine(imagePixels)
    .parse(input);
  if (file !== undefined) checkFile(file, `${path}.file`);
  const info = src === undefined ? undefined : imageInfo(doc, src, `${path}.src`);
  return {
    ...rest,
    ...(src !== undefined && { src }),
    ...(file !== undefined && { file }),
    // imageFrame refused an Image with neither pixels nor a frame.
    width: width ?? info?.width ?? 0,
    height: height ?? info?.height ?? 0,
    // The schema refused anything this cannot spell.
    preserveAspectRatio: preserveAspectRatio(rest.preserveAspectRatio) ?? "none",
  };
}

/** Illustrator's basic appearance for a new shape, fresh per Node so no two share arrays. */
const defaultAppearance = () =>
  AppearanceInput.parse({ fills: [{ color: "#FFFFFF" }], strokes: [{ color: "#000000" }] });

/** Illustrator's default for new type: a black Fill and no Stroke. */
const defaultTypeAppearance = () => AppearanceInput.parse({ fills: [{ color: "#000000" }] });

const r3 = (n: number) => Math.round(n * 1000) / 1000 || 0;
const point = (x: number, y: number) => ({ x: r3(x), y: r3(y) });

/** Geometric bounds in a leaf's own coordinates, before its transform. */
const ownBounds = (leaf: Shape | TextShape): Rect =>
  (leaf.type === "text" ? textBox(leaf) : pathBounds(shapeSegments(leaf))) ?? {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };

/**
 * The gradient with the geometry left out filled in from `box`, a leaf's own bounds or a
 * container's geometric bounds (ADR-0026, ADR-0043); null is no bounds, which needs full geometry.
 */
function placed(
  g: z.output<typeof Gradient>,
  stops: ColorStop[],
  box: () => Rect | null,
  at: string,
): Gradient {
  if (g.type === "linear" && g.start && g.end) {
    return { type: "linear", stops, start: g.start, end: g.end };
  }
  let measured: Rect | undefined;
  const own = () => {
    measured ??= box() ?? undefined;
    if (measured) return measured;
    throw new ZibelError({
      code: "INVALID_INPUT",
      message:
        "The gradient leaves out its geometry, and the Layer or Group has no bounds to span.",
      hint: "Give start and end (linear) or center and radius (radial) in document coordinates, or add children first.",
      path: `${at}.gradient`,
    });
  };
  const middle = () => point(own().x + own().width / 2, own().y + own().height / 2);
  if (g.type === "linear") {
    const { x: cx, y: cy } = middle();
    const { width, height } = own();
    const t = ((g.angle ?? 0) * Math.PI) / 180;
    const [ux, uy] = [Math.cos(t), Math.sin(t)];
    // Half the bounds' extent along the direction, so the stops touch opposite sides.
    const extent = (Math.abs(width * ux) + Math.abs(height * uy)) / 2;
    const half = extent > 1e-9 ? extent : 0.5;
    const start = point(cx - half * ux, cy - half * uy);
    return { type: "linear", stops, start, end: point(cx + half * ux, cy + half * uy) };
  }
  const { aspectRatio, angle } = g;
  const center = g.center ?? middle();
  // Illustrator's default: half the width on a square.
  const radius = g.radius ?? (r3(Math.sqrt((own().width ** 2 + own().height ** 2) / 8)) || 1);
  let focus = g.focus ?? center;
  // A focus outside the ellipse moves onto it, as SVG 1.1 does, so every renderer agrees.
  const t = (angle * Math.PI) / 180;
  const dx = focus.x - center.x;
  const dy = focus.y - center.y;
  const reach = Math.hypot(
    (dx * Math.cos(t) + dy * Math.sin(t)) / radius,
    (dy * Math.cos(t) - dx * Math.sin(t)) / (radius * aspectRatio),
  );
  if (reach > 1) focus = point(center.x + dx / reach, center.y + dy / reach);
  return { type: "radial", stops, center, radius, aspectRatio, angle, focus };
}

/**
 * A radial gradient's ellipse as a matrix mapping its circle of `radius` about `center` onto it:
 * turned by `angle`, scaled by `aspectRatio` across it. SVG's `gradientTransform`; undefined for a
 * circle.
 */
export function ellipseMatrix(g: Extract<Gradient, { type: "radial" }>): Matrix | undefined {
  if (g.angle === 0 && g.aspectRatio === 1) return undefined;
  const t = (g.angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const { x, y } = g.center;
  return multiply(
    [cos, sin, -sin * g.aspectRatio, cos * g.aspectRatio, x, y],
    [1, 0, 0, 1, -x, -y],
  );
}

/**
 * The gradient in the space `m` maps its own space into, at 3 decimals. A linear gradient stays
 * linear, its end recomputed so the stops keep their places; a radial one becomes an ellipse, its
 * focus mapped.
 */
export function mapGradient(g: Gradient, m: Matrix): Gradient {
  if (g.type === "linear") {
    const [a, b, c, d] = m;
    const [dx, dy] = [g.end.x - g.start.x, g.end.y - g.start.y];
    // The gradient's direction goes through the inverse transpose; its length through 1 / |g|².
    const det = a * d - b * c;
    const len = dx * dx + dy * dy;
    const [gx, gy] = [(d * dx - b * dy) / det / len, (a * dy - c * dx) / det / len];
    const [sx, sy] = applyTo(m, g.start.x, g.start.y);
    const g2 = gx * gx + gy * gy;
    return {
      type: "linear",
      stops: g.stops,
      start: point(sx, sy),
      end: point(sx + gx / g2, sy + gy / g2),
    };
  }
  // The circle of `radius` about `center`, through the ellipse and then `m`.
  const e = ellipseMatrix(g);
  const [a, b, c, d] = e ? multiply(m, e) : m;
  let angle: number;
  let major: number;
  let minor: number;
  if (Math.abs(a * c + b * d) < 1e-5 * (a * a + b * b + c * c + d * d)) {
    // Columns at right angles, as a move, turn and scale make, and Zibel's own export: the ellipse's
    // axes are the images of the circle's, so the radius stays along the first.
    angle = Math.atan2(b, a);
    major = Math.hypot(a, b);
    minor = Math.hypot(c, d);
  } else {
    // A skew: the axes from the singular value decomposition.
    const [p, f, h, k] = [(a + d) / 2, (a - d) / 2, (b + c) / 2, (b - c) / 2];
    const [q, r] = [Math.hypot(p, k), Math.hypot(f, h)];
    angle = (Math.atan2(h, f) + Math.atan2(k, p)) / 2;
    major = q + r;
    minor = Math.abs(q - r);
  }
  const degrees = (((angle * 180) / Math.PI) % 360) + 360;
  return {
    type: "radial",
    stops: g.stops,
    center: point(...applyTo(m, g.center.x, g.center.y)),
    radius: r3(g.radius * major),
    aspectRatio: r3(minor / major),
    angle: r3(degrees % 360),
    focus: point(...applyTo(m, g.focus.x, g.focus.y)),
  };
}

/** The paint with its gradient, if it has one, mapped through `m`. */
export const mapPaint = <P extends Fill>(p: P, m: Matrix): P =>
  p.type === "gradient" ? ({ ...p, gradient: mapGradient(p.gradient, m) } as P) : p;

/** Parses the colours, fills in `type` and every gradient's geometry, and sorts its stops. */
export const paint = (a: AppearanceInput, path: string, leaf: Shape | TextShape): Appearance =>
  paintOn(a, path, () => ownBounds(leaf));

function paintOn(a: AppearanceInput, path: string, box: () => Rect | null): Appearance {
  const one = <T extends AppearanceInput["fills" | "strokes"][number]>(p: T, at: string) => {
    if (p.type !== "gradient") {
      return { ...p, type: "solid", color: parseColor(p.color, `${at}.color`) };
    }
    const stops = p.gradient.stops
      .map((s, k) => ({ ...s, color: parseColor(s.color, `${at}.gradient.stops[${k}].color`) }))
      .sort((s, t) => s.offset - t.offset);
    return { ...p, gradient: placed(p.gradient, stops, box, at) };
  };
  return {
    fills: a.fills.map((f, i) => one(f, `${path}.fills[${i}]`) as Fill),
    strokes: a.strokes.map((s, i) => one(s, `${path}.strokes[${i}]`) as Stroke),
  };
}

/**
 * A Layer's or Group's Appearance as stored (ADR-0043): its colours parsed, `contents` inside the
 * stack, a gradient's geometry left out filled in from `box`, the container's geometric bounds, in
 * document coordinates.
 */
export function paintContainer(
  a: ContainerAppearanceInput,
  path: string,
  box: () => Rect | null,
): ContainerAppearance {
  const count = a.fills.length + a.strokes.length;
  if (!Number.isInteger(a.contents) || a.contents < 0 || a.contents > count) {
    throw new ZibelError({
      code: "INVALID_INPUT",
      message: `contents is ${a.contents}, outside 0 to ${count}, the number of fills and strokes.`,
      hint: "contents counts the paints drawn below the children, from the first Fill up through the Strokes: 0 puts every paint above them.",
      path: `${path}.contents`,
    });
  }
  return { ...paintOn(a, path, box), contents: a.contents };
}

type FillRule = "nonzero" | "evenodd";

/** A Live Shape, Path or text a container paints, with its outline in document coordinates. */
export interface PaintedLeaf {
  node: ShapeNode | TextNode;
  /** A shape's outline; a text's frame, since its glyphs paint and have no outline (F-TEXT-06). */
  segments: Segment[];
  fillRule: FillRule;
  /** The Clipping Paths of the inner Clipping Masks it sits in, outermost first (ADR-0021). */
  clips: LeafClip[];
}

/**
 * An inner Clipping Mask's clip: a shape's outline under its fill rule, or a text, which clips by
 * the glyphs it draws (ADR-0052) and whose `segments` are only its frame, for bounds.
 */
export type LeafClip = { maskId: string; segments: Segment[] } & (
  | { fillRule: FillRule; text?: undefined }
  | { text: TextNode }
);

const worldFrame = (doc: Document, n: TextNode) =>
  transformSegments(shapeSegments(frameShape(textBox(n))), worldTransform(doc, n));

const worldOutline = (
  doc: Document,
  n: ShapeNode,
): { segments: Segment[]; fillRule: FillRule } => ({
  segments: transformSegments(shapeSegments(n), worldTransform(doc, n)),
  fillRule: n.type === "path" && n.fillRule === "evenodd" ? "evenodd" : "nonzero",
});

/** A Clipping Mask's Clipping Path as the clip of the leaves inside it. */
export const leafClip = (doc: Document, maskId: string, clip: LeafNode): LeafClip =>
  clip.type === "text"
    ? { maskId, segments: worldFrame(doc, clip), text: clip }
    : { maskId, ...worldOutline(doc, clip) };

/**
 * The leaves a container's Appearance paints (ADR-0043): its descendant Live Shapes, Paths and
 * texts, depth first in stacking order, each under the clip of every inner Clipping Mask it is in.
 * Hidden Nodes and subtrees, Images and Clipping Paths get none.
 */
export function paintedLeaves(
  doc: Document,
  container: Node,
  clips: PaintedLeaf["clips"] = [],
): PaintedLeaf[] {
  return childrenOf(doc, container.id).flatMap((n): PaintedLeaf[] => {
    if (!n.visible || n.type === "image") return [];
    if (n.type === "layer" || n.type === "group") {
      const clip = clippingPath(doc, n);
      const inner = clip ? [...clips, leafClip(doc, n.id, clip)] : clips;
      return paintedLeaves(doc, n, inner);
    }
    if (n.clipping) return [];
    if (n.type === "text")
      return [{ node: n, segments: worldFrame(doc, n), fillRule: "nonzero", clips }];
    return [{ node: n, ...worldOutline(doc, n), clips }];
  });
}

/**
 * A container Stroke as a leaf drawn at `scale` must draw it: its width and dash are in document
 * units, which the leaf's own transform would grow (ADR-0043).
 */
export const unscaledStroke = (s: Stroke, scale: number): Stroke =>
  scale === 1 ? s : { ...s, width: s.width / scale, dash: s.dash.map((d) => d / scale) };

/** A container's Appearance, empty when it has none. */
export const containerAppearance = (n: LayerNode | GroupNode): ContainerAppearance =>
  n.appearance ?? { fills: [], strokes: [], contents: 0 };

// ponytail: scans every Node per lookup; keep a parent index beside the map when Documents grow.
export function childrenOf(doc: Document, parentId: string | null): Node[] {
  return [...doc.nodes.values()]
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
}

/** Locked, or inside a locked Layer or Group. */
export const lockedIn = (doc: Document, node: Node | undefined): boolean =>
  !!node &&
  (node.locked || lockedIn(doc, node.parentId ? doc.nodes.get(node.parentId) : undefined));

const clipAmong = (children: Node[]) =>
  children.find((c): c is LeafNode => "clipping" in c && c.clipping === true);

/** The Layer's or Group's Clipping Path, which makes it a Clipping Mask (ADR-0021, ADR-0053). */
export function clippingPath(doc: Document, node: Node): LeafNode | undefined {
  return node.type === "layer" || node.type === "group"
    ? clipAmong(childrenOf(doc, node.id))
    : undefined;
}

/** A frame as the rect Live Shape that outlines it: an Image's, or a text's box. */
export const frameShape = (r: Rect) => ({
  type: "rect" as const,
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
  radius: 0,
});

/** Geometric bounds in document coordinates (no stroke), or null for an empty container. */
export function bounds(doc: Document, node: Node): Rect | null {
  if (node.type === "layer" || node.type === "group") {
    const children = childrenOf(doc, node.id);
    const clip = clipAmong(children);
    return clip ? bounds(doc, clip) : union(children.map((c) => bounds(doc, c)));
  }
  const shape =
    node.type === "text"
      ? frameShape(textBox(node))
      : node.type === "image"
        ? frameShape(node)
        : node;
  return pathBounds(transformSegments(shapeSegments(shape), worldTransform(doc, node)));
}

/**
 * Geometric bounds grown by half the widest Stroke, for a leaf; the union of its children's, for a
 * container; its Clipping Path's, as a leaf's, for a Clipping Mask (ADR-0051).
 */
export function visibleBounds(doc: Document, node: Node): Rect | null {
  if (node.type === "layer" || node.type === "group") {
    const children = childrenOf(doc, node.id);
    // Everything else is clipped, and the Clipping Path's Strokes draw unclipped.
    const clip = clipAmong(children);
    if (clip) return visibleBounds(doc, clip);
    const grow = Math.max(0, ...containerAppearance(node).strokes.map((s) => s.width)) / 2;
    // A leaf inside an inner Clipping Mask paints only within its Clipping Paths.
    const painted =
      grow > 0
        ? paintedLeaves(doc, node).map((l) =>
            l.clips.reduce(
              (b, c) => intersection(b, pathBounds(c.segments)),
              grown(pathBounds(l.segments), grow),
            ),
          )
        : [];
    return union([...children.map((c) => visibleBounds(doc, c)), ...painted]);
  }
  const b = bounds(doc, node);
  if (node.type === "image") return b;
  // ponytail: half the Stroke width on every side, scaled by sqrt|det|; miter spikes, square caps
  // and non-uniform scale can reach further.
  const grow =
    (Math.max(0, ...node.appearance.strokes.map((s) => s.width)) / 2) *
    scaleOf(worldTransform(doc, node));
  return grown(b, grow);
}

const intersection = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right < x || bottom < y ? null : { x, y, width: right - x, height: bottom - y };
};

/** `b` grown by `by` on every side. */
export const grown = (b: Rect | null, by: number): Rect | null =>
  b && { x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by };

/**
 * The Node's transform composed with every ancestor's, mapping its coordinates to the Document's.
 * Containers stay identity (ADR-0007), so this equals a leaf's own transform; composing keeps it
 * correct should a container ever carry one.
 */
export function worldTransform(doc: Document, node: Node): Matrix {
  const parent = node.parentId ? doc.nodes.get(node.parentId) : undefined;
  return parent ? multiply(worldTransform(doc, parent), node.transform) : node.transform;
}

function outlineOf(node: ShapeNode): { d: string; closed: boolean } {
  const segments = shapeSegments(node);
  return { d: formatPath(segments), closed: segments.at(-1)?.cmd === "Z" };
}

export interface ConciseView {
  id: string;
  type: Node["type"];
  name: string;
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  childCount: number;
  geometricBounds: Rect | null;
}

/** Every stored property, the derived `d` of a Live Shape or Path, and the derived bounds (F-DOC-03a). */
export type FullView = Node &
  ConciseView & {
    d?: string;
    closed?: boolean;
    visibleBounds: Rect | null;
    worldTransform: Matrix;
  };

/** A Node as `node_get` returns it. */
export function nodeView(doc: Document, node: Node, detail: "concise"): ConciseView;
export function nodeView(doc: Document, node: Node, detail: "full"): FullView;
export function nodeView(
  doc: Document,
  node: Node,
  detail: "concise" | "full",
): ConciseView | FullView;
export function nodeView(doc: Document, node: Node, detail: "concise" | "full") {
  const { id, type, name, parentId, visible, locked } = node;
  const concise: ConciseView = {
    id,
    type,
    name,
    parentId,
    visible,
    locked,
    childCount: childrenOf(doc, id).length,
    geometricBounds: bounds(doc, node),
  };
  if (detail === "concise") return concise;
  return {
    ...node,
    ...((node.type === "layer" || node.type === "group") && {
      appearance: containerAppearance(node),
    }),
    ...concise,
    // A text has no outline until Create Outlines (F-TEXT-06).
    ...(node.type !== "layer" &&
      node.type !== "group" &&
      node.type !== "text" &&
      node.type !== "image" &&
      outlineOf(node)),
    visibleBounds: visibleBounds(doc, node),
    worldTransform: worldTransform(doc, node),
  };
}

export interface OutlineNode {
  id: string;
  type: Node["type"];
  name: string;
  /** Left out with `includeBounds: false`. */
  bounds?: Rect | null;
  childCount: number;
  visible: boolean;
  locked: boolean;
  children?: OutlineNode[];
}

export interface OutlineOptions {
  /** Its children are the top level; omitted, the Layer list is. */
  rootId?: string;
  /** Levels from the top level, which is level 1. */
  depth?: number;
  /** Keep an entry of these types or above one within `depth` (ADR-0015). */
  types?: Node["type"][];
  includeBounds?: boolean;
}

/** Sparse tree whose top level is the Layer list, or `rootId`'s children. */
export function outline(
  doc: Document,
  { rootId, depth = 2, types, includeBounds = true }: OutlineOptions = {},
): OutlineNode[] {
  if (rootId !== undefined && !doc.nodes.has(rootId)) {
    throw new ZibelError({
      code: "NODE_NOT_FOUND",
      message: `No Node with id ${rootId}.`,
      hint: "Use an id from doc_outline without rootId, or from a WriteReceipt.",
      path: "rootId",
    });
  }
  const walk = (parentId: string | null, level: number): OutlineNode[] =>
    childrenOf(doc, parentId).flatMap((n) => {
      const kids = childrenOf(doc, n.id);
      const children = kids.length > 0 && level < depth ? walk(n.id, level + 1) : undefined;
      const kept =
        !types || types.includes(n.type) || (children?.length ?? 0) > 0 || (!rootId && level === 1);
      if (!kept) return [];
      return {
        id: n.id,
        type: n.type,
        name: n.name,
        ...(includeBounds && { bounds: bounds(doc, n) }),
        childCount: kids.length,
        visible: n.visible,
        locked: n.locked,
        ...(children && { children }),
      };
    });
  return walk(rootId ?? null, 1);
}

/**
 * The Nodes matching every filter of `q`, sorted by id, one page at a time: `nextCursor` is the
 * last id returned while more follow (ADR-0015).
 */
// ponytail: scans every Node per call; a spatial index when Documents grow.
export function queryNodes(
  doc: Document,
  { types, nameRegex, tags, parentId, withinRect, intersectsRect, limit = 100, cursor }: NodeQuery,
): { nodes: ConciseView[]; nextCursor: string | null } {
  const name = nameRegex === undefined ? undefined : new RegExp(nameRegex);
  const matches = [...doc.nodes.values()]
    .filter(
      (n) =>
        (cursor === undefined || n.id > cursor) &&
        (!types || types.includes(n.type)) &&
        (!name || name.test(n.name)) &&
        (!tags || tags.every((t) => n.tags.includes(t))) &&
        (parentId === undefined || n.parentId === parentId),
    )
    .filter((n) => {
      if (!withinRect && !intersectsRect) return true;
      const b = bounds(doc, n);
      return (
        !!b &&
        (!withinRect || inside(b, withinRect)) &&
        (!intersectsRect || touches(b, intersectsRect))
      );
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const page = matches.slice(0, limit);
  return {
    nodes: page.map((n) => nodeView(doc, n, "concise")),
    nextCursor: matches.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

const inside = (a: Rect, outer: Rect) =>
  outer.x <= a.x &&
  outer.y <= a.y &&
  a.x + a.width <= outer.x + outer.width &&
  a.y + a.height <= outer.y + outer.height;

/** Whether two rects overlap or touch, edges included. */
export const touches = (a: Rect, b: Rect) =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

export function union(rects: (Rect | null)[]): Rect | null {
  const rs = rects.filter((r): r is Rect => r !== null);
  if (rs.length === 0) return null;
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  const right = Math.max(...rs.map((r) => r.x + r.width));
  const bottom = Math.max(...rs.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}
