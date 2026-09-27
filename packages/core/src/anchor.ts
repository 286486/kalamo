import { z } from "zod";
import { childrenOf, worldTransform } from "./document.ts";
import { lookup } from "./edit.ts";
import { ZibelError } from "./errors.ts";
import { applyTo, IDENTITY, invert, multiply, transformSegments } from "./matrix.ts";
import { formatPath, parsePath, type Segment, shapeSegments } from "./path.ts";
import {
  type Document,
  type Matrix,
  type Node,
  SHAPES,
  type ShapeNode,
  type WriteReceipt,
} from "./schema.ts";

type Point = [number, number];
export type PathNode = Extract<ShapeNode, { type: "path" }>;

/** One Anchor of a subpath (REQUIREMENTS §6.5). A missing Handle is null. */
export interface Anchor {
  anchor: Point;
  handleIn: Point | null;
  handleOut: Point | null;
  /** Derived: Smooth when both Handles are collinear through the Anchor (ADR-0032). */
  type: "corner" | "smooth";
}

/** An Anchor before its type is derived, as fromAnchors reads it. */
export type BareAnchor = Omit<Anchor, "type">;

/** A closed subpath's last Anchor joins its first by the closing segment. */
export interface Subpath {
  closed: boolean;
  anchors: Anchor[];
}

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
const lerp = (a: Point, b: Point, t: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];
const pair = (args: number[], k: number): Point => [args[k] ?? 0, args[k + 1] ?? 0];

/**
 * Smooth when both Handles point away from the Anchor along one line, within what rounding `d`
 * to 3 decimals can bend them.
 */
function typeOf({ anchor: [x, y], handleIn, handleOut }: BareAnchor): Anchor["type"] {
  if (!handleIn || !handleOut) return "corner";
  const [ux, uy, vx, vy] = [handleIn[0] - x, handleIn[1] - y, handleOut[0] - x, handleOut[1] - y];
  const cross = Math.abs(ux * vy - uy * vx);
  return ux * vx + uy * vy < 0 && cross <= 1e-3 * (Math.hypot(ux, uy) + Math.hypot(vx, vy))
    ? "smooth"
    : "corner";
}

/** A Handle on its own Anchor is no Handle, as in Illustrator. */
const handle = (h: Point, anchor: Point) => (same(h, anchor) ? null : h);

