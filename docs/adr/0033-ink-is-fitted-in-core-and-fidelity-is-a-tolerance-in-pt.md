---
status: accepted
date: 2026-09-27
---

# Ink is fitted in core, and Fidelity is an error tolerance in pt

The Pencil, Simplify and `freehand_stroke` all turn Ink into a path (F-FREE-02, F-FREE-06, #76). Adobe publishes nothing about how the Pencil fits Ink. Its five-stop Fidelity slider behaves like the tolerance of a least-squares cubic fit with corner detection (research 06).

## Decision

**One fit in core: `fitInk(points, tolerance)`.** It is Schneider's algorithm ("An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems 1990) in plain TypeScript. First the Ink is split at its corners. Each piece gets a least-squares cubic, which is reparameterized with Newton steps and split at its worst point until every point lies within `tolerance`. A piece whose points all lie within the tolerance of its chord becomes a line.

- **A corner** is a turn sharper than 60°. The turn is measured between the directions to the nearest points at least twice the tolerance away on each side, and only the sharpest point of a run of such turns counts. A corner's Handles are not collinear, so the Anchor is Corner (ADR-0032). Any other join between cubics shares one tangent, so it is Smooth.
- **Closing.** A path closes only when its last point repeats its first, within 0.001 pt, whatever the Fidelity, and it has at least three distinct points. A gap the tolerance would bridge stays open, since it could be deliberate.
- **A smooth loop** splits at the point farthest from its start before fitting, so no piece has coincident ends and a small loop at Smooth stays a loop.

**Fidelity 0 to 100 maps to a tolerance of 10^((f − 50) / 50) pt.** That is 0.1 pt at 0 (Accurate), 1 pt at 50 and 10 pt at 100 (Smooth). The steps are geometric, so each stop of Illustrator's slider changes the result by about the same amount. The range covers Illustrator's old Fidelity field, 0.5 to 20 px.

**`freehand_stroke` fits the Ink in the MCP server and creates the path with `createNodes`.** It needs no new `DocumentService` method or Command, and the browser's Pencil will send the same `create` Command (ADR-0032). The tool takes `tool: "pencil"` only. `brush` and `blob` wait for their tools, and so does §6.4's `width`, since the Pencil's width comes from its Stroke. `pressure` is accepted and ignored. By default the path gets the Pencil's Appearance, a 1 pt black Stroke and no Fill ("Fill new pencil strokes" off).

## Consequences

- The tolerance is in document pt. The browser's Pencil will divide it by the zoom, so that Fidelity follows the screen the way Illustrator's does. The browser will also apply Illustrator's 15 px close distance itself, by ending the Ink on its first point.
- A turn up to 60° is fitted as a curve, even at Accurate.
