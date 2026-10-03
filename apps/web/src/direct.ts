import {
  type Anchor,
  applyTo,
  type BareAnchor,
  childrenOf,
  type Document,
  editSubpaths,
  formatPath,
  fromAnchors,
  invert,
  isLiveShape,
  type Matrix,
  type Node,
  type PathEditInput,
  PathOp,
  type Rect,
  runsClockwise,
  type ShapeNode,
  type Subpath,
  shapeSegments,
  toAnchors,
  worldTransform,
} from "@kalamo/core";
import type { Endpoint } from "./receive.ts";
import { editable, pathTargets } from "./selection.ts";

/** Direct Selection (research §4): Anchors, Handles and segments of paths and Live Shapes. */

type Point = [number, number];
type Which = "handleIn" | "handleOut";

/**
 * One selected Anchor as UI state, like the Selection: its Node, subpath and index. A selected
 * segment's key names the Anchor it starts at (ADR-0045).
 */
export const anchorKey = (nodeId: string, subpath: number, index: number) =>
  `${nodeId} ${subpath} ${index}`;
export function parseKey(key: string) {
  const [index, subpath, ...id] = key.split(" ").reverse();
  return { nodeId: id.reverse().join(" "), subpath: Number(subpath), index: Number(index) };
}
type Ref = ReturnType<typeof parseKey>;

/** The keys by Node, in first-seen order. */
function byNode(keys: string[]): Map<string, Ref[]> {
  const out = new Map<string, Ref[]>();
  for (const r of keys.map(parseKey)) out.set(r.nodeId, [...(out.get(r.nodeId) ?? []), r]);
  return out;
}

export const hasAnchors = (n: Node | undefined): n is ShapeNode =>
  !!n && (n.type === "path" || isLiveShape(n));

/** Its Anchors in its own coordinates, as `path_edit` numbers them. */
export const localAnchors = (n: ShapeNode) => toAnchors(shapeSegments(n));

/** Anchor `a`, its Handles too, through `m`. */
export const through = <A extends BareAnchor>(m: Matrix, a: A): A => ({
  ...a,
  anchor: applyTo(m, ...a.anchor),
  handleIn: a.handleIn && applyTo(m, ...a.handleIn),
  handleOut: a.handleOut && applyTo(m, ...a.handleOut),
});

/** How Node `id` maps its own coordinates into the Document's. */
export const worldOf = (doc: Document, id: string) =>
  worldTransform(doc, doc.nodes.get(id) as Node);

/** Its Anchors in document coordinates. */
export function anchorsOf(doc: Document, n: ShapeNode): Subpath[] {
  const m = worldTransform(doc, n);
  return localAnchors(n).map((s) => ({ ...s, anchors: s.anchors.map((a) => through(m, a)) }));
}

export const allKeys = (n: ShapeNode) =>
  localAnchors(n).flatMap((s, k) => s.anchors.map((_, i) => anchorKey(n.id, k, i)));

/**
 * Every visible, unlocked path and Live Shape, in the isolated Node `scope` if any, in order: an
 * isolated leaf is the only one (ADR-0058).
 */
export function editableShapes(doc: Document, scope: string | null): ShapeNode[] {
  const walk = (n: Node): ShapeNode[] => {
    if (!n.visible || n.locked) return [];
    return hasAnchors(n) ? [n] : childrenOf(doc, n.id).flatMap(walk);
  };
  const root = doc.nodes.get(scope ?? "");
  return root ? walk(root) : childrenOf(doc, null).flatMap(walk);
}

/** Segment k runs from Anchor k to the next; a closed subpath's last is the closing segment. */
const segmentEnds = (s: Subpath, k: number) =>
  [s.anchors[k], s.anchors[(k + 1) % s.anchors.length]] as [Anchor, Anchor];
const segmentCount = (s: Subpath) => (s.closed ? s.anchors.length : s.anchors.length - 1);

function bezier(a: Anchor, b: Anchor, t: number): Point {
  const [p0, p3] = [a.anchor, b.anchor];
  const [c1, c2] = [a.handleOut ?? p0, b.handleIn ?? p3];
  const u = 1 - t;
  const at = (k: 0 | 1) =>
    u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p3[k];
  return [at(0), at(1)];
}

