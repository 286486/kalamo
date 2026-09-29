---
status: accepted
date: 2026-09-23
---

# Document structure follows Illustrator, not Figma

Kalamo keeps Illustrator's structure: Layer and Group are separate node types (a Layer's parent is the root or another Layer; a Group never contains a Layer), and an Artboard is a region of the canvas, not a node and never a parent. Terms follow Illustrator too, such as Compound Shape versus Compound Path. The product replicates Illustrator for illustrators who already think in these terms, and giving agents a mandatory "pick a layer" step keeps generated documents organised.

## Considered Options

- **Figma's Frame model** (frames as nestable artboard-containers with layout): familiar to UI designers, but it merges page layout with drawing structure and has no Illustrator equivalent for layer-level appearance, template layers or artboard-independent artwork.

## Consequences

- Contributors coming from Figma will expect Frames. `CONTEXT.md` lists Frame as a term to avoid.
- Moving artwork between artboards is a transform, not a reparent.
