import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { z } from "zod";
import {
  type Anchor,
  AnchorRef,
  convertedWarning,
  editSubpaths,
  fromAnchors,
  isLiveShape,
  type LiveShape,
  type PathNode,
  type Subpath,
  toAnchors,
  toPath,
  withAnchors,
} from "./anchor.ts";
import {
  bounds,
  childrenOf,
  createNodes,
  isOpacityMask,
  MAX_NODES_PER_CREATE,
  mapPaint,
  newId,
  paintOrder,
  worldOutline,
  worldTransform,
} from "./document.ts";
import { deleteNodes, lookup, outermost } from "./edit.ts";
import { KalamoError } from "./errors.ts";
import { simplifySubpath } from "./fit.ts";
import { frameEdges } from "./frame.ts";
import { applyTo, IDENTITY, invert, multiply, scaleOf, transformSegments } from "./matrix.ts";
import { formatPath, parsePath, pathBounds, type Segment, shapeSegments } from "./path.ts";
import type {
  Appearance,
  Document,
  Fill,
  GroupNode,
  Matrix,
  Node,
  Rect,
  ShapeNode,
  Stroke,
  WriteReceipt,
} from "./schema.ts";

type Point = [number, number];

/** Illustrator's Pathfinder Shape Modes, expanded (ADR-0104). */
export const SHAPE_MODES = ["unite", "minus_front", "intersect", "exclude"] as const;

/** Illustrator's Pathfinders built so far, which combine as the Shape Modes do (ADR-0104). */
export const PATHFINDERS = ["minus_back"] as const;

/** Object > Compound Path's Make and Release (ADR-0107). */
export const COMPOUND_PATH = ["make_compound_path", "release_compound_path"] as const;

/**
 * `path_op` (REQUIREMENTS §6.4) so far: convert_to_path (Object > Shape > Expand Shape), reverse
 * (Reverse Path Direction), add_anchors (Add Anchor Points), join (Join), average (Average),
 * simplify (Simplify), outline_stroke (Outline Stroke), offset (Offset Path), divide_below (Divide
 * Objects Below), split_into_grid (Split Into Grid), clean_up (Clean Up) and the Pathfinder Shape
 * Modes unite, minus_front, intersect and exclude and the Pathfinder minus_back (ADR-0104), and
 * Compound Path make_compound_path and release_compound_path (ADR-0107).
 */
export const PathOpInput = z.strictObject({
  nodeIds: z
    .array(z.string())
    .max(1000)
    .default([])
    .describe("Every op but clean_up, which acts on the whole Document, needs at least one."),
  op: z.enum([
    "convert_to_path",
    "reverse",
    "add_anchors",
    "join",
    "average",
    "simplify",
    "outline_stroke",
    "offset",
    "divide_below",
    "split_into_grid",
    "clean_up",
    ...SHAPE_MODES,
    ...PATHFINDERS,
    ...COMPOUND_PATH,
  ]),
  tolerance: z
    .number()
    .min(0)
    .optional()
    .describe(
      "In document units. join: Endpoints this close merge into one Anchor, farther ones get a straight segment; default 0.01. simplify: the most the result may stray from the path, above 0; default 1.",
    ),
  cornerAngle: z
    .number()
    .min(0)
    .max(180)
    .default(90)
    .describe(
      "simplify: Illustrator's Corner Point Angle Threshold in degrees. Where the path turns so that the angle between its two sides is at most this (180 is straight on), a Corner Anchor stays one; higher keeps more. A Smooth Anchor never becomes a corner.",
    ),
  toLines: z
    .boolean()
    .default(false)
    .describe(
      "simplify: Convert to Straight Lines: straight segments between original Anchors, keeping those the path needs to stay within tolerance.",
    ),
  axis: z
    .enum(["horizontal", "vertical", "both"])
    .default("both")
    .describe(
      "average: horizontal lines the Anchors up on one y, vertical on one x, both stacks them.",
    ),
  distance: z
    .number()
    .finite()
    .optional()
    .describe(
      "offset: Illustrator's Offset, in document units; required. Positive grows the path, negative shrinks it.",
    ),
  join: z
    .enum(["miter", "round", "bevel"])
    .default("miter")
    .describe("offset: Illustrator's Joins, how the offset turns at a corner."),
  miterLimit: z
    .number()
    .min(1)
    .default(4)
    .describe(
      "offset: past this many times the distance, a miter corner is beveled instead, as a Stroke's.",
    ),
  rows: z.number().int().min(1).default(2).describe("split_into_grid: rows of rectangles."),
  cols: z.number().int().min(1).default(2).describe("split_into_grid: columns of rectangles."),
  gutter: z
    .number()
    .min(0)
    .default(0)
    .describe("split_into_grid: the gap between rows and between columns, in document units."),
  totalWidth: z
    .number()
    .positive()
    .optional()
    .describe(
      "split_into_grid: Illustrator's Columns Total, the grid's width from the shape's left; default the shape's width.",
    ),
  totalHeight: z
    .number()
    .positive()
    .optional()
    .describe(
      "split_into_grid: Illustrator's Rows Total, the grid's height from the shape's top; default the shape's height.",
    ),
  strayPoints: z
    .boolean()
    .default(true)
    .describe("clean_up: remove Stray Points, subpaths of one Anchor."),
  unpainted: z
    .boolean()
    .default(true)
    .describe("clean_up: remove Live Shapes and paths with no Fill and no Stroke."),
  emptyText: z
    .boolean()
    .default(true)
    .describe("clean_up: remove texts whose content is only spaces and hard returns."),
  anchors: z
    .array(AnchorRef)
    .max(10000)
    .optional()
    .describe(
      "join and average: the Anchors to act on, each of a Node in nodeIds. join takes two open Endpoints; omitted, join takes the whole paths and average every Anchor of nodeIds.",
    ),
});
export type PathOpInput = z.input<typeof PathOpInput>;

/**
 * Each `path_op`'s name: `menu` as the browser's Object menu shows it (an ellipsis when it opens a
 * dialog), `summary` for its Transaction in history and Undo.
 */
