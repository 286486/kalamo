import { expect, it } from "vitest";
import { KalamoError } from "./errors.ts";
import { formatPath, normalizePath, parsePath, pathBounds, shapeSegments } from "./path.ts";
import type { Rect, Shape } from "./schema.ts";

const regular = { angle: 0, rounded: 0, randomized: 0 };
const WHOLE = { startAngle: 0, endAngle: 360, arcType: "slice" } as const;

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

it("parses absolute M, L, C, Q and Z", () => {
  expect(parsePath("M 10 10 L 60 10 C 70 10 70 40 60 40 Q 35 50 10 40 Z", "d")).toEqual([
    { cmd: "M", args: [10, 10] },
    { cmd: "L", args: [60, 10] },
    { cmd: "C", args: [70, 10, 70, 40, 60, 40] },
    { cmd: "Q", args: [35, 50, 10, 40] },
    { cmd: "Z", args: [] },
  ]);
});

it("accepts implicit repeats, commas and compact numbers", () => {
  expect(parsePath("M0,0 1,2L3 4 5-6e1", "d")).toEqual([
    { cmd: "M", args: [0, 0] },
    { cmd: "L", args: [1, 2] },
    { cmd: "L", args: [3, 4] },
    { cmd: "L", args: [5, -60] },
  ]);
});

it("bounds a cubic by its extremum, not its control points", () => {
  expect(pathBounds(parsePath("M 0 0 C 0 100 100 100 100 0", "d"))).toEqual({
    x: 0,
    y: 0,
    width: 100,
    height: 75,
  });
  expect(pathBounds(parsePath("M 0 0 Q 50 100 100 0", "d"))).toEqual({
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });
});

it("formats with at most 3 decimals", () => {
  expect(formatPath(parsePath("M 0.00001 -0.0001 L 10.00049 1.23456 Z", "d"))).toBe(
    "M 0 0 L 10 1.235 Z",
  );
});

it.each([
  ["M 0 0 l 10 10", /absolute/],
  ["M 0 0 H 10", /H/],
  ["M 0 0 A 5 5 0 0 1 10 10", /A/],
  ["M 0 0 L 10", /L/],
  ["M 0 0 L 10 x", /x/],
  ["L 10 10", /M/],
  ["", /M/],
  ["M 0 0 L 1e400 0", /range/],
])("rejects %j with INVALID_PATH", (d, hint) => {
  const error = errorOf(() => parsePath(d, "nodes[0].d"));
  expect(error).toMatchObject({ code: "INVALID_PATH", path: "nodes[0].d" });
  expect(`${error.message} ${error.hint}`).toMatch(hint);
});

it("derives d for each Live Shape, with bounds equal to the shape's box", () => {
  const cases: [Shape, string | null, Rect][] = [
    [
      { type: "rect", x: 10, y: 20, width: 50, height: 30, radius: 0 },
      "M 10 20 L 60 20 L 60 50 L 10 50 Z",
      { x: 10, y: 20, width: 50, height: 30 },
    ],
    [
      { type: "rect", x: 0, y: 0, width: 40, height: 20, radius: 100 },
      null,
      { x: 0, y: 0, width: 40, height: 20 },
    ],
    [
      { type: "ellipse", x: 10, y: 10, width: 80, height: 40, ...WHOLE },
      null,
      { x: 10, y: 10, width: 80, height: 40 },
    ],
    [
      { type: "line", x1: 0, y1: 5, x2: 30, y2: 45 },
      "M 0 5 L 30 45",
      { x: 0, y: 5, width: 30, height: 40 },
    ],
    [
      { type: "polygon", cx: 50, cy: 50, radius: 10, sides: 4, ...regular },
      "M 50 40 L 60 50 L 50 60 L 40 50 Z",
      { x: 40, y: 40, width: 20, height: 20 },
    ],
    [
      {
        type: "star",
        cx: 0,
        cy: 0,
        outerRadius: 10,
        innerRadius: 5,
        points: 4,
        ...regular,
        twist: 0,
      },
      null,
      { x: -10, y: -10, width: 20, height: 20 },
    ],
  ];
  for (const [shape, d, box] of cases) {
    const segments = shapeSegments(shape);
    if (d) expect(formatPath(segments)).toBe(d);
    const b = pathBounds(segments);
    for (const k of ["x", "y", "width", "height"] as const) expect(b?.[k]).toBeCloseTo(box[k], 9);
  }
  // An ellipse starts at its top and runs in cubics.
  expect(
    formatPath(shapeSegments({ type: "ellipse", x: 10, y: 10, width: 80, height: 40, ...WHOLE })),
  ).toMatch(/^M 50 10 C/);
});

