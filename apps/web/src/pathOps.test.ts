import {
  COMBINING,
  createDocument,
  createNodes,
  type Document,
  directionEdits,
  editPath,
  type Geometry,
  type Node,
  type PathNode,
  pathOp,
  runsClockwise,
} from "@kalamo/core";
import { loadGeometry } from "@kalamo/geometry";
import type { ClientMessage, Command, ServerMessage } from "@kalamo/sync";
import { beforeAll, expect, it, vi } from "vitest";
import { setDirection } from "./attributes.ts";
import { cleanUp } from "./cleanUp.ts";
import { anchorKey, hasAnchors, localAnchors } from "./direct.ts";
import { directTool } from "./directTool.ts";
import { documentMenus, type Item, type Menu, type MenuItem, shapeMode } from "./menu.ts";
import { previewAll, previewOp, previewsOf } from "./receive.ts";
import { commitSimplify } from "./simplify.ts";
import { connect, type NodeOp, runHeld, sendPathOp, useStore } from "./store.ts";
import { message, stateAfter, viewState } from "./testing.ts";
import type { ToolEvent } from "./toolbox.ts";

/** Every command sent since `reset`, as the socket carries it, under its own id (#289, #299). */
let log: { id: string; command: Command }[] = [];
/** Those not yet answered, oldest first. */
let queue: typeof log = [];

let geometry: Geometry;
beforeAll(async () => {
  geometry = await loadGeometry();
  // An open socket under the store's own `send`, which every step sends through.
  vi.stubGlobal("location", { protocol: "http:", host: "x" });
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      send(data: string) {
        const msg = JSON.parse(data) as ClientMessage;
        if (msg.type !== "command") return;
        log.push({ id: msg.id, command: msg.command });
        queue.push({ id: msg.id, command: msg.command });
      }
      close() {}
    },
  );
  connect("d");
});

function reset() {
  log = [];
  queue = [];
}
const commands = () => log.map((c) => c.command);
/** Each command sent, a `path_op` by its op. */
const sentOps = () => commands().map((c) => (c.type === "path_op" ? c.input.op : c.type));

/** A pointer event at (x, y) at 100%. */
const event = (doc: Document, x: number, y: number) =>
  ({
    x,
    y,
    points: [[x, y]],
    shift: false,
    alt: false,
    doc,
    viewport: { x: 0, y: 0, scale: 1 },
    capture() {},
    redraw() {},
  }) as unknown as ToolEvent;

/**
 * The Durable Object, applying `id`'s command to `doc` as the socket delivers it (ADR-0010): a
 * missing Node is NODE_GONE, and `reject` rejects it as an invalid path.
 */
function apply(doc: Document, id: string, c: Command, reject: boolean): ServerMessage {
  const nodeIds =
    c.type === "path_edit"
      ? [c.input.nodeId]
      : c.type === "path_reverse"
        ? c.subpaths.map((s) => s.nodeId)
        : c.type === "path_op"
          ? (c.input.nodeIds ?? [])
          : [];
  const gone = nodeIds.filter((n) => !doc.nodes.has(n));
  if (reject || gone.length > 0) {
    const code = gone.length > 0 ? "NODE_GONE" : "INVALID_PATH";
    return message("rejected", { id, error: { code, message: "No.", hint: "" } });
  }
  const before = new Map([...doc.nodes].map(([k, n]) => [k, JSON.stringify(n)]));
  try {
    if (c.type === "path_reverse") {
      for (const input of directionEdits(doc, c.subpaths, c.clockwise)) editPath(doc, input);
    } else if (c.type === "path_edit") editPath(doc, c.input);
    else if (c.type === "path_op") pathOp(doc, c.input, geometry);
    else throw new Error(`The test server does not run ${c.type}.`);
  } catch (e) {
    const error = { code: "INVALID_PATH" as const, message: String(e), hint: "" };
    return message("rejected", { id, error });
  }
  const nodes = [...doc.nodes.values()];
  doc.rev++;
  return message("tx", {
    rev: doc.rev,
    commandId: id,
    created: nodes.filter((n) => !before.has(n.id)),
    updated: nodes.filter((n) => before.has(n.id) && before.get(n.id) !== JSON.stringify(n)),
    deletedIds: [...before.keys()].filter((k) => !doc.nodes.has(k)),
  });
}

