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

### Phase A as built -- `src/sim/phase-a.js`, `src/sim/hydrology.js`, `map.html`

**The step order above is wrong, and the reason generalises to any terrain that has not been eroded.** Carving is listed as step 4, after routing, because the mental model is "route the water, then cut where it runs". On this terrain nothing can be routed first: **43% of the map has no downhill path to the map edge at all**, in basins whose median depth is 21 m, p90 52 m and max 98 m. That is not a defect in the height field, it is what fbm *is* -- it has exactly as many closed bowls as it has peaks, and real DEMs have almost none only because rivers spent ten thousand years cutting outlets. Route a surface like that and you get ten thousand disconnected puddles instead of a river network. So the cut comes first, and the flow routing afterwards runs over a surface that actually drains.

The carving is **depression breaching**, not filling: from each basin floor, search outward for the cheapest crossing and incise a gently sloping channel to it, stopping at ground that is both below the ramp and outside any depression.

**The gate passed 42 checks on a world whose entire river network was straight 45° and 90° segments closing into polygons. Rendering it is the only thing that caught that, and it is the single most valuable thing this round produced.** The first version walked the priority-flood spanning tree out of each basin -- free, since the flood already computed it, and every invariant held. But *inside a depression the flood's tree is a BFS across a flat surface*: the lake top is level, so nothing distinguishes one route from another and the search takes the straightest path an 8-neighbourhood can express. Every channel in the world ran dead straight across whatever the basin floor happened to contain, ignoring the valley underneath it. No hydrological invariant can see this, because the drainage was *correct* -- water flowed downhill, mass balanced, nothing pooled. It was just not a river.

The replacement is **least-cost path breaching (Lindsay 2016)** -- Dijkstra from the basin floor -- and the load-bearing detail is not the algorithm but one operator in its cost function:

> **`g(next) = max(g(current), barrier)`, not `g(current) + barrier`.** A *sum* cost minimises the total volume cut, and volume grows with length, so it forces near-shortest paths -- a straight line with a wiggle. A **bottleneck (minimax)** cost asks only *how high is the highest thing I must cross*, and once the path is under that height it is free to wander. That one substitution is the difference between a river network and a road network: it makes the channel hug the valley floor instead of striking out across it. Sum cost was tried first and reduced the straightness without curing it.

Two smaller things that fall out of it. The bottleneck and the low-ground tie-break must be carried in **separate arrays** and combined only into the heap key -- folding the tie-break into the running cost lets it accumulate through every subsequent `max()` and slowly turns the bottleneck back into a sum, which is the exact thing being avoided. And a tie-break is *required*: below the bottleneck height every cell is free, which is the same degenerate flat the spanning tree had, so without a small preference for lower ground the straight lines come straight back.

**The straight lattice was not caused by the breach, and assuming it was would have wasted the round.** The first hypothesis was the obvious one. It was disproved by rendering flow accumulation with breaching disabled entirely -- the lattice was already there, produced by routing over the 43% of the map that filling had raised to flat lake surfaces. The breach was reproducing a defect it inherited. `flowDirections` still resolves flats by following the flood tree, so **a residual lattice remains in the raw flow field wherever a flat survives; Garbrecht & Martz flat resolution is the standard fix and is a named follow-up.**

**The knob is "how much surface area a lake may keep", and that framing was arrived at by measuring and rejecting three others.** Worth recording, because each of the three is the obvious first idea:

1. *Cap the cut depth, refuse anything deeper.* Binary on this terrain -- a cap of 85 m leaves 33% of the map as lake, a cap of 100 m leaves none. Every basin here is 85-100 m deep, so they all flip together and no setting yields "a few lakes."
2. *Cap the cut, incise partially, iterate to convergence.* Not idempotent, and not convergent: a partially drained basin still has a floor with no lower neighbour, so each pass incises another `maxDepth`. Ten passes never converged. Iterating is just full breaching taking longer.
3. *Cap the retained depth.* Idempotent and continuous, but it makes every lake exactly as deep as the cap. At 1-2 m a 0.7 km² body is a flooded meadow.

**The world currently has no lakes at all, and that is a decision rather than a default nobody looked at.** Measured sweep of `BREACH.maxLakeArea` on seed 20260804 at 1024²:

| max lake area | water | bodies | biggest | passes to converge |
|---|---|---|---|---|
| 0 km² | 0.00% | 0 | -- | 7 |
| 0.02 | 11.9% | 17,104 | 0.020 | 16+ (did not converge) |
| 0.05 | 15.0% | 16,219 | 0.050 | 16+ |
| 0.12 | 18.7% | 15,326 | 0.120 | 16+ |
| 0.25 | 22.6% | 14,455 | 0.245 | 16+ |
| 0.60 | 27.1% | 13,530 | 0.565 | 16+ |

Every non-zero setting leaves thirteen to seventeen *thousand* ponds, because a basin under the cap is kept whole and this terrain has ten thousand small basins. And twelve percent of the map as standing water saturates the distance-to-water field, which collapses the moisture range, which collapses the five biomes into two -- **so the leftover ponds do not merely look bad, they take the biome system with them.** Zero gives the world §2, §6 and §11 actually describe: river valleys, villages sited on them, streams as ribbon meshes. The cost is that §11's flat lake planes have nothing to render. **The fix for that is deliberate ponding -- pick N good basins and dam them -- rather than keeping whatever the fill happens to leave behind.** That is a follow-up, not a knob.

**The eleventh instrument failure, and the most dangerous one so far, because it looked exactly like success.** The outlet test was `out[c] <= target` -- any cell below the ramp counts as an outlet. But the spanning tree runs back *toward* the spill point, so the first few steps out of a basin floor are still underwater, and every large basin immediately declared itself already drained. It breached 17 basins out of 10,284 while reporting a clean converged run with plausible timings. The fix is one extra clause: the cell must also be outside any depression (`filled[c] <= out[c]`). Two smaller ones in the same function -- Float32 write-back read ~1e-7 above its own float64 target, so every pass re-cut every channel and the loop never converged while reporting a deepest cut of 0.0 m (fixed with a 1e-3 tolerance and a monotone write guard); and drawing a basin down lowers the order statistic that selects its own outlet, so it chases itself forever at ~7,400 re-cuts per pass (fixed with a 0.1 m minimum bite).

**Then the least-cost router stalled at 573 undrained basins, and the convergence signal itself was the liar.** The outer loop terminates when `breached` reaches 0, on the reasoning that a pass which cuts nothing has nothing left to cut. But a basin can also be *silently skipped* -- and a skip is not a refusal, so it decrements `breached` without ever appearing in `refused`. The loop read a stall as a finish and reported a clean converged run with 7.35% of the map still under water. Neither a longer search budget nor an unlimited one moved the number, which is what ruled out the easy explanation. Counting the skip paths directly split the 573 exactly two ways, and each was its own bug:

