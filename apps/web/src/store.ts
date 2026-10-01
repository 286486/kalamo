import { newId } from "@kalamo/core";
import {
  ACCESS_CHANGED,
  type ClientMessage,
  type Command,
  DOC_DELETED,
  type Role,
  type ServerMessage,
  TOO_MANY_CONNECTIONS,
} from "@kalamo/sync";
import { create } from "zustand";
import { parseKey } from "./direct.ts";
import type { ImageCache } from "./images.ts";
import { type Areas, areasAfter, type Pointer, presenceSender } from "./presence.ts";
import { afterProbe, type Probe, receive, type ViewState } from "./receive.ts";
import type { Tool, ToolGroup } from "./toolbox.ts";
import type { FillStroke } from "./tools.ts";
import type { Viewport } from "./viewport.ts";

export interface State extends ViewState {
  /** False while the socket is down; the last Document stays on screen. */
  live: boolean;
  /** The shown Document's Role, from the socket (ADR-0047); null until it connects. */
  role: Role | null;
  /** Null until the first Document arrives and is fitted to the screen. */
  viewport: Viewport | null;
  /** The canvas in CSS px. */
  size: { width: number; height: number };
  /** The shown Document's image files, which the downloads embed. */
  images: ImageCache | null;
  /** Window > Layers. */
  layersShown: boolean;
  /** Window > Gradient (ADR-0081). */
  gradientShown: boolean;
  tool: Tool;
  /** The tool each Tools panel group shows: the last chosen from it. */
  front: Partial<Record<ToolGroup, Tool>>;
  /** The Fill and Stroke boxes, kept across Document Tabs as in Illustrator. */
  fillStroke: FillStroke;
  /** The shown Document's Actors' names, by Actor id, from its Actor rows (ADR-0090). */
  actorNames: ReadonlyMap<string, string>;
  /** Their kinds, `user` or `agent`, by Actor id. */
  actorKinds: ReadonlyMap<string, string>;
  /** Each Actor's last write, drawn as an Agent's Working Area (ADR-0090). */
  areas: Areas;
}

/** Illustrator's default: a white Fill and a 1 pt black Stroke. */
export const DEFAULT_FILL_STROKE: FillStroke = {
  fill: "#FFFFFF",
  stroke: "#000000",
  active: "fill",
};

export const useStore = create<State>(() => ({
  doc: null,
  live: false,
  role: null,
  viewport: null,
  selection: [],
  isolated: null,
  layerRows: [],
  drag: null,
  pen: null,
  pending: [],
  edit: null,
  opPreview: null,
  anchors: [],
  segments: [],
  notice: null,
  paintPreview: null,
  size: { width: 0, height: 0 },
  images: null,
  layersShown: true,
  gradientShown: false,
  tool: "selection",
  front: {},
  fillStroke: DEFAULT_FILL_STROKE,
  peers: new Map(),
  actorNames: new Map(),
  actorKinds: new Map(),
  areas: new Map(),
}));

// Selected Anchors and segments live only on selected Nodes, whatever changed the Selection.
useStore.subscribe((s, prev) => {
  if (s.selection === prev.selection) return;
  const on = (k: string) => s.selection.includes(parseKey(k).nodeId);
  const anchors = s.anchors.filter(on);
  const segments = s.segments.filter(on);
  if (anchors.length < s.anchors.length || segments.length < s.segments.length) {
    useStore.setState({ anchors, segments });
  }
});

// A Selection change that does not set the Layer rows forgets them (ADR-0076).
useStore.subscribe((s, prev) => {
  if (s.selection !== prev.selection && s.layerRows === prev.layerRows && s.layerRows.length > 0) {
    useStore.setState({ layerRows: [] });
  }
});

/** A viewer's tab edits nothing: the menus grey out and the tools shrink (ADR-0047). */
export const canEdit = (s: Pick<State, "role">) => s.role !== "viewer";

/** The tools a viewer keeps, which change nothing; Space pans as the Hand for everyone. */
export const VIEWER_TOOLS: readonly Tool[] = ["selection", "zoom"];

let socket: WebSocket | null = null;
/** The shown Document's presence sender; null between tabs. */
let presence: ReturnType<typeof presenceSender> | null = null;

/** The pointer over the canvas in document coordinates, or null once it is off it (ADR-0090). */
export const pointerAt = (cursor: Pointer) => presence?.update({ cursor });

/**
 * Each Document Tab's viewport, Selection and Isolation while another tab is shown, for the page's
 * lifetime.
 */
const views = new Map<string, Pick<State, "viewport" | "selection" | "isolated" | "layerRows">>();

/**
 * Sends one gesture to the Document (ADR-0010) and returns its id, which its answer carries. While
 * the socket is down it is dropped: the Document sent on reconnect clears what waited on it.
 */
export function send(command: Command): string {
  const id = newId();
  const msg: ClientMessage = { type: "command", id, command };
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  return id;
}

/** Sends a signed-out person to sign in, coming back to this page. */
export const goSignIn = () =>
  location.replace(`/?return=${encodeURIComponent(location.pathname + location.search)}`);

