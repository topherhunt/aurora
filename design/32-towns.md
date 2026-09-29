# §32 -- Towns

The overworld has human towns: 8 to 25 of §19's buildings round a dirt clearing in a gently sloping valley, each door on a path, and one or two roads running out to the edge of town. A campfire and stools sit in the clearing, and townsfolk walk the ways between them. Towns are generated at boot from the heightmap, the layers and SEED, so every client plans the same ones and nothing is saved.

## The files

| piece | where |
|---|---|
| siting and layout (three-free) | `src/v2/layers/towns.js` `planTowns`, `TOWN` |
| drawing, walk colliders, tree exclusion | `src/v2/render/towns.js` `Towns`, `TOWN_BANDS` |
| generated roads in the document | `doc.js` `GENERATED_ID`, `serialize({ authored })`; `layers.js` `addGenerated` |
| boot | `main.js`, straight after `height.setLayers(layers)` (overworld only) |
| hearth and townsfolk | `src/v2/render/townsfolk.js` `Townsfolk`, `TownLife`, `townGraph`, `TOWNSFOLK`; `hearth.js` (`scale`) |
| gate | `scripts/check-towns.mjs`; eyes: `tmp/townshot-drive.mjs`, `tmp/folkshot-drive.mjs` |

## Siting

A 40 m grid scan keeps points that are dry, under a 0.2 slope underfoot, 150 m from the spawn, even (rise under 12 m across a 50 m disc), and with a 45 m disc clear of water, rivers and authored roads. The score adds water within 220 m (1.5x, tapering with distance), a cliff within 180 m (slope ramping 1.2 to 2.4), half the valley depth against the 400 m ring, and subtracts unevenness. Selection takes each 1 km tile's best, keeping one above the snow line with chance 0.35, then fills from the best remaining sites below the snow up to 64. All towns stay at least 512 m apart. A layout with fewer than 8 buildings is dropped. The shipped map gets 63 towns: 2 above the snow, 15 by water, 40 under a cliff. Water caps the count, because only about 13% of flat sites have it within 220 m.

## Layout