/** Each subpath's Anchors. A Q's control point becomes the two Handles of the same curve. */
export function toAnchors(segments: Segment[]): Subpath[] {
  type Bare = { closed: boolean; anchors: BareAnchor[] };
  const out: Bare[] = [];
  let current: Bare | undefined;
  let start: Point = [0, 0];
  let curved = false;
  let curvedBefore = false;
  for (const { cmd, args } of segments) {
    if (cmd === "Z") {
      if (!current || current.closed) continue;
      current.closed = true;
      const [first] = current.anchors;
      const last = current.anchors.at(-1);
      const before = current.anchors.at(-2);
      // A curve back onto the first Anchor is the closing segment; an explicit L stays an Anchor,
      // except the zero-length L fromAnchors writes after a curve onto an Anchor on the first.
      if (first && last && last !== first && curved && same(first.anchor, last.anchor)) {
        first.handleIn = last.handleIn;
        current.anchors.pop();
      } else if (first && last && before && before !== first && !curved && curvedBefore) {
        if (same(last.anchor, first.anchor) && same(before.anchor, first.anchor)) {
          current.anchors.pop();
        }
      }
      continue;
    }
    const end = pair(args, args.length - 2);
    if (cmd === "M") start = end;
    if (cmd === "M" || !current || current.closed) {
      current = { closed: false, anchors: [{ anchor: start, handleIn: null, handleOut: null }] };
      out.push(current);
      if (cmd === "M") continue;
    }
    const prev = current.anchors.at(-1) as Bare["anchors"][number];
    let handleIn: Point | null = null;
    if (cmd === "C") {
      prev.handleOut = handle(pair(args, 0), prev.anchor);
      handleIn = handle(pair(args, 2), end);
    } else if (cmd === "Q") {
      const q = pair(args, 0);
      prev.handleOut = handle(lerp(prev.anchor, q, 2 / 3), prev.anchor);
      handleIn = handle(lerp(end, q, 2 / 3), end);
    }
    [curvedBefore, curved] = [curved, cmd !== "L"];
    current.anchors.push({ anchor: end, handleIn, handleOut: null });
  }
  return out.map((s) => ({ ...s, anchors: s.anchors.map((a) => ({ ...a, type: typeOf(a) })) }));
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * (1 + Math.abs(a));

/** L without Handles, Q when the cubic is exactly a raised quadratic, else C. */
function segment(a: BareAnchor, b: BareAnchor): Segment {
  const [p0, p3] = [a.anchor, b.anchor];
  if (!a.handleOut && !b.handleIn) return { cmd: "L", args: [...p3] };
  const [c1, c2] = [a.handleOut ?? p0, b.handleIn ?? p3];
  const q1 = [(3 * c1[0] - p0[0]) / 2, (3 * c1[1] - p0[1]) / 2];
  const q2 = [(3 * c2[0] - p3[0]) / 2, (3 * c2[1] - p3[1]) / 2];
  if (q1.every((v, k) => near(v, q2[k] ?? 0))) {
    return { cmd: "Q", args: [...q1.map((v, k) => (v + (q2[k] ?? 0)) / 2), ...p3] };
  }
  return { cmd: "C", args: [...c1, ...c2, ...p3] };
}

/** The segments of `d` for the subpaths; closing without Handles is a bare Z. */
export function fromAnchors(subpaths: { closed: boolean; anchors: BareAnchor[] }[]): Segment[] {
  const out: Segment[] = [];
  for (const { closed, anchors } of subpaths) {
    const [first] = anchors;
    const last = anchors.at(-1);
    if (!first || !last) continue;
    out.push({ cmd: "M", args: [...first.anchor] });
    for (let i = 1; i < anchors.length; i++) {
      out.push(segment(anchors[i - 1] as BareAnchor, anchors[i] as BareAnchor));
    }
    if (closed) {
      if (last.handleOut || first.handleIn) out.push(segment(last, first));
      // A curve onto an Anchor on the first would read back as the closing segment.
      else if (last !== first && same(last.anchor, first.anchor) && out.at(-1)?.cmd !== "L") {
        out.push({ cmd: "L", args: [...first.anchor] });
      }
      out.push({ cmd: "Z", args: [] });
    }
  }
  return out;
}

const XY = z.tuple([z.number(), z.number()]);
const subpath = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Which subpath of d, from 0 in d's order.");
const index = z.number().int().min(0).describe("The Anchor's index in its subpath, from 0.");

/** One `path_edit` op (REQUIREMENTS §6.4). Every position is in the path's own coordinates. */
export const PathOp = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("move_anchor"), subpath, index, to: XY })
    .describe("Move an Anchor to `to`; its Handles move with it."),
  z
    .object({
      op: z.literal("set_handles"),
      subpath,
      index,
      handleIn: XY.nullable().optional(),
      handleOut: XY.nullable().optional(),
    })
    .describe("Set a Handle to a point, or retract it with null; an omitted one stays."),
  z
    .object({
      op: z.literal("set_point_type"),
      subpath,
      index,
      type: z.enum(["corner", "smooth"]),
    })
    .describe(
      "corner retracts both Handles; smooth lines them up, pulling out a missing one along the neighbouring Anchors.",
    ),
  z
    .object({
      op: z.literal("add_anchor"),
      subpath,
      segment: z
        .number()
        .int()
        .min(0)
        .describe(
          "The segment from Anchor `segment` to the next; on a closed subpath the last is the closing segment.",
        ),
      t: z.number().gt(0).lt(1).describe("Where along the segment, as its curve parameter."),
    })
    .describe("Split a segment with a new Anchor, keeping its shape."),
  z
    .object({ op: z.literal("remove_anchor"), subpath, index })
    .describe("Remove an Anchor, joining its neighbours."),
  z.object({ op: z.literal("close"), subpath }).describe("Close a subpath with a segment."),
  z
    .object({ op: z.literal("open"), subpath })
    .describe("Open a closed subpath at its first Anchor, keeping its outline."),
  z
    .object({
      op: z.literal("reverse"),
      subpath: subpath.removeDefault().optional().describe("Omitted: every subpath."),
    })
    .describe("Reverse the direction; a closed subpath keeps its first Anchor."),
  z
    .object({ op: z.literal("set_d"), d: z.string() })
    .describe("Replace d as a whole; later ops see its Anchors."),
]);
export type PathOp = z.input<typeof PathOp>;

