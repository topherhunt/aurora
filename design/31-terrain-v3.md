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
| Biomes | boundary polygons in the doc | class grid rasterised at boot, shipped to the mesh workers beside the heightmap |
| Rivers | doc `rivers[]` polylines, found from the eroded grid | v2's A*-routed splines (`route.js`), as today |
| Lakes | doc `lakes[]`, the sea one uncarved rectangle at y = 0 | v2 `WaterSurfaces`, as today |
| Props | nothing | scattered live from the grid and the biome class, as today |

The biome grid is not a texture: it is a `Uint8Array` the mesher reads per vertex, so `shade()` in `chunk-mesh-v2.js` can lerp a per-class ground colour in. It is bit-identical to today when the grid is absent.

## Where the work runs

Everything runs at boot in a Web Worker, every layer of it -- macro shape, octaves, biomes, hydrology, rivers. It is cached in IndexedDB (`aurora-v3`, key `seed:algorithmVersion`) as the finished field plus the doc, so the second boot is a read; `?regen` throws the cache away and `?seed=N` picks the island. Nothing is pre-baked into `public/` until the algorithm is LOCKED (step E): a layer that is baked is a layer that cannot be revised from the page, and revising is the whole of the next few weeks. The same generator module runs in node for the gate and the PNG script -- `src/v3/` is three-free and DOM-free, the constraint that makes that possible.

The cost is one worker run per client per algorithm version. Desktop node measures the macro shape at 1025² in well under a second; the eroded whole is budgeted at 15-40 s on a Quest 2, once, behind a progress line. If that budget is blown, the escape is to bake at lock time, not to move layers out of the boot path early.

## Scale

`WORLD_SIZE` stays 8192 m so nothing in v2 has to be told. 1025 texels at 8 m. The island's mean coast radius is 2.5 km, so the sea runs 1.2-1.7 km out from the coast to the box edge and keeps falling all the way. The generator owns the octaves from 2048 m down to 16 m, eight of them; the 8 m and 4 m rungs the brief asked for are what v2's `detail.js` already supplies at runtime, calibrated against whatever coarse field it is given.

The known trap in that calibration: `calibrateRough` fits its curvature law over sites drawn from the whole grid, and 40% of this grid is sea floor with less structure than land. Step B measures whether the fit drifts and, if it does, calibrates over land texels only. Until then the sea floor carries the same noise as the land so the fit has nothing flat to be dragged down by.

## The steps

Each step is its own look on the map page and in 3D before the next goes on, because the lesson of §14 is that shape complaints must become numbers before they become code, and the number has to be read off the layer that is wrong, not off the sum.

### Step 0 -- skeleton and instruments (built)

`src/v3/island.js` is the field, `src/v3/generate.js` the pipeline (`generate({ seed, n, log })` -> `{ v, seed, n, cell, height, doc, stats, ms }`), `src/v3/paint.js` the hillshade and layer painters, `src/v3/worker.js` the worker, `src/v3/store.js` the IndexedDB cache. `/terrain-v3-map` runs the generator in the worker every time (and so is what fills the cache) and draws it as relief, elevation, slope and closed bowls with a hover readout and the stats; `scripts/island-png.mjs` writes the same relief layer to a PNG; `scripts/check-v3.mjs` asserts determinism, finiteness, land fraction, a summit near the centre, a sea floor that falls, an irregular coast, a doc that validates, the rg16 round trip, and that `V2Height` will stand on the field. `/terrain-v3` boots the v2 engine on the result behind the cache and lets you fly.

### Step A -- the macro shape (built)

Nothing but the broad shape: a warped cone standing in a sea that falls away. Everything smaller than the coast's own features is deliberately absent, so the map view is judging only whether the island's silhouette and its skirt are right.