- **Clearing** r = 5 m: two ring roads, 3 m wide at 1.5 and 4 m, just room for the hearth and a walk round it.
- **Roads**, 1 or 2, 2 m wide. They aim at the nearest other towns, at least 60° apart, and grow in 6 m steps, meandering on two sine waves (40-180 m wavelengths, up to 8 m off line). A road stops at water, at a grade over 22% or near an authored road. A road that stalls tries swinging ±20/40/60°. At the end each road is trimmed to just past the outermost building, ready to be joined into a network between towns.
- **Buildings** are placed in prestige order: inns, then longhouses, cottages and huts. Walls and roofs are picked by prestige, so slate and pantile sit near the centre and thatch at the edge. Each building takes the best of 90 random tries, preferring the nearest radius. Its yaw faces the nearest point on the network (the clearing's edge, a road, or an earlier path). The gap between boxes grows with radius, so the centre is dense and the edge is loose. A try is rejected on overlap, a road or path through it, a door path over 30 m or crossing another building, wet ground, a footprint that rises more than 2 m, or a door so far below the floor that it needs more than 4 steps.
- **Paths**, 0.8 m wide and at most 24 m, wind (two sine waves of 8-36 m wavelength, pinned at both ends) from 0.3 m in front of the door's face to the nearest network point, which is often an earlier house's path rather than the clearing. A try's rank adds 1.5 per metre of path to its radius, so a door beside an existing path beats one nearer the centre, and the ways branch instead of spoking out from the hub.

## Everything on the ground is a road

Clearing rings, door paths and roads are all road records with `town\d` ids. PathSet therefore flattens the ground under them, paints them dirt, cobbles them (litter) and keeps grass, ferns and rocks off them, with no terrain code of its own. PathSet ranks a road by its signed gap past the kerb, not by its centreline, so a narrow door path beside a wide road still wins where it is nearer; `out.dist` is still the centreline distance.

Buildings get no pad: they stand on the live, unflattened field (`surface`, which includes the fractal detail that is up to 1 m off the raw heightmap). The chosen seat is resampled on a 1 m grid, with the clearing ring's feather blended in. The floor sits at the highest sample, the plinth reaches 0.6 m below the lowest, and the door steps drop to the door's ground, with 4 treads reserved in front of the box. Rocks keep off buildings through `keepOut` (`townsOccupyAt`).

Generated roads ride every document the workers, the editor and the undo stack see. `serialize({ authored: true })` drops them for saves, because boot regenerates them and a saved copy would stack a second one underneath. So **editing a town road in the editor does not persist**.

## Drawing

Quest 2 has no multiview, so every draw call is paid twice. Towns use one merged mesh per nearby town and one shared instanced mesh for all distant buildings. A town swaps tier whole, by the distance to its edge (centre distance less `radius`, with 4 m hysteresis):

- **Near**: each town is one Mesh, detail 2 inside 60 m and detail 1 inside 140 m. Each tier's buildings are placed a few a frame within a 4 ms budget (detail 2: one building a frame across all towns), merged once when the last is placed, and cached on the town. Detail 1 starts within 300 m, detail 2 within 140 m; both are dropped past 420 m. A tier is shown only once merged; until then the town draws the tier below, or its far boxes. A swap only reassigns the mesh's geometry.
- **Far**: one `town-far` InstancedMesh with an instance per building mass. It is a 14-triangle box with a gable roof. `instanceColor` carries the roof tint (`ROOF_TINT`) and the instanced `aWallTint` the wall tint (`WALL_TINT`). A town at tier 0 within 1500 m shows its boxes. Each change repacks the shown instances (about 1500 at most) to the front and sets `count`, rewriting the matrix and colour buffers with no geometry rebuilt.

A standing town costs 2 draws per eye (its merged mesh, plus the far pool that every town shares). Detail 2 is 26-30k triangles for a 20-building town; placing it costs about 1.6 ms a building on desktop.

## Walking and trees

`Towns` is a walk stone: `columnAt` and `blockTopAt` give each building a solid span from the plinth to the roof surface. Trees ask `occupiesAt`, which covers each building's box plus 2 m; roads and paths keep trees off themselves. There is no town-wide clearing, so forest stands right up behind the houses. Wildlife passes `avoid` = `nearBuildingAt(x, z, 20)` and spawns nothing within 20 m of a building.

## Hearth and townsfolk

Each town's clearing holds a `Hearth` (§30's leafkin fire and stools) at `scale` 1.3, sized so the stool tops meet the mean seated underside of the human avatars. Every town draws one `hearthKit` built at boot on level ground (the clearing is flat to 5 mm under its ring roads), without the decimated tier: decimateHearth costs about 200 ms to save under 300 triangles. A hearth and its flame are hidden past 220 times their height, about 5 px. `hipSeat` measures that underside as the idle-sit hip joints less 0.05 of the body height. villagers.js `seatY` does not work here: its lowest hip-skinned vertex is the coat hem at the ground.

Townsfolk come from `farmer`, `shepherd` and `woodcutter`, dealt in turn, with 1 per hut or cottage and 2 per longhouse or inn. `townGraph` builds each town's ways as a graph: a 10-node ring at 4 m, the roads, and each door path attached where it meets the network. `TownLife` is a three-free, deterministic sim on the room clock. A town that wakes (within 250-330 m of its radius) replays its chapter from the start, `TOWNSFOLK.replay` (400) ticks a frame shared by the towns still catching up, so a full chapter takes up to 30 frames. Its people are not drawn until it is caught up. It reads heights only on the last two ticks. People leave home on errands (visit, home, sit at the fire, wander), keep right with a 0.2 m lane offset, chat when two meet (8-20 s, then a 45 s cooldown), and are all indoors by the chapter's turn.

The greeting is this client's alone. When she comes within 2 m of someone walking, standing or talking, half the time they carry on. Otherwise they stop, turn to her, and wave (0.12), beckon (0.08) or just look (0.8) for 2.5-4 s, so about one meeting in ten gets a gesture. They then walk straight back to where the sim has them at 1.5x pace. The cooldown is 20 s either way.

Every town's fire crackles through ambience.js's campfire rule, a loop per town placed at the clearing's centre whether or not the town is awake.

The pool is 4 puppets per body, so at most 12 townsfolk draws per eye, plus each live town's hearth mesh and flame. Each body's puppets go to its nearest 4 people who want one. A farther holder fades out to free its puppet.

## Open

- The tints are eyeballed from a couple of distant shots.
- Rocks, deadwood and litter keep off the town's roads but not its yards.
- Market stalls, fences and livestock. Townsfolk make no sound of their own, and they avoid each other only through the lane offset.
