import { createDocument, createNodes, type Document, makeMask, type Node } from "@zibel/core";
import { beforeEach, expect, it } from "vitest";
import { boxContext } from "./boxContext.ts";
import { selectionTool } from "./selectionTool.ts";
import { useStore } from "./store.ts";
import type { ToolEvent } from "./toolbox.ts";

const event = (doc: Document, x: number, y: number, clicks: number): ToolEvent =>
  ({
    x,
    y,
    points: [[x, y]],
    shift: false,
    alt: false,
    ctrl: false,
    space: false,
    clicks,
    doc,
    viewport: { x: 0, y: 0, scale: 1 },
    ctx: boxContext(),
    capture() {},
    redraw() {},
  }) as unknown as ToolEvent;

/** A press and release at (x, y), the `clicks`-th of a run; `to` drags it there first. */
function press(doc: Document, [x, y]: [number, number], clicks: number, to?: [number, number]) {
  selectionTool.down(event(doc, x, y, clicks));
  if (to) selectionTool.move?.(event(doc, ...to, clicks));
  selectionTool.up?.(event(doc, ...(to ?? [x, y]), clicks));
}
const doubleClick = (doc: Document, at: [number, number]) => {
  press(doc, at, 1);
  press(doc, at, 2);
};

/** Layer: rect bg (0–100), Clip Group g: content (10–40) clipped by clip (10–40). */
function fixture() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = (x: number, width: number) =>
    ({ type: "rect", parentId, x, y: x, width, height: width }) as const;
  const [bg, content, clip] = createNodes(doc, [rect(0, 100), rect(10, 30), rect(10, 30)])
    .nodes as [Node, Node, Node];
  const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  return { doc, bg, content, group };
}

beforeEach(() => {
  useStore.setState({ selection: [], isolated: null, drag: null, tool: "selection" });
});

it("isolates a double-clicked Group and selects what is under the pointer inside it", () => {
  const { doc, content, group } = fixture();
  useStore.setState({ doc });
  doubleClick(doc, [25, 25]);
  expect(useStore.getState()).toMatchObject({ isolated: group.id, selection: [content.id] });
});

it("isolates and selects a double-clicked Live Shape or Path, and goes no deeper (ADR-0058)", () => {
  const { doc, bg } = fixture();
  useStore.setState({ doc });
  doubleClick(doc, [80, 80]);
  expect(useStore.getState()).toMatchObject({ isolated: bg.id, selection: [bg.id] });
  doubleClick(doc, [80, 80]);
  expect(useStore.getState()).toMatchObject({ isolated: bg.id, selection: [bg.id] });
});

it("isolates a path double-clicked inside an isolated Group", () => {
  const { doc, content, group } = fixture();
  useStore.setState({ doc, isolated: group.id });
  doubleClick(doc, [25, 25]);
  expect(useStore.getState()).toMatchObject({ isolated: content.id, selection: [content.id] });
});

it("only selects a double-clicked text, Image or Clipping Path", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const [text, image, content, clip] = createNodes(doc, [
    { type: "text", parentId, x: 10, y: 20, content: "Hi" },
    { type: "image", parentId, x: 100, y: 0, width: 20, height: 20, file: "a.png" },
    { type: "rect", parentId, x: 150, y: 10, width: 10, height: 10 },
    { type: "rect", parentId, x: 140, y: 0, width: 40, height: 40 },
  ]).nodes as [Node, Node, Node, Node];
  const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  useStore.setState({ doc });
  doubleClick(doc, [12, 15]);
  expect(useStore.getState()).toMatchObject({ isolated: null, selection: [text.id] });
  doubleClick(doc, [110, 10]);
  expect(useStore.getState()).toMatchObject({ isolated: null, selection: [image.id] });
  useStore.setState({ isolated: group.id });
  doubleClick(doc, [140, 30]);
  expect(useStore.getState()).toMatchObject({ isolated: group.id, selection: [clip.id] });
});

it("goes up a level on a double-click where nothing in scope is hit, selecting the Group left", () => {
  const { doc, group } = fixture();
  useStore.setState({ doc, isolated: group.id });
  doubleClick(doc, [80, 80]);
  expect(useStore.getState()).toMatchObject({ isolated: null, selection: [group.id] });
});

it("moves on a second press that drags, and after a first press that dragged, without isolating", () => {
  const { doc } = fixture();
  useStore.setState({ doc });
  press(doc, [25, 25], 1);
  press(doc, [25, 25], 2, [35, 25]);
  expect(useStore.getState().isolated).toBeNull();
  press(doc, [25, 25], 1, [35, 25]);
  press(doc, [25, 25], 2);
  expect(useStore.getState().isolated).toBeNull();
});
