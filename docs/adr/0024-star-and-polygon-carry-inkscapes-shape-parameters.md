---
status: accepted
date: 2026-09-25
---

# Stars and polygons carry Inkscape's angle, rounded, randomized and twist

ADR-0017 lists a star's or polygon's `rounded`, `randomized` and twist as Kalamo gaps: until they exist, such a shape imports as a Path with `STAR_AS_PATH` (#34, F-DRAW-01). This ADR adds them, and one more parameter, `angle`, that the randomisation forces.

## The parameters

| Field | On | Default | Inkscape | Meaning |
|---|---|---|---|---|
| `angle` | polygon, star | 0 | `arg1 = −π/2 + angle·π/180` | direction of the first vertex, degrees clockwise on screen from straight up, as `rotate` is |
| `twist` | star | 0 | `arg2 = arg1 + π/points + twist·π/180` | how far the inner vertices turn clockwise off the half step |
| `rounded` | polygon, star | 0 | `inkscape:rounded` | handle length at each vertex, as a fraction of the distance to the next vertex; negative loops the curve |
| `randomized` | polygon, star | 0 | `inkscape:randomized` | vertex jitter, as a fraction of the larger radius |

All four are finite numbers; `rounded` and `randomized` are limited to −10…10, Inkscape's own toolbar range. `node_create` and `node_update` accept them, `node_get` returns them with the derived `d`, and `shapeSegments` in `core/path.ts` draws them, so the canvas, `render` and export draw the same outline. The names are Inkscape's: Illustrator's live polygon has an angle but no rounding that matches (its corner radius makes circular arcs, Inkscape's rounding makes Béziers through every vertex) and no randomisation. The same reasoning named `preserveAspectRatio` (ADR-0023).

## The geometry

Derived from Inkscape 1.2.2's output, not its source: 40 random stars and polygons (sides 3–12, radii 5–200, any angle, twist, rounding and randomisation) and 10 with round-number centres and radii (sides 4–12, flat and not), rebuilt by Inkscape with `object-to-path`, match the formulas below to 0.14 user units at worst.

- **Vertices.** For `i` in `0…sides−1`: the outer vertex at radius `r1`, angle `arg1 + i·(2π/sides)`, then, for a star, the inner vertex at `r2`, angle `arg2 + i·(2π/sides)`, the step computed first, as Inkscape does: a star with a round-number centre and radius puts vertices exactly on the seed's 1/1024 grid, where the last bit of the angle picks the seed, and `arg + 2πi/sides` moves a 6-point star's jittered vertex by 9 units; a polygon has only the outer ones and `r2` is its inradius. Each is `(cx + r·cos t, cy + r·sin t)`. Call these `U`.
- **Seed.** Each vertex has its own pseudo-random stream, seeded from its `U` point. The point is computed from `cx, cy, r1, r2` first rounded to float32 (`Math.fround`), with `arg1`, `arg2` and all arithmetic in double. For each coordinate `v`: `F = floor(1024·v)`, `h = (floor(F/16) rem 1024) + (F rem 64)`, where `floor(F/16)` rounds down (an arithmetic shift, checked on negative coordinates) and `rem` is C's truncating remainder; the seed is `((h(x) << 16) + h(y))` mod 2³². The stream is the LCG `s ← (69069·s + 1) mod 2³²`, and each draw is `2s/2³² − 1`, in −1…1. A vertex takes four draws `d1…d4`.
- **Jitter.** The drawn vertex is `V = U + randomized · max(r1, r2) · (d1, d2)`.
- **Sharp** (`rounded = 0`): `M V0 L V1 … Z`.
- **Rounded.** Every edge `i → j` is a cubic. At vertex `i` the handle direction is `t_i = atan2(U[i+1] − U[i−1]) + randomized · π/2 · d3`, and for the edge `i → j` both handle lengths use that edge's unjittered length `L = |U[j] − U[i]|`: `l_i = rounded · L · (1 + randomized · d4_i / 2)`. The edge is `C V_i + l_i(cos t_i, sin t_i), V_j − l_j(cos t_j, sin t_j), V_j`.

