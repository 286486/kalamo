import { createDocument, createNodes, type NodeInput } from "@kalamo/core";
import { afterEach, expect, it, vi } from "vitest";
import { connect, useStore } from "./store.ts";

afterEach(() => {
  vi.unstubAllGlobals();
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

it("fetches the Actor names on each Document and once per unknown Actor, and resends presence in full", async () => {
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  const fetched = vi.fn(async () => ({ ok: true, json: async () => ({ actors: [] }) }));
  vi.stubGlobal("fetch", fetched);
  let socket: { onmessage?: (e: { data: string }) => void; sent: string[] } | undefined;
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      onmessage?: (e: { data: string }) => void;
      constructor() {
        socket = this;
      }
      send(m: string) {
        this.sent.push(m);
      }
      close() {}
    },
  );
  const { doc, defaultLayerId } = createDocument({ id: "a", name: "A", artboards: [] });
  const rect = { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 1, height: 1 };
  const [box] = createNodes(doc, [rect as NodeInput]).nodes;
  const stop = connect("a");
  useStore.setState({ selection: [box?.id ?? ""] });
  const receive = (msg: object) => socket?.onmessage?.({ data: JSON.stringify(msg) });
  const document = {
    type: "document",
    rev: 0,
    name: "A",
    artboards: [],
    nodes: [...doc.nodes.values()],
    role: "owner",
    peers: [{ peer: "p1", actor: "user_alice" }],
  };
  const presence = { type: "presence", peer: "p2", actor: "agent-a", cursor: null };
  const full = () =>
    socket?.sent.filter((m) => JSON.parse(m).selection?.[0] === box?.id).length ?? 0;
  receive(document);
  await vi.waitFor(() => expect(full()).toBe(1));
  receive(presence);
  receive(presence);
  receive({ ...presence, peer: "p3" });
  expect(fetched).toHaveBeenCalledTimes(2);
  // A new socket's Document starts over: one fetch, and the unchanged Selection again.
  receive(document);
  receive(presence);
  expect(fetched).toHaveBeenCalledTimes(4);
  await vi.waitFor(() => expect(full()).toBe(2));
  stop();
});
