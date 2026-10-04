# 39 -- Caves

Status: built, untested in a headset. Builds on the torch (§37 `uTorch`), the mushroom family (§24), the trust relay pattern (`server/src/main.js` `applyTrust`) and the hands' sources (`hands.js`, `taken.js`).

Cave mouths stand at the feet of cliffs. Walking a couple of metres into one fades her to black and moves her into the mouth's cave **system**: a pitch-dark labyrinth of tunnels, caverns, drops and flooded passages, in regions that each look their own, generated from the system's seed so every peer walks the same cave. Mouths within ~500 m may open onto the same system.

## 1. Pieces

| piece | job |
|---|---|
| `caves/sites.js` | sites the mouths on the overworld (`siteMouths`) and groups them into systems (`groupSystems`) |
| `layers/clefts.js` | the slot cut into the terrain behind each mouth |
| `render/cave-mouths.js` | the hood of cliff rock each mouth stands in, and the walk-in test |
| `caves/graph.js` | the topology: nodes, passages, drops, sumps, rivers, pools, glows, regions |
| `caves/field.js` | the signed distance field the graph describes |
| `caves/props.js`, `caves/regions.js` | what stands in the cave, and each region's look |
| `caves/build.js` | `planCave`: graph, field, props, lights and the doors, from `{ seed, entries }` |
| `caves/mesh.js`, `caves/worker.js` | surface nets per 16 m chunk, in a worker, nearest chunks first |
| `caves/walk.js` | `CaveWalk`: the walk surface read off the field |
| `render/cave-room.js` | the system drawn: chunks, instanced props, water, fish and crabs, chalk |
| `caves/chalk.js`, `render/chalk.js` | chalk strokes: codec, store, pens, ribbons; the lumps as a hands source |
| `check-caves.mjs` | determinism, the no-trap proof on the built surface, sump flooding, triangle budget, chalk |

All of `caves/` is pure and node-runnable. main.js wires it (`--- caves` section): `siteCaves` at overworld build, `warmCave` starts the worker as she nears a mouth, `caveTest` runs the portal each step, `enterCave`/`leaveCave` swap the walk under the fade, `stepCave` runs the frame underground.

## 2. Mouths in the overworld

**Siting.** Candidates are scanned on the raw 8 m texels for level ground with a face rising at least `RISE_MIN` (11 m) two texels behind it, then refined against the walker's exact height so the hole's floor is the ground under her feet. Water and towns refuse a site. Mouths keep `MOUTH_SPACING` (350 m) apart, at most `MOUTH_CAP` (30). Pairs within `LINK_M` (500 m) join one system with odds `LINK_ODDS` (0.6), by union-find. A system is `{ id, seed, mouths, cx, cz }`; the seed is a uint32 and keys everything about it, chalk included.

**The look.** The ground is a height field and cannot overhang, so a mouth is two parts:

1. **A hood** (`CaveMouths`): a mesh in the terrain's stippled cliff rung standing `hoodOut` out of the face, with a hole (`holeW` x `holeH`) whose throat darkens to a black cap at `throat`. Seeing one means she can walk in. The hood's walls are what stop her at its sides. It is built in world axes, never rotated, because the stipple reads its plane off the local position.
2. **A cleft** (`CleftSet`): inside the hood's walls the terrain is pulled down to the mouth's floor, never raised, so the ground never pokes through the hole. Clefts are made at boot like roads and never saved.

**The portal.** Past `MOUTH.into` (1.6 m) in from the lip, `caveTest` fades her under and boots her at the mouth's door inside, `ARRIVE_IN` (3.5 m) down the passage, facing in. Each mouth node's dead end glows faint daylight (`DAYLIGHT`), so the way out reads from down the passage. Walking within `EXIT_R` of that dead end takes her back out onto the apron before the mouth, facing away from the cliff.

**Where the cave is.** Every system is built at `CAVE_OY` (-2000 m) under the overworld at its plan's own x, z, so a peer in the same cave stands where she does with nothing new on the wire. Underground, every overworld scene child except the rig, hands, peers, flames and the room is hidden each frame; `darkCave` zeroes sun, sky and night lift and turns the fog black.

## 3. The graph

Nodes are `mouth`, `junction`, `chamber` and `cavern`. Each mouth gets a throat junction 18 m in; more junctions scatter at `SPACING` and some become chambers or caverns. Edges are `walk`, `drop` or `sump`; a walk may also be a squeeze or a river.

**The no-trap rule is structural.** Every node hangs off a spanning tree of two-way edges (walks and sumps), so any node reaches a mouth by walking and swimming alone. Drops (a lip over `DROP_MIN`, 2.2 m, past her reach) are only ever added on top of the tree as shortcuts down. Grades stay under `GRADE_MAX` (0.36). `check-caves.mjs` proves the rule on the graph, then by walking every two-way passage both ways on the built surface.

**Down is in.** Depth grows from the mouths at y = 0, so "climb when lost" is a rule she can learn, and the drops make it one with exceptions.

## 4. The field and the mesh

`CaveField.at(x, y, z)` is positive in rock, negative in air, roughly metres, in cave-local coordinates. Passages are D-shaped (a half-ellipse vault over a flat floor) swept along each edge's samples; nodes are ellipsoid domes cut by a floor; everything joins by a smooth min. Noise (`noise3.js`, value noise for speed) roughens walls and floors. The mesher and `CaveWalk` build identical fields from the same graph, so they agree to the millimetre.

