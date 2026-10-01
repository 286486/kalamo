import { checkImage, type ErrorData, IMAGE_ID, KalamoError, MAX_IMAGE_BYTES } from "@kalamo/core";
import { createMcpServer } from "@kalamo/mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ACTOR_HEADER,
  authenticate,
  authRoute,
  CONNECTION_LIMIT_HEADER,
  crossOrigin,
  foreignOrigin,
  githubMode,
  misconfigured,
  type Principal,
  permissionDenied,
  ROLE_HEADER,
  signInRequired,
  USER_HEADER,
} from "./auth.ts";
import { MAX_REQUEST_BYTES, readCapped } from "./body.ts";
import { imageKey } from "./document-object.ts";
import { agentPrincipal, oauthProvider, oauthRoute, revokedChallenge } from "./oauth.ts";
import { ownerStorage, QUOTAS } from "./quotas.ts";
import { actorsRoute, authorize, listDocuments, membersRoute } from "./roles.ts";
import { documentService, unwrap } from "./service.ts";

export { DocumentObject } from "./document-object.ts";

/**
 * GitHub mode puts the OAuth provider in front (ADR-0047): it answers discovery, registration and
 * tokens, hands `/mcp` with a valid token to `agentMcp`, and everything else to `app`.
 */
export default {
  fetch(request, env, ctx): Promise<Response> {
    if (misconfigured(env)) {
      return Promise.resolve(new Response("server misconfigured", { status: 500 }));
    }
    if (!githubMode(env)) return app.fetch(request, env);
    return oauthProvider(env, app, agentMcp).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/** `/mcp` behind a valid OAuth token, as the token's Agent Actor. */
const agentMcp = {
  async fetch(request, env, ctx) {
    const principal = await agentPrincipal(env, ctx);
    if (!principal) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": revokedChallenge(env) },
      });
    }
    return mcp(request, env, principal);
  },
} satisfies ExportedHandler<Env>;

const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (crossOrigin(request, env)) return foreignOrigin();
    const auth = authRoute(request, env) ?? (githubMode(env) ? oauthRoute(request, env) : null);
    if (auth) return auth;
    const url = new URL(request.url);
    const principal = await authenticate(request, env);
    if (url.pathname === "/mcp") return mcp(request, env, principal);
    if (!principal) return signInRequired();
    const ws = url.pathname.match(/^\/api\/docs\/([^/]+)\/ws$/)?.[1];
    if (ws) return socket(request, env, principal, ws);
    if (url.pathname === "/api/docs" && request.method === "POST")
      return openFile(request, env, principal);
    const [, imageDoc, imageSrc] =
      url.pathname.match(/^\/api\/docs\/([^/]+)\/images\/([^/]+)$/) ?? [];
    if (imageDoc && imageSrc && request.method === "GET")
      return image(env, principal, imageDoc, imageSrc);
    const place = url.pathname.match(/^\/api\/docs\/([^/]+)\/place$/)?.[1];
    if (place && request.method === "POST") return placeFile(place, request, env, principal);
    const placeImage = url.pathname.match(/^\/api\/docs\/([^/]+)\/place-image$/)?.[1];
    if (placeImage && request.method === "POST")
      return placeBitmap(placeImage, request, env, principal);
    const relink = url.pathname.match(/^\/api\/docs\/([^/]+)\/relink-image$/)?.[1];
    if (relink && request.method === "POST") return relinkBitmap(relink, request, env, principal);
    const roster = membersRoute(request, env, principal) ?? actorsRoute(request, env, principal);
    if (roster) return answer(() => roster);
    const doc = url.pathname.match(/^\/api\/docs\/([^/]+)$/)?.[1];
    if (doc && request.method === "GET") return answer(() => readable(env, principal, doc));
    if (doc && request.method === "DELETE")
      return answer(() => documentService(env, principal).delete(doc));
    if (url.pathname === "/api/docs") {
      return Response.json({ documents: await listDocuments(env, principal) });
    }
    return new Response("not found", { status: 404 });
  },
};