it("cuts an ellipse into a slice, a chord or an open arc, clockwise from 3 o'clock (ADR-0025)", () => {
  const box = { x: 40, y: 50, width: 120, height: 60 };
  const pie = (startAngle: number, endAngle: number, arcType: "slice" | "chord" | "open") =>
    shapeSegments({ type: "ellipse", ...box, startAngle, endAngle, arcType });
  const bounds = (segments: ReturnType<typeof pie>) => {
    const b = pathBounds(segments);
    return (
      b && Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * 1e9) / 1e9]))
    );
  };
  // Inkscape 1.2.2 draws this slice from 160,80 through 100,50, then v 30 z.
  const arc =
    "M 160 80 C 160 96.569 133.137 110 100 110 C 66.863 110 40 96.569 40 80 C 40 63.431 66.863 50 100 50";
  expect(formatPath(pie(0, 270, "slice"))).toBe(`${arc} L 100 80 Z`);
  expect(formatPath(pie(0, 270, "chord"))).toBe(`${arc} Z`);
  expect(formatPath(pie(0, 270, "open"))).toBe(arc);
  for (const type of ["slice", "chord", "open"] as const)
    expect(bounds(pie(0, 270, type))).toEqual(box);
  // An end before the start wraps through 0°.
  const right = pie(270, 90, "chord");
  const point = (args: number[] = []) => args.slice(-2).map((v) => Math.round(v * 1e9) / 1e9);
  expect(point(right[0]?.args)).toEqual([100, 50]);
  expect(point(right.at(-2)?.args)).toEqual([100, 110]);
  expect(bounds(right)).toEqual({ x: 100, y: 50, width: 60, height: 60 });
  expect(bounds(pie(0, 90, "slice"))).toEqual({ x: 100, y: 80, width: 60, height: 30 });
  // Equal angles draw the whole ellipse, closed, whatever the arc type.
  expect(formatPath(pie(57.296, 57.296, "open"))).toBe(formatPath(pie(0, 360, "slice")));
});

it("clamps the corner radius and draws four arcs", () => {
  const d = formatPath(
    shapeSegments({ type: "rect", x: 0, y: 0, width: 40, height: 20, radius: 100 }),
  );
  expect(d.match(/C/g)).toHaveLength(4);
  expect(d.startsWith("M 10 0 L 30 0 C")).toBe(true);
});

it("gives a 5-point star 10 vertices, alternating outer and inner, first at the top", () => {
  // Stored before ADR-0024, so without angle, twist, rounded or randomized.
  const segments = shapeSegments({
    type: "star",
    cx: 0,
    cy: 0,
    outerRadius: 10,
    innerRadius: 4,
    points: 5,
  } as Shape);
  const vertices = segments.filter((s) => s.cmd !== "Z");
  expect(vertices).toHaveLength(10);
  expect(vertices[0]?.args[0]).toBeCloseTo(0, 9);
  expect(vertices[0]?.args[1]).toBeCloseTo(-10, 9);
  expect(vertices.map((v) => Math.round(Math.hypot(v.args[0] ?? 0, v.args[1] ?? 0)))).toEqual([
    10, 4, 10, 4, 10, 4, 10, 4, 10, 4,
  ]);
  expect(segments.at(-1)?.cmd).toBe("Z");
});

it("bounds a path with more segments than a function call takes arguments", () => {
  const segments = Array.from({ length: 200_000 }, (_, i) => ({
    cmd: "L" as const,
    args: [i, -i],
  }));
  expect(pathBounds(segments)).toEqual({ x: 0, y: -199_999, width: 199_999, height: 199_999 });
});

it("normalises relative commands, H, V, S and T to absolute M, L, C, Q and Z", () => {
  expect(formatPath(normalizePath("m 10 10 h 20 v 20 s 5 5 10 0 t 10 0 z", "d"))).toBe(
    "M 10 10 L 30 10 L 30 30 C 30 30 35 35 40 30 Q 40 30 50 30 Z",
  );
  // S and T reflect the previous control point; implicit repeats continue the command.
  expect(
    formatPath(normalizePath("M0 0C0 10 10 10 10 0S20-10 20 0Q25 5 30 0T40 0l5 5 5 5", "d")),
  ).toBe("M 0 0 C 0 10 10 10 10 0 C 10 -10 20 -10 20 0 Q 25 5 30 0 Q 35 -5 40 0 L 45 5 L 50 10");
  // A command after Z without M starts a new subpath at the closed one's start.
  expect(formatPath(normalizePath("M 5 5 L 10 0 Z l 1 1", "d"))).toBe("M 5 5 L 10 0 Z M 5 5 L 6 6");
});

