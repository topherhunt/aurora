# §35 -- Roads, names, bridges and signposts

The overworld's towns (§32) are joined by one web of winding dirt roads, planned at boot from the heightmap, the layers, the towns and SEED, so every client lays the same ones and nothing is saved. There are no hand-drawn overworld roads: `public/world/layers.json` carries `"roads": []`. Where a road crosses a river it stops on each bank and the shipped stone bridge (§34) joins the two tips. Where roads fork, a signpost on a cairn names the nearest towns.

## The files

| piece | where |
|---|---|
| names (three-free) | `src/v2/layers/names.js` `nameTowns` |
| network, bridges' and signs' placement (three-free) | `src/v2/layers/roads.js` `planRoads`, `ROAD`, `STONE_BRIDGE` |
| bridge meshes and walk layer | `src/v2/render/bridges.js` `Bridges`, `BRIDGE_BANDS` |
| signposts | `src/v2/render/signposts.js` `Signposts`, `SIGN` |
| boot | `main.js`, after the towns' `addGenerated` (overworld only); `window.v2roads`; the debug row "road network lines" (`buildRoadLines`: every way and bridge, each used stub carried on to a dot at its town's centre) |
| gate | `scripts/check-roads.mjs`; the map: `tmp/roads/probe1.mjs`; near misses and density: `tmp/roads/even.mjs`; a close-up: `tmp/roads/zoom.mjs`; eyes: `tmp/roads/shot.mjs` |

## Names

Each town gets one Nordic compound, prefix plus suffix, unique across the map. `features` lists what the town stands near, strongest first: the sea or a lake within 300 m, a river within 300 m, the snow line, a cliff (slope over 1.2) within 180 m, a valley (35 m under the 400 m ring), and always `plain` last. The suffix names the strongest (Selvik, Gråhammar, Djupdal), and the prefix comes from another of the town's features half the time, else from the plain pool. A name already taken, or one whose halves repeat (Steinstein), is rolled again, widening to any feature after 20 tries.

## The network

1. **Grid.** An 8 m cost grid over the raw heightmap. It is blocked on lakes (plus a cell), on each river out to its drawn bank plus `riverPad`, inside town discs, and on the mirror band past `TOWN.realZ`. The cost per metre rises with slope, `(1 + (grade / 0.07)²)`, and falls in valleys: a summed-area table compares each cell to the 200 m mean around it.
2. **Crossings.** Every 12 m along each river, a straight square crossing is tried. It is kept where both tips stand at least `bank` over the water, the approach from each tip to its end node is no steeper than 0.3, and the bridge's scale stays within ±30% (below). Each kept crossing is a jump edge in the search, costing its length plus `penalty` (150) the first time, so a road crosses only when going round costs more, and a second road reuses a bridge for free.
3. **Pairs.** Each town's `near.k` (4) nearest within `near.r` (2 km), plus the relative-neighbourhood pairs that hold the web together, are tried shortest first. Distance over the web counts a town's streets (port to centre to port), so a road through a town is a way on. A pair already joined within `detour` (1.6x) its straight distance is skipped. Otherwise an A* runs from one town's stub ports to the other's, with road already laid costing 0.45x, so roads merge and fork rather than run side by side. If that route walks past `direct.over` (2x) the straight distance, or no shorter than the web's way round, it is raced by a direct search: grade costed at 0.14 instead of 0.07, no valley pull, and laid road at 0.8x. The shorter walk wins. The route is laid if it saves at least `gain` (25%) over the way round. Laying a route splits any road it meets into a fork node.
4. **Unused stubs.** A stub no pair used runs to another town or to the web more than 200 m past its own town.
5. **Links.** Every `link.step` (12) cells along each way, the most a link could save is bounded: road cells `min` (80) to `reach` (900) m away, more than `detour` (2x) and `save` (500 m) further round by road, the straight distance standing in for the walk. The points are tried biggest saving first from a lazy heap: laying roads only shortens the way round, so a stale bound is an overestimate and is pushed back when it has fallen below the next. A try is a direct-costed search capped at `budget` (2) × `reach` of cost, and lays the cheapest candidate whose walk still meets the three limits. It never splits a way within 4 cells of its end, where the stub left could not ease between its ends' heights. Road cells sit in 16-cell bins so the bound walks only nearby road.
6. **Pruning.** A way whose ends are joined within `prune` (1.3x) its length without it is taken up, most redundant first, so no road runs beside another. Ways holding a bridge, a bank or a town's only road stay. A fork left with one way is a dead end and goes; one left with two joins them into one way.
7. **Geometry.** Each way's cell path is smoothed, resampled to 12 m and given a meander of two seeded sine bands (48-104 m and 120-256 m wavelengths, amplitude capped at 6 m and 14.4 m), enveloped to zero over 30 m at each pinned end and refused where it would enter water or climb. A fork takes the ground's height, then gives way until no road from it averages steeper than 0.8 `maxGrade`. Otherwise two pinned forks joined by a short way could stand too far apart in height for any relax to flatten. Ports and banks hold. Heights along a way come from the live surface, smoothed along the arc (σ 12 m) and relaxed until no segment climbs more than 0.18. Each way is a `road<n>` record at half-width 2.

