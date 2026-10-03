import { createDocument, createNodes, type Node, type PathEditInput } from "@kalamo/core";
import { ACCESS_CHANGED, type Command, type ServerMessage } from "@kalamo/sync";
import { afterEach, expect, it, vi } from "vitest";
import { sendAnchorEdits } from "./anchorTools.ts";
import { anchorKey, clearInputs } from "./direct.ts";
import { afterRenumbering, connect, send, sendPathOp, unheld, useStore } from "./store.ts";
import { message } from "./testing.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps each Document Tab's Isolation while another tab is shown, and none for a new one", () => {
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      close() {}
    },
  );
  let stop = connect("a");
  useStore.setState({ isolated: "group-a", selection: ["x"] });
  stop();
  stop = connect("b");
  expect(useStore.getState()).toMatchObject({ isolated: null, selection: [] });
  stop();
  stop = connect("a");
  expect(useStore.getState()).toMatchObject({ isolated: "group-a", selection: ["x"] });
  stop();
});

it("forgets the Layer rows on any Selection change that does not set them, equal contents too", () => {
  useStore.setState({ selection: [], layerRows: ["L"] });
  expect(useStore.getState().layerRows).toEqual(["L"]);
  // Another empty Selection, as a click on empty canvas makes: the row does not come back.
  useStore.setState({ selection: [] });
  expect(useStore.getState().layerRows).toEqual([]);
  useStore.setState({ selection: [] });
  expect(useStore.getState().layerRows).toEqual([]);
  useStore.setState({ selection: ["x"], layerRows: ["L"] });
  useStore.setState({ notice: null });
  expect(useStore.getState().layerRows).toEqual(["L"]);
  useStore.setState({ selection: ["x"] });
  expect(useStore.getState().layerRows).toEqual([]);
});

/** A stubbed WebSocket per `connect`, the last one made, and every fetch. */
function stubSockets() {
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  const fetched = vi.fn(async () => ({ ok: true, json: async () => ({ actors: [] }) }));
  vi.stubGlobal("fetch", fetched);
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    closed = 0;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: (e: { code: number }) => void;
    constructor() {
      sockets.push(this);
    }
    send(m: string) {
      this.sent.push(m);
    }
    close() {
      this.closed++;
    }
    receive(msg: ServerMessage) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  return { fetched, last: () => sockets.at(-1) as FakeSocket };
}

it("runs what each message asks: a fetch and a full presence on a Document, a close on a missed rev", async () => {
  const { fetched, last } = stubSockets();
  const stop = connect("a");
  useStore.setState({ selection: ["x"] });
  last().receive(message("document", { peers: [{ peer: "p1", actor: "user_alice" }] }));
  expect(fetched).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(last().sent.map((m) => JSON.parse(m).selection)).toEqual([["x"]]));
  expect(useStore.getState()).toMatchObject({ live: true, role: "owner" });
  last().receive(message("tx", { rev: 5 }));
  expect(last().closed).toBe(1);
  stop();
});

it("stops when a socket closed for changed access fails again before a Document", () => {
  const { last } = stubSockets();
  vi.useFakeTimers();
  const stop = connect("a");
  last().onopen?.();
  last().receive(message("document"));
  last().onclose?.({ code: ACCESS_CHANGED });
  expect(useStore.getState()).toMatchObject({ live: false, peers: new Map() });
  vi.advanceTimersByTime(1000);
  // The new socket's Document keeps the tab going after its next close.
  last().onopen?.();
  last().receive(message("document"));
  last().onclose?.({ code: 1006 });
  vi.advanceTimersByTime(1000);
  expect(useStore.getState().notice).toBeNull();
  last().onopen?.();
  last().onclose?.({ code: ACCESS_CHANGED });
  vi.advanceTimersByTime(1000);
  last().onopen?.();
  last().onclose?.({ code: 1006 });
  expect(useStore.getState().notice).toBe("This Document is no longer shared with you.");
  vi.useRealTimers();
  stop();
});