1. **The warp.** Each texel's position is displaced by three octaves of simplex (1600 m / 380 m, 520 m / 110 m, 170 m / 32 m amplitude), and every later term reads the warped position. This is what puts bays and headlands of three sizes on a coast that would otherwise be a circle.
2. **The coast radius.** `R(theta) = R0 * (1 + a1 n1(theta) + a2 n2(theta))`, noise sampled on a circle so it is periodic by construction: a low-order term at +-32% for the big peninsulas and the deep bays, a higher-order term at +-9% for the middling ones. A peninsula is an arm: because height is a function of `r / R(theta)`, ground that reaches further out reaches further out AT HEIGHT, and the ridge runs down it on its own.
3. **The profile.** `d = r / R(theta)`, 0 at the centre and 1 at the coast. Land is `H (1 - d)^1.7` with a coastal shelf: below 0.12 H the profile is bent toward a low apron so the last 400 m before the shore are lowland rather than a straight slope into the water. Sea is a shelf 6 m under for 120 m, then a slope of 1:9 that keeps falling to the box edge: -230 m on average along the edge, -431 m in the corners, against an encoding floor of -450 m. The centre is not a point: the top 8% of the cone is capped by a tangent parabola, flat at the top and zero at the coast, so the summit is a massif of (1 - 0.08) H = 828 m and not a spike; the octaves of step B are what will make it jagged.
4. **The basin term.** Between `d` 0.3 and 0.75 a broad low-frequency noise (wavelength 900 m) is added bipolar: its dips at full share up to 120 m, its lumps at 0.6 of that, tapered to nothing outside the ring. A dip alone on a 20% slope needs more than S * lambda / 4 = 45 m to close, which is why the amplitude is what it is. This is what leaves closed bowls in the mid-elevation ring for step D's priority flood to find as lakes; the low-lying lakes come from the apron, which the same term reaches at a third of the amplitude.

Instruments: land fraction, summit height and offset from the centre, coast irregularity (the shoreline's length against the circumference of the circle with the island's area), the relief-by-scale table (rms of what a box blur at 32, 128, 512 and 2048 m removes over land), which is the table step B adds to, and the closed bowls (what a priority flood would pond over a metre deep, grouped, over 2 ha). Seed 20260824 measures: land 29.5% (19.8 km²), summit 828 m and 313 m off centre, coast 53.7 km at 2.67x its circle, sea floor -84 m a kilometre out, 17 bowls ponding 0.70 km², relief 3.6 / 19.1 / 57.8 / 173.1 m, 0.43 s in desktop node.

Known blemish: the 170 m warp octave whorls the near-flat summit cap, a marbling the hillshade shows and step B's octaves are expected to bury; if it survives step B the warp's smallest octave is the first suspect.

### Step B -- the octaves (not built)

Eight octaves of fbm from 2048 m to 16 m at gain exactly 0.5 -- the 1/f law of §3 -- with domain warp on the top three only, ridged noise blended in above the tree line for the massif, and variance masking so the lowlands stay quiet and the mountains do not. Heights are not clamped; the sea floor takes the same octaves. Measured on the relief-by-scale table against the target law before it is looked at in 3D.

### Step C -- climate and biomes (not built)

Temperature from elevation and a latitude gradient across the box, moisture from a prevailing-wind rain shadow over the massif plus distance from the sea; the seven classes (arctic, temperate forest, temperate plains, humid jungle, swamp, dry canyon, desert) assigned by thresholds on the pair with a noise-warped border. The classes are then TRACED as polygons (marching squares on the class grid, simplified), and the polygons are what the doc stores; the grid is rebuilt from them at boot. Each class gets a flat distinct ground colour through `shade()` until the props exist to tell them apart.

### Step D -- hydrology per biome (not built)

`src/sim/hydrology.js` as built for Phase A: priority flood, breach, D8 flow, accumulation, stream-power incision, plus `thermalErode` from v2. Per biome the knobs differ -- the canyon takes deep incision and high talus, the swamp almost none and a flat apron, the arctic takes thermal erosion over fluvial. Closed bowls the flood finds above a size threshold are kept as lakes at their spill level, each with an outflow river from its spill point; the rest are breached. Rivers are traced down the eroded grid by accumulation, splined, and given a meander term on their low-gradient reaches, then written to the doc as v2 river polylines. The sea stays the one uncarved rectangle lake.

### Step E -- lock (not built)

The generated field is baked to `public/world-v3/` the way `make-heightmap.mjs` bakes the shipped one, the doc beside it, and the boot path becomes a load. The generator stays as the gate's reference.

### Phase 2 -- populate (not built)

Per-biome prop rules through the seam `BiomeField` already leaves in `src/v2/layers/biome.js`.

## Shared files this touches

Step 0 and A touch no shared file except `package.json` (the `check-v3` script and its link in the chain) and one row of `DESIGN.md`. Steps B-D will touch `chunk-mesh-v2.js` (the biome lerp in `shade`), `worker.js` and `terrain-v2.js` (shipping the class grid), and `detail.js` (land-only calibration) -- each is declared to the other sessions before it is opened.