it("turns arcs into cubics on the ellipse", () => {
  const arc = normalizePath("M 0 0 A 10 10 0 0 1 20 0", "d");
  expect(arc.slice(1).every((s) => s.cmd === "C")).toBe(true);
  const b = pathBounds(arc) as Rect;
  for (const [k, v] of Object.entries({ x: 0, y: -10, width: 20, height: 10 })) {
    expect(b[k as keyof Rect]).toBeCloseTo(v, 3);
  }
  // Compact flags, a relative end point and the radius scaled up to reach it.
  const compact = normalizePath("M0 0a1 1 0 0110 0", "d");
  expect(compact.at(-1)?.args.slice(-2)).toEqual([10, 0]);
  expect((pathBounds(compact) as Rect).height).toBeCloseTo(5, 3);
  // A zero radius is a line; an arc to the current point draws nothing.
  expect(formatPath(normalizePath("M 0 0 A 0 5 0 0 0 10 0 A 5 5 0 0 0 10 0", "d"))).toBe(
    "M 0 0 L 10 0",
  );
});

it("refuses path data it cannot read", () => {
  for (const d of ["L 0 0", "M 0", "M 0 0 X 1", "M 0 0 A 1 1 0 2 0 5 5", ""]) {
    expect(errorOf(() => normalizePath(d, "d")).code).toBe("INVALID_PATH");
  }
});

it("turns the first vertex by angle and the inner vertices by twist, clockwise", () => {
  const star = {
    type: "star",
    cx: 10,
    cy: 20,
    outerRadius: 10,
    innerRadius: 4,
    points: 5,
    rounded: 0,
    randomized: 0,
  } as const;
  const [first, inner] = shapeSegments({ ...star, angle: 90, twist: 10 });
  expect(first?.args[0]).toBeCloseTo(20, 9);
  expect(first?.args[1]).toBeCloseTo(20, 9);
  const t = ((90 + 36 + 10) * Math.PI) / 180;
  expect(inner?.args[0]).toBeCloseTo(10 + 4 * Math.sin(t), 9);
  expect(inner?.args[1]).toBeCloseTo(20 - 4 * Math.cos(t), 9);
});

// Expected points from ADR-0024's reference model, which matches Inkscape 1.2.2 to 0.14 units.
const closeTo = (segments: { args: number[] }[], want: number[][]) => {
  expect(segments.map((s) => s.args.length)).toEqual(want.map((w) => w.length));
  segments.forEach((s, i) => {
    s.args.forEach((v, k) => {
      expect(v).toBeCloseTo(want[i]?.[k] ?? Number.NaN, 9);
    });
  });
};

it("jitters each vertex from a seed its own position gives, as Inkscape does", () => {
  const segments = shapeSegments({
    type: "star",
    cx: -37.3,
    cy: 42.7,
    outerRadius: 30,
    innerRadius: 12,
    points: 5,
    angle: 0,
    twist: 0,
    rounded: 0,
    randomized: 0.2,
  });
  expect(segments.map((s) => s.cmd).join("")).toBe(`ML${"L".repeat(8)}Z`);
  closeTo(segments.slice(0, -1), [
    [-32.73034278322011, 10.35430577285588],
    [-29.668813060222337, 38.567452507609644],
    [-6.595781786539295, 39.4015559900416],
    [-29.607743440003944, 48.606258423110326],
    [-25.464839320346144, 65.49577518125494],
    [-32.804445780999956, 58.13435211665929],
    [-50.93398082508203, 61.73661990781744],
    [-53.10582932327513, 47.85296252467283],
    [-65.07732461971726, 33.07105061894785],
    [-49.208032162116695, 33.99347789823465],
  ]);
});

