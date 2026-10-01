---
status: accepted
date: 2026-10-02
---

# SVG Open reads a text's positioned tspans as its lines

ADR-0022 imports a `<text>` as multi-line Point Type only from Inkscape's `sodipodi:role="line"` tspans. Plain SVG writes a paragraph as one `<tspan x="…" dy="1.2em">` (or `y="…"`) per line, and browsers, resvg and Inkscape draw those as lines. Agents, hand-written files and other editors' exporters all write it. Kalamo dropped every other tspan's position without a word, so such a paragraph opened on one long line with its lines' words run together (#238, found by `pnpm bench fit`, #231). This amends ADR-0022's import section.

## Decision

1. **Scope.** The rule applies to a `<text>` that has no direct `sodipodi:role="line"` tspan and is not Area Type. Inkscape's line tspans and Area Type import exactly as before.
2. **What starts a line.** A direct child `<tspan>` of the `<text>` starts a line when it has an `x` and its baseline lies strictly below the current line's. Its baseline is its first `y`, else the current position plus its first `dy`; the position starts at the text's first `y` plus its first `dy`, and follows every direct tspan's `y` and `dy`. A nested tspan never starts a line. Each character belongs to the last line started before it in document order. Positions met before any character other than whitespace only move the first line, so a first tspan's `x` and `dy` place the text.
3. **Lengths.** `y` and `dy` read as other SVG lengths do, in the text's user units; `em` is of that tspan's computed `font-size`. A value that does not read counts as 0.
4. **Content and anchor.** Each line is cleaned by the existing whitespace rules, so indentation between tspans adds no spaces, and the lines join with `\n`. `x` and `y` are the first line's start and baseline, through the text's bake.
5. **Leading.** With two or more lines, `leading` is the step between the first two baselines, scaled by the bake and rounded to 3 decimals, and the positions win over `line-height`, since they are what renderers draw. A step of 120 % of `fontSize` at 3 decimals is Auto and is not stored, as `line-height: 1.2` imports. One line keeps reading `line-height`.
6. **Warnings.** Both are `UNSUPPORTED_ATTRIBUTE`, once per file per key (ADR-0017):
   - `tspan line position`: a later line starts at another `x` than the first, or steps by another distance than the first step. Every line takes the first line's `x`, and the first step is the leading.
   - `tspan position`: an `x`, `y`, `dx` or `dy` dropped without starting a line: any `dx`, a nested tspan's position, a direct tspan on the same or a higher baseline, an `x` alone, a value past the first in a list, and an unreadable length. Those characters import in the line's flow.
7. **Unchanged.** Character Ranges, `rotate`, `baseline-shift` and alignment from `text-anchor` and `text-align` (ADR-0077) work on positioned lines as on Inkscape's, and a later line with another alignment warns as there. Export still writes Inkscape line tspans (ADR-0022), so a re-open gives the same Node.

## Considered Options

- **Start a line at any tspan that moves the baseline down, `x` or not.** A `dy` superscript's return, or a tspan nudged down for an effect, would break the line. Requiring an `x` is what makes a tspan a new line, not a shifted run.
- **One Point Type per positioned line**, as ADR-0017 first imported Inkscape's lines. ADR-0022 rejected that: a paragraph should be one Node to edit.
- **Keep `line-height` over the positions.** Renderers ignore `line-height` on positioned tspans, so the opened text would not match what the file draws.

## How it was checked

`read.test.ts` "positioned tspan lines (ADR-0091)" opens #238's repro with `dy="1.2em"`, `dy="19.2"`, `dy="19.2px"` and an absolute `y`, and covers direct text before the first tspan, pretty-printed whitespace, Auto and set leading, a first-tspan `dy`, both warnings, a nested Character Range, `text-anchor="middle"`, a baked root scale and Area Type's positioned tspans. The existing Inkscape line and Area Type tests pass unchanged.
