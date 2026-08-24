## 6. Procedural placement

> **Covers:** procedural scatter -- density, jitter, biome rules, and the scale-reference props.
> **Read this when:** touching `src/props/scatter.js`.

Per chunk, in the worker, deterministic from `hash(worldSeed, chunkX, chunkZ)`:

- Poisson-disc or jittered-grid scatter, with density and species mix driven by biome weights
- Reject on slopes above threshold, in water, on paths, on packed dirt, or inside village footprints
- **Per-instance random Y-rotation and non-uniform scale** (0.8-1.3x, with slight independent vertical stretch). This is most of what makes a procedural forest stop looking procedural
- Align to terrain normal but only partially (lerp ~30%) so trees on slopes lean slightly rather than growing perpendicular to the hillside

### Placement samples the DRAWN surface, not the height field

**This is the load-bearing decision in this section, and it is a correctness fix before it is an optimisation.**

`scatter.js` currently asks `TerrainHeight.heightAndSlopeAt(x, z)` for every surviving candidate: the full-fidelity analytic field, six noise evaluations, **4,912 ns measured**. The hash that produces everything else about the prop -- position, yaw, scale, tint, variant -- is **34 ns**. So 99.3% of a placement rebuild is spent asking the terrain a question, which is why rebuild cost has been fought three times in that file's comments (9.5 ms, then 4.1 ms against a 4 ms gate, then radius traded away to buy 16% back).

It is also *wrong*, and visibly so. The terrain that gets **drawn** is a decimated quadtree chunk. A prop placed at the analytic height sits at `field(x, z)` while the ground under it is drawn at `bilinear(chunk_vertices)`, and the difference is exactly the LOD's angular error -- which is why distant trees and rocks float above the hillside or sink into it. Placement is measuring one surface and the renderer is drawing another.

**So placement reads the resident chunk's own raster instead.** Each chunk already computes a 17x17 grid of heights in the worker; keep it, key it by node, and bilinear-sample it. That gives, in one change:

- **~60x cheaper.** A quadtree descent plus a bilinear sample is on the order of 80 ns against 4,912.
- **Zero float, by construction.** The prop sits on the surface being drawn, at every LOD, because it is sampling that surface. The error is not reduced, it is *identically zero*.
- **Precision that tracks the terrain's own.** Coarse ground gets coarsely-placed props, which is the correct coupling: 1 m cells near the eye, 8 m cells at depth 3. Nothing is precise where nothing is drawn precisely.
- **One cache shared by every placeable kind.** Trees, rocks, logs, bushes, ferns, grass, buildings all sample the same raster. Today each kind pays its own field queries on its own cells, so N kinds cost N times over; after this they cost once.

Memory is not an objection: 289 heights per chunk is 1.2 KB, so 304 resident chunks is ~350 KB.

Three things this has to get right:

- **Slope must stay on a fixed world-scale stencil, not on the chunk's own cell.** A coarse chunk's mesh normal averages a 74° cliff over 128 m and reports 24°, so slope-rejection read off coarse geometry would plant trees on cliff faces and then delete them as you approached. This is the identical bug `chunk-mesh.js` fixes for surface *classification* with `CLASS_EPS`, and placement wants the same estimator: have the worker emit a fixed-scale slope raster beside the height raster. It is already computing it for the colour pass, so it costs a `Float32Array` and a transfer.
- **Placement must invalidate on chunk LOD change, not only on camera cell crossing.** A subdividing chunk changes the answer. `Scatter.invalidate()` already exists for exactly this shape of event (villages use it); terrain streaming becomes a second caller.
- **A prop's height changes when its chunk's LOD does.** That is not a pop to hide -- the ground moves by the same amount at the same instant, so the prop stays planted and the pair slides together. That is strictly better than today, where the prop is anchored to a surface nobody can see.

The escape hatch in §1 still holds: this is array indexing and lerps, no three.js, so it moves to a worker whenever the main thread needs the room.

### Interim: the scale-reference scatter (`src/props/scatter.js`)

None of the above exists yet -- it needs the Phase A biome pass -- but an empty heightfield gives you no way to judge how big a mountain is or how fast you are crossing it. Trees alone give you one number. A cabin, a one-metre boulder and a tuft of grass at your feet give you four scales an order of magnitude apart, and it is having several at once that makes a valley read as a valley rather than as a shape. Placeholder geometry, real architecture: one `BatchedMesh`, one material, per-instance geometry selection, so if that shape is wrong we find out on 1,200 props rather than on 40,000.

Two rules here are not placeholders and should survive into the real system:

- **Density tapers with distance; it does not stop at a cull radius.** A hard edge is visible as a moving wall of trees. A taper reads as depth. The outermost band also fades *scale* to zero, because at 800 m the fog is only 3% and hides nothing, so instances have to dissolve rather than pop.
- **At most one kind rebuilds per** `update()`**.** Grass re-places every 10 m of travel, which at fly speed is three times a second; stacking it into the same frame as a tree pass is a visible hitch for no reason. Measured worst single call: 1.7 ms.

Rejection order is cheap-to-expensive -- density roll, jitter, radius, distance taper, *then* the first `heightAt` -- so the far majority of candidates cost one hash. Grass inverts the usual radius/density trade (30 m disc, tufts ~2.5 m apart) because past 30 m a tuft is a sub-pixel speck, and within 30 m it is the only thing giving the ground texture at walking pace. That cost is the rebuild, not the triangles: at spacing 1.6 it measured 3.0 ms, a fifth of a frame, and had to be widened.