/** The segment nearest (x, y), where along it, and how far, by 32 chords per segment. */
export function nearestSegment(subpaths: Subpath[], x: number, y: number) {
  let best: { subpath: number; segment: number; t: number; dist: number } | null = null;
  const N = 32;
  for (const [s, sub] of subpaths.entries()) {
    for (let k = 0; k < segmentCount(sub); k++) {
      const [a, b] = segmentEnds(sub, k);
      let prev = a.anchor;
      for (let j = 1; j <= N; j++) {
        const q = bezier(a, b, j / N);
        const [ux, uy] = [q[0] - prev[0], q[1] - prev[1]];
        const len2 = ux * ux + uy * uy;
        const u = len2
          ? Math.max(0, Math.min(1, ((x - prev[0]) * ux + (y - prev[1]) * uy) / len2))
          : 0;
        const dist = Math.hypot(prev[0] + u * ux - x, prev[1] + u * uy - y);
        if (!best || dist < best.dist) best = { subpath: s, segment: k, t: (j - 1 + u) / N, dist };
        prev = q;
      }
    }
  }
  return best;
}

export type Target =
  | { kind: "handle"; key: string; which: Which }
  | { kind: "anchor"; key: string }
  | { kind: "segment"; nodeId: string; subpath: number; segment: number; t: number };

/** The Handles a selected segment shows: its start's out and its end's in, as Anchor keys. */
export function segmentHandles(doc: Document, key: string): { key: string; which: Which }[] {
  const { nodeId, subpath, index } = parseKey(key);
  const n = doc.nodes.get(nodeId);
  const s = hasAnchors(n) ? localAnchors(n)[subpath] : undefined;
  if (!s || !Number.isInteger(index) || index < 0 || index >= segmentCount(s)) return [];
  const next = (index + 1) % s.anchors.length;
  return [
    { key: anchorKey(nodeId, subpath, index), which: "handleOut" },
    { key: anchorKey(nodeId, subpath, next), which: "handleIn" },
  ];
}

/**
 * What a Direct Selection press at (x, y) grabs within `tolerance`: a Handle a selected Anchor or
 * segment shows, else an Anchor (a selected path's first), else the topmost segment, of the paths
 * in the isolated Node `scope` if any. Null for none.
 */
export function pick(
  doc: Document,
  {
    selection,
    anchors,
    segments = [],
    x,
    y,
    tolerance,
    scope,
  }: {
    selection: string[];
    anchors: string[];
    segments?: string[];
    x: number;
    y: number;
    tolerance: number;
    scope: string | null;
  },
): Target | null {
  const near = (p: Point | null) => !!p && Math.hypot(p[0] - x, p[1] - y) <= tolerance;
  const handles = [
    ...anchors.flatMap((key) =>
      (["handleIn", "handleOut"] as const).map((which) => ({ key, which })),
    ),
    ...segments.flatMap((key) => segmentHandles(doc, key)),
  ];
  for (const { key, which } of handles) {
    const { nodeId, subpath, index } = parseKey(key);
    const n = doc.nodes.get(nodeId);
    if (!hasAnchors(n) || !editable(doc, n)) continue;
    const a = anchorsOf(doc, n)[subpath]?.anchors[index];
    if (a && near(a[which])) return { kind: "handle", key, which };
  }
  const shapes = editableShapes(doc, scope).reverse();
  const selected = (n: ShapeNode) => selection.includes(n.id);
  for (const n of [...shapes.filter(selected), ...shapes.filter((n) => !selected(n))]) {
    for (const [s, sub] of anchorsOf(doc, n).entries()) {
      const i = sub.anchors.findIndex((a) => near(a.anchor));
      if (i >= 0) return { kind: "anchor", key: anchorKey(n.id, s, i) };
    }
  }
  for (const n of shapes) {
    const hit = nearestSegment(anchorsOf(doc, n), x, y);
    if (hit && hit.dist <= tolerance) {
      const { subpath, segment, t } = hit;
      return { kind: "segment", nodeId: n.id, subpath, segment, t };
    }
  }
  return null;
}

/** The Anchors of visible, unlocked paths and Live Shapes, in `scope` if any, inside `rect`. */
export function marqueeAnchors(doc: Document, rect: Rect, scope: string | null): string[] {
  const inside = ([x, y]: Point) =>
    rect.x <= x && x <= rect.x + rect.width && rect.y <= y && y <= rect.y + rect.height;
  return editableShapes(doc, scope).flatMap((n) =>
    anchorsOf(doc, n).flatMap((s, k) =>
      s.anchors.flatMap((a, i) => (inside(a.anchor) ? [anchorKey(n.id, k, i)] : [])),
    ),
  );
}

/** A move by (dx, dy) in document coordinates, in `n`'s own. */
export function localDelta(doc: Document, n: Node, dx: number, dy: number): Point {
  const inv = invert(worldTransform(doc, n));
  const [x0, y0] = applyTo(inv, 0, 0);
  const [x1, y1] = applyTo(inv, dx, dy);
  return [x1 - x0, y1 - y0];
}
export const plus = (p: Point, [dx, dy]: Point): Point => [p[0] + dx, p[1] + dy];

