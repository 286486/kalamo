import { applyTo, type Gradient, type Matrix } from "@kalamo/core";
import { describe, expect, it } from "vitest";
import { dragHandle, dragVector, HIT, hitHandle, layout, STOP_GAP } from "./annotator.ts";

const stops = [
  { offset: 0, color: "#000000", midpoint: 0.25 },
  { offset: 0.5, color: "#FF0000" },
  { offset: 1, color: "#FFFFFF" },
];
const linear: Gradient = { type: "linear", stops, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };
const radial: Gradient = {
  type: "radial",
  stops,
  center: { x: 50, y: 50 },
  radius: 40,
  aspectRatio: 0.5,
  angle: 0,
  focus: { x: 50, y: 50 },
};
/** Turned 90° clockwise and scaled 2×, then moved to (200, 100). */
const turned: Matrix = [0, 2, -2, 0, 200, 100];
const world = (x: number, y: number) => {
  const [wx, wy] = applyTo(turned, x, y);
  return { x: wx, y: wy };
};

describe("hit-testing, in screen space through the leaf's transform", () => {
  const l = layout(linear, turned, 0.5);

  it("maps the bar through the transform", () => {
    expect(l.origin).toEqual({ x: 200, y: 100 });
    expect(l.end).toEqual(world(100, 0));
  });

  it("finds the end, a stop below the bar and a midpoint above it, within HIT screen px", () => {
    // At scale 0.5 a screen px is 2 pt, and the bar runs down the screen, so below it is left.
    expect(hitHandle(l, { x: 200 + 2, y: 300 }, 0.5)).toEqual({ kind: "end" });
    expect(hitHandle(l, { x: 200 - STOP_GAP * 2, y: 200 }, 0.5)).toEqual({
      kind: "stop",
      index: 1,
    });
    expect(hitHandle(l, { x: 200 + 9 * 2, y: 125 }, 0.5)).toEqual({ kind: "midpoint", index: 0 });
    expect(hitHandle(l, { x: 200 + (HIT + 1) * 2, y: 300 }, 0.5)).toBeNull();
    expect(hitHandle(l, { x: 200, y: 250 }, 0.5)).toEqual({ kind: "bar", t: 0.75 });
  });

  it("finds a radial's aspect ratio and focus handles on the ellipse", () => {
    const r = layout(radial, turned, 1);
    // The ellipse's short radius, 20, points down in the leaf and left on the screen.
    expect(r.aspect).toEqual(world(50, 70));
    expect(hitHandle(r, world(50, 70), 1)).toEqual({ kind: "aspect" });
    // A focus on the origin moves with it; Alt takes the focus alone.
    expect(hitHandle(r, world(50, 50), 1)).toEqual({ kind: "origin" });
    expect(hitHandle(r, world(50, 50), 1, true)).toEqual({ kind: "focus" });
    const off = layout({ ...radial, focus: { x: 70, y: 50 } }, turned, 1);
    expect(hitHandle(off, world(70, 50), 1)).toEqual({ kind: "focus" });
  });
});

describe("dragging", () => {
  const drag = (g: Gradient, h: Parameters<typeof dragHandle>[1], from: object, to: object) =>
    dragHandle(g, h, turned, from as never, to as never, 1);

  it("moves the whole vector by the origin, and the end alone, in the leaf's coordinates", () => {
    const moved = drag(linear, { kind: "origin" }, world(0, 0), world(10, 5));
    expect(moved).toMatchObject({ start: { x: 10, y: 5 }, end: { x: 110, y: 5 } });
    expect(drag(linear, { kind: "end" }, world(100, 0), world(60, 30))).toMatchObject({
      start: { x: 0, y: 0 },
      end: { x: 60, y: 30 },
    });
    expect(drag(linear, { kind: "end" }, world(100, 0), world(0, 0))).toBe(linear);
  });

  it("sets a radial's radius and angle by its end, and its aspect ratio across it", () => {
    expect(drag(radial, { kind: "end" }, world(90, 50), world(50, 110))).toMatchObject({
      radius: 60,
      angle: 90,
    });
    expect(drag(radial, { kind: "aspect" }, world(50, 70), world(80, 60))).toMatchObject({
      aspectRatio: 0.25,
    });
  });

  it("keeps the focus inside the ellipse", () => {
    expect(drag(radial, { kind: "focus" }, world(50, 50), world(60, 50))).toMatchObject({
      focus: { x: 60, y: 50 },
    });
    // Straight across, the ellipse is 20 high.
    expect(drag(radial, { kind: "focus" }, world(50, 50), world(50, 90))).toMatchObject({
      focus: { x: 50, y: 70 },
    });
  });

  it("moves a stop along the bar, and tears it off away from it while more than two remain", () => {
    const along = drag(linear, { kind: "stop", index: 1 }, world(50, 6), world(20, 6));
    expect(along.stops.map((s) => s.offset)).toEqual([0, 0.2, 1]);
    const torn = drag(linear, { kind: "stop", index: 1 }, world(50, 12), world(50, 60));
    expect(torn.stops.map((s) => s.color)).toEqual(["#000000", "#FFFFFF"]);
    expect(
      dragHandle(torn, { kind: "stop", index: 1 }, turned, world(100, 12), world(50, 90), 1),
    ).toBe(torn);
  });

  it("keeps a midpoint within 13%-87% of its span", () => {
    const m = (x: number) =>
      drag(linear, { kind: "midpoint", index: 0 }, world(12.5, -9), world(x, -9)).stops[0]
        ?.midpoint;
    expect(m(25)).toBeUndefined();
    expect(m(10)).toBe(0.2);
    expect(m(0)).toBe(0.13);
    expect(m(49)).toBe(0.87);
  });

  it("draws a new vector from the press to the release, and a radial centred at the press", () => {
    expect(dragVector(linear, turned, world(5, 5), world(25, 5))).toMatchObject({
      start: { x: 5, y: 5 },
      end: { x: 25, y: 5 },
    });
    expect(dragVector(radial, turned, world(10, 10), world(10, 40))).toMatchObject({
      center: { x: 10, y: 10 },
      radius: 30,
      focus: { x: 10, y: 10 },
      aspectRatio: 0.5,
    });
    expect(dragVector(linear, turned, world(5, 5), world(5, 5))).toBeNull();
  });
});
