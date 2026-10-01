import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BLUE_1x1_PNG, RED_2x2_PNG } from "../../../fixtures/images.ts";
import { authorizeMcp } from "./authorize.ts";
import { browser, bytes, type Person, person, shareWith, socket, tool } from "./people.ts";
import { call, errorOf } from "./rpc.ts";
import { APP_ORIGIN, hosted } from "./signin.ts";

type Role = "none" | "viewer" | "editor" | "owner";
const ROLES: Role[] = ["none", "viewer", "editor", "owner"];

let people: Promise<Record<Role, Person>> | undefined;
/** One person per Role, made once for the file. */
const cast = () => {
  people ??= (async () => ({
    none: await person("nora"),
    viewer: await person("vic"),
    editor: await person("eddie"),
    owner: await person("olive"),
  }))();
  return people;
};

/** The owner's new Document, shared with the viewer and the editor, holding one Image. */
async function sharedDoc() {
  const p = await cast();
  const { ok } = await tool(p.owner, "kalamo_doc_create", {
    name: "Shared",
    artboards: [{ width: 100, height: 100 }],
  });
  const { docId, defaultLayerId } = ok;
  expect((await shareWith(p.owner, docId, "vic", "viewer")).status).toBe(200);
  expect((await shareWith(p.owner, docId, "EDDIE", "editor")).status).toBe(200);
  const placed = await browser(
    p.owner,
    `/api/docs/${docId}/place-image?parentId=${defaultLayerId}`,
    {
      method: "POST",
      body: bytes(RED_2x2_PNG),
    },
  );
  const { createdIds } = (await placed.json()) as { createdIds: string[] };
  const imageId = createdIds[0] as string;
  const got = await tool(p.owner, "kalamo_node_get", {
    docId,
    nodeIds: [imageId],
    detail: "full",
  });
  return { docId, layerId: defaultLayerId as string, imageId, src: got.ok.nodes[0].src as string };
}

type Outcome = "ok" | "DOC_NOT_FOUND" | "PERMISSION_DENIED";

/** Each route family, run as `who`, gives its outcome. */
const FAMILIES: Record<
  string,
  (who: Person, doc: Awaited<ReturnType<typeof sharedDoc>>) => Promise<Outcome>
> = {
  "MCP read": async (who, { docId }) => {
    const { error } = await tool(who, "kalamo_doc_get_info", { docId });
    return error?.code ?? "ok";
  },
  "MCP write": async (who, { docId, layerId }) => {
    const { error } = await tool(who, "kalamo_node_create", {
      docId,
      nodes: [{ type: "rect", parentId: layerId, x: 0, y: 0, width: 5, height: 5 }],
    });
    return error?.code ?? "ok";
  },
  "WebSocket read": async (who, { docId }) => {
    const s = await socket(who, docId);
    if (!s.ws) return s.res.status === 404 ? "DOC_NOT_FOUND" : "PERMISSION_DENIED";
    const first = await s.next();
    s.ws.close();
    expect(first.type).toBe("document");
    return "ok";
  },
  "WebSocket command": async (who, { docId, imageId }) => {
    const s = await socket(who, docId);
    if (!s.ws) return s.res.status === 404 ? "DOC_NOT_FOUND" : "PERMISSION_DENIED";
    await s.next();
    // Each Role toggles it the other way, so no update is a no-op.
    s.send("c1", { type: "update", nodeId: imageId, patch: { visible: who.login === "olive" } });
    const answer = await s.next();
    // An Alt-drag copy (ADR-0076) is refused the same way.
    s.send("c2", { type: "duplicate", input: { nodeIds: [imageId] } });
    const copy = await s.next();
    s.ws.close();
    expect(copy.type).toBe(answer.type);
    return answer.type === "rejected" ? (answer.error.code as Outcome) : "ok";
  },
  "Place, place-image, relink": async (who, { docId, layerId, imageId }) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
    const responses = [
      await browser(who, `/api/docs/${docId}/place?parentId=${layerId}`, {
        method: "POST",
        body: svg,
      }),
      await browser(who, `/api/docs/${docId}/place-image?parentId=${layerId}`, {
        method: "POST",
        body: bytes(BLUE_1x1_PNG),
      }),
      await browser(who, `/api/docs/${docId}/relink-image?nodeId=${imageId}&name=b.png`, {
        method: "POST",
        body: bytes(BLUE_1x1_PNG),
      }),
    ];
    const statuses = new Set(responses.map((r) => r.status));
    expect(statuses.size).toBe(1);
    return outcomeOf(responses[0] as Response);
  },
  "image route": async (who, { docId, src }) => {
    const res = await browser(who, `/api/docs/${docId}/images/${src}`);
    if (res.ok) {
      expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    }
    return outcomeOf(res);
  },
  "Document read": async (who, { docId }) => {
    const res = await browser(who, `/api/docs/${docId}`);
    if (res.ok) {
      const role = { vic: "viewer", eddie: "editor", olive: "owner" }[who.login];
      expect(await res.json()).toEqual({ docId, name: "Shared", role });
      return "ok";
    }
    return outcomeOf(res);
  },
  members: async (who, { docId }) => outcomeOf(await browser(who, `/api/docs/${docId}/members`)),
  delete: async (who, { docId }) =>
    outcomeOf(await browser(who, `/api/docs/${docId}`, { method: "DELETE" })),
};