export const PATH_OP_TEXT: Record<PathOpInput["op"], { menu: string; summary: string }> = {
  convert_to_path: { menu: "Expand Shape", summary: "Convert to Path" },
  reverse: { menu: "Reverse Path Direction", summary: "Reverse Path Direction" },
  add_anchors: { menu: "Add Anchor Points", summary: "Add Anchor Points" },
  join: { menu: "Join", summary: "Join" },
  average: { menu: "Average…", summary: "Average" },
  simplify: { menu: "Simplify…", summary: "Simplify" },
  outline_stroke: { menu: "Outline Stroke", summary: "Outline Stroke" },
  offset: { menu: "Offset Path…", summary: "Offset Path" },
  divide_below: { menu: "Divide Objects Below", summary: "Divide Objects Below" },
  split_into_grid: { menu: "Split Into Grid…", summary: "Split Into Grid" },
  clean_up: { menu: "Clean Up…", summary: "Clean Up" },
  unite: { menu: "Unite", summary: "Unite" },
  minus_front: { menu: "Minus Front", summary: "Minus Front" },
  intersect: { menu: "Intersect", summary: "Intersect" },
  exclude: { menu: "Exclude", summary: "Exclude" },
  minus_back: { menu: "Minus Back", summary: "Minus Back" },
  make_compound_path: { menu: "Make", summary: "Make Compound Path" },
  release_compound_path: { menu: "Release", summary: "Release Compound Path" },
};

export type ShapeMode = (typeof SHAPE_MODES)[number];
/** The ops that combine their operands into one path: the Shape Modes and the Pathfinders. */
export const COMBINING = [...SHAPE_MODES, ...PATHFINDERS] as const;
/** A Shape Mode or a Pathfinder that combines like one. */
export type Combining = (typeof COMBINING)[number];
const isCombining = (op: string): op is Combining => (COMBINING as readonly string[]).includes(op);

/** How a Stroke is drawn along its path, without its paint. */
export type StrokeStyle = Pick<Stroke, "width" | "cap" | "join" | "miterLimit" | "dash">;

/** How Offset Path grows or shrinks a path's fill. */
export type OffsetStyle = Pick<Stroke, "join" | "miterLimit"> &
  Pick<PathNode, "fillRule"> & {
    /** Negative shrinks. */
    distance: number;
  };

/** A fill in document coordinates. */
export type Filled = { segments: Segment[]; fillRule: PathNode["fillRule"] };

/**
 * The path geometry core needs but does not compute: Skia's, which `@kalamo/geometry` loads
 * (ADR-0034).
 */
export interface Geometry {
  /**
   * The area `stroke` paints along `segments`, dashes included, to fill under nonzero; in the
   * path's own coordinates.
   */
  outlineStroke(segments: Segment[], stroke: StrokeStyle): Segment[];
  /** The fill of `segments` offset by `style.distance`, no segments when it shrinks away. */
  offsetPath(segments: Segment[], style: OffsetStyle): Segment[];
  /** `target`'s fill inside `cutter`'s and outside it, each no segments when empty. */
  divide(target: Filled, cutter: Filled): { inside: Segment[]; outside: Segment[] };
  /**
   * `operands`, back to front, combined by the Shape Mode, no segments when empty. Holes wind
   * against their outlines, so all but exclude fill the same under nonzero.
   */
  combine(op: ShapeMode, operands: Filled[]): Segment[];
}

const invalid = (path: string, message: string, hint: string) =>
  new KalamoError({ code: "INVALID_PATH", message, hint, path });

/** The paths and Live Shapes `nodeIds` names, each once. */
function allWithAnchors(doc: Document, nodeIds: string[]): (PathNode | LiveShape)[] {
  const nodes = nodeIds.map((id, i) => withAnchors(doc, id, `nodeIds[${i}]`));
  return [...new Map(nodes.map((n) => [n.id, n])).values()];
}

/** `path_op convert_to_path`: converts each Live Shape and leaves a path as it is. */
export function convertToPath(doc: Document, nodeIds: string[]): { updated: PathNode[] } {
  const updated = allWithAnchors(doc, nodeIds).filter(isLiveShape).map(toPath);
  for (const node of updated) doc.nodes.set(node.id, node);
  return { updated };
}

/** Each subpath's segments split at t = 0.5, last first so the indices ahead stay put. */
function addAnchors(subpaths: Subpath[]): Subpath[] {
  for (const [k, s] of subpaths.entries()) {
    for (let i = (s.closed ? s.anchors.length : s.anchors.length - 1) - 1; i >= 0; i--) {
      editSubpaths(subpaths, { op: "add_anchor", subpath: k, segment: i, t: 0.5 }, "");
    }
  }
  return subpaths;
}

type Ref = z.output<typeof AnchorRef>;
type PathOpResult = {
  created?: Node[];
  updated: Node[];
  deletedIds: string[];
  warnings: WriteReceipt["warnings"];
};
type WithAnchors = PathNode | LiveShape;

/** The Node as a path, converted if it is a Live Shape, and its Anchors mapped by `m`. */
function anchorsIn(node: WithAnchors, m: Matrix = IDENTITY) {
  const path = isLiveShape(node) ? toPath(node) : node;
  return { node, path, subpaths: toAnchors(transformSegments(parsePath(path.d, "d"), m)) };
}

/** `anchors`, each checked to be of a Node in `nodeIds`. */
const checkRefs = (refs: Ref[] | undefined, nodeIds: string[]) =>
  refs?.map((r, i) => {
    if (nodeIds.includes(r.nodeId)) return r;
    throw invalid(
      `anchors[${i}].nodeId`,
      "The Anchor's Node is not in nodeIds.",
      "List its Node in nodeIds too.",
    );
  });

const flip = (s: Subpath) =>
  editSubpaths([structuredClone(s)], { op: "reverse" }, "")[0] as Subpath;

const shift = (a: Anchor, [dx, dy]: Point): Anchor => {
  const by = (p: Point | null): Point | null => p && [p[0] + dx, p[1] + dy];
  return {
    ...a,
    anchor: [a.anchor[0] + dx, a.anchor[1] + dy],
    handleIn: by(a.handleIn),
    handleOut: by(a.handleOut),
  };
};

