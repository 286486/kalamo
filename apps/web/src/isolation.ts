import { type Document, isLiveShape, type Node } from "@kalamo/core";
import { editable } from "./selection.ts";

/**
 * Isolation Mode (ADR-0057, ADR-0058): the tab's isolated Group, sub-Layer or single Live Shape or
 * Path, or null. It is browser state beside the Selection, never sent anywhere; its levels are
 * derived from the tree.
 */

/** A Node that holds no children: an isolated one is its own scope's only object (ADR-0058). */
export const isLeaf = (n: Node) => n.type !== "layer" && n.type !== "group";

/**
 * The levels down to `id`: `id` itself and every Group and sub-Layer above it, from below its
 * top-level Layer, outermost first. Empty when `doc` has no such Node.
 */
export function levels(doc: Document, id: string): string[] {
  const out: string[] = [];
  for (let n = doc.nodes.get(id); n?.parentId; n = doc.nodes.get(n.parentId)) {
    out.unshift(n.id);
  }
  return out;
}

/**
 * Whether `node` is in the scope of the isolated Node `scope`: below it, or the isolated leaf
 * itself; anywhere when there is none.
 */
export function inScope(doc: Document, node: Node, scope: string | null): boolean {
  if (scope === null || (node.id === scope && isLeaf(node))) return true;
  for (let n = doc.nodes.get(node.parentId ?? ""); n; n = doc.nodes.get(n.parentId ?? "")) {
    if (n.id === scope) return true;
  }
  return false;
}

/**
 * A Group, a Layer inside a Layer, or a Live Shape or Path that is no Clipping Path, visible and
 * unlocked, itself and through its ancestors (ADR-0058).
 */
export function isolatable(doc: Document, id: string): boolean {
  const n = doc.nodes.get(id);
  if (!n || !editable(doc, n)) return false;
  if (n.type === "layer") return !!n.parentId;
  return n.type === "group" || ((n.type === "path" || isLiveShape(n)) && !n.clipping);
}

/** What isolating `id` makes the Isolation: `id`, or null when it cannot be isolated. */
export const isolate = (doc: Document, id: string): string | null =>
  isolatable(doc, id) ? id : null;

/**
 * A breadcrumb: the Isolation goes up to `level`, one of the isolated Node's levels, or leaves
 * with null. The level just below where it lands, the one left, becomes the Selection, unless it
 * is a sub-Layer, which is never selected.
 */
export function goTo(
  doc: Document,
  isolated: string,
  level: string | null,
): { isolated: string | null; selection: string[] } {
  const path = levels(doc, isolated);
  const left = doc.nodes.get(path[level === null ? 0 : path.indexOf(level) + 1] ?? "");
  return { isolated: level, selection: left && left.type !== "layer" ? [left.id] : [] };
}

/** Esc, the bar's back arrow and Object > Exit Isolation Mode: up one level. */
export const exitLevel = (doc: Document, isolated: string) =>
  goTo(doc, isolated, levels(doc, isolated).at(-2) ?? null);

/**
 * The Isolation and Selection new art starts from (ADR-0058): a leaf holds no children, so an
 * isolated one first goes up one level; the new art then becomes the Selection.
 */
export function forNewArt(
  doc: Document,
  s: { isolated: string | null; selection: string[] },
): { isolated: string | null; selection: string[] } {
  const n = doc.nodes.get(s.isolated ?? "");
  return n && isLeaf(n) ? exitLevel(doc, n.id) : { isolated: s.isolated, selection: s.selection };
}

/**
 * The Isolation move a drawn `create` makes once the Worker's `tx` creates it (#137): from the
 * isolated leaf `from` up to the level forNewArt's result `at` went to. Place checks the same in
 * postFile.
 */
export const leaving = (from: string | null, at: { isolated: string | null }) =>
  from !== null && from !== at.isolated ? { from, to: at.isolated } : undefined;

/**
 * The Isolation after `prev` became `doc`, from any Actor, undo or redo: the innermost level that
 * can still be isolated, or null. A deleted isolated Node's levels are read from `prev`.
 */
export function prune(prev: Document | null, doc: Document, isolated: string | null) {
  if (isolated === null) return null;
  const path = doc.nodes.has(isolated) || !prev ? levels(doc, isolated) : levels(prev, isolated);
  return path.findLast((id) => isolatable(doc, id)) ?? null;
}
