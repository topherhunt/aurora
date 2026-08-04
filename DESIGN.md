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

1. **Ridged multifractal** (`1 - abs(noise)`, accumulated across octaves) -- produces sharp ridgelines and knife-edge arêtes instead of rounded domes. ~~This is the backbone of the mountain layer.~~ **It is not, and this was the largest single mistake in the terrain so far -- see "Ridged noise makes filaments; fbm makes piles" below.** It survives as a rare, masked accent on roughly a tenth of the map, because a knife edge is a real landform and worth stumbling on; it just is not what a mountain looks like.
2. **Domain warping** -- perturb the noise input coordinates by a second noise field before sampling. Cheap, and it is what turns symmetric blobs into twisted, organic, geologically plausible shapes. Probably the highest ratio of visual payoff to code in the entire terrain system.
3. **Stratification / terracing** -- quantize elevation into bands with a sharp smoothstep between them, producing mesa edges and cliff bands. Gate it behind a mask so only some regions terrace; uniform terracing looks like a wedding cake.
4. **Variance masking** -- multiply detail-octave amplitude by a low-frequency mask so some regions are smooth (rolling alpine meadow) and others are chaotic (shattered broken ground). This is what gives "different levels of variation" rather than uniform noisiness everywhere.
5. **Worley/Voronoi cell noise** for plateau and cliff boundaries -- gives angular, fractured, geological breaks rather than round ones.

**Gorges and gulches come primarily from hydrology, not noise.** The `accumulation × slope` carve depth in §2 cuts genuine canyons exactly where a river cuts through steep terrain, which is where canyons actually are. Noise-based gulches on their own look arbitrary; hydrological ones look inevitable.

### Horizontal scale: Skyrim, not the Alps

The first tuning pass got the *character* right and the *size* wrong: valleys read as forty kilometres across and faded into haze rather than framing anywhere. The reference is the Riverwood-to-Whiterun stretch of Skyrim -- those are proper valleys, and they are small.

So all feature frequencies roughly doubled while relief stayed put, which is the whole trick: shrinking a valley without flattening it makes the walls steeper, and steep is what makes a valley read as one. Measured before -> after, with `scripts/probe-terrain.mjs` (a 513×513 sample at 32 m that reports elevation percentiles, a slope histogram, prominence-based peak spacing and valley-floor run lengths):

| | before | after |
|---|---|---|
| median peak-to-peak (prominence ≥ 120 m) | 1600 m | 864 m |
| median valley floor run | 800 m | 416 m |
| p95 valley floor run | 9952 m | 4736 m |
| max elevation | 893 m | 863 m |

Build the probe before turning the knobs. "Too big" is a feeling; 1600 m is a number, and only the number tells you when you have arrived.

The trade is walkable area, and it is the intended trade: steeper walls mean less of the map is under the 38° limit (55% -> 47%, reachable-from-spawn 86% -> 72%). §4's actual guarantee is *connectivity*, not coverage -- everything reachable stays leavable -- so the check gate moved rather than the terrain.

**Peaks want a soft ceiling, not a clamp.** `clamp01(ridged * 1.55)` saturated on 4.21% of the map, and that 4.21% was exactly the summits: every peak was a mesa at precisely `mountainRelief`. Replaced with a soft knee (`over / (1 + over * 2.2)` above 0.88) plus a crest-gated high-frequency ridged term, which is what turns domes into something jagged.

### Vertical scale: the one number is `relief × freq`

The Skyrim pass above doubled every frequency and deliberately held `mountainRelief` at 690. That is arithmetically identical to doubling every slope in the world, and the result was a landscape of 800 m vertical walls where every mountainside was a cliff and whole regions were sealed off behind them. "Make the peaks jagged" got implemented as "make everything vertical," which is not the same request.

**Horizontal scale and vertical scale are independent; steepness is their ratio.** Concretely, `relief × freq` is the number that governs how the world reads:

| | first pass | Skyrim pass | correction | current |
|---|---|---|---|---|
| `mountainRelief` | 690 m | 690 m | 175 m | 95 m |
| `ridgeFreq` | 0.00033 | 0.00068 | 0.00095 | 0.0029 |
| product | 0.23 | 0.47 | 0.166 | 0.28 |
| max elevation | 893 m | 863 m | 252 m | 225 m |
| median peak-to-peak | 1600 m | 864 m | 640 m | 384 m |
| walkable at 38° | 55% | 53% | 91% | 98% |
| reachable from spawn | 86% | 72% | 99% | 99.9% |