const gap = (a: Anchor, b: Anchor): Point => [a.anchor[0] - b.anchor[0], a.anchor[1] - b.anchor[1]];

/**
 * Open subpaths `a` and `b` as one, joined at `a`'s end (else start) and `b`'s end (else start),
 * keeping `a`'s direction. Endpoints within `tolerance` merge into `a`'s, `b` sliding onto it, each
 * keeping its Handle, as Illustrator's Corner join leaves them unaligned (research §5); farther
 * ones get a straight segment.
 */
function connect(a: Subpath, aEnd: boolean, b: Subpath, bEnd: boolean, tolerance: number): Subpath {
  const other = aEnd === bEnd ? flip(b) : b;
  const [pa, pb] = aEnd
    ? [a.anchors.at(-1), other.anchors[0]]
    : [a.anchors[0], other.anchors.at(-1)];
  const d = gap(pa as Anchor, pb as Anchor);
  if (Math.hypot(...d) > tolerance) {
    return {
      closed: false,
      anchors: aEnd ? [...a.anchors, ...other.anchors] : [...other.anchors, ...a.anchors],
    };
  }
  const moved = other.anchors.map((x) => shift(x, d));
  const anchors = aEnd
    ? [
        ...a.anchors.slice(0, -1),
        { ...(pa as Anchor), handleOut: moved[0]?.handleOut ?? null },
        ...moved.slice(1),
      ]
    : [
        ...moved.slice(0, -1),
        { ...(pa as Anchor), handleIn: moved.at(-1)?.handleIn ?? null },
        ...a.anchors.slice(1),
      ];
  return { closed: false, anchors };
}

/** Closes an open subpath, merging its ends when within `tolerance`. */
function closeWithin(s: Subpath, tolerance: number): Subpath {
  const [first] = s.anchors as [Anchor];
  const last = s.anchors.at(-1) as Anchor;
  const d = gap(first, last);
  if (s.anchors.length > 1 && Math.hypot(...d) <= tolerance) {
    first.handleIn = shift(last, d).handleIn;
    s.anchors.pop();
  }
  s.closed = true;
  return s;
}

/**
 * The two subpaths of `chains`, open ones, whose Endpoints lie closest, `aEnd` and `bEnd` telling whether
 * that is the end (else the start) of `chains[i]` and `chains[j]`, with `i < j`. The first pair
 * wins a tie.
 */
export function closestEnds(chains: Subpath[]) {
  let best = { i: 0, j: 1, aEnd: true, bEnd: false, dist: Infinity };
  for (const [i, a] of chains.entries()) {
    for (const [j, b] of chains.entries()) {
      if (j <= i) continue;
      for (const aEnd of [false, true]) {
        for (const bEnd of [false, true]) {
          const pa = (aEnd ? a.anchors.at(-1) : a.anchors[0]) as Anchor;
          const pb = (bEnd ? b.anchors.at(-1) : b.anchors[0]) as Anchor;
          const dist = Math.hypot(...gap(pa, pb));
          if (dist < best.dist) best = { i, j, aEnd, bEnd, dist };
        }
      }
    }
  }
  return best;
}

const JOIN_HINT = "Name two open Endpoints in anchors, or omit anchors to join whole open paths.";

/**
 * `path_op join` (research §5): two named Endpoints connect; whole paths join their open subpaths
 * closest Endpoints first until one is left, and one open path alone closes. The topmost path takes
 * the result with every subpath of the others, keeping its appearance; the others are deleted.
 */
function join(doc: Document, input: z.output<typeof PathOpInput>): PathOpResult {
  const refs = checkRefs(input.anchors, input.nodeIds);
  const named = allWithAnchors(doc, input.nodeIds);
  const order = paintOrder(doc);
  // Everything in the topmost Node's coordinates, tolerance too: it is in the Document's.
  const gather = (nodes: WithAnchors[]) => {
    const top = nodes.reduce((a, b) => ((order.get(b.id) ?? 0) > (order.get(a.id) ?? 0) ? b : a));
    const m = worldTransform(doc, top);
    const each = nodes.map((n) => anchorsIn(n, multiply(invert(m), worldTransform(doc, n))));
    return { top, each, tolerance: (input.tolerance ?? 0.01) / scaleOf(m) };
  };
  const done = (top: WithAnchors, subpaths: Subpath[], nodes: WithAnchors[]): PathOpResult => {
    const next = { ...anchorsIn(top).path, d: formatPath(fromAnchors(subpaths)) };
    const deletedIds = nodes.filter((n) => n !== top).map((n) => n.id);
    for (const id of deletedIds) doc.nodes.delete(id);
    doc.nodes.set(next.id, next);
    return {
      updated: [next],
      deletedIds,
      warnings: isLiveShape(top) ? [convertedWarning(top)] : [],
    };
  };

  if (refs) {
    const nodes = named.filter((n) => refs.some((r) => r.nodeId === n.id));
    const { top, each, tolerance } = gather(nodes);
    const subpathOf = (r: Ref) => each.find((e) => e.node.id === r.nodeId)?.subpaths[r.subpath];
    const isEndpoint = (r: Ref) => {
      const s = subpathOf(r);
      return !!s && !s.closed && (r.index === 0 || r.index === s.anchors.length - 1);
    };
    const [p, q] = refs as [Ref, Ref];
    const twice =
      refs.length === 2 && p.nodeId === q.nodeId && p.subpath === q.subpath && p.index === q.index;
    if (refs.length !== 2 || twice || !refs.every(isEndpoint)) {
      throw invalid("anchors", "Join connects two open Endpoints.", JOIN_HINT);
    }
    const [sp, sq] = [subpathOf(p), subpathOf(q)] as [Subpath, Subpath];
    const rest = each.flatMap((e) => e.subpaths).filter((s) => s !== sp && s !== sq);
    const joined =
      sp === sq ? closeWithin(sp, tolerance) : connect(sp, p.index > 0, sq, q.index > 0, tolerance);
    return done(top, [joined, ...rest], nodes);
  }

  const nodes = named.filter((n) => anchorsIn(n).subpaths.some((s) => !s.closed));
  if (nodes.length === 0) {
    throw invalid("nodeIds", "None of the paths has an open subpath to join.", JOIN_HINT);
  }
  const { top, each, tolerance } = gather(nodes);
  const closed = each.flatMap((e) => e.subpaths.filter((s) => s.closed));
  // The topmost Node's open subpaths first, so the result keeps its direction.
  const chains = [...each]
    .sort((a, b) => Number(b.node === top) - Number(a.node === top))
    .flatMap((e) => e.subpaths.filter((s) => !s.closed));
  if (chains.length === 1) {
    const [only] = chains as [Subpath];
    if (only.anchors.length === 1) {
      throw invalid("nodeIds", "A Stray Point has no segment to close.", JOIN_HINT);
    }
    return done(top, [closeWithin(only, tolerance), ...closed], nodes);
  }
  while (chains.length > 1) {
    const { i, j, aEnd, bEnd } = closestEnds(chains);
    chains[i] = connect(chains[i] as Subpath, aEnd, chains[j] as Subpath, bEnd, tolerance);
    chains.splice(j, 1);
  }
  return done(top, [...chains, ...closed], nodes);
}