/** Moving the Anchors `keys` by (dx, dy): one `path_edit` per path. */
export function moveAnchors(doc: Document, keys: string[], dx: number, dy: number) {
  return [...byNode(keys)].flatMap(([nodeId, refs]): PathEditInput[] => {
    const n = doc.nodes.get(nodeId);
    if (!hasAnchors(n)) return [];
    const d = localDelta(doc, n, dx, dy);
    const subpaths = localAnchors(n);
    const ops = refs.flatMap(({ subpath, index }): PathOp[] => {
      const a = subpaths[subpath]?.anchors[index];
      return a ? [{ op: "move_anchor", subpath, index, to: plus(a.anchor, d) }] : [];
    });
    return ops.length > 0 ? [{ nodeId, ops }] : [];
  });
}

/**
 * Dragging one Handle by (dx, dy). A Smooth Anchor's other Handle turns to stay collinear and
 * keeps its length, as Illustrator's Direct Selection does; `alone` (Alt) leaves it, so the
 * Anchor becomes Corner.
 */
export function moveHandle(
  doc: Document,
  key: string,
  which: Which,
  dx: number,
  dy: number,
  alone: boolean,
): PathEditInput | null {
  const { nodeId, subpath, index } = parseKey(key);
  const n = doc.nodes.get(nodeId);
  const a = hasAnchors(n) ? localAnchors(n)[subpath]?.anchors[index] : undefined;
  const h = a?.[which];
  if (!n || !a || !h) return null;
  const to = plus(h, localDelta(doc, n, dx, dy));
  const handles: Partial<Record<Which, Point>> = { [which]: to };
  const other = which === "handleIn" ? "handleOut" : "handleIn";
  const o = a[other];
  const [ux, uy] = [to[0] - a.anchor[0], to[1] - a.anchor[1]];
  const l = Math.hypot(ux, uy);
  if (!alone && a.type === "smooth" && o && l) {
    const lo = Math.hypot(o[0] - a.anchor[0], o[1] - a.anchor[1]);
    handles[other] = [a.anchor[0] - (ux / l) * lo, a.anchor[1] - (uy / l) * lo];
  }
  return { nodeId, ops: [{ op: "set_handles", subpath, index, ...handles }] };
}

/**
 * Dragging a segment grabbed at `t` by (dx, dy) with Direct Selection: a straight one moves both
 * its Anchors; a curved one bends, as `bendSegment`.
 */
export function moveSegment(
  doc: Document,
  nodeId: string,
  subpath: number,
  segment: number,
  t: number,
  dx: number,
  dy: number,
): PathEditInput | null {
  const n = doc.nodes.get(nodeId);
  const s = hasAnchors(n) ? localAnchors(n)[subpath] : undefined;
  if (!n || !s || segment >= segmentCount(s)) return null;
  const [a, b] = segmentEnds(s, segment);
  if (a.handleOut || b.handleIn) return bendSegment(doc, nodeId, subpath, segment, t, dx, dy);
  const next = (segment + 1) % s.anchors.length;
  const d = localDelta(doc, n, dx, dy);
  return {
    nodeId,
    ops: [
      { op: "move_anchor", subpath, index: segment, to: plus(a.anchor, d) },
      { op: "move_anchor", subpath, index: next, to: plus(b.anchor, d) },
    ],
  };
}

/**
 * Bending a segment grabbed at `t` by (dx, dy): its inner Handles move so the grabbed point
 * follows the pointer, weighted as Inkscape does; a straight one pulls them out of its Anchors.
 * `semicircle` (Shift with the Anchor Point tool) sets them perpendicular to the segment and of
 * equal length instead, bulging to the pointer's side.
 */