The corollary is worth stating because it is counter-intuitive and it came up as an explicit request: **scaling the whole world down by 4× cannot un-wall it.** A conformal shrink divides relief and multiplies frequency by the same factor, leaves the ratio untouched, and therefore leaves every slope angle in the world exactly where it was. Only the ratio moves slopes.

And the ratio overshoots in both directions. 0.166 measured as a world with **nothing above 40° anywhere and only 1.7% above 30°** -- gentle to the point of having no cliffs at all, which is its own failure. 0.28 puts 6.7% of the map in the 30-40° band and 1.0% above 40°, which is "some cliffs steep, others gradual" rather than either walls or pillows.

### Ridged noise makes filaments; fbm makes piles

The complaint was that the mountains looked like *wrinkled-up cloth* -- all curving smooth-edged ridgelines, no jumbled pile of peaks -- and that the coarse LOD rings turned those ridgelines into a row of saw teeth. Both had one cause, and it was structural rather than parametric: **no amount of frequency or relief tuning could have fixed it.**

Any `1 - abs(n)` construction puts its maxima on the **zero contour** of the underlying noise. A zero contour is a curvilinear network. So a ridged multifractal can only ever produce thin connected filaments -- rounding the crease just fattens the wire. Measured, the old backbone's distribution was `p10 0.081  median 0.268  p90 0.564`: most of the world was floor by construction, with bright threads on it. Plain fbm has **isolated point maxima**, which is what a jumbled pile of peaks actually is.

The remap on top of the fbm is deliberately **linear**, not a smoothstep. Pooling the bottom into valley floor is wanted; an S-curve would also dome every summit, and distinct summits are the point.

The saw-tooth artifact is a **sampling truth, not a tuning failure**: a crest whose curvature radius is smaller than the cell it is sampled on cannot be represented, so coarse rings land on alternating sides of the edge. The crest has to be wider than the sample spacing. Hence `ridged(..., round)`, where `sqrt(n² + r²)` equals `|n|` everywhere except within `r` of zero. No LOD change fixes it.

The same error recurred one scale down and had to be found the same way: the crest-gated summit-jag layer was also `ridged`, and it laid a fine wire network over every summit. Now fbm, still crest-gated -- the gate is what makes it different from simply adding another octave.

### Two scales, and the big one is the larger

`valleyRelief` (130 m at `baseFreq`, a 3.5 km wavelength) is deliberately **bigger** than `mountainRelief` (95 m at a 345 m wavelength). That inversion is what separates a region from gravel: lumps at one uniform scale read as texture, lumps riding on a slow swell read as high country and low country. It is also the only thing that gives a snow line meaning -- the same-shaped peak is white in one basin and bare in the next.

`reference/skyrim-height-map.jpg` is the target, and `scripts/heightmap-png.mjs` renders our field at the same **6.29 m/px** (the reference is 4 miles across at 1024 px) so the two can be put side by side. **Build this before tuning character.** Numbers catch scale errors; only the image catches character errors -- the ridged backbone measured perfectly well for two passes while looking like crumpled cloth.

### "Wide open plains" was the macro mask reaching zero

Basins 4 km across with nothing in them were not a frequency problem. The mountain mask reached a true 0, so the low country had **no backbone under it at all** and its only relief was the 3.5 km regional swell, which lays down nothing visible from inside it. A `mountainFloor` of 0.2 runs the same already-sampled backbone under the low ground at a fifth of its height -- about a 5% roll over 345 m, which reads as soft valleys rather than as floor, and costs nothing.

| | before | after |
|---|---|---|
| map that is flat (<6 m over 64 m) | 12.8% | 2.0% |
| largest unbroken plain | 1206 m | 284 m |
| median plain diameter (area-weighted) | 529 m | 102 m |

### Shape complaints have to become numbers

"It should be rare to have a pinnacle whose horizon angle is less than 30°" is a shape complaint, and `probe-terrain.mjs` could not answer it. It now reports **summit apex angle**: find cells that pass the prominence test on *both* their row and their column (a cheap stand-in for 2D prominence that correctly rejects shoulders), then measure the cone against the **mean** of a ring at 24 m and 64 m -- mean rather than min, so a summit on the end of a spur is judged by all its sides. Current: median 145°, p5 114°, and **nothing at all below 60°**.