- **136 basins, all of them touching the map edge.** The search treats any border cell as an outlet -- correct, since water leaving the world is gone whatever the terrain beyond. But an outlet accepted for being *below the ramp* is excluded from the channel (it needs no cutting), and that exclusion was being applied to border outlets too, which have passed no height test at all. Every basin whose floor sat next to the edge produced a zero-length channel, cut nothing, and came back identically on every subsequent pass. The router now flags which of the two rules fired.
- **437 basins with a mean required cut of 5.5 cm over a mean path of 1.2 cells.** These were killed by the 0.1 m minimum bite from the fix above -- **a guard that was correct in the regime it was measured in and wrong everywhere else.** The tail-chasing it prevents needs an area cap to chase; when the draw-down level *is* the floor, carving the path cannot move the level, so a small bite is not an oscillation, it is a real sill a few centimetres high with lower ground behind it. The bite floor is now conditional on the draw-down regime, and the monotone-write `changed` flag is what guarantees termination in the other one.

With both fixed the world drains completely in 7 passes -- 10,284 basins, then 5,676, 2,712, 553, 59, 2, 0 -- a clean geometric convergence instead of a plateau. **The tell was in the numbers the whole time: a converged run should not show a basin count that stops falling.**

**And one of this file's own gates had drifted into asserting the failure.** `filling raised a plausible fraction` required `raised > 0` on the *carved* surface, to catch a flood that was not running. A fully drained world is supposed to raise exactly zero cells there, so the check failed the moment breaching started working correctly. The intent was real but the surface was wrong: it now measures the *uncarved* surface, where 0% would genuinely mean the flood is dead, and prints the 43.2% → 0.0% that breaching removes. **That is thirteen instrument failures in this project, and this one is the first where the instrument was a test I had written specifically to prevent this class of bug.**

**Three tuning constants were set from measured distributions after being set by eye first, and all three were badly wrong by eye.** `BIOME_TUNING.lowEdge` was -150 m relative to the local snow line, but the field bottoms out at -124, so there was *zero* low ground anywhere and two of the five bands could not exist. `VILLAGE.elevBelowSnow` at 90 m against a snow line running 127-170 m admitted only ground below ~58 m -- under the world's 5th percentile -- and put all six villages on the absolute floor of one southern corner. And every village scored exactly 0.000, because the openness term was `1 - avgSlope/maxSlope` against a 9° maximum: neighbourhood-average slope in a mountain range is essentially never under 9°, so the product collapsed and the six sites were chosen by array order. It is measured against a 20° reference now.

**The five biome bands are in tension and the tension is structural, not a bad setting.** `MOISTURE.reach` started at 420 m, but in a fully drained world 2.4% of cells are stream, so nearly all valley floor is within a few hundred metres of running water -- the proximity term read ~1 across every valley, "low and dry" was impossible, and heather came out at 1% of the map. At 250 m the riparian strip is narrow enough for heather to exist. `altitudeDry` then trades pine against heather directly: 0.30 gives bare 44 / pine 10 / heath 3, 0.25 gives 40/13/2, 0.20 gives 37/17/2. Heather falls under the 2% gate before pine gets interesting, because *"low" is a smoothstep* and wetting the high ground also wets the mid-elevation cells heather is the only occupant of. The real fix is more low ground, not more knob.

**With the drainage fixed, the map view immediately produced a second finding, and it is upstream in §3 rather than anywhere in Phase A. The terrain has no structure above about 2 km, so at map scale a 16 km world reads as one uniform texture.** Measured by smoothing the elevation and asking how much relief survives: 76% at 260 m, 32% at 1 km, 16% at 2 km, 6% at 4 km. A real range keeps most of its relief at 5-20 km -- that is what makes it a range rather than a field of hills. Here every layer's characteristic wavelength is at or below the macro mask's 2 km (halved again to 1 km by `SHRINK`), so **nothing in the height stack has a scale that is a meaningful fraction of the world**, and fbm's self-similar spectrum means it then looks the same at every zoom.

This is also the honest explanation for the shape of the drainage network. The world produces 10,284 tiny basins spread evenly across the map, each with its own short outlet channel, which is why the flow layer tiles the plane instead of collecting into a few trunk rivers with tributaries. **The hydrology is doing exactly the right thing to the terrain it was given.** `SHRINK = 2` was checked as a suspect and cleared: setting it to 1 doubles the relief (677 m against 328 m) and doubles feature size, but the character is unchanged -- 33% surviving a 2 km blur instead of 16%, still texture rather than landform. The cause is the frequencies, not the scale factor. Fixing it means adding a layer at 5-10 km or pulling `macroFreq`/`massifFreq` down by a factor of four, which changes what the whole world looks like and is a §3 decision to take deliberately rather than a knob to turn in passing. **Not resolved, and deliberately not resolved unilaterally.**

**Phase A does not write its carve back into `TerrainHeight`.** `heightAt` stays a pure function of the noise stack, every existing gate still measures the surface it has always measured, and nothing the player walks on has moved. The pass returns `base` (raw analytic) and `elev` (carved) side by side, and applying the delta per chunk is Phase B's job -- it needs the D8 path splined and given a channel profile before it touches a 0.5 m heightmap. **Until that exists, the streams here are correct routes over a surface the renderer does not yet show.**

**The 1-3 second budget above is not met.** Measured at 1024²: 3,850 ms total, of which elevation sampling is ~950 and breaching ~2,400 (7 passes, deepest cut 99 m). Breaching roughly tripled when the spanning-tree walk became a Dijkstra search, which is the price of the shape and worth paying. At 2048² this extrapolates to roughly 15 seconds. Sampling dominates, and it is embarrassingly parallel, so the two outs are a worker pool or accepting a 1024² sim grid -- note that §2's own resolution table treats 8 m as a floor for *stream topology*, not for anything the player sees. Not resolved.

`scripts/check-phase-a.mjs` gates all of this in nine sections (43 checks) and is part of `npm run check`, which is now 102 checks across the three suites. The hydrology invariants are the load-bearing ones: no receiver uphill, no receiver out of priority-flood order, nothing filled below its original height, the flow graph acyclic, and mass balance exact -- all 4,194,304 cells reaching the edge at full 2048².

**`map.html` is the 2D canvas map view §14 step 3 asks for**, and it is the eye that "tune it by eye" refers to. Nine layers (relief, elevation, breach cuts, depression depth, flow accumulation, moisture, biome, slope/walkable, reachability) with four overlays and a per-cell readout, running Phase A in a real Web Worker so the load-path arrangement gets exercised rather than simulated. It is strictly a reader -- it recomputes nothing except hillshade, which is presentation -- because on this project's record the fastest way to get a twelfth drifted instrument is to let the debug view compute its own version of the field.

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

