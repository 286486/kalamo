import { ACCESS_CHANGED, type ServerMessage } from "@kalamo/sync";
import { afterEach, expect, it, vi } from "vitest";
import { connect, useStore } from "./store.ts";
import { message } from "./testing.ts";

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
