import { type ClientMessage, PRESENCE_INTERVAL, type ServerMessage } from "@kalamo/sync";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  colorOf,
  labelOf,
  PEER_COLORS,
  type Peers,
  peersAfter,
  presenceSender,
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
