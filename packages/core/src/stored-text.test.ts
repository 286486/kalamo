import { describe, expect, it } from "vitest";
import { KalamoError } from "./errors.ts";
import { storedText } from "./stored-text.ts";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

const point = {
  type: "text",
  kind: "point",
  x: 0,
  y: 0,
  content: "one",
  fontFamily: "Source Sans 3",
  fontStyle: "Regular",
  fontSize: 12,
} as const;
const area = { ...point, kind: "area", x: 10, y: 20, width: 100, height: 50 } as const;

describe("storedText", () => {
  it("drops left, the default alignment, and keeps the others (ADR-0077)", () => {
    expect(storedText({ ...point, alignment: "left" }, "t", "INVALID_INPUT")).toEqual(point);
    expect(storedText({ ...point, alignment: "center" }, "t", "INVALID_INPUT")).toEqual({
      ...point,
      alignment: "center",
    });
  });

  it("stores a shaped frame's bounds, replacing missing or stale ones (ADR-0078)", () => {
    const frame = "M 10 10 L 60 10 L 35 50 Z";
    const bounds = { x: 10, y: 10, width: 50, height: 40 };
    const want = { ...area, frame, ...bounds };
    expect(storedText({ ...area, frame }, "t", "INVALID_INPUT")).toEqual(want);
    const { x: _, y: __, width: ___, height: ____, ...unbounded } = area;
    expect(storedText({ ...unbounded, frame }, "t", "INVALID_INPUT")).toEqual(want);
  });

  it("stores Character Ranges canonical, and none as no key (ADR-0029)", () => {
    const ranges = [
      { start: 0, end: 2, fill: "#FF0000" },
      { start: 1, end: 2, rotation: 5 },
    ];
    expect(storedText({ ...point, ranges }, "t", "INVALID_INPUT").ranges).toEqual([
      { start: 0, end: 1, fill: "#FF0000" },
      { start: 1, end: 2, fill: "#FF0000", rotation: 5 },
    ]);
    const cleared = storedText(
      { ...point, ranges: [{ start: 0, end: 1, fontSize: 12 }] },
      "t",
      "INVALID_INPUT",
    );
    expect(cleared).not.toHaveProperty("ranges");
  });

  it("fits Auto Size's height to the lines its ranges give, and drops it off (ADR-0092)", () => {
    const { height: _, ...open } = area;
    const content = "one\ntwo";
    expect(storedText({ ...open, content, autoSize: true }, "t", "INVALID_INPUT")).toMatchObject({
      autoSize: true,
      height: 28.8,
    });
    const ranges = [{ start: 0, end: 3, fontSize: 24 }];
    const big = storedText({ ...open, content, ranges, autoSize: true }, "t", "INVALID_INPUT");
    expect((big as unknown as { height: number }).height).toBeGreaterThan(28.8);
    expect(storedText({ ...area, autoSize: false }, "t", "INVALID_INPUT")).toEqual(area);
  });

  it.each([point, { ...area, frame: "M 0 0 L 9 0 L 9 9 Z" }])(
    "refuses Auto Size on %j, as node_update does",
    (text) => {
      expect(errorOf(() => storedText({ ...text, autoSize: true }, "u", "INVALID_PATCH"))).toEqual({
        code: "INVALID_PATCH",
        message: "Auto Size belongs to a rectangular frame.",
        hint: "Send frame: null with it to make the frame the rectangle of its bounds.",
        path: "u.autoSize",
      });
    },
  );

  it.each([
    ["M 0 0 L 9 9", "INVALID_INPUT"],
    ["M 0 0 L 9 0 Z", "INVALID_PATCH"],
  ] as const)("refuses the frame %s in %s's terms", (frame, code) => {
    expect(errorOf(() => storedText({ ...area, frame }, "nodes[0]", code))).toMatchObject({
      code,
      path: "nodes[0].frame",
    });
  });

  it("refuses a bad range colour at its key", () => {
    const ranges = [{ start: 0, end: 1, fill: "red" }];
    expect(
      errorOf(() => storedText({ ...point, ranges }, "nodes[0]", "INVALID_INPUT")),
    ).toMatchObject({
      code: "INVALID_COLOR",
      path: "nodes[0].ranges[0].fill",
    });
  });
});
