import { newId } from "@zibel/core";
import {
  ACCESS_CHANGED,
  type ClientMessage,
  type Command,
  DOC_DELETED,
  type Role,
  type ServerMessage,
} from "@zibel/sync";
import { create } from "zustand";
import { parseKey } from "./direct.ts";
import type { ImageCache } from "./images.ts";
import { afterProbe, type Probe, receive, type ViewState } from "./receive.ts";
import type { Tool } from "./toolbox.ts";
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
  tool: Tool;
  /** The Fill and Stroke boxes, kept across Document Tabs as in Illustrator. */
  fillStroke: FillStroke;
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
  drag: null,
  pen: null,
  edit: null,
  opPreview: null,
  anchors: [],
  segments: [],
  notice: null,
  size: { width: 0, height: 0 },
  images: null,
  layersShown: true,
  tool: "selection",
  fillStroke: DEFAULT_FILL_STROKE,
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

/** A viewer's tab edits nothing: the menus grey out and the tools shrink (ADR-0047). */
export const canEdit = (s: Pick<State, "role">) => s.role !== "viewer";

/** The tools a viewer keeps, which change nothing; Space pans as the Hand for everyone. */
export const VIEWER_TOOLS: readonly Tool[] = ["selection", "zoom"];

let socket: WebSocket | null = null;

/** Each Document Tab's viewport and Selection while another tab is shown, for the page's lifetime. */
const views = new Map<string, Pick<State, "viewport" | "selection">>();

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
    edit: null,
    opPreview: null,
    anchors: [],
    segments: [],
    notice: null,
    viewport: null,
    selection: [],
    ...views.get(docId),
  });
  let ws: WebSocket;
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
      if (msg.type === "document") {
        accessChanged = false;
        const { tool } = useStore.getState();
        const viewer = msg.role === "viewer" && !VIEWER_TOOLS.includes(tool);
        useStore.setState({ live: true, role: msg.role, ...(viewer && { tool: "selection" }) });
      }
      if (next) useStore.setState(next);
      else ws.close(); // A missed rev: reconnect for the whole Document.
    };
    ws.onclose = (e) => {
      if (stopped) return;
      if (e.code === DOC_DELETED) return stop("This Document was deleted.");
      if (accessChanged) return stop("This Document is no longer shared with you.");
      accessChanged = e.code === ACCESS_CHANGED;
      useStore.setState({ live: false });
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
    const { viewport, selection } = useStore.getState();
    views.set(docId, { viewport, selection });
    stopped = true;
    clearTimeout(retry);
    socket = null;
    ws.close();
  };
}
