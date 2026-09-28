import { createDocument, createNodes, type Document, type NodeInput } from "@zibel/core";
import type { ServerMessage } from "@zibel/sync";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { curvatureDown, curvatureUp } from "./curvature.ts";
import { DEFAULT_PENCIL, pencilDown, pencilMove, pencilUp, savePencilOptions } from "./pencil.ts";
import { receive } from "./receive.ts";
import { connect, DEFAULT_FILL_STROKE, send, useStore } from "./store.ts";
import { finishPen, penDown, penUp } from "./tools.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "sent"),
}));

type Point = [number, number];

/** A Rect isolated in a Group in the default Layer, with another Rect selected (ADR-0058). */
function isolateLeaf(scope: "leaf" | "group" = "leaf") {
  const { doc, defaultLayerId: layer } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = (clientKey: string) =>
    ({ type: "rect", clientKey, x: 0, y: 0, width: 10, height: 10 }) as const;
  const { keyMap } = createNodes(doc, [
    { type: "group", clientKey: "g", parentId: layer, children: [rect("leaf")] },
    { ...rect("other"), parentId: layer },
  ]);
  const id = (key: string) => keyMap[key] as string;
  const view = { isolated: id(scope === "leaf" ? "leaf" : "g"), selection: [id("other")] };
  useStore.setState({
    doc,
    pen: null,
    edit: null,
    drag: null,
    opPreview: null,
    anchors: [],
    segments: [],
    notice: null,
    fillStroke: DEFAULT_FILL_STROKE,
    ...view,
  });
  return { ...view, id };
}

const view = () => {
  const { isolated, selection } = useStore.getState();
  return { isolated, selection };
};
const deliver = (msg: ServerMessage) => {
  const next = receive(useStore.getState(), msg, "d");
  if (!next) throw new Error("missed rev");
  useStore.setState(next);
};
/** The Worker creating the one `create` sent: its `tx`, with the new path's id. */
function accept(): string {
  const [command] = vi.mocked(send).mock.lastCall ?? [];
  if (command?.type !== "create") throw new Error("no create");
  const doc = structuredClone(useStore.getState().doc) as Document;
  const { nodes } = createNodes(doc, command.nodes as NodeInput[]);
  deliver({
    type: "tx",
    rev: doc.rev + 1,
    txId: "t",
    actor: "user",
    intent: null,
    created: nodes,
    updated: [],
    deletedIds: [],
    commandId: "sent",
  });
  return nodes[0]?.id as string;
}
const reject = () =>
  deliver({
    type: "rejected",
    id: "sent",
    error: { code: "PERMISSION_DENIED", message: "Viewers cannot edit." },
  } as ServerMessage);
/** The Document a reconnect sends: a command dropped while the socket was down never arrived. */
const reconnect = () => {
  const doc = useStore.getState().doc as Document;
  deliver({
    type: "document",
    rev: doc.rev + 1,
    name: doc.name,
    artboards: doc.artboards,
    nodes: [...doc.nodes.values()],
    role: "editor",
  } as ServerMessage);
};

const drawPen = () => {
  for (const p of [[50, 50] as Point, [80, 60] as Point]) {
    penDown(p, 1);
    penUp();
  }
  finishPen();
};
const drawCurve = () => {
  for (const p of [[50, 50] as Point, [80, 60] as Point, [90, 90] as Point]) {
    vi.advanceTimersByTime(1000);
    curvatureDown(p, 1, false);
    curvatureUp();
  }
  finishPen();
};
const drawPencil = (keep = true) => {
  savePencilOptions({ ...DEFAULT_PENCIL, keepSelected: keep });
  pencilDown([50, 50]);
  for (let x = 51; x <= 120; x++)
    pencilMove([[x, 50 + ((x * 7) % 5)]], { shift: false, alt: false });
  pencilUp(1);
};
const tools: [string, () => void][] = [
  ["Pen", drawPen],
  ["Curvature", drawCurve],
  ["Pencil", drawPencil],
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.advanceTimersByTime(1000);
  savePencilOptions(DEFAULT_PENCIL);
  vi.mocked(send).mockClear();
});

