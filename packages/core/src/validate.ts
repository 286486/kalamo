import { z } from "zod";
import { childrenOf, isOpacityMask, touches, visibleBounds, worldOutline } from "./document.ts";
import { artboardOf, lookup } from "./edit.ts";
import type { Segment } from "./path.ts";
import {
  ArtboardScope,
  type Document,
  type Node,
  NodesScope,
  type Point,
  type Rect,
} from "./schema.ts";
import { textWarnings } from "./text.ts";

/** `validate`'s rules (ADR-0105), in the order a Node's issues are listed. */
export const ValidateRule = z.enum([
  "font_missing",
  "missing_glyphs",
  "text_overflow",
  "missing_link",
  "zero_area",
  "empty_group",
  "outside_artboards",
]);
export type ValidateRule = z.infer<typeof ValidateRule>;

/** `render`'s `{artboardId}` and `{nodeIds}` scopes. */
export const ValidateScope = z.union([ArtboardScope, NodesScope]);
export type ValidateScope = z.infer<typeof ValidateScope>;

export interface ValidateOptions {
  /** Omitted, the whole Document. */
  scope?: ValidateScope;
  /** Omitted, every rule. */
  rules?: ValidateRule[];
}

export const ValidateIssue = z.object({
  rule: ValidateRule,
  nodeId: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});
export type ValidateIssue = z.infer<typeof ValidateIssue>;

/** Under this, in pt, a length or a distance from a line counts as zero: `round3`'s precision. */
const EPSILON = 0.001;

const TEXT_RULES: Record<string, ValidateRule | undefined> = {
  FONT_MISSING: "font_missing",
  MISSING_GLYPHS: "missing_glyphs",
  TEXT_OVERFLOW: "text_overflow",
};

/**
 * The visible Nodes of `scope` that break a rule, in drawing order, bottom first; a Node's issues
 * in `ValidateRule`'s order. Hidden Nodes and Template Layers are skipped with what they contain.
 */
export function validate(doc: Document, { scope, rules }: ValidateOptions = {}): ValidateIssue[] {
  const on = (rule: ValidateRule) => !rules || rules.includes(rule);
  const frames = doc.artboards.map((a) => a.frame);
  const frame =
    scope && "artboardId" in scope && artboardOf(doc, scope.artboardId, "scope.artboardId").frame;
  const listed =
    scope && "nodeIds" in scope
      ? new Set(scope.nodeIds.map((id, i) => lookup(doc, id, `scope.nodeIds[${i}]`).id))
      : undefined;
  const offAll = (b: Rect | null) => !!b && !frames.some((f) => touches(b, f));
  const issues: ValidateIssue[] = [];
  /** `inScope`: a listed Node is this or above it; `off`: one above it was reported off the Artboards. */
  const walk = (parentId: string | null, inScope: boolean, off: boolean) => {
    for (const n of childrenOf(doc, parentId)) {
      if (!n.visible || (n.type === "layer" && n.template)) continue;
      const here = inScope || !!listed?.has(n.id);
      const vb = visibleBounds(doc, n);
      const checked = here && (!frame || (!!vb && touches(vb, frame)));
      // The highest Node off every Artboard, so a Group dragged off is one issue; a Layer has no
      // place of its own. Under {artboardId} every checked Node touches an Artboard.
      const outside = checked && !off && n.type !== "layer" && !isOpacityMask(n) && offAll(vb);
      if (checked) issues.push(...check(doc, n).filter((i) => on(i.rule)));
      if (outside && on("outside_artboards")) {
        issues.push({
          rule: "outside_artboards",
          nodeId: n.id,
          message: "Its visibleBounds touch no Artboard, so no Artboard export draws it.",
          hint: "Move it onto an Artboard with kalamo_node_transform, or delete it.",
        });
      }
      walk(n.id, here, off || outside || isOpacityMask(n));
    }
  };
  walk(null, !listed, false);
  return issues;
}

/** The issues of one Node's own rules, every rule but outside_artboards. */
function check(doc: Document, n: Node): ValidateIssue[] {
  switch (n.type) {
    case "layer":
      return [];
    case "group":
      return childrenOf(doc, n.id).length === 0
        ? [
            {
              rule: "empty_group",
              nodeId: n.id,
              message: "A Group with no children, which draws nothing.",
              hint: "Delete it, or move Nodes into it with kalamo_node_reparent.",
            },
          ]
        : [];
    case "text":
      return textWarnings([n]).flatMap((w) => {
        const rule = TEXT_RULES[w.code];
        return rule ? [{ rule, nodeId: n.id, message: w.message }] : [];
      });
    case "image":
      return n.src
        ? []
        : [
            {
              rule: "missing_link",
              nodeId: n.id,
              message: `A missing link: its file ${n.file} has no pixels in the Document, so it draws as a crossed frame.`,
              hint: "Relink it with kalamo_node_update src, a data: URL of the file, or delete it.",
            },
          ];
    default:
      return zeroArea(worldOutline(doc, n))
        ? [
            {
              rule: "zero_area",
              nodeId: n.id,
              message: "It has zero area, so its Fills paint nothing.",
              hint: "Give it a width and height, or delete it.",
            },
          ]
        : [];
  }
}

