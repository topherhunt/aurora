# 39 -- Caves

Status: built, untested in a headset. Builds on the torch (§37 `uTorch`), the mushroom family (§24), the trust relay pattern (`server/src/main.js` `applyTrust`) and the hands' sources (`hands.js`, `taken.js`).

Cave mouths stand at the feet of cliffs. Walking a couple of metres into one fades her to black and moves her into the mouth's cave **system**: a pitch-dark labyrinth of tunnels, caverns, drops and flooded passages, in regions that each look their own, generated from the system's seed so every peer walks the same cave. Mouths within ~250 m may open onto the same system.

## 1. Pieces

| piece | job |
|---|---|
| `caves/sites.js` | sites the mouths on the overworld (`siteMouths`) and groups them into systems (`groupSystems`) |
| `layers/clefts.js` | the notch cut into the cliff foot at each mouth, and the keep-off for trees and rocks |
| `layers/trails.js` | the footpath from each mouth to the roads |
| `render/cave-mouths.js` | the leafkin arch at each mouth (an `Entrances` in fixed mode), and the walk-in test |
| `caves/graph.js` | the topology: nodes, passages, drops, sumps, rivers, pools, glows, regions |
| `caves/field.js` | the signed distance field the graph describes |
| `caves/props.js`, `caves/regions.js` | what stands in the cave, and each region's look |
| `caves/build.js` | `planCave`: graph, field, props, lights and the doors, from `{ seed, entries }` |
| `caves/mesh.js`, `caves/worker.js` | surface nets per 16 m chunk, in a worker, nearest chunks first |
| `caves/walk.js` | `CaveWalk`: the walk surface read off the field |
| `render/cave-room.js` | the system drawn: chunks, instanced props, water, fish and crabs, chalk |
| `caves/chalk.js`, `render/chalk.js` | chalk strokes: codec, store, pens, ribbons; the lumps as a hands source |
| `check-caves.mjs` | determinism, the no-trap proof on the built surface, sump flooding, triangle budget, chalk |

All of `caves/` is pure and node-runnable. main.js wires it (`--- caves` section): `siteCaves` groups the world plan's mouths at overworld build, `warmCave` starts the worker as she nears a mouth, `caveTest` runs the portal each step, `enterCave`/`leaveCave` swap the walk under the fade, `stepCave` runs the frame underground.

## 2. Mouths in the overworld

**Siting.** Candidates are scanned on the raw 8 m texels for level ground with a face rising at least `RISE_MIN` (11 m) two texels behind it, then refined against the walker's exact height so the hole's floor is the ground under her feet. Water, towns, the mirrored strip past `TOWN.realZ` and ground no trail reaches refuse a site. Siting runs in `planWorld` (layers/world-plan.js) after the roads and before the trails, whose records would move it, so the mouths ride the baked plan. Mouths keep `MOUTH_SPACING` (160 m) apart, at most `MOUTH_CAP` (160; the shipped world fills it, nearest neighbours a median 232 m apart). Pairs within `LINK_M` (250 m) join one system with odds `LINK_ODDS` (0.6), by union-find; LINK_M keeps the chains short, so a shipped system is at most 8 mouths and 418 m from its centre, inside chalk's ±655 m (check-caves holds it under 600 m; nothing in `groupSystems` caps it, so the number moves whenever the mouths renumber). A system is `{ id, seed, mouths, cellars, cx, cz }`; the seed is a uint32 and keys everything about it, chalk included.

**Cellars.** `siteCellars` gives `CELLAR_ODDS` (0.15) of town houses (never huts), `CELLAR_SPACING` (40 m) apart, a stair down into the cave in a screened corner of the house's ground floor (design/38 Cellar). `groupSystems` runs after the cliff union-find, so cliff systems keep their ids, seeds and centres. Each cellar then joins the nearest system whose centre is within `CELLAR_LINK_M` (250 m, inside chalk's ±655 m packing) on a `LINK_ODDS` coin, or founds a system of its own with no mouths. `caveEntries` orders a system's doors mouths first, then cellars, so door `i >= mouths.length` is a cellar. A cellar's passage ends at a wooden door, one or two torches set in its wall 5 to 20 m in, and leads back up into the house, at the stair's head. Chalk drawn in a cliff system before it gained a cellar no longer lines up, because the graph changed.

**The look.** The ground is a height field and cannot overhang, so a mouth is two parts, both sized off `MOUTH` (sites.js):