async function mcp(request: Request, env: Env, principal: Principal | null): Promise<Response> {
  if (!principal) return permissionDenied();
  // GET would open a server-to-client stream and DELETE ends a session; stateless MCP has neither.
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readCapped(request, MAX_REQUEST_BYTES, requestTooLarge);
  } catch (e) {
    if (!(e instanceof KalamoError)) throw e;
    const { code, message, hint } = e.data;
    // No request id is known without the body (ADR-0049).
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message, data: { code, message, hint } } },
      { status: 413 },
    );
  }
  // Stateless (ADR-0006): no session id, a new server and transport per request.
  const server = createMcpServer(documentService(env, principal), principal.actor);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(new Request(request, { body }));
}

/**
 * A browser subscribes to a Document it has a Role on. The Document DO records the Worker's Actor,
 * User and Role, never ones a client sends (ADR-0047).
 */
async function socket(request: Request, env: Env, principal: Principal, docId: string) {
  let role: string;
  try {
    role = await authorize(env, principal, docId, "read");
  } catch (e) {
    return failure(e);
  }
  const headers = new Headers(request.headers);
  headers.set(ACTOR_HEADER, principal.actor);
  headers.set(USER_HEADER, principal.userId);
  headers.set(ROLE_HEADER, role);
  if (githubMode(env)) headers.set(CONNECTION_LIMIT_HEADER, String(QUOTAS.connections));
  else headers.delete(CONNECTION_LIMIT_HEADER);
  return env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)).fetch(new Request(request, { headers }));
}

/**
 * The caller's Role on a Document, by the same check as the WebSocket upgrade, whose refusal a
 * browser cannot read: a tab whose socket never opens asks here whether it still has access.
 */
async function readable(env: Env, principal: Principal, docId: string) {
  const role = await authorize(env, principal, docId, "read");
  const name = await env.DB.prepare("SELECT name FROM documents WHERE id = ?")
    .bind(docId)
    .first<string>("name");
  return { docId, name, role };
}

/**
 * The browser's Open file: the file's text as the body, its name in `?name=`. Over HTTP, not the
 * WebSocket, since a file does not belong in a gesture message (ADR-0017); by the request's User Actor.
 */
async function openFile(request: Request, env: Env, principal: Principal): Promise<Response> {
  const name = new URL(request.url).searchParams.get("name") ?? undefined;
  return answer(async () => {
    const { docId, warnings } = await documentService(env, principal).open({
      content: await fileText(request, "content"),
      name,
    });
    return { docId, warnings };
  });
}

/**
 * The browser's paste or drop of an SVG (Place, ADR-0017): the SVG as the body; `parentId`, the
 * centre `x`, `y`, `inPlace` for Paste in Place (ADR-0030) and the file's `name` in the query. By
 * the User Actor, like Open.
 */
async function placeFile(
  docId: string,
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const x = Number(q.get("x") ?? Number.NaN);
  const y = Number(q.get("y") ?? Number.NaN);
  return answer(async () =>
    documentService(env, principal).place(docId, {
      svg: await fileText(request, "svg"),
      parentId: q.get("parentId") ?? "",
      ...(Number.isFinite(x) && Number.isFinite(y) && { position: { x, y } }),
      inPlace: q.has("inPlace"),
      name: q.get("name") ?? undefined,
    }),
  );
}

/**
 * The browser's paste or drop of a bitmap (ADR-0023): the file's bytes as the body; `parentId` and
 * the centre `x`, `y` in the query. An Image at its pixel size, by the User Actor, like Place.
 */