export function bendSegment(
  doc: Document,
  nodeId: string,
  subpath: number,
  segment: number,
  t: number,
  dx: number,
  dy: number,
  semicircle = false,
): PathEditInput | null {
  const n = doc.nodes.get(nodeId);
  const s = hasAnchors(n) ? localAnchors(n)[subpath] : undefined;
  if (!n || !s || segment >= segmentCount(s)) return null;
  const [a, b] = segmentEnds(s, segment);
  const next = (segment + 1) % s.anchors.length;
  const d = localDelta(doc, n, dx, dy);
  // Near an end the weights blow up; that end's Anchor is grabbed there instead.
  const u = Math.max(0.05, Math.min(0.95, t));
  const c1 = a.handleOut ?? a.anchor;
  const c2 = b.handleIn ?? b.anchor;
  const set = (p: Point, q: Point): PathEditInput => ({
    nodeId,
    ops: [
      { op: "set_handles", subpath, index: segment, handleOut: p },
      { op: "set_handles", subpath, index: next, handleIn: q },
    ],
  });
  if (semicircle) {
    const chord: Point = [b.anchor[0] - a.anchor[0], b.anchor[1] - a.anchor[1]];
    const l = Math.hypot(...chord);
    if (!l) return null;
    const normal: Point = [-chord[1] / l, chord[0] / l];
    const at = bezier(a, b, u);
    const across =
      (at[0] + d[0] - a.anchor[0]) * normal[0] + (at[1] + d[1] - a.anchor[1]) * normal[1];
    // A cubic's semicircle has Handles 4/3 of its radius long.
    const h = Math.sign(across) * (2 / 3) * l;
    const off: Point = [normal[0] * h, normal[1] * h];
    return set(plus(a.anchor, off), plus(b.anchor, off));
  }
  const w =
    u <= 1 / 6
      ? 0
      : u <= 0.5
        ? ((6 * u - 1) / 2) ** 3 / 2
        : u <= 5 / 6
          ? (1 - ((6 * (1 - u) - 1) / 2) ** 3) / 2 + 0.5
          : 1;
  const k0 = (1 - w) / (3 * u * (1 - u) * (1 - u));
  const k1 = w / (3 * u * u * (1 - u));
  return set(plus(c1, [k0 * d[0], k0 * d[1]]), plus(c2, [k1 * d[0], k1 * d[1]]));
}

/**
 * Delete on Anchors and segments, as Illustrator does: an Anchor goes with the segments on both
 * sides, a segment alone, each opening the path there. A piece left with one Anchor would be a
 * Stray Point and goes too.
 */
export function deleteParts(
  subpaths: Subpath[],
  anchors: Pick<Ref, "subpath" | "index">[],
  segments: Pick<Ref, "subpath" | "index">[] = [],
): Subpath[] {
  return subpaths.flatMap((s, k) => {
    const has = (refs: typeof anchors, i: number) =>
      refs.some((r) => r.subpath === k && r.index === i);
    const cutAnchor = s.anchors.map((_, i) => has(anchors, i));
    // Segment i starts at Anchor i; an open subpath's last Anchor starts none.
    const cutSegment = s.anchors.map((_, i) => has(segments, i) && i < segmentCount(s));
    const first = s.anchors.findIndex((_, i) => cutAnchor[i] || cutSegment[i]);
    if (first < 0) return [s];
    // A closed subpath is walked from just after a cut, so each piece is in order.
    const start = s.closed ? first + 1 : 0;
    const pieces: Anchor[][] = [[]];
    for (let j = 0; j < s.anchors.length; j++) {
      const i = (start + j) % s.anchors.length;
      if (cutAnchor[i]) {
        pieces.push([]);
        continue;
      }
      pieces.at(-1)?.push({ ...(s.anchors[i] as Anchor) });
      if (cutSegment[i]) pieces.push([]);
    }
    return pieces
      .filter((p) => p.length >= 2)
      .map((anchors) => {
        (anchors[0] as Anchor).handleIn = null;
        (anchors.at(-1) as Anchor).handleOut = null;
        return { closed: false, anchors };
      });
  });
}

/** Whether `key` names an Anchor its Node has now. */
export function inRange(doc: Document, key: string): boolean {
  const { nodeId, subpath, index } = parseKey(key);
  const n = doc.nodes.get(nodeId);
  return hasAnchors(n) && !!localAnchors(n)[subpath]?.anchors[index];
}

/**
 * Where Anchor `key`, or with `segment` the segment starting there, is once its subpath is reversed,
 * if `subpaths` names it. Reversing twice is no change, so this also numbers a key back.
 */
export const reversedKey =
  (doc: Document, subpaths: SubpathRef[], segment: boolean) => (key: string) => {
    const { nodeId, subpath, index } = parseKey(key);
    const n = doc.nodes.get(nodeId);
    const sub = n?.type === "path" ? localAnchors(n)[subpath] : undefined;
    if (!sub || !subpaths.some((t) => t.nodeId === nodeId && t.subpath === subpath)) return key;
    const count = sub.anchors.length;
    // A closed subpath keeps its first Anchor; a segment now starts at its old end.
    const at = sub.closed
      ? (count - index - (segment ? 1 : 0)) % count
      : count - 1 - index - (segment ? 1 : 0);
    return anchorKey(nodeId, subpath, at);
  };

