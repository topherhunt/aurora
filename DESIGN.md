# Aurora -- Design Document

A WebXR snowy mountainscape for Meta Quest 3. Procedurally generated, N64-era low-poly with baked lighting, explored on foot at walking pace, with the Northern Lights playing overhead at night.

Status: pre-implementation. Spike in progress (§0).

---

## 0. Priority task: the multi-draw spike

**Do this before writing any other code. Everything in §5 depends on the answer.**

The entire rendering architecture rests on `THREE.BatchedMesh`, which needs the `WEBGL_multi_draw` WebGL2 extension to collapse many different geometries into a single draw call. Quest Browser is Chromium 146 on Adreno hardware, so it is very likely present, but this has not been verified on-device and no documentation confirms it.

Build a throwaway page, serve it to the headset, enter immersive VR, and report:

| Check | How | Why it matters |
|---|---|---|
| `WEBGL_multi_draw` present | `gl.getExtension('WEBGL_multi_draw')` -- print to an in-world HUD, not the console | If absent, `BatchedMesh` degrades to per-geometry draws and §5 needs rethinking |
| `BatchedMesh` actually batches | Render ~2,000 instances across ~10 distinct geometries, read `renderer.info.render.calls` | Should be a small constant, not ~2,000. This is the whole thesis |
| Draw call ceiling | Scale instance count and distinct-geometry count until frametime degrades | Establishes the real budget, replacing the estimates in §5 |
| Triangle ceiling | Same, but scale geometry density | Ditto |
| `setFoveation(1.0)` works and helps | Toggle it, watch frametime | Free perf, confirm it is not a no-op |
| Frame rate control | Request 72Hz and 90Hz via the WebXR frame rate API | Determines the target |
| Sustained thermals | Leave it running 20+ minutes at load, watch for frametime cliff | Sets the length of the experience |

Deliverable: an in-world debug HUD showing `renderer.info.render.calls`, `.triangles`, `memory.geometries`, `memory.textures`, and frametime. **This HUD stays in the project permanently**, toggled by a controller button.

Note the HUD-not-console requirement: you cannot see a JS console while wearing the headset, and remote debugging over `chrome://inspect` is slow enough that you will avoid doing it. Print to a world-space panel.

### RESULTS -- measured on Quest 3, 2026-08-04

**`WEBGL_multi_draw` is present. `BatchedMesh` batches. The core thesis holds.**

| Instances (BATCHED) | Draw calls | Triangles (`renderer.info`) | Framerate |
|---|---|---|---|
| ≤ 2,000 | 6 | **~800k** | **72-80, buttery** |
| 4,000 | 6 | ~1.5M | ~30-35 |
| 8,000 | 6 | ~3M | ~15, nauseating |

**Draw calls stayed flat at 6 from 250 instances to 8,000.** That is the whole thesis, confirmed: object count is now decoupled from draw calls, and the §5 architecture is sound.

**The bottleneck moved to geometry throughput, which is the good failure mode** -- it is exactly what LOD and billboarding attack. The placeholder props run ~200 tris/instance at *full detail regardless of distance*, because the spike deliberately has no LOD.

### Working ceiling: ~800k triangles per frame, as the HUD reports it

**Budget against the `renderer.info` number directly.** Do not divide it by two for "per eye" -- whether that counter double-counts stereo passes was never established on-device, and the whole quantity is only useful as a number the HUD can be compared against. 800k is smooth, 1.5M is 30-35 fps, and the cliff between them is steep.

This is roughly **half** the headroom an earlier draft of this section claimed (it mistakenly recorded the 1.5M *failure* point as the ceiling), so the LOD arithmetic has to be more aggressive than a casual reading of §5 suggests:

| Tier mix | Avg tris/prop | Props affordable in a 400k prop budget |
|---|---|---|
| 15% LOD0 (300) / 35% LOD1 (100) / 50% billboard (4) | ~82 | ~4,900 |
| 10% LOD0 (300) / 25% LOD1 (100) / 65% billboard (4) | ~58 | ~6,900 |

The lush-world target is reachable, but **only with billboards as the majority tier, not the fallback tier.** LOD is not an optimization here, it is load-bearing.

Caveats on what this run did *not* establish:

- **The BATCHED-vs-INDIVIDUAL comparison was inconclusive, and that is expected.** INDIVIDUAL was not much slower at 4,000 because at ~190 tris/instance the scene is geometry-bound long before draw-call submission matters. Batching's win shows up in the opposite regime -- thousands of *cheap* objects (4-tri billboards, grass tufts), which is precisely the regime the real world lives in. The 4,000 cap in INDIVIDUAL mode is a hardcoded guard in `main.js`, not a device limit.
- Not yet read off the HUD: `MAX_ARRAY_TEXTURE_LAYERS`, foveation delta, 90 Hz behavior, 20-minute thermal soak.

### Fallback if `WEBGL_multi_draw` is absent

Moot -- it is present. Retained for the record: fall back to one `InstancedMesh` per (asset type × LOD tier × chunk), which costs more draw calls and shrinks the §5 asset variety budget substantially.

---

## 1. Platform decision

**WebXR, three.js, WebGL2.** Deployed as static files to `topherhunt.com/games/aurora` via GitHub Pages. She opens a URL.

Rejected alternatives, with reasoning preserved so we do not relitigate:

- **Unity WebXR Export** -- worst of both worlds. Unity WebGL's wasm/GC overhead on top of browser overhead, community-maintained, with open issues reporting ~45 FPS ceilings on Quest 3.
- **Native APK (Unity/Godot) sideloaded** -- genuinely 3-5x more headroom (native does 300-500 draw calls and 1M+ tris/frame vs. WebXR's ~150-200 calls/eye and ~250-400k tris/eye). Rejected because it requires physical access to the headset plus developer mode on her Meta account. Note: hosting an APK on GitHub Pages does **not** work. Horizon OS has no install-from-browser path.
- **Native via Horizon Store private release channel** -- clean install experience, no content review, 200-user default. Rejected due to verified-developer-org bureaucracy and 90-day expiring invite URLs.
- **WebGPU / `WebGPURenderer` / TSL** -- **explicitly dropped.** Quest support for `XRGPUBinding` is unconfirmed, Chrome's implementation is Windows/Android-XR behind two flags, and Brandon Jones (WebXR spec editor) states directly that WebGPU-in-WebXR is "not necessarily expected to be an automatic performance win vs. WebGL at this point" due to internal texture copies. **Consequence: shaders are GLSL via `onBeforeCompile`, not TSL.** A deliberate one-way door, walked through knowingly.

The porting escape hatch: terrain generation, hydrology, biome assignment, and placement are all plain math in Web Workers with no three.js dependency. If we ever hit a wall, that code ports to Godot 4 in a weekend and only the render layer is thrown away. **Keep the sim layer free of three.js imports.**

---

## 2. World structure and resolution

**Bounded world: 16 km × 16 km.** Bounded is a feature -- coherent hydrology needs to know where the outflow is, and infinite terrain with correct rivers is an open research problem. At walking pace she will never find an edge.

### Resolution: three distinct grids, do not conflate them

This is the answer to "does a 7.8 m cell mean 8 m flat polygons?" -- **no.** There are three separate resolutions and only the finest one is ever rendered.

| Grid | Resolution | What it is for | Rendered? |
|---|---|---|---|
| **Global sim grid** | 2048² over 16 km = **7.8 m/cell** | Macro topology, flow routing, lake levels, biome fields, village siting | Never |
| **Chunk heightmap** | **0.5-1 m/cell** | The actual terrain surface, generated per chunk on demand | Yes |
| **Rendered mesh** | Varies by LOD ring | What the GPU draws | Yes |

The global grid decides *where water flows*. The chunk heightmap decides *what the ground looks like*. A stream whose route is computed at 7.8 m resolution is then **carved into the 0.5-1 m chunk heightmap as a channel 1-4 m wide**, which is 2-8 chunk cells across. Perfectly representable.

Two real consequences of coarse routing, both handled:

- **D8 flow paths are quantized to 45° steps** and look like staircases if used raw. Fit a Catmull-Rom spline through the D8 path points and resample at sub-meter spacing before carving. The spline is the stream centerline; the 7.8 m grid never appears in the output.
- **Streams below the accumulation threshold do not exist.** Stream density is a single tunable (lower threshold = more, smaller headwater streams = more ribbon geometry). Tune it by eye.

If stream topology turns out too sparse even at a low threshold, the option is a 4096² global grid (3.9 m/cell), but note the cost: 16M cells, ~64 MB per float32 layer, several layers plus priority-flood's working set. Expect to push past 300 MB transient in the worker. Try tuning the threshold first.

### Phase A -- global pass, once at load, in a Web Worker

Operates on the 2048² grid. Produces the skeleton of the world:

1. **Elevation** -- see §3, this is not plain Perlin
2. **Priority-flood** depression filling. Anything that fills becomes a **lake** at its spill elevation
3. **D8 flow direction + flow accumulation** over the filled surface. Cells above threshold become **rivers/streams**; width scales with sqrt(accumulation), so tributaries merge naturally
4. **Channel carving** -- subtract a channel profile along the splined flow paths. Carve depth scales with `accumulation × local_slope`, which is what produces **gorges and canyons** where fast water cuts through steep terrain, and shallow meanders on valley floors. Physically motivated and free. (Skipping this step entirely is the classic failure mode where rivers run over hilltops.)
5. **Moisture field** = distance-to-water from the flow/lake mask. Free, and it is what makes biomes feel earned rather than noise-driven
6. **Village siting** -- score valley-floor cells by (low slope) × (proximity to fresh water) × (not in a lake) and pick local maxima with a minimum separation
7. **Traversability + connectivity validation** -- see §4

Expect ~100 MB transient and 1-3 seconds of compute at 2048². Acceptable as a one-time load cost.

### Phase B -- per-chunk detail, on demand, in a Web Worker

Interpolate the global grid, add high-frequency detail noise (§3), apply carved channels, place props (§6), bake lighting (§8). Transfer results as `ArrayBuffer`s. **Never generate terrain on the main thread** -- hitches read as stutter in VR, which is worse for comfort than a lower average framerate.

### Biomes

`biome = f(elevation, moisture, temperature-noise)`:

- High + dry -> bare rock, snow, sparse windswept pines
- High + moist -> dense pine
- Mid -> mixed pine and scrub, heather
- Low + dry -> heather, scrub brush, exposed rock
- Low + moist (river valleys) -> lush growth, broadleaf, tall grass; where this coincides with a village site, cleared/managed land

Blend biome weights rather than hard-switching. Perturb the biome lookup with low-frequency noise so borders wander instead of following clean contour lines.

---

## 3. Terrain character: cliffs, gorges, gullies

Plain multi-octave Perlin produces rolling blobby hills and nothing else. It is the single biggest reason procedural terrain looks procedural. Five techniques, layered:

1. **Ridged multifractal** (`1 - abs(noise)`, accumulated across octaves) -- produces sharp ridgelines and knife-edge arêtes instead of rounded domes. This is the backbone of the mountain layer.
2. **Domain warping** -- perturb the noise input coordinates by a second noise field before sampling. Cheap, and it is what turns symmetric blobs into twisted, organic, geologically plausible shapes. Probably the highest ratio of visual payoff to code in the entire terrain system.
3. **Stratification / terracing** -- quantize elevation into bands with a sharp smoothstep between them, producing mesa edges and cliff bands. Gate it behind a mask so only some regions terrace; uniform terracing looks like a wedding cake.
4. **Variance masking** -- multiply detail-octave amplitude by a low-frequency mask so some regions are smooth (rolling alpine meadow) and others are chaotic (shattered broken ground). This is what gives "different levels of variation" rather than uniform noisiness everywhere.
5. **Worley/Voronoi cell noise** for plateau and cliff boundaries -- gives angular, fractured, geological breaks rather than round ones.

**Gorges and gulches come primarily from hydrology, not noise.** The `accumulation × slope` carve depth in §2 cuts genuine canyons exactly where a river cuts through steep terrain, which is where canyons actually are. Noise-based gulches on their own look arbitrary; hydrological ones look inevitable.

### Two hard constraints

- **Heightmaps cannot represent overhangs, arches, or caves.** One elevation per XZ, period. No natural bridges, no cave mouths. Accepted.
- **Near-vertical cliffs stretch triangles and UVs badly.** Solved by **triplanar mapping** on the terrain material (§7), which blends three axis-aligned projections weighted by the surface normal. Costs 3x texture samples, mitigated by lerping toward triplanar only where slope is high.

---

## 4. Traversability: making traps impossible by construction

Requirement: deep gulches she cannot cross or might get trapped in, but never actually stuck.

The naive solution -- "prop placement guarantees an exit" -- is fragile and hard to verify. Do this instead:

**Enforce a maximum walkable slope in the locomotion controller (~35-40°), with no falling and no sliding.**

If she cannot walk onto terrain steeper than 35°, she can never *descend into* a region she cannot climb out of. Traversability is symmetric (a slope is the same slope in both directions), so any place she can reach, she can leave. **Traps become impossible by construction rather than by careful level design.**

Gulches, cliffs, and gorges then function exactly as intended: hard visual barriers she must path around, forcing the wending route up each valley. She can stand at the lip of a canyon and look down into somewhere she cannot go, which is better scenery than somewhere she can.

Two supporting pieces:

- **Connectivity validation in Phase A.** Build a coarse walkable mask (slope < max, not deep water), flood-fill from spawn, and verify every village and the summit are in the reachable set. If not, either lower the path-carving slope penalty (§6) or reseed. Log loudly on failure -- do not ship a world with an unreachable summit.
- **An "unstick" binding** that teleports to the nearest walkable cell. Pure insurance against a collision bug. Cheap, and the alternative is her removing the headset.

Water: shallow water is walkable, deep water is not. Same mask, so lakes are barriers and stream crossings are not.

---

## 5. Rendering architecture

### The load-bearing decisions

1. **`THREE.BatchedMesh`, not `InstancedMesh`.** `InstancedMesh` draws N copies of one geometry. `BatchedMesh` uses `WEBGL_multi_draw` to draw many *different* geometries in one call, provided they share a material. The entire prop library -- every tree variant, rock, building, and LOD tier -- collapses into a handful of draw calls. Per-object frustum culling is built in. LOD switching is `setGeometryIdAt(instanceId, geometryId)`: one call, no rebuild, no change in draw call count.
2. **One material for all props**, backed by one `sampler2DArray`. See §9.
3. **Alpha test, never alpha blend, for anything batched.** See §7.

4. **Terrain goes through `BatchedMesh` too** -- decided at build step 2, and not what the original draft assumed. See below.

Water, sky, and weather each get their own material and their own draw calls. That is expected and budgeted.

### Terrain is batched, for the same reason props are

The first draft of this section said terrain "gets its own material and its own draw calls. That is expected and budgeted," on the assumption that a quadtree produces a handful of chunks. It does not. At the shipped step-2 parameters the selector returned **502 leaves**, which as one `THREE.Mesh` per chunk is 502 draw calls against the 60 the §0 measurements allow -- before a single tree exists.

So terrain uses one `BatchedMesh` with a pre-allocated pool of fixed-size geometry slots, and streaming a chunk in is `setGeometryAt()` on a recycled slot rather than an add/remove from the scene graph. **The whole 16 km world is one draw call.**

This is legal only because every chunk has identical topology -- same `CHUNK_RES`, therefore the same vertex and index count -- so a freed slot always fits whatever arrives next. **If chunk resolution ever varies by LOD level, the slot pool has to become size-classed.** That is the constraint to remember before "optimising" coarse rings to a lower resolution.

Verified on `three@0.180`: `setGeometryAt` reuses a slot in place and throws only if the incoming geometry exceeds the reserved counts; it re-clones `boundingSphere` from the source on every call, so per-instance frustum culling stays correct across reuse; and the batch index widens to `Uint32` automatically once the pooled vertex count passes 65535.

### Budget

Per eye, at 72 Hz, targeting ~250k triangles with headroom. three.js renders once per eye (no multiview -- `OCULUS_multiview` has never been merged into three.js core), so `renderer.info` reports roughly double these figures.

**Measured ceiling (§0): ~800k triangles per frame as `renderer.info` reports them.** 1.5M drops to 30-35 fps.

There is roughly 2× headroom, not the 4× an earlier draft assumed. Treat the per-layer numbers below as a budget to be *defended*, not a floor to build up from. If a layer wants more, another layer gives it up.

| Layer | Visible count | Tris each | Total |
|---|---|---|---|
| Terrain (all LOD rings) | 304 chunks | 640 | 98k |
| Trees 0-30 m | 40 | 600 | 24k |
| Trees 30-80 m | 200 | 150 | 30k |
| Trees 80-500 m (cross-quad) | 2,000 | 4 | 8k |
| Grass/scrub 0-25 m | 3,000 | 4 | 12k |
| Rocks (tiered) | ~400 | -- | 20k |
| Village buildings | 20 | 800 | 16k |
| Water surfaces | -- | -- | 5k |
| Snow particles | 1 draw | -- | 4k |
| Sky dome + aurora | -- | -- | 2k |
| **Total** | | | **~219k** |

2,240 trees, 3,000 grass tufts, and a village visible simultaneously. **Every row except terrain is still an estimate.** Terrain is measured (step 2): 304 chunks × 640 tris = 195k as `renderer.info` reports it, 24% of the ceiling, *before* per-instance frustum culling -- which removes most of the ring behind her, so the drawn figure is lower and the pre-cull number is the safe one to budget against.

~219k/eye is ~438k as the HUD reports it, **~55% of the measured ceiling**, leaving roughly 360k for water, weather, thermal margin, and the props these estimates get wrong.

### Download budget -- a non-issue, which is the liberating part

- Texture arrays, 128×128 × ~150 layers, RGBA8: ~9.8 MB uncompressed, **~1.5 MB with ASTC 6×6**. See §9 -- compression is required, not optional
- ~80 assets × ~500 tris, meshopt-compressed: **~1-2 MB**
- World data: **0 bytes** (it is a seed)

**Under 10 MB total.** Go wide on asset variety. The constraint is `MAX_ARRAY_TEXTURE_LAYERS` and Meshy generation time, not bandwidth.

### Distance tiering

**Terrain LOD:** quadtree chunks at a **constant** `CHUNK_RES` (16), subdividing when the camera is closer to a node than `splitK` times its own edge length. Chunk size halves with depth; vertex *density* therefore doubles, but vertex *count* stays fixed -- which is what lets every chunk share one slot size in the batch. **Skirts** (vertical flanges at chunk edges) hide cracks between adjacent levels -- far simpler than stitching and invisible in practice. Fog and atmospheric desaturation hide popping and do most of the work of selling scale.

Measured at step 2, `res 16 / splitK 1.3 / MAX_DEPTH 10`: 304 leaves, 195k tris (24% of budget), 16 m leaves at 1.00 m per cell, ~2.75° angular error. The three parameters are one decision, not three -- see the derivation at the top of `src/terrain/quadtree.js`, including why raising `CHUNK_RES` to buy back `splitK` costs *more* triangles at equal quality rather than fewer. `splitK` is live-tunable with `[` and `]` because 2.75° is a judgement call that has to be made looking at ridgelines.

**Prop LOD:**

| Range | Treatment |
|---|---|
| 0-30 m | Full mesh (~600 tris) |
| 30-80 m | Reduced mesh (~150 tris) |
| 80-500 m | Cross-quad billboard (4 tris), per-instance random Y-rotation so the forest does not shimmer with a visible grain |
| > 500 m | **No individual objects at all** |

**Beyond 500 m: bake the forest into the terrain.** Use the same noise field that *would have* placed trees to modulate the terrain material's albedo and normal (darker, greener, mottled), plus sparse "forest clump" billboards where one quad represents ~20 trees. This is what shipped open-world games do. Sparse individual billboards at distance look like a comb-over; a modulated terrain material reads as continuous forest cover and costs essentially nothing.

### Per Meta's WebXR best practices

- Sort opaque front-to-back
- **One real-time light maximum** (the sun/moon directional). Everything else is baked -- §8
- **No shadow map passes** -- they double draw calls
- KTX2/Basis texture compression throughout
- Stagger CPU work: sway, weather, and animation logic at 30 Hz while rendering at 72 Hz
- Render alpha-tested foliage *after* all opaque geometry

---

## 6. Procedural placement

Per chunk, in the worker, deterministic from `hash(worldSeed, chunkX, chunkZ)`:

- Poisson-disc or jittered-grid scatter, with density and species mix driven by biome weights
- Reject on slopes above threshold, in water, on paths, on packed dirt, or inside village footprints
- **Per-instance random Y-rotation and non-uniform scale** (0.8-1.3x, with slight independent vertical stretch). This is most of what makes a procedural forest stop looking procedural
- Align to terrain normal but only partially (lerp ~30%) so trees on slopes lean slightly rather than growing perpendicular to the hillside

### Paths

Paths are what turn a heightfield into a place. Generate as least-cost routes (A\* with a slope-penalized cost function) between points of interest -- village to village, valley floor to summit. Then:

- Clear props within the path corridor
- **Increase** prop density immediately alongside it (bushes, rocks, boulders) to create the walled, wending, "you must follow this" feeling
- Paint the path corridor into the **packed-dirt splat channel** (§7), which both textures it and suppresses foliage -- one mask, two uses
- Flatten terrain slightly along the corridor

The slope penalty is what makes paths switchback up mountainsides naturally rather than beelining. It also means A\* failing to find a route is a **signal that the terrain is not traversable**, which feeds §4's connectivity validation.

---

## 7. Terrain material and transparency

### Splat blending: 4 layers, 4 channels

| Layer | Placement rule |
|---|---|
| **Snow** | Elevation above snowline, plus noise, plus weather accumulation (§10). Reduced on steep slopes -- snow does not cling to cliffs |
| **Rock** | Slope above threshold. Dominant on cliffs and gorge walls |
| **Grass** | Low elevation + moisture. Warmer valleys |
| **Packed dirt** | Path and village masks (§6) |

Weights pack into a single RGBA texture -- four layers, four channels, exactly. Two implementation notes that matter for how it looks:

- **Height-blend, do not linear-lerp.** Give each layer a height/roughness map and blend by `max(weight + height)` rather than a weighted average. This is the difference between snow *settling into* rock crevices and snow *fading uniformly* over rock. It is a few lines of shader and it is the single biggest quality lever on the terrain.
- **Triplanar on steep slopes only.** Lerp toward triplanar projection as slope increases, rather than applying it everywhere. Avoids stretched cliff textures at 1/3 the average cost.

The terrain uses its own material with small tiling textures -- **not** the prop atlas, since atlas tiles cannot wrap. This is a deliberate exception to the one-material rule and costs one draw call family.

### Transparency: alpha test, never alpha blend

`material.alphaTest = 0.5`, binary cutout, no partial alpha.

Not merely a preference: alpha blending requires back-to-front sorting, cannot write depth, and **fundamentally cannot be sorted within a batched or instanced draw call**. It is architecturally incompatible with §5. Alpha test writes depth, needs no sorting, batches cleanly.

Two caveats, neither fatal:

- On Adreno tile-based GPUs, `discard` disables early-Z for that draw. Render alpha-tested foliage **after** all opaque geometry so it still benefits from the opaque depth prepass.
- Alpha-test edges alias badly against MSAA. Set `alphaToCoverage = true`; cheap, and it cleans this up.

True alpha blending is reserved for **the aurora**, **fog/mist cards**, **water**, and **snow particles** -- all of which are small in number and sort trivially.

---

## 8. Lighting, shadows, and the day/night cycle

**24 real minutes = 24 in-world hours.** One real minute per in-world hour.

### Technique: horizon mapping

For each terrain texel, precompute the **horizon elevation angle** in N azimuth directions (N = 16) by raymarching the heightmap. Store as a texture. At runtime:

```
sunOccluded = smoothstep(horizonAngle - softness, horizonAngle + softness, sunElevation)
```

where `horizonAngle` is bilinearly interpolated between the two azimuth slices nearest the sun's current azimuth.

Horizon maps are **computed once and valid for every sun position**, which is what makes a continuously moving sun affordable. This gives:

- **Continuous sun movement** with no re-baking, no crossfade artifacts, no periodic hitches
- **Soft, blurry shadow edges** for free -- the `smoothstep` band replaces a hard step, and band width is a single tunable
- Correct behavior at grazing dawn/dusk angles, which is where long mountain shadows look best

### Separate AO bake for crevice deepening

Shadow (directional occlusion) and ambient occlusion are different terms and must be computed separately. Bake a **sky-visibility / AO value** per texel once at generation. It is sun-independent, so it is computed exactly once and never recomputed. This is what deepens gorges, gullies, and cliff bases regardless of sun position -- and gorges are a headline feature, so this term is doing real work.

```
terrainLight = sunColor * NdotL * (1 - sunOccluded) + ambientColor * ao
```

Ambient color is driven by time of day (warm at dusk, deep blue at night, tinted green when the aurora is active).

### Props inherit terrain lighting

In the vertex shader, use the instance's world XZ to compute a UV into the horizon map and AO texture, sample both, pass the resulting scalar to the fragment shader as a varying, multiply into albedo.

Trees on the shadowed side of a ridge are darker than trees catching the sun; props tucked into gullies pick up the crevice darkening. All automatic, all consistent with the terrain they stand on, for the cost of two vertex-shader texture samples. **No per-instance attribute needed**, which is why `batched-mesh-extensions` is not required (see §13).

### Resolution strategy (most likely part to need tuning)

Horizon maps at 16 azimuths cost 16 bytes/texel. Two tiers:

- **Global coarse:** 1024² over 16 km (15.6 m/texel), ~16 MB, computed once at load. Macro "which side of the mountain" shadowing for distant terrain
- **Per-chunk fine:** ~1 m/texel, computed in the worker as chunks stream in within the detail radius. Crevice-scale detail near the player

Blend by distance. **If the fine tier proves too expensive, ship the global tier alone** -- macro mountain shadows are 80% of the payoff, and the AO bake (cheap, sun-independent) carries crevice detail on its own.

### Other lighting

- **Blob shadow decals** under props for contact shadow
- **AO baked into each asset's own texture/vertex colors** during the Blender pass
- One real-time directional light for sun/moon. Nothing else

---

## 9. Asset pipeline

### Bootstrap assets (in hand)

`tmp/placeholder-props/Ultimate Nature Pack - Jun 2019/` -- 150 Quaternius CC0 meshes in OBJ/FBX/Blend. Key findings from inspection:

- **No textures and no UVs at all.** Each mesh carries 2-3 materials that are solid `Kd` colors (`Green`, `Wood`). Flat-shaded.
- Poly counts are above target: `CommonTree_1` = 1,444 tris, `PineTree_1` = 958, vs. a 600-tri LOD0 budget. **Decimation is required even for these.**
- `Rock_1` = 36 tris. Rocks are already fine.
- **`_Snow` variants exist for nearly every species** (`PineTree_Snow`, `CommonTree_Snow`, `BirchTree_Snow`, `Bush_Snow`, `Rock_Snow`, `TreeStump_Snow`, `Willow_Snow`). Directly usable for a snowy mountainscape and for a snow-accumulation swap.
- ~40 distinct species prefixes, most with 5 variants each. Ample variety for the whole project.

Also present: `tmp/placeholder-props/high-poly-to-decimate/` -- 23 zipped higher-poly assets (cabins, watchtower, windmill, boulders, ferns, grasses) needing heavy decimation.

### Texture array, not atlas

**Art direction, stated precisely so it does not drift again: low-poly geometry with N64-resolution textures.** Ocarina/Majora, or a lower-res Skyrim. Explicitly **not** the flat-shaded untextured low-poly look. The Quaternius bootstrap assets happen to be flat-colored; that is a property of the placeholders, not the target.

Textures live in a **`DataArrayTexture`** rather than a packed 2048² atlas. Each vertex carries a `texLayer` index attribute; the shader samples `texture(sampler2DArray, vec3(uv, layer))`. One texture binding, so still one material, so `BatchedMesh` still batches everything (§5). Layer sizing is settled below -- 128×128, in two arrays.

Why the array wins at this texture size:

| | Atlas | Texture array |
|---|---|---|
| Mip bleeding | Neighboring tiles blend at coarse mips. Padding mitigates, never fixes | None -- layers mip independently |
| Padding overhead | A 32px tile needs ~4px borders to survive mip 2 → 40×40, **+56%**. Surviving mip 3 needs 8px → **+125%** | None |
| UV tiling / wrapping | Impossible. Cannot repeat bark up a trunk | Native per layer |
| Pipeline | Pack + rewrite every asset's UVs | Assets keep native 0-1 UVs |
| Size flexibility | Any tile size | **All layers identical dimensions** |

### On the uniform-size constraint

It is a real constraint, but at N64 resolutions its cost is negligible, and the atlas alternative does not actually buy variable resolution for free either -- it just trades uniform-size waste for padding waste, at roughly the same magnitude.

The numbers:

- 64×64 RGBA8 = **16 KB/layer**. Storing a 32×32 texture in a 64×64 layer wastes 12 KB. A hundred such assets waste **1.2 MB**. Irrelevant against a 10 MB budget.
- An atlas would have spent a comparable amount on padding those same 32px tiles (+56% each), so the array is not meaningfully more wasteful. It is just wasteful in a different place.

**The constraint that actually binds is different from the one that looks like it binds.** It is not atlas *area* (2048²/64² = 1024 slots) -- it is `MAX_ARRAY_TEXTURE_LAYERS`, which WebGL2 only guarantees to be **≥256**. The spike (§0) prints the real value for Quest.

### Correction: "layers are per surface, not per asset" does not survive a Meshy pipeline

An earlier draft claimed 256 layers is roomier than it sounds because a layer is a *surface* (bark, needles) shared across every species, so forty trees cost a dozen layers. **That is true only of a hand-authored library, and this project does not have one.**

Meshy emits, per generated asset, a mesh with an auto-generated UV unwrap and its own baked texture set. Bark and needles land in one image in one bespoke UV layout. Nothing is shared with the next generated asset, and there is no non-manual way to make it shared -- extracting a tiling bark texture out of a Meshy unwrap and re-unwrapping the trunk to tile it is exactly the hand-artist labor the pipeline exists to avoid.

**So the honest accounting is one layer per asset, scaling linearly.** ~150 assets = ~150 layers. Still inside the ≥256 guarantee, but with far less slack than the surface-sharing story implied, and worth re-checking against Quest's actual reported value.

### Two texture classes, which is what actually drives sizing

The pipeline produces two genuinely different kinds of texture, and conflating them is what made 64×64 look sufficient:

| | **Class A -- tiling surfaces** | **Class B -- per-asset UV atlases** |
|---|---|---|
| Source | Hand-made or procedural, a handful total | Meshy output, one per asset |
| Content | One material, repeating (snow, rock, grass, dirt, bark) | An entire object's unwrap |
| UVs | `RepeatWrapping`, scaled by world size | Native 0-1, `ClampToEdge` |
| Count | ~8-16 | ~1 per asset, ~150 |
| Size needed | **64×64 is fine** -- it tiles, so texel density comes from repetition | **128×128 minimum** |

The Class B floor is the point. A 64×64 covering a whole tree's unwrap gives each surface maybe 16×16 of effective resolution -- that is mud, not N64. Ocarina's textures were 32×32 *per tiling surface*, which is a completely different quantity than 32×32 per object. **Base the array at 128×128** and let Class A layers simply be upsampled or authored at 128.

Cost at 128²: 64 KB/layer RGBA8, ~150 layers = **~9.8 MB uncompressed**. That is over the §5 download figure, so ASTC/KTX2 compression moves from "nice" to **required** (ASTC 6×6 lands it near 1.5 MB). Verify the KTX2 array round-trip early -- it is now load-bearing rather than a convenience.

### The two-array split, no longer hypothetical

Class A wants small and `RepeatWrapping`; Class B wants larger and `ClampToEdge`. Wrap mode is per-texture, not per-layer, so **these cannot share one array anyway** -- the split is forced by the sampler, not chosen for resolution.

Bind both to the same material: `uArrTile` (128², repeat) and `uArrAsset` (128² or 256², clamp), selected by a per-vertex tier attribute. Still one material, still one batch; costs one extra texture unit of the ≥16 WebGL2 guarantees. Caveat: sampling inside non-uniform control flow with automatic mip derivatives is undefined in GLSL ES 3.00, so sample both and select, or use `textureGrad` with explicit gradients.

Build this at §14 step 4, when the first real Meshy asset arrives -- not before. The spike's single 64×64 array is correct for the spike.

### Where variety comes from instead

Since texture sharing is unavailable, variety has to be generated in the **shader**, and this is cheaper than making more textures anyway:

- **Per-instance tint.** A hue/value multiply keyed off the instance's world position gives eight visually distinct birches from one layer. Nearly free.
- **Procedural snow accumulation.** Blend toward the snow layer by upward-facing normal, modulated by elevation and the weather state (§10). One asset serves as both its bare and snow-covered variant, which halves what Meshy has to generate.
- **Rotation, non-uniform scale, slight lean** -- already planned in §6.

This is a better fit for an AI-generation pipeline than texture reuse would have been: Meshy produces *shapes*, and the shader produces *variation on* those shapes.

### Headless Blender pass

Fully scripted: `blender --background --python pipeline.py`

1. **Import** OBJ/FBX/GLB
2. **Decimate** to per-LOD budgets (600 / 150 / billboard)
3. **Bake AO** into the asset's own texture
4. **Downscale** each texture to 128×128 and emit it into the Class B array; assets keep their native UVs
5. **Generate billboard** by rendering LOD0 to a cross-quad texture, also as a layer
6. **Compress** -- meshopt for geometry, ASTC/KTX2 for the arrays
7. **Export** a single GLB of all geometries plus the arrays as side-loaded assets

⚠️ Verify that KTX2/Basis round-trips array textures through three's `KTX2Loader` **before generating assets in bulk**. At 128×128 × 150 layers the uncompressed fallback is ~9.8 MB, so unlike the earlier 64×64 estimate this is no longer a shrug -- it would force either fewer assets or a drop back to 64×64.

⚠️ **Blender is not currently installed on this machine** (not on PATH, not in `/Applications`). Needed before step 4 of §14. For the spike, geometry is loaded and processed at runtime in JS instead.

Get **one** species through end-to-end before doing forty. The atlas packing and UV rewrite are where this pipeline will break, and it is much cheaper to debug with one asset.

---

## 10. Weather

**Randomly varying snowfall, heavier with elevation.**

- **Particles:** a single fixed-size box (~30 m) of instanced quads or points centered on the player, wrapping modulo as she moves. Constant cost regardless of world size -- the classic technique. One draw call.
- **Additive blend, not alpha blend.** Snow at night is bright specks against dark; additive needs no sorting and sidesteps §7's transparency constraint entirely.
- **Intensity** = `weatherState × elevationFactor`. `weatherState` is low-frequency noise over time, giving squalls that come and go. `elevationFactor` ramps with altitude, so summits are stormier -- which also makes the climb feel like it costs something.
- **Coupling:** heavy snow raises fog density, cuts draw distance (a perf win exactly when the GPU is busiest), and mutes the aurora.
- **Accumulation:** lerp the terrain's snow splat weight (§7) toward 1 based on a slowly-varying accumulation scalar, and swap prop geometry IDs to `_Snow` variants above a threshold via `setGeometryIdAt`. Nearly free, and it makes weather feel consequential rather than cosmetic.

⚠️ Watch overdraw: snow particles are a fullscreen-ish alpha source and mobile GPUs are fill-rate bound. Keep the box small, the particles small, and the count modest. This is a likely candidate for the first thing to dial back if frametime is tight.

---

## 11. Water

From the Phase A hydrology (§2):

- **Lakes:** one flat plane per body, at the spill elevation from priority-flood
- **Rivers and streams:** ribbon mesh extruded along the splined flow paths, width from sqrt(accumulation), sitting in the channel carved into the chunk heightmap

Shading:

- Two scrolling normal maps at different scales/speeds to break up tiling
- Fresnel term
- Skybox/environment cubemap sample
- Moon specular highlight
- **No screen-space reflections.** Far too expensive, and at night nobody will miss them

---

## 12. Locomotion and comfort

She is a first-time-ish VR user. Comfort outranks capability.

- **Left stick forward only.** Push up to walk in the direction she is facing. No strafe, no backward.
- **Snap turn 60°** by tilting either stick left or right. (Note: 30-45° is the more common choice; 60° is a larger vestibular jump but fewer of them. Implemented as a single tunable constant -- easy to change after trying it.)
- **Eased acceleration to ~1.3-1.5 m/s** (normal walking pace). The ease-in curve is what prevents nausea, not the top speed. Instant stop on release.
- **Comfort vignette** tunneling peripheral vision during movement, tightening with speed
- **Damp vertical camera motion** on slopes. Pitch and bob from naive terrain-following is a major nausea source
- **Max walkable slope ~35-40°**, no falling, no sliding (§4)
- **'A' toggles teleport mode** for covering distance
- **Recenter** binding (long-press a face button)
- **Unstick** binding (§4)

### Pacing

At 1.4 m/s, 800 m takes ~9.5 minutes. Against a ~15-20 minute thermal window, the summit should be roughly 10-12 minutes of walking from spawn. Place spawn accordingly.

---

## 13. Aurora and sky

**The aurora appears randomly at night, anywhere in the world** -- not gated on altitude. Summits simply give a better view: less terrain occlusion, less atmospheric haze, and a modest intensity boost with elevation.

This is driven by the same low-frequency-noise-over-time mechanism as weather (§10), gated to night hours. Squalls of snow and curtains of aurora both come and go, which makes the world feel like it has moods.

- Rendered on the sky dome or a band of geometry inside it, **not** as a fullscreen pass. Fill rate is the constraint on mobile GPUs; dome geometry bounds the cost
- Scrolling FBM/curl noise, additive blend, vertical gradient falloff
- Keep the fragment shader short -- this is the one place a long shader will show in frametime
- Tint scene ambient green as it strengthens, so it affects the world rather than sitting on a separate layer

Also on the dome: starfield (slowly rotating), moon, wispy drifting cloud layer (two scrolling alpha-blended layers).

---

## 14. Build order

1. ~~**§0 spike.**~~ **DONE.** `WEBGL_multi_draw` confirmed, `BatchedMesh` confirmed batching (6 draw calls at 8,000 instances), ceiling measured at ~800k tris/frame as the HUD reports it. In-world HUD built, preserved at `spike.html`. Still to read off the HUD on the next headset visit: `MAX_ARRAY_TEXTURE_LAYERS`, foveation delta, 90 Hz, 20-minute soak.
2. **Terrain + locomotion vertical slice.** Worker-generated quadtree terrain with skirts, heightmap collision, slope limiting, eased locomotion, vignette, snap turn, recenter. **Get this to a stable 72 Hz with an empty world before adding a single tree.**
   **Code complete and checked headlessly** (`npm run check`): sim layer validated (relief, slope distribution, winding, spawn connectivity), terrain streaming drilled over an 18 km walk (slot accounting, eviction, geometry placement), empty world at 195k tris / 1 draw call. **Not yet run on a screen or in a headset** -- shader compilation, the look of the terrain, and comfort are all unverified.
3. **Phase A global pass.** Elevation (§3), priority-flood, flow accumulation, biomes, village siting, connectivity validation. Pure math, no rendering, most reusable code in the project. Debug it with a 2D canvas map view before it ever renders in 3D.
4. **Asset pipeline + `BatchedMesh` + texture array.** One species end-to-end. Requires installing Blender.
5. **Placement, paths, LOD tiering.** The lushness pass. **Build LOD tiering in the same step as placement, never after it** -- §0 measured that undifferentiated full-detail props hit the triangle ceiling at ~4,000 instances, well under the density this world needs. A placement system without LOD cannot be evaluated, because it will be unplayable for reasons that have nothing to do with placement.
6. **Terrain material.** Splat blending, height-blend, triplanar.
7. **Lighting.** Horizon maps, AO bake, prop light inheritance, day/night cycle.
8. **Water.**
9. **Weather.**
10. **Aurora and sky.**

---

## 15. Decisions deliberately deferred

- **`batched-mesh-extensions`** -- offers BVH culling, LOD helpers, and per-instance uniforms. The per-instance uniform need is eliminated by §8's texture-sampling approach. It is a single-maintainer package sitting under a core system. Validate stock `BatchedMesh` first (§0); adopt only if culling or LOD bookkeeping measurably becomes the bottleneck.
- **4096² global sim grid** -- only if stream density is unsatisfying at a low accumulation threshold, and only with the memory caveat in §2.
- **Per-chunk fine horizon maps** -- ship global-tier-only if too expensive (§8).

## 16. Open questions

- ~~Does Quest Browser expose `WEBGL_multi_draw`?~~ **Yes** (§0)
- ~~What are the real draw call and triangle ceilings?~~ **6 draw calls flat; ~800k tris/frame as HUD-reported** (§0)
- ~~Is 64×64 the right base texture size?~~ **No -- 128×128, in two arrays** (§9)
- Is 60° the right snap angle, or does it want to be 45°? (§12 -- try it)
- Is ~2.75° of terrain LOD error acceptable on ridgelines, or does `splitK` need to go up? (§5 -- `[` `]` on desktop; costs 33% of budget at 1.6, 45% at 2.1)
- Does the coarse ancestor poke through finer chunks while a new LOD ring streams in? (§5 -- expected artifact, needs eyes on it)
- Is 2048² adequate for global hydrology at 16 km? (§2)
- Does snow particle overdraw fit the fill-rate budget? (§10)
- What is Quest's real `MAX_ARRAY_TEXTURE_LAYERS`? (§0 prints it; §9 now needs ~150, not ~12)
- Does `KTX2Loader` round-trip array textures? (§9 -- now load-bearing at 128×128)
- Where does the frametime cliff sit once terrain, water, and weather share the budget? (§17 -- re-measure at each gate)

---

## 17. Development workflow: desktop-first, headset-gated

**Iterate in Chrome on the desktop. Verify in the headset at gates.** Deploy-and-don-the-headset is a ~2 minute round trip against a ~2 second one, and most of this project's work -- procedural generation, placement aesthetics, LOD popping, terrain material, lighting, the aurora -- is judged with the eyes and reads fine on a monitor.

### What desktop tells you honestly

Silhouettes, colour, biome transitions, path layout, village siting, LOD pop distances, shadow softness, water shading, sky and aurora. Triangle counts and draw calls are also literally true -- they just need doubling to compare against a headset number.

### What desktop actively lies about

This list is why the gates exist, not a disclaimer:

| Lie | Why |
|---|---|
| **Fill rate** | Quest renders ~2× the pixels at a higher effective resolution and is fill-bound far more often than a desktop GPU. Alpha-tested foliage overdraw looks free on a monitor and is not |
| **Stereo cost** | Everything CPU-side and every draw call happens twice; there is no multiview in three.js (§5) |
| **`discard` cost** | The early-Z penalty from `alphaTest` is an Adreno tiler behaviour with no desktop analogue (§7) |
| **Thermals** | Minute 3 and minute 20 are different machines. Only a soak finds the cliff |
| **Foveation** | No desktop equivalent; it is real headroom that only appears on-device |
| **Scale and comfort** | Tree height, locomotion speed, snap-turn angle, gorge depth, vignette strength. **Not assessable on a monitor at all.** A mountain that reads as majestic on a screen can read as a hill in VR |

### Making the desktop HUD tell the truth

The §0 HUD stays on desktop and gets a budget line: **red past 1.5M triangles or 60 draw calls** (frame totals, matching the headset's `renderer.info`). Desktop then flags a budget breach the moment it happens, instead of hiding it behind a 200 fps monitor framerate. This converts most performance regressions into desktop-visible failures and shrinks what the gates have to catch to genuinely device-specific effects.

### Gates -- put on the headset when

1. A **new material or shader** enters the scene (fill-rate and `discard` behaviour are unmeasurable on desktop)
2. **Instance density or LOD distances** change materially
3. **Anything transparent or full-screen** is added -- snow particles, fog, aurora, vignette
4. Anything touching **locomotion, scale, or comfort** -- always, no exceptions, and judge by feel rather than by numbers
5. The end of **each §14 build step**, with a 20-minute soak at the last one before it gets handed over

A gate visit is a checklist, not a look-around: read frametime, worst-frame, draw calls, triangles, and the soak worst-case off the HUD, then toggle foveation to confirm the headroom is still there.
