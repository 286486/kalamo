import {
  type Document,
  directionEdits,
  isCompoundPath,
  type Node,
  type PathNode,
  runsClockwise,
} from "@kalamo/core";
import { parseKey } from "./direct.ts";
import { compoundParts } from "./menu.ts";
import { editable } from "./selection.ts";
import { afterRenumbering, canEdit, type State, send, useStore } from "./store.ts";

/** The Attributes panel's fill rule and Reverse Path Direction controls (ADR-0108). */

type FillRule = NonNullable<PathNode["fillRule"]>;
type Selected = Pick<State, "doc" | "selection" | "anchors" | "segments" | "role">;
/** With the press in flight, whose direction its subpaths show. */
type Directed = Selected & Pick<State, "reversing">;

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
 * The subpaths Reverse Path Direction sets: those with a selected Anchor or segment, of an
 * editable Compound Path under nonzero, each once. On is a subpath that runs clockwise on screen,
 * as Kalamo's Live Shapes do; Off runs counter-clockwise. So a Make result reads as Illustrator's:
 * the backmost Off, the holes On (ADR-0108). A subpath with no area has no direction to set.
 */
export function directionTargets(s: Directed): { nodeId: string; subpath: number; on: boolean }[] {
  const { doc } = s;
  if (!doc || !canEdit(s)) return [];
  const seen = new Set<string>();
  return [...s.anchors, ...s.segments].flatMap((key) => {
    const { nodeId, subpath } = parseKey(key);
    const n = doc.nodes.get(nodeId);
    if (seen.has(`${nodeId} ${subpath}`) || !reversible(doc, n)) return [];
    seen.add(`${nodeId} ${subpath}`);
    // A subpath a press in flight names shows the direction pressed (ADR-0110).
    const pressed = s.reversing?.subpaths.some((t) => t.nodeId === nodeId && t.subpath === subpath);
    const on = pressed ? s.reversing?.clockwise : runsClockwise(doc, n, subpath);
    return typeof on === "boolean" ? [{ nodeId, subpath, on }] : [];
  });
}

const reversible = (doc: Document, n: Node | undefined): n is PathNode =>
  n?.type === "path" && isCompoundPath(n) && n.fillRule !== "evenodd" && editable(doc, n);

/** The chosen subpaths' one direction, "mixed" when they differ, null with none. */
export function directionOf(s: Directed): boolean | "mixed" | null {
  const ons = new Set(directionTargets(s).map((t) => t.on));
  return ons.size > 1 ? "mixed" : ([...ons][0] ?? null);
}

/**
 * Sets the chosen subpaths' direction as one Transaction; sends nothing when none differ. The
 * command names the direction, so a subpath someone else reverses first is left as it is
 * (ADR-0109). The selected Anchors and segments keep their numbers until the answer renumbers
 * them, and Direct Selection edits wait for it (ADR-0110).
 */
export function setDirection(s: Directed, on: boolean) {
  const { doc } = s;
  const flip = directionTargets(s).filter((t) => t.on !== on);
  if (!doc || flip.length === 0) return;
  const subpaths = flip.map(({ nodeId, subpath }) => ({ nodeId, subpath }));
  const commandId = send({ type: "path_reverse", subpaths, clockwise: on });
  const inputs = directionEdits(doc, subpaths, on);
  useStore.setState({ reversing: { commandId, subpaths, clockwise: on, inputs } });
}

/**
 * The Attributes panel's direction buttons: a press waits for the person's own command that may
 * renumber a path's Anchors, unanswered, such as the press before it, which the store tracks alone
 * (ADR-0110).
 */
export const pressDirection = (on: boolean) => afterRenumbering((s) => setDirection(s, on));