export const PathEditInput = z.object({
  nodeId: z.string().describe("A path's id."),
  ops: z.array(PathOp).min(1).max(1000).describe("Applied in order, each to the result so far."),
});
export type PathEditInput = z.input<typeof PathEditInput>;

/**
 * `path_op` (REQUIREMENTS §6.4) so far: convert_to_path (Object > Shape > Expand Shape), reverse
 * (Reverse Path Direction), add_anchors (Add Anchor Points), join (Join) and average (Average).
 */
export const PathOpInput = z.object({
  nodeIds: z.array(z.string()).min(1).max(1000),
  op: z.enum(["convert_to_path", "reverse", "add_anchors", "join", "average"]),
  tolerance: z
    .number()
    .min(0)
    .default(0.01)
    .describe(
      "join: Endpoints this close merge into one Anchor; farther ones get a straight segment.",
    ),
  axis: z
    .enum(["horizontal", "vertical", "both"])
    .default("both")
    .describe(
      "average: horizontal lines the Anchors up on one y, vertical on one x, both stacks them.",
    ),
  anchors: z
    .array(z.object({ nodeId: z.string(), subpath, index }))
    .max(10000)
    .optional()
    .describe(
      "join and average: the Anchors to act on, each of a Node in nodeIds. join takes two open Endpoints; omitted, join takes the whole paths and average every Anchor of nodeIds.",
    ),
});
export type PathOpInput = z.input<typeof PathOpInput>;

const invalid = (path: string, message: string, hint: string) =>
  new ZibelError({ code: "INVALID_PATH", message, hint, path });

const isEndpoint = (s: Subpath, i: number) => !s.closed && (i === 0 || i === s.anchors.length - 1);

/** Pulls both Handles out along one line through the Anchor (ADR-0032). */
function smooth(s: Subpath, i: number, at: string): void {
  const a = s.anchors[i] as Anchor;
  const n = s.anchors.length;
  const [x, y] = a.anchor;
  const unit = (p: Point | null, sign = 1): Point | null => {
    const l = p && Math.hypot(p[0] - x, p[1] - y);
    return p && l ? [(sign * (p[0] - x)) / l, (sign * (p[1] - y)) / l] : null;
  };
  const dist = (p: Point | null) => (p ? Math.hypot(p[0] - x, p[1] - y) : 0);
  const prev = (s.anchors[(i + n - 1) % n] as Anchor).anchor;
  const next = (s.anchors[(i + 1) % n] as Anchor).anchor;
  const out = unit(a.handleOut);
  const back = unit(a.handleIn, -1);
  let d: Point | null =
    out && back ? unit([x + out[0] + back[0], y + out[1] + back[1]]) : (out ?? back);
  d ??= unit([x + next[0] - prev[0], y + next[1] - prev[1]]);
  const lin = dist(a.handleIn) || dist(prev) / 3;
  const lout = dist(a.handleOut) || dist(next) / 3;
  if (!d || !lin || !lout) {
    throw invalid(
      at,
      "The Anchor has no direction to smooth along.",
      "Its neighbours sit on it; give it Handles with set_handles instead.",
    );
  }
  a.handleIn = [x - d[0] * lin, y - d[1] * lin];
  a.handleOut = [x + d[0] * lout, y + d[1] * lout];
}

