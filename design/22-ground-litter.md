# 22 -- Ground litter

Strewn small stones on the /v2 route, drawn as small stones: one closed twenty-triangle pebble, bedded into the ground tens of thousands of times inside a few strides of the player. Scatter: `src/v2/render/litter.js`. Gate: `scripts/check-litter.mjs`.

## Why it is geometry, and why it was not before

The rock scatter's `underfoot` bed put a modelled pebble on the ground every 1.7 m across every wood and cliffside, at about 11 cm across -- forty-one specks for every rock big enough to read as a rock. What killed it was never the triangles. A `BatchedMesh` instance costs the same whether it is a four-face pebble or a seven-metre lip; the bed ran a three-tier ladder plus a card band for stones that are invisible past 15 m; and its reach was 120 m, so nearly the whole prop budget went on placement work for things smaller than a boot that nobody could see.

The answer in between was a texture: four baked top-down photographs of pebbles stamped flat on the hill as alpha-tested 1.6-2.2 m quads. It was cheap and it looked like what it was -- an obvious square, repeated, floating on any ground that curved inside its own width -- and on a tiled GPU the alpha test cost more than its two triangles suggested, since `discard` in the fragment program disables early depth rejection for every quad underfoot.

So the stones are stones again, with the three costs that sank `underfoot` removed rather than paid: **no ladder** (T20 at every range it is drawn at, because a 15 cm stone reaches the boulder ladder's own "25 m per metre of rock" crossover at under 4 m), **no card**, and **a 28 m reach** thinned from 8 instead of 120 m. A pebble is opaque geometry through the ordinary prop material with `FrontSide` culling, so it costs the depth buffer a write and nothing else. The panel's `litter` row shows the drawn pebble count times twenty, which IS the layer's cost; there is no per-instance work hidden behind it.

## The smallest cut of the standard scatter

Same machine as its siblings, deliberately reduced: one `InstancedArena` over a single `InstancedMesh`, one material, a tiled camera-following scatter keyed on `tileSeed`, graded thinning by per-candidate rank, rank-based incremental regrow, and the rim dissolve -- all argued in `render/trees.js`'s header. What it does NOT have is the usual bulk: no variant bank, no tier ladder, no LOD bands, no promote/demote loop. A pebble is born at its only tier and stays there until evicted.

**One geometry, seven dials.** The arena holds exactly one geometry, so variety is the instance matrix's and the instance colour's: a continuous yaw; a size from 6 to 30 cm skewed small by `u²` (loose stone is mostly grit with a few stones in it, and a uniform roll reads as a hatch of same-sized dots); a stretch of 0.75-1.25 on the pebble's long axis with its complement on the other, so the plan runs from round to twice as long as wide at constant area; a flatness of 0.55-1.1 on the height, so the same stone is a domed cobble or a chip; a burial of 30-55% of its height; a tint off the rock bank's own palette; and a coin for whether it wears that tint or the ground's own colour. At this size a stone IS its silhouette, and one blob under those dials is as many silhouettes as a bank of fifteen would be.

**The LOD question was asked and declined.** A 3-triangle folded pentagon for an 8-16 m ring would save at most ~15k triangles on a full disc while adding a second tier, a promote/demote loop and a cross-dissolve where instances change geometry -- the "ghost swap" `ferns.js` runs. The whole layer is a few tens of thousands of triangles; the number to watch is instances, and a second tier does not reduce those by one. If the `litter` row ever says otherwise, the ferns ring pattern is the follow-up.

## Sunk, not lifted

The pebble is a closed solid bedded a third to a half of its height into the DRAWN ground. Three things follow. The half of it under the surface is back-face culled, so the burial costs nothing; the ground's cut through it hides the twenty facets' outline, which is what stops a T20 blob photographing as a gem; and it has no rim to show on any slope, so the plane-on-a-hill problem the stamps had (a 2.2 m quad whose corner rode 14 cm off ground that curved by 5 degrees) does not exist. The old 5 cm lift and its z-fight jitter are gone with it: two overlapping solids at different burials are just two stones.

**The sink is along world Y**, and `_reground` -- the sweep that re-seats a sixteenth of the resident tiles per frame as terrain chunks re-split beneath them -- rewrites only the matrix's Y. The two agree by construction. Sinking along the normal would need the reground to recompose the whole matrix, for an error of three centimetres times (1 - cos 34°) on the steepest ground admitted.

The tilt is FULL alignment to the field normal, unlike every rock bed's partial lean: a boulder tipped all the way in looks placed, but a pebble has no "proud" to read at its size, and one not flat on a slope shows more downhill flank than its own height -- a stone about to roll. Off the field rather than the drawn mesh, so a chunk LOD change under it does not rock it.

**No stone on a face, and the face is the paint's.** `MAX_SLOPE_DEG` 34 is the terrain's own stone line: `shade()` starts painting a hillside as bare rock at ny 0.86 (31°), and at 34° the ground is still under 5% stone, so litter lies only where the ground is drawn as ground. Tested at two scales, because the paint is classified over a metre (`CLASS_EPS`) and the heightmap's slope out of `scatterAt` is coarser: the coarse test is in hand already and throws away the obvious faces cheaply, then the same 1.2 m normal the pebble is tilted by is asked too, so ground that averages walkable over the heightmap's cell and stands up over a metre gets no stone. The stone that belongs at the foot of a face is the rock scatter's scree bed.

## Taking the ground's colour

The same construction `rocks.js` uses, one step further: a tint off `ENV_TINTS[env]` with `lichen` filtered out (the one entry that says "this boulder has not moved in a century", which loose stone by definition has), pulled toward the mesher's own `shade` at that point at `GROUND_CUE` 0.6-0.8 by environment, against the boulders' 0.45-0.75. A boulder is an object sitting ON the ground and keeps its own stone colour; litter IS the ground and takes most of it. Neither reaches 1, so the stones stay findable. A ±20% tone jitter sits on top, wider than a boulder's, because at this size there is no texture detail to tell two neighbours apart and the tone is most of what does.

**And half of them are the ground's hue at a stone's brightness.** Each pebble rolls a coin (`GROUND_SHARE` 0.5): the palette half is the paragraph above; the ground half is that same stone's luminance (Rec. 709) carrying `shade`'s chromaticity at that point instead of its own, so its hue is exactly the ground's and it is found by its tone and its shading alone. Luminance is the split, not a lerp, because the two live at different brightnesses: the ground's own colour sits near 0.2 and a lit stone near 0.5, so a pebble that took the ground's colour whole was a black speck on it, and a lerp toward it desaturates before it darkens. A wood floor's litter is then half stone-coloured stone and half the greens and browns it lies in, which is what a handful of ground looks like, and each half is what stops the other from reading as a pattern. The gate measures the ground half's chromaticity against `shade` at its own point and expects zero, and holds its median luma to the tint half's within 5%.

Because the pebble samples `LAYER.ROCK`, which is in the snow layer list, it takes the shader's own snow on its crown for free -- the stamps' atlas layers were deliberately kept out of that list because a second snow line on a flat picture fought the terrain's. The ground cue carries the rest: on a snowfield the terrain colour is near white, so the stones land at a stone's worth below it rather than as wet coal.

## Density is stones per square metre, never a ratio

The figure that matters is the one AFTER the rejections. `DENSITY` 3.4 candidates/m² becomes, on the gate's stubs inside the 8 m full-density radius:

| Ground | stones / m² |
|---|---|
| Wood | 0.97 |
| Bare peak | 1.14 |
| Snowfield | 0.24 x the bare peak |
| Shore | 1.24 |
| Lake bed | 1.95 |
| Sine ridge (whole disc) | 0.13 x the wood |

The drift floor throws away a measured 32% of candidates before anything else looks, `ENV_DENSITY` and the fine swing throw away a quarter of the rest in a wood, and the ridge's steep stretches refuse nearly all of what reaches them (its walkable ground begins 18 m out, in the thinned tail). A stone every metre reads as "there are stones about" rather than "the ground is paved"; the gate holds 0.6-2.0 on the walked grounds.

**Snow keeps a quarter.** The accept rate is cut by `SNOW_KEEP` 0.25 ramped on the same cover term `shade()` paints the snow with, the smoothstep across the band about the snow line (its slope term is ~0 on any ground the slope test admits). Stone under snow is under snow: a quarter says the field is not a sheet, and the shader's own snow cap on every crown carries the rest. The gate's snowfield reads 0.24x its bare peak -- a shade under the constant because the bare peak's rate saturates at the top of the drift and the snowed one never does.

Past 8 m the keep-fraction falls as `FULL_RADIUS / d`, quantised to quarter-octave steps and taken from a tile's NEAREST corner -- and with an 8 m tile under an 8 m full radius, every tile of the 3x3 block around the camera has a corner inside the disc, so full density is in practice a 24 m square. That is why the gate's wood holds 2054 stones resident against 194 inside the disc: the block is nine discs' worth and the tail to 28 m, where a stone is a few pixels and the rim dissolve takes the last of them, adds only the rest. Full density is not the draw radius because a 15 cm stone at 8 m is still twenty pixels on a desktop, and a ring of them arriving at that range would be the most visible thing in the layer.

## The riverbed costs a second pass

A riverbed and a lake floor are where loose stone collects and stays, so the bed should carry the most of it. Making it the most is not turning a number up, which is why `_growTile` has two candidate loops. `ENV_DENSITY` is an accept RATE (`rocks.js`'s `BEDS` argues this at length): `river` is saturated, so every candidate offered on shingle is already taken and no multiplier produces another. The only lever left is how many candidates are OFFERED, and candidates are per-pass. **The wet pass is that bed**: `WET_DENSITY` 2.0 more candidates per square metre out of a SEPARATE random stream, everything not under water thrown away, survivors through the identical drift, slope and rate tests. The two passes differ in exactly two things -- how many candidates they offer, and whether they demand water.

**A separate stream is why this was affordable.** The dry pass's draw order is the most fragile line in the file: every candidate draws the same randoms whether or not it survives (`_draw`, shared by both passes), so one extra draw reshuffles every pebble in the world. The wet pass draws from `tileSeed` slot 1 where the dry pass draws from slot 0, so not one dry candidate moves. It costs a second loop over ground that is nearly all dry, bought back by testing water FIRST -- `WaterSurfaces.levelAt` is an AABB reject and a bucket scan, returning null on dry land long before anything pays the terrain sample. The gate's lake bed reads 1.95 stones/m² against the shore's 1.24.

## `ENV_DENSITY`: where each rate caps

- **`river` 0.9 is saturated on purpose, and the only one allowed to be.** Every candidate reaching the test has cleared `CLUMP_FLOOR`, so with the fine swing at its mean the rate it faces is at least `0.9 * (1 + 0.55 * 0.34) = 1.068`: the coarse drift refuses nothing on shingle and `CLUMP_GAIN` is inert there; only the fine swing's low half thins it. River shingle IS where loose stone collects, and the drift still carves swept lanes because the FLOOR still bites. Buying the in-drift gradation back means dropping `river` under 0.842, below the peak, giving up the thing the entry exists to say.
- **`forest` 0.6** tops out at 0.930 and is never capped, so the gain is live across its whole range.
- **`peak` 0.75** reaches 1.0 at clump 0.606, so the gain is live over the lower two thirds of the drift and inert above.
- **`cliff` 0 is also unreachable**, two different facts and both wanted. `_envAt` only says `cliff` past `CLIFF_TAN` (42°) and `MAX_SLOPE_DEG` refuses past 34, so no candidate can arrive carrying that name. The entry is kept at zero for what happens if someone raises `MAX_SLOPE_DEG`: the branch would come alive, and a plausible-looking 0.22 here would quietly bed pebbles into a vertical face.

The drift lattice (`CLUMP_CELL` 12 m) is coarser than the 8 m tile, which is a constraint and not a taste: a lattice finer than the tile lines the drifts up with the tile grid. It is 12 rather than the stamps' 21 because the whole layer now lives inside 28 m and a drift has to be crossable in a few strides to be seen as one.

**A second octave at the stride scale.** The coarse field says where the drifts are; `FINE_CELL` 3 m, the same value noise in its own hash slot, says that inside a drift the stone still gathers and thins from one stride to the next, which is the scale the eye reads standing still. It is a GAIN and not a floor: it swings the accept rate between 1 ∓ `FINE_SWING` 0.7 about a mean of 1, so it moves density both ways and, where the rate is unsaturated, leaves the count alone on average; only the coarse floor carves bare ground. The gate bins the wood into 3 m cells and reads a standard deviation 2.6x what a Poisson sprinkle at the same mean would have (band 1.3-3). On shingle the top of the swing is eaten by saturation and the bottom is not, so shingle is the one ground it thins more than it thickens -- and the one place the `river` rate now refuses anything at all, a third of what the wood does.

## Measuring it

The `litter` toggle on the panel hides and freezes litter, mushrooms and dead wood together, so it cannot attribute a frame cost to this layer alone. `window.v2litter` is exposed for that: `v2litter.batch.visible = false` in the console hides the pebbles and nothing else, against `v2mushrooms` and `v2deadwood` for the other two.