describe.each(tools)("the %s with a leaf isolated (ADR-0058, #137)", (_, draw) => {
  it("sends the path into the leaf's parent and changes nothing while it is in flight", () => {
    const before = isolateLeaf();
    draw();
    const [command] = vi.mocked(send).mock.lastCall ?? [];
    expect(command).toMatchObject({ type: "create", nodes: [{ parentId: before.id("g") }] });
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
  });

  it("goes up one level and selects the path once the Worker creates it", () => {
    const { id } = isolateLeaf();
    draw();
    const path = accept();
    expect(view()).toEqual({ isolated: id("g"), selection: [path] });
    expect(useStore.getState().pen).toBeNull();
  });

  it("leaves the Isolation and Selection alone when the create is rejected, and says why", () => {
    const before = isolateLeaf();
    draw();
    reject();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
    expect(useStore.getState()).toMatchObject({ pen: null, notice: "Viewers cannot edit." });
  });

  it("leaves them alone when the command was dropped and the reconnect's Document arrives", () => {
    const before = isolateLeaf();
    draw();
    reconnect();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
    expect(useStore.getState().pen).toBeNull();
  });

  it("keeps an Isolation an Esc changed while the create was in flight", () => {
    const { id } = isolateLeaf();
    draw();
    useStore.setState({ isolated: null, selection: [id("g")] });
    const path = accept();
    expect(view()).toEqual({ isolated: null, selection: [path] });
  });

  it("keeps a Group scope, as without a leaf", () => {
    const before = isolateLeaf("group");
    draw();
    const [command] = vi.mocked(send).mock.lastCall ?? [];
    expect(command).toMatchObject({ nodes: [{ parentId: before.id("g") }] });
    const path = accept();
    expect(view()).toEqual({ isolated: before.id("g"), selection: [path] });
  });
});

it("the Pencil with Keep selected off goes up and selects nothing", () => {
  const { id } = isolateLeaf();
  drawPencil(false);
  accept();
  expect(view()).toEqual({ isolated: id("g"), selection: [] });
});

it("a prune by another Actor's tx while the create is in flight wins", () => {
  const { id } = isolateLeaf();
  drawPen();
  const doc = useStore.getState().doc as Document;
  const leaf = doc.nodes.get(id("leaf"));
  // Another Actor makes the leaf a Clipping Path: it can no longer be isolated.
  deliver({
    type: "tx",
    rev: doc.rev + 1,
    txId: "other",
    actor: "agent",
    intent: null,
    created: [],
    updated: [{ ...leaf, clipping: true } as never],
    deletedIds: [],
  });
  expect(useStore.getState().isolated).toBe(id("g"));
  const path = accept();
  expect(view()).toEqual({ isolated: id("g"), selection: [path] });
});

it("a tab switched away while the create is in flight keeps the leaf isolated on return", () => {
  const before = isolateLeaf();
  const doc = useStore.getState().doc as Document;
  let socket: { onmessage?: (e: { data: string }) => void } | undefined;
  vi.stubGlobal("location", { protocol: "http:", host: "x" });
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      onmessage?: (e: { data: string }) => void;
      constructor() {
        socket = this;
      }
      close() {}
    },
  );
  const disconnect = connect("d");
  useStore.setState({ isolated: before.isolated, selection: before.selection });
  const nodes = [...doc.nodes.values()];
  const { rev, name, artboards } = doc;
  socket?.onmessage?.({
    data: JSON.stringify({ type: "document", rev, name, artboards, nodes, role: "editor" }),
  });
  drawPen();
  // The Viewer's cleanup: the answer to the create is lost with the socket.
  disconnect();
  connect("d")();
  expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
  vi.unstubAllGlobals();
});
