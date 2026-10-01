import { type ClientMessage, PRESENCE_INTERVAL, type ServerMessage } from "@kalamo/sync";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AREA_SHOWN,
  areasAfter,
  colorOf,
  labelOf,
  PEER_COLORS,
  type Peers,
  peersAfter,
  presenceSender,
  visibleAreas,
} from "./presence.ts";

const document = (peers: { peer: string; actor: string }[]): ServerMessage => ({
  type: "document",
  rev: 1,
  name: "Doc",
  artboards: [],
  nodes: [],
  role: "owner",
  peers,
});

it("adds, updates and removes Peers, keeping a Selection a message leaves out", () => {
  let peers: Peers = peersAfter(new Map(), document([{ peer: "p1", actor: "user_alice" }]));
  expect([...peers]).toEqual([["p1", { actor: "user_alice", cursor: null, selection: [] }]]);
  peers = peersAfter(peers, { type: "joined", peer: "p2", actor: "agent-a" });
  peers = peersAfter(peers, {
    type: "presence",
    peer: "p1",
    actor: "user_alice",
    cursor: { x: 1, y: 2 },
    selection: ["n1"],
  });
  peers = peersAfter(peers, { type: "presence", peer: "p1", actor: "user_alice", cursor: null });
  expect(peers.get("p1")).toEqual({ actor: "user_alice", cursor: null, selection: ["n1"] });
  expect(peers.has("p2")).toBe(true);
  peers = peersAfter(peers, { type: "left", peer: "p2" });
  expect([...peers.keys()]).toEqual(["p1"]);
  // A reconnect drops every Peer and starts over.
  expect([...peersAfter(peers, document([{ peer: "p3", actor: "user_bob" }])).keys()]).toEqual([
    "p3",
  ]);
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const sender = () => {
  const sent: ClientMessage[] = [];
  return { sent, s: presenceSender((m) => sent.push(m)) };
};

it("sends at most one message per interval, and always the last change", () => {
  const { sent, s } = sender();
  s.update({ cursor: { x: 0, y: 0 } });
  for (let x = 1; x <= 10; x++) s.update({ cursor: { x, y: 0 } });
  expect(sent).toEqual([{ type: "presence", cursor: { x: 0, y: 0 }, selection: [] }]);
  vi.advanceTimersByTime(PRESENCE_INTERVAL - 1);
  expect(sent).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual({ type: "presence", cursor: { x: 10, y: 0 } });
  // Nothing changed: nothing sent.
  vi.advanceTimersByTime(PRESENCE_INTERVAL * 3);
  s.update({ cursor: { x: 10, y: 0 } });
  expect(sent).toHaveLength(2);
  s.update({ selection: ["n1"] });
  expect(sent[2]).toEqual({ type: "presence", cursor: { x: 10, y: 0 }, selection: ["n1"] });
});

it("sends cursor and Selection in full after resend, whatever was sent before", () => {
  const { sent, s } = sender();
  s.update({ cursor: { x: 1, y: 1 }, selection: ["n1"] });
  vi.advanceTimersByTime(PRESENCE_INTERVAL);
  // A new socket's `document`: the Selection is sent again, unchanged.
  s.resend();
  vi.advanceTimersByTime(PRESENCE_INTERVAL);
  expect(sent).toEqual([
    { type: "presence", cursor: { x: 1, y: 1 }, selection: ["n1"] },
    { type: "presence", cursor: { x: 1, y: 1 }, selection: ["n1"] },
  ]);
});

it("sends a Selection's first 1 000 ids", () => {
  const { sent, s } = sender();
  s.update({ selection: Array.from({ length: 1500 }, (_, i) => `n${i}`) });
  expect((sent[0] as { selection: string[] }).selection).toHaveLength(1000);
});

it("gives an Actor the same colour every time, from the palette", () => {
  expect(colorOf("user_alice")).toBe(colorOf("user_alice"));
  expect(PEER_COLORS).toContain(colorOf("agent-a"));
  // Every browser computes the same one.
  expect(colorOf("user_alice")).toMatchInlineSnapshot(`"#F08C00"`);
});

it("labels an Actor by its row, else by its id without the user_ prefix", () => {
  const names = new Map([["user_1", "woody"]]);
  expect(labelOf(names, "user_1")).toBe("woody");
  expect(labelOf(names, "user_alice")).toBe("alice");
  expect(labelOf(names, "agent-a")).toBe("agent-a");
});

const box = (x: number) => ({ x, y: 0, width: 10, height: 10 });
const write = (
  type: "tx" | "staged",
  actor: string,
  bounds: ReturnType<typeof box> | null,
  intent: string | null,
): ServerMessage =>
  type === "staged"
    ? { type, txId: "t1", actor, intent, bounds }
    : { type, rev: 2, txId: "t1", actor, intent, bounds, created: [], updated: [], deletedIds: [] };

it("moves an Agent's Working Area with each write, keeping its bounds and intent over nulls", () => {
  let areas = areasAfter(new Map(), write("staged", "agent-a", box(0), "Draw a logo"), 1000);
  areas = areasAfter(areas, write("tx", "agent-a", box(50), null), 2000);
  expect(areas.get("agent-a")).toEqual({ bounds: box(50), intent: "Draw a logo", at: 2000 });
  areas = areasAfter(areas, write("staged", "agent-a", null, "Recolour it"), 3000);
  expect(areas.get("agent-a")).toEqual({ bounds: box(50), intent: "Recolour it", at: 3000 });
  expect(areasAfter(areas, document([]), 4000)).toBe(areas);
});

it("shows an Agent's area until 5 minutes after its last write, and never a User's", () => {
  let areas = areasAfter(new Map(), write("tx", "agent-a", box(0), "Draw"), 0);
  areas = areasAfter(areas, write("tx", "user_alice", box(5), null), 0);
  areas = areasAfter(areas, write("tx", "user", box(5), null), 0);
  areas = areasAfter(areas, write("tx", "a1", box(5), null), 0);
  // a1's row says it is a User Actor, whatever its id.
  const kinds = new Map([["a1", "user"]]);
  const shown = (now: number) => visibleAreas(areas, kinds, now).map((a) => a.actor);
  expect(shown(AREA_SHOWN - 1000)).toEqual(["agent-a"]);
  expect(shown(AREA_SHOWN)).toEqual([]);
  // With no row, a1's id reads as an Agent's.
  expect(visibleAreas(areas, new Map(), 0).map((a) => a.actor)).toEqual(["agent-a", "a1"]);
});