It also reports unbroken flat ground as connected components, with **area-weighted** percentiles. Unweighted, ten thousand single-cell specks drown out one 4 km basin, which is exactly the thing being looked for.

**Cliffs should come from the cliff layer, not the ridge backbone.** With cliffs sourced from `mountainRelief` they are a property of every mountain; sourced from the Worley break layer (`cliffFreq`, `cliffAmp`, gated by the mountain mask) they are a property of *some faces of some* mountains, which is both what real ranges look like and what leaves the rest climbable.

**Terracing is emergent, and its band width is `step / tan(slope)`.** An 18 m terrace step on a 30° slope puts a 31 m bench on the ground and reads as geology; the same step on a 60° slope puts a 10 m ledge under an 18 m wall and reads as a staircase. The terrace code never changed between the Skyrim pass and the complaint about staircases -- the ground under it got twice as steep. Fixes were all three of: shallower slopes (above), a smaller `terraceStep`, a wider smoothstep riser, and gating the terrace mask by `1 - crest` so summits never terrace.

**Instruments stop measuring when the world moves under them.** Two silently broke during this retune and both had to be fixed before the numbers meant anything again: `probe-terrain.mjs` used a fixed 120 m prominence threshold, which against 175 m peaks disqualified nearly every summit and reported peak spacing had *grown* to 3584 m (it is now `0.17 × mountainRelief`); and `check-sim.mjs` sampled slope at 1 m eps while flood-filling on a 16 m grid, so the same world measured 73% reachable or 99% depending on which number you read. Colour bands in `chunk-mesh.js` and elevation bands in `props/scatter.js` are the same class of hazard -- every one of them is a fraction of the world's relief, and a 470 m treeline against 252 m peaks is not a treeline, it is "trees everywhere."

That hazard then bit again, in the *other* direction: a snow band of `smoothstep(140, 210)` written for 252 m peaks put snow **nowhere at all** once max elevation fell to 137 m. The rule that follows is worth writing down, because it has now cost two passes. **Every elevation-keyed constant outside `TUNING` has to be re-read off the probe whenever `TUNING` moves**, and there are four families of them: `shade()` in `chunk-mesh.js`, the four `minElev`/`maxElev`/`elevFade` sets in `props/scatter.js`, `findSpawn()` in `main.js`, and the spawn band in `check-sim.mjs` that must match it. None of them fail loudly; they all just quietly stop meaning anything.

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

Measured at step 2, `res 16 / splitK 1.1 / MAX_DEPTH 10`: 304 leaves, 195k tris (24% of budget), 16 m leaves at 1.00 m per cell, ~3.26° angular error. The three parameters are one decision, not three -- see the derivation at the top of `src/terrain/quadtree.js`, including why raising `CHUNK_RES` to buy back `splitK` costs *more* triangles at equal quality rather than fewer. `splitK` is live-tunable with `[` and `]` because the angular error is a judgement call that has to be made looking at ridgelines.

**`splitK` is a step function, not a gradient**, and this is the thing to know before tuning it. Subdivision is a discrete test, so a whole band of K values selects the same ring layout and costs exactly the same. Measured worst case over 400 viewpoints:

| K | leaves | tris | angular error |
|---|---|---|---|
| 0.8 | 148 | 95k | 4.48° |
| 0.9 | 178 | 114k | 3.98° |
| 1.0 | 211 | 135k | 3.58° |
| **1.1** | **304** | **195k** | **3.26°** |
| 1.2 | 304 | 195k | 2.98° |
| 1.3 | 304 | 195k | 2.75° |
| 1.6 | 400 | 256k | 2.24° |

1.1, 1.2 and 1.3 are one plateau. A visible quality jump between 1.0 and 1.1 is that boundary and nothing else -- so 1.1 is the default (cheapest K on its plateau), going up to 1.3 is free, and dropping to 1.0 buys back a real 60k triangles. Regenerate the table by sweeping `selectNodes()` over the `CAMS` list in `check-sim.mjs` section 5.

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

### Interim: the scale-reference scatter (`src/props/scatter.js`)