type SubpathRef = { nodeId: string; subpath: number };

/** Which way subpath `t` runs in `doc`; undefined when it is gone. */
function direction(doc: Document, t: SubpathRef) {
  const n = doc.nodes.get(t.nodeId);
  return n?.type === "path" ? runsClockwise(doc, n, t.subpath) : undefined;
}

/** Those of `subpaths` that run the other way in `doc` than in `prior`: a reverse reached them. */
export const turnedOf = (prior: Document, doc: Document, subpaths: SubpathRef[]) =>
  subpaths.filter((t) => direction(prior, t) !== direction(doc, t));

/** The key of the Anchor `t` is on, or of the Anchor its segment starts at. */
const keyOf = (t: Target) =>
  t.kind === "segment" ? anchorKey(t.nodeId, t.subpath, t.segment) : t.key;

/**
 * `t` as `doc` numbers it once its subpath is reversed, if `subpaths` names it: an Anchor is
 * renumbered, a Handle is its Anchor's other one, and a segment runs back from its old end. Every
 * key and target a Reverse Path Direction press's answer turns goes through this rule (ADR-0110).
 */
export const turnTarget =
  (doc: Document, subpaths: SubpathRef[]) =>
  <T extends Target>(t: T): T => {
    const at = keyOf(t);
    const { nodeId, subpath } = parseKey(at);
    if (!subpaths.some((s) => s.nodeId === nodeId && s.subpath === subpath)) return t;
    if (t.kind === "segment") {
      const { index } = parseKey(reversedKey(doc, subpaths, true)(at));
      return { ...t, segment: index, t: 1 - t.t };
    }
    const key = reversedKey(doc, subpaths, false)(at);
    if (t.kind === "anchor") return { ...t, key };
    return { ...t, key, which: t.which === "handleIn" ? "handleOut" : "handleIn" };
  };

/**
 * Where a command the browser built puts one path's Anchors (#298): by subpath, each Anchor's new
 * subpath and index, null once the command removed it; whether each subpath was closed; each new
 * subpath's Anchor count and whether it is closed, which say where its segments are; and the
 * segments an `add_anchor` split, by the Anchor each starts at, where, and whether it is a line.
 */
export interface Renumbering {
  nodeId: string;
  to: ([number, number] | null)[][];
  closed: boolean[];
  after: { count: number; closed: boolean }[];
  splits?: { at: [number, number]; t: number; line: boolean }[];
}

type Tag = { from?: [number, number] };

/** `n`'s Anchors, each tagged with its subpath and index, for `renumbering` to read once edited. */
export const tagged = (n: ShapeNode): Subpath[] =>
  localAnchors(n).map((s, k) => ({
    ...s,
    anchors: s.anchors.map((a, i): Anchor & Tag => ({ ...a, from: [k, i] })),
  }));

/** How `after`, worked out from `tagged(n)` keeping each Anchor's tag, renumbers `n`'s Anchors. */
export function renumbering(
  n: ShapeNode,
  after: Subpath[],
  splits: Renumbering["splits"] = [],
): Renumbering {
  const before = localAnchors(n);
  const to = before.map((s) => s.anchors.map((): [number, number] | null => null));
  for (const [j, s] of after.entries()) {
    for (const [i, a] of s.anchors.entries()) {
      const from = (a as Anchor & Tag).from;
      const row = from && to[from[0]];
      if (row && from) row[from[1]] = [j, i];
    }
  }
  return {
    nodeId: n.id,
    to,
    closed: before.map((s) => s.closed),
    after: after.map((s) => ({ count: s.anchors.length, closed: s.closed })),
    ...(splits.length > 0 && { splits }),
  };
}

const KEEPS_NUMBERING = new Set<PathOp["op"]>(["move_anchor", "set_handles", "set_point_type"]);
const NUMBERED = new Set<PathOp["op"]>([...KEEPS_NUMBERING, "add_anchor", "remove_anchor"]);

/**
 * How `input` renumbers its path's Anchors on `doc` (#298): undefined when its ops keep the
 * numbering, null when the browser cannot tell from its ops alone, as for a `set_d`, `open`,
 * `close` or `reverse`.
 */
