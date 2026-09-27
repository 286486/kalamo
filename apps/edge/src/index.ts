import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { checkImage, IMAGE_ID, ZibelError } from "@zibel/core";
import { createMcpServer } from "@zibel/mcp";
import { actorFor, permissionDenied } from "./auth.ts";
import { documentService, listDocuments, unwrap } from "./service.ts";

export { DocumentObject } from "./document-object.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // Browsers are not authenticated in M0: the viewer is read-only and local (ADR-0009).
    const ws = url.pathname.match(/^\/api\/docs\/([^/]+)\/ws$/)?.[1];
    if (ws) return env.DOCUMENT.get(env.DOCUMENT.idFromName(ws)).fetch(request);
    if (url.pathname === "/api/docs" && request.method === "POST") return openFile(request, env);
    const [, imageDoc, imageSrc] =
      url.pathname.match(/^\/api\/docs\/([^/]+)\/images\/([^/]+)$/) ?? [];
    if (imageDoc && imageSrc && request.method === "GET") return image(env, imageDoc, imageSrc);
    const place = url.pathname.match(/^\/api\/docs\/([^/]+)\/place$/)?.[1];
    if (place && request.method === "POST") return placeFile(place, request, env);
    const placeImage = url.pathname.match(/^\/api\/docs\/([^/]+)\/place-image$/)?.[1];
    if (placeImage && request.method === "POST") return placeBitmap(placeImage, request, env);
    const relink = url.pathname.match(/^\/api\/docs\/([^/]+)\/relink-image$/)?.[1];
    if (relink && request.method === "POST") return relinkBitmap(relink, request, env);
    if (url.pathname === "/api/docs") return Response.json({ documents: await listDocuments(env) });
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    const actor = actorFor(request, env.DEV_TOKENS);
    if (!actor) return permissionDenied();
    // GET would open a server-to-client stream and DELETE ends a session; stateless MCP has neither.
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    // Stateless (ADR-0006): no session id, a new server and transport per request.
    const server = createMcpServer(documentService(env, actor), actor);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * The browser's Open file: the file's text as the body, its name in `?name=`. Over HTTP, not the
 * WebSocket, since a file does not belong in a gesture message (ADR-0017); by the user.
 */
async function openFile(request: Request, env: Env): Promise<Response> {
  const name = new URL(request.url).searchParams.get("name") ?? undefined;
  return answer(async () => {
    const { docId, warnings } = await documentService(env, "user").open({
      content: await request.text(),
      name,
    });
    return { docId, warnings };
  });
}

/**
 * The browser's paste or drop of an SVG (Place, ADR-0017): the SVG as the body; `parentId`, the
 * centre `x`, `y`, `inPlace` for Paste in Place (ADR-0030) and the file's `name` in the query. By
 * the user, like Open.
 */
async function placeFile(docId: string, request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const x = Number(q.get("x") ?? Number.NaN);
  const y = Number(q.get("y") ?? Number.NaN);
  return answer(async () =>
    documentService(env, "user").place(docId, {
      svg: await request.text(),
      parentId: q.get("parentId") ?? "",
      ...(Number.isFinite(x) && Number.isFinite(y) && { position: { x, y } }),
      inPlace: q.has("inPlace"),
      name: q.get("name") ?? undefined,
    }),
  );
}

/**
 * The browser's paste or drop of a bitmap (ADR-0023): the file's bytes as the body; `parentId` and
 * the centre `x`, `y` in the query. An Image at its pixel size, by the user, like Place.
 */
async function placeBitmap(docId: string, request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const x = Number(q.get("x") ?? Number.NaN);
  const y = Number(q.get("y") ?? Number.NaN);
  return answer(async () => {
    // ponytail: read whole, under the platform's request cap (100 MB); stream with a cap if that bites.
    const file = checkImage(new Uint8Array(await request.arrayBuffer()), "file");
    const frame = Number.isFinite(x) && Number.isFinite(y);
    return unwrap(
      await env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)).placeImage(
        // The name only titles a Template Layer, which paste and drop never make.
        { ...file, name: "Image" },
        "user",
        {
          parentId: q.get("parentId") ?? "",
          ...(frame && { frame: { x: x - file.width / 2, y: y - file.height / 2 } }),
        },
      ),
    );
  });
}

/**
 * Object > Relink… (ADR-0042): the file's bytes as the body; the Image's `nodeId` and the file's
 * `name`, which a linked Image takes as its `file`, in the query. By the user, like Place.
 */
async function relinkBitmap(docId: string, request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams;
  return answer(async () => {
    const file = checkImage(new Uint8Array(await request.arrayBuffer()), "file");
    return unwrap(
      await env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)).relinkImage(
        { ...file, name: q.get("name") ?? undefined },
        "user",
        { nodeId: q.get("nodeId") ?? "" },
      ),
    );
  });
}

/**
 * An Image's file for the canvas (ADR-0023). An id always names the same bytes, so it is cached for
 * good. Unauthenticated like the WebSocket until M1 (ADR-0009).
 */
async function image(env: Env, docId: string, src: string): Promise<Response> {
  if (!IMAGE_ID.test(src)) return new Response("not found", { status: 404 });
  const result = await env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)).image(src);
  if ("error" in result) return Response.json(result.error, { status: 404 });
  return new Response(result.bytes, {
    headers: {
      "content-type": result.mime,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** `fn`'s result as JSON, or its ZibelError as a 400. */
async function answer(fn: () => Promise<object>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (e) {
    if (e instanceof ZibelError) return Response.json(e.data, { status: 400 });
    throw e;
  }
}
