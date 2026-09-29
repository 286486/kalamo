import { expect, it } from "vitest";
import { nextTap, TOOLS, type Tool, toolSlots } from "./toolbox.ts";

it("counts a press close in time and space as the next click, and far ones as a first", () => {
  const first = nextTap(null, 100, 100, 1000);
  expect(first.count).toBe(1);
  const second = nextTap(first, 110, 108, 1400);
  expect(second.count).toBe(2);
  expect(nextTap(second, 110, 108, 1800).count).toBe(3);
  expect(nextTap(first, 100, 100, 1600).count).toBe(1);
  expect(nextTap(first, 120, 100, 1100).count).toBe(1);
  // The limits themselves still count.
  expect(nextTap(first, 116, 100, 1500).count).toBe(2);
  expect(nextTap(first, 116.1, 100, 1100).count).toBe(1);
  expect(nextTap(first, 100, 100, 1500.1).count).toBe(1);
});

it("shows each group as one button, at its first tool, fronting its last chosen tool", () => {
  const all = Object.keys(TOOLS) as Tool[];
  const slots = toolSlots(all, {});
  expect(slots.map((s) => s.shown)).toEqual([
    "selection",
    "direct",
    "zoom",
    "pen",
    "rectangle",
    "pencil",
  ]);
  expect(slots[3]?.tools).toEqual(["pen", "addAnchor", "deleteAnchor", "anchorPoint", "curvature"]);
  expect(slots[4]?.tools).toEqual(["rectangle", "ellipse"]);
  expect(toolSlots(all, { pen: "curvature", rectangle: "ellipse" })[3]?.shown).toBe("curvature");
  expect(toolSlots(all, { pen: "curvature", rectangle: "ellipse" })[4]?.shown).toBe("ellipse");
  // A viewer's tools show no group; a fronted tool that is not shown is ignored.
  expect(toolSlots(["selection", "zoom"], { pen: "curvature" })).toEqual([
    { tools: ["selection"], shown: "selection" },
    { tools: ["zoom"], shown: "zoom" },
  ]);
});