/** Answers the next command sent, as the socket does, rejecting it if it is `reject`; its id. */
function answer(server: Document, reject?: string) {
  const { id, command } = queue.shift() as { id: string; command: Command };
  const after = stateAfter(useStore.getState(), apply(server, id, command, id === reject));
  useStore.setState(after);
  runHeld(after.notice);
  return id;
}

/** Answers what was sent, in order, and what the answers send. */
function serve(server: Document, reject?: string) {
  while (queue.length > 0) answer(server, reject);
}

/**
 * p a Compound Path, a square with a hole, q a triangle, or path `qd`, r a Live Shape and s a stray
 * point, p, q and r selected.
 */
function fixture(qd = "M100 100 L140 100 L120 140 Z") {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const [p, q, r] = createNodes(doc, [
    { type: "path", parentId, d: "M0 0 L30 0 L30 30 L0 30 Z M10 10 L10 20 L20 20 L20 10 Z" },
    { type: "path", parentId, d: qd },
    { type: "rect", parentId, x: 0, y: 150, width: 10, height: 10 },
    { type: "path", parentId, d: "M180 180" },
  ]).nodes as [PathNode, PathNode, Node];
  return { doc, p, q, r };
}

/**
 * The fixture after a press reversing p's hole, in flight, with q's Anchor 1 at (140, 100) then
 * chosen; `drag` drags it by (10, 0), which the press holds. With `q`, q is that path and the
 * Anchor at (140, 100) is its Anchor `anchor`; with `press` false, nothing is in flight and the drag
 * is sent at once.
 */
function pressed({ q: qd = undefined as string | undefined, anchor = 1, press = true } = {}) {
  const { doc, p, q, r } = fixture(qd);
  reset();
  const state = viewState({
    doc,
    selection: [p.id, q.id, r.id],
    role: "owner",
    tool: "direct",
    anchors: [anchorKey(p.id, 1, 0)],
  });
  useStore.setState(state);
  if (press) setDirection(state, !runsClockwise(doc, p, 1));
  const { reversing, renumbering, sent } = useStore.getState();
  expect(!!reversing).toBe(press);
  useStore.setState({
    ...state,
    reversing,
    renumbering,
    sent,
    anchors: [anchorKey(q.id, 0, anchor)],
  });
  const server = structuredClone(doc);
  const drag = () => {
    directTool.down(event(doc, 140, 100));
    directTool.move?.(event(doc, 150, 100));
    directTool.up?.(event(doc, 150, 100));
    expect(useStore.getState().held).toHaveLength(press ? 1 : 0);
  };
  return { doc, p, q, r, server, press: log[0]?.id, drag };
}

const menus = documentMenus({ open() {}, close() {} });
/** The Menu Item at `path`. */
function menuItem(...path: string[]): MenuItem {
  let items: Item[] = menus;
  for (const label of path) {
    const found = items.find((i) => i !== "-" && i.label === label);
    if (!found || found === "-") throw new Error(`No ${path.join(" > ")}.`);
    if (!("items" in found)) return found;
    items = (found as Menu).items;
  }
  throw new Error(`${path.join(" > ")} is a submenu.`);
}

/** The open bar's or dialog's preview of `input`. */
const shown = (input: NodeOp) => ({
  input,
  showOriginal: false,
  ...(input.op === "offset" && { geometry }),
});

/**
 * OK in Simplify's bar, or in Offset Path's or Split Into Grid's dialog with Preview on or off, as
 * each sends: the dialog hands the step its own preview, as its OK handler does.
 */
