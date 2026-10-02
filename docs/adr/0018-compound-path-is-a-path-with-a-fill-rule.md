---
status: accepted
date: 2026-09-24
---

# A Compound Path is a `path` with several subpaths and a fill rule

Designers cut holes with Compound Paths (Illustrator's Object > Compound Path > Make), and an SVG `<path>` carries the same thing as `fill-rule`, which import drops today with a warning, so the round trip (ADR-0017) needs it (#30). REQUIREMENTS F-DOC-03 listed both a `fillRule` on `path` and a separate `compound_path` node type, after Illustrator's CompoundPathItem, which holds PathItems.

Kalamo has no `compound_path` type. A `path` Node gains `fillRule`, `"nonzero"` (the default) or `"evenodd"`, after Illustrator's PathItem `evenodd` and its Attributes panel. A Compound Path is a `path` whose `d` has more than one subpath: one Appearance, one fill rule, one Node, as CONTEXT.md defines it ("视为一个 Path").

- **SVG.** It is one `<path d fill-rule>`, which is also what Inkscape has: Inkscape's Path > Combine makes one `<path>`, and it has no compound object. Export writes `fill-rule="evenodd"` on a Path that has it and nothing for nonzero, the SVG default. Import keeps `fill-rule` on every element that becomes a Path (`<path>`, `<polygon>`, `<polyline>`). On a Live Shape or a text it is dropped without a warning: their outlines never cross themselves, so the rule draws nothing different.
- **Tools.** `node_create` and `node_update` take `fillRule` on a `path`; `node_get` returns it. Holes are written as subpaths of one `d`. Under `evenodd` any inner subpath is a hole; under `nonzero` an inner subpath is a hole only when it winds the other way.
- **Canvas.** The browser fills and hit-tests with the Node's rule, so a click in a hole misses the Path, as in Illustrator.

## Considered Options

- **A `compound_path` container with child `path` Nodes**, as Illustrator's DOM has it. SVG and Inkscape have no such object, so export must either write one `<path>` and lose the children's ids, which breaks Replace's id mapping (ADR-0017), or write a `<g>` of separate paths, which fills each alone and draws no hole. The children would also carry Appearances and transforms the compound would have to ignore.
- **`fillRule` on every leaf.** Only a Path's outline can cross itself or hold another subpath.

## Consequences

- REQUIREMENTS F-DOC-03 drops the `compound_path` row, and F-TEXT-06's Create Outlines makes one Path per glyph. ADR-0017's `UNSUPPORTED_ATTRIBUTE` list loses `fill-rule: evenodd`.
- Make and Release (F-BOOL-04) become operations on `path` Nodes: Make joins the selected Paths' `d`, each with its `transform` composed in (ADR-0007), into one Path; Release splits one into a Path per subpath. They are the `path_op` ops `make_compound_path` and `release_compound_path` and Object > Compound Path (ADR-0107, #266).
- A Path stored in a Durable Object before this change has no `fillRule`, and every reader takes a missing one as nonzero. A `.kalamo.json` file without it reads as nonzero through the schema default, so it needs no migration.
