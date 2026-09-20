# Aurora -- Design Document

A WebXR snowy mountainscape for **Meta Quest 2**. Procedurally generated, N64-era low-poly with baked lighting, explored on foot at walking pace, with the Northern Lights playing overhead at night.

**This file is the index. The design lives in `design/`.** Load the one or two files you need; do not load the folder.

## The four constraints that decide arguments

1. **Quest 2 is the only device this document plans for.** It is the budget target and the measurement target, and there is deliberately no second column: designing against the generous headset is how you ship something that only runs on the generous headset. A quality tier for stronger hardware is a **user-facing setting** and belongs in `src/budget.js` as a multiplier on these numbers, not as a parallel plan.
2. **~350k triangles per frame**, derived rather than measured on target -- see `design/00-spike-and-budget.md` for what the ~800k ceiling was measured on and why the target number is half of it. Terrain ships at `LOD.triDeg` 5.72 deg.
3. **The sim layer imports no three.js.** `src/sim/*` and `src/clock.js` run in node, which is the only reason `npm run check` can gate them headlessly.
4. **Nothing counts as done until a gate script asserts it**, and a gate that cannot fail is not a gate. See `design/lessons.md`.

## Status

Build steps 1-4 are code-complete and gated (`npm run check`); the runtime half of the asset pipeline is the open work. Current step board and what is left: `design/14-build-order.md`. Per-area follow-up checklists live in `TASKS.md`, not here.

## Where things are

Source comments across the tree cite `DESIGN.md §N`. **Filenames carry the section number, so §N resolves to `design/NN-*.md`.**

