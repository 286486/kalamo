import { KalamoError } from "@kalamo/core";
import { githubMode, type Principal } from "./auth.ts";

/** The free beta's Quotas (F-MCP-06c, ADR-0048), enforced in GitHub mode only. */
export const QUOTAS = {
  documents: 50,
  storage: 200 * 1024 * 1024,
  render: 500,
  export: 200,
  connections: 20,
};

/**
 * Refuses a new Document once the caller owns 50; Documents shared with them do not count.
 * ponytail: count then create, so two concurrent creates can overshoot by one; accepted for the beta.
 */
export async function checkDocuments(env: Env, principal: Principal) {
  if (!githubMode(env)) return;
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?")
    .bind(principal.userId)
    .first<number>("n");
  const limit = QUOTAS.documents;
  if ((used ?? 0) < limit) return;
  throw new KalamoError({
    code: "LIMIT_EXCEEDED",
    message: `You own ${used} of ${limit} Documents, the beta's limit.`,
    hint: "Delete a Document you no longer need, with kalamo_doc_delete or from the Document list, then retry. Documents shared with you do not count.",
    limit: { name: "documents", limit, used: used ?? 0 },
  });
}

/**
 * Counts one `render` or `export` call against the calling User's UTC day, in one atomic upsert,
 * and refuses it past the day's limit. A refused call, or one that fails later, still counts.
 */
export async function countCall(env: Env, principal: Principal, kind: "render" | "export") {
  if (!githubMode(env)) return;
  const now = new Date();
  const n = await env.DB.prepare(
    `INSERT INTO usage (user_id, day, kind, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (user_id, day, kind) DO UPDATE SET n = n + 1 RETURNING n`,
  )
    .bind(principal.userId, now.toISOString().slice(0, 10), kind)
    .first<number>("n");
  const limit = QUOTAS[kind];
  if ((n ?? 0) <= limit) return;
  const resetsAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
  throw new KalamoError({
    code: "LIMIT_EXCEEDED",
    message: `You have used all ${limit} kalamo_${kind} calls of today (UTC), the beta's daily limit.`,
    hint: `The count resets at ${resetsAt}; retry then.${kind === "render" ? " Render a smaller scope less often to make the calls last." : ""}`,
    limit: { name: kind, limit, used: limit, resetsAt },
  });
}

/**
 * What a write that may store files on `docId` gets to spend of its owner's storage: the bytes the
 * owner's other Documents store, and the owner's limit. `userId` owns a Document not indexed yet.
 * Undefined in dev mode.
 */
export async function ownerStorage(
  env: Env,
  docId: string,
  userId: string,
): Promise<OwnerStorage | undefined> {
  if (!githubMode(env)) return undefined;
  const used = await env.DB.prepare(
    `SELECT COALESCE(SUM(stored_bytes), 0) AS n FROM documents
     WHERE owner_id = COALESCE((SELECT owner_id FROM documents WHERE id = ?1), ?2) AND id != ?1`,
  )
    .bind(docId, userId)
    .first<number>("n");
  return { used: used ?? 0, limit: QUOTAS.storage };
}

/** The image bytes the owner's other Documents store, and the owner's storage limit. */
export interface OwnerStorage {
  used: number;
  limit: number;
}
