import { generateKeyBetween } from "fractional-indexing";
import { checkTree } from "./document.ts";
import { subtree } from "./edit.ts";
import { KalamoError } from "./errors.ts";
import { type Document, type Node, SHAPES } from "./schema.ts";

/**
 * One Node an open Transaction touched (ADR-0008): `base` is the committed copy at first touch
 * (null: created in the Transaction), `working` its current copy (null: deleted in the Transaction).
 */
export interface TxRow {
  id: string;
  base: Node | null;
  working: Node | null;
}

/** The committed Document as the Transaction sees it. Leaves `doc` untouched. */
export function overlay(doc: Document, rows: TxRow[]): Document {
  const nodes = new Map(doc.nodes);
  for (const { id, working } of rows) {
    if (working) nodes.set(id, working);
    else nodes.delete(id);
  }
  return { ...doc, nodes };
}

type Change = { created: Node[]; updated: Node[]; deletedIds: string[] };

/**
 * Applies the Transaction to the committed Document (per-key last-writer-wins, ADR-0004), or throws,
 * changing nothing: NODE_GONE when a Node it edited, or a parent it created or moved Nodes into, was
 * deleted meanwhile; TREE_CONFLICT when the merged Document would break a tree rule or hold two
 * Clipping Paths in one container (ADR-0072). A key a sibling took meanwhile is rekeyed.
 */
export function commitTransaction(doc: Document, rows: TxRow[]): Change {
  const createdIds = new Set(rows.filter((r) => !r.base && r.working).map((r) => r.id));
  const gone = new Set<string>();
  for (const { id, base, working } of rows) {
    if (base && working && !doc.nodes.has(id)) gone.add(id);
    const parent = working?.parentId;
    const placed = !base || base.parentId !== parent;
    if (placed && parent && !createdIds.has(parent) && !doc.nodes.has(parent)) gone.add(parent);
  }
  if (gone.size > 0) {
    throw new KalamoError({
      code: "NODE_GONE",
      message: `Someone deleted ${[...gone].join(", ")} after this Transaction used them.`,
      hint: "Roll back with kalamo_tx_rollback and redo the work in a new Transaction.",
      nodeIds: [...gone],
    });
  }
  const next = { ...doc, nodes: new Map(doc.nodes) };
  const change = apply(next, rows);
  const broken = conflicts(next, change);
  if (broken.size > 0) {
    throw new KalamoError({
      code: "TREE_CONFLICT",
      message: `Edits committed after this Transaction used them conflict with it: ${[...broken].map(([id, e]) => `${id}: ${e.data.message}`).join(" ")}`,
      hint: "Roll back with kalamo_tx_rollback and redo the work in a new Transaction.",
      nodeIds: [...broken.keys()],
    });
  }
  return settle(doc, change);
}

/** Merges `rows` into `doc`, then rekeys each created or updated Node whose key a sibling holds. */
function apply(doc: Document, rows: TxRow[]): Change {
  const touched: string[] = [];
  const deleted = new Set<string>();
  for (const { id, base, working } of rows) {
    if (!working) continue;
    doc.nodes.set(id, base ? merge(doc.nodes.get(id) as Node, base, working) : working);
    touched.push(id);
  }
  for (const { id, base, working } of rows) {
    const node = doc.nodes.get(id);
    if (!base || working || !node) continue;
    for (const n of subtree(doc, node)) deleted.add(n.id);
  }
  for (const id of deleted) doc.nodes.delete(id);
  const kept = touched.filter((id) => !deleted.has(id));
  rekey(doc, kept);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const nodes = kept.map((id) => doc.nodes.get(id) as Node);
  return {
    created: nodes.filter((n) => !byId.get(n.id)?.base),
    updated: nodes.filter((n) => byId.get(n.id)?.base),
    deletedIds: [...deleted],
  };
}

/**
 * Gives each of `ids`, in order, whose `index` a sibling holds a key between it and the next key
 * above, so it stays in its intended slot, just above the Node that holds it (ADR-0072). Two
 * concurrent creates on top of one parent take the same key; the later-committed one goes above.
 */
