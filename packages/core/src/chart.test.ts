import { describe, expect, it } from "vitest";
import {
  CHART_PALETTE,
  type ChartInput,
  columnChart,
  maxChartRows,
  niceTicks,
  parseCsv,
  parseNumber,
} from "./chart.ts";
import { createDocument, createNodes, visibleBounds } from "./document.ts";
import { KalamoError } from "./errors.ts";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

const frame = { x: 50, y: 40, width: 400, height: 300 };
const quarters = [
  { quarter: "Q1", north: 120, south: 80, west: 100 },
  { quarter: "Q2", north: 150, south: 95, west: 90 },
  { quarter: "Q3", north: 170, south: 110, west: 130 },
  { quarter: "Q4", north: 160, south: 125, west: 140 },
];
// biome-ignore lint/suspicious/noExplicitAny: the tests read each Node type's own fields
type Child = { children?: Child[] } & Record<string, any>;
const chart = (input: Partial<ChartInput> = {}) => {
  const { node, warnings } = columnChart({
    parentId: "L",
    data: { rows: quarters },
    encoding: { x: "quarter", y: ["north", "south", "west"] },
    frame,
    ...input,
  });
  const group = node as Child;
  const part = (name: string) => group.children?.find((c) => c.name === name) as Child;
  return { group, part, warnings };
};

describe("niceTicks", () => {
  it.each([
    [0, 7, [0, 1, 2, 3, 4, 5, 6, 7]],
    [0, 1234, [0, 200, 400, 600, 800, 1000, 1200, 1400]],
    [-40, 60, [-40, -20, 0, 20, 40, 60]],
    [0, 0.7, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]],
    [-3, 0, [-3, -2.5, -2, -1.5, -1, -0.5, 0]],
  ])("%d to %d", (lo, hi, ticks) => expect(niceTicks(lo, hi)).toEqual(ticks));

  it("covers 0 and the values, and an all-zero chart spans 0 to 1", () => {
    const axis = (rows: object[]) =>
      chart({ data: { rows } as ChartInput["data"], encoding: { x: "c", y: "v" } })
        .part("Value Axis")
        .children?.filter((c) => c.type === "text")
        .map((c) => c.content);
    expect(
      axis([
        { c: "a", v: 5 },
        { c: "b", v: 5 },
      ]),
    ).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(axis([{ c: "a", v: 0 }])).toEqual(["0", "0.2", "0.4", "0.6", "0.8", "1"]);
    expect(
      axis([
        { c: "a", v: -40 },
        { c: "b", v: 60 },
      ]),
    ).toEqual(["-40", "-20", "0", "20", "40", "60"]);
  });

  it("draws values of 1e-300 to 1e300 in magnitude and fails INVALID_INPUT at a cell outside", () => {
    const numbers = (n: Child): number[] =>
      Object.values(n).flatMap((v) =>
        typeof v === "number"
          ? [v]
          : Array.isArray(v)
            ? v.flatMap((c) => (typeof c === "object" ? numbers(c) : []))
            : [],
      );
    const draw = (vs: number[]) =>
      chart({
        data: { rows: vs.map((v, i) => ({ c: `r${i}`, v })) },
        encoding: { x: "c", y: "v" },
      });
    for (const vs of [[-1e300, 1e300], [1e300], [-1e300], [1e-300], [-1e-300, 1]]) {
      const { group, part } = draw(vs);
      expect(numbers(group).every(Number.isFinite)).toBe(true);
      const ticks = part("Value Axis")
        .children?.filter((c) => c.type === "text")
        .map((c) => Number(c.content)) as number[];
      expect(ticks[0]).toBeLessThanOrEqual(Math.min(0, ...vs));
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(Math.max(0, ...vs));
      const step = (ticks[1] ?? 0) - (ticks[0] ?? 0);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5].some((m) => Math.abs(mantissa - m) < 1e-9)).toBe(true);
    }
    for (const [vs, at] of [
      [[-1e308, 1e308], 0],
      [[1.7e308], 0],
      [[Number.MAX_VALUE], 0],
      [[-Number.MAX_VALUE], 0],
      [[5e-324], 0],
      [[1, 1e-301], 1],
    ] as const) {
      expect(errorOf(() => draw([...vs]))).toMatchObject({
        code: "INVALID_INPUT",
        path: `data.rows[${at}].v`,
        message: `Row ${at}'s v, ${vs[at]}, is outside 1e-300 to 1e+300 in magnitude.`,
      });
    }
  });
});