None of the above exists yet -- it needs the Phase A biome pass -- but an empty heightfield gives you no way to judge how big a mountain is or how fast you are crossing it. Trees alone give you one number. A cabin, a one-metre boulder and a tuft of grass at your feet give you four scales an order of magnitude apart, and it is having several at once that makes a valley read as a valley rather than as a shape. Placeholder geometry, real architecture: one `BatchedMesh`, one material, per-instance geometry selection, so if that shape is wrong we find out on 1,200 props rather than on 40,000.

Two rules here are not placeholders and should survive into the real system:

- **Density tapers with distance; it does not stop at a cull radius.** A hard edge is visible as a moving wall of trees. A taper reads as depth. The outermost band also fades *scale* to zero, because at 800 m the fog is only 3% and hides nothing, so instances have to dissolve rather than pop.
- **At most one kind rebuilds per `update()`.** Grass re-places every 10 m of travel, which at fly speed is three times a second; stacking it into the same frame as a tree pass is a visible hitch for no reason. Measured worst single call: 1.7 ms.

Rejection order is cheap-to-expensive -- density roll, jitter, radius, distance taper, *then* the first `heightAt` -- so the far majority of candidates cost one hash. Grass inverts the usual radius/density trade (30 m disc, tufts ~2.5 m apart) because past 30 m a tuft is a sub-pixel speck, and within 30 m it is the only thing giving the ground texture at walking pace. That cost is the rebuild, not the triangles: at spacing 1.6 it measured 3.0 ms, a fifth of a frame, and had to be widened.

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

### Interim: procedural speckle (`src/terrain/terrain-material.js`)

Until the splat textures exist, the surface gets its grain from a `MeshLambertMaterial` patched through `onBeforeCompile`: a sin-free hash noise at two octaves (~0.5 m grit and ~3.5 m patches), a brightness speckle on everything, then dirt and moss mixes gated on `vColor.g > max(vColor.r, vColor.b)` so only vegetated ground gets them. It fades out between 12 m and 95 m, because past that it is per-pixel noise nobody asked for.

**Keyed to world position, in the fragment shader, deliberately.** Anything baked per-vertex would rescale itself at every quadtree ring and pop as the LOD changed -- the grain would visibly breathe as you walked. Same reason the base classification in `chunk-mesh.js` stays coarse: it is the only part that *can* live on vertices.

Two things this pass got wrong the first time, both worth remembering. Vertex colours and plain `THREE.Color` uniforms are **linear working space**, and the palette had been authored as if they were sRGB: linear 0.33 is sRGB 0.60, which under a 2.1-intensity sun came out as pale mint green. Dark gritty ground lives around linear 0.05. And the speckle is what makes speed legible -- on untextured ground at 29 m/s you cannot tell you are moving at all.

**A second, un-faded macro layer, because the fade is what made distance look flat.** Everything past ~95 m was reading as smooth green or smooth grey, and the cause was not a thin palette -- it was that the only thing varying the palette had already faded out. So there are two independent layers with opposite requirements: the near grain (0.5-3.5 m) *must* die at range or it aliases into shimmer once it is sub-pixel; the macro layer (~110 m regions with ~38 m variation inside them) *must not*, and is safe not to because it is never close to pixel-sized from anywhere you can stand. One shared fade cannot satisfy both, which is why they are not just extra octaves on one fbm. The macro layer swings brightness on everything (damped on snow -- blotchy snow reads as dirty snow), pulls green ground toward a dry ochre or a damp deep green, and stains rock on the finer octave alone, since mineral banding follows the face rather than the valley.

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
- **Eased acceleration to ~1.3-1.5 m/s** (normal walking pace). The ease-in curve is what prevents nausea, not the top speed. Instant stop on release. **Headset only:** the nausea is from a moving world the inner ear disagrees with, which does not happen on a monitor, so the desktop keyboard path takes top speed instantly -- there the ramp is just input lag.
- **Comfort vignette** tunneling peripheral vision during movement, tightening with speed
- **Damp vertical camera motion** on slopes. Pitch and bob from naive terrain-following is a major nausea source
- **Max walkable slope ~35-40°**, no falling, no sliding (§4)
- **'A' toggles teleport mode** for covering distance
- **Recenter** binding (long-press a face button)
- **Unstick** binding (§4)

### Desktop-only survey controls