1. **An arch** (`CaveMouths`): the leafkin villages' stone entrance (`render/entrances.js`, the `cave-mouth` bank) at `MOUTH.scale` (2.2), 3.3 m tall and 4 m across, its black hole about 2.7 m wide. It runs as an `Entrances` in fixed mode, one site per mouth, so it has the same LOD rungs and ground shadow as a village's. Like a village's, it does not collide.
2. **A notch** (`CleftSet`): in the mouth's frame (s metres in past the foot, t across), a level floor at the mouth's y, cut or filled, `floorW` (3 m) either side and `floorOut` (4.5 m) out from a straight back wall `MOUTH.wall` (1 m) in. The wall rises 5 m half a metre behind that line, so the terrain's 0.5 m cells never climb in front of the hole, and feathers into the cliff behind. The arch stands against it. Clefts are made at boot like roads and never saved. Trees and rocks keep off the floor and a 6 m approach out in front of it (`occupiesAt`), so the arch shows from a way off.

**The trail** (`routeTrails`): one Dijkstra over the roads' 8 m grid, on the live surface, outward from every laid road cell at once, so each mouth follows it back to its cheapest road or onto a trail already laid (a quarter of them). It runs straight from half a metre short of the wall to 10 m out, level across the floor, then smoothed, resampled at 6 m and Gaussian-heighted like a road. It is a generated road record (`trail<k>`) half a road wide with a 3 m feather, so it paints dirt and keeps trees and rocks off like any road, but it is not a way: no signpost, no traveller, and no road cell within 24 m of a signpost seeds it, so no sign seems to point down it. A footpath steps up to 0.5 grade where a road stops at 0.28; the shipped trails run a median 263 m, at most 1.4 km, and pitch no steeper than 0.84 (check-caves).

**The portal.** With her feet within `MOUTH.reach` (0.8 m) of the hole's plane and `MOUTH.holeW` (1.2 m) of its axis, `caveTest` fades her under and boots her at the mouth's door inside, `ARRIVE_IN` (3.5 m) down the passage, facing in. Behind each mouth node the passage folds outward into a flare (`mouthFlare`, field.js), capped by a plane of sky that `CaveRoom.setDay` blends from night blue to white by the hour; its `DAYLIGHT` is baked as `day` light the same uniform tints, so the way out reads from down the passage. Walking within `EXIT_R` of the mouth node, or anywhere past it into the flare, takes her back out onto the notch's floor before the arch (`CaveMouths.apron`), facing away from the cliff.

**Where the cave is.** Every system is built at `CAVE_OY` (-2000 m) under the overworld at its plan's own x, z, so a peer in the same cave stands where she does with nothing new on the wire. Underground, the overworld is not stepped (`stepOverworld`), and every overworld scene child except the rig, hands, peers, flames and the room is hidden each frame; `darkCave` zeroes sun, sky and night lift and turns the fog black.

## 3. The graph

Nodes are `mouth`, `junction`, `chamber` and `cavern`. Each mouth gets a throat junction 18 m in; more junctions scatter at `SPACING` and some become chambers or caverns. The first cavern with room, kept 35 m clear of every mouth, is a **great cavern**: 30 to 200 m long, its roof 40-70 m up, ringed by lobes and nooks, with up to 16 braids off it (most passages elsewhere take 4). Edges are `walk`, `drop` or `sump`; a walk may also be a squeeze or a river.

**The no-trap rule is structural.** Every node hangs off a spanning tree of two-way edges (walks and sumps), so any node reaches a mouth by walking and swimming alone. Drops (a lip from `DROP_MIN`, 2.2 m, past her reach, to `DROP_MAX`, 9 m) are only ever added on top of the tree as shortcuts down, often opening high in the lower chamber's wall. Grades stay under `GRADE_MAX` (0.42), a fifth of tree walks descending into the cave. Passage width and height vary per edge (from 1.8 m wide and 2.3 m tall, some vaulting several metres higher), stacked passages keep `SILL` (2.6 m) of rock between them, and two links out of one node keep 40 degrees apart (`alongside`), so a climbing passage never leaves a ledge in its sibling's tube. `check-caves.mjs` proves the rule on the graph, then by walking every two-way passage both ways on the built surface.

**Down is in.** Depth grows from the mouths at y = 0, so "climb when lost" is a rule she can learn, and the drops make it one with exceptions.

## 4. The field and the mesh

`CaveField.at(x, y, z)` is positive in rock, negative in air, roughly metres, in cave-local coordinates. Passages are D-shaped (a half-ellipse vault over a flat floor) swept along each edge's samples; nodes are ellipsoid domes cut by a floor; everything joins by a smooth min. Noise (`noise3.js`, value noise for speed) roughens walls and floors. The mesher and `CaveWalk` build identical fields from the same graph, so they agree to the millimetre.

