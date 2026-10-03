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
import { parseKey, type Renumbering, targetKeys } from "./direct.ts";
import type { ImageCache } from "./images.ts";
import { type ActorKind, type Pointer, peersFrom, presenceSender } from "./presence.ts";
import {
  afterProbe,
  type Chosen,
  type Effect,
  type Held,
  heldRan,
  joinNotices,
  opening,
  type Preview,
  type Probe,
  receive,
  type SentPreview,
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
  penPress: null,
  pending: [],
  edit: null,
  reversing: null,
  renumbering: new Map(),
  held: [],
  grabbed: [],
  regrab: null,
  sentPreviews: [],
  sent: new Set(),
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
 * Every command except a `path_edit`, a `path_join` and a `path_op`. A reverse in flight would put
 * one that names Anchors, Handles or segments by index on other points, and a `path_op` on whole
 * Nodes reshapes or replaces the paths that edits held for it name by index, so `send` takes each
 * only with `Waited` (ADR-0110). A `path_reverse` names subpaths, which a reverse does not renumber.
 */
export type NodeCommand = Exclude<Command, { type: "path_edit" | "path_join" | "path_op" }>;
/** A `path_op` on whole Nodes. */
export type NodeOp = PathOpInput & { anchors?: undefined };

declare const waited: unique symbol;
/**
 * Says that a command is sent after the Reverse Path Direction press in flight, as `afterReverse`
 * hands it, or that it need not wait, as `unheld` does: it names indices, or it reshapes or replaces
 * paths that held edits name by index (ADR-0110).
 */
export type Waited = { readonly [waited]: true };
const WAITED = {} as Waited;

/**
 * Lets an edit by index be sent at once, though a Reverse Path Direction press may be in flight.
 * `why` says at the call site why it need not wait (ADR-0110).
 */
export const unheld = (_why: string): Waited => WAITED;

/**
 * Sends one gesture to the Document (ADR-0010) and returns its id, which its answer carries, and
 * which `sent` records until then (#288). While the socket is down it is dropped and not recorded:
 * the Document sent on reconnect clears what waited on it. A command that names Anchors by index,
 * and any `path_op`, needs `Waited`.
 */
export function send<C extends Command>(
  command: C,
  ..._waited: [C] extends [NodeCommand] ? [] : [Waited]
): string {
  const id = newId();
  const msg: ClientMessage = { type: "command", id, command };
  if (socket?.readyState !== WebSocket.OPEN) return id;
  socket.send(JSON.stringify(msg));
  return record(id, command);
}

/**
 * Records `command`, sent as `id`, as not yet answered, and returns `id`. A command that may
 * renumber a path's Anchors opens the window edits by index wait for (#298).
 */
export function record(id: string, command: Command) {
  useStore.setState((s) => {
    const r = opening(s.doc, command);
    return {
      sent: new Set(s.sent).add(id),
      ...(r !== undefined && { renumbering: new Map(s.renumbering).set(id, r) }),
    };
  });
  return id;
}

/** Says how command `id`, unanswered, renumbers `r`'s path where its ops alone do not (#298). */
export function renumbers(id: string, r: Renumbering) {
  useStore.setState((s) =>
    s.renumbering.has(id) ? { renumbering: new Map(s.renumbering).set(id, r) } : {},
  );
}

/**
 * Whether a command of the person's own that may renumber a path's Anchors is unanswered: a Reverse
 * Path Direction press, or another that `record` opened the window for (ADR-0110).
 */
export const waiting = (s: Pick<State, "reversing" | "renumbering">) =>
  !!s.reversing || s.renumbering.size > 0;

/**
 * Whether one of the commands a held Pen finish or Pencil redraw was drawn on is unanswered (#293,
 * #309). A held edit's token in its seed is never in `sent`: that edit runs first, and its token
 * gives way to what it sent (#308).
 */
const unanswered = (s: Pick<State, "sent">, seed: string[] | undefined) =>
  !!seed?.some((id) => s.sent.has(id));

/**
 * Runs a Direct Selection edit now, or once the Reverse Path Direction press in flight, or the
 * person's other command that may renumber a path, is answered (`waiting`), on the Document as it
 * is then and the keys the person had chosen, renumbered (ADR-0110, #298). The edit
 * is handed the `Waited` its commands by index are sent with. `chosen` overrides the Direct
 * Selection's keys, as a drag's own do; a `target` stands on its own keys, and the edit reads it
 * alone, as the answer turns it. With `previewed`, the live gesture's unsent preview in `edit` and
 * `drag` is the edit's own and leaves the live slots: held, it goes with the edit, so the next
 * gesture's preview leaves it on screen; run, it gives way to what the edit sends, if anything.
 * Either way the edit never sees or changes the live slots' preview (#285). A `seed` holds it, and
 * the edits after it, until the answers to the edits it was drawn on (#293, #308, #309). A `set_d`
 * edit's `redraw` comes from `afterRedraw`, its one run step (#286, #309); `pulled`
 * turns its preview as an Anchor Point drag out of an Anchor sends it (#286).
 */
export function afterReverse(
  edit: (s: State & Chosen, w: Waited) => void,
  {
    previewed,
    seed,
    redraw,
    pulled,
    ...chosen
  }: Partial<Chosen> & { previewed?: true } & Pick<Held, "seed" | "redraw" | "pulled"> = {},
) {
  const s = useStore.getState();
  const { target } = chosen;
  const { anchors, segments, selection, tool } = {
    ...s,
    ...chosen,
    ...(target && targetKeys(target)),
  };
  const c = { anchors, segments, selection, tool, ...(target && { target }) };
  const run = (k: Chosen) => edit({ ...useStore.getState(), ...k }, WAITED);
  const preview: Preview = { edit: previewed ? s.edit : null, drag: previewed ? s.drag : null };
  if (previewed) useStore.setState({ edit: null, drag: null });
  if (!waiting(s) && s.held.length === 0 && !unanswered(s, seed)) return run(c);
  const h: Held = {
    chosen: c,
    run,
    preview,
    token: newId(),
    ...(seed && { seed }),
    ...(redraw && { redraw }),
    ...(pulled && { pulled }),
  };
  useStore.setState({ held: [...useStore.getState().held, h] });
}

/**
 * Draws `p`, an edit's preview whose commands were just sent with the ids it carries, until their
 * answers. Every sent preview reaches `sentPreviews` through here, from a live gesture or a held
 * edit, in the order sent (#285).
 */
export function drawSent(p: SentPreview) {
  if (!p.edit && !p.drag) return;
  useStore.setState((s) => ({ sentPreviews: [...s.sentPreviews, p] }));
}

/**
 * Runs the held edits in order; one that sends a command that may renumber a path, such as another
 * press, holds the rest (#298). Each runs off its own preview, which it replaces with what it sends
 * or drops, touching no other (ADR-0110); what was drawn on it then waits for what it sent, or goes
 * when it sent nothing (#308). One that throws stops only itself: the rest still run,
 * and the error is thrown once they have. The notices they set, such as a drop of what the person
 * drew, are shown before `said`, the notice of the message that answered, so none replaces another
 * (#291).
 */
export function runHeld(said?: string | null) {
  const before = useStore.getState().notice;
  const notices: string[] = [];
  const errors: unknown[] = [];
  let runs = 0;
  for (;;) {
    const state = useStore.getState();
    const [h, ...rest] = state.held;
    if (!h || waiting(state) || unanswered(state, h.seed)) break;
    runs++;
    useStore.setState({ held: rest, notice: null });
    const { sentPreviews: was, sent } = useStore.getState();
    const from = was.length;
    try {
      h.run(h.chosen);
    } catch (e) {
      errors.push(e);
    }
    const ran = useStore.getState();
    const ids = [...ran.sent].filter((id) => !sent.has(id));
    const { state: after, notices: gone } = heldRan(ran, h.token, ids);
    useStore.setState({ ...after, notice: joinNotices([ran.notice, ...gone]) || null });
    // What it sent is marked as a held edit's (#288).
    const { sentPreviews } = useStore.getState();
    if (sentPreviews.length > from) {
      useStore.setState({
        sentPreviews: sentPreviews.map(
          (p, i): SentPreview => (i < from ? p : { ...p, fromHeld: true }),
        ),
      });
    }
    const { notice } = useStore.getState();
    if (notice) notices.push(notice);
  }
  if (runs > 0) useStore.setState({ notice: joinNotices([...notices, said]) || before });
  if (errors.length > 1) throw new AggregateError(errors, "Held edits threw.");
  if (errors.length > 0) throw errors[0];
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
    penPress: null,
    pending: [],
    edit: null,
    reversing: null,
    renumbering: new Map(),
    held: [],
    grabbed: [],
    regrab: null,
    sentPreviews: [],
    sent: new Set(),
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
      runHeld(state.notice);
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
