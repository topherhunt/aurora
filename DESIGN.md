# Aurora -- Design Document

A WebXR snowy mountainscape for Meta Quest 3. Procedurally generated, N64-era low-poly with baked lighting, explored on foot at walking pace, with the Northern Lights as the reward for reaching a summit.

Status: pre-implementation. Nothing built yet.

---

## 0. Priority task: the multi-draw spike

**Do this before writing any other code. Everything in §4 depends on the answer.**

The entire rendering architecture rests on `THREE.BatchedMesh`, which needs the `WEBGL_multi_draw` WebGL2 extension to collapse many different geometries into a single draw call. Quest Browser is Chromium 146 on Adreno hardware, so it is very likely present, but this has not been verified on-device and no documentation confirms it.

Build a throwaway page, serve it over HTTPS (WebXR requires a secure context), load it in Quest Browser, enter immersive VR, and report:

| Check | How | Why it matters |
|---|---|---|
| `WEBGL_multi_draw` present | `gl.getExtension('WEBGL_multi_draw')` -- print to an in-world HUD, not the console | If absent, `BatchedMesh` degrades to per-geometry draws and §4 needs rethinking |
| `BatchedMesh` actually batches | Render ~2,000 instances across ~10 distinct geometries, read `renderer.info.render.calls` | Should be a small constant, not ~2,000. This is the whole thesis |
| Draw call ceiling | Scale instance count and distinct-geometry count until frametime degrades | Establishes the real budget, replacing my estimates |
| Triangle ceiling | Same, but scale geometry density | Ditto |
| `setFoveation(1.0)` works and helps | Toggle it, watch frametime | Free perf, confirm it is not a no-op |
| Frame rate control | Request 72Hz and 90Hz via the WebXR frame rate API | Determines the target |
| Sustained thermals | Leave it running 20+ minutes at load, watch for frametime cliff | Sets the length of the experience |

Deliverable: an in-world debug HUD showing `renderer.info.render.calls`, `.triangles`, `memory.geometries`, `memory.textures`, and frametime. **This HUD stays in the project permanently**, toggled by a controller button. It is the single most useful thing to have from day one.

Note the HUD-not-console requirement: you cannot see a JS console while wearing the headset, and remote debugging over `chrome://inspect` is slow enough that you will avoid doing it. Print to a world-space panel.

### Fallback if `WEBGL_multi_draw` is absent

Fall back to one `InstancedMesh` per (asset type × LOD tier × chunk). Costs more draw calls, so the asset variety budget in §4 shrinks substantially. Not fatal, but it changes the numbers.

---

## 1. Platform decision

**WebXR, three.js, WebGL2.** Deployed as static files to `topherhunt.com/games/aurora` via GitHub Pages. She opens a URL.

Rejected alternatives, with reasoning preserved so we do not relitigate:

- **Unity WebXR Export** -- worst of both worlds. Unity WebGL's wasm/GC overhead on top of browser overhead, community-maintained, with open issues reporting ~45 FPS ceilings on Quest 3.
- **Native APK (Unity/Godot) sideloaded** -- genuinely 3-5x more headroom (native does 300-500 draw calls and 1M+ tris/frame vs. WebXR's ~150-200 calls/eye and ~250-400k tris/eye). Rejected because it requires physical access to the headset plus developer mode on her Meta account. Note: hosting an APK on GitHub Pages does **not** work. Horizon OS has no install-from-browser path.
- **Native via Horizon Store private release channel** -- clean install experience, no content review, 200-user default. Rejected due to verified-developer-org bureaucracy and 90-day expiring invite URLs.
- **WebGPU / `WebGPURenderer` / TSL** -- **explicitly dropped.** Considered and rejected: Quest support for `XRGPUBinding` is unconfirmed (Meta's April 2026 notes mention "experimental WebGPU" with no mention of the XR binding), Chrome's implementation is Windows/Android-XR behind two flags, and Brandon Jones (WebXR spec editor) states directly that WebGPU-in-WebXR is "not necessarily expected to be an automatic performance win vs. WebGL at this point" due to internal texture copies. **Consequence: shaders are GLSL via `onBeforeCompile`, not TSL.** This is a deliberate one-way door and we are fine walking through it.

The porting escape hatch: terrain generation, hydrology, biome assignment, and placement are all plain math in Web Workers with no three.js dependency. If we ever hit a wall, that code ports to Godot 4 in a weekend and only the render layer is thrown away. **Keep the sim layer free of three.js imports.**

---

## 2. World structure

**Bounded world: 16 km × 16 km.** Bounded is a feature, not a compromise -- coherent hydrology needs to know where the outflow is, and infinite terrain with correct rivers is an open research problem. At walking pace she will never find an edge.

Two-phase generation:

**Phase A -- global pass, once at load, in a Web Worker.** Operates on a coarse 2048² grid (7.8 m/cell across 16 km). Produces the skeleton of the world:

1. Multi-octave Perlin/simplex elevation, with a separate low-frequency ridge-noise layer controlling where mountain ranges vs. valleys fall.
2. **Priority-flood** depression filling. Anything that fills becomes a **lake** at its spill elevation.
3. **D8 flow direction + flow accumulation** over the filled surface. Cells above an accumulation threshold become **rivers**; width scales with sqrt(accumulation), so tributaries merge into larger rivers naturally.
4. **Channel carving** -- subtract a smoothed channel profile along river paths so rivers sit in valleys rather than running along ridgelines. (Skipping this step is the classic failure mode where rivers flow over hilltops.)
5. **Moisture field** = distance-to-water derived from the flow/lake mask. Free, and it is the input that makes biomes feel earned rather than noise-driven.
6. **Village siting** -- score valley-floor cells by (low slope) × (proximity to fresh water) × (not in a lake) and pick local maxima with a minimum separation.

Memory note: 2048² float32 is 16 MB per layer, and there are several layers plus priority-flood's working set. Expect ~100 MB transient in the worker and 1-3 seconds of compute. Acceptable as a one-time load cost. If it proves slow, drop to 1024² (15.6 m/cell) -- still ample for river topology.

**Phase B -- per-chunk detail, on demand, in a Web Worker.** As chunks stream in, generate the fine heightmap by interpolating the global grid and adding higher-frequency detail noise, then place props (§5) and bake lighting (§7). Transfer results as `ArrayBuffer`s. **Never generate terrain on the main thread** -- hitches read as stutter in VR, which is worse for comfort than a lower average framerate.

### Biomes

`biome = f(elevation, moisture, temperature-noise)`:

- High + dry -> bare rock, snow, sparse windswept pines
- High + moist -> dense pine
- Mid -> mixed pine and scrub, heather
- Low + dry -> heather, scrub brush, exposed rock
- Low + moist (river valleys) -> lush growth, broadleaf, tall grass, and where it coincides with a village site, cleared/managed land

Blend biome weights rather than hard-switching, so transitions are gradients. Add a low-frequency noise perturbation to the biome lookup so borders wander instead of following clean contour lines.

---

## 3. Distance tiering

### Terrain LOD

Quadtree chunks, 4-5 LOD levels, each level doubling chunk size and halving vertex density. **Skirts** (vertical flanges at chunk edges) to hide cracks between adjacent LOD levels -- far simpler than stitching and invisible in practice. Fog and atmospheric desaturation with distance both hide popping and do most of the work of selling scale.

### Prop LOD

Driven by `BatchedMesh.setGeometryIdAt(instanceId, geometryId)` -- an LOD switch is one call, no rebuild, no change in draw call count.

| Range | Treatment |
|---|---|
| 0-30 m | Full mesh (~600 tris) |
| 30-80 m | Reduced mesh (~150 tris) |
| 80-500 m | Cross-quad billboard (4 tris), with per-instance random Y-rotation so the forest does not shimmer with a visible grain |
| > 500 m | **No individual objects at all** |

### Beyond 500 m: bake the forest into the terrain

Do not scatter individual objects. Use the same noise field that *would have* placed trees to modulate the terrain material's albedo and normal (darker, greener, mottled), plus a sparse scattering of "forest clump" billboards where one quad represents ~20 trees.

This is what shipped open-world games actually do. Sparse individual billboards at distance look like a comb-over; a modulated terrain material reads as continuous forest cover and costs essentially nothing.

---

## 4. Rendering architecture

### The load-bearing decisions

1. **`THREE.BatchedMesh`, not `InstancedMesh`.** `InstancedMesh` draws N copies of one geometry. `BatchedMesh` uses `WEBGL_multi_draw` to draw many *different* geometries in one call, provided they share a material. The entire prop library -- every tree variant, rock, building, and LOD tier -- collapses into a handful of draw calls. Per-object frustum culling is built in.
2. **One texture atlas, one material.** This is what makes (1) possible. The moment a second material exists, every batch splits. Guard this jealously. Any new visual idea that needs its own material must justify the draw calls it costs.
3. **Alpha test, never alpha blend, for anything batched.** See §6.

### Budget

Per eye, at 72 Hz, targeting ~250k triangles with headroom. Note three.js renders once per eye (no multiview -- `OCULUS_multiview` has never been merged into three.js core), so `renderer.info` will report roughly double these figures.

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
| Sky dome + aurora | -- | -- | 2k |
| **Total** | | | **~187k** |

That is 2,240 trees, 3,000 grass tufts, and a village simultaneously visible, with ~60k tris of headroom. These numbers are estimates to be **replaced by the §0 spike's measurements**.

### Download budget -- a non-issue, which is the liberating part

- One 2048² atlas, KTX2/ASTC with mips: **~7 MB**. At 32-128 px per asset with padding, holds 60-100 distinct assets. (1024² at ~1.8 MB likely suffices if we stay strict about 32 px.)
- ~80 assets × ~500 tris of unique geometry, meshopt-compressed: **~1-2 MB**
- World data: **0 bytes** (it is a seed)

**Under 10 MB total.** Go wide on asset variety. The constraint is atlas real estate and Meshy generation time, not bandwidth.

### Per Meta's WebXR best practices

- Sort opaque front-to-back (minimizes overdraw)
- **One real-time light maximum** (the sun/moon directional). All other lighting is baked -- see §7
- **No shadow map passes** -- they double draw calls
- KTX2/Basis texture compression throughout
- Stagger CPU work: sway and animation logic at 30 Hz while rendering at 72 Hz
- Render alpha-tested foliage *after* all opaque geometry

---

## 5. Procedural placement

Per chunk, in the worker, deterministic from `hash(worldSeed, chunkX, chunkZ)`:

- Poisson-disc or jittered-grid scatter, with density and species mix driven by the biome weights at each point
- Reject placements on slopes above a threshold, in water, on paths, or inside village footprints
- **Per-instance random Y-rotation and non-uniform scale** (e.g. 0.8-1.3x, with slight independent vertical stretch) -- this is most of what makes a procedural forest stop looking procedural
- Align to terrain normal, but only partially (lerp ~30% toward the normal) so trees on slopes lean slightly rather than growing perpendicular to the hillside

### Paths

Paths are what turn a heightfield into a place. Generate them as least-cost routes (A\* with a slope-penalized cost function) between points of interest -- village to village, valley floor to summit. Then:

- Clear props within the path corridor
- **Increase** prop density immediately alongside it (bushes, rocks, boulders) to create the walled, wending, "you must follow this" feeling
- Flatten and texture-blend the terrain slightly along the corridor

The slope penalty is what makes paths switchback up mountainsides naturally rather than beelining.

---

## 6. Materials and transparency

**Alpha test (masked), not alpha blend.** `material.alphaTest = 0.5`, binary cutout, no partial alpha.

Why this is not merely a preference: alpha blending requires back-to-front sorting, cannot write depth, and **fundamentally cannot be sorted within a batched or instanced draw call**. It is architecturally incompatible with §4. Alpha test writes depth, needs no sorting, and batches cleanly.

Two caveats, neither fatal:

- On Adreno tile-based GPUs, `discard` disables early-Z for that draw. Render alpha-tested foliage **after** all opaque geometry so it still benefits from the opaque depth prepass.
- Alpha-test edges alias badly against MSAA. Set `alphaToCoverage = true`; it is cheap and cleans this up.

True alpha blending is reserved for exactly two things: **the aurora** and **fog/mist cards**. Both sort trivially because there is one of each.

---

## 7. Lighting, shadows, and the day/night cycle

### Cycle

**24 real minutes = 24 in-world hours.** One real minute per in-world hour.

**Design constraint worth respecting:** the aurora only appears at the summit, and the aurora needs night. A 24-minute cycle against a ~15-20 minute thermal window means she sees roughly one cycle. If she summits at in-world noon, the payoff is ruined.

Mitigation: **start the clock at dusk**, and weight the cycle so night occupies ~60% of it (compressed daylight, extended night). Dawn/dusk are also the most flattering light for baked low-poly terrain, so this is an aesthetic win as well as a scheduling one.

### Technique: horizon mapping

This replaces the earlier "bake 8 sun azimuths and crossfade" idea. Horizon maps are **computed once and valid for every sun position**, which is what makes a continuously moving sun affordable.

For each terrain texel, precompute the **horizon elevation angle** in N azimuth directions (N = 16) by raymarching the heightmap. Store as a texture. At runtime:

```
sunOccluded = smoothstep(horizonAngle - softness, horizonAngle + softness, sunElevation)
```

where `horizonAngle` is bilinearly interpolated between the two azimuth slices nearest the sun's current azimuth.

This gives all three things asked for:

- **Continuous sun movement** with no re-baking, no crossfade artifacts, no periodic hitches
- **Soft, blurry shadow edges** for free -- the `smoothstep` band replaces a hard step. Widen `softness` for softer shadows; it is a single tunable
- Correct behavior at every sun angle including grazing dawn/dusk light, which is where long mountain shadows look best

### Separate AO bake for crevice deepening

Shadow (directional occlusion) and ambient occlusion are different terms and must be computed separately.

Bake a **sky-visibility / AO value** per texel once at generation. It is sun-independent, so it is computed exactly once and never recomputed. This is what deepens crevices, gullies, and the bases of cliffs regardless of sun position.

```
terrainLight = sunColor * NdotL * (1 - sunOccluded) + ambientColor * ao
```

Ambient color is driven by the time of day (warm at dusk, deep blue at night, tinted green near the aurora).

### Props inherit terrain lighting

Requested feature, and it falls out cleanly with **no per-instance attribute needed** -- which is why `batched-mesh-extensions` is not required.

In the vertex shader, use the instance's world XZ position to compute a UV into the horizon map and AO texture, sample both, and pass the resulting scalar to the fragment shader as a varying. Multiply into albedo.

Result: trees on the shadowed side of a ridge are darker than trees catching the sun, and props tucked into gullies pick up the crevice darkening -- all automatically, all consistent with the terrain they stand on, at the cost of two vertex-shader texture samples.

### Resolution strategy (the part most likely to need tuning)

Horizon maps at 16 azimuths cost 16 bytes/texel. Two tiers:

- **Global coarse tier:** 1024² over 16 km (15.6 m/texel), ~16 MB. Computed once at load. Provides macro "which side of the mountain am I on" shadowing for all distant terrain.
- **Per-chunk fine tier:** ~1 m/texel, computed in the worker as chunks stream in within the detail radius. Provides crevice-scale detail near the player.

Blend between tiers by distance. **If the fine tier proves too expensive, ship the global tier alone** -- macro mountain shadows are 80% of the visual payoff, and the AO bake (which is cheap and sun-independent) carries the crevice detail on its own.

### Other lighting

- **Blob shadow decals** under props for contact shadow.
- **AO baked into each asset's own texture** during the Blender pass (Meshy will not do this).
- One real-time directional light for the sun/moon. Nothing else.

---

## 8. Water

Rendered from the Phase A hydrology (§2):

- **Lakes:** one flat plane per water body, at the spill elevation from priority-flood
- **Rivers:** ribbon mesh extruded along the flow-accumulation splines, width from sqrt(accumulation)

Shading:

- Scrolling normal map (two layers at different scales/speeds to break up tiling)
- Fresnel term
- Skybox/environment cubemap sample
- Moon specular highlight
- **No screen-space reflections.** Far too expensive, and at night nobody will miss them.

Water is one of the few alpha-blended surfaces, but there is a small fixed number of water bodies visible at once, so sorting is trivial.

---

## 9. Locomotion and comfort

She is a first-time-ish VR user. Comfort outranks capability.

- **Left stick: move only.** Forward/back/strafe, relative to head direction.
- **No stick turning of any kind** -- no snap turn, no smooth turn. She turns her body physically. (Smooth yaw is the single most reliable way to induce sickness; this sidesteps it entirely.)
- **Eased acceleration to ~1.3-1.5 m/s** (normal walking pace). The ease-in curve is what prevents nausea, not the top speed. Instant stop on release.
- **Comfort vignette** that tunnels peripheral vision during movement, tightening with speed.
- **Damp vertical camera motion** when walking slopes. The pitch and bob from naive terrain-following is a major nausea source.
- **'A' button toggles teleport mode** for covering distance.

### Consequences of no stick turning

- **Requires an adequate physical play space and a correctly set Quest guardian.** Confirm before she starts. Seated or in a tight space, this becomes frustrating fast.
- **Provide a recenter binding** (suggest long-press a face button). With no stick turn, there is no way to correct a drifted forward orientation, and she will end up facing a wall eventually.
- Start her facing something worth looking at.

### Pacing math

At 1.4 m/s, 800 m takes ~9.5 minutes. Against a 24-minute day cycle and ~15-20 minute thermal window, that means **the summit needs to be reachable in roughly 10-12 minutes of walking from the start point**. Place the start accordingly. This is a hard design constraint, not a nice-to-have.

---

## 10. Asset pipeline

### Sourcing

Final assets from **Meshy.ai**. Meshy exports GLB with baked PBR maps and has a Remesh step for hitting a poly budget, but raw output is photogrammetry-flavored: messy topology, per-asset UVs, 2K-4K textures, inconsistent art direction between generations. Every asset goes through the Blender pass below.

**For bootstrapping before Meshy assets exist**, use CC0 low-poly kits -- they are already close to the target style and will unblock the terrain and rendering work:

- **Quaternius** (Ultimate Nature Pack) -- CC0, low-poly, stylized, ideal
- **Kenney** (Nature Kit) -- CC0, very low-poly
- **Poly Haven** -- CC0, higher fidelity, needs more decimation

### Headless Blender pass

Fully scripted, no manual work: `blender --background --python pipeline.py`

1. **Import** GLB/FBX
2. **Decimate** to target tri budget per LOD tier (600 / 150 / billboard)
3. **Bake AO** into the asset's own texture (contact/self-shadowing)
4. **Downscale** textures to target (32 px typical, up to 128 px for hero assets like buildings)
5. **Atlas** -- pack every asset's texture into the single shared 2048² atlas and rewrite UVs. This step is what makes §4 work
6. **Generate billboard** -- render the LOD0 mesh to a cross-quad texture, also into the atlas
7. **Compress** -- KTX2/Basis for the atlas, meshopt for geometry
8. **Export** a single GLB containing all geometries plus the atlas

Get **one** tree species through end-to-end before generating forty. The atlas packing and UV rewrite are where this pipeline will break, and it is much cheaper to debug with one asset.

---

## 11. Aurora

Saved for last -- it is the payoff and it is self-contained.

- Rendered on the sky dome (or a band of geometry inside it), **not** as a fullscreen pass. Fill rate is the constraint on mobile GPUs; keeping it on dome geometry bounds the cost.
- Scrolling FBM/curl noise, additive blend, vertical gradient falloff.
- Keep the shader short. This is the one place where a long fragment shader will show up in frametime.
- **Appears based on altitude**, fading in as the player crosses a threshold near the summit. Consider a subtle early tease -- a faint glow visible from partway up -- so there is something pulling her upward.
- Tint the scene's ambient light green as it strengthens, so the aurora affects the world rather than sitting on a separate layer.

Also on the sky dome: starfield (slowly rotating), moon, wispy drifting cloud layer (alpha blended, two scrolling layers).

---

## 12. Build order

1. **§0 spike.** Verify `WEBGL_multi_draw`, `BatchedMesh` batching, foveation, frame rate, thermals. Build the permanent in-world debug HUD. Half a day.
2. **Terrain + locomotion vertical slice.** Worker-generated quadtree terrain with skirts, heightmap collision, eased locomotion with vignette, recenter. **Get this to a stable 72 Hz with an empty world before adding a single tree.**
3. **Phase A global pass.** Heightmap, priority-flood, flow accumulation, biomes, village siting. Pure math, no rendering, most reusable code in the project. Debug it with a 2D canvas view before it ever renders in 3D.
4. **Asset pipeline + `BatchedMesh` + atlas.** One tree species end-to-end.
5. **Placement, paths, LOD tiering.** The lushness pass.
6. **Lighting.** Horizon maps, AO bake, prop light inheritance, day/night cycle.
7. **Water.**
8. **Aurora and sky.**

---

## Open questions

- Does Quest Browser expose `WEBGL_multi_draw`? (§0 -- blocks everything)
- What are the real draw call and triangle ceilings? (§0 -- all §4 numbers are estimates)
- Is the per-chunk fine horizon map affordable, or do we ship the global tier only? (§7)
- Is 2048² adequate for the Phase A global grid at 16 km, or does river topology need more? (§2)
- Does the 24-minute cycle need further night-weighting once the summit walk is timed? (§7, §9)