**Surface nets** on a voxel grid in 16 m chunks (`LODS`, `CHUNK`). A chunk samples one voxel past each face but emits quads only for edges it owns, so seams close without cracks. Per vertex the mesher bakes region colour, a cheap AO, and the glow of every light within reach (§8). Passages end in rounded caps whose floor climbs a metre a metre under a vault left on the unclimbed floor, so a climb never shelves a terrace and a cap never leaves a film of air at its neighbour's roof; a passage's floor coves up `COVE` (0.9 m) into its walls, so climbing out of another's tube is a ramp. Chamber and cavern floors carry `relief` (graph.js `relieve`): a tilt and mounds on a 1 m grid, slope-limited, flattened where passages arrive; a great cavern's also cuts a river channel and pools in its hollows.

**LOD and regions.** Every chunk is meshed once at 0.5 m and every tier vertex-clustered from that, its seam rows clustered at 1 m along the face whatever the tier, so a chunk's seam vertices are identical at every tier and neighbours at different tiers meet without a crack (the gate checks it). The hem is thus twice as fine as the 2 m tier and four times the 4 m; the seam fans are about half the coarse tiers' triangles. A seam vertex whose triangles a coarse tier would all collapse keeps them at full detail there, so none goes missing in one tier only. One mesh per region: 0.5 m within 10 m of her (gap to the chunk's box), 1 m clusters to 25 m, 2 m to 50 m, 4 m to `CULL_M` (85 m), nothing past it (`drawnLod`, shared by `CaveRoom` and the gate). Only her region and those it touches are drawn. Clear sightlines past 30 m are rare and the black fog hides most of what lies past 25 m, so the thin walls the coarse tiers drop do not show. The gate holds the triangles drawn from any node, counting every direction, under 80k; its systems peak at 55-75k, a great cavern's open floor among the heaviest.

**The worker** plans the same cave from `{ seed, entries }` and posts chunks nearest her arrival first, then 'near' once everything within `NEAR_M` is out; `enterCave` waits on 'near'. The main thread also runs `planCave` itself, for the walk and props.

## 5. Water

Pools sit in chambers and caverns with a dish; rivers cut `RIVER_DEPTH` under a long, gentle walk's floor. Up to three tree walks become **sumps**: the passage dips under its water level to the roof and climbs out at `SUMP_GRADE`. Fish and crabs keep to the pools. A torch dipped in any water, cave or overworld, goes out with `extinguish`.

**Shores.** `settleWaters` (caves/water.js) floods each pool and sump from its deepest point over the real floor under its planned level, on a 0.5 m grid refined to 0.25 m where the shoreline crosses, so the plane runs into the bank instead of stopping at an ellipse. Two columns join only with air `LIP` over the higher floor, so water does not leak into a passage under rock. The flood stays within the body's home (node ellipse × `HOME`, a sump's line padded `SUMP_HOME`) and stops a cell past it. The level is never lowered to the lip it would spill over: the planned level is what floats her past a dish's steep wall to a bank she can mantle onto, and check-caves fails its exits with the water 0.1 m lower. A pool a sump's water covers takes the sump's level and draws no plane of its own. `CaveWalk` and the renderer both read the shore grid.

**Reflection.** From above, the water shows a 64 px cube (`MIRROR_SIZE`) the room captures one face a frame, a hand over the water vertex nearest her eye within `MIRROR_REACH` (30 m). It is Fresnel-weighted and rippled by the shader's slow normal, with the analytic torch glint on top. The water is hidden from the capture; the torches are not, so the wall she lights shows in it. Underneath, the murk. Under a roof lower than the water, `CaveWalk.waterAt` answers the roof less `ROOF_GAP`, so a swimmer is held under the rock and follows it down and back up instead of floating through it.

