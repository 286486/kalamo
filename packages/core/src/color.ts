import { KalamoError } from "./errors.ts";

export const COLOR_PATTERN = "^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$";
const HEX = new RegExp(COLOR_PATTERN);

/** The 148 CSS named colours (CSS Color 4 §6.1), as name and hex pairs. */
const NAMED: Record<string, string> = Object.fromEntries(
  (
    "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff " +
    "beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff " +
    "blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 " +
    "chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c " +
    "cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 " +
    "darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b " +
    "darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 " +
    "darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f " +
    "darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 " +
    "deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 " +
    "floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff " +
    "gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 " +
    "honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c " +
    "lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd " +
    "lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 " +
    "lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a " +
    "lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 " +
    "lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 " +
    "magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd " +
    "mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee " +
    "mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 " +
    "midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead " +
    "navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 " +
    "orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee " +
    "palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb " +
    "plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 " +
    "rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 " +
    "seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb " +
    "slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f " +
    "steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 " +
    "violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 " +
    "yellowgreen 9acd32"
  )
    .split(" ")
    .flatMap((w, i, all) => (i % 2 ? [] : [[w, `#${(all[i + 1] as string).toUpperCase()}`]])),
);

/**
 * Returns `value` if it is `#RRGGBB` or `#RRGGBBAA`, else throws INVALID_COLOR whose hint carries the
 * hex form of what the Agent probably meant (REQUIREMENTS §6.5).
 */
export function parseColor(value: unknown, path: string): string {
  if (typeof value === "string" && HEX.test(value)) return value;
  const hex = suggest(value);
  throw new KalamoError({
    code: "INVALID_COLOR",
    message: `${JSON.stringify(value) ?? "undefined"} is not a color.`,
    hint: hex
      ? `Use "${hex}". Colors are #RRGGBB or #RRGGBBAA.`
      : "Colors are #RRGGBB or #RRGGBBAA, e.g. #FF8800 or #FF880080 at half opacity.",
    path,
  });
}

/**
 * Any CSS colour as `#RRGGBB`, or `#RRGGBBAA` when not opaque: hex, `rgb()`, `hsl()`, the named
 * colours and `transparent`. `none`, `currentColor`, `url()` and anything else are null.
 */
export function cssColor(css: string): string | null {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    return (
      full.length === 8 && full.endsWith("ff") ? `#${full.slice(0, 6)}` : `#${full}`
    ).toUpperCase();
  }
  if (s === "transparent") return "#00000000";
  if (NAMED[s]) return NAMED[s];
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = (fn[2] as string).split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const value = (p: string, full: number) =>
    p.endsWith("%") ? (parseFloat(p) / 100) * full : parseFloat(p);
  const alpha = parts[3] === undefined ? 1 : value(parts[3], 1);
  let rgb: number[];
  if (fn[1]?.startsWith("rgb")) rgb = parts.slice(0, 3).map((p) => value(p, 255));
  else {
    const [hs = "", ss = "", ls = ""] = parts;
    const h = (((parseFloat(hs) % 360) + 360) % 360) / 30;
    const sat = value(ss, 1);
    const l = value(ls, 1);
    const a = sat * Math.min(l, 1 - l);
    rgb = [0, 8, 4].map((n) => {
      const k = (n + h) % 12;
      return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
    });
  }
  return channels(alpha < 1 ? [...rgb, alpha] : rgb, false);
}

function suggest(value: unknown): string | null {
  if (typeof value === "string") {
    // Agents often drop the #.
    return cssColor(value) ?? cssColor(`#${value.trim()}`);
  }
  if (Array.isArray(value))
    return channels(
      value,
      value.every((n) => n <= 1),
    );
  if (value && typeof value === "object") {
    const { r, g, b, a } = value as Record<string, unknown>;
    const list = a === undefined ? [r, g, b] : [r, g, b, a];
    return channels(
      list,
      list.every((n) => typeof n === "number" && n <= 1),
    );
  }
  return null;
}

/** `[r, g, b, a?]` as hex; `unit` means r, g, b are 0–1 floats. Alpha is always 0–1. */
function channels(list: unknown[], unit: boolean): string | null {
  if (list.length < 3 || list.length > 4) return null;
  if (!list.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const byte = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  const nums = list as number[];
  return `#${nums.map((n, i) => byte(unit || i === 3 ? n * 255 : n)).join("")}`.toUpperCase();
}

/** A colour's alpha, 0 to 1: its AA, or 1 for #RRGGBB (ADR-0017). */
export const alphaOf = (color: string) =>
  color.length === 9 ? Number.parseInt(color.slice(7), 16) / 255 : 1;

/** `hex` with its own alpha times `a`, as #RRGGBB when opaque. */
export function withAlpha(hex: string, a: number): string {
  const byte = Math.round(alphaOf(hex) * a * 255);
  return byte >= 255
    ? hex.slice(0, 7)
    : `${hex.slice(0, 7)}${byte.toString(16).padStart(2, "0").toUpperCase()}`;
}
