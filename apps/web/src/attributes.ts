import {
  type Document,
  isCompoundPath,
  type Node,
  type PathNode,
  type Subpath,
} from "@kalamo/core";
import { anchorKey, anchorsOf, localAnchors, parseKey } from "./direct.ts";
import { compoundParts } from "./menu.ts";
import { editable } from "./selection.ts";
import { canEdit, type State, send, useStore } from "./store.ts";

/** The Attributes panel's fill rule and Reverse Path Direction controls (ADR-0108). */

type FillRule = NonNullable<PathNode["fillRule"]>;
type Selected = Pick<State, "doc" | "selection" | "anchors" | "segments" | "role">;

/** The paths the fill rule buttons set: selected, or painting in a selected Group, editable. */
export const fillRuleTargets = (s: Selected): PathNode[] =>
  s.doc && canEdit(s)
    ? compoundParts(s.doc, s.selection).filter((n): n is PathNode => n.type === "path")
    : [];

/** The targets' one fill rule, "mixed" when they differ, null with none. */
export function fillRuleOf(s: Selected): FillRule | "mixed" | null {
  const rules = new Set(fillRuleTargets(s).map((n) => n.fillRule ?? "nonzero"));
  return rules.size > 1 ? "mixed" : ([...rules][0] ?? null);
}

/** Sets the targets' fill rule as one Transaction; sends nothing when none differ. */
export function setFillRule(s: Selected, fillRule: FillRule) {
  const nodeIds = fillRuleTargets(s)
    .filter((n) => (n.fillRule ?? "nonzero") !== fillRule)
    .map((n) => n.id);
  if (nodeIds.length > 0) send({ type: "fill_rule", nodeIds, fillRule });
}

/**
 * Twice the signed area of a subpath as drawn in the document, y down: positive when it runs
 * clockwise on screen. Each cubic's term is exact by Green's theorem; a closed subpath's closing
 * segment counts, an open one closes by a line.
 */
export function signedArea(s: Subpath): number {
  const cross = (p: number[], q: number[]) => (p[0] ?? 0) * (q[1] ?? 0) - (p[1] ?? 0) * (q[0] ?? 0);
  const n = s.anchors.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = s.anchors[i];
    const b = s.anchors[(i + 1) % n];
    if (!a || !b) continue;
    const curved = (s.closed || i < n - 1) && (a.handleOut || b.handleIn);
    if (!curved) {
      sum += cross(a.anchor, b.anchor);
      continue;
    }
    const [p0, p1, p2, p3] = [a.anchor, a.handleOut ?? a.anchor, b.handleIn ?? b.anchor, b.anchor];
    sum +=
      (6 * cross(p0, p1) +
        3 * cross(p0, p2) +
        cross(p0, p3) +
        3 * cross(p1, p2) +
        3 * cross(p1, p3) +
        6 * cross(p2, p3)) /
      10;
  }
  return sum;
}

/**
 * The subpaths Reverse Path Direction sets: those with a selected Anchor or segment, of an
 * editable Compound Path under nonzero, each once. On is a subpath that runs clockwise on screen,
 * as Kalamo's Live Shapes do; Off runs counter-clockwise. So a Make result reads as Illustrator's:
 * the backmost Off, the holes On (ADR-0108). A subpath with no area has no direction to set.
 */
export function directionTargets(s: Selected): { nodeId: string; subpath: number; on: boolean }[] {
  const { doc } = s;
  if (!doc || !canEdit(s)) return [];
  const seen = new Set<string>();
  return [...s.anchors, ...s.segments].flatMap((key) => {
    const { nodeId, subpath } = parseKey(key);
    const n = doc.nodes.get(nodeId);
    if (seen.has(`${nodeId} ${subpath}`) || !reversible(doc, n)) return [];
    seen.add(`${nodeId} ${subpath}`);
    const sub = anchorsOf(doc, n)[subpath];
    const area = sub ? signedArea(sub) : 0;
    return area !== 0 ? [{ nodeId, subpath, on: area > 0 }] : [];
  });
}

const reversible = (doc: Document, n: Node | undefined): n is PathNode =>
  n?.type === "path" && isCompoundPath(n) && n.fillRule !== "evenodd" && editable(doc, n);

/** The chosen subpaths' one direction, "mixed" when they differ, null with none. */
export function directionOf(s: Selected): boolean | "mixed" | null {
  const ons = new Set(directionTargets(s).map((t) => t.on));
  return ons.size > 1 ? "mixed" : ([...ons][0] ?? null);
}

/**
 * Sets the chosen subpaths' direction as one Transaction; sends nothing when none differ. The
 * selected Anchors and segments stay on the Anchors they named, renumbered as the reverse
 * renumbers them, so the panel keeps showing the direction it set.
 */
export function setDirection(s: Selected, on: boolean) {
  const { doc } = s;
  const flip = directionTargets(s).filter((t) => t.on !== on);
  if (!doc || flip.length === 0) return;
  const subpaths = flip.map(({ nodeId, subpath }) => ({ nodeId, subpath }));
  const commandId = send({ type: "path_reverse", subpaths });
  const inputs = [...new Set(subpaths.map((t) => t.nodeId))].map((nodeId) => ({
    nodeId,
    ops: subpaths
      .filter((t) => t.nodeId === nodeId)
      .map(({ subpath }) => ({ op: "reverse" as const, subpath })),
  }));
  /** Where Anchor `index`, or the segment starting there, is once its subpath is reversed. */
  const renumber = (segment: boolean) => (key: string) => {
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
  useStore.setState({
    edit: { inputs, commandIds: inputs.map(() => commandId) },
    anchors: s.anchors.map(renumber(false)),
    segments: s.segments.map(renumber(true)),
  });
}