/** `GET /api/docs/:docId`'s status and error code; null if the request itself failed. */
async function probe(docId: string): Promise<Probe> {
  try {
    const res = await fetch(`/api/docs/${docId}`);
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    return { status: res.status, code: body.code };
  } catch {
    return null;
  }
}

/** The Document's Actor rows' names and kinds; none when the request fails, so ids label them. */
async function fetchActors(docId: string): Promise<Pick<State, "actorNames" | "actorKinds">> {
  try {
    const res = await fetch(`/api/docs/${docId}/actors`);
    if (!res.ok) return { actorNames: new Map(), actorKinds: new Map() };
    const { actors } = (await res.json()) as {
      actors: { actorId: string; name: string; kind: string }[];
    };
    return {
      actorNames: new Map(actors.map((a) => [a.actorId, a.name])),
      actorKinds: new Map(actors.map((a) => [a.actorId, a.kind])),
    };
  } catch {
    return { actorNames: new Map(), actorKinds: new Map() };
  }
}

/**
 * Shows a Document (ADR-0009) until the returned function is called. Only the active tab is
 * connected, so switching tabs starts over from the Document sent on connect (ADR-0030).
 */
export function connect(docId: string): () => void {
  useStore.setState({
    doc: null,
    live: false,
    role: null,
    drag: null,
    pen: null,
    pending: [],
    edit: null,
    opPreview: null,
    anchors: [],
    segments: [],
    notice: null,
    paintPreview: null,
    viewport: null,
    selection: [],
    isolated: null,
    layerRows: [],
    peers: new Map(),
    actorNames: new Map(),
    actorKinds: new Map(),
    areas: new Map(),
    ...views.get(docId),
  });
  let ws: WebSocket;
  const sender = presenceSender((msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, useStore.getState().selection);
  presence = sender;
  const unwatch = useStore.subscribe((s, prev) => {
    if (s.selection !== prev.selection) sender.update({ selection: s.selection });
  });
  /** The Actors this connection fetched the names for, at most once each; a fetch gets them all. */
  let asked = new Set<string>();
  const fetchNames = (actors: string[]) => {
    for (const a of actors) asked.add(a);
    fetchActors(docId).then((actors) => {
      if (!stopped) useStore.setState(actors);
    });
  };
  let retry: ReturnType<typeof setTimeout>;
  let stopped = false;
  /** Set by a 4003 close until a Document arrives: failing then means access was removed. */
  let accessChanged = false;
  const stop = (notice: string) => {
    stopped = true;
    useStore.setState({ live: false, notice });
  };
  // ponytail: fixed 1 s retry, forever; back off if many tabs hammer a dead server.
  const later = () => {
    retry = setTimeout(open, 1000);
  };
  const open = () => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/api/docs/${docId}/ws`);
    socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      const next = receive(useStore.getState(), msg, docId);
      // A new socket is a new Peer to the others: it sends its presence in full; and so does every
      // socket when one joins, which asks for it (ADR-0090).
      if (msg.type === "document" || msg.type === "joined") sender.resend();
      if (msg.type === "document") {
        asked = new Set();
        fetchNames(msg.peers.map((p) => p.actor));
      } else if (
        (msg.type === "presence" ||
          msg.type === "joined" ||
          msg.type === "tx" ||
          msg.type === "staged") &&
        !asked.has(msg.actor) &&
        !useStore.getState().actorNames.has(msg.actor)
      )
        fetchNames([msg.actor]);
      if (msg.type === "document") {
        accessChanged = false;
        const { tool } = useStore.getState();
        const viewer = msg.role === "viewer" && !VIEWER_TOOLS.includes(tool);
        useStore.setState({ live: true, role: msg.role, ...(viewer && { tool: "selection" }) });
      }
      const areas = areasAfter(useStore.getState().areas, msg, Date.now());
      if (next) useStore.setState({ ...next, areas });
      else ws.close(); // A missed rev: reconnect for the whole Document.
    };
    ws.onclose = (e) => {
      if (stopped) return;
      if (e.code === DOC_DELETED) return stop("This Document was deleted.");
      if (e.code === TOO_MANY_CONNECTIONS) {
        return stop("Too many open tabs on this Document. Close one, then reload this tab.");
      }
      if (accessChanged) return stop("This Document is no longer shared with you.");
      accessChanged = e.code === ACCESS_CHANGED;
      // The Peers come again with the next socket's Document.
      useStore.setState({ live: false, peers: new Map() });
      if (opened) return later();
      // The upgrade's refusal is unreadable (1006); the same check over HTTP says why.
      probe(docId).then((p) => {
        if (stopped) return;
        const next = afterProbe(p);
        if (next === "retry") later();
        else if (next === "sign-in") {
          stopped = true;
          goSignIn();
        } else stop(next.notice);
      });
    };
  };
  open();
  return () => {
    const { viewport, selection, isolated, layerRows } = useStore.getState();
    views.set(docId, { viewport, selection, isolated, layerRows });
    stopped = true;
    clearTimeout(retry);
    sender.stop();
    unwatch();
    presence = null;
    socket = null;
    ws.close();
  };
}