The seed is quantised at 1/1024 of a unit, so the same star moved by a fraction of a unit draws a different jitter. That fixes three rules:

1. **`angle` is a parameter, not a matrix.** ADR-0017 folded `arg1 ≠ −π/2` into `transform` as a rotation about the centre. For a randomized shape that moves every `U` point, so every seed, and the imported shape would not be the one Inkscape drew. Import now maps `arg1` to `angle` for every star and polygon, randomized or not, so one rule holds.
2. **Randomized shapes are not baked or rounded on import.** ADR-0017 bakes a move plus a uniform scale into the parameters and rounds them to 3 decimals. For a shape with `randomized ≠ 0` both would re-roll the jitter: its `cx`, `cy`, `r1`, `r2`, `angle` and `twist` are kept exactly as the file has them, and a non-identity matrix stays in `transform` at 6 decimals. `angle` and `twist` are derived from `arg1` and `arg2` in floating point, so they round to 9 decimals of a degree, which moves a vertex at radius 1000 by 2 × 10⁻⁸ units against a seed quantum of 1/1024. Other stars and polygons bake and round as before.
3. **Export writes `sodipodi:cx`, `cy`, `r1`, `r2`, `arg1` and `arg2` at full precision**, not through the 3-decimal `formatNumber`, so Inkscape seeds from the values Kalamo drew with. `d` stays at 3 decimals; Inkscape rebuilds it from the parameters on load anyway.

`node_transform` composes into `transform` (ADR-0007), so moving a randomized star keeps its jitter. `node_update` of `cx` or `cy` moves the seed points and re-rolls it, as moving a randomized star in Inkscape with its default optimized transforms does.

## Known ceiling

On a star that is both twisted and rounded, Inkscape's handle directions differ from `t_i` by an angle proportional to `r1` (about 2.6 × 10⁻⁴ rad at `r1 = 80`) and independent of `cx`, `cy` and `rounded`. It is under a pixel at any radius a page holds, so it is left unmodelled; `shapeSegments` marks it. Model it if a round-trip pixel check ever fails on it.

## Import

`STAR_AS_PATH` now only covers a `sodipodi:type="star"` whose parameters are invalid (sides outside 3…1000, a non-finite value, a negative radius, `rounded` or `randomized` outside −10…10, or a randomized flatsided star whose `r2` exceeds `r1`, since Inkscape jitters it by `r2` and a polygon keeps no `r2`): it imports as the Path its `d` draws. `twist` is read as `(arg2 − arg1 − π/sides)` in degrees, normalised to −180…180; a polygon's `arg2` is ignored.

## Considered Options

- **Keep rotation in `transform`, add only the three parameters.** Loses Inkscape's jitter on every turned randomized star, rule 1.
- **Store Inkscape's seed, or the jittered vertices.** Either would survive baking, but Inkscape does not read them: it re-derives the seed from the parameters on load, so the file would open as a different star.
- **Illustrator's names and rounding** (corner radius with circular arcs). Inkscape could not rebuild the shape from them, and the round trip would turn every such shape into a Path.

## Consequences

- Schema: polygon and star gain `angle`, `rounded` and `randomized`; star gains `twist`. Existing Documents read them as 0, which draws what they drew: a `.kalamo.json` through the schema defaults, a Node already stored in a Document where it is drawn and exported, without rewriting storage, so its `node_get` shows the fields after its next write.
- An imported turned star or polygon now has its turn in `angle` and an identity `transform`, where it had a rotation matrix. A Document exported before this change and replaced after reports `transform` and `angle` changed on such Nodes once.
- ADR-0017's star rows are amended: `arg1` carries `angle`, `arg2` carries `twist`, `rounded` and `randomized` are written as set, and the parameters are at full precision.