/** One op on the subpaths, in place. */
function apply(subpaths: Subpath[], op: z.output<typeof PathOp>, at: string): Subpath[] {
  if (op.op === "set_d") return toAnchors(parsePath(op.d, `${at}.d`));
  if (op.op === "reverse") {
    for (const [k, s] of subpaths.entries()) {
      if (op.subpath !== undefined && op.subpath !== k) continue;
      const flipped = s.anchors
        .map((a) => ({ ...a, handleIn: a.handleOut, handleOut: a.handleIn }))
        .reverse();
      // A closed subpath keeps its start.
      s.anchors = s.closed ? [...flipped.slice(-1), ...flipped.slice(0, -1)] : flipped;
    }
    if (op.subpath !== undefined && !subpaths[op.subpath]) throw noSubpath(subpaths, at);
    return subpaths;
  }
  const s = subpaths[op.subpath];
  if (!s) throw noSubpath(subpaths, at);
  const n = s.anchors.length;
  const anchorAt = (i: number) => {
    const a = s.anchors[i];
    if (a) return a;
    throw invalid(
      `${at}.index`,
      `Subpath ${op.subpath} has no Anchor ${i}.`,
      `Its Anchors are 0 to ${n - 1}; path_edit returns each subpath's Anchors.`,
    );
  };
  switch (op.op) {
    case "move_anchor": {
      const a = anchorAt(op.index);
      const [dx, dy] = [op.to[0] - a.anchor[0], op.to[1] - a.anchor[1]];
      const by = (p: Point | null): Point | null => p && [p[0] + dx, p[1] + dy];
      Object.assign(a, { anchor: op.to, handleIn: by(a.handleIn), handleOut: by(a.handleOut) });
      break;
    }
    case "set_handles": {
      const a = anchorAt(op.index);
      for (const key of ["handleIn", "handleOut"] as const) {
        const h = op[key];
        if (h === undefined) continue;
        const missing = key === "handleIn" ? op.index === 0 : op.index === n - 1;
        if (h && !s.closed && missing) {
          throw invalid(
            `${at}.${key}`,
            `An Endpoint of an open subpath has no ${key}.`,
            "Close the subpath with close first, or set the other Handle.",
          );
        }
        a[key] = h && handle(h, a.anchor);
      }
      break;
    }
    case "set_point_type": {
      const a = anchorAt(op.index);
      if (op.type === "corner") [a.handleIn, a.handleOut] = [null, null];
      else if (isEndpoint(s, op.index)) {
        throw invalid(
          `${at}.index`,
          "An Endpoint of an open subpath has one Handle, so it is always a Corner (ADR-0032).",
          "Pull its Handle out with set_handles, or close the subpath first.",
        );
      } else if (typeOf(a) !== "smooth") smooth(s, op.index, `${at}.index`);
      break;
    }
    case "add_anchor": {
      const closing = s.closed && op.segment === n - 1;
      const a = s.anchors[op.segment];
      const b = s.anchors[closing ? 0 : op.segment + 1];
      if (!a || !b) {
        throw invalid(
          `${at}.segment`,
          `Subpath ${op.subpath} has no segment ${op.segment}.`,
          `Its segments are 0 to ${s.closed ? n - 1 : n - 2}: segment k runs from Anchor k to the next.`,
        );
      }
      const { t } = op;
      const [p0, p3] = [a.anchor, b.anchor];
      const [c1, c2] = [a.handleOut ?? p0, b.handleIn ?? p3];
      // de Casteljau: the two halves are the same curve.
      const [ab, bc, cd] = [lerp(p0, c1, t), lerp(c1, c2, t), lerp(c2, p3, t)];
      const [abc, bcd] = [lerp(ab, bc, t), lerp(bc, cd, t)];
      const line = !a.handleOut && !b.handleIn;
      const mid = line ? lerp(p0, p3, t) : lerp(abc, bcd, t);
      if (a.handleOut) a.handleOut = ab;
      if (b.handleIn) b.handleIn = cd;
      const added = line
        ? { anchor: mid, handleIn: null, handleOut: null }
        : { anchor: mid, handleIn: handle(abc, mid), handleOut: handle(bcd, mid) };
      s.anchors.splice(op.segment + 1, 0, added as Anchor);
      break;
    }
    case "remove_anchor": {
      anchorAt(op.index);
      if (n === 1) {
        if (subpaths.length === 1) {
          throw invalid(
            `${at}.index`,
            "It is the path's last Anchor.",
            "Delete the path with node_delete instead.",
          );
        }
        subpaths.splice(op.subpath, 1);
        break;
      }
      s.anchors.splice(op.index, 1);
      if (!s.closed) {
        (s.anchors[0] as Anchor).handleIn = null;
        (s.anchors.at(-1) as Anchor).handleOut = null;
      }
      break;
    }
    case "close": {
      if (s.closed) break;
      const [first] = s.anchors as [Anchor];
      const last = s.anchors.at(-1) as Anchor;
      if (n > 1 && same(first.anchor, last.anchor)) {
        first.handleIn = last.handleIn;
        s.anchors.pop();
      }
      s.closed = true;
      break;
    }
    case "open": {
      if (!s.closed) break;
      const [first] = s.anchors as [Anchor];
      const last = s.anchors.at(-1) as Anchor;
      // The closing segment becomes an ordinary one, ending on a copy of the first Anchor.
      const degenerate = !last.handleOut && !first.handleIn && same(first.anchor, last.anchor);
      if (!degenerate || n === 1) {
        s.anchors.push({
          anchor: first.anchor,
          handleIn: first.handleIn,
          handleOut: null,
        } as Anchor);
      }
      first.handleIn = null;
      s.closed = false;
      break;
    }
  }
  return subpaths;
}

