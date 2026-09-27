import { subtree } from "./edit.ts";
import { ZibelError } from "./errors.ts";
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

/**
 * Applies the Transaction to the committed Document (per-key last-writer-wins, ADR-0004), or throws
 * NODE_GONE, changing nothing, when a Node it edited or created into was deleted meanwhile.
 */
export function commitTransaction(
  doc: Document,
  rows: TxRow[],
): { created: Node[]; updated: Node[]; deletedIds: string[] } {
  const createdIds = new Set(rows.filter((r) => !r.base && r.working).map((r) => r.id));
  const gone = new Set<string>();
  for (const { id, base, working } of rows) {
    if (base && working && !doc.nodes.has(id)) gone.add(id);
    const parent = !base && working?.parentId;
    if (parent && !createdIds.has(parent) && !doc.nodes.has(parent)) gone.add(parent);
  }
  if (gone.size > 0) {
    throw new ZibelError({
      code: "NODE_GONE",
      message: `Someone deleted ${[...gone].join(", ")} after this Transaction used them.`,
      hint: "Roll back with zibel_tx_rollback and redo the work in a new Transaction.",
      nodeIds: [...gone],
    });
  }
  const created: Node[] = [];
  const updated: Node[] = [];
  const deleted = new Set<string>();
  for (const { id, base, working } of rows) {
    if (!base && working) {
      doc.nodes.set(id, working);
      created.push(working);
    } else if (base && working) {
      const next = merge(doc.nodes.get(id) as Node, base, working);
      doc.nodes.set(id, next);
      updated.push(next);
    }
  }
  for (const { id, base, working } of rows) {
    const node = doc.nodes.get(id);
    if (!base || working || !node) continue;
    for (const n of subtree(doc, node)) deleted.add(n.id);
  }
  for (const id of deleted) doc.nodes.delete(id);
  return { created, updated, deletedIds: [...deleted] };
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
export function revert(
  doc: Document,
  delta: DeltaRow[],
): { created: Node[]; updated: Node[]; deletedIds: string[]; skipped: string[] } {
  return applyRows(
    doc,
    delta.map(({ id, before, after }) => ({ id, base: after, working: before })),
  );
}

/**
 * `commitTransaction` that skips instead of failing (delete beats edit, ADR-0004): an update of a
 * Node deleted since, and a create or update whose parent is gone and not created here, are left
 * out and reported in `skipped`.
 */
export function applyRows(
  doc: Document,
  rows: TxRow[],
): { created: Node[]; updated: Node[]; deletedIds: string[]; skipped: string[] } {
  const creates = new Map(rows.flatMap((r) => (!r.base && r.working ? [[r.id, r.working]] : [])));
  const placeable = (node: Node): boolean => {
    const parent = node.parentId;
    if (parent === null || doc.nodes.has(parent)) return true;
    const p = creates.get(parent);
    return !!p && placeable(p);
  };
  const skipped: string[] = [];
  const kept: TxRow[] = [];
  for (const row of rows) {
    const { id, base, working } = row;
    const gone = working && ((base && !doc.nodes.has(id)) || !placeable(working));
    if (gone) skipped.push(id);
    else kept.push(row);
  }
  return { ...commitTransaction(doc, kept), skipped };
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
