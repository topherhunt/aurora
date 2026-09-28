# §32 -- Towns

The overworld has human towns: 8 to 25 of §19's buildings round a dirt clearing in a flat valley, each door on a path, and one or two roads running out to the edge of town. Towns are generated at boot from the heightmap, the layers and SEED, so every client plans the same ones and nothing is saved.

## The files

| piece | where |
|---|---|
| siting and layout (three-free) | `src/v2/layers/towns.js` `planTowns`, `TOWN` |
| drawing, walk colliders, tree exclusion | `src/v2/render/towns.js` `Towns`, `TOWN_BANDS` |
| generated roads in the document | `doc.js` `GENERATED_ID`, `serialize({ authored })`; `layers.js` `addGenerated` |
| boot | `main.js`, straight after `height.setLayers(layers)` (overworld only) |
| gate | `scripts/check-towns.mjs`; eyes: `tmp/townshot-drive.mjs` |

## Siting

A 40 m grid scan keeps points that are dry, 60 m under the snow line, gentle underfoot, 150 m from the spawn, and flat: rise under 8 m over a 60 m disc (a 20 m grid plus a 24-sample rim ring, because the grid barely touches the rim where a valley's walls start). A point must also be a valley, with the 400 m ring on average 15 m above it, and have a 90 m disc clear of water, rivers and authored roads. Candidates are ranked by valley depth minus unevenness, then taken greedily at least 900 m apart. A layout with fewer than 8 buildings is dropped. On the shipped map that makes 12 towns.

## Layout

- **Clearing** r = 10 m, twice the leafkin clearing in metres (the leafkin room is at half scale, so it reads as four times hers). Kept for market stalls.
- **Roads**, 1 or 2, 4 m wide. They aim at the nearest other towns, at least 60° apart, and grow in 12 m steps. A road stops at water, at a grade over 22% or near an authored road. A road that stalls tries swinging ±20/40/60°. At the end each road is trimmed to just past the outermost building, ready to be joined into a network between towns.
- **Buildings** are placed in prestige order: inns, then longhouses, cottages and huts. Walls and roofs are picked by prestige, so slate and pantile sit near the centre and thatch at the edge. Each building takes the best of 90 random tries, preferring the nearest radius. Its yaw faces the nearest point on the network (the clearing's edge, a road, or an earlier path). The gap between boxes grows with radius, so the centre is dense and the edge is loose. A try is rejected on overlap, a road or path through it, a door path over 30 m or crossing another building, wet ground, or a footprint that rises more than 3 m.
- **Paths**, 1.6 m wide, run from 0.3 m in front of the door's face to the nearest network point.

## Everything on the ground is a road

Clearing rings, building pads, door paths and roads are all road records with `town\d` ids. PathSet therefore flattens the ground under them, paints them dirt and keeps grass, rocks and litter off them, with no terrain code of its own. A building's pad is a capsule along its long axis, sized for the 0.8 minimum SWELL so the corners stay on flat ground. The plinth reaches 0.3 m below the lowest corner sample.

Generated roads ride every document the workers, the editor and the undo stack see. `serialize({ authored: true })` drops them for saves, because boot regenerates them and a saved copy would stack a second one underneath. So **editing a town road in the editor does not persist**.

## Drawing

Quest 2 has no multiview, so every draw call is paid twice. Towns use one merged mesh per nearby town and one shared instanced mesh for all distant buildings:

- **Near** (under 140 m to a building, with 4 m hysteresis): each town is one merged Mesh, re-merged when a building changes tier. Detail 2 inside 60 m, detail 1 inside 140 m. Detail-1 geometry is prebuilt within 300 m and evicted past 420 m. Detail-2 builds are capped at one per frame, within a 4 ms budget.
- **Far**: one `town-far` InstancedMesh with an instance per building mass. It is a 14-triangle box with a gable roof. `instanceColor` carries the roof tint (`ROOF_TINT`) and the instanced `aWallTint` the wall tint (`WALL_TINT`). A building drawn near zeroes its instances' matrices.

A standing town costs 2 draws per eye (its merged mesh, plus the far pool that every town shares) and about 20k triangles at the centre.

## Walking and trees

`Towns` is a walk stone: `columnAt` and `blockTopAt` give each building a solid span from the plinth to the roof surface. Trees ask `occupiesAt`, which covers each town's meadow (a disc with three lobes, 70-100% of the town radius) and each building's box plus 2 m.

## Open

- The tints are eyeballed from a couple of distant shots.
- Rocks, deadwood and litter keep off the town's roads but not its yards.
- Market stalls, fences, livestock and townsfolk.
- Roads between towns.