describe("parseNumber", () => {
  it.each([
    ["1,234", 1234],
    ["12%", 12],
    ["$5", 5],
    ["5 €", 5],
    ["-$1,234.5", -1234.5],
    [" 7 ", 7],
    [3, 3],
    ["", null],
    [null, null],
    ["  ", null],
    ["abc", undefined],
    ["1,2", undefined],
    ["$", undefined],
    ["1e999", undefined],
    ["$5€", undefined],
    [",123", undefined],
  ])("%j", (cell, n) => expect(parseNumber(cell)).toBe(n));
});

it("drops the byte-order mark Excel writes before the header", () => {
  expect(parseCsv("\uFEFFq,v\na,1\n")).toEqual([
    ["q", "v"],
    ["a", "1"],
  ]);
});

it("parses RFC 4180: quoted commas, doubled quotes, CRLF and a line break in quotes", () => {
  expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",3\n')).toEqual([
    ["a", "b"],
    ["x, y", 'say "hi"'],
    ["two\nlines", "3"],
  ]);
});

describe("columnChart", () => {
  it("lays one series out as Illustrator's 80% cluster of one 90% column per category", () => {
    const { group, part, warnings } = chart({ encoding: { x: "quarter", y: "north" } });
    expect(group).toMatchObject({ type: "group", parentId: "L", name: "Column Graph" });
    expect(group.children?.map((c) => c.name)).toEqual(["Value Axis", "Category Axis", "north"]);
    const [base] = part("Category Axis").children as { x1: number; x2: number; y1: number }[];
    const slot = ((base?.x2 ?? 0) - (base?.x1 ?? 0)) / 4;
    const columns = part("north").children as {
      x: number;
      y: number;
      width: number;
      height: number;
    }[];
    expect(columns.map((c) => c.x)).toEqual(
      [0, 1, 2, 3].map((i) => expect.closeTo((base?.x1 ?? 0) + (i + 0.1 + 0.04) * slot, 9)),
    );
    for (const c of columns) {
      expect(c.width).toBeCloseTo(0.72 * slot, 9);
      expect(c.y + c.height).toBeCloseTo(base?.y1 ?? 0, 9);
    }
    // 0 to 180 by 20: heights are proportional to the values.
    const unit = (columns[0]?.height ?? 0) / 120;
    expect(columns.map((c) => c.height / unit)).toEqual(
      [120, 150, 170, 160].map((v) => expect.closeTo(v, 9)),
    );
    expect(warnings).toEqual([]);
  });

  it("puts three series side by side, each a ninth of 80% of the category wide, with a Legend", () => {
    const { group, part } = chart();
    expect(group.children?.map((c) => c.name)).toEqual([
      "Value Axis",
      "Category Axis",
      "north",
      "south",
      "west",
      "Legend",
    ]);
    const [base] = part("Category Axis").children as { x1: number; x2: number }[];
    const slot = ((base?.x2 ?? 0) - (base?.x1 ?? 0)) / 4;
    const share = (0.8 * slot) / 3;
    ["north", "south", "west"].forEach((name, j) => {
      const columns = part(name).children as Child[];
      expect(columns.map((c) => c.name)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
      columns.forEach((c, i) => {
        expect(c.x).toBeCloseTo((base?.x1 ?? 0) + i * slot + 0.1 * slot + (j + 0.05) * share, 9);
        expect(c.width).toBeCloseTo(0.9 * share, 9);
        expect(c.appearance).toEqual({ fills: [{ color: CHART_PALETTE[j] }], strokes: [] });
      });
    });
    const legend = part("Legend").children as Child[];
    expect(legend.map((c) => [c.type, c.name])).toEqual([
      ["rect", "north"],
      ["text", "north"],
      ["rect", "south"],
      ["text", "south"],
      ["rect", "west"],
      ["text", "west"],
    ]);
    expect(legend[0]).toMatchObject({
      appearance: { fills: [{ color: CHART_PALETTE[0] }] },
    });
    // Top right: the Legend's widest name ends at the frame's right edge (checked in the frame test).
    expect(legend[0]?.x as number).toBeGreaterThan((base?.x2 ?? 0) as number);
  });

  it("leaves a gap for an empty cell or a 0 and draws a negative value below the baseline", () => {
    const rows = [
      { c: "a", v: 10 },
      { c: "b", v: "" },
      { c: "c", v: -5 },
      { c: "d", v: 0 },
    ];
    const { part } = chart({ data: { rows }, encoding: { x: "c", y: "v" } });
    const columns = part("v").children as { name: string; y: number; height: number }[];
    expect(columns.map((c) => c.name)).toEqual(["a", "c"]);
    const [base] = part("Category Axis").children as { y1: number }[];
    expect(columns[0]?.y).toBeLessThan(base?.y1 ?? 0);
    expect(columns[1]?.y).toBeCloseTo(base?.y1 ?? 0, 9);
    expect(columns[1]?.height).toBeCloseTo((columns[0]?.height ?? 0) / 2, 9);
  });

  it("reads CSV with quoted commas the same as rows", () => {
    const csv =
      'quarter,north,south,west\nQ1,120,80,100\n"Q2","150",95,90\nQ3,170,110,130\nQ4,160,"125",140\n';
    expect(chart({ data: { csv } }).group).toEqual(chart().group);
    const thousands = 'q,v\na,"1,234"\nb,12%\nc,$5\n';
    const { part } = chart({ data: { csv: thousands }, encoding: { x: "q", y: "v" } });
    const h = (part("v").children as { height: number }[]).map((c) => c.height);
    expect(h[1] && (h[0] ?? 0) / h[1]).toBeCloseTo(1234 / 12, 6);
    expect(h[2] && (h[1] ?? 0) / h[2]).toBeCloseTo(12 / 5, 6);
  });

  it("fails INVALID_INPUT at the cell that does not parse", () => {
    const rows = [...quarters, { quarter: "Q5", north: 1, south: 2, west: 3 }];
    rows[3] = { quarter: "Q4", north: 1, south: "lots" as never, west: 2 };
    expect(
      errorOf(() => chart({ data: { rows }, encoding: { x: "quarter", y: ["north", "south"] } })),
    ).toMatchObject({
      code: "INVALID_INPUT",
      path: "data.rows[3].south",
      message: 'Row 3\'s south, "lots", is not a number.',
    });
    expect(
      errorOf(() => chart({ data: { csv: "q,v\na,1\nb,x\n" }, encoding: { x: "q", y: "v" } })),
    ).toMatchObject({
      path: "data.csv",
      message: 'Row 1\'s v, "x", is not a number.',
    });
    expect(
      errorOf(() => chart({ data: { csv: "q,v\na,1,2\n" }, encoding: { x: "q", y: "v" } })),
    ).toMatchObject({
      path: "data.csv",
    });
    expect(
      errorOf(() => chart({ encoding: { x: "quarter", y: ["north", "east"] } })),
    ).toMatchObject({
      path: "encoding.y[1]",
    });
    expect(errorOf(() => chart({ encoding: { x: "quarter", y: "constructor" } }))).toMatchObject({
      path: "encoding.y",
    });
    // A row without an Object-property-named field has no such cell, not Object's.
    expect(
      errorOf(() =>
        chart({
          data: { rows: [{ constructor: "a", v: 1 }, { v: 2 }] },
          encoding: { x: "constructor", y: "v" },
        }),
      ),
    ).toMatchObject({ path: "data.rows[1].constructor" });
    expect(
      chart({
        data: { rows: [{ c: "a", toString: 1 }, { c: "b" }] },
        encoding: { x: "c", y: "toString" },
      }).part("toString").children,
    ).toHaveLength(1);
    expect(errorOf(() => chart({ encoding: { x: "month", y: "north" } }))).toMatchObject({
      path: "encoding.x",
    });
    expect(errorOf(() => chart({ frame: { x: 0, y: 0, width: 20, height: 20 } }))).toMatchObject({
      path: "frame",
    });
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(
      errorOf(() =>
        chart({
          data: { rows: [Object.fromEntries([["c", "a"], ...many.map((s) => [s, 1])])] },
          encoding: { x: "c", y: many },
          frame: { x: 0, y: 0, width: 400, height: 150 },
        }),
      ),
    ).toMatchObject({ path: "frame", message: expect.stringContaining("Legend") });
  });

  describe.each([
    [1, 987],
    [3, 491],
    [50, 35],
  ])("with %i series", (n, most) => {
    const ys = Array.from({ length: n }, (_, j) => `s${j}`);
    const rowsOf = (length: number, value: (i: number, j: number) => number | null) =>
      Array.from({ length }, (_, i) =>
        Object.fromEntries([["c", `c${i}`], ...ys.map((y, j) => [y, value(i, j)])]),
      );
    const input = (rows: Record<string, unknown>[]) => ({
      parentId: "L",
      data: { rows: rows as never },
      encoding: { x: "c", y: n === 1 ? "s0" : ys },
      frame: { x: 0, y: 0, width: 2000, height: 2000 },
    });
    // -1 to 14.8 steps by 2 from -2 to 16, the most ticks niceTicks gives.
    const worst = (i: number) => (i === 0 ? -1 : 14.8);

    it(`draws ${most} rows of the most ticks and no zeros in one createNodes`, () => {
      expect(maxChartRows(n)).toBe(most);
      expect(niceTicks(-1, 14.8)).toHaveLength(10);
      const { doc, defaultLayerId } = createDocument({
        id: "d",
        name: "D",
        artboards: [{ width: 2000, height: 2000 }],
      });
      const { node } = columnChart({ ...input(rowsOf(most, worst)), parentId: defaultLayerId });
      // The Value Axis: its line and 10 ticks of a line and a label.
      expect((node as Child).children?.[0]?.children).toHaveLength(21);
      expect(() => createNodes(doc, [node])).not.toThrow();
    });

    it(`fails ${most + 1} rows at data, whatever the values`, () => {
      const said = `${n === 1 ? "1 series fits" : `${n} series fit`} at most ${most} rows`;
      for (const value of [worst, (i: number, j: number) => (i + j === 0 ? 1 : i % 2 ? 0 : null)]) {
        for (const data of [
          { rows: rowsOf(most + 1, value) },
          {
            csv: [
              ["c", ...ys],
              ...rowsOf(most + 1, value).map((r) => Object.values(r).map((v) => v ?? "")),
            ]
              .map((r) => r.join(","))
              .join("\n"),
          },
        ]) {
          if (n === 1 && "rows" in data) continue;
          expect(errorOf(() => columnChart({ ...input([]), data } as never))).toMatchObject({
            code: "LIMIT_EXCEEDED",
            path: "data",
            message: expect.stringContaining(said),
          });
        }
      }
    });
  });

  it("stays inside its frame, Strokes included", () => {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "D",
      artboards: [{ width: 500, height: 400 }],
    });
    for (const input of [
      {},
      { encoding: { x: "quarter", y: "north" } },
      {
        data: {
          rows: [
            { c: "loss", v: -1234 },
            { c: "gain", v: 987 },
          ],
        },
        encoding: { x: "c", y: "v" },
      },
    ]) {
      const { node } = columnChart({
        parentId: defaultLayerId,
        data: { rows: quarters },
        encoding: { x: "quarter", y: ["north", "south", "west"] },
        frame,
        ...input,
      });
      const [group] = createNodes(doc, [node]).nodes;
      const b = visibleBounds(doc, group as never);
      expect(b?.x).toBeGreaterThanOrEqual(frame.x - 1e-9);
      expect(b?.y).toBeGreaterThanOrEqual(frame.y - 1e-9);
      expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(frame.x + frame.width + 1e-9);
      expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThanOrEqual(frame.y + frame.height + 1e-9);
    }
  });

  it("warns CHART_LABELS_OVERLAP when a category label is wider than its category", () => {
    const rows = quarters.map((r) => ({ ...r, quarter: `${r.quarter} of the fiscal year 2026` }));
    expect(chart({ data: { rows } }).warnings).toEqual([
      { code: "CHART_LABELS_OVERLAP", message: expect.stringContaining("Widen the frame") },
    ]);
  });
});