"It should be rare to have a pinnacle whose horizon angle is less than 30°" is a shape complaint, and `probe-terrain.mjs` could not answer it. It now reports **summit apex angle**: find cells that pass the prominence test on *both* their row and their column (a cheap stand-in for 2D prominence that correctly rejects shoulders), then measure the cone against the **mean** of a ring at 24 m and 64 m -- mean rather than min, so a summit on the end of a spur is judged by all its sides. Current: median 128°, p5 89°, and **0.1% below 60°**.

It also reports unbroken flat ground as connected components, with **area-weighted** percentiles. Unweighted, ten thousand single-cell specks drown out one 4 km basin, which is exactly the thing being looked for.

**Cliffs should come from the cliff layer, not the ridge backbone.** With cliffs sourced from `mountainRelief` they are a property of every mountain; sourced from the Worley break layer (`cliffFreq`, `cliffAmp`, gated by the mountain mask) they are a property of *some faces of some* mountains, which is both what real ranges look like and what leaves the rest climbable.

**Terracing is emergent, and its band width is `step / tan(slope)`.** An 18 m terrace step on a 30° slope puts a 31 m bench on the ground and reads as geology; the same step on a 60° slope puts a 10 m ledge under an 18 m wall and reads as a staircase. The terrace code never changed between the Skyrim pass and the complaint about staircases -- the ground under it got twice as steep. Fixes were all three of: shallower slopes (above), a smaller `terraceStep`, a wider smoothstep riser, and gating the terrace mask by `1 - crest` so summits never terrace.

**Instruments stop measuring when the world moves under them.** Two silently broke during this retune and both had to be fixed before the numbers meant anything again: `probe-terrain.mjs` used a fixed 120 m prominence threshold, which against 175 m peaks disqualified nearly every summit and reported peak spacing had *grown* to 3584 m (it now reports two thresholds, both keyed to total relief, because with a three-tier hierarchy "distance between peaks" has two different right answers); and `check-sim.mjs` sampled slope at 1 m eps while flood-filling on a 16 m grid, so the same world measured 73% reachable or 99% depending on which number you read. Colour bands in `chunk-mesh.js` and elevation bands in `props/scatter.js` are the same class of hazard -- every one of them is a fraction of the world's relief, and a 470 m treeline against 252 m peaks is not a treeline, it is "trees everywhere."

That hazard then bit again, in the *other* direction: a snow band of `smoothstep(140, 210)` written for 252 m peaks put snow **nowhere at all** once max elevation fell to 137 m. The rule that follows is worth writing down, because it has now cost two passes. **Every elevation-keyed constant outside `TUNING` has to be re-read off the probe whenever `TUNING` moves**, and there are four families of them: `shade()` in `chunk-mesh.js`, the four `minElev`/`maxElev`/`elevFade` sets in `props/scatter.js`, `findSpawn()` in `main.js`, and the spawn band in `check-sim.mjs` that must match it. None of them fail loudly; they all just quietly stop meaning anything.

### Three tiers, because height and peak spacing fight

"Peaks should reach 600 m, and 300-400 m should be common" and "peak to peak should be 200-500 m" cannot both come out of one noise layer, and the arithmetic is not close: a 600 m summit 400 m from its neighbour is 470 m of rise over 200 m of ground, a 67° wall -- the exact failure that sealed the world off during the Skyrim pass. Real ranges resolve it with a hierarchy, so the height function now has one:

| tier | wavelength | relief | what it is |
|---|---|---|---|
| `valleyRelief` | ~5.3 km | 240 m | regional swell -- high country and low country |
| `massifRelief` | ~1.7 km | 370 m | broad mountains on ~700 m flanks (~25°, walkable) |
| `mountainRelief` | ~345 m | 110 m | the close-spaced sub-peaks, riding on those flanks |
| `detail` | 91 m → 1.4 m | 2-7 m | micro relief, variance-masked |

Measured: max 661 m, p90 415, median 276; sub-peak spacing median 544 m, massif spacing median 1760 m; summit apex angle median 128°, nothing below 60°.

### Four ways a height field can look wrong while measuring right

Every one of these was found by rendering the field **shaded** and looking at it, after the percentiles had all come out fine. `heightmap-png.mjs` now takes `shade: true` and that is the default instrument for character, because a crease is a discontinuity in the *gradient* and an elevation map does not show the gradient.

- **Ridged noise makes filaments.** Covered above; it appeared twice, one scale apart.
- **A domain warp only works on features larger than its own amplitude.** `warpAmp` 60 m folds a 345 m ridge, which is the intent. Applied to a detail layer whose finest octave is 1.4 m, the same displacement is tens of wavelengths: it shears rather than folds, smearing every fine feature into a comet streak along the warp gradient. Shaded, the entire world looked like brushed metal -- thousands of parallel ripples with no landform behind them. Fixed by warping only the layers scaled for it and sampling jag and detail unwarped, and by sizing `warpAmp` against the **finest** warped wavelength rather than the base.
- **fbm gain above 0.5 is fur.** With lacunarity 2, octave *k* contributes slope in proportion to `(2·gain)^k`. At gain 0.55 the finest octave is the *roughest* thing in the layer, 1.8× the coarsest over 7 octaves. Exactly 0.5 is the 1/f self-similar law real terrain follows, and it is not a tuning preference.
- **Hard clamps make creases.** `(v - lo) / (hi - lo)` followed by a clamp is C0 but not C1, and the crease runs along a level set of smooth noise -- a closed curve. It shades as a hard-edged teardrop blob lying on otherwise smooth ground. `softFloor()` rounds the corner over a band while staying *exactly* equal to the input above the knee, so summits keep their points; the alternative, a smoothstep remap, would dome every summit.

### Creases and gorges -- the same operator at two scales, and where it stops working

The "molded curves of clay with mottled skin on top" complaint outlived two amplitude fixes, which is the evidence that it was never an amplitude problem. Measuring rather than guessing settled it: slope-per-octave-band is already near-constant at ~20% from 1 m to 67 m, so **no octave is missing**. What was missing is non-gaussianity. Curvature kurtosis measured **3.5**, where 3.0 is exactly gaussian -- the surface was smooth *everywhere*, and smooth-everywhere is what clay is. Every octave of an fbm is itself a smooth blob, so no amount of gain or octave count produces a C0 kink.

`1 - |fbm|` does. Its maxima lie on the noise's **zero contour**, and a zero contour is a connected curvilinear network -- the thing isolated noise maxima can never be. §3 rejected this operator twice already, at 345 m where it made the map read as wire and on the jag layer where it laid a wire net over every summit. **That rejection does not transfer to 38 m**, where a curvilinear network across a hillside is not wire, it is ribs and gully edges. Same operator, different scale, opposite verdict. Kurtosis 3.5 → 6.4 at the origin.

At 625 m spacing and 34 m depth the same operator gives **gorges** -- trenches with ~60° walls that have to be walked around. Two things separate a canyon from a worm, and the first sweep had neither, producing a rash of embossed squiggles:

- **One octave.** At two or more the zero contour closes into loops and doubles back every couple of hundred metres. Rivers do not do that.
- **A low-ground gate**, which matters more. Water does not cross a summit, so a trench that does reads instantly as something laid *on* the terrain rather than cut *into* it. Fading the cut out on high ground was the single change that turned the render from worms into canyons.

Measured on a 2 km patch: gorges occupy 3.1% of the ground within 16% of the map, mean trench 37 m across, +1.5 points of impassable ground.

**The negative result is the more useful half.** The same operator at 45-110 m, gated on true local slope, was tried for hillside gulches and rejected on the render: at that spacing you see dozens at once and the isotropy is unmissable -- squiggle loops and scratches, not gullies. Real gullies run down the fall line, deepen downslope and converge, and **no isotropic noise contour can produce any of those three**. Gorges work only because 625 m spacing is sparse enough that the eye reads each one individually. Hillside-scale incision is a job for the Phase A flow accumulation once it folds into the chunk pipeline (§2 Phase B), not for another noise layer.

### `TUNING` is pre-SHRINK, and a world-space measurement is not

The crease layer was tuned in a scratch harness that added it *on top of* `heightAt` -- i.e. in world metres -- and the constants were transplanted straight into `TUNING`, which the header at `terrain-height.js:49` states in capitals is pre-SHRINK. A layer tuned to sit at 38 m with a 4 m excursion therefore shipped at 19 m with 2 m.

What makes this class of error hard to catch by looking is that **it is conformal**: halving wavelength and amplitude together leaves every slope angle identical. Nothing looked broken, no walkability number moved, and the ablation gate (`creaseAmp` to 0 restores the old world exactly) still passed. The features were simply half the size -- which put them back down in the fur band the layer exists to escape, and the complaint came back as "there are still lumpy clay areas". Measured peak contribution on a hillside: 1.00 m where 2.00 m was intended.

Any constant arrived at by measuring `heightAt` has to be multiplied on the way in. `snowLineAt` already does this explicitly and says why; that comment is the model.

### An elevation proxy is not a slope

`creaseMask` gates on `highGround = clamp01(massif * 0.7 + crest)`, which is deliberately an *elevation* proxy -- a true local slope costs four extra `heightAt` evaluations inside the hottest function in the project. The cost of the proxy is that mid-elevation hillsides read as low ground. The patch that prompted the second complaint sits at the map's **median** elevation with 27 m of relief across 400 m -- unmistakably a hillside, and one the mask was running at roughly half strength.

Fixed with a floor (`creaseFloor`) rather than a real slope: no ground is left perfectly smooth, and the gradient the window provides still holds above the floor. Cost, measured: walkable 57.5% → 55.4%, reachable from spawn 97.1% → 96.6%, with the gorges included in the same delta.

### The connectivity instrument was measuring the wrong thing

`check-sim.mjs` flood-filled over **nodes**, masking out any cell whose own local slope exceeded 38°. `player.js` `_walkable()` tests an **edge**: it compares the height where she is against the height where she is going and rejects the *step*, and never asks whether the ground she is standing on is steep. The difference is not conservative, it is wrong -- a node mask deletes the flat strip along the base of a cliff, which is the one corridor a mountain world most needs. The same terrain measures **71.8% reachable as nodes and 92.5% as edges**. The node number sent an entire pass hunting a connectivity regression that was never in the terrain. This is the third instrument to break this way; the pattern is now four for four.

**Ablations must not disturb the thing they are holding fixed.** The first ablation of this pass zeroed `massifRelief` and reported it cost 17 points of walkability, which pointed the fix at the massif tier. It was confounded: `jag` is gated on `massif` and the detail roughness mask keys off it too, so zeroing the massif silently removed three layers. Sweeping `massifFreq` across a 2× range moved walkability by 3 points, which is what the massif actually costs.

### The rockiness rule is POSITION, not elevation

Every rock layer -- `jag`, `detail`, `crease`, `cliff` -- used to be gated on `highGround = clamp01(massif * 0.7 + crest)`, and the `mountain` macro mask was a factor on most of them as well. Both are elevation proxies, so the rule the world was actually running was *high ground is rock, low ground is soil*. That rule can produce exactly two complaints and it produced both of them, repeatedly: low hills come out as smooth moulded clay, and high saddles and hanging valleys come out shattered. They are one bug seen from its two ends. Three separate passes raised rock amplitude against it, which is why each fix worked at the peaks and made the second complaint worse.

The replacement is **exposure**, and it is the organising idea of the whole field now. Rockiness follows landform *position*: convex ground -- spurs, ribs, crests, outcrops -- sheds its debris and stands as bare rock, while concave ground -- hollows, saddles, gullies, valley floors -- collects it and fills smooth. That is a real geomorphic process rather than a stylistic choice, and its useful property here is that **it is scale-free**: the same rule governs a 400 m spur off a massif and a 15 m outcrop in a meadow, so low hills get the same jagged jutting character as the peaks, at a gentler angle, with no second rule to tune.

It is free to compute, which is what makes it affordable inside the hottest function in the project. An fbm normalised to 0..1 sits near 0.5 at its own local mean, so `(lump - 0.5)` *is* local relative height with no absolute elevation in it. Convexity is a weighted sum of two already-sampled fbms (massif-scale and ridge-scale), pushed through a smoothstep band and multiplied by a slow lithology field so that whole regions are craggier than others:

```
convex   = (massifLump - 0.5)*exposureMassif + (lump - 0.5)*exposureRidge + exposureBias
exposure = smoothstep(-exposureBand, exposureBand, convex) * lith
rockAmp  = exposure * lerp(lowlandRock, 1, highGround)
```

`lowlandRock` (0.45) is the only place elevation still enters, and it is deliberately a *damper*, not a gate: low crests are rocky, just less violently so. Measured with a two-scale probe -- classify crest/hollow at a 400 m blur, measure roughness at a 24 m blur -- crest ground is **2.40x** rougher than hollow ground overall, and **2.22x** on low ground specifically (hollow 0.140, crest 0.310). Low crest against high crest is 1.80x: the same rule at both ends, at a gentler angle low down.

The consequence worth naming is that **the paths are what the rule leaves behind**. Concave ground is smooth by construction and hollows run unbroken from a valley floor to a saddle, so a walkable route network up every mountain falls out of the exposure rule without anything being placed. It is not a separate system and there is nothing to keep in sync.

### The slope ladder, not the height ladder

A layer's RMS *height* says how much it moves the ground; its RMS *slope* -- amplitude divided by wavelength -- says how much it moves the gradient, and the eye reads gradient. A hillshade, a silhouette and `_walkable()` are all functions of slope. A layer with a twentieth of the amplitude of the tier above it but a fortieth of the wavelength is **twice as steep** as that tier and will dominate it visually, however modest its height-ladder entry looks.