async function placeBitmap(
  docId: string,
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const x = Number(q.get("x") ?? Number.NaN);
  const y = Number(q.get("y") ?? Number.NaN);
  return answer(async () => {
    await authorize(env, principal, docId, "write");
    const file = await bitmap(request);
    const frame = Number.isFinite(x) && Number.isFinite(y);
    return unwrap(
      await env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)).placeImage(
        // The name only titles a Template Layer, which paste and drop never make.
        { ...file, name: "Image" },
        principal.actor,
        {
          parentId: q.get("parentId") ?? "",
          ...(frame && { frame: { x: x - file.width / 2, y: y - file.height / 2 } }),
          storage: await ownerStorage(env, docId, principal.userId),
        },
      ),
    );
  });
}

/** "N bytes" when the body declared more than `cap`, else "over `cap` bytes". */
const sizeOf = (cap: number, declared?: number) =>
  declared !== undefined && declared > cap ? `${declared} bytes` : `over ${cap} bytes`;

/** The refusal of a body over 32 MiB, from Open, Place and `/mcp` alike (ADR-0049). */
const requestTooLarge = (declared?: number, path?: string) =>
  new KalamoError({
    code: "LIMIT_EXCEEDED",
    message: `The file is ${sizeOf(MAX_REQUEST_BYTES, declared)}; the server reads at most ${MAX_REQUEST_BYTES} (32 MiB).`,
    hint: "Split the drawing into several files, or remove embedded images.",
    ...(path && { path }),
  });

/** Open's or Place's file as text, read no further than 32 MiB (ADR-0049). */
const fileText = async (request: Request, path: string) =>
  new TextDecoder().decode(
    await readCapped(request, MAX_REQUEST_BYTES, (declared) => requestTooLarge(declared, path)),
  );

/** The body as a PNG, JPEG or GIF of at most 5 MB (ADR-0023), read no further (ADR-0049). */
const bitmap = async (request: Request) =>
  checkImage(
    await readCapped(
      request,
      MAX_IMAGE_BYTES,
      (declared) =>
        new KalamoError({
          code: "LIMIT_EXCEEDED",
          message: `The image is ${sizeOf(MAX_IMAGE_BYTES, declared)}; the limit is ${MAX_IMAGE_BYTES} (5 MB).`,
          hint: "Scale the image down or compress it before placing it.",
          path: "file",
        }),
    ),
    "file",
  );

/**
 * Object > Relink… (ADR-0042): the file's bytes as the body; the Image's `nodeId` and the file's
 * `name`, which a linked Image takes as its `file`, in the query. By the User Actor, like Place.
 */
async function relinkBitmap(
  docId: string,
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const q = new URL(request.url).searchParams;
  return answer(async () => {
    await authorize(env, principal, docId, "write");
    const file = await bitmap(request);
    return unwrap(
      await env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)).relinkImage(
        { ...file, name: q.get("name") ?? undefined },
        principal.actor,
        {
          nodeId: q.get("nodeId") ?? "",
          storage: await ownerStorage(env, docId, principal.userId),
        },
      ),
    );
  });
}

/**
 * An Image's file for the canvas, streamed from R2 without the Document Durable Object (ADR-0046),
 * to a caller with a Role on the Document (ADR-0047). An id always names the same bytes, so it is
 * cached for good, but only by the browser: another User must not get it from a shared cache.
 */
async function image(env: Env, principal: Principal, docId: string, src: string) {
  try {
    await authorize(env, principal, docId, "read");
  } catch (e) {
    return failure(e);
  }
  const object = IMAGE_ID.test(src) ? await env.IMAGES.get(imageKey(docId, src)) : null;
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

/** `fn`'s result as JSON, or its KalamoError as `failure` answers it. */
async function answer(fn: () => Promise<object>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (e) {
    return failure(e);
  }
}

const STATUS: Partial<Record<ErrorData["code"], number>> = {
  PERMISSION_DENIED: 403,
  DOC_NOT_FOUND: 404,
};

/** A KalamoError as JSON: 403 for PERMISSION_DENIED, 404 for DOC_NOT_FOUND, else 400. */
function failure(e: unknown): Response {
  if (!(e instanceof KalamoError)) throw e;
  return Response.json(e.data, { status: STATUS[e.data.code] ?? 400 });
}