function ok(input: NodeOp, previewed = true) {
  if (previewed) useStore.setState({ opPreview: shown(input) });
  if (input.op === "simplify") return commitSimplify();
  const { showOriginal: _, ...own } = shown(input);
  sendPathOp(input, previewed ? own : undefined);
}

/** Every entry point that sends a `path_op` on whole Nodes, on the Selection's p, q and r. */
function entryPoints(p: string, q: string, r: string): Record<string, () => void> {
  const nodeIds = [p, q, r];
  const simplify = {
    nodeIds,
    op: "simplify" as const,
    tolerance: 1,
    cornerAngle: 90,
    toLines: false,
  };
  const path = (label: string) => () => menuItem("Object", "Path", label).run();
  return {
    outline_stroke: path("Outline Stroke"),
    offset: () => ok({ nodeIds, op: "offset", distance: 5, join: "miter", miterLimit: 4 }),
    reverse: path("Reverse Path Direction"),
    simplify: () => ok(simplify),
    add_anchors: path("Add Anchor Points"),
    divide_below: path("Divide Objects Below"),
    split_into_grid: () => ok({ nodeIds, op: "split_into_grid", rows: 2, cols: 2, gutter: 0 }),
    clean_up: () =>
      cleanUp({ op: "clean_up", strayPoints: true, unpainted: true, emptyText: true }),
    convert_to_path: () => menuItem("Object", "Shape", "Expand Shape").run(),
    ...Object.fromEntries(COMBINING.map((op) => [op, () => shapeMode(op)])),
    make_compound_path: () => menuItem("Object", "Compound Path", "Make").run(),
    release_compound_path: () => menuItem("Object", "Compound Path", "Release").run(),
  };
}
const SELECTING = new Set<string>([...COMBINING, "make_compound_path", "release_compound_path"]);

it("sends every path_op on whole Nodes after the edits held for a press, in input order, accepted or rejected (#289)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const op of Object.keys(entryPoints("p", "q", "r"))) {
      const label = `${op}, ${outcome}`;
      const { p, q, r, server, press, drag } = pressed();
      drag();
      log = [];
      entryPoints(p.id, q.id, r.id)[op]?.();
      const atClick = { sent: sentOps(), pending: useStore.getState().pending };
      // The press's answer alone, so what it lets go is sent and not yet answered.
      expect(answer(server, outcome === "rejected" ? press : undefined), label).toBe(press);
      expect(sentOps(), label).toEqual(["path_edit", op]);
      // Nothing went out, and nothing waited on the op, until the press was answered.
      expect(atClick, label).toEqual({ sent: [], pending: [] });
      if (SELECTING.has(op)) {
        expect(useStore.getState().pending, label).toEqual([
          { commandId: queue[1]?.id, nodes: [], select: true },
        ]);
      }
    }
  }
});

it("sends every path_op on whole Nodes at once with no press in flight (#289)", () => {
  const { doc, p, q, r } = fixture();
  for (const [op, run] of Object.entries(entryPoints(p.id, q.id, r.id))) {
    reset();
    useStore.setState({
      ...viewState({ doc, selection: [p.id, q.id, r.id], role: "owner", tool: "direct" }),
    });
    run();
    expect(sentOps(), op).toEqual([op]);
    if (SELECTING.has(op)) {
      expect(useStore.getState().pending, op).toEqual([
        { commandId: log[0]?.id, nodes: [], select: true },
      ]);
    }
  }
});

/** `id`'s Anchors in `doc`, as points. */
const anchorsOf = (doc: Document, id: string) =>
  localAnchors(doc.nodes.get(id) as PathNode).flatMap((s) => s.anchors.map((a) => a.anchor));

