import { newId, type PathOpInput } from "@kalamo/core";
import {
  ACCESS_CHANGED,
  type ClientMessage,
  type Command,
  DOC_DELETED,
  type ServerMessage,
  TOO_MANY_CONNECTIONS,
} from "@kalamo/sync";
import { create } from "zustand";
import { parseKey } from "./direct.ts";
import type { ImageCache } from "./images.ts";
import { type ActorKind, type Pointer, peersFrom, presenceSender } from "./presence.ts";
import {
  afterProbe,
  type Chosen,
  type Effect,
  type Preview,
  type Probe,
  receive,
  type ViewState,
} from "./receive.ts";
import type { Tool, ToolGroup } from "./toolbox.ts";
import type { FillStroke } from "./tools.ts";
import type { Viewport } from "./viewport.ts";

export interface State extends ViewState {
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
  /** Window > Pathfinder. */
  pathfinderShown: boolean;
  /** Window > Attributes (ADR-0108). */
  attributesShown: boolean;
  /** The tool each Tools panel group shows: the last chosen from it. */
  front: Partial<Record<ToolGroup, Tool>>;
  /** The Fill and Stroke boxes, kept across Document Tabs as in Illustrator. */
  fillStroke: FillStroke;
  /** The shown Document's Actors' kinds, by Actor id. */
  actorKinds: ReadonlyMap<string, ActorKind>;
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
  reversing: null,
  held: [],
  ran: [],
  opPreview: null,
  anchors: [],
  segments: [],
  notice: null,
  paintPreview: null,
  size: { width: 0, height: 0 },
  images: null,
  layersShown: true,
  gradientShown: false,
  pathfinderShown: false,
  attributesShown: false,
  tool: "selection",
  front: {},
  fillStroke: DEFAULT_FILL_STROKE,
  peers: new Map(),
  actorNames: new Map(),
  actorKinds: new Map(),
  asked: new Set(),
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
 * Every command except those that name Anchors, Handles or segments by index: a `path_edit`, a
 * `path_join`, or a `path_op` given `anchors`. A reverse in flight would put such a command on other
 * points, so `send` takes it only with `Waited` (ADR-0110). A `path_reverse` names subpaths, which
 * a reverse does not renumber.
 */
export type NodeCommand =
  | Exclude<Command, { type: "path_edit" | "path_join" | "path_op" }>
  | { type: "path_op"; input: NodeOp };
/** A `path_op` on whole Nodes. */
export type NodeOp = PathOpInput & { anchors?: undefined };

declare const waited: unique symbol;
/**
 * Says that an edit by index waits for the Reverse Path Direction press in flight, as `afterReverse`
 * hands it, or that it need not, as `unheld` does (ADR-0110).
 */
export type Waited = { readonly [waited]: true };
const WAITED = {} as Waited;

/**
 * Lets an edit by index be sent at once, though a Reverse Path Direction press may be in flight.
 * `why` says at the call site why it need not wait (ADR-0110).
 */
export const unheld = (_why: string): Waited => WAITED;

/**
 * Sends one gesture to the Document (ADR-0010) and returns its id, which its answer carries. While
 * the socket is down it is dropped: the Document sent on reconnect clears what waited on it. A
 * command that names Anchors by index needs `Waited`.
 */
export function send<C extends Command>(
  command: C,
  ..._waited: [C] extends [NodeCommand] ? [] : [Waited]
): string {
  const id = newId();
  const msg: ClientMessage = { type: "command", id, command };
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  return id;
}

/**
 * Runs a Direct Selection edit now, or once the Reverse Path Direction press in flight is answered,
 * on the Document as it is then and the keys the person had chosen, renumbered (ADR-0110). The edit
 * is handed the `Waited` its commands by index are sent with. `chosen` overrides the Direct
 * Selection's keys, as a drag's own do. With `previewed`, the unsent preview in `edit` and `drag` is
 * the edit's own: held, it goes with the edit, so the next gesture's preview leaves it on screen.
 */
export function afterReverse(
  edit: (s: State, w: Waited) => void,
  { previewed, ...chosen }: Partial<Chosen> & { previewed?: true } = {},
) {
  const s = useStore.getState();
  const { anchors, segments, selection, tool } = { ...s, ...chosen };
  const c = { anchors, segments, selection, tool };
  const run = (k: Chosen) => edit({ ...useStore.getState(), ...k }, WAITED);
  if (!s.reversing) return run(c);
  const preview: Preview = {
    edit: previewed && s.edit?.commandIds === null ? s.edit : null,
    drag: previewed && s.drag?.commandId === null ? s.drag : null,
  };
  useStore.setState({
    held: [...s.held, { chosen: c, run, preview }],
    ...(preview.edit && { edit: null }),
    ...(preview.drag && { drag: null }),
  });
}

/**
 * Runs the held edits in order; one that presses Reverse Path Direction again holds the rest. Each
 * runs on its own preview, so it replaces or drops that one only: what it sends is drawn in `ran`
 * until answered, and the gesture's preview it set aside is put back (ADR-0110).
 */
export function runHeld() {
  for (;;) {
    const {
      held: [h, ...rest],
      reversing,
      edit,
      drag,
    } = useStore.getState();
    if (!h || reversing) return;
    useStore.setState({ held: rest, ...h.preview });
    h.run(h.chosen);
    const after = useStore.getState();
    const sent = {
      edit: after.edit?.commandIds ? after.edit : null,
      drag: after.drag?.commandId ? after.drag : null,
    };
    useStore.setState({
      edit,
      drag,
      ...((sent.edit || sent.drag) && { ran: [...after.ran, sent] }),
    });
  }
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
      actors: { actorId: string; name: string; kind: ActorKind }[];
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
    reversing: null,
    held: [],
    ran: [],
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
    asked: new Set(),
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
  let retry: ReturnType<typeof setTimeout>;
  let stopped = false;
  /** Set by a 4003 close: failing again before a Document arrives means access was removed. */
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
    const run = (effect: Effect) => {
      if (effect.type === "resend-presence") sender.resend();
      else if (effect.type === "fetch-names")
        fetchActors(docId).then((actors) => {
          if (!stopped) useStore.setState(actors);
        });
      else if (effect.type === "reconnect") ws.close();
      else effect satisfies never;
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      const { state, effects } = receive(useStore.getState(), msg, docId, Date.now());
      effects.forEach(run);
      useStore.setState(state);
      runHeld();
    };
    ws.onclose = (e) => {
      if (stopped) return;
      if (e.code === DOC_DELETED) return stop("This Document was deleted.");
      if (e.code === TOO_MANY_CONNECTIONS) {
        return stop("Too many open tabs on this Document. Close one, then reload this tab.");
      }
      // Only a Document makes a socket live.
      if (accessChanged && !useStore.getState().live) {
        return stop("This Document is no longer shared with you.");
      }
      accessChanged = e.code === ACCESS_CHANGED;
      // The Peers come again with the next socket's Document.
      useStore.setState({ live: false, peers: peersFrom([]) });
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
