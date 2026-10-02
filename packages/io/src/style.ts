import type { Element } from "@xmldom/xmldom";

/** CSS properties by name, as one element ends up with them. */
export type Style = Record<string, string>;

/** Properties a child takes from its parent unless it sets its own (SVG 1.1 §6.14). */
const INHERITED = [
  "font-weight",
  "font-style",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "marker-start",
  "marker-mid",
  "marker-end",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-opacity",
  "font-family",
  "font-size",
  "color",
  "visibility",
  "text-anchor",
  "text-align",
  "line-height",
  "white-space",
  "letter-spacing",
];
/** Every property import reads. */
const PROPERTIES = [
  ...INHERITED,
  "opacity",
  "display",
  "mix-blend-mode",
  "clip-path",
  "shape-inside",
  "mask",
  "filter",
  "stop-color",
  "stop-opacity",
  "baseline-shift",
  // A nested <svg>'s only (#237).
  "overflow",
];

export function declarations(text: string | null): Style {
  const out: Style = {};
  for (const part of (text ?? "").split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const value = part
      .slice(colon + 1)
      .replace(/!important/i, "")
      .trim();
    if (value) out[part.slice(0, colon).trim().toLowerCase()] = value;
  }
  return out;
}

/** A `<style>` rule with one simple selector: a tag, `.class`, `#id` or `tag.class`. */
export interface Rule {
  tag?: string;
  cls?: string;
  id?: string;
  specificity: number;
  style: Style;
}

// ponytail: simple selectors only; combinators, attributes and pseudo-classes are skipped.
export function stylesheet(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const [, selectors = "", body = ""] of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const style = declarations(body);
    for (const sel of selectors.split(",").map((s) => s.trim())) {
      const m = /^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?(?:#([\w-]+))?$/.exec(sel);
      if (!m || !sel) continue;
      const [, tag, cls, id] = m;
      const specificity = (id ? 100 : 0) + (cls ? 10 : 0) + (tag ? 1 : 0);
      rules.push({ tag, cls, id, specificity, style });
    }
  }
  // Stable, so later rules of equal specificity still win.
  return rules.sort((a, b) => a.specificity - b.specificity);
}

/**
 * The element's style: what it inherits, then its presentation attributes, then matching
 * `<style>` rules, then its `style` attribute.
 */
export function computeStyle(e: Element, parent: Style, rules: Rule[]): Style {
  const own: Style = {};
  for (const p of PROPERTIES) {
    const v = e.getAttribute(p);
    if (v !== null && v.trim()) own[p] = v.trim();
  }
  const classes = (e.getAttribute("class") ?? "").split(/\s+/);
  for (const r of rules) {
    if (r.tag && r.tag !== e.localName) continue;
    if (r.cls && !classes.includes(r.cls)) continue;
    if (r.id && r.id !== e.getAttribute("id")) continue;
    Object.assign(own, r.style);
  }
  Object.assign(own, declarations(e.getAttribute("style")));
  const out: Style = {};
  for (const p of INHERITED) if (parent[p] !== undefined) out[p] = parent[p] as string;
  for (const [k, v] of Object.entries(own)) {
    if (v === "inherit") {
      if (parent[k] !== undefined) out[k] = parent[k] as string;
    } else out[k] = v;
  }
  if (own["font-size"] && out["font-size"]) {
    out["font-size"] = fontSize(out["font-size"], parent["font-size"]);
  }
  return out;
}

const NUMBER = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-z%]*)$/i;

/**
 * A percentage or `em` font size as a length in its parent's unit, so its children inherit what it
 * resolves to (CSS Fonts §2.5); with no parent's, it is of 12, Kalamo's default. Anything else, a
 * keyword such as `larger` included, is left as written.
 */
function fontSize(value: string, parent = "12px") {
  const [, n, unit = ""] = NUMBER.exec(value) ?? [];
  const [, p, parentUnit = ""] = NUMBER.exec(parent) ?? [];
  if (n === undefined || p === undefined || /^(%|em|ex|rem)$/i.test(parentUnit)) return value;
  const factor = unit === "%" ? Number(n) / 100 : unit.toLowerCase() === "em" ? Number(n) : 0;
  return factor ? `${Number(p) * factor}${parentUnit}` : value;
}