So the coherence rule is: sort the layers by RMS slope, and each rung should sit roughly 2x below the one above it. A flat ladder means no scale wins, and no scale winning is precisely what "jumbled chaos" looks like from inside. `scripts/ladder.mjs` ablates each layer and prints the ladder with its rung ratios.

Measured before this pass, the ladder was cliff 1.051 / backbone 0.631 / massif 0.539 / jag 0.457 -- four layers inside a 1.2x spread, with the *finest* structural layer twice as steep as the largest one. After: massif 0.556 leads, backbone 0.337, jag 0.322, swell 0.198, cliff 0.189, detail 0.151, crease 0.099. The massif tier dominating the ladder is the structural fix; `cliffAmp` 60 → 30 plus re-gating on exposure took cliff down 5.6x on its own.

This also reframes what a slider is for. Six amplitudes in metres and six frequencies are twelve controls that jointly set one thing nobody can see. Where a rung needs to come down, splitting the cut across amplitude *and* wavelength (here `mountainRelief` 110 → 80 with `ridgeFreq` 0.0029 → 0.0021) buys the slope reduction while keeping the sub-peak count and height, instead of spending the tier's presence to get it.

### A hillshade cannot see a hedge horizon

Every instrument in the repo looked straight down. A hillshade shows the gradient everywhere; it cannot show whether summits *differ*, only whether they exist. `massif` is an fbm remapped into a fixed window, so every massif topped out at the same value by construction and the range read as a hedge along the horizon -- invisible from above, and the single most obvious difference from the Skyrim reference silhouettes.

`scripts/skyline-png.mjs` ray-marches the horizon as she would see it: for each of 1200 azimuth columns across a 75 deg FOV it steps outward with geometric growth to 6000 m from a 1.65 m eye, tracking the maximum elevation angle and the distance of whatever drew it, then paints exponential haze so ridgelines separate into layers. It reports apex, median and relief in degrees, which is directly comparable against a reference screenshot.

The fix it drove is `peakContrast`: a very slow fbm (`peakFreq` 0.00013) that *multiplies* the massif tier rather than adding to it, so it changes which mountains are big without moving the mean. It needs a signed power curve (`sign(n)*|n|^peakSkew`) because a normalised fbm is bell-shaped and almost never approaches its declared ends -- the same pathology already recorded twice in this file for `valleyLo` and `cliffBreakLo`. Measured: mean apex 33.2 → 18.4 deg, relief 6.8 → 6.6 (references measure 5-9), and the viewpoint that had a sheer 71.2 deg wall in her face now reads 14.9.

### Seventy-five sliders is the source file with a mouse

The tuner shipped with every `TUNING` constant exposed, and it was reported as overwhelming and as full of controls that "don't do the thing that they say they do". That report was accurate, for three separate reasons:

- **About a third were gate endpoints.** `cliffGateLo`, `creaseHi`, `massifLo` and two dozen siblings are smoothstep edges on internal noise. Nobody can predict what moving one by 0.05 does, because the answer depends on the distribution of a field you cannot see. They were solved once against measurements; the right home for a solved constant is the source, with its reasoning beside it.
- **Most of the rest were gated to invisibility.** An amplitude multiplied by three masks does nothing wherever any mask is shut, and the cliff layer as shipped was shut over 96% of the world. Dragging that slider and seeing nothing is indistinguishable from a broken control.
- **The thing that decided the look was not on the panel.** The slope ratio between tiers is not any one constant, so no slider moved it.

Cut to 17, against the rule that a knob must visibly change the *character* of the world within a couple of seconds of dragging, from wherever you happen to be standing: five for the silhouette, seven for the rock/smooth balance (led by `exposureBias`, which sets what fraction of the world is bare rock), two for the lowlands, three for the snow line.

### The Worley cliff layer is retired, and the wall was the gate

`cliffAmp` is 0. This layer has now been asked four times to do something its structure cannot do -- it shipped as a field of round pits (F1 read backwards), then as an inert 0.08 m contribution, then at amplitude 60 as a carpet of closed Worley squiggles over every summit, and finally as sheer vertical walls. The fourth complaint is the one that settled it, because the measurement showed the two knobs that are supposed to control face steepness do not control it.

Face angle of the isolated layer, p90 and p99, across the plausible range:

```
lip 3.0, edge 0.13 (as shipped)   p90 80   p99 85
lip 1.0, edge 0.30                p90 77   p99 85
lip 1.0, edge 0.40, amp 22        p90 67   p99 80
```

That last row is a 7.4 m step spread over a 24 m run. That is a **17 degree** face by arithmetic, and it measures 67. So the angle is not coming from the mosaic.

It is coming from the **gate**. `gate` multiplies the whole term, and deep inside a cell the term already sits at full plateau height, so wherever the gate opens underneath such a cell the ground climbs the entire height of the cliff over the gate's transition distance -- at a location set by three composed smoothsteps on unrelated noise, with no relation to the mosaic at all. `cliffGateLo/Hi` exist precisely to make that transition near-binary, on the stated reasoning that "a partially-gated cliff is not a small cliff, it is the smooth ramp we were trying to get rid of". The vertical faces are what the gate was tightened to produce.

The `mid` construction keeps the surface continuous across **cell** boundaries and was always cited as this layer's continuity argument. Nothing keeps it continuous across **gate** boundaries, and that is where the walls are. Opening the gate windows does soften them (p90 80 → 65) but relocates the cliffs entirely, which is a redesign rather than a knob.

Cost of retiring it, world-wide at a 1.5 m stride: ground over 60 deg 3.27% → 2.93%, over 70 deg 0.51% → 0.21%, **over 80 deg 0.13% → 0.00%**, across 2.9% coverage. The layer supplied all of the genuinely vertical ground and about 60% of everything past 70 deg. What remains over 60 deg comes from the exposure rule, which produces steep rock as a consequence of landform position rather than by drawing a mosaic on top of one. The skyline is unchanged by the removal (mean relief 6.6 → 7.1 deg), so the drama was never coming from this layer either.

The code stays, guarded on `cliffAmp < 0.001` tested *before* the gate so the retired layer costs one compare in the hottest function in the project, and the slider stays on the panel. If it is ever wanted, **fix the gate first, not the blend**.

### Two hard constraints

- **Heightmaps cannot represent overhangs, arches, or caves.** One elevation per XZ, period. No natural bridges, no cave mouths. Accepted.
- **Near-vertical cliffs stretch triangles and UVs badly.** Solved by **triplanar mapping** on the terrain material (§7), which blends three axis-aligned projections weighted by the surface normal. Costs 3x texture samples, mitigated by lerping toward triplanar only where slope is high.

---

## 4. Traversability: making traps impossible by construction

Requirement: deep gulches she cannot cross or might get trapped in, but never actually stuck.

The naive solution -- "prop placement guarantees an exit" -- is fragile and hard to verify. Do this instead:

**Enforce a maximum walkable slope in the locomotion controller, with no falling and no sliding.** (The angle is 50° and is derived from the shader's rock threshold, not picked -- see below. The argument here does not depend on which angle it is.)

If she cannot walk onto terrain steeper than the limit, she can never *descend into* a region she cannot climb out of. Traversability is symmetric (a slope is the same slope in both directions), so any place she can reach, she can leave. **Traps become impossible by construction rather than by careful level design.**

Gulches, cliffs, and gorges then function exactly as intended: hard visual barriers she must path around, forcing the wending route up each valley. She can stand at the lip of a canyon and look down into somewhere she cannot go, which is better scenery than somewhere she can.

**The limiter needs a baseline, and the obvious one is wrong.** "Steeper than 38°" is not a property of a point, it is a rise over a run, and the run has to be chosen. The first implementation used her travel distance for the frame, which is 2 cm at walking pace and 72 Hz -- so it was not measuring a slope at all, it was measuring a 2 cm difference, and any 40 cm hummock became a wall. `Player._walkable` now takes the gentler of two baselines, one frame and one stride (1.5 m), so an obstacle has to keep going uphill for two paces before it counts. The one-frame test is kept as the first of the two rather than replaced, and that is what preserves the argument above: its probe pair *is* her travel pair, so the arithmetic that let her in is bit-identical to the arithmetic that lets her back out, and reversibility does not depend on the terrain. A lookahead on its own would also read every cliff from 1.5 m back and stop her there, which is an invisible standoff bubble around each wall.


### The walk limit is the shader's rock line, not a taste

`LOCOMOTION.maxSlopeDeg` is 50, and it is derived rather than chosen. The rule: **she can walk on anything the renderer does not draw as bare rock.**

`chunk-mesh.js` `shade()` ramps rock in over `smoothstep(0.86, 0.62, ny)`, so rock begins to show at 30.7 deg and is total at 51.7 deg. A limit of 38 sat *inside* that ramp, on ground still shaded as mostly grass. Measured across a 4 km box at the limiter's own 1.5 m stride, the fraction of the world blocked while being drawn as vegetation:

```
limit            38     42     45     48     50     55
grassy-blocked  7.36%  0.43%  0.00%  0.00%  0.00%  0.00%
walkable        70.8%  77.8%  82.4%  86.5%  88.8%  93.6%
```

**7.36% of the world looked climbable and refused her.** That is the entire "areas that look like they should be walkable that you can't walk on" report, and it is what sent an earlier pass hunting through the cliff layer for a cause that was never in the terrain -- the same class of error as the connectivity instrument above, and the fifth instance of it.

45 is where it reaches zero. 50 keeps 5 deg of margin, because the limiter reads a 1.5 m stride while the shader reads a per-vertex normal at whatever the LOD ring supplies, and those two need not agree at the metre scale. **If the shader's ramp moves, the limit moves with it: they are one decision.**

This strictly strengthens the §4 argument rather than weakening it. Traps are impossible because traversability is symmetric, which holds at any angle; raising the limit only enlarges the reachable set. `phase-a.js` carries the same number as `MAX_WALK_SLOPE`, duplicated because that file runs in a worker and `player.js` pulls in THREE -- if the two ever disagree, the connectivity report and the village siting describe a world she cannot walk.

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

   A fourth round put the height back without bringing the wrinkled cloth back with it. The fbm backbone had bought naturalism by giving up altitude and peak frequency, so it was split into three tiers -- massif, sub-peak, detail -- because 600 m summits and 200-500 m peak spacing are geometrically incompatible in a single layer and have to be answered at different scales (§3). Getting there turned up four ways a height field can look wrong while every percentile stays green: a domain warp shears any octave finer than its own amplitude, an fbm gain above 0.5 grows fur, a hard clamp in a remap creases along a level set, and ridged noise still makes filaments. All four were found by rendering the field *shaded* -- hillshading went into `heightmap-png.mjs` and immediately became the primary character instrument, because a crease is a discontinuity in the gradient and an elevation map does not show the gradient. Alongside: `softFloor`/`softCeil` replacing the hard clamps, `detailOctaves` to 7 so relief exists down to 1.4 m, colour bands and the treeline re-read off the probe (the old treeline sat *under* the snow line, which is why snowy ground had no trees), prop density doubled in all four kinds, and double-click-to-travel at 500 m/s (§12) so a region 8 km away is reachable in a survey session. One more instrument had drifted -- `check-sim.mjs` was masking nodes while `player.js` tests edges, reading 71.8% against the player's true 92.5% on the same terrain.

   A fifth round shrank the world and tried to make the walkable/unwalkable boundary visible. The macro was finally right, so nothing about landform character was touched: instead a single `SHRINK` constant at the `heightAt` boundary evaluates the field at `x * SHRINK` and divides the result, which is *provably* conformal -- horizontal and vertical cannot drift apart, every slope angle is bit-identical, and it is one number to undo, where the equivalent edit is 11 frequencies and 12 amplitudes. It also halves the peaks, 664 m to 332 m, directly reversing round four's headline change; that was the explicit ask and the cost is worth stating plainly. Every elevation constant outside `TUNING` had to be halved by hand in six files, which nothing can check. Two more instruments had drifted, both the same mistake in a new place: the reference render still cropped 6437 m when the point of that comparison is *features per pixel* rather than metres per pixel, and the probe's `TOTAL_RELIEF` was still reading pre-shrink `TUNING` against post-shrink heights. A `hm-human-shaded` render at 0.29 m/px was added, and it is the only view at which the 10 m scale is big enough to have a shape at all -- at 1.5 m/px a 10 m hummock is seven pixels, which is a smudge whether it is a crisp scarp or a clay mound.

   The "smooth molded clay" complaint turned out to be arithmetic rather than character: two multipliers compounded on valley floors and left ~0.44 m of relief over a 91 m base wavelength, a 0.4% grade, which shades as perfectly smooth however many octaves sit on top of it. Also in that round: `detailOctaves` back to 6, because post-shrink a 7th octave lands at 0.7 m against a 1.00 m leaf cell -- that number is set by the renderer, not by taste -- and `terraceStrength` 0.22 -> 0.10, because a terrace riser is ~1.24x the local slope and on ground already at 33-41 deg the risers crossed the scarp knee while the treads did not, giving every band its own hard step. That is the third distinct path to the staircase failure mode.

   The scarp experiment (`SCARP` in `sim/terrain-height.js`, banner-delimited, one flag to disable) is worth recording as a *failure and its correction*. Version one subtracted a constant from ground steeper than 41 deg. It produced beautiful numbers -- the 40-50 deg bin collapsed from 18.5% to 8.4%, a real trough right above the walkable threshold -- and was wrong on the headset, because a constant offset has no gradient, so it cannot steepen anything: all it can do is move the whole face down, and the face still has to rejoin untouched ground at its foot. Every ledge sat in a trench. Version two moves earth instead of removing it -- an unsharp mask, height minus a blur of itself, gated by slope -- so it cuts the hollow at the foot, piles onto the shoulder at the top, and leaves the planar middle alone. A transect across the steepest face in a 3 km box shows +4.3 m of fill on the shoulder, -3 m through the face, and a run-out tapering to -0.4 m instead of a trench. **The honest cost: the bimodality mostly goes with the craters.** They were the same phenomenon -- the trough came *from* the discontinuity -- and the fence-sitting band does not improve at any gain. Two scale lessons fell out: the operator's `eps` matters more than its gain (at 2 m it sharpens the terrain's grain, not the shape of a hillside, which is a 10 m feature), and gain and `eps` are not independent, since in a field with power at every scale the measured bulge grows roughly in proportion to `eps` -- a gain tuned at one is off by 3x at the other, which pinned the cap at both ends along an entire face and produced a square wave.

   Two performance notes from the same round, both about the cost of asking the field a question. `heightAt` went from one field evaluation to five, so prop scatter -- which asks for height and slope on tens of thousands of candidates per rebuild -- needed `heightAndSlopeAt`, answering both from one shared stencil. The useful part is a guarantee rather than an optimisation: the scarp is identically zero below 41 deg and every prop kind's slope cap is at or below 41, so on any ground a prop can be placed on at all the shared answer is *exactly* `heightAt`, not an approximation. Props cannot float. Second: grass had quietly collapsed to single digits, and the cause was not slope but an elevation band inherited from a taller world -- it thinned from 130 m when the world's median is 137, so two of the four sample sites rejected 70-80% of candidates on altitude before slope was ever asked.

   The sky stopped being `scene.background = FOG_COLOR`. A flat sky is not merely dull: it costs depth, because the deep-overhead-to-pale-horizon gradient is one of the cues that places the horizon at infinity, and without it the sky reads as a wall a few hundred metres out, fighting the fog doing the opposite job on the terrain. `src/sky.js` is an inverted sphere with a per-fragment gradient and a two-part sun (a clipped-white core about 1.1 deg across, plus forward-scatter halo). No texture, so nothing to author or round-trip through KTX2, and no banding -- an 8-bit cubemap of a smooth gradient bands badly on a headset. It follows her position but never her rotation, so a snap turn carries the sun with the world.

   **Now run in a browser for the first time in five rounds, which is what turned up the crater bug -- no percentile in the probe could have.** Still not run in a headset: 72 Hz, comfort, and the four §0 HUD numbers remain unverified, and that is what this step is actually gated on.

   Round six replaced the scarp's unsharp mask with **benching**, which is worth recording because the correction above was itself only half right. The unsharp mask fixed the craters but is *identically zero on a plane*, and a smooth planar over-steep ramp is the worst case in the whole system: she is refused with no visual cue whatsoever. A reported case made it concrete -- walking +x from `-205,151`, 44 deg of featureless snow, bulge contribution `-0.03 m`. Two further scale errors were compounding it. `SCARP.eps` is a HALF-width, so gating at `eps 1.5` reads slope over 3 m while `Player` reads it over 1.5 m, and the blocking step measures 43.6 deg at the limiter's scale and 36.6 deg at the gate's -- the gate gave it a knee of 0.067. And the *gate* wants the limiter's scale by definition, so `eps` is now pinned to `slopeAt`'s 0.75 rather than tuned. With the scales matched, sweeping the gain showed the bulge term was **making the reported complaint worse, not better**: measured over 41 walking transects the raw field refuses her in 176 runs of median 125 cm, and a gain of 9 turned that into 722 runs of median 56 cm. At the limiter's eps the curvature it amplifies is the terrain's grain, not the shape of a hillside. It was deleted.

   Benching replaced it and was **also rejected, from the headset, and `SCARP.enabled` is now `false`.** It remaps each elevation band through an odd power curve about the band's own middle: identity at the boundaries so consecutive bands join with no step, gradient multiplied by `benchPow` across the riser and driven to zero across the tread. Earth cut from the top of each band and packed onto the bottom, and unlike a Laplacian it works on a perfectly planar ramp. Its metrics were the best of the three -- refused ground down from 21.2% to ~15%, and on the reported transect a 15 m unbroken wall became treads at 11 and 15 deg separated by risers at 72-77 deg. It looked like rice paddies. The verdict was *"it's taking things that were continuous cliffs that looked pretty nice and combing the cliffside with these beautiful but unnatural regular curves."*

   **That is the fourth time this project has produced corduroy, and this time the cause generalises.** `bench 6 / benchPow 4.5` was chosen entirely on numbers -- 1.6 m of earth moved, refused ground down a quarter, every metric asking for exactly that -- and the hillshade was a paddy field. *No metric can distinguish one legible ledge from six illegible ones, because both move the same earth.* An image sweep gave 10 / 2.0; that still combed, so it was masked by a slow noise to a third of the world; that still combed in the headset. Softening, widening, jittering and masking each thinned the stripes without changing what they were, because **the operator is keyed to absolute elevation and its output is therefore a family of contour-parallel lines at regular vertical intervals -- which is the definition of a terrace.** All four corduroy incidents were something periodic in height. Anything periodic in height is a terrace generator; the parameters only decide how obvious.

   The standing lesson is worth more than the code, which is why the block is left in place behind its flag. Cliffs are not periodic in anything. What real ones have -- jagged in-and-out, bulges, isolated platforms -- is aperiodic and lateral, and wants a noise-driven displacement along the surface rather than a function of `h`. That operator is not written. Turning the flag off is also a real speed-up rather than a neutral revert: `heightAt` short-circuits to a single field evaluation instead of five, and it is the hottest query in the project.

   Two process notes. A 340 px sweep tile read as clean where the same setting at 1024 px was visibly combed, so image checks have a resolution floor. And the headset overturned a judgement I had already made from a 1024 px hillshade -- **five rounds of numbers, then two rounds of images, and it still took walking around in it.**

   Three surface fixes in the same round, all fragment-side. **The zig-zag on terrain-type boundaries** had two grid-aligned causes: every mesh cell split along the *same* diagonal, so a colour boundary could run straight only along that diagonal and had to staircase across it (hence "some faces look natural and others zig-zag" -- the good ones run with the grain), and the classification is a clean iso-contour of `(h, ny)`. The mesher now picks the shorter diagonal per cell, which is data-dependent so the pattern is irregular, and is independently the better surface because splitting a saddle the wrong way invents a ridge that is not in the field. On top of that the shader displaces the snow/rock decision by a world-space noise, which moves the boundary off the vertex grid entirely -- the real cure is per-fragment classification at step 6, and this is the down payment. **Near-field micro relief** is a normal perturbation, deliberately *not* a 7th height octave: at 0.7 m against a 1.00 m leaf cell it would alias, cost five more field evaluations on the collision path, and feed the slope limiter to manufacture exactly the sub-metre refusals this round removed. **Snow sparkle** is added rather than multiplied and hard-thresholded to the top few percent -- snow's problem is the opposite of grass's, since darkening bright ground reads as dirt rather than as texture.

   The dither's first version fixed the boundary up close and did nothing at range, and the reason is worth keeping because it will recur for every screen-space-invariant trick in this project: its octaves were ~11 m and ~3 m, and 11 m at 2 km subtends about 0.3 degrees. Both octaves average to a flat tint on a distant peak, what survives is the vertex ramp underneath, and that ramp is a function of elevation alone -- so every faraway summit wore a level contour line of snow. **A world-space detail layer has a distance past which it is not a detail layer, and the only fix is at the wavelength.** It is now a four-octave series, ~130 / 42 / 12 / 3.4 m, so something is always resolvable; the octaves are rotated ~37 deg apart because `auroraNoise` is value noise on an axis-aligned lattice, and at range the coarse octave is *all* that is left, so its lattice would be aligned with the very chunk grid the dither exists to hide. Deliberately not distance-gated: it is the same snow line seen from further off, so it should be the same shape. The amplitude that buys is only safe because of an explicit elevation guard -- `auroraVertexSnow` saturates to zero somewhat below the snow line and then stays there for the rest of the world, so vColor cannot tell a fragment 20 m below the line from one 200 m below it, and un-guarded amplitude scatters white flecks across the valleys. World height is the signal vColor threw away; the guard is a 120..165 m ramp on the *amplitude of the noise*, which is why it cannot draw a contour of its own, and it is set off `probe-terrain.mjs` (median elevation 137 m) rather than by eye.

   Then the snow line stopped being a constant, and that is the fix the dither was a proxy for. A fragment shader can break up the *edge* of a boundary but it cannot move the boundary, so with one elevation every summit in a range starts its snow at the same height no matter how ragged the edge is -- and at 2 km the height is all you can see. `TerrainHeight.snowLineAt` makes it a field: mean 148 m, swing +/- 22 m, wavelength ~2.3 km, which measures out to a line running 127..170 m across the world with total coverage unchanged at 41.6%. The wavelength is deliberately slower than the terrain under it (massif spacing is 896 m median) so a whole massif shares one line and its neighbour disagrees; faster than that and it reads as blotching rather than as climate. The two layers now divide cleanly -- **the vertex pass owns where the line is, the fragment pass owns what the edge looks like** -- and the shader's height guard came out, because a fixed window is wrong by up to 22 m in both directions once the line moves. Two consumers had to follow it or silently stop meaning what they said: the treeline is now `snowLineAt + 67` rather than an absolute 215, since "a wide belt of conifers standing in snow" is a statement about the *gap* between the two lines and only held at the mean; and the probe's snow-gap statistic asks `snowLineAt` per sample. `check-terrain.mjs` failed on the first run because it validated placement against the raw `maxElev` -- the right failure, and the tenth time an instrument in this project has drifted out from under the thing it names.

   **The three failed operators were all attacking the wrong layer, and the fix was four lines in `player.js`.** The reported annoyance was never a terrain problem: `Player._walkable` compared heights over one frame of travel -- 2 cm at 1.45 m/s and 72 Hz -- so a 46 cm patch of 42 deg stopped her dead where a person would step over it. *No amount of sculpting can make a 46 cm feature visible*, which is exactly why every operator that tried either did nothing or wrecked the character of the cliffs. The limiter now takes the gentler of a one-frame and a one-stride baseline (§4 for why the frame test stays). Measured over the same 41 transects the operators were tuned against: refusal runs 738 -> 534, runs shorter than a metre 331 -> 209, refused ground 19.1% -> 16.3%, and the longest unbroken refusal unchanged at 44.5 m -- short spurious ones gone, real cliffs untouched. Median run length went *up*, 120 -> 155 cm, which is the signature to look for.

   Two notes on how that number was picked. Sweeping the stride 0.75 -> 4 m gives a smooth curve with no knee and never eats a cliff (the 44.5 m run survives a 4 m stride), so **the metrics cannot choose it** -- 1.5 m is chosen because it is two paces and because it is `slopeAt`'s own 2 x eps, which finally makes the limiter and the reachability instruments ask the same question. And the reachability gate could not have validated this fix either way: it floods over 16 m edges, so it never saw the 2 cm bug and does not see the repair. Three orders of magnitude of disagreement between the gate and the thing it gates, and it took a headset to notice.