### Paths

Paths are what turn a heightfield into a place. Generate as least-cost routes (A\* with a slope-penalized cost function) between points of interest -- village to village, valley floor to summit. Then:

- Clear props within the path corridor
- **Increase** prop density immediately alongside it (bushes, rocks, boulders) to create the walled, wending, "you must follow this" feeling
- Paint the path corridor into the **packed-dirt splat channel** (§7), which both textures it and suppresses foliage -- one mask, two uses
- Flatten terrain slightly along the corridor

The slope penalty is what makes paths switchback up mountainsides naturally rather than beelining. It also means A\* failing to find a route is a **signal that the terrain is not traversable**, which feeds §4's connectivity validation.

### Villages (`src/village/plan.js`, `src/village/shapes.js`, `src/village/village.js`)

Villages are split in three, and the split is the load-bearing decision. `plan.js` is pure data with **no three.js import at all**, under the same §1 rule as `src/sim/*` -- which is what lets `scripts/check-village.mjs` plan six real sites headlessly and assert things a screenshot cannot: that no road runs through a building, that every door is within 3 m of a path, that every field fence closes, that no plinth floats. `shapes.js` is the geometry kit and knows nothing about layout. `village.js` is the runtime and knows nothing about either.

**Siting is not here.** Phase A already scores village cells on proximity to fresh water and rejects anything in a lake (`VILLAGE` in `phase-a.js`). `Villages.setSites()` takes those positions and has no opinion about them, so when lakes land and the macro structure moves, the villages move with it and nothing in these three files changes. `main.js` currently passes one stand-in site near spawn because Phase A is not wired into the runtime yet, only into `map.html`; that block is marked temporary and is the only temporary thing about the village.

**There is no flat ground to build on, and that is the whole design problem.** Measured over low ground: neighbourhood-average slope p1 10.3 deg, p25 16.9 deg, p50 21.2 deg. So nothing is placed on the assumption of a level pad. Buildings **terrace**: the floor is set at the highest corner of the footprint and a stone plinth grows *down* from it, which is how a real hillside farmstead is built and also means a building can never float. Halls and fields **run along the contour** -- they are yawed to the local strike, not to a random bearing, because a 17 m hall laid across the fall line either floats a metre at one end or buries itself at the other.

The zoning is concentric and every radius is one constant in `VILLAGE_PLAN`: plaza 12 m, ring 31 m, core 48 m, work 76 m, fields 88-122 m. Market stalls and the well in the plaza; the great hall on the plaza rim; dwellings in the core; barns, sheds and workshops in the work band; fenced crop plots and pasture in the outer ring. Arteries leave the plaza on their own bearings and every door gets a spur routed to the nearest path -- routed *around* buildings, with four candidate joins and four bend scales tried, because the first version cheerfully drew a footpath through a workshop wall.

Four decisions worth keeping:

- **Paths are ribbon geometry, not a splat channel.** §7's packed-dirt channel is the right answer for long-distance paths across a chunk, but a village lays ~1,100 m of path inside 240 m and the splat mask's resolution is the chunk's, not the village's. A ribbon is four vertices per polyline point (feathered edge, surface, surface, feathered edge), height-sampled per vertex so it lies on the ground, with `polygonOffset` to beat z-fighting. Cost measured: 918 path triangles for the whole village.
- **The static parts are one merged mesh, not a** `BatchedMesh`**.** The scatter uses batching because trees stream continuously and per-instance culling earns its keep. A village is ~450 static pieces all within 240 m of each other -- per-instance culling would cull nothing and charge a matrix upload per piece per frame. Merged, the entire village is **one draw call**.
- **Fire is instanced, and no light is attached to it.** §5 allows exactly one real-time light and the sun has it. Torches and bonfires are emissive `MeshBasicMaterial` geometry that flickers on two incommensurable sines, so the flicker never settles into a visible beat, and the flame widens as it shortens -- a flame that only scales in Y reads as a pulsing cone.
- **Smoke is opaque and shrinks to nothing.** §7 forbids alpha blending in anything instanced, because blending inside a batch cannot be depth-sorted. So each puff is a pure function of `time + phase` -- no state, no per-frame allocation, identical if the village unloads and returns -- that grows as it rises, drifts on an accelerating wind, and scales through zero instead of fading.

Measured, six real Phase A sites, seed 20260804: plan 2.9-7.0 ms (one frame, once, on approach); 283-453 pieces; 9-15 dwellings; 4-7 fenced plots; 21-29 lampposts; 2-3 bonfires; 25-30 paths totalling 874-1,192 m; ~1,100-1,850 terrain probes. Runtime: **24.5k village triangles + 0.9k path triangles in one draw call**, from a kit of 45 geometries totalling 5.6k triangles -- 3% of the §5 budget. Geometry generation is 19.2 ms, spread over 4 frames against a 2.5 ms budget with a worst frame of 8.8 ms, so walking up to a village does not hitch.

The village also feeds the scatter an exclusion predicate (`Villages.excludes`), injected as a callback rather than imported, so the scatter never has to know villages exist. Grass is deliberately exempt outside the plaza: a 136 m circle with no grass in it reads as a bald patch from the ridge above, and grass between the huts is correct anyway.

---
