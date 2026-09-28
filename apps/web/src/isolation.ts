import type { Document, Node } from "@zibel/core";
import { editable } from "./selection.ts";

/**
 * Isolation Mode (ADR-0057): the tab's isolated Group, or null. It is browser state beside the
 * Selection, never sent anywhere; its levels are derived from the tree.
 */

/**
 * The levels down to `id`: every Group from below its Layer down to `id` itself, outermost first.
 * Empty when `doc` has no such Node.
 */
export function levels(doc: Document, id: string): string[] {
  const out: string[] = [];
  for (let n = doc.nodes.get(id); n?.type === "group"; n = doc.nodes.get(n.parentId ?? "")) {
    out.unshift(n.id);
  }
  return out;
}

/** Whether `node` is below the isolated Group `scope`, or anywhere when there is none. */
export function inScope(doc: Document, node: Node, scope: string | null): boolean {
  if (scope === null) return true;
  for (let n = doc.nodes.get(node.parentId ?? ""); n; n = doc.nodes.get(n.parentId ?? "")) {
    if (n.id === scope) return true;
  }
  return false;
}

/** A Group that is visible and unlocked, itself and through its ancestors. */
const isolatable = (doc: Document, id: string) => {
  const n = doc.nodes.get(id);
  return n?.type === "group" && editable(doc, n);
};

/** What isolating `id` makes the Isolation: `id`, or null when it is no editable Group. */
export const isolate = (doc: Document, id: string): string | null =>
  isolatable(doc, id) ? id : null;

/**
 * A breadcrumb: the Isolation goes up to `level`, one of the isolated Group's levels, or leaves
 * with null. The level just below where it lands, the one left, becomes the Selection.
 */
export function goTo(
  doc: Document,
  isolated: string,
  level: string | null,
): { isolated: string | null; selection: string[] } {
  const path = levels(doc, isolated);
  const left = path[level === null ? 0 : path.indexOf(level) + 1];
  return { isolated: level, selection: left ? [left] : [] };
}

/** Esc, the bar's back arrow and Object > Exit Isolation Mode: up one level. */
export const exitLevel = (doc: Document, isolated: string) =>
  goTo(doc, isolated, levels(doc, isolated).at(-2) ?? null);

/**
 * The Isolation after `prev` became `doc`, from any Actor, undo or redo: the innermost level that
 * still exists as an editable Group, or null. A deleted isolated Group's levels are read from
 * `prev`.
 */
export function prune(prev: Document | null, doc: Document, isolated: string | null) {
  if (isolated === null) return null;
  const path = doc.nodes.has(isolated) || !prev ? levels(doc, isolated) : levels(prev, isolated);
  return path.findLast((id) => isolatable(doc, id)) ?? null;
}