3. **Phase A global pass.** Elevation (§3), priority-flood, flow accumulation, biomes, village siting, connectivity validation. Pure math, no rendering, most reusable code in the project. Debug it with a 2D canvas map view before it ever renders in 3D.
   **Code complete and gated** -- `src/sim/hydrology.js`, `src/sim/phase-a.js`, `scripts/check-phase-a.mjs` (43 checks, in `npm run check`), and the map view at `map.html`. Everything measured is written up in §2 under "Phase A as built": the step order had to be inverted because 43% of an uneroded fbm world has no outlet, the carve knob is retained lake *area* after three other framings were measured and rejected, and the world ships fully drained with **no lakes at all** because every alternative leaves 13-17k ponds that collapse the biome system.
   **"Debug it with a 2D canvas map view before it ever renders in 3D" earned its place in this list on the first look.** The gate was 42 green checks over a river network made entirely of straight 45° segments closing into polygons -- correct drainage, no rivers. The cause was a `sum` where a `max` belonged in the breach router's cost function, and no invariant over a height field can express the difference. **That is the finding this view exists to produce, and the argument for building the instrument before the renderer rather than after.**
   **Four things are open before this can be called done.** The pass now costs ~3.9 s at 1024² and extrapolates to ~15 s at 2048² against §2's 1-3 s budget -- worse than before, because least-cost routing costs roughly 3x the spanning-tree walk it replaced; elevation sampling is embarrassingly parallel and breaching is now the larger half. §11 has no water bodies to render until deliberate ponding exists. **§3 has no structure above ~2 km**, which is why the map reads as texture and why the drainage is ten thousand small catchments rather than a few river systems -- diagnosed and measured above, deliberately not fixed unilaterally. And **`main.js` still has its own `findSpawn`**, a second implementation of a decision `phase-a.js` owns -- `SPAWN` is exported specifically so it can be consumed, and that should happen when Phase A is wired into the load path rather than being left as a fourteenth-instrument-in-waiting.
   Not yet seen in a browser: the map view builds clean and its layer painters are exercised by the PNG script, but nothing on that page has been rendered by an actual canvas.
   **Phase A now also owes §3 something.** The hillside-gulch experiment in §3 came back negative -- no isotropic noise contour can produce fall-line incision -- so the remaining "molded clay" on mid-slopes has exactly one honest fix left, and it is the flow accumulation this step already computes, applied as a carve depth per chunk in Phase B. That makes folding Phase A into the load path a *character* dependency, not just a rivers-and-lakes one.
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
