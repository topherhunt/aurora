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
| 5 | `design/05-rendering.md` | Quadtree LOD, `LOD.triDeg`, the triangle budget table, prop LOD ladder |
| 6 | `design/06-placement.md` | Scatter density, jitter, biome rules |
| 7 | `design/07-terrain-material.md` | Ground shader, palette, speckle, snow line |
| 8 | `design/08-lighting.md` | Horizon maps, AO bake, day/night palette, night lighting and fog |
| 9 | `design/09-asset-pipeline.md` | Blender pipeline, decimation, baking, impostors, texture array, sourcing rules |
| 10 | `design/10-weather.md` | Snow, rain, mist (intent only, not built) |
| 11 | `design/11-water.md` | Lakes, rivers, water shader |
| 12 | `design/12-locomotion.md` | VR and desktop movement, comfort, survey tools |
| 13 | `design/13-aurora-and-sky.md` | Aurora shader, the 16-form catalogue, sky dome, stars |
| 14 | `design/14-build-order.md` | Ordered build plan and what is done |
| 15, 16 | `design/15-open-and-deferred.md` | Deferred decisions and open questions |
| 17 | `design/17-workflow.md` | Desktop-first, the gate scripts, the headset-gate protocol |
| 18 | `design/18-v2-world.md` | v2: imported heightmap, procedural detail to 10 cm, authored content layers (snow line, lakes, rivers, roads) |
| 19 | `design/19-buildings.md` | The Nordic building kit: its texture layers, the `Builder`, the plan grammar, LOD by re-generation |

Plus two files with no section number:

- **`design/lessons.md`** -- the failure modes this project keeps re-learning, each one counted. Read it before writing a check or diagnosing "it looks wrong". It is the highest-value-per-line file here.
- **`design/history/`** -- work that was built, measured and then reverted or retracted. **None of it is in the tree.** It is kept because the arguments still hold and re-deriving them costs more than reading them, and because it is what stops a round eight from re-running round four.
  - `aurora-rounds-4-6.md` -- twist/flame/12-form catalogue, the re-siting, the polar-graph shell
  - `night-fog.md` -- the retracted argument for heavy night fog
  - `terrain-tuning-log.md` -- the round-by-round terrain changelog from build step 2

## Conventions

Prose uses `--`, not em dashes, and does not hard-wrap inside a paragraph. These files hold **current truth**; chronology goes to `design/history/`. When a fact changes, rewrite the sentence that is now wrong rather than adding a note beside it.
