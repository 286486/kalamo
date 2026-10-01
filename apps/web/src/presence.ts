import {
  type ClientMessage,
  PRESENCE_INTERVAL,
  type PresenceMessage,
  type ServerMessage,
} from "@kalamo/sync";

/** The pointer in document coordinates, or null off the canvas (ADR-0090). */
export type Pointer = PresenceMessage["cursor"];

/** Another connection to the Document, as its last messages left it (ADR-0090). */
export interface PeerView {
  actor: string;
  cursor: Pointer;
  selection: string[];
}

/** Every other Peer of the Document, by `peer` id. */
export type Peers = ReadonlyMap<string, PeerView>;

/**
 * The Peers after one server message. A `document` starts over from its `peers`; a presence
 * message without a `selection` keeps the Peer's last one.
 */
export function peersAfter(peers: Peers, msg: ServerMessage): Peers {
  if (msg.type === "document")
    return new Map(msg.peers.map((p) => [p.peer, { actor: p.actor, cursor: null, selection: [] }]));
  if (msg.type !== "presence" && msg.type !== "joined" && msg.type !== "left") return peers;
  const next = new Map(peers);
  if (msg.type === "left") next.delete(msg.peer);
  else if (msg.type === "joined")
    next.set(msg.peer, { actor: msg.actor, cursor: null, selection: [] });
  else {
    const selection = msg.selection ?? peers.get(msg.peer)?.selection ?? [];
    next.set(msg.peer, { actor: msg.actor, cursor: msg.cursor, selection });
  }
  return next;
}

/** A Selection longer than this is sent as its first ids (ADR-0090). */
const MAX_IDS = 1000;

/**
 * Sends this browser's cursor and Selection: at most one message per PRESENCE_INTERVAL, only on a
 * change, and the last change of an interval at its end. `resend` makes the next message carry
 * both in full, changed or not: after each `document`, so nothing sent on an earlier socket counts,
 * and on each `joined`, which asks for it.
 */
export function presenceSender(post: (msg: ClientMessage) => void, selection: string[] = []) {
  let cursor: Pointer = null;
  /** What the Peers last got; null when they must get everything. */
  let sent: { cursor: Pointer; selection: string[] } | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    const moved = !sent || sent.cursor?.x !== cursor?.x || sent.cursor?.y !== cursor?.y;
    const reselected = !sent || !sameIds(sent.selection, selection);
    if (!moved && !reselected) return;
    lastAt = Date.now();
    sent = { cursor, selection };
    post({
      type: "presence",
      cursor,
      ...(reselected && { selection: selection.slice(0, MAX_IDS) }),
    });
  };
  const schedule = () => {
    if (timer !== undefined) return;
    const wait = lastAt + PRESENCE_INTERVAL - Date.now();
    if (wait <= 0) flush();
    else timer = setTimeout(flush, wait);
  };
  return {
    update(next: { cursor?: Pointer; selection?: string[] }) {
      if (next.cursor !== undefined) cursor = next.cursor;
      if (next.selection) selection = next.selection;
      schedule();
    },
    resend() {
      sent = null;
      schedule();
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Every browser picks an Actor's colour from these by the same hash, so all agree (ADR-0090). */
export const PEER_COLORS = [
  "#E8413C",
  "#F08C00",
  "#2F9E44",
  "#1C7ED6",
  "#7048E8",
  "#D6336C",
  "#0C8599",
  "#5C940D",
] as const;

/** An Actor's colour, by an FNV-1a hash of its id. */
export function colorOf(actor: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < actor.length; i++) h = Math.imul(h ^ actor.charCodeAt(i), 0x01000193);
  return PEER_COLORS[(h >>> 0) % PEER_COLORS.length] as string;
}

/** An Actor's label: its row's name, or its id, a User Actor's without the `user_` prefix. */
export const labelOf = (names: ReadonlyMap<string, string>, actor: string) =>
  names.get(actor) ?? actor.replace(/^user_/, "");
