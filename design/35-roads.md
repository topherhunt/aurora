# §35 -- Roads, names, bridges and signposts

The overworld's towns (§32) are joined by one web of winding dirt roads, planned at boot from the heightmap, the layers, the towns and SEED, so every client lays the same ones and nothing is saved. There are no hand-drawn overworld roads: `public/world/layers.json` carries `"roads": []`. Where a road crosses a river it stops on each bank and the shipped stone bridge (§34) joins the two tips. Where roads fork, a signpost on a cairn names the nearest towns.

## The files

| piece | where |
|---|---|
| names (three-free) | `src/v2/layers/names.js` `nameTowns` |
| network, bridges' and signs' placement (three-free) | `src/v2/layers/roads.js` `planRoads`, `ROAD`, `STONE_BRIDGE` |
| bridge meshes and walk layer | `src/v2/render/bridges.js` `Bridges`, `BRIDGE_BANDS` |
| signposts | `src/v2/render/signposts.js` `Signposts`, `SIGN` |
| boot | `main.js`, after the towns' `addGenerated` (overworld only); `window.v2roads` |
| gate | `scripts/check-roads.mjs`; the map: `tmp/roads/probe1.mjs`; eyes: `tmp/roads/shot.mjs` |

## Names

Each town gets one Nordic compound, prefix plus suffix, unique across the map. `features` lists what the town stands near, strongest first: the sea or a lake within 300 m, a river within 300 m, the snow line, a cliff (slope over 1.2) within 180 m, a valley (35 m under the 400 m ring), and always `plain` last. The suffix names the strongest (Selvik, Gråhammar, Djupdal), and the prefix comes from another of the town's features half the time, else from the plain pool. A name already taken, or one whose halves repeat (Steinstein), is rolled again, widening to any feature after 20 tries.

## The network

1. **Grid.** An 8 m cost grid over the raw heightmap. It is blocked on lakes (plus a cell), on each river out to its drawn bank plus `riverPad`, inside town discs, and on the mirror band past `TOWN.realZ`. The cost per metre rises with slope, `(1 + (grade / 0.07)²)`, and falls in valleys: a summed-area table compares each cell to the 200 m mean around it.
2. **Crossings.** Every 12 m along each river, a straight square crossing is tried. It is kept where both tips stand at least `bank` over the water, the approach from each tip to its end node is no steeper than 0.3, and the bridge's scale stays within ±30% (below). Each kept crossing is a jump edge in the search, costing its length plus `penalty` (150) the first time, so a road crosses only when going round costs more, and a second road reuses a bridge for free.
3. **Pairs.** Town pairs come from the relative neighbourhood graph, shortest first. A pair already joined by less than 1.5x its straight distance over the web is skipped. Otherwise an A* runs from one town's stub ports to the other's, with road already laid costing 0.45x, so roads merge and fork rather than run side by side. A found route is laid if the pair was not joined, or if it walks under 2.5x the straight distance. Laying a route splits any road it meets into a fork node.
4. **Unused stubs.** A stub no pair used runs to another town or to the web more than 200 m past its own town.
5. **Geometry.** Each way's cell path is smoothed, resampled to 12 m and given a meander of two seeded sine bands (60-130 m and 150-320 m wavelengths), enveloped to zero over 30 m at each pinned end and refused where it would enter water or climb. Heights come from the live surface, smoothed along the arc (σ 12 m) and relaxed until no segment climbs more than 0.18. Each way is a `road<n>` record at half-width 2.

## Bridges

A crossing's bridge is the shipped mesh placed as §34 says. Its origin sits on the centre line at the water, and local +x runs along the road. The scale is:
- x: the river's drawn width over 14, floored at 0.7;
- y: the mean tip height over the water, divided by 3 and clamped to 0.7..1.3;
- z: the road width over 3.2.

Each tip sits 8.5·sx from the centre. A straight approach record (feather 1) from the bank node to the tip cuts or fills the bank to the bridge's end height, `level + 3·sy`, so the deck and the road meet. `Bridges` swaps the three LODs at 70 / 260 m, hides a bridge past 3000 m, and is a walk stone layer: the deck is a level floor, and the parapets are stone to their top.

## Signposts

Every node where three or more ways meet gets a signpost. A town's stub counts as one of the ways, and bank nodes are skipped. Its boards name 3-5 towns by road distance, starting with the nearest town down each way, then the nearest overall, then sorted nearest first. Each board is an arrow turned to the way it names. The post stands 3.4 m off the fork, in the widest gap between the ways, at the end of a half-width 1.5 m spur record. The spur keeps the verge's crowded trees (trees.js `ROAD`) off the cairn. Names are drawn once to a canvas atlas, dark brown on planked wood, and read from both faces. A post is built within 250 m and dropped past 300 m.

## Numbers on the shipped map

Planning takes about 0.6 s. The map gets 185 ways, 90.9 km of road, 105 signposts and 1 bridge out of 53 candidate crossings. The worst segment grade is 0.22, and no road point stands in water. 61 of 63 towns share one web:
- town2 sits on a mesa ringed by ground steeper than `steep` (0.28) on every side;
- town3 is on an island.

Two further stubs, town21's and town27's second, find nothing within 1.5 km.

## Open

- Only one bridge: the shipped rivers are short (0.2-2.2 km), and most crossings fail the ±30% scale or the bank test. More bridges want longer rivers or a second shipped span.
- The bridge's post lights and flames (`meta.lights`) are not lit.
- town2 would need a switchback stair up its mesa.
- Whether the roads read as following the valleys is judged from the map, not gated.
