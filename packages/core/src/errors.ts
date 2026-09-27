export type ErrorCode =
  | "DOC_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "ARTBOARD_NOT_FOUND"
  | "NOTHING_TO_RENDER"
  | "INVALID_PARENT"
  | "INVALID_COLOR"
  | "INVALID_PATH"
  | "INVALID_PATCH"
  | "INVALID_MASK"
  | "INVALID_DOCUMENT"
  | "INVALID_IMAGE"
  | "FETCH_FAILED"
  | "LIMIT_EXCEEDED"
  | "PERMISSION_DENIED"
  | "REV_CONFLICT"
  | "NODE_GONE"
  | "TX_NOT_FOUND"
  | "TX_EXPIRED"
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "BOOLEAN_FAILED";

/** What an Agent sees for a failed call: enough to fix the call without a stack trace. */
export interface ErrorData {
  code: ErrorCode;
  message: string;
  hint: string;
  path?: string;
  /** REV_CONFLICT: the committed rev. */
  rev?: number;
  /** REV_CONFLICT: Nodes changed since `ifRev`. NODE_GONE: the deleted Nodes. */
  nodeIds?: string[];
}

export class ZibelError extends Error {
  constructor(readonly data: ErrorData) {
    super(data.message);
    this.name = "ZibelError";
  }
}

/** One batch item that did not apply under `partial: true`. */
export interface Failed extends ErrorData {
  index: number;
}

/**
 * Runs `prepare` on every item. Atomic (default): the first ZibelError propagates. With `partial`,
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
      if (!partial || !(e instanceof ZibelError)) throw e;
      failed.push({ index, ...e.data });
    }
  });
  const first = failed[0];
  if (ok.length === 0 && first) {
    const { index: _, ...data } = first;
    throw new ZibelError(data);
  }
  return { ok, failed };
}