/**
 * A shape whose points all sit on one point, or a closed one that fills nothing: winding is zero
 * everywhere off its outline, or even under evenodd. Winding steps by an edge's net count as it is
 * crossed, so that holds when every piece of every line its edges lie on is crossed a net zero (or
 * even) times. An open shape with length, such as a Line, has no area to lose.
 */
function zeroArea({ segments, fillRule }: ReturnType<typeof worldOutline>): boolean {
  const points = segments.flatMap((s) =>
    Array.from({ length: s.args.length / 2 }, (_, i) => ({
      x: s.args[2 * i] as number,
      y: s.args[2 * i + 1] as number,
    })),
  );
  const [p0] = points;
  if (!p0) return false;
  if (points.every((p) => Math.hypot(p.x - p0.x, p.y - p0.y) <= EPSILON)) return true;
  if (!segments.some((s) => s.cmd === "Z")) return false;
  // Longest first: each line is set by the edge that fixes its direction best, and a shape with
  // area is usually told by its first line.
  // ponytail: each line scans the edges left, O(edges × lines) for a shape that does cancel; bucket
  // lines by angle if such paths with thousands of curves get slow.
  let edges = outlineEdges(segments)
    .filter((e) => length(e) > EPSILON)
    .sort((e, f) => length(f) - length(e));
  while (edges[0]) {
    const [from, to] = edges[0];
    const len = length(edges[0]);
    const u = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
    const on = (p: Point) => Math.abs(u.x * (p.y - from.y) - u.y * (p.x - from.x)) <= EPSILON;
    const at = (p: Point) => (p.x - from.x) * u.x + (p.y - from.y) * u.y;
    // Each edge on the line is crossed +1 forward or -1 backward between its ends; up the line,
    // either way that is +1 at its start and -1 at its end.
    const steps = edges
      .filter(([a, b]) => on(a) && on(b))
      .flatMap(([a, b]): [number, number][] => [
        [at(a), 1],
        [at(b), -1],
      ])
      .sort((p, q) => p[0] - q[0]);
    let count = 0;
    const fills = steps.some(([t, step], i) => {
      count += step;
      const next = steps[i + 1];
      return !!next && next[0] - t > EPSILON && (fillRule === "evenodd" ? count % 2 : count) !== 0;
    });
    if (fills) return false;
    edges = edges.filter(([a, b]) => !(on(a) && on(b)));
  }
  return true;
}

const length = ([a, b]: [Point, Point]) => Math.hypot(b.x - a.x, b.y - a.y);

/** Curves are cut into this many straight edges, evenly in t, so a curve traced back cancels. */
const CURVE_STEPS = 16;

/** An outline's edges, each subpath closed as its fill closes it, curves cut into straight edges. */
// ponytail: a curve cancels only one traced back along the same control points; another curve of
// the same shape but other control points is not flattened to the same edges.
function outlineEdges(segments: Segment[]): [Point, Point][] {
  const edges: [Point, Point][] = [];
  let start: Point = { x: 0, y: 0 };
  let at = start;
  const close = () => {
    if (at.x !== start.x || at.y !== start.y) edges.push([at, start]);
    at = start;
  };
  for (const { cmd, args: a } of segments) {
    const p = (i: number): Point => ({ x: a[2 * i] as number, y: a[2 * i + 1] as number });
    if (cmd === "M") {
      close();
      start = at = p(0);
    } else if (cmd === "Z") close();
    else {
      const ctrl = [at, ...Array.from({ length: a.length / 2 }, (_, i) => p(i))];
      const steps = cmd === "L" ? 1 : CURVE_STEPS;
      for (let i = 1; i <= steps; i++) {
        const next = i === steps ? (ctrl.at(-1) as Point) : bezier(ctrl, i / steps);
        edges.push([at, next]);
        at = next;
      }
    }
  }
  close();
  return edges;
}

/** The point at `t` on the Bézier curve with these control points (de Casteljau). */
function bezier(ctrl: Point[], t: number): Point {
  let pts = ctrl;
  while (pts.length > 1) {
    pts = pts.slice(1).map((q, i) => {
      const p = pts[i] as Point;
      return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    });
  }
  return pts[0] as Point;
}