// tsc checks this test: each @ts-expect-error fails the check once its line compiles (ADR-0110).
it("sends a command that names Anchors by index, or any path_op, only once it waited or says why it need not", () => {
  const input: PathEditInput = { nodeId: "p", ops: [{ op: "move_anchor", index: 0, to: [1, 1] }] };
  const anchors = [{ nodeId: "p", subpath: 0, index: 0 }];
  // @ts-expect-error A path_edit names Anchors by index.
  send({ type: "path_edit", input });
  // @ts-expect-error So does a Join of chosen Anchors.
  send({ type: "path_op", input: { nodeIds: ["p"], op: "join", anchors } });
  // @ts-expect-error And the Pen's path_join.
  send({ type: "path_join", edit: input, join: { nodeIds: ["p"], op: "join", anchors } });
  const some = { type: "undo" } as Command;
  // @ts-expect-error A command that may be any of them.
  send(some);
  send({ type: "path_edit", input }, unheld("a test"));
  // @ts-expect-error Only a path_edit's ops may leave how it renumbers to the sender.
  send({ type: "path_op", input: { nodeIds: ["p"], op: "unite" } }, unheld("a test"), null);
  afterRenumbering((_s, w) =>
    send({ type: "path_op", input: { nodeIds: ["p"], op: "join", anchors } }, w),
  );
  // @ts-expect-error A path_op on whole Nodes reshapes or replaces paths held edits name by index.
  send({ type: "path_op", input: { nodeIds: ["p"], op: "add_anchors" } });
  afterRenumbering((_s, w) => send({ type: "path_op", input: { nodeIds: ["p"], op: "unite" } }, w));
  // A press, which names subpaths, and a delete, which waits by call-site convention (#288).
  send({ type: "path_reverse", subpaths: [{ nodeId: "p", subpath: 0 }], clockwise: true });
  send({ type: "delete", nodeIds: ["p"] });
  expect(useStore.getState().held).toEqual([]);
});

// tsc checks this test: each @ts-expect-error fails the check once its line compiles.
it("takes no sent op preview into a held op or its send step (#306, #299)", () => {
  const op = {
    input: { nodeIds: [], op: "simplify" as const },
    geometry: undefined,
    commandId: "c1",
  };
  // Never called: it only has to compile, or not.
  () => {
    // @ts-expect-error A sent op preview never goes back into a held op.
    afterRenumbering(() => {}, { op });
    // @ts-expect-error
    sendPathOp(op.input, op);
  };
});

// tsc checks this test: each @ts-expect-error fails the check once its line compiles.
it("holds an edit on a seed only with its tool's drop notices (#300)", () => {
  // Never called: it only has to compile, or not.
  () => {
    // @ts-expect-error A seed without a redraw would be dropped with no notice.
    afterRenumbering(() => {}, { seed: ["c1"] });
    // @ts-expect-error So would a redraw's seed without its notices.
    afterRenumbering(() => {}, { redraw: { run: () => "", seed: ["c1"] } });
  };
});

it("opens the window with Clear's own renumbering in the one step that sends it (#300)", () => {
  const { last } = stubSockets();
  const stop = connect("a");
  const { doc, defaultLayerId: parentId } = createDocument({ id: "d", name: "Doc", artboards: [] });
  const [rect] = createNodes(doc, [
    { type: "rect", parentId, x: 0, y: 0, width: 10, height: 10 },
  ] as never).nodes as [Node];
  const edits = clearInputs(doc, [rect.id], [], [anchorKey(rect.id, 0, 3)]);
  // Every renumbering the store held, from the Clear's send on.
  const seen: unknown[] = [];
  const unsubscribe = useStore.subscribe(({ renumbering }) => seen.push(...renumbering.values()));
  sendAnchorEdits(edits, unheld("a test"));
  unsubscribe();
  const [sent] = last().sent.map((m) => JSON.parse(m).id as string);
  expect(useStore.getState().renumbering).toEqual(new Map([[sent, edits.known[0]]]));
  // Never "cannot number", which a `set_d` alone says.
  expect(seen.every((r) => r === edits.known[0])).toBe(true);
  stop();
});

it("records a command only when it goes out on an open socket, until its answer (#288)", () => {
  const { last } = stubSockets();
  const stop = connect("a");
  last().receive(message("document"));
  const id = send({ type: "undo" });
  expect(useStore.getState().sent).toEqual(new Set([id]));
  last().receive(message("tx", { rev: 1, commandId: id }));
  expect(useStore.getState().sent).toEqual(new Set());
  const rejected = send({ type: "redo" });
  last().receive(message("rejected", { id: rejected }));
  expect(useStore.getState().sent).toEqual(new Set());
  // Sent while the socket is down, it never went out, so nothing waits on its answer.
  last().readyState = 3;
  send({ type: "undo" });
  expect(useStore.getState().sent).toEqual(new Set());
  last().readyState = 1;
  send({ type: "undo" });
  last().receive(message("document", { rev: 4 }));
  expect(useStore.getState().sent).toEqual(new Set());
  stop();
});
