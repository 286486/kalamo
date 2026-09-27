import { createDocument, createNodes, type Document } from "@zibel/core";
import { expect, it } from "vitest";
import { anchorKey } from "./direct.ts";
import { directTool } from "./directTool.ts";
import { useStore } from "./store.ts";
import type { ToolEvent } from "./toolbox.ts";

const event = (doc: Document, x: number, y: number, shift = false): ToolEvent =>
  ({
    x,
    y,
    points: [[x, y]],
    shift,
    alt: false,
    ctrl: false,
    space: false,
    doc,
    viewport: { x: 0, y: 0, scale: 1 },
    capture() {},
    redraw() {},
  }) as unknown as ToolEvent;

const click = (doc: Document, x: number, y: number, shift = false) => {
  directTool.down(event(doc, x, y, shift));
  directTool.up?.(event(doc, x, y, shift));
};

it("a click selects a segment and no Anchor; Shift toggles it beside Anchors", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const [rect] = createNodes(doc, [
    { type: "rect", parentId, x: 0, y: 0, width: 10, height: 10 },
  ] as never).nodes;
  const id = rect?.id as string;
  useStore.setState({ doc, selection: [], anchors: [], segments: [], edit: null });
  const [top, right] = [anchorKey(id, 0, 0), anchorKey(id, 0, 1)];

  click(doc, 5, 0);
  expect(useStore.getState()).toMatchObject({ selection: [id], anchors: [], segments: [top] });
  click(doc, 10, 5, true);
  click(doc, 0, 10, true);
  expect(useStore.getState()).toMatchObject({
    anchors: [anchorKey(id, 0, 3)],
    segments: [top, right],
  });
  click(doc, 5, 0, true);
  expect(useStore.getState()).toMatchObject({ segments: [right] });
  // A drag on a selected segment keeps the selection and moves it; the rect stays live meanwhile.
  directTool.down(event(doc, 10, 5));
  directTool.move?.(event(doc, 14, 5));
  expect(useStore.getState().segments).toEqual([right]);
  expect(useStore.getState().edit?.inputs[0]?.ops).toMatchObject([
    { op: "move_anchor", index: 1, to: [14, 0] },
    { op: "move_anchor", index: 2, to: [14, 10] },
  ]);
  directTool.cancel?.(() => {});
  expect(doc.nodes.get(id)?.type).toBe("rect");
  // A plain click on an Anchor drops the segments.
  click(doc, 0, 0);
  expect(useStore.getState()).toMatchObject({ anchors: [anchorKey(id, 0, 0)], segments: [] });
});