/**
 * `path_op average` (research §5): the Anchors move, Handles along, to their mean position in
 * document coordinates, on one axis or both. A Live Shape with an Anchor to move is converted first.
 */
function average(doc: Document, input: z.output<typeof PathOpInput>): PathOpResult {
  const named = allWithAnchors(doc, input.nodeIds);
  const listed =
    checkRefs(input.anchors, input.nodeIds) ??
    named.flatMap((n) =>
      anchorsIn(n).subpaths.flatMap((s, subpath) =>
        s.anchors.map((_, index) => ({ nodeId: n.id, subpath, index })),
      ),
    );
  const nodes = named.filter((n) => listed.some((r) => r.nodeId === n.id));
  const each = new Map(nodes.map((n) => [n.id, { ...anchorsIn(n), m: worldTransform(doc, n) }]));
  const anchorOf = (r: Ref) => each.get(r.nodeId)?.subpaths[r.subpath]?.anchors[r.index];
  listed.forEach((r, i) => {
    if (anchorOf(r)) return;
    throw invalid(
      `anchors[${i}]`,
      `The Node has no Anchor ${r.index} in subpath ${r.subpath}.`,
      "kalamo_path_edit returns each subpath's Anchors.",
    );
  });
  const refs = [...new Map(listed.map((r) => [`${r.nodeId} ${r.subpath} ${r.index}`, r])).values()];
  const world = refs.map((r) => {
    const { m } = each.get(r.nodeId) as { m: Matrix };
    return applyTo(m, ...(anchorOf(r) as Anchor).anchor);
  });
  const mean = (k: 0 | 1) => world.reduce((sum, p) => sum + p[k], 0) / world.length;
  const [mx, my] = [mean(0), mean(1)];
  refs.forEach(({ nodeId, subpath, index }, i) => {
    const { m, subpaths } = each.get(nodeId) as { m: Matrix; subpaths: Subpath[] };
    const [wx, wy] = world[i] as Point;
    const x = input.axis === "horizontal" ? wx : mx;
    const y = input.axis === "vertical" ? wy : my;
    editSubpaths(subpaths, { op: "move_anchor", subpath, index, to: applyTo(invert(m), x, y) }, "");
  });
  const updated = [...each.values()].map(({ path, subpaths }) => ({
    ...path,
    d: formatPath(fromAnchors(subpaths)),
  }));
  for (const node of updated) doc.nodes.set(node.id, node);
  return { updated, deletedIds: [], warnings: nodes.filter(isLiveShape).map(convertedWarning) };
}

/**
 * `path_op outline_stroke` (research §5): each Stroke becomes a path filled with its paint, the
 * Stroke's outline. A path with one Stroke and no Fill becomes that outline itself. Otherwise, as in
 * Illustrator, a Group in its place holds it, keeping only its Fills, below each outlined Stroke,
 * and takes its opacity and blend mode so they still composite as one. A path without a Stroke is
 * left as it is.
 */
function outlineStrokes(doc: Document, nodeIds: string[], geometry: Geometry): PathOpResult {
  // A Clipping Path paints nothing (ADR-0021), and a Group cannot stand in for it.
  const stroked = allWithAnchors(doc, nodeIds).filter(
    (n) => n.appearance.strokes.length > 0 && !n.clipping,
  );
  if (stroked.length === 0) {
    throw invalid("nodeIds", "None of the Nodes has a Stroke to outline.", "Name a stroked path.");
  }
  const created: Node[] = [];
  const updated: Node[] = [];
  for (const found of stroked) {
    const path = isLiveShape(found) ? toPath(found) : found;
    const segments = parsePath(path.d, "d");
    const { fills, strokes } = path.appearance;
    const outlines = strokes.map((stroke): PathNode => {
      const { width, cap, join, miterLimit, dash } = stroke;
      const d = formatPath(
        geometry.outlineStroke(segments, { width, cap, join, miterLimit, dash }),
      );
      const paint: Fill =
        stroke.type === "gradient"
          ? { type: "gradient", gradient: stroke.gradient }
          : { type: "solid", color: stroke.color };
      return { ...path, d, fillRule: "nonzero", appearance: { fills: [paint], strokes: [] } };
    });
    const members: PathNode[] = [
      ...(fills.length > 0 ? [{ ...path, appearance: { fills, strokes: [] } }] : []),
      ...outlines,
    ];
    const [only, ...rest] = members;
    if (only && rest.length === 0) {
      updated.push(only);
      continue;
    }
    const [made] = createNodes(doc, [{ type: "group", parentId: path.parentId as string }]).nodes;
    const { index, opacity, blendMode } = path;
    const group: GroupNode = { ...(made as GroupNode), index, opacity, blendMode };
    created.push(group);
    let key: string | null = null;
    for (const [k, m] of members.entries()) {
      key = generateKeyBetween(key, null);
      const inside: PathNode = {
        ...m,
        parentId: group.id,
        index: key,
        opacity: 1,
        blendMode: "normal",
      };
      if (k === 0) updated.push(inside);
      else created.push({ ...inside, id: newId() });
    }
  }
  for (const n of [...created, ...updated]) doc.nodes.set(n.id, n);
  return {
    created,
    updated,
    deletedIds: [],
    warnings: stroked.filter(isLiveShape).map(convertedWarning),
  };
}