const noSubpath = (subpaths: Subpath[], at: string) =>
  invalid(
    `${at}.subpath`,
    `The path has ${subpaths.length} ${subpaths.length === 1 ? "subpath" : "subpaths"}.`,
    `Use a subpath from 0 to ${subpaths.length - 1}, in d's order: each M starts one.`,
  );

type LiveShape = Exclude<ShapeNode, PathNode>;
/** A rect, ellipse, line, polygon or star: its outline comes from its parameters. */
export const isLiveShape = (node: Node): node is LiveShape =>
  node.type in SHAPES && node.type !== "path";

/**
 * Convert to Path (ADR-0032): a Live Shape keeps its id, parent, `index`, name and appearance, and
 * swaps its parameters for the `d` its outline gives. Undo removes the added keys (ADR-0011).
 */
function toPath(node: LiveShape): PathNode {
  const out: Record<string, unknown> = { ...node };
  for (const key of Object.keys(SHAPES[node.type].shape)) delete out[key];
  return {
    ...out,
    type: "path",
    d: formatPath(shapeSegments(node)),
    fillRule: "nonzero",
  } as PathNode;
}

/** The path or Live Shape `id` names, or INVALID_PATH for a Node without Anchors. */
function withAnchors(doc: Document, id: string, at: string): PathNode | LiveShape {
  const node = lookup(doc, id, at);
  if (node.type === "path" || isLiveShape(node)) return node;
  throw invalid(at, `A ${node.type} has no Anchors.`, "Name a path or a Live Shape.");
}

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

const converted = (node: LiveShape) => ({
  code: "CONVERTED_TO_PATH",
  nodeId: node.id,
  message: `The ${node.type} was converted to a path first: it keeps its id, and its parameters are gone.`,
});

/** Each subpath's segments split at t = 0.5, last first so the indices ahead stay put. */
function addAnchors(subpaths: Subpath[]): Subpath[] {
  for (const [k, s] of subpaths.entries()) {
    for (let i = (s.closed ? s.anchors.length : s.anchors.length - 1) - 1; i >= 0; i--) {
      apply(subpaths, { op: "add_anchor", subpath: k, segment: i, t: 0.5 }, "");
    }
  }
  return subpaths;
}