function rekey(doc: Document, ids: string[]): void {
  const own = new Set(ids);
  const keys = new Map<string | null, string[]>();
  const of = (parentId: string | null) =>
    keys.get(parentId) ?? keys.set(parentId, []).get(parentId);
  for (const n of doc.nodes.values()) if (!own.has(n.id)) of(n.parentId)?.push(n.index);
  for (const id of ids) {
    const node = doc.nodes.get(id) as Node;
    const taken = of(node.parentId) as string[];
    if (taken.includes(node.index)) {
      const above = taken.filter((k) => k > node.index).sort()[0] ?? null;
      doc.nodes.set(id, { ...node, index: generateKeyBetween(node.index, above) });
    }
    taken.push((doc.nodes.get(id) as Node).index);
  }
}

/**
 * The created and updated Nodes of `change` that break a rule of `checkTree` in `doc`, each with
 * the first it breaks. Nodes the change did not touch are checked first, so of two Clipping Paths in
 * one container the touched one is named; a rule an untouched Node already broke is not.
 */
function conflicts(doc: Document, change: Change): Map<string, KalamoError> {
  const touched = [...change.created, ...change.updated];
  const ids = new Set(touched.map((n) => n.id));
  const others = [...doc.nodes.values()].filter((n) => !ids.has(n.id));
  const broken = new Map<string, KalamoError>();
  checkTree(doc, [...others, ...touched], (e, i) => {
    const node = touched[i - others.length];
    if (node && !broken.has(node.id)) broken.set(node.id, e);
  });
  return broken;
}

/** Writes the Nodes of a checked `change` into `doc`. */
function settle(doc: Document, change: Change): Change {
  for (const n of [...change.created, ...change.updated]) doc.nodes.set(n.id, n);
  for (const id of change.deletedIds) doc.nodes.delete(id);
  return change;
}

/**
 * One Node a committed Transaction changed (ADR-0011): its copy before (null: the Transaction created
 * it) and after (null: the Transaction deleted it).
 */
export interface DeltaRow {
  id: string;
  before: Node | null;
  after: Node | null;
}

/**
 * Applies the inverse of a committed Transaction's delta to the Document as committed now, per
 * top-level key (ADR-0011).
 */
export function revert(doc: Document, delta: DeltaRow[]): Change & { skipped: string[] } {
  return applyRows(
    doc,
    delta.map(({ id, before, after }) => ({ id, base: after, working: before })),
  );
}

/**
 * `commitTransaction` that skips instead of failing (delete beats edit, ADR-0004): an update of a
 * Node deleted since, a create or update whose parent is gone and not created here, and a row whose
 * Node would break a tree rule or be a second Clipping Path (ADR-0072) are left out and reported in
 * `skipped`, until what is left applies.
 */
export function applyRows(doc: Document, rows: TxRow[]): Change & { skipped: string[] } {
  const skipped: string[] = [];
  let kept = rows;
  for (;;) {
    const creates = new Map(kept.flatMap((r) => (!r.base && r.working ? [[r.id, r.working]] : [])));
    const placeable = (node: Node): boolean => {
      const parent = node.parentId;
      if (parent === null || doc.nodes.has(parent)) return true;
      const p = creates.get(parent);
      return !!p && placeable(p);
    };
    const gone = new Set(
      kept.flatMap(({ id, base, working }) =>
        working && ((base && !doc.nodes.has(id)) || !placeable(working)) ? [id] : [],
      ),
    );
    kept = kept.filter((r) => !gone.has(r.id));
    const next = { ...doc, nodes: new Map(doc.nodes) };
    const change = apply(next, kept);
    const broken = conflicts(next, change);
    skipped.push(...gone, ...broken.keys());
    if (broken.size === 0) return { ...settle(doc, change), skipped };
    kept = kept.filter((r) => !broken.has(r.id));
  }
}

/** `current` with every top-level key where `working` differs from `base` taken from `working`. */
function merge(current: Node, base: Node, working: Node): Node {
  const b = base as unknown as Record<string, unknown>;
  const w = working as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...current };
  // Converted to a path meanwhile (ADR-0032): the Live Shape's parameters are gone, so edits to
  // them are dropped, as delete beats edit.
  const converted = current.type !== base.type && working.type === base.type;
  const gone = converted ? SHAPES[base.type as keyof typeof SHAPES]?.shape : undefined;
  for (const k of new Set([...Object.keys(b), ...Object.keys(w)])) {
    if (same(b[k], w[k]) || (gone && k in gone)) continue;
    if (Object.hasOwn(w, k)) out[k] = w[k];
    else delete out[k];
  }
  return out as unknown as Node;
}

/** Structural equality of JSON values; key order does not matter. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length &&
    keys.every((k) => Object.hasOwn(y, k) && same(x[k], y[k]))
  );
}