/**
 * `path_op offset` (research §5): a copy of each path offset by `distance` in document units,
 * directly below it as Inkscape's Linked Offset stacks it, filled evenodd (ADR-0039). The original stays, a Live
 * Shape live; a Clipping Path, or a path that shrinks away, gets no copy.
 */
function offset(
  doc: Document,
  input: z.output<typeof PathOpInput>,
  geometry: Geometry,
): PathOpResult {
  const { nodeIds, distance, join, miterLimit } = input;
  if (distance === undefined) {
    throw invalid("distance", "Offset Path needs a distance.", "Pass distance in document units.");
  }
  const created: PathNode[] = [];
  for (const found of allWithAnchors(doc, nodeIds).filter((n) => !n.clipping)) {
    const path = isLiveShape(found) ? toPath(found) : found;
    // Offsets in document units, so a scaled path's copy is offset by distance on the page.
    const world = worldTransform(doc, found);
    const grown = geometry.offsetPath(transformSegments(parsePath(path.d, "d"), world), {
      distance,
      join,
      miterLimit,
      fillRule: path.fillRule,
    });
    if (grown.length === 0) continue;
    const below = childrenOf(doc, found.parentId).findLast((n) => n.index < found.index);
    const copy: PathNode = {
      ...path,
      id: newId(),
      index: generateKeyBetween(below?.index ?? null, found.index),
      d: formatPath(transformSegments(grown, invert(world))),
      // Skia's contours do not overlap, but a hole winds as its outline does.
      fillRule: "evenodd",
    };
    doc.nodes.set(copy.id, copy);
    created.push(copy);
  }
  if (created.length === 0) {
    throw invalid("nodeIds", "No path has an offset to add.", "Name a filled area it can offset.");
  }
  return { created, updated: [], deletedIds: [], warnings: [] };
}

/**
 * `path_op split_into_grid` (research §5): each closed path or Live Shape becomes rows × cols rects
 * over its geometric bounds in document coordinates, in its place, all with the topmost shape's
 * appearance. Containers carry no transform (ADR-0007), so the rects need none either. A Clipping
 * Path is left as it is.
 */
function splitIntoGrid(doc: Document, input: z.output<typeof PathOpInput>): PathOpResult {
  const { rows, cols, gutter } = input;
  const shapes = allWithAnchors(doc, input.nodeIds).filter((n) => {
    const { subpaths } = anchorsIn(n);
    return !n.clipping && subpaths.length > 0 && subpaths.every((s) => s.closed);
  });
  if (shapes.length === 0) {
    throw invalid("nodeIds", "No closed shape to split.", "Name a closed path or Live Shape.");
  }
  if (shapes.length * rows * cols > MAX_NODES_PER_CREATE) {
    throw invalid(
      "rows",
      `The grids would make more than ${MAX_NODES_PER_CREATE} rects.`,
      "Use fewer rows or columns.",
    );
  }
  // Adobe: several objects' grids take the topmost one's appearance.
  const order = paintOrder(doc);
  const { appearance } = shapes.reduce((a, b) =>
    (order.get(b.id) ?? 0) > (order.get(a.id) ?? 0) ? b : a,
  );
  const created: ShapeNode[] = [];
  for (const found of shapes) {
    const b = bounds(doc, found) as Rect;
    const width = ((input.totalWidth ?? b.width) - gutter * (cols - 1)) / cols;
    const height = ((input.totalHeight ?? b.height) - gutter * (rows - 1)) / rows;
    if (width <= 0 || height <= 0) {
      throw invalid("gutter", "The gutters leave no room for the rects.", "Use a smaller gutter.");
    }
    const below = childrenOf(doc, found.parentId).findLast((n) => n.index < found.index);
    const keys = generateNKeysBetween(below?.index ?? null, found.index, rows * cols);
    const { name, parentId, visible, locked, opacity, blendMode, tags, meta } = found;
    for (const [k, index] of keys.entries()) {
      const [r, c] = [Math.floor(k / cols), k % cols];
      created.push({
        ...{ id: newId(), name, parentId, index, visible, locked, opacity, blendMode, tags, meta },
        ...{ transform: IDENTITY, appearance, type: "rect", radius: 0, width, height },
        x: b.x + c * (width + gutter),
        y: b.y + r * (height + gutter),
      });
    }
  }
  const deletedIds = shapes.map((n) => n.id);
  for (const id of deletedIds) doc.nodes.delete(id);
  for (const n of created) doc.nodes.set(n.id, n);
  return { created, updated: [], deletedIds, warnings: [] };
}

/** Visible and unlocked, as are all its ancestors. */
const editable = (doc: Document, n: Node | undefined): boolean =>
  !n ||
  (n.visible && !n.locked && editable(doc, n.parentId ? doc.nodes.get(n.parentId) : undefined));

const overlap = (a: Rect | null, b: Rect | null) =>
  !!a &&
  !!b &&
  a.x <= b.x + b.width &&
  b.x <= a.x + a.width &&
  a.y <= b.y + b.height &&
  b.y <= a.y + a.height;

/**
 * `path_op divide_below` (research §5): the one path or Live Shape named cuts each filled path and
 * Live Shape below it in paint order that it overlaps, visible and unlocked, into the fill inside
 * it and the fill outside, and is deleted. The outside keeps the Node's id, the inside is a new path
 * directly above it, both with its appearance and fillRule evenodd. A Clipping Path is neither cut
 * nor a cutter.
 */