## Bridges

A crossing's bridge is the shipped mesh placed as §34 says. Its origin sits on the centre line at the water, and local +x runs along the road. The scale is:
- x: the river's drawn width over 14, floored at 0.7;
- y: the mean tip height over the water, divided by 3 and clamped to 0.7..1.3;
- z: the road width over 3.2.

Each tip sits 8.5·sx from the centre. A straight approach record (feather 1) from the bank node to the tip cuts or fills the bank to the bridge's end height, `level + 3·sy`, so the deck and the road meet. `Bridges` swaps the three LODs at 70 / 260 m, hides a bridge past 1500 m, and lifts the drawn mesh with its river's far-terrain raise (`WaterSurfaces.riverLiftAt`) so the water never swallows it from the air. It is a walk stone layer at the true height: the deck is a level floor, and the parapets are stone to their top.

## Signposts

Every node where three or more ways meet gets a signpost. A town's stub counts as one of the ways, and bank nodes are skipped. Its boards name 3-5 towns by road distance, starting with the nearest town down each way, then the nearest overall, then sorted nearest first. Each board is an arrow turned to the way it names. The post stands 3.4 m off the fork, in the widest gap between the ways, at the end of a half-width 1.5 m spur record. The spur keeps the verge's crowded trees (trees.js `ROAD`) off the cairn. A way still longer than 500 m gets evenly spaced waymarks, so no stretch between signs exceeds 500 m. A waymark is the same post on alternate verges, naming the nearest town each way and then the nearest by road from either end. Names are drawn once to a canvas atlas, dark brown on planked wood, and read from both faces. A post is built when the eye is within 60 m of its foot (3D, so not from the air) and dropped past 70 m.

## Numbers on the shipped map

Planning takes about 2.2 s (the gate allows 2.5 s; the link pass is about 1.2 s of it, and `budget` 1.5 saves 0.4 s at 4 more 500 m near misses). The map gets 271 ways, 107.2 km of road, 142 forks between towns (19 within 60 m of another), 260 signposts (96 of them waymarks) and 1 bridge out of 53 candidate crossings. The worst segment grade is 0.23, and no road point stands in water. A town reaches its 4 nearest within 2 km at a median of 1.84x their distance apart by road; 36% of those pairs are past 2x, mostly where cliffs or 1.5-2 slopes forbid the straight way (town8 to town34: 520 m apart across a 70 m drop). 61 of 63 towns share one web:
- town2 sits on a mesa ringed by ground steeper than `steep` (0.28) on every side;
- town3 is on an island.

Two further stubs, town21's and town27's second, find nothing within 1.5 km.

Three spots are left where roads pass within 300 m but are over 4x and 1 km apart by road (the gate allows 5), all across cliffs of grade 1.3-3.3: (-1949, -1532), (-3415, -576) and (-2362, 751).

## Open

- Only one bridge: the shipped rivers are short (0.2-2.2 km), and most crossings fail the ±30% scale or the bank test. More bridges want longer rivers or a second shipped span.
- The bridge's post lights and flames (`meta.lights`) are not lit.
- town2 would need a switchback stair up its mesa.
- Whether the roads read as following the valleys is judged from the map, not gated.
- The south-east highland holds no towns, so a ring of road about 5 km across circles it with nothing inside for a 900 m link to reach. Links of up to 2 km (at `detour` 3) still leave it empty and cost 5.2 s to plan.