type Ref = { nodeId: string; subpath: number; index: number };
type PathOpResult = {
  updated: PathNode[];
  deletedIds: string[];
  warnings: WriteReceipt["warnings"];
};
type WithAnchors = PathNode | LiveShape;

/** The Node as a path, converted if it is a Live Shape, and its Anchors mapped by `m`. */
function anchorsIn(node: WithAnchors, m: Matrix = IDENTITY) {
  const path = isLiveShape(node) ? toPath(node) : node;
  return { node, path, subpaths: toAnchors(transformSegments(parsePath(path.d, "d"), m)) };
}

/** Each Node's place in paint order, bottom first. */
function paintOrder(doc: Document): Map<string, number> {
  const order = new Map<string, number>();
  const walk = (parentId: string | null) => {
    for (const n of childrenOf(doc, parentId)) {
      order.set(n.id, order.size);
      walk(n.id);
    }
  };
  walk(null);
  return order;
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

const flip = (s: Subpath) => apply([structuredClone(s)], { op: "reverse" }, "")[0] as Subpath;

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
 * keeping its Handle; farther ones get a straight segment. Joins are Corner (research §5).
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
  return { closed: false, anchors: anchors.map((x) => ({ ...x, type: typeOf(x) })) };
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

const JOIN_HINT = "Name two open Endpoints in anchors, or omit anchors to join whole open paths.";

/**
 * `path_op join` (research §5): two named Endpoints connect; whole paths join their open subpaths
 * closest Endpoints first until one is left, and one open path alone closes. The topmost path takes
 * the result with every subpath of the others, keeping its appearance; the others are deleted.
 */
function join(doc: Document, input: z.output<typeof PathOpInput>): PathOpResult {
  const { tolerance } = input;
  const refs = checkRefs(input.anchors, input.nodeIds);
  const named = allWithAnchors(doc, input.nodeIds);
  const order = paintOrder(doc);
  // Everything in the topmost Node's coordinates.
  const gather = (nodes: WithAnchors[]) => {
    const top = nodes.reduce((a, b) => ((order.get(b.id) ?? 0) > (order.get(a.id) ?? 0) ? b : a));
    const toTop = invert(worldTransform(doc, top));
    const each = nodes.map((n) => anchorsIn(n, multiply(toTop, worldTransform(doc, n))));
    return { top, each };
  };
  const done = (top: WithAnchors, subpaths: Subpath[], nodes: WithAnchors[]): PathOpResult => {
    const next = { ...anchorsIn(top).path, d: formatPath(fromAnchors(subpaths)) };
    const deletedIds = nodes.filter((n) => n !== top).map((n) => n.id);
    for (const id of deletedIds) doc.nodes.delete(id);
    doc.nodes.set(next.id, next);
    return { updated: [next], deletedIds, warnings: isLiveShape(top) ? [converted(top)] : [] };
  };

  if (refs) {
    const nodes = named.filter((n) => refs.some((r) => r.nodeId === n.id));
    const { top, each } = gather(nodes);
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
  const { top, each } = gather(nodes);
  const closed = each.flatMap((e) => e.subpaths.filter((s) => s.closed));
  // The topmost Node's open subpaths first, so the result keeps its direction.
  const chains = [...each]
    .sort((a, b) => Number(b.node === top) - Number(a.node === top))
    .flatMap((e) => e.subpaths.filter((s) => !s.closed));
  if (chains.length === 1)
    return done(top, [closeWithin(chains[0] as Subpath, tolerance), ...closed], nodes);
  while (chains.length > 1) {
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
    const { i, j, aEnd, bEnd } = best;
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
  const refs = [...new Map(listed.map((r) => [`${r.nodeId} ${r.subpath} ${r.index}`, r])).values()];
  const nodes = named.filter((n) => refs.some((r) => r.nodeId === n.id));
  const each = new Map(nodes.map((n) => [n.id, { ...anchorsIn(n), m: worldTransform(doc, n) }]));
  const world = refs.map((r, i) => {
    const e = each.get(r.nodeId);
    const a = e?.subpaths[r.subpath]?.anchors[r.index];
    if (!e || !a) {
      throw invalid(
        `anchors[${i}]`,
        `The Node has no Anchor ${r.index} in subpath ${r.subpath}.`,
        "zibel_path_edit returns each subpath's Anchors.",
      );
    }
    return applyTo(e.m, ...a.anchor);
  });
  const mean = (k: 0 | 1) => world.reduce((sum, p) => sum + p[k], 0) / world.length;
  const [mx, my] = [mean(0), mean(1)];
  refs.forEach(({ nodeId, subpath, index }, i) => {
    const { m, subpaths } = each.get(nodeId) as { m: Matrix; subpaths: Subpath[] };
    const [wx, wy] = world[i] as Point;
    const x = input.axis === "horizontal" ? wx : mx;
    const y = input.axis === "vertical" ? wy : my;
    apply(subpaths, { op: "move_anchor", subpath, index, to: applyTo(invert(m), x, y) }, "");
  });
  const updated = [...each.values()].map(({ path, subpaths }) => ({
    ...path,
    d: formatPath(fromAnchors(subpaths)),
  }));
  for (const node of updated) doc.nodes.set(node.id, node);
  return { updated, deletedIds: [], warnings: nodes.filter(isLiveShape).map(converted) };
}

/**
 * `path_op` (REQUIREMENTS §6.4) on each path or Live Shape; every op but convert_to_path converts a
 * Live Shape first (F-PATH-07), with a warning.
 */
export function pathOp(doc: Document, raw: PathOpInput): PathOpResult {
  const input = PathOpInput.parse(raw);
  const { nodeIds, op } = input;
  if (op === "convert_to_path") {
    return { ...convertToPath(doc, nodeIds), deletedIds: [], warnings: [] };
  }
  if (op === "join") return join(doc, input);
  if (op === "average") return average(doc, input);
  const unique = allWithAnchors(doc, nodeIds);
  const updated = unique.map((found) => {
    const node = isLiveShape(found) ? toPath(found) : found;
    const subpaths = toAnchors(parsePath(node.d, "d"));
    const next = op === "reverse" ? apply(subpaths, { op: "reverse" }, "") : addAnchors(subpaths);
    return { ...node, d: formatPath(fromAnchors(next)) };
  });
  for (const node of updated) doc.nodes.set(node.id, node);
  return { updated, deletedIds: [], warnings: unique.filter(isLiveShape).map(converted) };
}

/**
 * `path_edit` (REQUIREMENTS §6.4): applies the ops in order to a path's Anchors and writes its `d`,
 * or throws before changing anything. A Live Shape is converted first (F-PATH-07), with a warning.
 * Returns the new Node and its Anchors as stored.
 */
export function editPath(
  doc: Document,
  raw: PathEditInput,
): {
  node: PathNode;
  subpaths: (Subpath & { anchors: (Anchor & { index: number })[] })[];
  warnings: WriteReceipt["warnings"];
} {
  const input = PathEditInput.parse(raw);
  const found = withAnchors(doc, input.nodeId, "nodeId");
  const node = isLiveShape(found) ? toPath(found) : found;
  let subpaths = toAnchors(parsePath(node.d, "d"));
  input.ops.forEach((op, i) => {
    subpaths = apply(subpaths, op, `ops[${i}]`);
  });
  const d = formatPath(fromAnchors(subpaths));
  const next: PathNode = { ...node, d };
  doc.nodes.set(next.id, next);
  const stored = toAnchors(parsePath(d, "d"));
  return {
    node: next,
    subpaths: stored.map((s) => ({
      ...s,
      anchors: s.anchors.map((a, index) => ({ index, ...a })),
    })),
    warnings: isLiveShape(found) ? [converted(found)] : [],
  };
}
