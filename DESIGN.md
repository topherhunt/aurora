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

### Fallback if `WEBGL_multi_draw` is absent

Fall back to one `InstancedMesh` per (asset type × LOD tier × chunk). Costs more draw calls, so the asset variety budget in §5 shrinks substantially. Not fatal, but it changes the numbers.

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

Terrain, water, sky, and weather each get their own material and their own draw calls. That is expected and budgeted. The one-material rule applies to **props**.

### Budget

Per eye, at 72 Hz, targeting ~250k triangles with headroom. three.js renders once per eye (no multiview -- `OCULUS_multiview` has never been merged into three.js core), so `renderer.info` will report roughly double these figures.

| Layer | Visible count | Tris each | Total |
|---|---|---|---|
| Terrain (all LOD rings) | -- | -- | 70k |
| Trees 0-30 m | 40 | 600 | 24k |
| Trees 30-80 m | 200 | 150 | 30k |
| Trees 80-500 m (cross-quad) | 2,000 | 4 | 8k |
| Grass/scrub 0-25 m | 3,000 | 4 | 12k |
| Rocks (tiered) | ~400 | -- | 20k |
| Village buildings | 20 | 800 | 16k |
| Water surfaces | -- | -- | 5k |
| Snow particles | 1 draw | -- | 4k |
| Sky dome + aurora | -- | -- | 2k |
| **Total** | | | **~191k** |

2,240 trees, 3,000 grass tufts, and a village visible simultaneously, with ~60k tris of headroom. **These are estimates to be replaced by the §0 spike's measurements.**

### Download budget -- a non-issue, which is the liberating part

- Texture array, 64×64 × ~128 layers, RGBA8: **~2 MB** uncompressed, less with ASTC
- ~80 assets × ~500 tris, meshopt-compressed: **~1-2 MB**
- World data: **0 bytes** (it is a seed)

**Under 10 MB total.** Go wide on asset variety. The constraint is atlas real estate and Meshy generation time, not bandwidth.

### Distance tiering

**Terrain LOD:** quadtree chunks, 4-5 levels, each doubling chunk size and halving vertex density. **Skirts** (vertical flanges at chunk edges) hide cracks between adjacent levels -- far simpler than stitching and invisible in practice. Fog and atmospheric desaturation hide popping and do most of the work of selling scale.

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

Textures live in a **`DataArrayTexture`** (one layer per surface texture, 64×64) rather than a packed 2048² atlas. Each vertex carries a `texLayer` index attribute; the shader samples `texture(sampler2DArray, vec3(uv, layer))`. One texture binding, so still one material, so `BatchedMesh` still batches everything (§5).

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

But 256 is roomier than it sounds, because **layers are per distinct surface, not per asset.** Every pine, dead pine, and snowy pine shares one bark layer and one needle layer. Forty tree species might consume a dozen layers. 256 distinct surfaces is far more art than this project will produce.

### If variable resolution is genuinely wanted later

Bind **two arrays simultaneously to the same material** -- `uArr64` and `uArr128` -- and select with a per-vertex tier attribute. This keeps one material and one batch; it costs one extra texture unit (WebGL2 guarantees ≥16 fragment units). Caveat: sampling inside non-uniform control flow with automatic mip derivatives is undefined in GLSL ES 3.00, so either sample both and select, or use `textureGrad` with explicit gradients.

**Do not build this now.** Start with a single 64×64 array. Adding a 128×128 tier later for hero assets (buildings, a landmark) requires no restructuring -- one uniform, one attribute, three shader lines.

### Headless Blender pass

Fully scripted: `blender --background --python pipeline.py`

1. **Import** OBJ/FBX/GLB
2. **Decimate** to per-LOD budgets (600 / 150 / billboard)
3. **Bake AO** into the asset's own texture
4. **Downscale** each texture to 64×64 and emit it as a texture-array layer; assets keep their native UVs
5. **Generate billboard** by rendering LOD0 to a cross-quad texture, also as a layer
6. **Compress** -- meshopt for geometry, ASTC/KTX2 for the array
7. **Export** a single GLB of all geometries plus the array as a side-loaded asset

⚠️ Verify that KTX2/Basis round-trips array textures through three's `KTX2Loader`. If it does not, ship the array uncompressed -- at ~2 MB it barely matters.

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

1. **§0 spike.** Verify `WEBGL_multi_draw`, `BatchedMesh` batching, foveation, frame rate, thermals. Build the permanent in-world debug HUD.
2. **Terrain + locomotion vertical slice.** Worker-generated quadtree terrain with skirts, heightmap collision, slope limiting, eased locomotion, vignette, snap turn, recenter. **Get this to a stable 72 Hz with an empty world before adding a single tree.**
3. **Phase A global pass.** Elevation (§3), priority-flood, flow accumulation, biomes, village siting, connectivity validation. Pure math, no rendering, most reusable code in the project. Debug it with a 2D canvas map view before it ever renders in 3D.
4. **Asset pipeline + `BatchedMesh` + texture array.** One species end-to-end. Requires installing Blender.
5. **Placement, paths, LOD tiering.** The lushness pass.
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

- Does Quest Browser expose `WEBGL_multi_draw`? (§0 -- blocks everything)
- What are the real draw call and triangle ceilings? (§0 -- all §5 numbers are estimates)
- Is 60° the right snap angle, or does it want to be 45°? (§12 -- try it)
- Is 2048² adequate for global hydrology at 16 km? (§2)
- Does snow particle overdraw fit the fill-rate budget? (§10)
- What is Quest's real `MAX_ARRAY_TEXTURE_LAYERS`? (§0 prints it; §9 assumes ≥256)
- Is 64×64 the right base texture size, or does it want to be 32 or 128? (§9 -- decide by eye on-device)
