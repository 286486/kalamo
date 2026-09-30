import { describe, expect, it } from "vitest";
import { blend, colorAt, type DrawnStop, drawnStops, MIDPOINT_CAP } from "./midpoint.ts";

const channels = (c: string) =>
  [1, 3, 5, 7].map((i) => (i < c.length ? Number.parseInt(c.slice(i, i + 2), 16) : 255));

/** The drawn colour at `t`, blended straight between drawn stops as SVG and Canvas2D do. */
function drawnAt(stops: DrawnStop[], t: number): number[] {
  const k = stops.findIndex((s) => s.offset > t);
  const [a, b] = [stops[k - 1] as DrawnStop, stops[k] as DrawnStop];
  const w = (t - a.offset) / (b.offset - a.offset);
  const [ca, cb] = [channels(a.color), channels(b.color)];
  return ca.map((v, i) => v + ((cb[i] as number) - v) * w);
}

describe("drawnStops", () => {
  it("returns the stops unchanged when every midpoint is 0.5", () => {
    const stops = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#FFFFFF" },
    ];
    expect(drawnStops({ stops })).toBe(stops);
  });

  const stops = [
    { offset: 0.2, color: "#000000", midpoint: 0.25 },
    { offset: 0.6, color: "#FFFFFF80" },
    { offset: 0.8, color: "#FF0000" },
  ];
  const drawn = drawnStops({ stops });

  it("keeps the Color Stops and marks only the stops it inserts", () => {
    expect(drawn.filter((s) => !s.simulated)).toEqual(stops);
    expect(drawn.filter((s) => s.simulated).every((s) => s.offset > 0.2 && s.offset < 0.6)).toBe(
      true,
    );
  });

  it("mixes 50/50 at the midpoint, colour and alpha, within one 8-bit step", () => {
    const at = drawnAt(drawn, 0.2 + 0.25 * 0.4);
    for (const [v, want] of at.map((v, i) => [v, [127.5, 127.5, 127.5, 191.5][i]])) {
      expect(Math.abs((v as number) - (want as number))).toBeLessThanOrEqual(1);
    }
  });

  it("keeps every channel within one step of the curve everywhere", () => {
    for (let t = 0.2; t < 0.6; t += 0.0001) {
      const w = blend((t - 0.2) / 0.4, 0.25);
      const want = [255 * w, 255 * w, 255 * w, 255 - 127 * w];
      drawnAt(drawn, t).forEach((v, i) => {
        expect(Math.abs(v - (want[i] as number))).toBeLessThanOrEqual(1);
      });
    }
  });

  it("leaves a hard edge alone and never inserts more than the cap", () => {
    const edge = [
      { offset: 0, color: "#000000" },
      { offset: 0.5, color: "#FF0000", midpoint: 0.13 },
      { offset: 0.5, color: "#0000FF", midpoint: 0.87 },
      { offset: 1, color: "#FFFFFF" },
    ];
    const out = drawnStops({ stops: edge });
    expect(out.slice(0, 3)).toEqual(edge.slice(0, 3));
    expect(out.length - edge.length).toBeGreaterThan(0);
    expect(out.length - edge.length).toBeLessThanOrEqual(MIDPOINT_CAP);
    expect(out.map((s) => s.offset)).toEqual(out.map((s) => s.offset).sort((a, b) => a - b));
  });

  it("never rounds an inserted stop onto its neighbour's offset, across the midpoint range", () => {
    for (let m = 0.13; m <= 0.87; m += 0.005) {
      const out = drawnStops({
        stops: [
          { offset: 0, color: "#000000", midpoint: m },
          { offset: 0.001, color: "#FFFFFF80", midpoint: m },
          { offset: 1, color: "#FFFFFF" },
        ],
      });
      out.slice(1).forEach((s, i) => {
        expect(s.offset, `m ${m}`).toBeGreaterThan((out[i] as DrawnStop).offset);
      });
    }
  });
});

describe("colorAt", () => {
  it("follows the blend curve between stops and holds beyond them", () => {
    const stops = [
      { offset: 0.5, color: "#000000", midpoint: 0.25 },
      { offset: 1, color: "#FFFFFF" },
    ];
    expect(colorAt(stops, 0.2)).toBe("#000000");
    // Half-way in colour, to within the curve's floating point.
    expect(colorAt(stops, 0.625)).toMatch(/^#(7F7F7F|808080)$/);
    expect(colorAt(stops, 1)).toBe("#FFFFFF");
  });
});