async function outcomeOf(res: Response): Promise<Outcome> {
  if (res.ok) {
    await res.body?.cancel();
    return "ok";
  }
  const { code } = (await res.json()) as { code: Outcome };
  expect(res.status).toBe(code === "DOC_NOT_FOUND" ? 404 : 403);
  return code;
}

const N = "DOC_NOT_FOUND";
const D = "PERMISSION_DENIED";
/** The expected outcome per family, in ROLES order: none, viewer, editor, owner. */
const EXPECTED: Record<keyof typeof FAMILIES, Outcome[]> = {
  "MCP read": [N, "ok", "ok", "ok"],
  "MCP write": [N, D, "ok", "ok"],
  "WebSocket read": [N, "ok", "ok", "ok"],
  "WebSocket command": [N, D, "ok", "ok"],
  "Place, place-image, relink": [N, D, "ok", "ok"],
  "image route": [N, "ok", "ok", "ok"],
  "Document read": [N, "ok", "ok", "ok"],
  members: [N, D, D, "ok"],
  delete: [N, D, D, "ok"],
};

describe("each Role on each route family", () => {
  for (const [family, run] of Object.entries(FAMILIES)) {
    it(family, async () => {
      const p = await cast();
      const doc = await sharedDoc();
      const outcomes: Outcome[] = [];
      for (const role of ROLES) outcomes.push(await run(p[role], doc));
      expect(outcomes).toEqual(EXPECTED[family]);
    });
  }
});

describe("a read-only token", () => {
  it("is a viewer of its own User's Document: render works, node_create and tx_begin do not", async () => {
    const { owner } = await cast();
    const { docId, layerId } = await sharedDoc();
    const { tokens } = await authorizeMcp(owner.cookie, { readOnly: true });
    const reader = { ...owner, token: tokens.access_token };
    expect((await tool(reader, "kalamo_render", { docId })).error).toBeNull();
    for (const [name, args] of [
      [
        "kalamo_node_create",
        { docId, nodes: [{ type: "rect", parentId: layerId, x: 0, y: 0, width: 1, height: 1 }] },
      ],
      ["kalamo_tx_begin", { docId }],
      ["kalamo_doc_create", { name: "D", artboards: [{ width: 1, height: 1 }] }],
    ] as const) {
      const { error } = await tool(reader, name, args);
      expect(error).toMatchObject({
        code: "PERMISSION_DENIED",
        hint: expect.stringContaining("viewer"),
      });
    }
    const { ok } = await tool(reader, "kalamo_doc_list", {});
    expect(ok.documents.find((d: { docId: string }) => d.docId === docId)?.role).toBe("viewer");
  });
});