export function renumberingOf(
  doc: Document | null,
  input: PathEditInput,
): Renumbering | null | undefined {
  if (input.ops.every((o) => KEEPS_NUMBERING.has(o.op))) return undefined;
  const n = doc?.nodes.get(input.nodeId);
  if (!hasAnchors(n) || !input.ops.every((o) => NUMBERED.has(o.op))) return null;
  try {
    const splits: Renumbering["splits"] = [];
    const after = input.ops.reduce((s, raw) => {
      const op = PathOp.parse(raw);
      if (op.op === "add_anchor") {
        const sub = s[op.subpath];
        const a = sub?.anchors[op.segment] as (Anchor & Tag) | undefined;
        const b = sub?.anchors[(op.segment + 1) % sub.anchors.length];
        if (a?.from) splits.push({ at: a.from, t: op.t, line: !a.handleOut && !b?.handleIn });
      }
      return editSubpaths(s, op, "");
    }, tagged(n));
    return renumbering(n, after, splits);
  } catch {
    return null;
  }
}

/** Whether `r` was worked out on `doc`'s numbering of its path: the same subpaths and Anchor counts. */
export function fits(doc: Document | null, r: Renumbering): boolean {
  const n = doc?.nodes.get(r.nodeId);
  const subpaths = hasAnchors(n) ? localAnchors(n) : [];
  return (
    subpaths.length === r.to.length &&
    subpaths.every((s, k) => s.anchors.length === r.to[k]?.length && s.closed === r.closed[k])
  );
}

/**
 * How far along a line `t` is: `nearestSegment` reads a line as a cubic with its Handles on its
 * ends, and `add_anchor`'s `t` on a line runs along it.
 */
export const alongLine = (t: number) => 3 * t ** 2 - 2 * t ** 3;

/**
 * `t` as the answer to the command `r` describes numbers it (#298): an Anchor or Handle is on its
 * Anchor's new index, and a segment on the segment between its two Anchors while they are still
 * next to each other; with `onSplit`, a point on a segment one `add_anchor` split is on the half it
 * lies on, at the same place. Null once the command removed the Anchor or merged the segment.
 */
const renumber =
  (r: Renumbering | null, onSplit: boolean) =>
  <T extends Target>(t: T): T | null => {
    const { nodeId, subpath, index } = parseKey(keyOf(t));
    if (r?.nodeId !== nodeId) return t;
    const row = r.to[subpath] ?? [];
    const at = row[index];
    if (!at) return null;
    if (t.kind !== "segment") return { ...t, key: anchorKey(nodeId, ...at) };
    const next = row[(index + 1) % row.length];
    const s = r.after[at[0]];
    if (!s || !next || next[0] !== at[0] || !(r.closed[subpath] || index + 1 < row.length)) {
      return null;
    }
    const after = (k: number) => (k + 1 < s.count ? k + 1 : s.closed ? 0 : -1);
    if (next[1] === after(at[1])) return { ...t, subpath: at[0], segment: at[1] };
    // Split by one Anchor, the segment is two; the point pressed is on one of them.
    const split = r.splits?.filter((x) => x.at[0] === subpath && x.at[1] === index);
    const [only] = split ?? [];
    if (!onSplit || split?.length !== 1 || !only || next[1] !== after(after(at[1]))) return null;
    const along = only.line ? alongLine(t.t) : t.t;
    const first = along < only.t;
    const u = first ? along / only.t : (along - only.t) / (1 - only.t);
    return {
      ...t,
      subpath: at[0],
      segment: first ? at[1] : after(at[1]),
      // `alongLine`'s inverse.
      t: only.line ? 0.5 - Math.sin(Math.asin(1 - 2 * u) / 3) : u,
    };
  };

/**
 * `t` renumbered as `renumber` does, a point on a split segment kept. Every held target and
 * `grabbed` the answer to a command the browser can number renumbers goes through this rule, and
 * every key through `renumberKey` (ADR-0110).
 */
export const renumberTarget = (r: Renumbering | null) => renumber(r, true);

/**
 * Anchor `key`, or with `segment` the segment starting there, renumbered as `renumberTarget` does. A
 * selected segment split in two goes: it would be one half or both, which the person never chose.
 */
export const renumberKey = (r: Renumbering | null, segment: boolean) => (key: string) => {
  const { nodeId, subpath, index } = parseKey(key);
  const t = renumber(
    r,
    false,
  )<Target>(
    segment ? { kind: "segment", nodeId, subpath, segment: index, t: 0 } : { kind: "anchor", key },
  );
  return t && keyOf(t);
};

/**
 * An unsent preview's `input` with each op's Anchor renumbered as `renumberTarget` does. An op on an
 * Anchor the command removed goes, and so does an input left with none.
 */
export function renumberInput(r: Renumbering | null, input: PathEditInput): PathEditInput | null {
  if (r?.nodeId !== input.nodeId) return input;
  const ops = input.ops.flatMap((op): PathOp[] => {
    if (!("index" in op)) return [];
    const key = renumberKey(r, false)(anchorKey(input.nodeId, op.subpath ?? 0, op.index));
    if (!key) return [];
    const { subpath, index } = parseKey(key);
    return [{ ...op, subpath, index }];
  });
  return ops.length > 0 ? { ...input, ops } : null;
}

