import { newId } from "@zibel/core";
import type { ClientMessage, Command, ServerMessage } from "@zibel/sync";
import { create } from "zustand";
import type { ImageCache } from "./images.ts";
import { receive, type ViewState } from "./receive.ts";
import type { FillStroke, Tool } from "./tools.ts";
import type { Viewport } from "./viewport.ts";

export interface State extends ViewState {
  /** False while the socket is down; the last Document stays on screen. */
  live: boolean;
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
  viewport: null,
  selection: [],
  drag: null,
  pen: null,
  notice: null,
  size: { width: 0, height: 0 },
  images: null,
  layersShown: true,
  tool: "selection",
  fillStroke: DEFAULT_FILL_STROKE,
}));

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

/**
 * Shows a Document (ADR-0009) until the returned function is called. Only the active tab is
 * connected, so switching tabs starts over from the Document sent on connect (ADR-0030).
 */
export function connect(docId: string): () => void {
  useStore.setState({
    doc: null,
    live: false,
    drag: null,
    pen: null,
    notice: null,
    viewport: null,
    selection: [],
    ...views.get(docId),
  });
  let ws: WebSocket;
  let retry: ReturnType<typeof setTimeout>;
  let stopped = false;
  const open = () => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/api/docs/${docId}/ws`);
    socket = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      const next = receive(useStore.getState(), msg, docId);
      if (next) useStore.setState({ ...next, ...(msg.type === "document" && { live: true }) });
      else ws.close(); // A missed rev: reconnect for the whole Document.
    };
    ws.onclose = () => {
      if (stopped) return;
      useStore.setState({ live: false });
      // ponytail: fixed 1 s retry, forever; back off if many tabs hammer a dead server.
      retry = setTimeout(open, 1000);
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