function divideBelow(doc: Document, nodeIds: string[], geometry: Geometry): PathOpResult {
  const [cutter, ...more] = allWithAnchors(doc, nodeIds);
  if (!cutter || more.length > 0) {
    throw invalid("nodeIds", "Divide Objects Below takes one cutter.", "Name one path or shape.");
  }
  if (cutter.clipping) {
    throw invalid("nodeIds", "A Clipping Path cannot cut.", "Name a path or shape that paints.");
  }
  if (!editable(doc, cutter)) {
    throw invalid("nodeIds", "The cutter is hidden or locked.", "Show and unlock it first.");
  }
  const fillOf = (n: WithAnchors): Filled => {
    const { path } = anchorsIn(n);
    const segments = transformSegments(parsePath(path.d, "d"), worldTransform(doc, n));
    return { segments, fillRule: path.fillRule };
  };
  const knife = fillOf(cutter);
  const box = pathBounds(knife.segments);
  const order = paintOrder(doc);
  const top = order.get(cutter.id) ?? 0;
  const targets = [...doc.nodes.values()].filter(
    (n): n is WithAnchors =>
      (n.type === "path" || isLiveShape(n)) &&
      (order.get(n.id) ?? 0) < top &&
      n.appearance.fills.length > 0 &&
      !n.clipping &&
      editable(doc, n) &&
      overlap(bounds(doc, n), box),
  );
  const created: PathNode[] = [];
  const updated: PathNode[] = [];
  const warnings: WriteReceipt["warnings"] = [];
  for (const found of targets) {
    const { inside, outside } = geometry.divide(fillOf(found), knife);
    if (inside.length === 0) continue;
    const back = invert(worldTransform(doc, found));
    const piece = (d: Segment[]): PathNode => ({
      ...anchorsIn(found).path,
      d: formatPath(transformSegments(d, back)),
      fillRule: "evenodd",
    });
    const above = childrenOf(doc, found.parentId).find((n) => n.index > found.index);
    const inner = {
      ...piece(inside),
      id: newId(),
      index: generateKeyBetween(found.index, above?.index ?? null),
    };
    // Wholly inside, the Node is its inside piece.
    if (outside.length === 0) updated.push({ ...inner, id: found.id, index: found.index });
    else {
      updated.push(piece(outside));
      created.push(inner);
    }
    if (isLiveShape(found)) warnings.push(convertedWarning(found));
  }
  if (updated.length === 0) {
    throw invalid(
      "nodeIds",
      "The cutter overlaps no filled path or shape below it.",
      "Place it over filled, visible, unlocked paths or shapes.",
    );
  }
  doc.nodes.delete(cutter.id);
  for (const n of [...updated, ...created]) doc.nodes.set(n.id, n);
  return { created, updated, deletedIds: [cutter.id], warnings };
}

/** `appearance` as it looks drawn under `m`, for a path with no transform of its own. */
function bake(appearance: Appearance, m: Matrix): Appearance {
  const k = scaleOf(m);
  return {
    ...appearance,
    fills: appearance.fills.map((f) => mapPaint(f, m)),
    strokes: appearance.strokes.map((t) => ({
      ...mapPaint(t, m),
      width: t.width * k,
      dash: t.dash.map((v) => v * k),
    })),
  };
}

const EMPTY: Record<Combining, string> = {
  unite: "The objects have no area to unite.",
  minus_front: "The objects in front cover all of the backmost one.",
  intersect: "The objects have no area in common.",
  exclude: "The objects' overlaps cancel all of their area.",
  minus_back: "The objects behind cover all of the frontmost one.",
};

/** A Shape Mode operand's paths and Live Shapes, back to front; no Clipping Path or mask. */
function operandLeaves(doc: Document, n: Node): WithAnchors[] {
  // A mask paints nothing (ADR-0103).
  if (isOpacityMask(n)) return [];
  if (n.type === "layer" || n.type === "group") {
    return childrenOf(doc, n.id).flatMap((c) => operandLeaves(doc, c));
  }
  return (n.type === "path" || isLiveShape(n)) && !n.clipping ? [n] : [];
}

/**
 * Pathfinder Shape Modes (ADR-0104): each Node in `nodeIds`, its path and Live Shape leaves for a
 * Group or Layer, is one operand in document coordinates. They combine into one new path in the
 * place, and with the paint, of the topmost operand, or the backmost for minus_front, and are
 * deleted. minus_back is minus_front taken front to back: the topmost minus all behind it.
 */
function shapeMode(
  doc: Document,
  nodeIds: string[],
  op: Combining,
  geometry: Geometry,
): PathOpResult {
  const order = paintOrder(doc);
  // A Node inside another operand is already part of it, as when Illustrator selects a Group.
  const { kept, nested } = outermost(
    doc,
    nodeIds.map((id, i) => lookup(doc, id, `nodeIds[${i}]`)),
  );
  const named = kept.map((node) => {
    const i = nodeIds.indexOf(node.id);
    const leaves = operandLeaves(doc, node);
    if (leaves.length === 0) {
      const what =
        node.type === "group" || node.type === "layer"
          ? `A ${node.type} with no path or Live Shape`
          : "clipping" in node && node.clipping
            ? "A Clipping Path"
            : `A ${node.type}`;
      const hint =
        node.type === "text"
          ? "A text has no outline until Create Outlines, still to come."
          : "Name paths, Live Shapes, or Groups of them.";
      throw invalid(`nodeIds[${i}]`, `${what} is not a ${PATH_OP_TEXT[op].menu} operand.`, hint);
    }
    if (node.parentId === null) {
      throw invalid(
        `nodeIds[${i}]`,
        "A top-level Layer has no parent to hold the result.",
        "Name the objects in it, or a sublayer.",
      );
    }
    return { node, leaves };
  });
  const operands = named.sort((a, b) => (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0));
  if (operands.length < 2) {
    throw invalid(
      "nodeIds",
      `${PATH_OP_TEXT[op].menu} combines two or more objects.`,
      "List them in nodeIds.",
    );
  }
  const filled = operands.map(({ leaves }): Filled => {
    const each = leaves.map((n) => worldOutline(doc, n));
    const [only] = each;
    if (only && each.length === 1) return only;
    return { segments: geometry.combine("unite", each), fillRule: "nonzero" };
  });
  const segments =
    op === "minus_back"
      ? geometry.combine("minus_front", filled.toReversed())
      : geometry.combine(op, filled);
  if (segments.length === 0) {
    throw invalid("nodeIds", EMPTY[op], "Overlap the objects so the result has area.");
  }
  const { node, leaves } = (op === "minus_front" ? operands[0] : operands.at(-1)) as {
    node: Node;
    leaves: WithAnchors[];
  };
  const leaf = leaves.at(-1) as WithAnchors;
  const parent = lookup(doc, node.parentId as string, "nodeIds");
  const back = invert(worldTransform(doc, parent));
  const { name, parentId, index, visible, locked, opacity, blendMode, tags, meta } = node;
  const result: PathNode = {
    ...{ id: newId(), name, parentId, index, visible, locked, opacity, blendMode, tags, meta },
    type: "path",
    transform: IDENTITY,
    appearance: bake(leaf.appearance, multiply(back, worldTransform(doc, leaf))),
    d: formatPath(transformSegments(segments, back)),
    fillRule: op === "exclude" ? "evenodd" : "nonzero",
  };
  const { deletedIds } = deleteNodes(
    doc,
    operands.map((o) => o.node.id),
  );
  doc.nodes.set(result.id, result);
  const warnings = nested.map((n) => ({
    code: "NESTED_TARGET",
    nodeId: n.id,
    message: "Also inside another operand, so it counted once, as part of that one.",
  }));
  return { created: [result], updated: [], deletedIds, warnings };
}