describe("listing", () => {
  it("shows only the caller's own and shared Documents, each with the caller's Role", async () => {
    const p = await cast();
    const { docId } = await sharedDoc();
    const mine = await tool(p.none, "kalamo_doc_create", {
      name: "Nora's",
      artboards: [{ width: 1, height: 1 }],
    });
    const listed = async (who: Person) => {
      const res = await browser(who, "/api/docs");
      const { documents } = (await res.json()) as { documents: { docId: string; role: string }[] };
      const viaMcp = (await tool(who, "kalamo_doc_list", {})).ok.documents;
      expect(viaMcp).toEqual(documents);
      return documents;
    };
    const nora = await listed(p.none);
    expect(nora.find((d) => d.docId === docId)).toBeUndefined();
    expect(nora.find((d) => d.docId === mine.ok.docId)?.role).toBe("owner");
    for (const role of ["viewer", "editor", "owner"] as const) {
      const docs = await listed(p[role]);
      expect(docs.find((d) => d.docId === docId)?.role).toBe(role);
      expect(docs.find((d) => d.docId === mine.ok.docId)).toBeUndefined();
    }
  });

  it("makes the caller of Open the owner", async () => {
    const { none } = await cast();
    const res = await browser(none, "/api/docs?name=a.svg", {
      method: "POST",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    });
    const { docId } = (await res.json()) as { docId: string };
    const owner = await env.DB.prepare("SELECT owner_id FROM documents WHERE id = ?")
      .bind(docId)
      .first<string>("owner_id");
    const userId = await env.DB.prepare("SELECT id FROM users WHERE login = 'nora'").first<string>(
      "id",
    );
    expect(owner).toBe(userId);
  });
});

describe("sharing", () => {
  it("closes a removed or downgraded member's socket with 4003, and the reconnect has the new Role", async () => {
    const p = await cast();
    const { docId } = await sharedDoc();
    const editor = await socket(p.editor, docId);
    expect(await editor.next?.()).toMatchObject({ type: "document", role: "editor" });
    const viewer = await socket(p.viewer, docId);
    expect(await viewer.next?.()).toMatchObject({ type: "document", role: "viewer" });

    expect((await shareWith(p.owner, docId, "eddie", "viewer")).status).toBe(200);
    expect((await editor.closed)?.code).toBe(4003);
    const again = await socket(p.editor, docId);
    expect(await again.next?.()).toMatchObject({ type: "document", role: "viewer" });
    again.ws?.close();

    const removed = await browser(p.owner, `/api/docs/${docId}/members/vic`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await viewer.closed)?.code).toBe(4003);
    expect((await socket(p.viewer, docId)).res.status).toBe(404);
    expect(await outcomeOf(await browser(p.viewer, `/api/docs/${docId}`))).toBe("DOC_NOT_FOUND");
    expect((await browser(p.owner, `/api/docs/${docId}`)).status).toBe(200);
  });

  it("relays a viewer's presence, and sends left for each socket 4003 closes (ADR-0090)", async () => {
    const p = await cast();
    const { docId } = await sharedDoc();
    const owner = await socket(p.owner, docId);
    await owner.next?.();
    const viewer = await socket(p.viewer, docId);
    const doc = await viewer.next?.();
    expect(doc).toMatchObject({
      type: "document",
      role: "viewer",
      peers: [{ actor: expect.any(String) }],
    });
    const joined = await owner.next?.();
    if (joined?.type !== "joined") throw new Error("no joined");
    const tab = await socket(p.viewer, docId);
    await tab.next?.();
    const joinedTab = await owner.next?.();
    await viewer.next?.();
    if (joinedTab?.type !== "joined") throw new Error("no joined");
    expect(joinedTab.actor).toBe(joined.actor);

    viewer.ws?.send(JSON.stringify({ type: "presence", cursor: { x: 3, y: 4 }, selection: [] }));
    expect(await owner.next?.()).toEqual({
      type: "presence",
      peer: joined.peer,
      actor: joined.actor,
      cursor: { x: 3, y: 4 },
      selection: [],
    });
    await tab.next?.();

    expect((await shareWith(p.owner, docId, "vic", "editor")).status).toBe(200);
    expect((await viewer.closed)?.code).toBe(4003);
    expect((await tab.closed)?.code).toBe(4003);
    const left = [await owner.next?.(), await owner.next?.()];
    expect(left).toContainEqual({ type: "left", peer: joined.peer });
    expect(left).toContainEqual({ type: "left", peer: joinedTab.peer });
    owner.ws?.close();
  });

  it("answers the Document read route with 401 without a session", async () => {
    const { docId } = await sharedDoc();
    const res = await hosted(`/api/docs/${docId}`, { headers: { origin: APP_ORIGIN } });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("lists members for the owner", async () => {
    const { owner } = await cast();
    const { docId } = await sharedDoc();
    const res = await browser(owner, `/api/docs/${docId}/members`);
    expect(await res.json()).toEqual({
      members: [
        { login: "eddie", avatarUrl: expect.any(String), role: "editor" },
        { login: "vic", avatarUrl: expect.any(String), role: "viewer" },
      ],
    });
  });

  it("refuses a login that never signed in, the owner's own, and an unknown Role, with INVALID_INPUT", async () => {
    const { owner } = await cast();
    const { docId } = await sharedDoc();
    for (const [login, role, hint] of [
      ["never-signed-in", "editor", "sign in to Kalamo"],
      ["Olive", "editor", "someone else"],
      ["vic", "owner", "viewer"],
    ]) {
      const res = await shareWith(owner, docId, login as string, role as string);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "INVALID_INPUT",
        hint: expect.stringContaining(hint as string),
      });
    }
  });

  it("ignores an Actor, User or Role header a client sends", async () => {
    const p = await cast();
    const { docId, imageId } = await sharedDoc();
    const s = await socket(p.viewer, docId, {
      "x-kalamo-actor": "forged",
      "x-kalamo-user": "forged",
      "x-kalamo-role": "owner",
    });
    expect(await s.next?.()).toMatchObject({ type: "document", role: "viewer" });
    s.send?.("f1", { type: "update", nodeId: imageId, patch: { visible: false } });
    expect(await s.next?.()).toMatchObject({
      type: "rejected",
      id: "f1",
      error: { code: "PERMISSION_DENIED" },
    });
    s.ws?.close();
  });
});

