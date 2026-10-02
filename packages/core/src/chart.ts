import { z } from "zod";
import { MAX_NODES_PER_CREATE } from "./document.ts";
import { KalamoError } from "./errors.ts";
import type { NodeInput, Warning } from "./schema.ts";
import { textBox } from "./text.ts";

/** A cell as `rows` give it; an empty one is a gap. */
const Cell = z.union([z.string(), z.number(), z.null()]);
const field = z.string().min(1);

/** `niceTicks` spans less than 7.91 steps, plus a step of slack at each end: at most 10 ticks. */
const MAX_TICKS = 10;
/** The Nodes left for rows and series once the axes are drawn (`maxChartRows`). */
const ROW_NODES = MAX_NODES_PER_CREATE - 5 - 2 * MAX_TICKS;

/**
 * The most rows a chart of `series` y fields draws whatever its values, so the chart fits one
 * createNodes. Its Nodes are 3 for the Group, Value Axis and its line, 2 per tick, 2 for the
 * Category Axis and its baseline, a label per row, a Group per series, a rect per value, and with
 * two or more series the Legend and a swatch and name per series.
 */
// ponytail: one createNodes holds a chart to its Nodes; split the write when charts need more.
export const maxChartRows = (series: number) =>
  Math.floor((ROW_NODES - series - (series > 1 ? 1 + 2 * series : 0)) / (series + 1));

/**
 * What every `chart_create_*` tool takes (ADR-0106, REQUIREMENTS §6.4.5): the data as rows or CSV,
 * which fields draw, and the frame the whole chart lies in.
 */
export const ChartInput = z.strictObject({
  parentId: z.string().describe("A Layer or Group id to draw the chart in."),
  data: z
    .union([
      z.strictObject({ rows: z.array(z.record(z.string(), Cell)).min(1).max(maxChartRows(1)) }),
      z.strictObject({
        csv: z.string().min(1).describe("RFC 4180, the first row naming the fields."),
      }),
    ])
    .describe(
      `At most ${maxChartRows(1)} rows for 1 series, ${maxChartRows(3)} for 3, ${maxChartRows(50)} for 50; for S series ⌊(${ROW_NODES} − S − (S > 1 ? 1 + 2S : 0)) ÷ (S + 1)⌋. Numbers may carry thousands separators, % and a leading or trailing currency sign; an empty cell is a gap.`,
    ),
  encoding: z.strictObject({
    x: field.describe("The category field: one cluster per row, labelled by it."),
    y: z
      .union([field, z.array(field).min(1).max(50)])
      .describe("The value field, or one per series, each named in the Legend."),
  }),
  frame: z
    .strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .describe(
      "Where the whole chart lies, axes, labels and Legend included, in parentId's coordinates.",
    ),
});
export type ChartInput = z.input<typeof ChartInput>;

/**
 * Okabe and Ito's colour-blind-safe categorical palette without its black, which the axes use;
 * the first four have 3:1 contrast with white (ADR-0106).
 */
export const CHART_PALETTE = [
  "#0072B2",
  "#D55E00",
  "#009E73",
  "#CC79A7",
  "#E69F00",
  "#56B4E9",
  "#F0E442",
];
/** Illustrator's Graph Type defaults: a cluster fills 80% of its category, a column 90% of its share. */
const CLUSTER_WIDTH = 0.8;
const COLUMN_WIDTH = 0.9;
/** A drawn value's magnitude bounds, so the Value Axis span and its ticks stay finite doubles. */
const SMALLEST = 1e-300;
const LARGEST = 1e300;

const invalid = (path: string, message: string, hint: string) =>
  new KalamoError({ code: "INVALID_INPUT", message, hint, path });

