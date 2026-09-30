/**
 * A Kalamo export of a midpoint, black to white at 0.25 from 10 % to 90 % of one 200 × 100 rect,
 * and the edits Inkscape 1.2.2 makes to its stops (ADR-0082). `io` checks the stops each reads
 * back, and `render` that they draw what resvg draws of the edited file.
 */
import { type ColorStop, createDocument, createNodes, mix } from "../packages/core/src/index.ts";
import { toSvg } from "../packages/io/src/index.ts";

export const MIDPOINT_STOPS: ColorStop[] = [
  { offset: 0.1, color: "#000000", midpoint: 0.25 },
  { offset: 0.9, color: "#FFFFFF" },
];

function exported(): string {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "D",
    name: "Doc",
    artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
  });
  const gradient = { type: "linear", stops: MIDPOINT_STOPS } as const;
  createNodes(doc, [
    {
      type: "rect",
      parentId,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      appearance: { fills: [{ type: "gradient", gradient }] },
    },
  ]);
  return toSvg(doc);
}

const STOP = /<stop [^>]*\/>/g;
const attr = (stop: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(stop)?.[1] ?? "";

/** The export with its stops, in order, replaced by what `f` makes of them. */
function edit(f: (stops: string[]) => string[]): string {
  const text = exported();
  const stops = text.match(STOP) ?? [];
  const first = text.indexOf(stops[0] as string);
  const last = text.indexOf(stops.at(-1) as string) + (stops.at(-1) as string).length;
  return text.slice(0, first) + f(stops).join("") + text.slice(last);
}

/** A copy of `stop`, its attributes and all, as Inkscape adds one, at `offset` in `color`. */
const copy = (stop: string, offset: number, color: string) =>
  stop
    .replace(/ offset="[^"]*"/, ` offset="${offset}"`)
    .replace("/>", ` style="stop-color:${color.toLowerCase()};stop-opacity:1"/>`);
/** `stop` recoloured in Inkscape's Fill and Stroke dialog. */
const recolour = (stop: string, color: string) =>
  stop.replace("/>", ` style="stop-color:${color};stop-opacity:1"/>`);

const marked = (stops: string[]) =>
  stops.flatMap((s, i) => (s.includes("kalamo:simulated") ? [i] : []));

export const MIDPOINT_EDITS = {
  "a plain save": edit((s) => s),
  // The triage repro: a stop added after an inserted one, and recoloured.
  "a red stop added after an inserted stop": edit((s) => {
    const i = marked(s)[11] as number;
    return [...s.slice(0, i + 1), copy(s[i] as string, 0.5, "#FF0000"), ...s.slice(i + 1)];
  }),
  // Inkscape gives an added stop the colour its neighbours blend to there.
  "a stop added between inserted stops, in the colour drawn there": edit((s) => {
    const i = marked(s)[8] as number;
    const [a, b] = [s[i] as string, s[i + 1] as string];
    const offset = Math.round(((+attr(a, "offset") + +attr(b, "offset")) / 2) * 1e6) / 1e6;
    const color = mix(attr(a, "stop-color"), attr(b, "stop-color"), 0.5);
    return [...s.slice(0, i + 1), copy(a, offset, color), ...s.slice(i + 1)];
  }),
  "an inserted stop moved": edit((s) => {
    const i = marked(s)[11] as number;
    return s.map((stop, k) => (k === i ? stop.replace(/ offset="[^"]*"/, ' offset="0.45"') : stop));
  }),
  "inserted stops copied before the first stop and after the last": edit((s) => {
    const [first, last] = [marked(s)[0] as number, marked(s).at(-1) as number];
    return [copy(s[first] as string, 0, "#0000FF"), ...s, copy(s[last] as string, 1, "#FF0000")];
  }),
  "the end stop recoloured by a step": edit((s) => [
    ...s.slice(0, -1),
    recolour(s.at(-1) as string, "#fefefe"),
  ]),
  "the start stop recoloured": edit(([start, ...rest]) => [
    recolour(start as string, "#0000ff"),
    ...rest,
  ]),
  // Inkscape copies kalamo:midpoint onto a stop added after a stop with one.
  "a stop added after the start stop": edit(([start, ...rest]) => {
    const offset = (0.1 + +attr(rest[0] as string, "offset")) / 2;
    return [start as string, copy(start as string, offset, "#010101"), ...rest];
  }),
};