**Surface nets** on a 0.5 m voxel grid in 16 m chunks (`VOXEL`, `CELLS`, `CHUNK`). A chunk samples one voxel past each face but emits quads only for edges it owns, so seams close without cracks. Per vertex the mesher bakes region colour, a cheap AO, and the glow of every light within reach (§8). The gate budgets 450k triangles a mouth.

**The worker** plans the same cave from `{ seed, entries }` and posts chunks nearest her arrival first, then 'near' once everything within `NEAR_M` is out; `enterCave` waits on 'near'. The main thread also runs `planCave` itself, for the walk and props.

## 5. Water

Pools sit in chambers and caverns with a dish; rivers cut `RIVER_DEPTH` under a long, gentle walk's floor. Up to three tree walks become **sumps**: the passage dips under its water level to the roof and climbs out at `SUMP_GRADE`. Fish and crabs keep to the pools. Under a roof lower than the water, `CaveWalk.waterAt` answers the roof less `ROOF_GAP`, so a swimmer is held under the rock and follows it down and back up instead of floating through it.

**Sumps and the torch.** Under water her view is the blurry murk (`CAVE_MURK`), like a night swim outside, and `underWater` reads the cave's water, so a sump douses the torch and blocks the flint as the overworld's water does. She relights it after surfacing. Both ends of a sump glow with odds 0.85 (others by their region's `glow`), so exits are usually but not always near glowing mushrooms.

## 6. Regions and props

A region is a connected group of nodes with one of seven `PALETTES` (grey rocky, dusty brown, blue-grey mushroom, pale limestone, old ruin, rust red, green damp): rock, vein and floor albedo in the terrain's range, and densities of dripstone, mushrooms, glow, ruins and rubble. Each region's biggest chamber holds its landmark (pillar, arch, giant mushroom, column, colonnade).

`placeProps` lays stalagmites and stalactites, mushrooms (some huge, a share glowing blue, green or violet from `GLOWS`), blocky ruin columns, chalk lumps, fish and crabs. **Anything she cannot step past** (a stalagmite over `MITE_BLOCKS`, 1 m, a column, a giant stem) is an obstacle in `CaveWalk` and is kept clear of every passage line into its node, so dressing cannot close a route the graph promised.

## 7. Walking

`CaveWalk` gives Player the WalkSurface contract read off the field. A cave stacks floors over floors, so every question is asked from a height: her foot height, or `hintY`, which main sets to her feet each frame for the rest. A rock column from over her reach down past her feet is a wall. The gate times a walk step under 50 us.

## 8. Drawing, light and chalk

**Light.** Pitch dark: the torches (`uTorch`) are the only light that moves. Glowing mushrooms and the mouths' daylight are baked into a per-vertex glow the cave shader adds unlit, so stretches can be walked by glow alone. Torch shadows are not built; the baked AO carries the depth.

**Chalk lumps** are a hands source (`ChalkStones`, kind `chalk`) over the room's `chalkRows`. Taking one marks it in `taken` (session only).

**Drawing.** In VR a held lump draws where its tip is within `CHALK_TOUCH_M` of rock (`onRock`, two Newton steps on the field, no raycast). On the desktop, a left drag with chalk held draws where the cursor's ray meets rock (`rayRock`, sphere march), and drag-look is suppressed while a stroke is live. A `ChalkPen` per hand resamples every `STEP_M` (3 cm) and starts a new stroke on a jump over `JUMP_M` or at `STROKE_MAX` points.

**Storage.** A stroke is `[system seed, id, player, points]`; points are int16 triples at `QUANT_M` (2 cm) about the system's centre (cx, cz) and cave-local y, base64, 6 bytes a point. Out of range throws rather than wraps. Wall normals and grain are recomputed at draw time, so only points are stored.

**Ribbons.** `ribbons()` lays each stroke as a strip lifted `LIFT_M` off the rock along the field's gradient; the mark shader discards by a grain hash for the dry, broken look, with a polygon offset and no blending. The room rebuilds the marks mesh when the system's rev changes, and the live strokes when they grow.

**Sharing** copies the trust relay. The client keeps every stroke it learns (`Chalk`), saves only hers, and resends them on load and on every welcome, `BATCH` (8) a flush. The relay keeps up to `CHALK_CAP` (4096) per room with a rev, tells each client what it has not seen at most 32 a snapshot, and never echoes. A stroke lasts as long as its author keeps their save.

## 9. Open

- `planCave` also runs on the main thread at warm-up, a hitch near a mouth.
- The marks mesh rebuilds whole on every stroke commit; many strokes may hitch.
- Chalk lumps come back on reload (`taken` is session only); things dropped in a cave are not kept once she leaves.
- Overworld layers keep updating underground, only hidden.
- Grass can grow in the hood's mouth; the hood is hard to see at night; cave rock reads as fairly uniform brown under the torch.
- Torch shadows.
- The chalk relay needs the server redeployed.
- Not yet felt in a headset: how dark, how lost, VR chalk drawing.
- Spiders and horrors are out of scope; caverns leave room for lairs.