/** Why `node` cannot be part of, or be, a Compound Path that Make or Release writes; else null. */
function notCompoundPart(node: Node): string | null {
  if (node.type !== "path" && !isLiveShape(node)) return article(node.type);
  if (node.clipping) return "A Clipping Path";
  // A Group holds one mask (ADR-0103).
  return isOpacityMask(node) ? "An Opacity Mask" : null;
}

/** "A text", "An image". */
const article = (type: string) => `${/^[aeiou]/.test(type) ? "An" : "A"} ${type}`;

/** `segments` cut at each M, one list per subpath. */
const splitSubpaths = (segments: Segment[]): Segment[][] =>
  segments.reduce<Segment[][]>((out, s) => {
    if (s.cmd === "M" || out.length === 0) out.push([]);
    out.at(-1)?.push(s);
    return out;
  }, []);

/** A path whose `d` has two or more subpaths (ADR-0018). */
export const isCompoundPath = (n: Node): boolean =>
  n.type === "path" && (n.d.match(/M/g)?.length ?? 0) >= 2;

/** Twice the area the subpath encloses, its sign its direction. */
const signedArea = (subpath: Segment[]) =>
  frameEdges(subpath).reduce((sum, [x1, y1, x2, y2]) => sum + x1 * y2 - x2 * y1, 0);

/** `segments` with every subpath drawn the other way. */
const reversed = (segments: Segment[]) =>
  fromAnchors(editSubpaths(toAnchors(segments), { op: "reverse" }, ""));

/**
 * `path_op make_compound_path` (ADR-0107): the paths and Live Shapes in `nodeIds` become one new
 * path, every operand's subpaths in document order back to front, its transform composed in. It
 * takes the backmost operand's paint and fill rule and the frontmost's place, and the operands are
 * deleted. Under nonzero the backmost winds against the others, so where they overlap it is a hole.
 */
function makeCompoundPath(doc: Document, nodeIds: string[]): PathOpResult {
  const nodes = [...new Map(nodeIds.map((id, i) => [id, lookup(doc, id, `nodeIds[${i}]`)]))];
  for (const [id, node] of nodes) {
    const what = notCompoundPart(node);
    if (!what) continue;
    const at = `nodeIds[${nodeIds.indexOf(id)}]`;
    const hint =
      node.type === "text"
        ? "A text has no outline until Create Outlines, still to come."
        : "Name paths and Live Shapes; select the ones inside a Group.";
    throw invalid(at, `${what} cannot be part of a Compound Path.`, hint);
  }
  const order = paintOrder(doc);
  const operands = nodes
    .map(([, n]) => n as WithAnchors)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const [backmost] = operands;
  const front = operands.at(-1);
  if (!backmost || !front || backmost === front) {
    throw invalid("nodeIds", "Make joins two or more paths.", "List them in nodeIds.");
  }
  const parent = lookup(doc, front.parentId as string, "nodeIds");
  const back = invert(worldTransform(doc, parent));
  const each = operands.map((n) =>
    transformSegments(shapeSegments(n), multiply(back, worldTransform(doc, n))),
  );
  const fillRule = backmost.type === "path" ? backmost.fillRule : "nonzero";
  const sign = (s: Segment[]) => Math.sign(signedArea(splitSubpaths(s)[0] ?? []));
  const turn = sign(each[0] as Segment[]);
  const d = each.flatMap((s, k) =>
    // Illustrator reverses the backmost; reversing the rest fills the same under nonzero, and
    // each operand keeps its own holes.
    k > 0 && fillRule === "nonzero" && sign(s) === turn ? reversed(s) : s,
  );
  const { visible, locked, opacity, blendMode, tags, meta } = backmost;
  const result: PathNode = {
    ...{ id: newId(), name: "", parentId: front.parentId, index: front.index, visible, locked },
    opacity,
    ...{ blendMode, tags, meta, type: "path", transform: IDENTITY, fillRule },
    appearance: bake(backmost.appearance, multiply(back, worldTransform(doc, backmost))),
    d: formatPath(d),
  };
  const deletedIds = operands.map((n) => n.id);
  for (const id of deletedIds) doc.nodes.delete(id);
  doc.nodes.set(result.id, result);
  return { created: [result], updated: [], deletedIds, warnings: [] };
}

/**
 * `path_op release_compound_path` (ADR-0107): each Compound Path in `nodeIds` becomes one path per
 * subpath in its place, the first subpath backmost, each with all of its attributes but its name,
 * as Illustrator names each `<Path>`.
 */