| § | File | What it decides |
|---|---|---|
| 0 | `design/00-spike-and-budget.md` | `WEBGL_multi_draw`, `BatchedMesh` batching, the measured ceiling, the frame budget |
| 1 | `design/01-platform.md` | Target device and stack |
| 2 | `design/02-world-and-hydrology.md` | World size, grid resolutions, Phase A as built (flood, flow, breach, biomes, villages) |
| 3 | `design/03-terrain-character.md` | Noise construction, scale, `SHRINK`, creases, the slope ladder |
| 4 | `design/04-traversability.md` | No traps by construction; the walkability limiter |
| 5 | `design/05-rendering.md` | Quadtree LOD, `LOD.triDeg`, the triangle budget table, prop LOD ladder, why a `BatchedMesh` buys nothing on Quest 2 |
| 6 | `design/06-placement.md` | Scatter density, jitter, biome rules |
| 7 | `design/07-terrain-material.md` | Ground shader, palette, speckle, snow line |
| 8 | `design/08-lighting.md` | Horizon maps, AO bake, day/night palette, night lighting and fog |
| 9 | `design/09-asset-pipeline.md` | Blender pipeline, decimation, baking, impostors, texture array, sourcing rules |
| 10 | `design/10-weather.md` | Weather as noise over the room's clock: cover and precip, what overcast does to the palette, the sky cloud layer inside the dome pass, the horizon that ends in the land's fog, summit wreaths as shaded cloud cards, the rain box, and the rain that goes quiet in snow |
| 11 | `design/11-water.md` | Lakes, rivers, water shader |
| 12 | `design/12-locomotion.md` | VR and desktop movement, comfort, survey tools |
| 13 | `design/13-aurora-and-sky.md` | Aurora shader, the 16-form catalogue, sky dome, stars |
| 14 | `design/14-build-order.md` | Ordered build plan and what is done |
| 15, 16 | `design/15-open-and-deferred.md` | Deferred decisions and open questions |
| 17 | `design/17-workflow.md` | Desktop-first, the gate scripts, the headset-gate protocol, the bench pages and how a route registers |
| 18 | `design/18-v2-world.md` | v2: imported heightmap, procedural detail to 10 cm, authored content layers (snow line, lakes, rivers, roads) |
| 19 | `design/19-buildings.md` | The Nordic building kit: its texture layers, the `Builder`, the plan grammar, LOD by re-generation |
| 20 | `design/20-vegetation-generators.md` | Trees and bushes: the four primitives, the triangle law, crown profile and height density, card foliage and its fold, the root crown, LOD by re-generation |
| 21 | `design/21-deadwood.md` | Snags and logs: one swept surface, the tier ladder and its budget, the broken rim, the analytic normal and its clamp, how a piece beds into the ground |
| 22 | `design/22-ground-litter.md` | Strewn small stones as one T20 pebble instanced inside 28 m: why geometry beat the stamped atlas, one geometry under seven dials, sunk along world Y, none on the paint's stone line and a quarter on snow, the wet second pass, density in stones per m² and its stride-scale octave, where each environment rate caps, half the stones the ground's own hue, the road's cobbles added over its pebbles on their own 30/42 m ladder, and the flat 20k pool |
| 23 | `design/23-rock-generator.md` | Procedural rocks: pure radial displacement, radial plane clipping for flat facets, the rock-relative tile, the four tiers, the six-face far hull and `ROCK_LOD_AT`, the support gain and `BOX_MARGIN` |
| 24 | `design/24-mushrooms.md` | Mushrooms: the two-knob cap family, parametric normals, colour in the sheets rather than the tint, the planar cap decal; and the anchor-driven scatter, its ordering contract and span-relative ladder |
| 25 | `design/25-rock-scatter.md` | The rock scatter: why six beds, the four environments and the relief test, per-rock LOD thresholds, `ROCK_FAR_LIFE`, the density derivations, `GROUND_CUE`, `anchorsInto` and its three approximations, the sampler-unit collision behind the blink |
| 27 | `design/27-creature-pipeline.md` | The creature pipeline: why Tripo over Meshy, why the 128px texture and not the polycount is the gate, the stages and what each costs, quad topology and what its surcharge buys, our own LOD decimator, the spend model, task ids written before the wait, the snowmen above the snow line that cower, watch and follow her |
| 28 | `design/28-tree-v9.md` | Solid trees, reconstructed then painted: why alpha and not triangles is the cost, ask for a picture of the mesh rather than of a tree, the mesh arrives untextured and its faces are painted with the world's tiling textures |
| 29 | `design/29-prop-pipeline.md` | Generated props (`/gen-prop`): §27's pipeline stopped at the LOD ladder and card cross, a prompt that asks for a gritty photorealistic specimen with a jagged outline seated on the floor, one mushroom per entry so the placer makes the clusters, a roster keyed on size and category rather than rig type, the shipper into `public/gen-props/` and the two scatters (§21's deadwood, the bones) that draw the result on the creatures' arc ladder plus a card rung, a standing prop's card spun in the shader and a lying one's crossed about its axis |
| 30 | `design/30-leafkin.md` | Leafkin and their villages: the entrance boulder as the `hollow` rock bed lying like every other giant, the mouth cut into its flat flank with its black polygon inside the ring and stones tucked either side, the portal test beside the slope limiter, the leafkin's roam-gather-startle-flee life on the snowmen puppet with two new human clips, the bundle through the hands' item pool, and the village as the first room: a valley built in memory in the overworld's format, every one its own off the seed of the mouth she came in by (the ground's noises, the clearing, the lake, the arc, the huts, the great hut and the river all rolled, a bad layout rolled again), the overworld's light on the same clock, the boulder she walked into turned inside out for a shell, fox and hare its only large animals, and no sky |
| 31 | `design/31-terrain-v3.md` | Terrain v3: the generated island as a new author of v2's coarse field, generated at boot in a worker and cached in IndexedDB, biomes as stored boundaries, lakes kept from the flood's bowls, rivers traced down the eroded grid; the step order and what each step's instrument measures |

Plus two files with no section number:

- **`design/lessons.md`** -- the failure modes this project keeps re-learning, each one counted. Read it before writing a check or diagnosing "it looks wrong". It is the highest-value-per-line file here.
- **`design/history/`** -- work that was built, measured and then reverted or retracted. **None of it is in the tree.** It is kept because the arguments still hold and re-deriving them costs more than reading them, and because it is what stops a round eight from re-running round four.
  - `aurora-rounds-4-6.md` -- twist/flame/12-form catalogue, the re-siting, the polar-graph shell
  - `night-fog.md` -- the retracted argument for heavy night fog
  - `terrain-tuning-log.md` -- the round-by-round terrain changelog from build step 2

## Conventions

Prose uses `--`, not em dashes, and does not hard-wrap inside a paragraph. These files hold **current truth**; chronology goes to `design/history/`. When a fact changes, rewrite the sentence that is now wrong rather than adding a note beside it.