None of these exist in the headset, and that is the point -- they are for reading a 16 km world during tuning, at speeds and freedoms §12 forbids in VR.

- **Fly mode uses Minecraft's bindings**, because that is the muscle memory already in place: hold space to rise, hold shift to sink, either freely combined with WASD, double-tap space to drop back to walking. There is no separate "enter fly mode" key -- the first tap is it, since the only reason to press space on the ground is to leave it. Vertical is world-up regardless of gaze; forward follows the full look direction including pitch. Vertical input counts toward movement demand while flying and must not while walking, or the ascend key silently becomes a walk key.
- **Click to measure.** A click plants a red beam on the ground and puts a live rangefinder in the stats panel (slant, horizontal and vertical separately -- on a mountainside they diverge hard). Live against the *current* eye position rather than frozen at click time, so you can plant a beam on a ridge and walk the distance down; calibrating your own sense of scale needs the walk, not the snapshot. Drag-to-look and click-to-measure are separated by accumulated pointer travel (5 px), not by a modifier.
- **The hit test raymarches `heightAt()`, never raycasts the mesh.** Terrain geometry is the current LOD selection, so a mesh raycast would measure the same rock differently depending on how far away you were standing, which is the one error a measuring tool cannot make. It also works on chunks that have not finished streaming.
- **One stats panel per platform.** The head-locked canvas HUD is the only one that exists in the headset; the DOM corner panel is the only one worth having on a monitor. Both render the same lines with the same prefix-driven colour coding (`##` heading, `!!` bad, `++` good, `%%` measurement).

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
   **Code complete and checked headlessly** (`npm run check`): sim layer validated (relief, slope distribution, winding, spawn connectivity), terrain streaming drilled over an 18 km walk (slot accounting, eviction, geometry placement), empty world at 195k tris / 1 draw call.

   Then a first desktop look drove a round of tuning, all recorded above: horizontal scale halved to Skyrim proportions (§3), peaks unclamped and jagged (§3), `splitK` 1.3 -> 1.0 (§5), procedural speckle over a much darker palette (§7), and a four-kind scale-reference scatter at ~24k tris in the same batch (§6). Desktop locomotion lost the acceleration ramp and gained a 29 m/s fly mode (§12), and walking strafe turned out to be mirrored -- the right-hand perpendicular had its sign backwards.

   A second desktop look found that pass had overshot: doubling frequencies while holding relief had doubled every slope, walling the world off behind 800 m cliffs and turning the terrace layer into a staircase. Fixed by cutting `mountainRelief` 690 -> 175 and moving cliff duty from the ridge backbone to the Worley break layer (§3), which took walkable area from 53% to 91% and reachability from 72% to 99%. Same round: a macro colour layer so distance stops reading as flat green and grey (§7), `splitK` -> 1.1 on the strength of a measured plateau (§5), and the desktop survey tools -- Minecraft flight bindings, click-to-measure, one stats panel per platform (§12). Two measurement scripts had silently stopped measuring what they named and were fixed alongside; `check-terrain.mjs` had also lost its exit code, so the gate was printing failures and exiting 0.

   A third round replaced the terrain's backbone outright rather than tuning it. The mountains read as wrinkled cloth, and the cause was that a ridged multifractal can only make filaments -- so the backbone became plain fbm, ridged noise was demoted to a rare masked arête accent, and the summit-jag layer was caught making the same mistake one scale down (§3). Alongside it: a `mountainFloor` so the low country has a backbone under it and the 4 km plains disappear, `valleyRelief` raised above `mountainRelief` so the world has high and low country, cliffs gated to real ranges, and every elevation-keyed constant outside `TUNING` re-read off the probe (§3). The measurement side grew as much as the terrain did -- `scripts/heightmap-png.mjs` renders the field at the reference heightmap's exact 6.29 m/px, and `probe-terrain.mjs` gained summit apex angle and area-weighted plain size, because "too pointy" and "too open" cannot be tuned against until they are numbers.

   **Still not run in a headset, and none of the last three tuning rounds has been run in a browser.** 72 Hz, comfort, and the four §0 HUD numbers are all unverified, and that is what this step is actually gated on.
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
- ~~Is ~2.75° of terrain LOD error acceptable on ridgelines?~~ **It can go the other way: 3.58° at `splitK` 1.0 is fine and chunky-at-distance is acceptable** (§5)
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
