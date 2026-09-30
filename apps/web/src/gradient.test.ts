import { createDocument, createNodes, type LeafNode, StoredGradient } from "@kalamo/core";
import { describe, expect, it } from "vitest";
import {
  activeGradient,
  addStop,
  angleOf,
  DEFAULT_STOPS,
  moveStop,
  paintTargets,
  paintUpdates,
  placeOn,
  removeStop,
  reverseStops,
  setMidpoint,
  withAngle,
  withPaints,
} from "./gradient.ts";

const stops = [
  { offset: 0, color: "#000000", midpoint: 0.25 },
  { offset: 0.4, color: "#FF0000", midpoint: 0.7 },
  { offset: 1, color: "#FFFFFF" },
];
/** Stops the schema stores unchanged. */
const valid = (s: unknown) =>
  StoredGradient.safeParse({ type: "linear", stops: s, start: { x: 0, y: 0 }, end: { x: 1, y: 0 } })
    .success;

describe("stops", () => {
  it("adds a stop in the colour the gradient has there, resetting its span's midpoint", () => {
    const { stops: out, index } = addStop(stops, 0.7);
    expect(index).toBe(2);
    expect(out[1]).toEqual({ offset: 0.4, color: "#FF0000" });
    expect(out[2]?.offset).toBe(0.7);
    expect(out[2]?.color).toMatch(/^#FF[0-9A-F]{4}$/);
    expect(out[0]).toEqual(stops[0]);
    expect(valid(out)).toBe(true);
  });

  it("moves a stop past another with its midpoint, and drops one that ends up last", () => {
    const moved = moveStop(stops, 1, 0.2);
    expect(moved).toEqual({ stops: [stops[0], { ...stops[1], offset: 0.2 }, stops[2]], index: 1 });
    const last = moveStop(stops.with(2, { offset: 0.9, color: "#FFFFFF" }), 1, 1.5);
    expect(last.index).toBe(2);
    expect(last.stops[2]).toEqual({ offset: 1, color: "#FF0000" });
    expect(valid(last.stops)).toBe(true);
  });

  it("removes a stop, but never one of the last two", () => {
    expect(removeStop(stops, 2)).toEqual([stops[0], { offset: 0.4, color: "#FF0000" }]);
    expect(removeStop(DEFAULT_STOPS, 0)).toBeNull();
  });

  it("keeps a midpoint within 13%-87% and leaves halfway out", () => {
    expect(setMidpoint(stops, 0, 0.05)[0]?.midpoint).toBe(0.13);
    expect(setMidpoint(stops, 0, 0.95)[0]?.midpoint).toBe(0.87);
    expect(setMidpoint(stops, 0, 0.5)[0]).toEqual({ offset: 0, color: "#000000" });
    expect(setMidpoint(stops, 2, 0.3)).toBe(stops);
  });

  it("reverses offsets and moves each midpoint to its mirrored span", () => {
    expect(reverseStops(stops)).toEqual([
      { offset: 0, color: "#FFFFFF", midpoint: 0.3 },
      { offset: 0.6, color: "#FF0000", midpoint: 0.75 },
      { offset: 1, color: "#000000" },
    ]);
    expect(reverseStops(reverseStops(stops))).toEqual(stops);
  });
});

describe("geometry", () => {
  const linear = {
    type: "linear" as const,
    stops,
    start: { x: 10, y: 10 },
    end: { x: 40, y: 50 },
  };

  it("turns a linear vector about its start, keeping its length", () => {
    const id = [1, 0, 0, 1, 0, 0] as const;
    expect(withAngle(linear, 90, [...id])).toEqual({ ...linear, end: { x: 10, y: 60 } });
    expect(withAngle(linear, 180, [...id])).toMatchObject({ end: { x: -40, y: 10 } });
  });

  it("reads and sets the angle as the page shows it through a turned, stretched leaf", () => {
    // Turned 90° clockwise and stretched 2× along the leaf's x.
    const m: [number, number, number, number, number, number] = [0, 2, -1, 0, 0, 0];
    const flat = { ...linear, end: { x: 60, y: 10 } };
    expect(angleOf(flat, m)).toBeCloseTo(90);
    // Pointing right on the page is pointing up (-y) in the leaf; its length stays 50.
    expect(withAngle(flat, 0, m)).toMatchObject({ end: { x: 10, y: -40 } });
    const radial = placeOn(leaf(), { type: "radial", stops });
    expect(withAngle(radial, 0, m)).toMatchObject({ angle: -90 });
    expect(angleOf(withAngle(radial, 0, m), m)).toBeCloseTo(0);
  });
});

function leaf(appearance?: object) {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const [group] = createNodes(doc, [
    {
      type: "group",
      parentId,
      children: [
        { type: "rect", x: 0, y: 0, width: 100, height: 50, ...(appearance && { appearance }) },
      ],
    },
  ]).nodes;
  const [rect] = [...doc.nodes.values()].filter((n) => n.type === "rect") as LeafNode[];
  return Object.assign(rect as LeafNode, { doc, groupId: group?.id as string });
}

describe("targets", () => {
  it("paints the leaves of a selected Group, filling in the default gradient's geometry", () => {
    const rect = leaf();
    const targets = paintTargets(rect.doc, [rect.groupId]);
    expect(targets.map((n) => n.id)).toEqual([rect.id]);
    const updates = paintUpdates(targets, "fill", (g, n) =>
      g ? null : placeOn(n, { type: "linear", stops: DEFAULT_STOPS }),
    );
    expect(updates).toEqual([
      {
        nodeId: rect.id,
        appearance: {
          fills: [
            {
              type: "gradient",
              gradient: {
                type: "linear",
                stops: DEFAULT_STOPS,
                start: { x: 0, y: 25 },
                end: { x: 100, y: 25 },
              },
            },
          ],
        },
      },
    ]);
    const shown = withPaints(rect.doc, updates);
    expect(activeGradient(shown.nodes.get(rect.id) as LeafNode, "fill")?.stops).toEqual(
      DEFAULT_STOPS,
    );
  });

  it("makes the topmost Stroke a gradient, keeping its width, or adds one", () => {
    const rect = leaf({
      strokes: [
        { color: "#000000", width: 1 },
        { color: "#FF0000", width: 6 },
      ],
    });
    const g = placeOn(rect, { type: "radial", stops });
    const [update] = paintUpdates([rect], "stroke", () => g);
    const strokes = (update as { appearance: { strokes: object[] } }).appearance.strokes;
    expect(strokes[0]).toMatchObject({ type: "solid", color: "#000000" });
    expect(strokes[1]).toEqual({
      type: "gradient",
      gradient: g,
      width: 6,
      cap: "butt",
      join: "miter",
      miterLimit: 10,
      dash: [],
    });
    const bare = leaf({ fills: [] });
    const [added] = paintUpdates([bare], "stroke", () => g);
    expect((added as { appearance: { strokes: object[] } }).appearance.strokes).toHaveLength(1);
  });
});