**Sumps and the torch.** Under water her view is the blurry murk (`CAVE_MURK`), like a night swim outside, and `underWater` reads the cave's water, so a sump douses the torch and blocks the flint as the overworld's water does. She relights it after surfacing. Both ends of a sump glow with odds 0.85 (others by their region's `glow`), so exits are usually but not always near glowing mushrooms.

## 6. Regions and props

A region is a connected group of nodes with one of seven `PALETTES` (grey rocky, dusty brown, blue-grey mushroom, pale limestone, old ruin, rust red, green damp): rock, vein and floor albedo in the terrain's range, and densities of dripstone, mushrooms, glow, ruins and rubble. Each region's biggest chamber holds its landmark (pillar, arch, giant mushroom, column, colonnade).

`placeProps` lays dripstone in bunches of up to eight (one lumpy lopsided 104-triangle model, `stalagmite.js`, in four seeds, pointed up or down; `/gen-stalagmite` shows it), mushrooms (glowing caps twice as common as plain) (the forest's species from `mushroom-bank.js` grown large, wearing the props atlas with caps from `MUSHROOM_CAP_CAVE`, each region's glowing its one colour scaled by the cap texture's luminance so the grain still shows, and small glowing clumps standing out of the walls), blocky ruin columns, chalk lumps, fish and crabs. A great cavern adds groves of giant glowing mushrooms (1.5 to 12 m, up to `GROVE_LIGHTS` of them lit) off its low ground, boulders up to 3 m, and fish in its hollows' pools. Props stand on the relieved floor (`reliefAt`). **Anything she cannot step past** (a stalagmite over `MITE_BLOCKS`, 1 m, a column, a giant stem) is an obstacle in `CaveWalk` and is kept clear of every passage line into its node, so dressing cannot close a route the graph promised.

## 7. Walking

`CaveWalk` gives Player the WalkSurface contract read off the field. A cave stacks floors over floors, so every question is asked from a height: her foot height, or `hintY`, which main sets to her feet each frame for the rest. A rock column from over her reach down past her feet is a wall. The gate times a walk step under 50 us.

## 8. Drawing, light and chalk

**Light.** Pitch dark: the torches (`uTorch`) are the only light that moves. Every glowing mushroom (a giant's light reaching `6 + h` m, a small cap's a pace or two) and the mouths' daylight are baked into a per-vertex glow the cave shader adds unlit (the daylight as a separate `day` scalar times `uDay`), so stretches can be walked by glow alone; a mouth's daylight runs `DAY_M` (11 m) down its passage. Torch shadows are not built; the baked AO carries the depth. The rock wears the boulders' stone tile every `STONE_M` (2.2 m), tinted by its region.

**Chalk lumps** are a hands source (`ChalkStones`, kind `chalk`) over the room's `chalkRows`. Taking one marks it in `taken` (session only).

**Drawing.** In VR a held lump draws where its tip is within `CHALK_TOUCH_M` of rock (`onRock`, two Newton steps on the field, no raycast). On the desktop, a left drag with chalk held draws where the cursor's ray meets rock (`rayRock`, sphere march), and drag-look is suppressed while a stroke is live. A `ChalkPen` per hand resamples every `STEP_M` (3 cm) and starts a new stroke on a jump over `JUMP_M` or at `STROKE_MAX` points.

**Storage.** A stroke is `[system seed, id, player, points]`; points are int16 triples at `QUANT_M` (2 cm) about the system's centre (cx, cz) and cave-local y, base64, 6 bytes a point. Out of range throws rather than wraps. Wall normals and grain are recomputed at draw time, so only points are stored.

**Ribbons.** `ribbons()` lays each stroke as a strip lifted `LIFT_M` off the rock along the field's gradient; the mark shader discards by a grain hash for the dry, broken look, with a polygon offset and no blending. The room rebuilds the marks mesh when the system's rev changes, and the live strokes when they grow.

**Sharing** copies the trust relay. The client keeps every stroke it learns (`Chalk`), saves only hers, and resends them on load and on every welcome, `BATCH` (8) a flush. The relay keeps up to `CHALK_CAP` (4096) per room with a rev, tells each client what it has not seen at most 32 a snapshot, and never echoes. A stroke lasts as long as its author keeps their save.

## 9. Open

- `planCave` also runs on the main thread at warm-up, a hitch near a mouth; `settleWaters` adds 70-100 ms of it.
- Where a chamber's floor lies under its pool's planned level, the water floods on down a descending passage and its plane ends in the air a cell past home, up to 1.4 m over the floor (tmp/cave-water-hover.mjs; 21 m² across check-caves' seven systems). The fix is in the plan: a lip at such a passage's mouth, or a level set from the real rim.
- The marks mesh rebuilds whole on every stroke commit; many strokes may hitch.
- Chalk lumps come back on reload (`taken` is session only); things dropped in a cave are not kept once she leaves.
- The arch does not collide; she can walk through its stones. Grass and ferns still grow in the notch.
- Every chunk's finer LODs are held in GPU memory once met.
- Torch shadows.
- The chalk relay needs the server redeployed.
- Not yet felt in a headset: how dark, how lost, VR chalk drawing.
- Spiders and horrors are out of scope; caverns leave room for lairs.
