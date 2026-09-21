# 31. Terrain v3 -- the generated island

The route is `/terrain-v3`, the map instrument `/terrain-v3-map`, the code `src/v3/`, the gate `scripts/check-v3.mjs`. This section is the plan and, as each step lands, the record of what was built; a step that is not yet built is marked so.

## What v3 is

v3 is a new AUTHOR OF THE COARSE FIELD for the v2 engine, not a new renderer. v2 (§18) draws whatever 1025² Float32 heightmap at 8 m a texel it is handed through `Heightmap.fromRaw` (the leafkin village room is the precedent), puts its own procedural detail from 8 m down to 10 cm on top of it, and reads lakes, rivers and roads out of a layers document. v3 generates that heightmap and that document from a seed, in the browser, at boot. Nothing in `src/v2/terrain/` is forked.

The island: roughly circular, ocean all round it running out to the box edge, a coast with bays and headlands of many sizes, hills rising inward to a jagged snowy massif at the centre, one or two broad arms off the massif, and inland valleys wide enough to hold lakes -- lakes between mountains and low-lying ones, not only lakes that open on the sea.

## The two representations (§18's rule, applied)

Stored is small and parametric; runtime is baked and O(1) to read.

| Thing | Stored | Runtime |
| --- | --- | --- |
| The ground | seed + algorithm version | 1025² Float32 metres, cached in IndexedDB |
| Biomes | boundary polygons (`biomes[]` in the v3 record; the v2 doc's `serialize()` drops keys it does not know, so they move into the doc when the doc learns them) | class grid rasterised from the polygons in the worker, shipped to the mesh workers beside the heightmap |
| Rivers | doc `rivers[]` polylines, found from the eroded grid | v2's A*-routed splines (`route.js`), as today |
| Lakes | doc `lakes[]`, the sea one uncarved rectangle at y = 0 | v2 `WaterSurfaces`, as today |
| Props | nothing | scattered live from the grid and the biome class, as today |

The biome grid is not a texture: it is a `Uint8Array` the mesher reads per vertex (`GroundTint` in `src/v2/layers/ground.js`, bilinear over a per-class palette), and `shade()` in `chunk-mesh-v2.js` takes that colour as its grass base in place of the grass-to-scrub altitude lerp. Bit-identical to today when the grid is absent.

## Where the work runs

Everything runs at boot in a Web Worker, every layer of it -- macro shape, octaves, biomes, hydrology, rivers. It is cached in IndexedDB (`aurora-v3`, key `seed:algorithmVersion`) as the finished field plus the doc, so the second boot is a read; `?regen` throws the cache away and `?seed=N` picks the island. Nothing is pre-baked into `public/` until the algorithm is LOCKED (step E): a layer that is baked is a layer that cannot be revised from the page, and revising is the whole of the next few weeks. The same generator module runs in node for the gate and the PNG script -- `src/v3/` is three-free and DOM-free, the constraint that makes that possible.

The cost is one worker run per client per algorithm version. Desktop node measures shape, octaves and biomes at 1025² in about a second; the eroded whole is budgeted at 15-40 s on a Quest 2, once, behind a progress line. If that budget is blown, the escape is to bake at lock time, not to move layers out of the boot path early.

## Scale

`WORLD_SIZE` stays 8192 m so nothing in v2 has to be told. 1025 texels at 8 m. The island's mean coast radius is 2.5 km, so the sea runs 1.2-1.7 km out from the coast to the box edge and keeps falling all the way. The generator owns the octaves from 512 m down to 8 m, seven of them; the 4 m rung and below is what v2's `detail.js` already supplies at runtime, calibrated against whatever coarse field it is given.

The known trap in that calibration: `calibrateRough` fits its curvature law over sites drawn from the whole grid, and 72% of this grid is sea floor. The sea floor carries the jitter at 30% of the massif's so the fit has nothing flat to be dragged down by; it lands at rough 0.0306, exponent 1.07, a finite fit the gate asserts, and `detail.js` is untouched.

## The steps

Each step is its own look on the map page and in 3D before the next goes on, because the lesson of §14 is that shape complaints must become numbers before they become code, and the number has to be read off the layer that is wrong, not off the sum.

### Step 0 -- skeleton and instruments (built)

`src/v3/island.js` is the field, `src/v3/generate.js` the pipeline (`generate({ seed, n, log })` -> `{ v, seed, n, cell, height, meta, doc, biomes, ground, stats, ms }`), `src/v3/paint.js` the hillshade and layer painters, `src/v3/worker.js` the worker, `src/v3/store.js` the IndexedDB cache. `/terrain-v3-map` runs the generator in the worker every time (and so is what fills the cache) and draws it as relief, elevation, slope, closed bowls and biomes with a hover readout and the stats; `scripts/island-png.mjs` writes the same relief layer to a PNG; `scripts/check-v3.mjs` asserts determinism, finiteness, land fraction, a summit near the centre, a sea floor that falls, an irregular coast, a doc that validates, the rg16 round trip, and that `V2Height` will stand on the field. `/terrain-v3` boots the v2 engine on the result behind the cache with the game's own `Player`: walking by default, space to fly and hold to climb, speed rising with height, double-tap to land. Its near plane steps with height above ground (0.1 m on foot, up to 8 m at 200 m up) so the shoreline stays crisp from altitude instead of z-fighting the sea; `window.__v3` exposes the rig, camera, look, player, height and clock for the console and the headless probe.

### Step A -- the cone (built)

`MACRO` in `island.js`. A circular cone standing in a sea that falls away, and nothing smaller than the coast's own features, so the map view is judging only whether the island's silhouette and its skirt are right.

1. **The warp.** Each texel's position is displaced by three octaves of simplex (1600 m / 150 m, 520 m / 45 m, 170 m / 15 m amplitude), and every later term reads the warped position. This is what puts bays and headlands of three sizes on a coast that would otherwise be a circle. Amplitude stays under a tenth of the wavelength: past that the warp folds the plane over itself, and every fold is a crease of terrain running inland.
2. **The coast radius.** `R(theta) = R0 * (1 + a1 n1(theta) + a2 n2(theta))`, noise sampled on a circle so it is periodic by construction: a low-order term at +-32% for the big peninsulas and the deep bays, a higher-order term at +-9% for the middling ones. A peninsula is an arm: because height is a function of `r / R(theta)`, ground that reaches further out reaches further out AT HEIGHT, and the ridge runs down it on its own. The same rule would run every middling bay inward as a valley converging on the summit, so the higher-order term is skin-deep: full from 0.9 R0 outward, gone inside 0.35 R0.
3. **The profile.** `d = r / R(theta)`, 0 at the centre and 1 at the coast. Land is `H (1 - d)^1.7` with H = 450 m. The centre is not a point: the top 8% of the cone is capped by a tangent parabola, flat at the top, so the pedestal tops out at 414 m as a massif and not a spike. Below 0.12 H the profile is bent toward a quadratic apron that keeps 15% of the cone's slope at the waterline, so the last few hundred metres before the shore are lowland but never a plane the sea can fight. Sea is a shelf 6 m under reached by a 24 m drop, 120 m wide, then a slope of 1:9 that keeps falling to the box edge: -229 m on average along the edge, deeper in the corners, against an encoding floor of -600 m (rg16 quantum 2.4 cm).

Instruments: land fraction, summit height and offset from the centre, coast irregularity (the shoreline's length against the circumference of the circle with the island's area), the relief-by-scale table (rms of what a box blur at 32, 128, 512 and 2048 m removes over land), and the closed bowls (what a priority flood would pond over a metre deep, grouped, over 2 ha).

### Step B -- the jitter (built)

`JITTER` in `island.js`. Seven octaves of value noise, one per scale from 512 m down to the 8 m texel, halving each time. An octave is a square lattice of nodes at that spacing; every node is moved up or down by a random amount up to `jitter` = 25% of the spacing (so +-128 m at 512 m, +-2 m at 8 m); the ground between nodes is a smoothstep between the four corners; and the octaves are added, so each refines the one before it. A node's move is a hash of its lattice coordinates and the seed, so the same seed always gives the same island and any texel can be asked for on its own. Two details keep the lattice from showing: every octave's lattice is turned by the golden angle from the last so no two share axes, and the interpolation is a smoothstep rather than a straight lerp, because a lerp is continuous but its slope is not, and the lattice lines read as creases across every hillside (`interp: 'linear'` is kept so this can be seen).

Why 512 m and not the whole box: the recipe cannot start at 4096 m, since +-1024 m of jitter at that scale is the island, not a refinement of it, and 25% at every scale from there down sums to a slope of about 30 degrees everywhere. The cone owns the shape above 512 m; the jitter owns everything under it.

`byHeight` = 0.7 scales the jitter by the cone's height under it: full on the summit, 30% at the waterline and over the sea. At 0 the +-128 m octave dwarfs the 54 m apron and shreds the coast into islets (coast 7x its circle); at 1 the coast is bland (1.5x), because the coastline's character is largely the jitter cutting the low apron into coves; 0.7 keeps it (3.9x).

Seed 20260824 measures: land 28.0% (18.8 km2), summit 483 m at the centre, coast 77 km at 3.92x its circle, sea floor -84 m a kilometre out and -229 m at the box edge, 7 bowls ponding 0.33 km2 (largest 0.13 km2), relief 2.2 / 8.1 / 29.1 / 102.6 m at 32 / 128 / 512 / 2048 m, about 0.75 s for the whole pipeline in desktop node. The bowl count sits just over the gate's floor of 6; step D's lakes will come from its own carving, not from what the jitter happens to leave. `scripts/island-png.mjs --jitter byHeight=0.5,interp=linear` renders an experiment without touching the cache.

### Step C -- climate and biomes (built)

`src/v3/biomes.js`, run in the worker after the octaves, about 0.2 s. Temperature is a base less a latitude gradient across the box (colder north) less a lapse of 1 per 1300 m, plus a little noise. Moisture is a westerly marched texel by texel across each row: it evaporates over the sea, rains out in proportion to the ground rising under it, dries a little every texel, and the rain that falls is box-blurred 300 m; to that is added the remaining humidity and a coast term (the sea mask blurred 500 m). So the west is wet and forested, the lee of the massif is plains, and the coast is damper than the interior. The seven classes are thresholds on the pair set at the LAND'S OWN QUANTILES, so each holds a seventh of the land whatever the seed: the coldest seventh is arctic; the next two sevenths temperate, split at their median moisture into plains and forest; the warmest four sevenths hot, split at their moisture quartiles into desert, canyon, jungle and swamp. The snow line in the doc is the height a seventh of the land lies above, so v2's snow and the arctic class roughly agree. The lookup is noise-warped (70 m at 260 m) so no border is smooth, and patches under 6 ha are given to their neighbours.

The classes are then TRACED: marching squares per class, each loop simplified to 10 m by Douglas-Peucker, and the polygons (world metres, to the decimetre) are what the v3 record stores. The grid is rebuilt from them by scanline fill in class order with the slivers the simplification leaves taken by the nearest painted texel; the gate asserts the rebuilt grid agrees with the traced one on more than 98% of texels (99.5% on seed 20260824) and that the cached grid IS the rasterisation of the cached polygons. Each class gets a flat distinct ground colour through `GroundTint` and `shade()` until the props exist to tell them apart; the map page's biomes layer paints the same palette over the hillshade.

Seed 20260824 after the warp and the despeckle: every class between 13.6% and 14.9% of the land, the snow line at 203 m; forest and swamp on the wet west, desert and canyon in the massif's lee to the east, jungle across the hot south, arctic on the peaks and the cold north. `CLIMATE` shapes WHERE each class falls; the shares it cannot change.

### Step D -- hydrology per biome (not built)

`src/sim/hydrology.js` as built for Phase A: priority flood, breach, D8 flow, accumulation, stream-power incision, plus `thermalErode` from v2. Per biome the knobs differ -- the canyon takes deep incision and high talus, the swamp almost none and a flat apron, the arctic takes thermal erosion over fluvial. Closed bowls the flood finds above a size threshold are kept as lakes at their spill level, each with an outflow river from its spill point; the rest are breached. Rivers are traced down the eroded grid by accumulation, splined, and given a meander term on their low-gradient reaches, then written to the doc as v2 river polylines. The sea stays the one uncarved rectangle lake.

### Step E -- lock (not built)

The generated field is baked to `public/world-v3/` the way `make-heightmap.mjs` bakes the shipped one, the doc beside it, and the boot path becomes a load. The generator stays as the gate's reference.

### Phase 2 -- populate (not built)

Per-biome prop rules through the seam `BiomeField` already leaves in `src/v2/layers/biome.js`.

## Shared files this touches

Steps 0 and A touched no shared file except `package.json` (the `check-v3` script and its link in the chain) and one row of `DESIGN.md`. Step C touched `chunk-mesh-v2.js` (`shade` takes an optional tint as its grass base; `buildChunkV2` takes an optional `GroundTint`), `worker.js` (builds the tint from the init message's `ground`) and `terrain-v2.js` (the `ground` option, validated on the main thread and copied to each worker), and added `src/v2/layers/ground.js`. Without `ground` every one of them is the path it was. `detail.js` was not touched: the calibration did not drift.
