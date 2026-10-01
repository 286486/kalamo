/**
 * A Document with a midpoint, black to white at 0.25 from 10 % to 90 % of one 200 × 100 rect, and
 * the edits Inkscape 1.2.2 makes to the stops of its export (ADR-0082). `io` checks the stops each
 * reads back, `render` that they draw what resvg draws of the edited file, and `pnpm roundtrip` that
 * each survives an Inkscape save and draws there as Kalamo draws it. Node runs the round trip, so
 * this imports only core's midpoint module.
 */
import { colorAt, mix } from "../packages/core/src/midpoint.ts";
import type { ColorStop } from "../packages/core/src/schema.ts";

export const MIDPOINT_STOPS: ColorStop[] = [
  { offset: 0.1, color: "#000000", midpoint: 0.25 },
  { offset: 0.9, color: "#FFFFFF" },
];

const LAYER = "01M38T29MP0NT1AYER00000000";
/** What every Node of a `.kalamo.json` carries, as a new one has it. */
const NODE = {
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: "normal",
  transform: [1, 0, 0, 1, 0, 0],
  tags: [],
  meta: {},
};

/** The Document, as `.kalamo.json`; `midpoint-edits.test.ts` checks it against the serializer. */
export const MIDPOINT_DOC = JSON.stringify({
  version: 1,
  name: "Midpoint",
  artboards: [
    {
      id: "01M38T29MP0NTARTB0ARD00000",
      name: "Artboard 1",
      frame: { x: 0, y: 0, width: 200, height: 100 },
      background: "#FFFFFF",
    },
  ],
  nodes: [
    { ...NODE, id: LAYER, type: "layer", parentId: null, index: "a0", name: "Layer 1" },
    {
      ...NODE,
      id: "01M38T29MP0NTRECT000000000",
      type: "rect",
      parentId: LAYER,
      index: "a0",
      name: "",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      radius: 0,
      appearance: {
        fills: [
          {
            type: "gradient",
            gradient: {
              type: "linear",
              start: { x: 0, y: 50 },
              end: { x: 200, y: 50 },
              stops: MIDPOINT_STOPS,
            },
          },
        ],
        strokes: [],
      },
    },
  ],
});

const STOP = /<stop [^>]*\/>/g;
const attr = (stop: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(stop)?.[1] ?? "";

/** `stop` recoloured in Inkscape's Fill and Stroke dialog. */
const recolour = (stop: string, color: string, opacity = 1) =>
  stop.replace("/>", ` style="stop-color:${color.toLowerCase()};stop-opacity:${opacity}"/>`);
/** A copy of `stop`, its attributes and all, as Inkscape adds one, at `offset` in `color`. */
const copy = (stop: string, offset: number, color: string) =>
  recolour(stop.replace(/ offset="[^"]*"/, ` offset="${offset}"`), color);

const marked = (stops: string[]) =>
  stops.flatMap((s, i) => (s.includes("kalamo:simulated") ? [i] : []));

const CHANNELS = ["red", "green", "blue", "alpha"] as const;
type Channel = (typeof CHANNELS)[number];
const hex2 = (v: number) => v.toString(16).padStart(2, "0");

/** Each edit of `exported`, the Document's SVG, by name. */
export function midpointEdits(exported: string) {
  const all = exported.match(STOP) ?? [];
  const first = exported.indexOf(all[0] as string);
  const last = exported.indexOf(all.at(-1) as string) + (all.at(-1) as string).length;
  /** The export with its stops, in order, replaced by what `f` makes of them. */
  const edit = (f: (stops: string[]) => string[]) =>
    exported.slice(0, first) + f([...all]).join("") + exported.slice(last);

  /** An inserted stop recoloured `steps` off its curve in one channel, the tolerance's edges. */
  const nudges = CHANNELS.flatMap((channel, k) =>
    [2, 3].map((steps) => [
      `an inserted stop's ${channel} ${steps} steps off the curve`,
      edit((s) => {
        const i = marked(s)[6] as number;
        const drawn = colorAt(MIDPOINT_STOPS, +attr(s[i] as string, "offset"));
        const v = [1, 3, 5].map((p) => Number.parseInt(drawn.slice(p, p + 2), 16));
        let alpha = 255;
        if (channel === "alpha") alpha -= steps;
        else v[k] = (v[k] as number) + ((v[k] as number) + steps > 255 ? -steps : steps);
        s[i] = recolour(s[i] as string, `#${v.map(hex2).join("")}`, alpha / 255);
        return s;
      }),
    ]),
  );

  return {
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
      return s.map((stop, k) =>
        k === i ? stop.replace(/ offset="[^"]*"/, ' offset="0.45"') : stop,
      );
    }),
    "inserted stops copied before the first stop and after the last": edit((s) => {
      const m = marked(s);
      const [start, end] = [m[0] as number, m.at(-1) as number];
      return [copy(s[start] as string, 0, "#0000FF"), ...s, copy(s[end] as string, 1, "#FF0000")];
    }),
    "the end stop recoloured by a step": edit((s) => [
      ...s.slice(0, -1),
      recolour(s.at(-1) as string, "#FEFEFE"),
    ]),
    "the start stop recoloured": edit(([start, ...rest]) => [
      recolour(start as string, "#0000FF"),
      ...rest,
    ]),
    // Inkscape copies kalamo:midpoint onto a stop added after a stop with one, halfway to the next
    // stop, the first inserted one: within 0.001 of the stop, so it reads back on the stop.
    "a stop added after the start stop": edit(([start, ...rest]) => {
      const offset = (0.1 + +attr(rest[0] as string, "offset")) / 2;
      return [start as string, copy(start as string, offset, "#010101"), ...rest];
    }),
    // The same copy dragged to 30 %, where Inkscape moves it among the stops by offset.
    "a stop added after the start stop, then moved": edit((s) => {
      const i = s.findIndex((stop) => +attr(stop, "offset") > 0.3);
      return [...s.slice(0, i), copy(s[0] as string, 0.3, "#010101"), ...s.slice(i)];
    }),
    ...(Object.fromEntries(nudges) as Record<
      `an inserted stop's ${Channel} ${2 | 3} steps off the curve`,
      string
    >),
  };
}
