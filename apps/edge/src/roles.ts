import { ZibelError } from "@zibel/core";
import type { DocSummary, Role } from "@zibel/sync";
import { githubMode, type Principal } from "./auth.ts";

/** What a call needs of its caller's Role (ADR-0047). */
export type Need = "read" | "write" | "own";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
const NEEDS: Record<Need, Role> = { read: "viewer", write: "editor", own: "owner" };

/**
 * The caller's Role on a Document from its owner column and `members` row: in dev mode the local
 * User owns every Document. A read-only Principal is at most a viewer, whatever its User's Role.
 */
const ROLE_SQL = `CASE WHEN ?1 = 0 OR d.owner_id = ?2 THEN 'owner' ELSE m.role END`;

const capped = (role: Role, principal: Principal): Role =>
  principal.access === "read" ? "viewer" : role;

/**
 * The single authorization check every Document route and DocumentService method makes before it
 * reaches the Document Durable Object. No Role is DOC_NOT_FOUND, so ids leak nothing; a Role below
 * `need` is PERMISSION_DENIED with a hint that names it.
 */
export async function authorize(
  env: Env,
  principal: Principal,
  docId: string,
  need: Need,
): Promise<Role> {
  const row = await env.DB.prepare(
    `SELECT ${ROLE_SQL} AS role FROM documents d
     LEFT JOIN members m ON m.doc_id = d.id AND m.user_id = ?2 WHERE d.id = ?3`,
  )
    .bind(githubMode(env) ? 1 : 0, principal.userId, docId)
    .first<{ role: Role | null }>();
  if (!row?.role) throw docNotFound();
  const role = capped(row.role, principal);
  if (RANK[role] < RANK[NEEDS[need]]) throw denied(role, row.role, need);
  return role;
}

export const docNotFound = () =>
  new ZibelError({
    code: "DOC_NOT_FOUND",
    message: "Document not found.",
    hint: "Check the docId against zibel_doc_list, which lists the Documents you own or that are shared with you.",
    path: "docId",
  });

function denied(role: Role, userRole: Role, need: Need) {
  if (role !== userRole) {
    return new ZibelError({
      code: "PERMISSION_DENIED",
      message: "This Agent's token is read-only, so it is a viewer of every Document.",
      hint: "As a viewer, read tools still work. To edit, connect the Agent again without choosing read only.",
    });
  }
  if (need === "own") {
    return new ZibelError({
      code: "PERMISSION_DENIED",
      message: `You are ${article(role)} of this Document; only its owner can share or delete it.`,
      hint: `As ${article(role)}, you can ${role === "editor" ? "edit it" : "read it"}; ask the owner to share or delete it.`,
    });
  }
  return new ZibelError({
    code: "PERMISSION_DENIED",
    message: "You are a viewer of this Document: you can read it but not change it.",
    hint: "As a viewer, read tools still work. Ask the owner to make you an editor to change it.",
  });
}

const article = (role: Role) => (role === "editor" ? "an editor" : "a viewer");

/** A read-only Principal makes nothing: creating a Document is a write. */
export function assertWrites(principal: Principal) {
  if (principal.access === "read") {
    throw new ZibelError({
      code: "PERMISSION_DENIED",
      message: "This Agent's token is read-only, so it cannot create Documents.",
      hint: "As a viewer, read tools still work. To create, connect the Agent again without choosing read only.",
    });
  }
}

/** The Documents the caller owns or is a member of, newest first, each with its Role. */
export async function listDocuments(env: Env, principal: Principal): Promise<DocSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.id AS docId, d.name, d.created_at AS createdAt, ${ROLE_SQL} AS role
     FROM documents d LEFT JOIN members m ON m.doc_id = d.id AND m.user_id = ?2
     WHERE ?1 = 0 OR d.owner_id = ?2 OR m.user_id IS NOT NULL ORDER BY d.rowid DESC`,
  )
    .bind(githubMode(env) ? 1 : 0, principal.userId)
    .all<DocSummary>();
  return results.map((d) => ({ ...d, role: capped(d.role, principal) }));
}

/**
 * `/api/docs/:docId/members[/:login]`, owner only: list, share with or change, and remove. A
 * change closes the member's sockets, which reconnect with the new Role. Null for other paths.
 */
export function membersRoute(
  request: Request,
  env: Env,
  principal: Principal,
): Promise<object> | null {
  const [, docId, rawLogin] =
    new URL(request.url).pathname.match(/^\/api\/docs\/([^/]+)\/members(?:\/([^/]+))?$/) ?? [];
  if (!docId) return null;
  const login = rawLogin && decodeURIComponent(rawLogin);
  const method = request.method;
  if (!login && method === "GET") return members(env, principal, docId);
  if (login && method === "PUT") return share(request, env, principal, docId, login);
  if (login && method === "DELETE") return unshare(env, principal, docId, login);
  return null;
}

async function members(env: Env, principal: Principal, docId: string) {
  await authorize(env, principal, docId, "own");
  const { results } = await env.DB.prepare(
    `SELECT u.login, u.avatar_url AS avatarUrl, m.role FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.doc_id = ? ORDER BY u.login COLLATE NOCASE`,
  )
    .bind(docId)
    .all();
  return { members: results };
}

async function share(
  request: Request,
  env: Env,
  principal: Principal,
  docId: string,
  login: string,
) {
  await authorize(env, principal, docId, "own");
  const { role } = await request.json<{ role?: unknown }>().catch(() => ({ role: undefined }));
  if (role !== "editor" && role !== "viewer") {
    throw new ZibelError({
      code: "INVALID_INPUT",
      message: "role must be editor or viewer.",
      hint: 'Send { "role": "editor" } or { "role": "viewer" }.',
      path: "role",
    });
  }
  const user = await member(env, principal, login);
  await env.DB.prepare(
    `INSERT INTO members (doc_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT (doc_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(docId, user.id, role)
    .run();
  await doc(env, docId).disconnect(user.id);
  return { login: user.login, role };
}

async function unshare(env: Env, principal: Principal, docId: string, login: string) {
  await authorize(env, principal, docId, "own");
  const user = await member(env, principal, login);
  await env.DB.prepare("DELETE FROM members WHERE doc_id = ? AND user_id = ?")
    .bind(docId, user.id)
    .run();
  await doc(env, docId).disconnect(user.id);
  return { login: user.login, removed: true };
}

/** The User a login names, case-insensitively, who is not the owner. */
async function member(env: Env, principal: Principal, login: string) {
  const user = await env.DB.prepare("SELECT id, login FROM users WHERE login = ? COLLATE NOCASE")
    .bind(login)
    .first<{ id: string; login: string }>();
  if (!user) {
    throw new ZibelError({
      code: "INVALID_INPUT",
      message: `${login} has never signed in to Zibel.`,
      hint: `Ask ${login} to sign in to Zibel with GitHub once, then share again.`,
      path: "login",
    });
  }
  if (user.id === principal.userId) {
    throw new ZibelError({
      code: "INVALID_INPUT",
      message: "You own this Document; the owner is never a member.",
      hint: "Share it with someone else's GitHub login.",
      path: "login",
    });
  }
  return user;
}

const doc = (env: Env, docId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));