/** The path `t` is on. */
export const targetNode = (t: Target) => (t.kind === "segment" ? t.nodeId : parseKey(t.key).nodeId);

/** What `t` stands on, as Direct Selection keys, which a press's answer renumbers (ADR-0110). */
export const targetKeys = (t: Target): { anchors: string[]; segments: string[] } =>
  t.kind === "segment"
    ? { anchors: [], segments: [keyOf(t)] }
    : { anchors: [keyOf(t)], segments: [] };

/** Whether `key` names a segment its Node has now. */
export const segmentInRange = (doc: Document, key: string) => segmentHandles(doc, key).length > 0;

/**
 * Edit > Clear under Direct Selection: a `set_d` per path with selected Anchors or segments, and
 * the ids to delete: paths left without a segment, and selected objects with neither selected.
 * Keys out of range are ignored, never sent as a no-op that would convert a Live Shape.
 */
export function clearInputs(
  doc: Document,
  selection: string[],
  anchors: string[],
  segments: string[] = [],
) {
  const edits: PathEditInput[] = [];
  const known: Renumbering[] = [];
  const anchorsBy = byNode(anchors);
  const segmentsBy = byNode(segments);
  const deleteIds = selection.filter(
    (id) => !anchorsBy.has(id) && !segmentsBy.has(id) && editable(doc, doc.nodes.get(id)),
  );
  for (const nodeId of new Set([...anchorsBy.keys(), ...segmentsBy.keys()])) {
    const n = doc.nodes.get(nodeId);
    const key = (r: Ref) => anchorKey(nodeId, r.subpath, r.index);
    const liveAnchors = (anchorsBy.get(nodeId) ?? []).filter((r) => inRange(doc, key(r)));
    const liveSegments = (segmentsBy.get(nodeId) ?? []).filter((r) => segmentInRange(doc, key(r)));
    if (!hasAnchors(n) || !editable(doc, n) || liveAnchors.length + liveSegments.length === 0) {
      continue;
    }
    const left = deleteParts(tagged(n), liveAnchors, liveSegments);
    if (left.length === 0) deleteIds.push(nodeId);
    else {
      edits.push({ nodeId, ops: [{ op: "set_d", d: formatPath(fromAnchors(left)) }] });
      known.push(renumbering(n, left));
    }
  }
  return { edits, deleteIds, known };
}

/**
 * Object > Path > Remove Anchor Points (research §5): a `remove_anchor` per selected Anchor, last
 * first so the indices ahead stay put, joining its neighbours. A subpath left with one Anchor, a
 * Stray Point, goes whole, and a path left with none is deleted. Keys out of range are ignored.
 */
export function removeAnchorInputs(doc: Document, anchors: string[]) {
  const edits: PathEditInput[] = [];
  const deleteIds: string[] = [];
  for (const [nodeId, refs] of byNode(anchors)) {
    const n = doc.nodes.get(nodeId);
    const live = refs.filter((r) => inRange(doc, anchorKey(nodeId, r.subpath, r.index)));
    if (!hasAnchors(n) || !editable(doc, n) || live.length === 0) continue;
    const subpaths = localAnchors(n);
    const gone = subpaths.map((s, k) => {
      const picked = new Set(live.filter((r) => r.subpath === k).map((r) => r.index));
      return s.anchors.length - picked.size < 2 ? new Set(s.anchors.keys()) : picked;
    });
    if (gone.every((picked, k) => picked.size === subpaths[k]?.anchors.length)) {
      deleteIds.push(nodeId);
      continue;
    }
    const ops = gone
      .flatMap((picked, subpath) =>
        [...picked]
          .sort((x, y) => x - y)
          .map((index): PathOp => ({ op: "remove_anchor", subpath, index })),
      )
      .reverse();
    edits.push({ nodeId, ops });
  }
  return { edits, deleteIds };
}

/**
 * What Object > Path > Join or Average acts on (research §5): the selected Anchors and their Nodes,
 * else the Selection's paths. Join takes a path with every Anchor selected as a whole path, but a
 * Stray Point as an Endpoint. Null for nothing.
 */