it("R1: adds Anchor Points to the dragged q, after a drag held for a press (#289)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const { q, server, press, drag } = pressed();
    drag();
    menuItem("Object", "Path", "Add Anchor Points").run();
    serve(server, outcome === "rejected" ? press : undefined);
    // Anchor 1 moved to (150, 100); every other Anchor as it was, with midpoints after the drag.
    const stored = useStore.getState().doc as Document;
    expect(anchorsOf(stored, q.id), outcome).toEqual([
      [100, 100],
      [125, 100],
      [150, 100],
      [135, 120],
      [120, 140],
      [110, 120],
    ]);
    expect(stored.nodes.get(q.id), outcome).toEqual(server.nodes.get(q.id));
    expect(useStore.getState().notice, outcome).toBe(outcome === "rejected" ? "No." : null);
    expect(sentOps(), outcome).toEqual(["path_reverse", "path_edit", "add_anchors"]);
  }
});

it("R3: unites the dragged q with no notice, and selects the result, after a drag held for a press (#289)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const { p, q, server, press, drag } = pressed();
    drag();
    useStore.setState({ selection: [p.id, q.id] });
    shapeMode("unite");
    serve(server, outcome === "rejected" ? press : undefined);
    const s = useStore.getState();
    expect(s.notice, outcome).toBe(outcome === "rejected" ? "No." : null);
    expect(sentOps(), outcome).toEqual(["path_reverse", "path_edit", "unite"]);
    const stored = s.doc as Document;
    expect(stored.nodes.has(q.id), outcome).toBe(false);
    const [united, ...rest] = s.selection;
    expect(rest, outcome).toEqual([]);
    expect(anchorsOf(stored, united as string), outcome).toContainEqual([150, 100]);
  }
});

it("counts Clean Up's notice on the Document it runs on, after a press (#289)", () => {
  const { server, drag, doc } = pressed();
  drag();
  cleanUp({ op: "clean_up", strayPoints: true, unpainted: false, emptyText: false });
  // Another Actor removes the stray point before the press is answered.
  const stray = [...doc.nodes.values()].find((n) => n.type === "path" && !n.d.includes("L"));
  server.nodes.delete(stray?.id as string);
  server.rev++;
  useStore.setState(
    stateAfter(
      useStore.getState(),
      message("tx", { rev: server.rev, actor: "agent", deletedIds: [stray?.id as string] }),
    ),
  );
  serve(server);
  expect(sentOps()).toEqual(["path_reverse", "path_edit"]);
  expect(useStore.getState().notice).toBe("Nothing to clean up.");
});

const PREVIEWED = ["simplify", "offset", "split_into_grid"] as const;

/** Simplify's, Offset Path's and Split Into Grid's input on `nodeIds`. */
const opsOn = (nodeIds: string[]): Record<(typeof PREVIEWED)[number], NodeOp> => ({
  simplify: { nodeIds, op: "simplify", tolerance: 1, cornerAngle: 90, toLines: false },
  offset: { nodeIds, op: "offset", distance: 5, join: "miter", miterLimit: 4 },
  split_into_grid: { nodeIds, op: "split_into_grid", rows: 2, cols: 2, gutter: 0 },
});

/** Offset Path's input on `q`, `distance` pt out. */
const offsetBy = (q: string, distance: number) => ({ ...opsOn([q]).offset, distance }) as NodeOp;

/** q with a straight-line Anchor 1, which Simplify removes, before the Anchor at (140, 100). */
const LINED = { q: "M100 100 L120 100 L140 100 L120 140 Z", anchor: 2 };

/** What the canvas draws: the Document with every preview applied, in order (#285, #299). */
function drawn() {
  const s = useStore.getState();
  return previewAll(s.doc as Document, previewsOf(s));
}

/** The paths and Live Shapes of `doc` but p, which only the press reshapes, by their Anchors. */
const shapes = (doc: Document, p: string) =>
  [...doc.nodes.values()]
    .flatMap((n) => (hasAnchors(n) && n.id !== p ? [JSON.stringify(localAnchors(n))] : []))
    .sort();