it("rounds a randomized, twisted star with one cubic per edge", () => {
  const segments = shapeSegments({
    type: "star",
    cx: 120.25,
    cy: 80.5,
    outerRadius: 40,
    innerRadius: 18,
    points: 6,
    angle: 20,
    twist: 7,
    rounded: 0.3,
    randomized: 0.15,
  });
  const curves = [
    [
      141.23617559739915, 49.39225497258947, 125.33388788322445, 59.218053176102735,
      131.47385801234753, 64.87131859844976,
    ],
    [
      136.87303942808845, 69.8425163347075, 164.5809676121619, 67.31453811210923,
      164.32686278349422, 74.92195404982694,
    ],
    [
      164.0378937829089, 83.57313707568784, 142.5702569788091, 77.72475127400332,
      138.49680875111608, 84.77231483891813,
    ],
    [
      134.91482292603453, 90.96958834770236, 147.31882287030913, 114.05908433337667,
      140.5416108181486, 116.51283884866669,
    ],
    [
      132.83453888356195, 119.30325803779745, 134.43337415481446, 103.69110465831663,
      126.20155030778376, 103.84462855445003,
    ],
    [
      118.96289777399873, 103.97962975957705, 116.52810969317493, 122.11405260181576,
      109.84281215018612, 119.60128046356148,
    ],
    [
      102.24026575332306, 116.74374620379504, 105.36527868990818, 94.51954375176963,
      100.49525741627902, 88.46222121344454,
    ],
    [
      96.21280525415476, 83.13571593894014, 81.50585447846986, 97.84448639112404, 79.64225264513233,
      90.41158576206738,
    ],
    [
      77.52295738383368, 81.95886222473737, 101.3858255638702, 75.41358551517118,
      105.47230667751047, 68.56122497297616,
    ],
    [
      109.06575296805359, 62.53560320034065, 85.12751566336165, 51.793161487239566,
      91.42750461047797, 48.820700963227594,
    ],
    [
      98.59187657181378, 45.44040728125905, 109.88673372256633, 61.226610002414255,
      117.76756512084279, 61.48891125744427,
    ],
    [
      124.69757252011964, 61.71956580977934, 127.87423858015575, 42.51384298137863,
      134.12630327844042, 45.732259348332825,
    ],
  ];
  expect(segments.map((s) => s.cmd).join("")).toBe(`M${"C".repeat(12)}Z`);
  closeTo(segments.slice(0, -1), [curves[11]?.slice(4) ?? [], ...curves]);
});

it("rounds a randomized polygon through its outer vertices only", () => {
  const segments = shapeSegments({
    type: "polygon",
    cx: 60.4,
    cy: -20.2,
    radius: 25,
    sides: 5,
    angle: -15,
    rounded: 0.25,
    randomized: 0.1,
  });
  const curves = [
    [
      60.64174208904279, -44.78411408441313, 79.11397097348278, -41.983232589487756,
      82.13263921311207, -35.59460099834564,
    ],
    [
      85.15130745274136, -29.205969407203526, 83.84791738143855, -9.193374201502799,
      79.66651759466718, -2.7235409425514323,
    ],
    [
      75.48511780789582, 3.746292316399934, 55.965885680996905, 6.068265731928003,
      49.06687979879997, 3.758012587339696,
    ],
    [
      42.16787391660303, 1.447759442751389, 31.711935089533164, -13.453237766714773,
      33.10863028714323, -20.539697117849318,
    ],
    [
      34.50532548475329, -27.62615646898386, 46.050521462930064, -42.52959671411172,
      53.34613177598643, -43.656855399262426,
    ],
  ];
  closeTo(segments.slice(0, -1), [curves[4]?.slice(4) ?? [], ...curves]);
});

it("seeds a vertex on the 1/1024 grid as Inkscape does, stepping the angle first", () => {
  // A round-number star puts vertices exactly on grid lines; Inkscape 1.2.2 rebuilt this d.
  const inkscape = normalizePath(
    "m 103.0284,48.329488 11.87615,30.142229 29.31483,-0.253181 -15.65282,20.442233 15.67341,31.285531 -29.38559,-3.63474 -11.78481,25.47346 L 91.368052,124.11429 57.498268,128.29347 79.562653,97.859988 57.477684,76.565703 84.841993,82.44358 Z",
    "d",
  );
  const segments = shapeSegments({
    type: "star",
    cx: 100,
    cy: 100,
    outerRadius: 50,
    innerRadius: 25,
    points: 6,
    angle: 0,
    twist: 0,
    rounded: 0,
    randomized: 0.1,
  });
  expect(segments.map((s) => s.cmd)).toEqual(inkscape.map((s) => s.cmd));
  segments.forEach((s, i) => {
    s.args.forEach((v, k) => {
      expect(Math.abs(v - (inkscape[i]?.args[k] ?? Number.NaN))).toBeLessThan(1e-3);
    });
  });
});