/** RFC 4180 records: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  // Excel writes UTF-8 CSV with a byte-order mark, which is not part of the first field's name.
  const csv = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (csv[i + 1] === '"') cell += csv[++i];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      record.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      records.push([...record, cell]);
      record = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw invalid("data.csv", "A quoted field is never closed.", 'Close it with ".');
  if (cell !== "" || record.length > 0) records.push([...record, cell]);
  return records;
}

/** A cell's number as F-CHART-02 reads it, null for a gap, undefined when it does not parse. */
export function parseNumber(cell: string | number | null | undefined): number | null | undefined {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : undefined;
  const t = (cell ?? "").trim();
  if (t === "") return null;
  if ((t.match(/\p{Sc}/gu) ?? []).length > 1) return undefined;
  const s = t
    .replace(/^([-+]?)\p{Sc}\s*/u, "$1")
    .replace(/\s*(%|\p{Sc})$/u, "")
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  const n = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** About five ticks at 1, 2 or 5 × 10ⁿ, from at most `lo` to at least `hi`, as d3's `ticks`. */
export function niceTicks(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const error = raw / power;
  const step =
    power *
    (error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.SQRT2 ? 2 : 1);
  const ticks: number[] = [];
  for (let k = Math.floor(lo / step); k <= Math.ceil(hi / step); k++) {
    ticks.push(Number((k * step).toPrecision(12)));
  }
  return ticks;
}

/** A row without Object's prototype, so a field named constructor is only ever the row's own. */
const own = (row: Record<string, z.output<typeof Cell>>) =>
  Object.assign(Object.create(null) as typeof row, row);

/** The rows as records; a CSV's cells all take the path data.csv. */
function rowsOf(data: z.output<typeof ChartInput>["data"]) {
  if ("rows" in data) {
    return data.rows.map((row, i) => ({
      row: own(row),
      at: (f: string) => `data.rows[${i}].${f}`,
    }));
  }
  const [header = [], ...records] = parseCsv(data.csv).filter((r) => r.some((c) => c !== ""));
  if (records.length === 0) {
    throw invalid("data.csv", "The CSV has no rows after its header.", "Give at least 1 row.");
  }
  return records.map((record, i) => {
    if (record.length !== header.length) {
      throw invalid(
        "data.csv",
        `Row ${i} has ${record.length} fields; the header has ${header.length}.`,
        'Quote a field that holds a comma, as "1,234".',
      );
    }
    const row = own(Object.fromEntries(header.map((name, k) => [name, record[k] ?? ""])));
    return { row, at: () => "data.csv" };
  });
}

const measure = (content: string, fontSize: number) => textBox({ x: 0, y: 0, content, fontSize });

/** Point Type at `fontSize`, its box's vertical middle at `cy`. */
function label(
  content: string,
  x: number,
  cy: number,
  fontSize: number,
  alignment?: "center" | "right",
) {
  const box = measure(content, fontSize);
  return {
    type: "text" as const,
    name: content,
    x,
    y: cy - box.y - box.height / 2,
    content,
    fontSize,
    ...(alignment && { alignment }),
  };
}

const stroke = { fills: [], strokes: [{ color: "#000000", width: 1 }] };
/** Series `j`'s columns and Legend swatch: one Fill from the palette, no Stroke. */
const seriesFill = (j: number) => ({
  fills: [{ color: CHART_PALETTE[j % CHART_PALETTE.length] as string }],
  strokes: [],
});
const line = (x1: number, y1: number, x2: number, y2: number) => ({
  type: "line" as const,
  x1,
  y1,
  x2,
  y2,
  appearance: stroke,
});

/**
 * `chart_create_column` (F-CHART-01): an expanded Column Graph, one Group of ordinary Nodes laid
 * out inside `frame` (ADR-0106). `warnings` say what does not fit.
 */
export function columnChart(raw: ChartInput): { node: NodeInput; warnings: Warning[] } {
  const { parentId, data, encoding, frame } = ChartInput.parse(raw);
  const series = typeof encoding.y === "string" ? [encoding.y] : encoding.y;
  const rows = rowsOf(data);
  const most = maxChartRows(series.length);
  if (rows.length > most) {
    const s = series.length === 1 ? "1 series fits" : `${series.length} series fit`;
    throw new KalamoError({
      code: "LIMIT_EXCEEDED",
      message: `${rows.length} rows; ${s} at most ${most} rows in one chart of ${MAX_NODES_PER_CREATE} Nodes.`,
      hint: "Chart fewer rows or series, or split the data over several charts.",
      path: "data",
    });
  }
  for (const [k, f] of [encoding.x, ...series].entries()) {
    if (!rows.some(({ row }) => Object.hasOwn(row, f))) {
      const at =
        k === 0
          ? "encoding.x"
          : typeof encoding.y === "string"
            ? "encoding.y"
            : `encoding.y[${k - 1}]`;
      throw invalid(
        at,
        `No row has a field ${f}.`,
        `Fields: ${Object.keys(rows[0]?.row ?? {}).join(", ")}.`,
      );
    }
  }
  if (new Set(series).size < series.length || series.includes(encoding.x)) {
    throw invalid("encoding.y", "A field is named twice.", "Name each series once, apart from x.");
  }
  const categories = rows.map(({ row, at }, i) => {
    const c = row[encoding.x];
    if (c === null || c === undefined || String(c).trim() === "") {
      throw invalid(at(encoding.x), `Row ${i} has no ${encoding.x}.`, "Give every row a category.");
    }
    return String(c);
  });
  const values = rows.map(({ row, at }, i) =>
    series.map((f) => {
      const v = parseNumber(row[f]);
      if (v === undefined) {
        throw invalid(
          at(f),
          `Row ${i}'s ${f}, ${JSON.stringify(row[f])}, is not a number.`,
          "Give a number such as 1234, 1,234, 12% or $5, or leave the cell empty for a gap.",
        );
      }
      if (v !== null && v !== 0 && !(Math.abs(v) >= SMALLEST && Math.abs(v) <= LARGEST)) {
        throw invalid(
          at(f),
          `Row ${i}'s ${f}, ${v}, is outside ${SMALLEST} to ${LARGEST} in magnitude.`,
          `Give 0 or a value from ${SMALLEST} to ${LARGEST} in magnitude, in a larger or smaller unit.`,
        );
      }
      return v;
    }),
  );
  const all = values.flat().filter((v) => v !== null);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const ticks = niceTicks(lo, hi === lo ? 1 : hi);
  const min = ticks[0] as number;
  const max = ticks.at(-1) as number;

  // Text and spacing scale with the frame, in the bundled font.
  const fontSize = Math.min(
    12,
    Math.max(6, Math.round(Math.min(frame.width, frame.height) / 3) / 10),
  );
  const textHeight = measure("0", fontSize).height;
  const width = (s: string) => measure(s, fontSize).width;
  const legend = series.length > 1;
  const legendWidth = legend ? 1.5 * fontSize + Math.max(...series.map(width)) : 0;
  const tick = fontSize / 2;
  const left = frame.x + Math.max(...ticks.map((t) => width(String(t)))) + tick + fontSize / 4;
  // The baseline's Stroke reaches half its width past its end.
  const right = frame.x + frame.width - (legend ? legendWidth + fontSize : 0.5);
  const top = frame.y + textHeight / 2;
  const bottom = frame.y + frame.height - textHeight - fontSize / 2;
  // The last Legend row's name ends a text height below its centre, 1.5 sizes per row down.
  const legendHeight = legend ? textHeight + 1.5 * fontSize * (series.length - 1) : 0;
  if (right - left <= 0 || bottom - top <= 0 || legendHeight > frame.height) {
    throw invalid(
      "frame",
      `A ${frame.width} × ${frame.height} frame leaves no room for the columns beside the axes${legend ? " and Legend" : ""}.`,
      "Make the frame larger.",
    );
  }
  const y = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);
  const slot = (right - left) / categories.length;
  const share = (CLUSTER_WIDTH * slot) / series.length;
  const zero = y(0);

  const valueAxis = {
    type: "group" as const,
    name: "Value Axis",
    children: [
      line(left, top, left, bottom),
      ...ticks.flatMap((t) => [
        line(left - tick, y(t), left, y(t)),
        label(String(t), left - tick - fontSize / 4, y(t), fontSize, "right"),
      ]),
    ],
  };
  const categoryAxis = {
    type: "group" as const,
    name: "Category Axis",
    children: [
      line(left, zero, right, zero),
      ...categories.map((c, i) =>
        label(
          c,
          left + (i + 0.5) * slot,
          bottom + fontSize / 2 + textHeight / 2,
          fontSize,
          "center",
        ),
      ),
    ],
  };
  const columns = series.map((name, j) => ({
    type: "group" as const,
    name,
    children: categories.flatMap((c, i) => {
      const v = values[i]?.[j];
      // A 0 draws no column, as a gap does, rather than a rect with no area.
      if (!v) return [];
      const x =
        left + i * slot + ((1 - CLUSTER_WIDTH) / 2) * slot + (j + (1 - COLUMN_WIDTH) / 2) * share;
      return [
        {
          type: "rect" as const,
          name: c,
          x,
          y: Math.min(zero, y(v)),
          width: COLUMN_WIDTH * share,
          height: Math.abs(zero - y(v)),
          appearance: seriesFill(j),
        },
      ];
    }),
  }));
  const legendX = frame.x + frame.width - legendWidth;
  const legendGroup = {
    type: "group" as const,
    name: "Legend",
    // Each row's name is taller than its swatch, so the row is centred on the name.
    children: series.flatMap((name, j) => [
      {
        type: "rect" as const,
        name,
        x: legendX,
        y: frame.y + textHeight / 2 - fontSize / 2 + 1.5 * fontSize * j,
        width: fontSize,
        height: fontSize,
        appearance: seriesFill(j),
      },
      label(
        name,
        legendX + 1.5 * fontSize,
        frame.y + textHeight / 2 + 1.5 * fontSize * j,
        fontSize,
      ),
    ]),
  };

  const widest = Math.max(...categories.map(width));
  const warnings: Warning[] =
    widest > slot
      ? [
          {
            code: "CHART_LABELS_OVERLAP",
            message: `A category label is ${round(widest)} pt wide, more than the ${round(slot)} pt each category has, so labels overlap or leave the frame. Widen the frame or shorten the labels.`,
          },
        ]
      : [];
  const node = {
    type: "group" as const,
    parentId,
    name: "Column Graph",
    children: [valueAxis, categoryAxis, ...columns, ...(legend ? [legendGroup] : [])],
  };
  return { node, warnings };
}

const round = (n: number) => Math.round(n * 10) / 10;
