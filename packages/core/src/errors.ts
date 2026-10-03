export type ErrorCode =
  | "DOC_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "ARTBOARD_NOT_FOUND"
  | "NOTHING_TO_RENDER"
  | "INVALID_PARENT"
  | "INVALID_COLOR"
  | "INVALID_PATH"
  | "INVALID_INPUT"
  | "INVALID_PATCH"
  | "INVALID_MASK"
  | "INVALID_DOCUMENT"
  | "INVALID_IMAGE"
  | "FETCH_FAILED"
  | "LIMIT_EXCEEDED"
  | "PERMISSION_DENIED"
  | "REV_CONFLICT"
  | "NODE_GONE"
  | "TREE_CONFLICT"
  | "LAST_LAYER"
  | "TX_NOT_FOUND"
  | "TX_EXPIRED"
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "NOTHING_TO_CHANGE"
  | "ENDPOINTS_APART"
  | "BOOLEAN_FAILED";

/** What an Agent sees for a failed call: enough to fix the call without a stack trace. */
export interface ErrorData {
  code: ErrorCode;
  message: string;
  hint: string;
  path?: string;
  /** REV_CONFLICT: the committed rev. */
  rev?: number;
  /** REV_CONFLICT: Nodes changed since `ifRev`. NODE_GONE: the deleted Nodes. TREE_CONFLICT: the conflicting Nodes. LAST_LAYER: the top-level Layers the delete names. */
  nodeIds?: string[];
  /** LIMIT_EXCEEDED of a beta Quota (ADR-0048): which one, and its numbers. */
  limit?: QuotaLimit;
}

/** A Quota's numbers: `used` of `limit`, in bytes for storage; `resetsAt` for a daily one. */
export interface QuotaLimit {
  name: "documents" | "storage" | "document_storage" | "render" | "export" | "connections";
  limit: number;
  used: number;
  resetsAt?: string;
}

export class KalamoError extends Error {
  constructor(readonly data: ErrorData) {
    super(data.message);
    this.name = "KalamoError";
  }
}

/** One batch item that did not apply under `partial: true`. */
export interface Failed extends ErrorData {
  index: number;
}

/**
 * Runs `prepare` on every item. Atomic (default): the first KalamoError propagates. With `partial`,
 * failures are collected by index; if nothing succeeded, the first failure is thrown instead.
 */
export function collect<T, R>(
  items: T[],
  partial: boolean,
  prepare: (item: T, i: number) => R,
): { ok: R[]; failed: Failed[] } {
  const ok: R[] = [];
  const failed: Failed[] = [];
  items.forEach((item, index) => {
    try {
      ok.push(prepare(item, index));
    } catch (e) {
      if (!partial || !(e instanceof KalamoError)) throw e;
      failed.push({ index, ...e.data });
    }
  });
  const first = failed[0];
  if (ok.length === 0 && first) {
    const { index: _, ...data } = first;
    throw new KalamoError(data);
  }
  return { ok, failed };
}