/** The paths `input` makes on `doc`, by their Anchors. */
function made(doc: Document, p: string, input: NodeOp) {
  const before = shapes(doc, p);
  return shapes(previewOp(doc, { input, geometry }), p).filter((x) => !before.includes(x));
}

/** Whether the canvas draws every path in `paths`. */
const draws = (p: string, paths: string[]) => paths.every((x) => shapes(drawn(), p).includes(x));

it("draws a Simplify, Offset Path or Split Into Grid confirmed after a drag on the dragged path, as the Document DO stores it (#299)", () => {
  for (const op of PREVIEWED) {
    for (const press of ["none", "accepted", "rejected"] as const) {
      const label = `${op}, press ${press}`;
      const { p, q, server, drag, ...s } = pressed({ ...LINED, press: press !== "none" });
      drag();
      const input = opsOn([q.id])[op];
      const seen: Record<string, string[]> = {};
      // The open bar's or dialog's preview, on top of the unanswered drag.
      useStore.setState({ opPreview: shown(input) });
      seen.open = shapes(drawn(), p.id);
      ok(input);
      seen.confirmed = shapes(drawn(), p.id);
      if (press !== "none") {
        answer(server, press === "rejected" ? s.press : undefined);
        seen["the press answered"] = shapes(drawn(), p.id);
      }
      expect(queue[0]?.command.type, label).toBe("path_edit");
      answer(server);
      seen["the drag answered"] = shapes(drawn(), p.id);
      serve(server);
      expect(sentOps().slice(press === "none" ? 0 : 1), label).toEqual(["path_edit", op]);
      const stored = shapes(server, p.id);
      expect(shapes(useStore.getState().doc as Document, p.id), label).toEqual(stored);
      for (const [when, at] of Object.entries(seen))
        expect(at, `${label}, ${when}`).toEqual(stored);
    }
  }
});

/**
 * `pressed`'s fixture, with nothing in flight but `first`: the press, or Add Anchor Points on p,
 * which opens #298's window for the person's own renumbering command.
 */
function waitingOn(first: "press" | "window") {
  if (first === "press") return pressed(LINED);
  const s = pressed({ ...LINED, press: false });
  useStore.setState({ selection: [s.p.id] });
  menuItem("Object", "Path", "Add Anchor Points").run();
  useStore.setState({ selection: [s.p.id, s.q.id, s.r.id] });
  return { ...s, press: log[0]?.id };
}

it("keeps a held Simplify, Offset Path or Split Into Grid preview its own until its answer, while another op is previewed and confirmed (#299)", () => {
  for (const op of PREVIEWED) {
    for (const [first, press] of ["press", "window"].flatMap((f) =>
      (["accepted", "rejected"] as const).map((o) => [f as "press" | "window", o] as const),
    )) {
      for (const outcome of ["accepted", "rejected"] as const) {
        const label = `${op}, ${first} ${press}, op ${outcome}`;
        const { p, q, doc, server, ...s } = waitingOn(first);
        const input = opsOn([q.id])[op];
        const own = made(doc, p.id, input);
        expect(own.length, label).toBeGreaterThan(0);
        ok(input);
        expect(draws(p.id, own), `${label}, held`).toBe(true);
        const later = offsetBy(q.id, 9);
        useStore.setState({ opPreview: shown(later) });
        expect(draws(p.id, own), `${label}, another previewed`).toBe(true);
        ok(later);
        expect(draws(p.id, own), `${label}, another confirmed`).toBe(true);
        answer(server, press === "rejected" ? s.press : undefined);
        // The later op waits for this one's answer, which may renumber q (#298).
        expect(sentOps().slice(1), label).toEqual([op]);
        expect(draws(p.id, own), `${label}, the press answered`).toBe(true);
        answer(server, outcome === "rejected" ? queue[0]?.id : undefined);
        expect(draws(p.id, own), `${label}, its answer`).toBe(outcome === "accepted");
        serve(server);
        expect(sentOps().slice(1), label).toEqual([op, "offset"]);
      }
    }
  }
});

