import { z } from "zod";
import { childrenOf, isOpacityMask, touches, visibleBounds, worldSegments } from "./document.ts";
import { artboardOf, lookup } from "./edit.ts";
import type { Segment } from "./path.ts";
import { ArtboardScope, type Document, type Node, NodesScope, type Rect } from "./schema.ts";
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
      return zeroArea(worldSegments(doc, n))
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
 * A shape whose points all sit on one point, or a closed one whose points all sit on one line. An
 * open shape with length, such as a Line, has no area to lose.
 */
// ponytail: tests the control points, so a closed path that doubles back on itself with curves off
// its line is not zero area; measure the filled area when that matters.
function zeroArea(segments: Segment[]): boolean {
  const points = segments.flatMap((s) =>
    Array.from({ length: s.args.length / 2 }, (_, i) => ({
      x: s.args[2 * i] as number,
      y: s.args[2 * i + 1] as number,
    })),
  );
  const [p0] = points;
  if (!p0) return false;
  const far = points.reduce((a, p) =>
    Math.hypot(p.x - p0.x, p.y - p0.y) > Math.hypot(a.x - p0.x, a.y - p0.y) ? p : a,
  );
  const length = Math.hypot(far.x - p0.x, far.y - p0.y);
  if (length <= EPSILON) return true;
  if (!segments.some((s) => s.cmd === "Z")) return false;
  return points.every(
    (p) =>
      Math.abs((far.x - p0.x) * (p.y - p0.y) - (far.y - p0.y) * (p.x - p0.x)) / length <= EPSILON,
  );
}