describe("kalamo_doc_delete", () => {
  it("by the owner removes the Document for every member; by an editor it is PERMISSION_DENIED", async () => {
    const p = await cast();
    const { docId, src } = await sharedDoc();
    expect((await tool(p.editor, "kalamo_doc_delete", { docId })).error).toMatchObject({
      code: "PERMISSION_DENIED",
      hint: expect.stringContaining("editor"),
    });
    const watching = await socket(p.viewer, docId);
    await watching.next?.();
    expect((await tool(p.owner, "kalamo_doc_delete", { docId })).ok).toEqual({
      docId,
      deleted: true,
    });
    expect((await watching.closed)?.code).toBe(4004);
    for (const role of ["viewer", "editor", "owner"] as const) {
      expect((await tool(p[role], "kalamo_doc_get_info", { docId })).error?.code).toBe(
        "DOC_NOT_FOUND",
      );
    }
    const left = await env.DB.prepare("SELECT count(*) AS n FROM members WHERE doc_id = ?")
      .bind(docId)
      .first<number>("n");
    expect(left).toBe(0);
    expect(await env.IMAGES.list({ prefix: `docs/${docId}/` })).toMatchObject({ objects: [] });
    expect(src).toBeTruthy();
    const info = await env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)).info();
    expect(info).toMatchObject({ error: { code: "DOC_NOT_FOUND" } });
  });
});

describe("dev mode", () => {
  it("keeps every existing Document visible and editable as the local User", async () => {
    const { docId, defaultLayerId } = (
      await call("kalamo_doc_create", { name: "Old", artboards: [{ width: 10, height: 10 }] })
    ).structuredContent;
    // Owned by someone else, as a hosted row would be: dev mode still owns it.
    await env.DB.prepare("UPDATE documents SET owner_id = 'someone' WHERE id = ?")
      .bind(docId)
      .run();
    const res = await exports.default.fetch("http://kalamo/api/docs");
    const { documents } = (await res.json()) as { documents: { docId: string; role: string }[] };
    expect(documents.find((d) => d.docId === docId)?.role).toBe("owner");
    const created = await call("kalamo_node_create", {
      docId,
      nodes: [{ type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 1, height: 1 }],
    });
    expect(errorOf(created)).toBeNull();
  });
});
