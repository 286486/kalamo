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
import type { Command, ServerMessage } from "@kalamo/sync";
import { beforeAll, expect, it, vi } from "vitest";
import { setDirection } from "./attributes.ts";
import { cleanUp } from "./cleanUp.ts";
import { anchorKey, localAnchors } from "./direct.ts";
import { directTool } from "./directTool.ts";
import { documentMenus, type Item, type Menu, type MenuItem, shapeMode } from "./menu.ts";
import { commitSimplify, sendPreviewedOp } from "./simplify.ts";
import { record, runHeld, send, useStore } from "./store.ts";
import { message, stateAfter, viewState } from "./testing.ts";
import type { ToolEvent } from "./toolbox.ts";

// Each command goes into `queue` under its own id, as the socket sends it (#289).
vi.mock("./store.ts", async (original) => {
  const store = await original<typeof import("./store.ts")>();
  return { ...store, send: vi.fn() };
});

let geometry: Geometry;
beforeAll(async () => {
  geometry = await loadGeometry();
});

let queue: { id: string; command: Command }[] = [];
let ids = 0;
function reset() {
  queue = [];
  ids = 0;
  vi.mocked(send).mockReset();
  vi.mocked(send).mockImplementation((command) => {
    const id = `k${++ids}`;
    queue.push({ id, command });
    return record(id);
  });
}
const commands = () => vi.mocked(send).mock.calls.map(([c]) => c);
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

/** Answers what was sent, in order, and what the answers send, as the socket does; `reject` the press. */
function serve(server: Document, reject?: string) {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const after = stateAfter(
      useStore.getState(),
      apply(server, next.id, next.command, next.id === reject),
    );
    useStore.setState(after);
    runHeld(after.notice);
  }
}

/**
 * p a Compound Path, a square with a hole, q a triangle, r a Live Shape and s a stray point, p, q
 * and r selected.
 */
function fixture() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const [p, q, r] = createNodes(doc, [
    { type: "path", parentId, d: "M0 0 L30 0 L30 30 L0 30 Z M10 10 L10 20 L20 20 L20 10 Z" },
    { type: "path", parentId, d: "M100 100 L140 100 L120 140 Z" },
    { type: "rect", parentId, x: 0, y: 150, width: 10, height: 10 },
    { type: "path", parentId, d: "M180 180" },
  ]).nodes as [PathNode, PathNode, Node];
  return { doc, p, q, r };
}

/**
 * The fixture after a press reversing p's hole, in flight, with q's Anchor 1 at (140, 100) then
 * chosen; `drag` drags it by (10, 0), which the press holds.
 */
function pressed() {
  const { doc, p, q, r } = fixture();
  reset();
  const state = viewState({
    doc,
    selection: [p.id, q.id, r.id],
    role: "owner",
    tool: "direct",
    anchors: [anchorKey(p.id, 1, 0)],
  });
  setDirection(state, !runsClockwise(doc, p, 1));
  const { reversing } = useStore.getState();
  expect(reversing).not.toBeNull();
  useStore.setState({ ...state, reversing, anchors: [anchorKey(q.id, 0, 1)] });
  const server = structuredClone(doc);
  const drag = () => {
    directTool.down(event(doc, 140, 100));
    directTool.move?.(event(doc, 150, 100));
    directTool.up?.(event(doc, 150, 100));
    expect(useStore.getState().held).toHaveLength(1);
  };
  return { doc, p, q, r, server, press: "k1", drag };
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

const preview = (input: Parameters<typeof sendPreviewedOp>[0]) => ({
  input,
  showOriginal: false,
  commandId: null,
});

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
    offset: () =>
      sendPreviewedOp({ nodeIds, op: "offset", distance: 5, join: "miter", miterLimit: 4 }),
    reverse: path("Reverse Path Direction"),
    simplify: () => {
      useStore.setState({ opPreview: preview(simplify) });
      commitSimplify();
    },
    add_anchors: path("Add Anchor Points"),
    divide_below: path("Divide Objects Below"),
    split_into_grid: () =>
      sendPreviewedOp({ nodeIds, op: "split_into_grid", rows: 2, cols: 2, gutter: 0 }),
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
      vi.mocked(send).mockClear();
      entryPoints(p.id, q.id, r.id)[op]?.();
      const atClick = { sent: sentOps(), pending: useStore.getState().pending };
      // The press's answer alone, so what it lets go is sent and not yet answered.
      const first = queue.shift();
      expect(first?.id, label).toBe(press);
      const answer = apply(server, press, first?.command as Command, outcome === "rejected");
      const after = stateAfter(useStore.getState(), answer);
      useStore.setState(after);
      runHeld(after.notice);
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
        { commandId: "k1", nodes: [], select: true },
      ]);
    }
  }
});

/** q's Anchors in `doc`, as points. */
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

it("keeps a held Simplify, Offset Path or Split Into Grid preview drawn until its answer, or gives way to a later one (#289)", () => {
  for (const op of ["simplify", "offset", "split_into_grid"] as const) {
    for (const later of [false, true]) {
      const label = `${op}, ${later ? "a later preview" : "alone"}`;
      const { server, drag, ...s } = pressed();
      drag();
      const nodeIds = [s.p.id];
      const input = {
        simplify: { nodeIds, op, tolerance: 1, cornerAngle: 90, toLines: false },
        offset: { nodeIds, op, distance: 5, join: "miter", miterLimit: 4 },
        split_into_grid: { nodeIds, op, rows: 2, cols: 2, gutter: 0 },
      }[op] as Parameters<typeof sendPreviewedOp>[0];
      useStore.setState({ opPreview: preview(input) });
      if (op === "simplify") commitSimplify();
      else sendPreviewedOp(input);
      const held = useStore.getState().opPreview;
      expect(held, label).toMatchObject({ input, commandId: null });
      expect(commands().slice(1), label).toEqual([]);
      const next = later ? preview({ nodeIds: [s.q.id], op: "add_anchors" }) : null;
      if (next) useStore.setState({ opPreview: next });
      // The press's answer alone: the drag and then the op go out.
      const first = queue.shift() as { id: string; command: Command };
      const after = stateAfter(useStore.getState(), apply(server, first.id, first.command, false));
      useStore.setState(after);
      runHeld(after.notice);
      expect(sentOps().slice(1), label).toEqual(["path_edit", op]);
      const sent = queue[1]?.id;
      expect(useStore.getState().opPreview, label).toEqual(next ?? { ...held, commandId: sent });
      serve(server);
      expect(useStore.getState().opPreview, label).toBe(next);
    }
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
