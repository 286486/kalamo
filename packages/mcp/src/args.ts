import { type ErrorData, ZibelError, zodPath } from "@zibel/core";
import { z } from "zod";

/**
 * Parses a tool's arguments with its strict input schema. The first issue, an unknown key before
 * any other, becomes INVALID_INPUT with a path and a hint (ADR-0050).
 */
export function parseArgs<T extends z.ZodType>(tool: string, schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const { issues } = parsed.error;
  // A misspelled required argument would otherwise read only as missing.
  const issue = issues.find((i) => i.code === "unrecognized_keys") ?? issues[0];
  if (!issue) throw parsed.error;
  const { path, message, hint } = explain(tool, schema, raw, issue);
  throw new ZibelError({ code: "INVALID_INPUT", message, hint, ...(path && { path }) });
}

const dotted = (path: PropertyKey[]) => zodPath(path).replace(/^\./, "");
const an = (word: string) => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;

function explain(
  tool: string,
  schema: z.ZodType,
  raw: unknown,
  issue: z.core.$ZodIssue,
): Pick<ErrorData, "path" | "message" | "hint"> {
  const path = dotted(issue.path);
  const says = `${tool}: ${path ? `${path}: ` : ""}${issue.message}`;
  const fix = `Fix ${path || "the arguments"} as ${tool}'s description says.`;
  switch (issue.code) {
    case "unrecognized_keys": {
      const key = issue.keys[0] ?? "";
      const known = keysAt(schema, raw, issue.path);
      const close = known && closest(key, known);
      return {
        path: dotted([...issue.path, key]),
        message: `${tool} has no argument ${dotted([...issue.path, key])}.`,
        hint: known
          ? `${close ? `Did you mean ${close}? ` : ""}${path || tool} takes: ${known.join(", ")}.`
          : `Remove ${key}.`,
      };
    }
    case "invalid_type":
      return valueAt(raw, issue.path) === undefined
        ? { path, message: `${tool} needs ${path}.`, hint: `${path} is required.` }
        : { path, message: says, hint: `Send ${an(issue.expected)} as ${path}.` };
    case "too_small":
    case "too_big": {
      const bound = issue.code === "too_small" ? issue.minimum : issue.maximum;
      const unit = { array: "item", string: "character", set: "item" }[issue.origin as string];
      const words =
        issue.code === "too_small"
          ? issue.inclusive
            ? "at least"
            : "more than"
          : issue.inclusive
            ? "at most"
            : "less than";
      const count = unit ? ` ${unit}${bound === 1 ? "" : "s"}` : "";
      return { path, message: says, hint: `${path} must be ${words} ${bound}${count}.` };
    }
    case "invalid_value":
      return { path, message: says, hint: `Send one of: ${issue.values.join(", ")}.` };
    case "invalid_union": {
      // A discriminated union names the tags it knows.
      const options = (issue as { options?: unknown[] }).options;
      return {
        path,
        message: says,
        hint: options
          ? `Send one of: ${options.join(", ")}.`
          : `${path || "The arguments"} matches none of the forms ${tool} takes; see its description.`,
      };
    }
    default:
      return { path, message: says, hint: fix };
  }
}

const valueAt = (value: unknown, path: PropertyKey[]) =>
  path.reduce<unknown>((v, k) => (v as Record<PropertyKey, unknown> | undefined)?.[k], value);

/** The keys of the object schema at `path`, following the input into the right union option. */
function keysAt(schema: z.ZodType, value: unknown, path: PropertyKey[]): string[] | undefined {
  let s: z.ZodType | undefined = schema;
  for (let i = 0; s; i++) {
    const v = valueAt(value, path.slice(0, i));
    s = unwrap(s, v);
    if (i === path.length) return s instanceof z.ZodObject ? Object.keys(s.shape) : undefined;
    const k = path[i];
    s =
      s instanceof z.ZodArray
        ? (s.element as z.ZodType)
        : s instanceof z.ZodObject
          ? ((s.shape as Record<PropertyKey, unknown>)[k as PropertyKey] as z.ZodType)
          : undefined;
  }
  return undefined;
}

function unwrap(s: z.ZodType | undefined, value: unknown): z.ZodType | undefined {
  while (s) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) {
      s = s.unwrap() as z.ZodType;
    } else if (s instanceof z.ZodLazy) {
      s = s.unwrap() as z.ZodType;
    } else if (s instanceof z.ZodDiscriminatedUnion) {
      const tag = s._zod.def.discriminator;
      const given = (value as Record<string, unknown> | undefined)?.[tag];
      s = (s.options as z.ZodType[]).find(
        (o) => o instanceof z.ZodObject && o.shape[tag]?.safeParse(given).success,
      );
    } else {
      return s;
    }
  }
  return undefined;
}

/** A known key equal ignoring case, containing or contained in `key`, or 2 edits away. */
function closest(key: string, known: string[]): string | undefined {
  const k = key.toLowerCase();
  const near = (c: string) => {
    const l = c.toLowerCase();
    const [short, long] = l.length < k.length ? [l, k] : [k, l];
    return (short.length >= 3 && long.includes(short)) || distance(l, k) <= 2;
  };
  return known
    .filter(near)
    .sort((a, b) => distance(a.toLowerCase(), k) - distance(b.toLowerCase(), k))[0];
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}