it("draws only the first of two held Offset Paths when the second has Preview off, each answer settling its own (#289, #299)", () => {
  const { p, q, doc, server } = pressed();
  const [five, nine] = [5, 9].map((d) => made(doc, p.id, offsetBy(q.id, d))) as [
    string[],
    string[],
  ];
  ok(offsetBy(q.id, 5));
  ok(offsetBy(q.id, 9), false);
  const both = () => [draws(p.id, five), draws(p.id, nine)];
  expect(both()).toEqual([true, false]);
  // The press's answer sends the first; the second waits for its answer, which may renumber q.
  answer(server);
  expect(sentOps().slice(1)).toEqual(["offset"]);
  expect(both()).toEqual([true, false]);
  answer(server);
  expect(sentOps().slice(1)).toEqual(["offset", "offset"]);
  expect(both()).toEqual([true, false]);
  answer(server);
  expect(both()).toEqual([true, true]);
});

it("draws both of two held Offset Paths with Preview on, each until its own answer (#299)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const { p, q, doc, server } = pressed();
    const [five, nine] = [5, 9].map((d) => made(doc, p.id, offsetBy(q.id, d))) as [
      string[],
      string[],
    ];
    ok(offsetBy(q.id, 5));
    ok(offsetBy(q.id, 9));
    const both = () => [draws(p.id, five), draws(p.id, nine)];
    expect(both(), outcome).toEqual([true, true]);
    answer(server);
    expect(both(), outcome).toEqual([true, true]);
    // The first's answer leaves the second's preview, held and then sent.
    answer(server, outcome === "rejected" ? queue[0]?.id : undefined);
    expect(sentOps().slice(1), outcome).toEqual(["offset", "offset"]);
    expect(both(), outcome).toEqual([outcome === "accepted", true]);
    answer(server, outcome === "rejected" ? queue[0]?.id : undefined);
    expect(both(), outcome).toEqual([outcome === "accepted", outcome === "accepted"]);
  }
});

it("drops a sent op's preview on reconnect and keeps the open bar's (#299)", () => {
  for (const what of ["sent", "open"] as const) {
    const { p, q, doc, server } = pressed({ ...LINED, press: false });
    const input = opsOn([q.id]).simplify;
    const own = made(doc, p.id, input);
    if (what === "sent") ok(input);
    else useStore.setState({ opPreview: shown(input) });
    expect(sentOps(), what).toEqual(what === "sent" ? ["simplify"] : []);
    expect(draws(p.id, own), what).toBe(true);
    // A sent op's answer is lost with the socket: the server never got it.
    const { rev, name, artboards } = server;
    const nodes = [...server.nodes.values()];
    const msg = message("document", { rev, name, artboards, nodes, role: "owner" });
    useStore.setState(stateAfter(useStore.getState(), msg));
    expect(draws(p.id, own), what).toBe(what === "open");
  }
});

it("never sends a drag made before Simplify's answer with indices from before it (#298 T6, #299)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const { q, doc, server } = pressed({ ...LINED, press: false });
    const before = structuredClone(server.nodes.get(q.id));
    ok(opsOn([q.id]).simplify);
    directTool.down(event(doc, 140, 100));
    directTool.move?.(event(doc, 150, 100));
    directTool.up?.(event(doc, 150, 100));
    expect(sentOps(), outcome).toEqual(["simplify"]);
    answer(server, outcome === "rejected" ? queue[0]?.id : undefined);
    serve(server);
    // Accepted, the answer renumbers q and drops the drag; rejected, the drag is sent and stored.
    const reshaped = JSON.stringify(server.nodes.get(q.id)) !== JSON.stringify(before);
    expect({ reshaped, sent: sentOps() }, outcome).toEqual({
      reshaped: true,
      sent: outcome === "rejected" ? ["simplify", "path_edit"] : ["simplify"],
    });
    expect(useStore.getState().held, outcome).toEqual([]);
  }
});