export function anchorOpTargets(
  doc: Document,
  selection: string[],
  anchors: string[],
  op: "join" | "average",
): { nodeIds: string[]; anchors?: Ref[] } | null {
  let keys = anchors.filter((k) => inRange(doc, k));
  if (op === "join") {
    // A Stray Point is always wholly selected, yet it is an Endpoint to connect.
    const stray = (k: string) => {
      const n = doc.nodes.get(parseKey(k).nodeId);
      return hasAnchors(n) && allKeys(n).length === 1;
    };
    const { partial } = splitWhole(doc, keys);
    keys = keys.filter((k) => partial.includes(k) || stray(k));
  }
  if (keys.length > 0) {
    const refs = keys.map(parseKey);
    return { nodeIds: [...new Set(refs.map((r) => r.nodeId))], anchors: refs };
  }
  const nodeIds = pathTargets(doc, selection);
  return nodeIds.length > 0 ? { nodeIds } : null;
}

/** The paths with every Anchor in `keys`, which move whole, and the keys of the rest. */
export function splitWhole(doc: Document, keys: string[]) {
  const whole: string[] = [];
  const partial: string[] = [];
  for (const [nodeId, refs] of byNode(keys)) {
    const n = doc.nodes.get(nodeId);
    const all = hasAnchors(n) ? allKeys(n) : [];
    const mine = refs.map((r) => anchorKey(nodeId, r.subpath, r.index));
    if (all.length > 0 && all.every((k) => mine.includes(k))) whole.push(nodeId);
    else partial.push(...mine);
  }
  return { whole, partial };
}

/**
 * What the Anchors bar converts (research 06 §4): the selected Anchors and each selected segment's
 * two ends, on paths partly selected. A path with every Anchor selected is selected whole, and
 * keys out of range are ignored.
 */
export function convertTargets(doc: Document, anchors: string[], segments: string[]) {
  const live = anchors.filter((k) => inRange(doc, k));
  const { whole } = splitWhole(doc, live);
  const keys = [...live, ...segments.flatMap((k) => segmentHandles(doc, k).map((h) => h.key))];
  return [...byNode([...new Set(keys)])].flatMap(([nodeId, refs]) =>
    whole.includes(nodeId) || !editable(doc, doc.nodes.get(nodeId))
      ? []
      : [{ nodeId, refs: refs.map(({ subpath, index }) => ({ subpath, index })) }],
  );
}

/**
 * Convert selected anchor points to corner or smooth: one `path_edit` of `set_point_type` per
 * path. An Anchor already that type is left out, and so is one smooth cannot turn: an open
 * subpath's Endpoint, or one with no direction to smooth along, which would fail the whole edit.
 */
export function convertInputs(
  doc: Document,
  anchors: string[],
  segments: string[],
  type: Anchor["type"],
): PathEditInput[] {
  return convertTargets(doc, anchors, segments).flatMap(({ nodeId, refs }) => {
    const subpaths = localAnchors(doc.nodes.get(nodeId) as ShapeNode);
    const ops = refs
      .filter(({ subpath, index }) => {
        const s = subpaths[subpath] as Subpath;
        const a = s.anchors[index] as Anchor;
        if (type === "corner") return !!(a.handleIn || a.handleOut);
        if (a.type === "smooth") return false;
        try {
          editSubpaths(
            structuredClone(subpaths),
            { op: "set_point_type", subpath, index, type },
            "",
          );
          return true;
        } catch {
          return false;
        }
      })
      .sort((x, y) => x.subpath - y.subpath || x.index - y.index)
      .map((r): PathOp => ({ op: "set_point_type", ...r, type }));
    return ops.length > 0 ? [{ nodeId, ops }] : [];
  });
}

/** The subpath reversed: its Anchors in the other order, each Handle swapped for the other. */
export const flip = (anchors: BareAnchor[]) =>
  anchors
    .map((a): BareAnchor => ({ anchor: a.anchor, handleIn: a.handleOut, handleOut: a.handleIn }))
    .reverse();

/** A `set_d` putting `anchors`, in document coordinates and ending at `e`, in place of its subpath. */
export function replaceSubpath(
  doc: Document,
  e: Endpoint,
  anchors: BareAnchor[],
  closed: boolean,
): PathEditInput {
  const n = doc.nodes.get(e.nodeId);
  if (!n || !hasAnchors(n)) throw new Error(`${e.nodeId} has no Anchors.`);
  const m = invert(worldTransform(doc, n));
  const all: { closed: boolean; anchors: BareAnchor[] }[] = localAnchors(n);
  // Back in the subpath's own direction.
  all[e.subpath] = {
    closed,
    anchors: (e.atStart ? flip(anchors) : anchors).map((a) => through(m, a)),
  };
  return { nodeId: e.nodeId, ops: [{ op: "set_d", d: formatPath(fromAnchors(all)) }] };
}