function releaseCompoundPath(doc: Document, nodeIds: string[]): PathOpResult {
  const compounds = [...new Map(nodeIds.map((id, i) => [id, lookup(doc, id, `nodeIds[${i}]`)]))];
  const split = compounds.map(([id, node]) => {
    const what =
      node.type === "path"
        ? (notCompoundPart(node) ?? (isCompoundPath(node) ? null : "A path with one subpath"))
        : article(node.type);
    if (what || node.type !== "path") {
      throw invalid(
        `nodeIds[${nodeIds.indexOf(id)}]`,
        `${what} is not a Compound Path.`,
        "Name a path whose d has two or more subpaths.",
      );
    }
    return { node, subpaths: splitSubpaths(parsePath(node.d, "d")) };
  });
  const created: PathNode[] = [];
  for (const { node, subpaths } of split) {
    const siblings = childrenOf(doc, node.parentId);
    const below = siblings.findLast((n) => n.index < node.index);
    const above = siblings.find((n) => n.index > node.index);
    const keys = generateNKeysBetween(below?.index ?? null, above?.index ?? null, subpaths.length);
    doc.nodes.delete(node.id);
    for (const [k, s] of subpaths.entries()) {
      const index = keys[k] as string;
      const path: PathNode = { ...node, id: newId(), name: "", index, d: formatPath(s) };
      doc.nodes.set(path.id, path);
      created.push(path);
    }
  }
  return { created, updated: [], deletedIds: split.map((c) => c.node.id), warnings: [] };
}

/**
 * `path_op clean_up` (research §5), over the whole Document: removes Stray Points, a path left
 * with none being deleted; Live Shapes and paths with no Fill and no Stroke; and texts of only
 * spaces and hard returns, the nearest a text gets to Illustrator's empty text path. Hidden and
 * locked Nodes, and Clipping Paths, are left as they are.
 */
function cleanUp(doc: Document, input: z.output<typeof PathOpInput>): PathOpResult {
  const deletedIds: string[] = [];
  const updated: PathNode[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type === "layer" || n.type === "group" || n.type === "image" || !editable(doc, n))
      continue;
    if (n.type === "text") {
      if (input.emptyText && n.content.trim() === "") deletedIds.push(n.id);
      continue;
    }
    if (n.clipping) continue;
    const { fills, strokes } = n.appearance;
    if (input.unpainted && fills.length === 0 && strokes.length === 0) {
      deletedIds.push(n.id);
    } else if (input.strayPoints && n.type === "path") {
      const subpaths = toAnchors(parsePath(n.d, "d"));
      const kept = subpaths.filter((s) => s.anchors.length > 1);
      if (kept.length === 0) deletedIds.push(n.id);
      else if (kept.length < subpaths.length) {
        updated.push({ ...n, d: formatPath(fromAnchors(kept)) });
      }
    }
  }
  if (deletedIds.length === 0 && updated.length === 0) {
    throw invalid("op", "Nothing to clean up.", "Clean Up found no object to remove.");
  }
  for (const id of deletedIds) doc.nodes.delete(id);
  for (const n of updated) doc.nodes.set(n.id, n);
  return { updated, deletedIds, warnings: [] };
}

/**
 * `path_op` (REQUIREMENTS §6.4) on each path or Live Shape; every op but convert_to_path and
 * offset converts a Live Shape first (F-PATH-07), with a warning. outline_stroke, offset,
 * divide_below and the Shape Modes need `geometry`.
 */
export function pathOp(doc: Document, raw: PathOpInput, geometry?: Geometry): PathOpResult {
  const input = PathOpInput.parse(raw);
  const { nodeIds, op } = input;
  if (op === "clean_up") return cleanUp(doc, input);
  if (nodeIds.length === 0) {
    throw invalid("nodeIds", "The op needs at least one Node.", "List the paths in nodeIds.");
  }
  if (op === "convert_to_path") {
    return { ...convertToPath(doc, nodeIds), deletedIds: [], warnings: [] };
  }
  if (op === "outline_stroke") {
    if (!geometry) throw new Error("outline_stroke needs the path geometry (ADR-0034).");
    return outlineStrokes(doc, nodeIds, geometry);
  }
  if (op === "offset") {
    if (!geometry) throw new Error("offset needs the path geometry (ADR-0034).");
    return offset(doc, input, geometry);
  }
  if (op === "divide_below") {
    if (!geometry) throw new Error("divide_below needs the path geometry (ADR-0034).");
    return divideBelow(doc, nodeIds, geometry);
  }
  if (isCombining(op)) {
    if (!geometry) throw new Error(`${op} needs the path geometry (ADR-0034).`);
    return shapeMode(doc, nodeIds, op, geometry);
  }
  if (op === "make_compound_path") return makeCompoundPath(doc, nodeIds);
  if (op === "release_compound_path") return releaseCompoundPath(doc, nodeIds);
  if (op === "split_into_grid") return splitIntoGrid(doc, input);
  if (op === "join") return join(doc, input);
  if (op === "average") return average(doc, input);
  const unique = allWithAnchors(doc, nodeIds);
  if (op === "simplify" && input.tolerance === 0) {
    throw invalid("tolerance", "Simplify needs a tolerance above 0.", "Omit it for 1 pt.");
  }
  const updated = unique.map((found) => {
    const node = isLiveShape(found) ? toPath(found) : found;
    const subpaths = toAnchors(parsePath(node.d, "d"));
    if (op === "simplify") {
      const tolerance = (input.tolerance ?? 1) / scaleOf(worldTransform(doc, found));
      const { cornerAngle, toLines } = input;
      const d = subpaths.flatMap(
        (s) => simplifySubpath(s, tolerance, cornerAngle, toLines) ?? fromAnchors([s]),
      );
      return { ...node, d: formatPath(d) };
    }
    const next =
      op === "reverse" ? editSubpaths(subpaths, { op: "reverse" }, "") : addAnchors(subpaths);
    return { ...node, d: formatPath(fromAnchors(next)) };
  });
  for (const node of updated) doc.nodes.set(node.id, node);
  return { updated, deletedIds: [], warnings: unique.filter(isLiveShape).map(convertedWarning) };
}
