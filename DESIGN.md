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

**Follow-up done, and it turned on one idea: a dam is not something you build, it is something you decline to cut.** Rank every basin by the largest inscribed disc of open water it would hold, keep the best N (a *count*, `LAKE.retain = 24`, not an area threshold -- a threshold on this terrain keeps ten thousand dimples or none), flatten each keeper to its pool level *before* the breach loop runs so it is not a depression and nothing tries to drain it, then restore the bowl underneath afterwards. The pipeline's own priority-flood re-finds them as lakes for free. No wall is ever built, so there is nothing to look like a wall. Two cul-de-sacs on the way: a depth cap put every large lake at 13-19 m altitude (deep water wants sea level), and filling to spill level gave dendritic floods of 7.75 km² at compactness 37.7 -- **area, not depth, is the currency**. Result: 24 lakes, surfaces spread 22-71 m so there is no single water table, widest 480 m inscribed *square* (~800-900 m along the long axis), ~2% of the map, 95.1% still reachable on foot, and the five biomes hold. **And the thing that caught the first attempt was the relief PNG, not the metrics** -- at `retain: 120` every number was green and the picture was uniform blue mush from horizon to horizon. Finland, not the Alps.

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

**Prop LOD: two mesh tiers plus the impostor, and the ladder is per size class.** Derived in `scripts/probe-prop-lod.mjs`, which prints the whole argument; the short version is below. The table this replaces assumed one chain served every prop and that triangles were what forced the crossovers. Neither is true.

| Class | Mesh tiers | Billboard | LOD0 to | Card from | Cull | Count |
|---|---|---|---|---|---|---|
| **large** (trees) | 500, 130 | 3 quads | 30 m | 130 m | 260 m | 93 |
| **structure** (cabins, tower, mill) | 1800 | 3 quads | 60 m | 170 m | 400 m | 5 |
| **medium** (boulders, stumps, logs, bushes) | 150, 40 | none | 22 m | -- | 95 m | 38 |
| **small** (grass, ferns, flowers) | 16 | none | 26 m | -- | 26 m | 11 |

**Triangles are not what binds.** The prop budget is 545k (800k ceiling − 195k terrain − 60k everything else), trees get about half of it, and at a dense-forest 0.08 stems/m² the whole 30/130/260 chain costs 215k -- 79% of the tree budget, with the crossovers set by perception rather than by arithmetic. Pushing LOD0 out to where its triangles stop being worth it would put it past 400 m.

**Parallax is what binds.** A billboard's defect is not that it lacks detail -- a 128 px impostor carries more foliage than a 45-triangle decimated conifer does. Its defect is that it does not turn as you walk past it, and that error is an angle, `atan(depth / distance)`, which no triangle count touches. Under ~2° it stops reading as wrong at walking pace, which gives the rule the table above is built from:

> **billboard crossover ≈ prop depth ÷ tan(2°) ≈ depth × 28.6**

That is 120 m for a 4.2 m deep tree, ~170 m for a 6 m deep cabin, and 17 m for a 0.6 m boulder. The rule scaling with prop size is why the ladder is per class and not global: a boulder's crossover falls *inside* its cull radius, so medium props never get a card at all, and small props get one tier and a hard cull.

**Why not a third mesh tier.** Compared at equal budget, a third tier does push real geometry from 151 m out to 234 m. But what it puts there is a 45-triangle conifer at 94 px with no needles and no silhouette, replacing a 128 px impostor of the real canopy whose only defect -- parallax -- is already under 2° at that range. The third tier spends a geometry slot, a build step and a pop event to install a *worse* representation. Two mesh tiers.

**Density is the lever, not the tier count.** Cost moves linearly with stems/m² and only quadratically with the crossovers, so "chaotically lush" is bought by raising density, and it is affordable to ~0.2 stems/m² before triangles bind. Tune density first and treat the LOD table as downstream of it.

⚠️ **The untested regime is instance count, not triangle count.** At 0.08/m² a 30/130/260 chain puts ~4,500 instances in view, most of them 6-triangle cards. §0 measured 8,000 instances but at ~190 tris each, where the scene was geometry-bound long before per-instance bookkeeping mattered; thousands of 6-tri billboards is the opposite regime and §0 records it as explicitly untested. Read this off the HUD on the next headset visit. It is also why clump impostors below are a planned tier rather than an optimisation -- one quad per ~20 trees takes the far band to ~226 instances, well inside what §0 did measure.

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

### Villages (`src/village/plan.js`, `src/village/shapes.js`, `src/village/village.js`)

Villages are split in three, and the split is the load-bearing decision. `plan.js` is pure data with **no three.js import at all**, under the same §1 rule as `src/sim/*` -- which is what lets `scripts/check-village.mjs` plan six real sites headlessly and assert things a screenshot cannot: that no road runs through a building, that every door is within 3 m of a path, that every field fence closes, that no plinth floats. `shapes.js` is the geometry kit and knows nothing about layout. `village.js` is the runtime and knows nothing about either.

**Siting is not here.** Phase A already scores village cells on proximity to fresh water and rejects anything in a lake (`VILLAGE` in `phase-a.js`). `Villages.setSites()` takes those positions and has no opinion about them, so when lakes land and the macro structure moves, the villages move with it and nothing in these three files changes. `main.js` currently passes one stand-in site near spawn because Phase A is not wired into the runtime yet, only into `map.html`; that block is marked temporary and is the only temporary thing about the village.

**There is no flat ground to build on, and that is the whole design problem.** Measured over low ground: neighbourhood-average slope p1 10.3 deg, p25 16.9 deg, p50 21.2 deg. So nothing is placed on the assumption of a level pad. Buildings **terrace**: the floor is set at the highest corner of the footprint and a stone plinth grows *down* from it, which is how a real hillside farmstead is built and also means a building can never float. Halls and fields **run along the contour** -- they are yawed to the local strike, not to a random bearing, because a 17 m hall laid across the fall line either floats a metre at one end or buries itself at the other.

The zoning is concentric and every radius is one constant in `VILLAGE_PLAN`: plaza 12 m, ring 31 m, core 48 m, work 76 m, fields 88-122 m. Market stalls and the well in the plaza; the great hall on the plaza rim; dwellings in the core; barns, sheds and workshops in the work band; fenced crop plots and pasture in the outer ring. Arteries leave the plaza on their own bearings and every door gets a spur routed to the nearest path -- routed *around* buildings, with four candidate joins and four bend scales tried, because the first version cheerfully drew a footpath through a workshop wall.

Four decisions worth keeping:

- **Paths are ribbon geometry, not a splat channel.** §7's packed-dirt channel is the right answer for long-distance paths across a chunk, but a village lays ~1,100 m of path inside 240 m and the splat mask's resolution is the chunk's, not the village's. A ribbon is four vertices per polyline point (feathered edge, surface, surface, feathered edge), height-sampled per vertex so it lies on the ground, with `polygonOffset` to beat z-fighting. Cost measured: 918 path triangles for the whole village.
- **The static parts are one merged mesh, not a `BatchedMesh`.** The scatter uses batching because trees stream continuously and per-instance culling earns its keep. A village is ~450 static pieces all within 240 m of each other -- per-instance culling would cull nothing and charge a matrix upload per piece per frame. Merged, the entire village is **one draw call**.
- **Fire is instanced, and no light is attached to it.** §5 allows exactly one real-time light and the sun has it. Torches and bonfires are emissive `MeshBasicMaterial` geometry that flickers on two incommensurable sines, so the flicker never settles into a visible beat, and the flame widens as it shortens -- a flame that only scales in Y reads as a pulsing cone.
- **Smoke is opaque and shrinks to nothing.** §7 forbids alpha blending in anything instanced, because blending inside a batch cannot be depth-sorted. So each puff is a pure function of `time + phase` -- no state, no per-frame allocation, identical if the village unloads and returns -- that grows as it rises, drifts on an accelerating wind, and scales through zero instead of fading.

Measured, six real Phase A sites, seed 20260804: plan 2.9-7.0 ms (one frame, once, on approach); 283-453 pieces; 9-15 dwellings; 4-7 fenced plots; 21-29 lampposts; 2-3 bonfires; 25-30 paths totalling 874-1,192 m; ~1,100-1,850 terrain probes. Runtime: **24.5k village triangles + 0.9k path triangles in one draw call**, from a kit of 45 geometries totalling 5.6k triangles -- 3% of the §5 budget. Geometry generation is 19.2 ms, spread over 4 frames against a 2.5 ms budget with a worst frame of 8.8 ms, so walking up to a village does not hitch.

The village also feeds the scatter an exclusion predicate (`Villages.excludes`), injected as a callback rather than imported, so the scatter never has to know villages exist. Grass is deliberately exempt outside the plaza: a 136 m circle with no grass in it reads as a bald patch from the ridge above, and grass between the huts is correct anyway.

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

### 10 cm texture is a NORMAL, not a seventh height octave

The ask was bumps and divots at 10 cm on every surface, because the ground was reading as poured and edible up close. That cannot go in the height field, and the reason is a number: the leaf chunk is 16 m over `CHUNK_RES` 16, so the mesh resolves **1.00 m cells**. A 10 cm wavelength is a fifth of Nyquist there. It would alias into a pattern that crawls whenever a chunk rebuilds, cost five more `heightAt` evaluations on the collision path (already the frame's most expensive query), and feed `slopeAt` at eps 0.75 with garbage -- manufacturing exactly the sub-metre walk refusals §4 just finished removing.

Perturbing the shading normal buys the look with none of it: geometry-free so nothing rebuilds and nothing can block her, world-keyed so it does not rescale across LOD rings, and inside a fade so it is gone before it can alias. There were already two octaves there (~1.4 m, ~0.45 m); this is a third rung at ~10 cm on its own tighter fade (gone by 40 m, where a 10 cm feature is about 3 px) and its own flat surface mask -- full on rock, half on grass and snow alike. The coarse pair give snow only a fifth, because half-metre relief makes a drift read as gravel; at 10 cm that does not apply, since windblown snow really is pitted at this scale.

**This ladder wants to be FLAT, which is the exact opposite of the terrain slope ladder in §3, and the difference is worth understanding.** Landform coherence needs one scale to dominate -- rungs ~2x apart, or the eye finds no large form. Surface texture needs every scale to read at once, because a real gritty surface differs at all of them simultaneously. Measured tilt from the transcribed noise, RMS / p99 / max:

```
~1.39 m   5.0 /  11.3 / 16.1 deg
~0.45 m   6.6 /  14.7 / 20.5 deg
~0.10 m   5.1 /  11.5 / 16.3 deg      <- the new rung, 1.8 cm on a 10 cm bump
```

Amplitude was derived rather than dialled: a rung's visual weight is amplitude over wavelength, so matching the existing pair means `10.0 * uMicroRelief / uRelief` landing near their `0.72*0.7 = 0.50` and `2.2*0.3 = 0.66`. `uMicroRelief = 0.018` gives 0.51, and the measurement above confirms it lands between them.

Two implementation details that are load-bearing. The octave is added to the **same** bump vector rather than applied as a second `normalize` -- two successive normalizes let the coarse tilt swallow the fine one wherever the coarse tilt is large, which is on rock, precisely where this octave is meant to be strongest. And it is nested inside the `uRelief > 0.0` guard, so the fill-bound escape hatch still kills the whole normal pass in one uniform.

Note there are now three separate operations at ~10 cm: the micro tint pair, the snow sparkle, and this. That is not duplication. A real gritty surface differs in albedo *and* in normal at once, and doing only the first is why a flat-shaded hillside with speckle on it still looks like icing.

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

### What shipped

`src/clock.js` (no three.js import, so the gate can run it in node), `src/sim/horizon.js`, `src/lighting.js`. Gated by `scripts/check-daynight.mjs`.

**The clock.** 24 real minutes = 24 in-world hours as specified. Latitude 65 N, declination -4 deg, which is early November at the top of Norway: the sun culminates at 21 deg, so shadows are long *all day*, not only at dawn -- that is the whole reason for the latitude. Day length is 10.85 h, leaving a 13-hour night to put an aurora in. `N` (or the right grip in VR) skips 6 in-world hours.

The clock's `elapsed` counter is monotonic and never wrapped; only the *displayed* hour wraps. That matters because the aurora's substorm noise is indexed on `elapsed` -- if the skip wrapped the counter, skipping forward a full day would land you on a byte-identical sky.

**The palette.** A 10-row keyframe table indexed on **sun elevation**, not on clock hour. Elevation is the physically meaningful variable -- it is what actually determines how much atmosphere the light is crossing -- and keying on it means the whole table stays correct if the latitude or the date ever changes. Rows at +25, +12, +5, +1, -1, -4, -6, -12, -18 and -90 deg; the tight cluster between +5 and -6 is where the entire sunset happens. Each row carries sky horizon and zenith colour, horizon glow colour/amount/sharpness, sun colour and intensity, hemisphere sky/ground/intensity, fog colour and density, star fade, moon brightness and the aurora ceiling. The daytime horizon colour is the pre-existing `FOG_COLOR`, so **noon looks exactly as it did before this work**.

The gate sweeps this table at 20,000 steps and fails on any channel step above 0.009. A keyframe accidentally typed out of order is otherwise a two-frame flash at dusk that nobody is wearing the headset to see.

**Sun and moon share one directional light.** The handover happens at -6 deg sun elevation, where the palette has already taken sun intensity to exactly 0 -- so the direction snaps while the light contributes nothing, and the snap is unobservable. Crossfading the *direction* instead would swing every shadow in the world through angles neither body ever occupies.

**The moon** is a genuine crescent: 19% lit, rising once a day and up for essentially the whole dark. That fraction is art direction and `clock.js` says so out loud -- a real 19% crescent sets shortly after the sun and would be gone by the time the aurora starts. What is *not* faked is the terminator's **orientation**, which is derived from the true sun direction every frame, because the angle of the horns against the sky is the part the eye actually checks.

**The horizon bake** is the interesting piece. Naive raymarching of 1024² texels x 16 azimuths is ~23 billion samples. Instead `bakeHorizon` uses **Stewart's (1998) O(n) upper-convex-hull line sweep**: for each azimuth, walk the grid as a family of near-parallel lines, and sweep each line backwards maintaining the upper hull of the points behind you. The maximum slope from any point to anything ahead of it is always on that hull, so it falls out in amortised O(1) per cell. That is ~25M point visits: **533 ms for 1024² x 16 azimuths**, run inside the existing Phase A worker on `result.elev`, so it costs nothing beyond those 533 ms.

The line enumeration is the part that wants care. The obvious scheme does not cover every cell exactly once, and a missed cell keeps its initial horizon of zero -- which reads as a pinprick of *full sunlight* in the middle of a mountain shadow. The shipped version offsets by an integer that is a bijection onto the minor axis for each major-axis step, and the gate checks the result against brute force: **max error 0.1751 deg, exactly half the byte quantisation step**, i.e. the sweep is exact and quantisation is the only error. That step is in turn 8x finer than the 1.5 deg penumbra, so it is invisible.

The same pass accumulates `mean_a(cos^2(h_a))`, the closed-form cosine-weighted fraction of visible sky, into the AO map for free -- with a 0.16 floor, because this is the *only* ambient occlusion term in the scene and true black in a crevice is worse than a slightly lifted one.

**Two shading granularities.** Terrain samples the horizon map **per fragment**; props and village geometry sample it **per vertex** and pass a `vec2` varying. Terrain has to be per-fragment because far-LOD triangles are 64 m across and per-vertex shading would pin every shadow edge to a quadtree boundary. Props are the triangle budget, and a tree is small against a mountain shadow, so per-vertex is not a compromise there -- it is the right answer.

`WorldLighting.patch()` chains onto any existing `onBeforeCompile` rather than replacing it, which is how the terrain keeps its own surface-grain patch. The gate runs those patches against three.js's real `ShaderLib.lambert` source and asserts the injected identifiers are present, because **a `String.replace` that matches nothing returns the string unchanged** -- a three.js version bump that renames a chunk would silently delete every shadow in the game while everything still compiled and rendered.

The uniforms are shared **by reference** into each compiled shader, so the horizon maps can land four seconds after the world is already on screen with no recompile and no pop. Until they arrive a flag uniform makes the sampler functions early-return 1.0.

The per-chunk fine tier above was **not** built, as anticipated: the global tier plus the AO bake carries it.

#### Night had to be lit properly, and multiplied light could not do it

The first night shipped was unnavigable -- "pitch dark, especially in the grassy areas". Measured rather than eyeballed, by reproducing three.js's Lambert + HemisphereLight maths on the CPU and reading out sRGB bytes: **grass in shadow at luma 1, rock in a gully at 0, a tree trunk at 0**, while snow sat at 89. Not "a bit dark": black.

The obvious repair -- raise `hemiIntensity` -- cannot work, and it is worth being precise about why. **A hemisphere light is a multiplier on albedo.** A tree trunk at 4% albedo under an ambient bright enough to blow the snow out is still black, because 0.04 x anything reasonable is still nothing. Every lever in the palette as it stood was a multiplier, so no combination of them had a solution.

The fix is three terms, and the important one is not a multiplier:

- **`skyGlow` x `skyGlowAmt`** -- an **additive**, albedo-independent glow added to `reflectedLight.indirectDiffuse` in `lighting.js`, *after* the BRDF has already multiplied in `diffuseColor`. Physically this is airglow and scattered starlight, which really are additive at the eye. It lifts a 4% trunk and 90% snow by the same absolute amount, which is exactly the behaviour needed and exactly what a multiplier cannot give.
- **`skyFloor`** -- remaps the AO term so that full occlusion means `skyFloor` rather than zero. At noon zero is right, because the sun fills the gully the AO term is darkening. After dark the ambient *is* the light, so an unfloored 0.1 occlusion leaves a crease with a tenth of all the illumination there is. Grass is self-occluding by construction, which is why the grass was the worst of it.
- **Raised night hemisphere and moonlight**, which now *rise* slightly from -6 deg to -18 deg rather than falling. That is deliberate and it is not the sky -- it is the **dark-adaptation curve**. We cannot adapt the viewer's eye; the headset is worn in a lit room. So the number that belongs in the table is what a dark-adapted eye reports, which is far closer to a moonlit photograph than to the physical millionth-of-noon ratio.

All three are exactly zero above the horizon, so **noon is bit-for-bit unchanged** and the gate asserts it.

Measured after: **trunk 21, gully rock 35, grass in shadow 41, lit grass 62, snow 119** -- a 6x range with nothing at black. The gate now sweeps every dark hour of the day, including the ones with the moon under the horizon, and fails if the darkest surface at the darkest hour drops below luma 12. That check found a real dip near dawn that the 01:00 spot-check had missed.

**Then it was too grey, and the fix was to halve the same term.** The complaint was that night had gone flat -- "there's still dark areas and lighter areas" was what it *should* look like, and it did not. The reason is the same additive-versus-multiplicative distinction, read the other way round: because `skyGlow` adds the same absolute amount to a 4% trunk and to 88% snow, **it does not merely brighten, it compresses contrast**. Lifting everything by a constant is what a fog layer does, and a fog layer is exactly what it looked like.

So both night knobs were halved across all six sub-horizon rows -- `skyGlowAmt` 0.019 -> 0.0095 at full dark, `skyFloor` 0.31 -> 0.155 -- and the hemisphere light and moonlight were left alone, because those multiply albedo and are therefore the terms that carry *colour* and *material difference*. Halving the additive term darkens the image and **raises** its contrast at the same time, which is not a tradeoff anyone gets to make with a multiplier.

Measured at 01:00 after: **trunk 12, gully rock 25, grass in shadow 34, lit grass 58, snow 117** -- the snow-to-darkest ratio went from 5.7x to 9.8x while every surface got darker. The gate's night promise is now split in two, because they are different promises: a **tree trunk** is allowed to become a silhouette at 03:00 (floor luma 6), but the **ground she is walking on** is not (floor 14 at 01:00, 12 at the worst moonless hour). A `GROUND` subset excluding trunk and snow carries the second one.

#### And then it was flat, which is a different complaint from grey -- and the check was causing it

"At nighttime the ground and terrain just feel flat and even and grayscale." Note what that is *not*: it is not "too dark" and it is not "too bright". Every brightness number above was in range and the night still had no shape. The missing quantity was **direction**, and the diagnosis is a ratio rather than a level.

At full dark the directional moonlight contributed `0.50 x 0.474 = 0.237` against a hemisphere at 0.50 plus an additive lift. So under a third of any surface's brightness came from the one term that knows where the moon is. Ambient light has no direction by construction, so while it dominated, the answer to "which way is this hillside facing" barely changed what you saw. **Measured, a full moon overhead gave lit grass 80 against shaded grass 34 -- 2.4:1.** That is the number that reads as flat.

Worse, the gate was actively enforcing it. `worstGround >= 12` swept every surface at every dark hour and demanded a floor, and the only way to meet a floor on the *shaded* side is to raise ambient, which lifts the lit side by the same amount and flattens the ratio further. The check had been written to catch "unnavigable" and it had quietly become a check for "evenly lit".

The repair is one move with two halves, and neither half works alone:

- **`MOONLIGHT.intensity` 0.50 -> 1.20**, and
- **night ambient cut about 40%** across all six sub-horizon rows: `hemiIntensity` 0.50 -> 0.30, `skyGlowAmt` 0.0095 -> 0.0062, `skyFloor` 0.155 -> 0.115 at full dark, proportionately at -12, -6 and -4.

Measured after, at a full moon well up: **lit grass 106 / shaded grass 24, lit snow 197 / shaded snow 43** -- 4.4:1 and 4.6:1, where it was 2.4:1. Snow on the moonlit side is now genuinely bright enough to walk by and a slope with the moon behind it goes most of the way to a silhouette, which is the requested behaviour and is the same behaviour on both counts.

**Distance is the other half of "flat", and fog does it.** A night that is correctly lit at 20 m is still a diorama if the ridge at 800 m is a slightly dimmer version of the same thing. `fogDensity` at full dark goes **0.0004 -> 0.0022** and the night fog colour goes **`0x121729` -> `0x080b14`**, which is darker than the night sky. Since `FogExp2` is `1 - exp(-(density x d)^2)` that gives 0.4% at 30 m, 5% at 100 m, 35% at 300 m, 82% at 600 m and 99% at 1 km: the near field is untouched, the middle distance loses its detail, and a far ridge becomes a black cutout against a lighter sky.

This is not aerosol and the file says so -- the air does not thicken at 22:00. It is the same dark-adaptation problem as the rest of §8, viewed along the depth axis. A dark-adapted eye loses contrast sensitivity well before it loses light, so at night the far half of a landscape does not get dim, it stops *resolving*. An exponential-squared falloff toward a colour darker than the sky is that shape. It also has the useful side effect of making the aurora, the moon and the stars the brightest things in the frame by a wide margin, which at night they should be.

**One thing had to be exempted.** Village fires are `MeshBasicMaterial`, and three fogs those like anything else -- so a hearth at 600 m would be lerped 82% of the way to near-black and simply vanish, when a distant fire on a dark night is in fact the *last* thing to disappear. Fog models attenuation between here and there; it has no way to model the eye adapting to a small bright source rather than to the landscape. So `flameMat` gets `fog: false`, alongside the pre-existing decision that it is unlit. The gate asserts it from `check-daynight.mjs`, reaching into `village.js`, because the reason for the flag lives in the fog table and not in the village.

**The gate's night promise is now three promises, not one**, and the middle one has an *upper* bound, which is the only check in the file that does:

- ground **the moon reaches** is readable at every hour the moon is up (luma >= 40; worst measured 55). Conditioned on the moon actually delivering light, because a 3-degree crescent is not a light source and requiring navigability under one is what put the ambient back.
- ground **it does not reach** is dark without being gone (luma >= 6; worst measured 8).
- **slope contrast** at a full moon is at least 3:1 on both grass and snow, and shaded grass is at most 26. Before this round it measured 2.4:1, which passed every brightness check in the file and still looked like nothing.

Plus the distance shape: unfogged at 30 m, under 10% at 100 m, over 55% at 600 m and over 90% at 1 km, fog luma below 80% of the horizon's, and daylight density untouched.

#### Round six: the night fog was a wall, and it has been taken back out

The paragraph above is the argument for heavy night fog, and it was wrong. The reported symptom was "all terrain at night is pitch-black except the mountains within ~500 m of me", and that is exactly what `fogDensity` 0.0022 does: 70% gone at 500 m, 95% at 800 m, 99% at a kilometre, toward a colour darker than the sky.

The reasoning error is worth naming, because it is a general one. Fog is applied *after* the lighting, so it is not a contrast effect at all -- it is a multiply toward a constant, and a density that erases a ridge at 600 m erases it however well the moon happens to be lighting it. "A dark-adapted eye loses contrast at distance" is a real observation, but the mechanism that models it is *lighting*, not *fog*: dimmer far-field illumination lowers the far field's contrast while leaving it visible, which is what the eye actually does. Fog toward near-black does not lower contrast, it deletes.

So the two knobs got the division of labour they should have had from the start. **The far-field lighting split makes distance dim. The fog makes distance hazy.** Night density drops from 0.0022 to 0.00032, which is a hair over the daytime 0.00022 rather than ten times it: 3% gone at 500 m, 10% at a kilometre, 33% at two, 60% at three, 92% at five. A moonlit ridge two valleys over is scenery again.

The checks were rewritten to guard the opposite promise -- under 20% at a kilometre, still over 35% at three and over 85% at six, and the night density within a factor of two of noon's, because night air is not actually thicker than day air and whatever rise there is here is a look choice that should stay small enough to be one.

#### Round five: splitting the lighting by distance

The ratio fix above bought slope contrast, but it bought it *everywhere*, and the follow-up request was to split the two jobs the night lighting is doing:

> Make the DEFAULT lighting for the whole scene just based on the position of the moon/sun, ~half as bright as the lighting currently used for nearby terrain. In addition, terrain within 25 m of you should be lit to the same degree that it currently is, fading out to "no additional lighting beyond moon lighting" at 50 m.

Two new palette columns, `farDirect` and `farAmbient`, and one new term in `lighting.js`:

```glsl
float wlNear = 1.0 - smoothstep( 25.0, 50.0, distance( worldPos, cameraPosition ) );
reflectedLight.directDiffuse *= sun * mix( uFarLight.x, 1.0, wlNear );
float wlSkyF = mix( uSkyFloor, 1.0, sky ) * mix( uFarLight.y, 1.0, wlNear );
```

At full dark `uFarLight` is **(0.40, 0.0)**, and *the zero is the point*. Ambient light has no direction, so out where it was most of the illumination, a slope facing the moon and a slope facing away measured the same -- the same defect the round-four ratio fix addressed, surviving in the part of the frame the round-four fix could not reach. Delete the ambient beyond arm's reach and the far field becomes purely a function of where the moon is. Measured at 01:00: **lit grass 67 near / 34 far, shaded grass 24 near / 0 far, snow 129 / 70.**

The near field keeps its ambient because that is where the ambient is doing honest work -- it is what stops the ground under her feet being a hole -- and 25 m is roughly how far a dark-adapted eye resolves ground texture by starlight.

Both columns are exactly 1.0 whenever the sun is up, so daylight is bit-for-bit untouched; they come down across the same civil-twilight band where the moon takes over as key light, and the continuity sweep now includes them (a step in `farAmbient` is a step in the brightness of most of the frame).

**The cost is honest and is written down**: a brightness gradient centred on the player. Shaded ground fades 24 to 0 across a 25 m annulus that travels with her, and nothing in nature does that. It is a deliberate trade against a flat far field on one side and a near field with no floor on the other, and it is the first thing to judge on device.

There is also an unresolved interaction with the fog. `fogDensity` at full dark (0.0022) was tuned when the far field still had ambient; the far field is now darker by that much again, so distance is being attenuated twice. Nothing was changed -- retuning two coupled knobs without a headset is how the last three rounds went wrong -- but it is flagged in TASKS.md.

The gate carries four new promises: distant moonlit ground is 40-62% of the ground at her feet, ground the moon cannot see is *genuinely zero* out there rather than grey, distant moonlit snow still carries the ridgelines (luma >= 60), and the envelope is exactly inert at 09:00, 12:00 and 15:00.

---

## 9. Asset pipeline

### Bootstrap assets (in hand)

`tmp/placeholder-props/Ultimate Nature Pack - Jun 2019/` -- 150 Quaternius CC0 meshes in OBJ/FBX/Blend. Key findings from inspection:

- **No textures and no UVs at all.** Each mesh carries 2-3 materials that are solid `Kd` colors (`Green`, `Wood`). Flat-shaded.
- Poly counts are above target. ⚠️ **Corrected:** the counts first recorded here were *quads*, not triangles, and were therefore half the real cost. Measured after triangulation: `CommonTree_1` = **2,888** tris (recorded 1,444), `PineTree_1` = **1,920** (recorded 958), `Rock_1` = **70** (recorded 36). `len(mesh.polygons)` is the trap -- see `tools/props/common.py:tri_count`. **Decimation is required even for these**, and by twice as much as it looked.
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

### Headless Blender pass -- built, `tools/props/`

Blender 5.2 LTS. `npm run props` (finds Blender on PATH, falls back to the macOS bundle path); `npm run props:manifest` regenerates the asset list; `npm run check` gates the output via `scripts/check-props.mjs`.

```
tools/props/make-manifest.mjs   the asset list and the per-class LOD table
tools/props/common.py           import, measure, normalise, weld
tools/props/build.py            the pipeline
tools/props/inspect_sources.py  read-only inventory of the raw downloads
tools/props/probe-source.py     go/no-go on a candidate BEFORE it enters the manifest
```

**Boundary-edge fraction decides whether a source is usable at all, and it is measurable in thirty seconds.** The collapse decimator will not collapse an edge that borders a hole, so the fraction of edges with fewer than two faces predicts the shape of the answer: a photoscanned log measures 0.0% and drops from 2,000,000 triangles to exactly 500 in one round, while photoreal card foliage -- every leaf its own quad -- measures 45-52% and does not decimate at all. `probe-source.py` reports it, then runs the collapse anyway and reports the **floor**, because the fraction predicts and only the floor decides: a butterfly bush measured 12.9% boundary and still floored at 1,908 triangles. Running it on a second batch of 13 candidates called every accept and reject correctly before anything was built, against four assets built-and-measured the expensive way the first time round.

Stages, in order, each placed where it is for a reason recorded in the source: **import → join → ground+centre → weld/triangulate → scale to declared height → texture-or-vertex-colour → AO bake → one final material → LOD chain → billboard render → GLB**.

**Source classes, detected not declared.** The manifest cannot know which a file is without opening it, so the pipeline branches on what it finds:

| Class | Detect | Colour path | Layer cost | Count |
|---|---|---|---|---|
| Textured | a Base Color image | Smart UV Project + Cycles bake into one 128² layer | 1 layer | 8 |
| Flat `Kd` | materials, no images | material colour → vertex colours | **0 layers** | 138 |
| Vertex-coloured | a colour attribute and no materials | kept as-is | **0 layers** | 1 (scanned PLY) |
| Scanned, maps loose | `base_color_map` in the manifest | material built from the files, then Textured | 1 layer | 13 |

The last row is the one exception to "detected not declared", and it has to be. Megascans ships its FBX with **no material at all** and the maps as loose JPGs beside it, so detection correctly answers "no images" and sends a photoscanned birch log down the flat-colour path -- discarding the only reason to use a photoscan. `attach_loose_textures` reads two paths out of the manifest entry (base colour, and opacity for the cutout foliage) and builds the ordinary Principled tree everything downstream already expects, so it is one generic field rather than a per-asset code path. The other seven maps in those packs -- normal, cavity, gloss, specular, displacement, translucency -- have no consumer: the runtime is one Lambert pass with a 128² albedo layer and baked AO (§8), and a normal map would not survive resampling to 128² anyway.

That is the finding that matters for the `MAX_ARRAY_TEXTURE_LAYERS ≥ 256` worry above: **160 assets need 21 albedo layers, not 160**, because 138 of them carry flat material colours that become vertex colours and cost nothing but geometry. The other 101 layers in the built library are impostor sheets, one per asset that gets a billboard (every `large` and every `structure`), so the total is 122 of a guaranteed 256. The ceiling is not close, and the ~9.8 MB uncompressed estimate does not apply to the current library.

**AO goes into vertex colours, not into a texture** (§8 asked for "the asset's own texture"). Vertex colours because the runtime is already `vertexColors: true`, they cost no layer, and at 500 tris the vertex density is comparable to what a 128² unwrap resolves. Raw AO is floored at 0.45 -- black bottoms-out reads as a hole rather than as shadow under one directional light plus ambient, and a crevice outdoors is lit by ambient, which is never zero. AO ray length is a fraction of the asset (`height × 0.25`), not a constant: 1 m on a 14 m tree turns the canopy into a black mass and 1 m on a 0.4 m grass tuft occludes nothing.

**Decimation only works after welding.** These FBXs are exported per-face or per-leaf-card, and the collapse decimator cannot collapse across a seam it reads as a boundary. Measured on the pine sources, welding first is the difference between reaching 500 tris and stalling around 3,000.

⚠️ **The collapse decimator has a hard floor at open boundaries, and it does not report it.** It takes a ratio, not a target, and silently returns whatever it reached. Anything with many boundary loops -- every building, all photoreal card foliage -- stops well above target. `build.py` therefore records `stalled` and `overshoot` per LOD, and `check-props.mjs` prints them, because a chain that quietly returns 917 tris for a 130 target is the most expensive lie this pipeline could tell. Structures get a planar-dissolve pre-pass (`planar_collapse`), which clears real ground (896 → 544, 2,366 → 1,514) but never reaches the target -- hence the one-mesh-tier `structure` class in §5.

**Not every stall is a floor, and the difference is one line of cleanup.** `decimate_to` iterates -- aim, measure, re-aim -- because the modifier takes a ratio and stops early. It used to run a fixed six rounds without cleaning up in between, and that plateaus long before the real floor: the debris of the previous round (the collapsed-but-not-deleted vertices of bug 4 below) presents a topology the next round can barely touch. Validating and dropping loose geometry *inside* the loop, and running it until it stops improving rather than a fixed count, took `wild_grass` from 253 triangles to the 16 asked for. Two assets previously recorded as boundary stalls were not stalled at all. Read a `stalled` flag as "measure it", not as "reject it" -- `probe-source.py` prints the whole trajectory precisely so a plateau (`5.9k → 1.4k → 1.4k`) is distinguishable from a descent that ran out of rounds (`253 → 66 → 28 → 16`).

⚠️ **Smart UV Project's island seams act on the decimator exactly like mesh boundaries.** The collapse decimator protects custom-data discontinuities, so an unwrap that makes many small islands protects many edges. Measured on the same grass tuft with identical topology (13,605 triangles, 46.1% boundary edges): 15 triangles reachable before `consolidate_texture`, 83 after. This is a property of the texture path, not of any asset -- it applies to all 21 textured assets, and it is why textured props sit above their budget more often than flat-colour ones. Not fixed. The options are to decimate before unwrapping (which means a bake per LOD instead of one shared layer, a real architecture change) or to raise the 66° angle limit for fewer, larger islands (cheap, but it trades atlas quality at 128² and wants measuring across the library, not on one tuft).

**Not fixable by decimation: photoreal card foliage.** Four downloads were built, measured and then excluded. Every leaf is its own quad, so the mesh is ~100% boundary edges and decimation does not slow down, it does nothing: `island_tree_02` went 1,432,638 → 273,971 tris for a 500 target (54 MB in one GLB, 88% of the library's entire on-disk size), `tall-grass-elegance` 537,210 → 14,847 for a 16 target. Getting these to budget means rebuilding them as a few cross-cards with a baked canopy texture -- authoring an asset, not converting one. Replacing them with game-ready low-poly sources is cheaper. Also excluded, for source reasons rather than topology: one ASCII FBX (Blender does not read it), one FBX whose texture records carry empty file paths, one `.rar`, and two pre-arranged grass *fields* that fight §6's per-tuft scatter. All reasons are recorded inline in `make-manifest.mjs` so nobody re-adds them without reading why.

**Five bugs the gate caught that looking at the render would not have.** Worth stating because each was silent:

1. **Up is +Z inside Blender**, Y only after `export_yup`. Writing the normalisation helpers against +Y scaled every prop along its *depth* axis and centred it vertically instead of standing it on the ground -- 150 assets exported half-buried at arbitrary sizes, and it looks fine in Blender's viewport. Only reading `POSITION.min` out of the GLB catches it.
2. **The glTF exporter drops a colour attribute no material node reads.** It logs a warning and writes a mesh that loads perfectly and renders flat and AO-less -- discarding the entire point of the pipeline. Fixed by collapsing each asset to one material that reads `Col` (which also gives one primitive per LOD, which is what `BatchedMesh` wants anyway).
3. **Decimation moves the bounds.** Collapsing a vertex removes an extreme, so every LOD came out shorter than its source and floating -- a 16-tri plant lost 28% of its height and hovered 15 cm. Each tier is now re-grounded and re-scaled, which also removes a visible shrink-and-hop at every LOD transition.
4. **The decimator does not delete the vertices it collapses**, it unhooks them from the faces and leaves them in the mesh -- 6,180 of `tree_deciduous_hi_LOD0`'s 7,285. Everything that measures the mesh afterwards then reads a ghost point-cloud of the *pre*-decimation silhouette, so the renormalisation in (3) computed a scale factor of 1.0 and applied it perfectly while the exporter -- which writes only face-referenced vertices -- shipped a tree 2% short and a fern 35% short and floating 4 cm. The reported vertex counts were fiction by the same margin, which is not cosmetic: `BatchedMesh` reserves storage against vertex count. This one cost a long hunt for a stale-depsgraph bug, because `obj.bound_box` *is* a lazily-refreshed cache and had the identical symptom; flushing the depsgraph produced bit-identical numbers, which is what finally ruled it out. `drop_loose` now runs at the end of every decimation.
5. **`transform_apply` bakes an object's LOCAL basis, not its world matrix.** Megascans (and any DCC export that carried a unit conversion) parents the mesh to an empty called `world_root` holding a 0.01 scale and a -90° X rotation. Applying transforms on the child bakes an identity and leaves the parent's scale and rotation exactly where they were: in the node hierarchy. Every helper in `common.py` measures `matrix_world`, so every measurement inside Blender was *right* and the build reported OK -- while what shipped was mesh data 100× too large, lying on its side, with a node transform to compensate. `forest_floor_cluster` exported at 167.75 m against a 1.15 m spec with its base 82 m below the floor. `import_any` now unparents keeping the world placement, before anything measures.

Note the shape all five share, because it is the argument for the gate: **the thing that looks at the mesh and the thing that ships the mesh were reading different data.** In (4) Blender saw vertices the exporter would not write; in (5) the exporter wrote a transform Blender had already folded into its measurement. No amount of checking inside the tool finds either. Only assertions against the exported bytes do.

Still to do: **compression.** Geometry is meshopt-able and the layers want ASTC/KTX2. ⚠️ Verify that KTX2/Basis round-trips *array* textures through three's `KTX2Loader` before relying on it.

Get **one** species through end-to-end before doing forty -- this held up exactly as written. Every bug above was found on the three-asset smoke test or on the first full build, and each would have been far more expensive to isolate across 160.

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

- **Lakes:** one flat plane per body, at the spill elevation from priority-flood. Built and shipping -- greedy-merged horizontal runs, one mesh per 64-cell tile so frustum culling has something to cull, and the mask dilated one cell so the polygon edge is buried and the shoreline comes from full-resolution terrain crossing the plane rather than from the sim grid's staircase.
- **Rivers and streams:** ~~ribbon mesh extruded along the splined flow paths~~ **built, measured, removed.** The ribbons read as paint rather than water, and the reason is not fixable in the renderer: Phase A routes flow over the *carved* surface, and the chunk mesher renders the *raw* one. On the rendered surface **47.4% of river segments run uphill** (0.26% on the carved surface), evenly across every size band, and steepest-descent tracing on the rendered surface pits out after a median of 39 m. A ribbon can be made to sit flush -- fixed 10 m resampling took buried vertices from 14.9% to 36 of 36,527, worst 4.5 m -- but a flush ribbon climbing a valley wall is still wrong, and it is wrong about the one thing rivers are for. **Rivers become possible when the generator produces a surface that drains, i.e. fluvial erosion at generation time (§2), not before.** The three measurements are recorded in `src/water.js`'s header so this is not re-attempted blind.

Shading -- **built, and it is a mirror rather than a blue plane.** Opaque, and only about a quarter its own colour at normal incidence; the rest is sky. What was planned above and what shipped differ in two places, both because something already in the world turned out to answer the question better:

- **The sky reflection is not a cubemap.** `sky.js` already computes the sky analytically from a world-space direction, so the water calls that same function along the reflected ray. One implementation, no second render pass, no 8-bit round trip -- and the reflection is automatically correct at every time of day including sunset, because it *is* the sky. The shading body moved to `sky-glsl.js` so the dome and the lake share it and cannot drift apart; `check-water-shader.mjs` fails if a second copy is ever started.
- **The waves are not normal maps, and they are not sines either.** The first pass was six summed directional wave trains with their headings carefully spread across a half turn so nothing would beat into a moire. It tiled visibly anyway, and the reason is not fixable by choosing better headings: *a sum of periodic functions is periodic.* Six sines repeat on the lattice whose cell is the least common multiple of their wavelengths, and the eye finds that lattice in about two seconds -- the lake reads as wallpaper sliding past. What replaced it is four layers of **gradient noise with analytic derivatives**, each with its own lattice rotation, its own sampling offset, its own drift heading and its own drift speed, and the two fine layers **domain-warped by the largest one** so they are dragged around by the swell instead of merely lying on top of it. Still gradient only -- the plane is never displaced, and the analytic derivative avoids picking a finite-difference step size that would be wrong at some distance no matter what it was. The two fine layers sit inside a distance branch, which is coherent because neighbouring fragments are at neighbouring distances, so the far half of a lake pays for two noise evaluations rather than four.
- **The wave speeds are unphysical on purpose.** 27 m/s for a 52 m feature is roughly a river surface, not a 52 m ocean swell. The first pass was physical -- 1.35 m/s, a 27-second period -- and the note back was "the large octave ripples appear to not move at all!?", which was exactly right: at that speed the biggest layer crosses its own wavelength once every half minute. Everything is 20x now, and `WATER.flow` scales all four together if it ever wants calming.
- **The tilt is measured, not derived.** A summed-sine surface could be checked from its table alone, because cos() peaks at 1 and the worst tilt is the sum of the slopes. Gradient noise hands you no such bound, so `check-water-shader.mjs` ports the same noise to JS and samples 20k points over 8 km and 60 s: median 4.3 deg, p99 10.3 deg, peak 13.9 deg. The port is not bit-identical to the shader and does not need to be -- the hash returns a *unit* vector from a uniformly distributed angle, so the distribution of gradients is the same on either side of the language boundary. The same file checks that the field does not echo itself at any multiple of a layer wavelength, which is the failure the sines had.
- **Fresnel term:** yes, and it is what makes the far end of a lake read differently from the near end.
- **Sun and moon highlight:** a *broadened* lobe, not the sky's hard disc. A 1.1 deg disc sampled through a rippling normal lands somewhere different every pixel -- that is static, not glitter, and it crawls whenever the head moves. So the disc is switched off in the reflection path and the highlight is drawn with a lobe that widens with distance, in step with the wave normal relaxing toward flat over the same range. The two fades are the same idea applied twice and neither works without the other.
- **Mountains occlude the reflection**, using the horizon map §8 already bakes for terrain shadows: it stores, for every point and 16 compass directions, how high the ground rises, so asking it along the reflected ray says whether that ray reaches sky or hits a ridge. Two texture reads the terrain was already paying for. Deliberately lo-fi -- 16 azimuths and a point sample, so it is a soft rounded silhouette, not a ridgeline. Where it blocks, the surface takes the mountain's **own deep blue**, brightened by the sky's horizon luminance rather than being a dimmed copy of it: dimming a grey dawn gives a grey mountain, and what reads as land-against-sky is a shift in hue as much as one in brightness. A floor keeps a moonless midnight near-black-blue instead of an actual hole in the lake.
- **The reflection comes back darker and bluer than what it reflects.** One multiply, and it is the term that stops the lake reading as a hole cut through to a second sky. Physically it is the light the surface transmits instead of bouncing, and water swallows red first. Applied to the sky only and not to the glitter, which has its own gains -- otherwise two knobs end up fighting over one number.
- **Sun and moon glitter is a THRESHOLD, not a falloff.** `pow(d, sharp)` is the statistical answer -- the average over every facet inside one pixel -- and it is right for water too far away to resolve a wavelet and wrong for water at your feet, where a facet either points at the light or it does not. Real glitter is crisp specks of blown-out white in dark water with nothing in between. So the lobe is thresholded, and how hard rides on the same `near` term everything else does: hard up close, relaxing back to the smooth lobe at range. Thresholding *distant* water instead would make every pixel a coin flip as the head moves, which is the specular aliasing the distance fades exist to prevent. The gains are all above 1, so the core clips to white and only each speck's rim keeps the tint of the body that lit it.
- **Water is exempt from the night fog rule, and this is the one place it deliberately disagrees with the terrain.** Everything else fades toward `scene.fog`, whose colour is pulled well below the sky's after dark on purpose -- that is what hides the far terrain the moon cannot light. Water must not obey it. A distant lake is seen at a grazing angle where Fresnel is essentially 1, so it is a near-perfect mirror of the sky just above the horizon, which is why a lake at night reads *brighter* than the land around it. It still fogs with distance -- air still softens contrast over kilometres -- but toward `skyRadiance` along the horizontal part of the view ray. At full distance a water pixel becomes exactly what the dome behind it is drawing, so the two meet with no seam at all: a better match than `fogColor` ever gave, for one more call to a function the shader already had. Done in linear *before* the colour-space conversion, which is the opposite of three's own order, because three fogs afterwards only on the grounds that `fogColor` is authored in output space and this target is not.
- **No screen-space reflections.** Far too expensive, and at night nobody will miss them.
- **The aurora and the stars ARE reflected, via a probe -- and the sky deliberately is not.** Both are meshes with a dozen noise evaluations per vertex, not functions of direction, so the analytic path structurally cannot see them. `sky-probe.js` captures **those two and nothing else**, and water *adds* the result -- which is exactly how they are composited into the real sky, so the two paths agree by construction rather than by tuning. Capturing the sky as well would be a downgrade: a low-res capture of a smooth night gradient bands, which is the whole reason `sky.js` was never a cubemap. Splitting it this way is what makes the probe cheap enough to want: it carries only soft additive light, so 64 px a face is plenty, there is no gradient in it to band, and switching it off tomorrow would cost the lake its aurora and nothing else.

  **The unit of work is one FACE, not one capture.** The cost is not in the fragments -- 64x64 is 4k pixels -- it is all in the aurora's vertex shader, 11 slots x 181 samples x 10 rows = 19,910 vertices of fold, swoop, flare and hem noise. Six faces in one frame is the spike worth avoiding, so each update renders a single face and five updates come round. That fixes the per-update cost at one aurora vertex pass regardless of cadence, and it means the lever for making this cheaper is *less work per update*, not *fewer updates* -- the better trade, because a slower cadence shows as the reflection lagging the aurora while a thinner slice of work shows as nothing at all. Five faces, not six: water folds the reflected ray into the upper hemisphere, so -Y is never sampled. Half-float, because the aurora's dim end sits below one 8-bit step. Parallax is a non-issue -- the aurora is 5.5-17.6 km out, so a capture reused for 100 m of walking is about a degree off.

  **The layer trap, which is the reason this note is this long.** The obvious implementation moves the two meshes to a private layer and points the probe camera at it. In WebXR that is a bug in a very good disguise: three does `cameraXR.layers.mask = camera.layers.mask | 0b110` and then `cameraL &= 0b011`, `cameraR &= 0b101`. Layers 1 and 2 belong to the eyes and the mask is *three bits wide*, so an object on any layer above 2 is drawn by **neither eye** -- perfect on the desktop canvas, invisible in the headset. So nothing is moved: the aurora and stars stay on layer 0 and are additionally *enabled* on layer 3. Object layers are a mask and a camera draws when the masks intersect, so the eyes still see them via layer 0 and the probe camera -- an ordinary camera, outside the XR path -- sees them and nothing else via layer 3.

  Two more failures that are silent and photogenic, both now checked headlessly against a stub renderer: `CubeCamera` leaves all six cameras **unrotated** until `updateCoordinateSystem()` runs, which only its own `update()` calls -- miss it and every face captures the same slice of sky, uniformly wrong and never obviously broken; and leaving `scene.background` set fills all five faces with flat fog grey, turning the lake into a mirror of the fog.

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

### What shipped

`src/sky.js` (rewritten), `src/stars.js`, `src/aurora.js`. The cloud layer is still outstanding.

#### What the aurora actually is

Worth writing down, because nearly every shortcut in the implementation is licensed by one of these facts.

An aurora is not a light in the sky. It is the **upper atmosphere itself glowing**, along magnetic field lines, where precipitating electrons excite oxygen and nitrogen. Three consequences:

1. **Colour is a function of altitude and nothing else.** Atomic oxygen at 100-150 km gives the 557.7 nm green that dominates; above ~200 km the same oxygen gives 630.0 nm red (long-lived state, only survives where collisions are rare); ionised nitrogen at 80-100 km gives the 428/470 nm blue-violet that shows as the pink-magenta lower hem. So the vertical colour ramp is not art direction -- it is a spectroscopy table, and it is the single strongest cue that what you are looking at is real.
2. **All structure is vertical.** The rays are field lines. This is the constraint that decides the shader: the noise that generates striations must be indexed on distance *along* the arc and must **not** contain an altitude term. One character's worth of mistake there and the whole thing stops being an aurora and becomes coloured fog. The gate asserts it textually.
3. **It is optically thin.** You see straight through it, additively. That means no sorting, no transparency ordering, no depth writes -- and it means the fold-on-fold brightening where a curtain doubles back on itself is *free*, because it is just addition.

#### The factorisation

Lawlor & Genetti (2010) is the load-bearing idea: an aurora is a **2D curtain footprint x a 1D altitude deposition profile**. There is no 3D volume to march. The shipped geometry is 5 ribbons, each a long strip that follows a horizontal path and rises through 8 altitude bands at 86, 92, 100, 112, 132, 165, 210 and 260 km. 8,040 vertices, 14,000 triangles, one draw call.

#### What Skyrim does, and what was worth stealing

Skyrim's auroras are **authored meshes** under `meshes\sky\`, not a shader effect. Each band is a hand-modelled ribbon carrying **three stacked layers**, each with a `BSEffectShaderProperty` -- emissive, additive, unlit, no lighting model at all -- and each layer has its own UV-scroll controller running at a different rate, plus a vertex-colour tint.

**Stolen: the three-layer interference.** Three semi-transparent additive layers drifting at different rates produce a shimmer that no single layer achieves, because the *beat* between them is what reads as motion. The shipped version generalises it to 5 curtains at different distances (38 to 200 km) with drift rates from +0.077 to -0.058, deliberately opposed in sign so nearer and further curtains slide against each other and give real parallax as you walk.

**Rejected: UV scroll.** Scrolling a texture across a fixed mesh slides the *pattern* through a *static silhouette*. Real curtains do the opposite -- the silhouette itself morphs while staying in place. So the folds here are generated by noise where **time is the second noise axis rather than an offset added to the first**:

```glsl
float f  = ( aurNoise( vec2( km * 0.0125, t * 0.055 ) ) - 0.5 ) * 1.0;
      f += ( aurNoise( vec2( km * 0.0410, t * 0.130 ) ) - 0.5 ) * 0.52;
      f += ( aurNoise( vec2( km * 0.1350, t * 0.310 ) ) - 0.5 ) * 0.34 * act;
```

That is the difference between a curtain that slides and a curtain that *writhes*. The third octave is scaled by activity, so a quiet arc is smooth and a substorm gets small-scale curl.

#### The rest of the shader, and the fill-rate budget

- **Edge-on brightening.** A curtain seen edge-on is far brighter than one seen face-on, because you are looking along much more emitting gas. The fold displacement already gives an analytic surface normal (one extra noise evaluation via finite difference in the *vertex* shader), so `1/|dot(view, normal)|` clamped to 4.2x gives the effect for free and it self-animates as the folds move. This is the single highest-value line in the file.
- **Altitude deposition.** A sharp lower edge (electrons stop where the air thickens) and a long exponential tail upward, which is why real auroras have a knife-edge bottom and a soft top.
- **Ray crispness falls with altitude.** Striations are sharp in the green band and washed out in the red, because the red-emitting state is long-lived enough for the gas to move before it radiates.
- **Two noise evaluations** in the fragment shader, and the gate fails if a third appears. §13's "keep the fragment shader short" is the one budget in this file that is enforced numerically.
- Curtains have staggered activity thresholds, so a quiet night shows one arc and a storm brings all five in -- the Akasofu substorm sequence (quiet arc, folds, curls and breakup, recovery) rather than a single global brightness knob.

#### Depth, without any sorting

Additive materials land in three.js's transparent pass, which runs *after* the opaque pass has already filled the depth buffer. So `depthTest: true, depthWrite: false` gives correct mountain occlusion for both the aurora and the stars with no `renderOrder` games at all. Across all sixteen catalogued forms the aurora geometry sits between 5.5 km and 17.6 km from the player, inside the 20 km far plane, and its lowest point is 17.9 deg above the horizon -- high enough that no mountain can occlude it anywhere it should not. Since the rewrite the vertex buffer is all zeros and every coordinate is computed in the shader, so the gate mirrors that arithmetic on the CPU rather than reading the buffer: the price of a parametric mesh, and worth paying, because it checks all sixteen forms instead of one hard-coded arrangement.

#### Stars

2,400 points, spectral tints weighted to a real-ish O-through-M distribution, sized and brightened by magnitude with saturation rising with brightness. The Milky Way is **rejection sampling on the CPU** -- a density gradient in the point distribution, costing exactly zero shader instructions. Twinkle is two out-of-phase sines whose amplitude rises near the horizon, because scintillation is an air-mass effect and stars overhead barely twinkle at all. The field rotates about the true celestial pole for the world's latitude.

#### Night-sky banding

An 8-bit framebuffer bands visibly across a dark full-screen gradient. A quarter-LSB hash dither fixes it, and it has to be applied **after** the sRGB conversion, not before: near black, one 8-bit code step is about 0.0003 in linear space, so a dither sized in linear units is either invisible or enormous depending on where in the gradient it lands.

#### Cost when the sun is up

Stars and aurora both set `visible = false` when their fade reaches zero, so this entire system costs **nothing at all** during the day. The gate asserts it.

### Round two: twelve named forms, and fixing the curtain

The first aurora was one hard-coded arrangement of five curtains. It looked right and it was wrong in four specific ways, all of which came from the same root: **the mesh's own geometry was visible in the image**.

#### One shader, one mesh, a table of named parameter rows

The brief asked for at least ten aurora patterns, and flagged the obvious worry about a procedural or combinatorial version: harder to troubleshoot. Both halves of that are correct, and they are separable.

What shipped is **one** shader program, **one** BufferGeometry, and `src/aurora-patterns.js` -- a table of twelve **named parameter rows**. Every form is the same twenty numbers with different values. There is no per-pattern code path, no shader permutation, no branch that only some patterns take, and therefore exactly one program to debug. The geometry is deliberately contentless: nine identical parametric grids carrying nothing but `(aU along, aV up, aSlot)`. Everything that makes a band a *drapery* rather than a *SAR arc* lives in uniform arrays indexed by `aSlot`, which is legal because three.js compiles every non-Raw shader as `#version 300 es` and GLSL ES 3.0 allows dynamic indexing of uniform arrays. Switching the entire sky is a write of 200 floats.

The twelve are the standard auroral morphology, going back to Stormer's classification in the 1910s: **quiet arc, multiple arcs, rayed band, drapery, corona, breakup, omega band, diffuse patches, pulsating patches, picket fence, SAR arc, STEVE**. Ten of them get their colour from the altitude ramp like everything else. The last two override it, and they are the two that are *not* electron precipitation at all -- a SAR arc is thermal excitation of oxygen and STEVE is a hot plasma stream -- so the override is a statement about physics rather than an escape hatch.

The combinatorial part is confined to **which** named forms are up at once, and that is where the real work went.

#### The concurrency cap took three attempts

Up to three forms overlay at a time, each with up to three bands, and `MAX_CONCURRENT x MAX_BANDS == SLOTS` exactly, so overflow is impossible by construction rather than by clamping.

Choosing *which* three is the hard part, and it is a continuity problem:

1. **Sort by weight, keep the top three.** Pops. When the third and fourth swap rank the sky loses a whole curtain in one frame -- a step of 1.0.
2. **Adaptive cut**: let the weight of the first *rejected* form be a floor that every accepted form fades against. Rank-invariant, so swaps are smooth -- but *worse* in practice, and the gate caught it. When forms saturate at weight 1.0, a fourth form rising from nothing does not displace the marginal one, it **dims the entire sky at once**. Measured: a 0.43 drop across all three in a single step.
3. **Adaptive cut with no special case**, plus slower channels. The version that shipped.

The subtle bug in between: skipping the crossfade entirely when fewer than four forms were in play meant that the instant a fourth candidate crossed zero, the fade switched *on* for everybody -- a 0.21 to 0.08 step on a form that was not even the one changing. Removing the `cut > 0` special case removes it, because `cut = 0` then gives the same answer on both sides of that moment.

The continuity budget is arithmetic, not taste. The worst-case per-frame change in an output weight is roughly `3 x (rate of raw weight change) / CUT_WIDTH`, and a fade slower than about a second needs that under 0.02. That is *why* the pattern periods are hours rather than minutes: a fast channel and a hard cap cannot both be smooth, and the channel is the one that can give. Weights also carry the channel value as a small continuous term, so exact ties become measure-zero and rank changes become slow crossings rather than flips.

The gate sweeps two in-world weeks at **one-frame resolution** -- 1.2 million samples -- and reports the worst single-frame change in any form's weight. It is **0.0021**, i.e. a fade of about eight seconds end to end. It also asserts that all twelve forms actually occur, that the slot budget is never exceeded, and that the sky is **never empty while the clock says the aurora is up**, which would otherwise leave the HUD reporting a curtain that is not there. That last one is guaranteed structurally: the diffuse form's gate is set below zero so it is always a candidate, which is both convenient and true -- the diffuse aurora really is close to continuous.

`P` (or the right A button in VR) cycles auto, then each named form in turn, then back to auto. The HUD names what is up and its weight. A form you cannot summon is a form you cannot judge, and several of these are rare on purpose.

#### The four shape complaints, and where each one came from

> *the height of the curtains is too regular*

Every column reached the same altitude, so the band was a rectangle. Now each column's top is set by along-band noise (`ragged`), and separately by an **ovality** term that shortens the band toward its ends -- so a band is a lens in silhouette rather than a rectangle with soft edges. The end taper also widened from 14% to 30%. Together these are what make overlaid forms read as separate blobs of light rather than as stacked ribbons.

> *they feel too permanent and they need to shimmer and fade out more*

Added `flick`: individual columns fade out and back on their own schedule. A band whose every column is permanently lit reads as a painted object. A real one is continually rebuilt out of rays that live a few seconds each.

> *especially the bottom fringe should fade in and fade out in vertical streaks*

Added `fringe`: two octaves of fast, high-spatial-frequency noise, applied only to the lowest fifth of the column, so the hem breaks into short vertical streaks that come and go independently of the band above them. Higher up the rays merge, so the term is faded out there.

> *the top fringe is just a solid line, like the top of a fabric curtain*

This one was the most instructive. The old deposition function was keyed on **absolute altitude** and was still non-zero at the top row of the mesh -- so it drew the top row, and a row of triangles is a straight line. The fix is to key on **normalised height up the column** and multiply by a term that reaches exactly zero strictly inside the mesh. That is not physics, it is honesty about geometry: the top of an aurora has no edge at all, it dissolves. Normalising also means one deposition curve serves a 30 km picket fence and a 90 km SAR arc.

#### Everything constant up a column moved to the vertex shader

Column height, flicker, hem streaks, lobe mask, pulse phase -- all of them are properties of a *field line*, and a field line is a column. Computing them per fragment would be both slower and wrong. They arrive in the fragment shader as varyings, which is why the fragment noise budget is still **two** evaluations despite everything added, and why the gate's budget assertion still holds unchanged.

Nine slots at 181 x 10 vertices is 29,160 triangles, and an unused slot collapses to a degenerate vertex outside the clip volume (`gl_Position = vec4(0,0,2,1)`) before a single noise call, so carrying nine slots for the sake of three costs one early return and no fill.

### Round three: lower, rarer, twisting, and in more than one colour

Round two got the shapes right and the *presence* wrong. Four complaints, and one of them turned out to be a bug in the concurrency maths rather than a matter of taste.

#### Lowering it 30% without desaturating it

> *sometimes they go so high that it's like you're looking up into a conical tower from the inside*

The naive fix is to reduce `alt1`. It cannot be done that way, because **colour is a function of altitude** (§13 above) -- pulling the top of a band from 260 km to 180 km does not lower the band, it deletes its red crown. The altitudes are the physics; only the *geometry of where you stand relative to them* is free.

So the transform holds `alt0` fixed, pushes `dist` outward until the band's bottom elevation `atan(alt0/dist)` falls to **0.70x** its previous value, and only then trims `alt1` where the far plane bites. That cap is `hypot(dist, alt1) <= 320` km, against a 20,000-unit far plane at 45 units/km = 444 km. Bottom elevations went from 27-76 deg to **19-49 deg**; the highest line of sight in the catalogue is 79.9 deg (corona, which is *supposed* to be overhead -- that is what a corona is). A new gate check fences it at 80.

#### The presence envelope: mostly absent, rarely blazing

> *they're just two stable and steady presences in the sky ... they should often be down to 20% opacity, and 100% should be rare*

Round two's `flick` shimmer works at **2 km and seconds**. What was missing is a second envelope at **150 km and minutes**, so that whole *sections* of a band come and go while the band itself persists:

```glsl
float mac = aurNoise( vec2( km * 0.0062, t * 0.028 ) ) * 0.62
          + aurNoise( vec2( km * 0.0210, t * 0.070 ) ) * 0.38;
float presence = mix( 1.0, 0.10 + 2.10 * pow( smoothstep( 0.20, 0.90, mac ), 2.0 ), F.w );
```

The `pow(..., 2.0)` is the whole request in one operator: it makes the mean about **0.15** and the peak about **2.2**. Typical is barely visible; blazing happens, and it is rare. Deliberately separating the two scales by two orders of magnitude is what keeps them from reading as one noise -- a single envelope covering both would just look like static.

Since the mean fell to ~0.3 of what it was, the alpha gain went **0.46 -> 0.80**. An average moment is now a little under half as bright as round two and a rare one is about 3x brighter than round two ever got. Additive blending clips those peaks toward white on its own, which is what a substorm surge actually does. `breathe` is a per-form 0-1 depth knob on the whole envelope, so a SAR arc (the S is for *stable*) sits at 0.35 and a smoke plume at 1.0.

#### The bottom hem, and why it had to become per-column

> *the bottom hem needs a gradient fade like the top and the sides*

The hem's ramp width was a constant, so every column's bottom edge was equally sharp and the row of them read as a line -- the same failure as round two's top edge, one row down. It is now a **per-column** width, computed in the vertex shader and tied to the same noise that drives the hem streaks:

```glsl
float soft = mix( 0.08, 0.26, fr );   // fr is the hem-streak noise
```

so a column with a strong streak also has a hard bottom, and a column between streaks dissolves. One extra float in an existing varying, no extra noise call.

#### The vortex family, and the one parameter that generates all of it

> *a giant ribbon of smoke going up, electric-green mist swirling, rather than a curtain*

The literature calls these **auroral vortices**, and they come in a size taxonomy: **curls** at ~15 km, **folds** at tens of km, and **spirals** from 15 to 1300 km (typically 25-75 km), all winding counterclockwise around upward field-aligned currents in the northern hemisphere. "Flaming" is a separate thing -- a wave of brightness running *up* the field lines. ([Small-Scale Dynamic Aurora](https://pmc.ncbi.nlm.nih.gov/articles/PMC8550089/), [Zhou 2025 GRL](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2025GL114714).)

That taxonomy is the design: **four new forms, one mechanism, different scales.** The mechanism is a single line in the vertex shader --

```glsl
float shear = F.z * ( alt - baseKm );
float f0 = aurFold( km + shear, t, amp, B.w, uActivity );
```

-- which makes the sample point depend on altitude, so the fold pattern *leans* as it rises instead of standing straight up. Two things fall out of it that were not designed:

1. **A sheared curtain stops having a vertical edge.** Each altitude row samples a different part of the fold, so the silhouette twists and the thing reads as a volume rather than a sheet. That is the entire "smoke, not curtain" look, with no new geometry and no new noise call.
2. **Along-band drift becomes vertical motion.** With shear, a `drift` of `d` moves the pattern up the column at exactly `-d/shear`. So **flaming aurora** -- a wave running up the field lines -- is just a large shear plus a *negative* drift. The sign is not optional; a positive drift runs the waves downward, which looks like rain.

The four are **vapour spiral** (3 bands, shear 0.85-1.25, the big slow one), **auroral curls** (2 bands, shear ~1.0 at 2.6-3.1 Hz, the 15 km end), **flaming aurora** (2 bands, shear 2.2-2.5, drift -11 and -13), and **smoke plume** (2 bands, narrow spans of 24-30 deg, mostly invisible by design). None exceeds `ray > 0.5`, because a striated vortex reads as a curtain again; the gate asserts both the count and the softness.

Crucially, **no altitude term entered any noise lookup**. The shear moves the *sample coordinate along the band*, which is the axis the noise was always indexed on. So the round-one gate assertion that guards field alignment -- the one-character mistake that turns an aurora into coloured fog -- still holds textually and unchanged.

#### Folds got much bigger, and they grow with height

> *the "wrinkles" should be way larger -- currently each band feels kinda flat*

Fold amplitudes roughly doubled across the catalogue (drapery 44/38/28 km, breakup 64/56/30, omega band 66/54), and amplitude now **scales with altitude**:

```glsl
float amp = B.z * ( 0.55 + ( alt - 90.0 ) * 0.0072 );
```

which is physically the right sign -- the same transverse displacement of a flux tube spreads wider where the field is weaker -- and visually it is what turns a fold into a *fold*, because the bottom stays put while the top swings.

#### Colour per form, from two knobs

> *each time you change up the pattern, change the colour mix too*

Two per-form floats, both 0-1. `pale` slides both endpoints of the ramp together: 0 is the classic OI 557.7 green over N2+ violet, 1 is a pale alien mint over electric blue (which is the real N2+ 427.8 nm line, so this is still the spectroscopy table, just weighted differently). `crown` scales how much 630.0 nm magenta sits above ~180 km.

```glsl
vec3 violet = mix( vec3( 0.62, 0.18, 0.72 ), vec3( 0.18, 0.60, 1.00 ), vCol.x );
vec3 green  = mix( vec3( 0.14, 1.00, 0.44 ), vec3( 0.56, 1.00, 0.84 ), vCol.x );
vec3 col = mix( violet, green, smoothstep( 92.0, 111.0, alt ) );
col = mix( col, vec3( 1.00, 0.20, 0.46 ),
           clamp( smoothstep( 155.0, 235.0, alt ) * 0.85 * vCol.y, 0.0, 0.95 ) );
```

All sixteen forms now have a distinct `(pale, crown, tintAmt)` triple, and the gate requires at least eight distinct ones so a future retune cannot quietly collapse them back to one.

#### The floor had to be reserved, not merely likely

Round two guaranteed "the sky is never empty" by setting the diffuse form's gate below zero, so it was always a *candidate*. Going from twelve forms to sixteen broke that, and the gate caught it: **193 empty frames in 1.2 million.**

Being a candidate was never the same as being admitted. The soft top-K cut is `w * smoothstep((w - cut) / CUT_WIDTH)` where `cut` is the fourth-place weight -- permutation-symmetric and continuous, which is precisely what makes rank swaps invisible. But when four candidates **tie**, `w ~= cut` for all of them and the smoothstep drives *every* output to zero. Sixteen forms made four-way ties common where twelve had made them rare. The old guarantee was statistical, and statistics is not a guarantee.

The fix is structural: `SLOTS` 9 -> 11, `FLOOR_BANDS = 2`, a `floor: true` flag on diffuse patches, and `composeAuto` pulls it out *before* the cut and appends it unconditionally afterward. It never competes for a slot, so it can never be squeezed out by a tie. Empty frames: **0**. It also freed a competitive slot, which fixed a second failure in the same run (15 of 16 forms occurring, rather than 16).

`MAX_CONCURRENT x MAX_BANDS + FLOOR_BANDS == SLOTS` is asserted, so the "overflow is impossible by construction" property of round two survives the change. Eleven slots is 35,640 triangles in one draw call, and the two extra ones are the only slots in the buffer that are never degenerate.

#### Two gates added because of mistakes made writing this round

- **`minBands >= 1`.** A python slice while retuning silently deleted both `band({...})` rows from `flaming aurora`, and **every existing check still passed**: `[].every(...)` is vacuously true, no field was non-finite, no band exceeded the radius cap. A form with no bands is invisible and nothing noticed. Now it fails loudly.
- **HUD line width.** With a reserved floor plus up to three competing forms, the worst-case label ran to 98 characters against a 62-character panel budget (1024 px, 22 px margin, 26 px monospace at 0.60 em advance), and `fillText` does not complain -- it just draws off the edge. The label now budgets its width and appends `+N more`; the gate sweeps the composer and asserts the worst case fits. It is currently **60 of 62**.

Also: a GLSL comment inside a JS template literal must not contain a backtick. Five of them did, and the resulting `SyntaxError` pointed at a line 100 lines away from any of them.

### Round four: shear was not enough, and the catalogue got shorter

Round three's presence envelope, its vortices and its flaming form were all judged from inside the headset and all three came back wrong in the same way -- the *mechanism* was right and the *magnitude of the right axis* was not. The catalogue went 16 forms -> **12**, and three new per-band parameters exist.

#### The blur radius of an envelope is its wavelength

> *the blur envelope feels too narrow, so I'm seeing this very confined triangle of a curtain*

The instinct on hearing "the blur is too narrow" is to soften the transfer curve -- widen the `smoothstep`. That is the wrong knob and it produces a *dimmer* hard edge rather than a soft one. **What sets the visual softness of an envelope is the wavelength of the noise carrying it**, because that is what decides how many metres of sky the transition is spread across. Round three's octaves were 161 km and 48 km. At a band 250 km out those subtend a few degrees, which is the "confined triangle": the edge is sharp because it is short.

So the envelope was rebuilt as two octaves with *different jobs* rather than two octaves of the same job:

```glsl
float macA = aurNoise( vec2( km * 0.0028 + E.z * 0.7, t * 0.052 ) );   // 360 km, slow
float macB = aurNoise( vec2( km * 0.0069 + E.z * 2.3, t * 0.285 ) );   // 145 km, 5.5x faster
float region = smoothstep( 0.18, 0.88, macA );
float wash   = smoothstep( 0.06, 0.94, macB );
float presence = mix( 1.0, 0.08 + 2.55 * region * region * ( 0.22 + 0.78 * wash ), F.w );
```

`region` is which stretches of the band are lit tonight; `wash` is the flicker moving across them. They **multiply rather than sum**, and that is the load-bearing choice: summed envelopes regress toward their mean, so a band is always about half lit and never absent, while multiplied ones let either term veto -- which is what "mostly absent, occasionally blazing" actually is. The per-band seed offsets (`E.z`) are new too. Without them every band in the sky shares one envelope at a given `km` and they all fade in unison, which reads as the renderer dimming rather than as weather.

#### The hem has to snake, and perspective alone cannot do it

> *the bottom line of the curtain waves a little, but it should be dramatically waving across the sky ... very serpentine rather than one long flat line*

The honest mechanism for a wandering hem is perspective on a meandering ground track, and it is **bounded by the camera**: a band 250 km out cannot fold 60 km outward and still fit a 444 km far plane, and folding it that far buys only about 2 degrees of apparent vertical swing anyway. So the work is split between two terms with different costs.

- **A meander octave in `aurFold`**, weighted **2.30** against the base octave's 1.0 and four times its wavelength. Deliberately *not* scaled by the per-band `foldHz`, because otherwise a form with tight folds stops snaking and goes back to a ruled line -- the meander is the band's course across the sky, not its texture. This costs far-plane budget, and three bands had to be trimmed after it landed.
- **A "swoop"** that slides a whole column bodily up and down. It moves `baseKm` and `topKm` together, so the *normalised* deposition curve is untouched -- the colour ramp and the hem softness are functions of `h` in column-local space and cannot see it. It costs no radius at all.

Both amplitudes are tied to `fold`, so a form still has one sinuousness knob rather than three that have to be kept in agreement.

This changed the gate's arithmetic in a way worth recording. The fold bound was `0.5 x sum(weights)`, which is now 2.08, and applying that to every fence flagged eleven bands as too low or too overhead. The bound is not wrong -- it is the right bound for *the far plane*, where clipping even once a night is a visible bug. It is far too pessimistic for the **aesthetic** fences, because it prices a configuration where all four octaves peak in the same direction at the same instant. So the gate now carries two constants: the worst case for radius, and `0.45x` that -- about two sigma for a sum of four independent terms -- for the elevation fences. `elev 13.2..89.4` became `elev 16.5..75.2` with no change to the shipped catalogue.

#### Shear leans, twist turns -- and the difference is the whole vortex

> *Pattern 13 doesn't at all look like a vortex, it just looks like a triangle*

Round three built four "vortex" forms out of one parameter, `shear`. **`shear` offsets where the fold noise is sampled as a function of altitude.** The pattern therefore leans -- but the sheet it is drawn on is still a flat ribbon standing on a fixed ground track, so from any single viewpoint it is a leaning triangle. There is no far side, because there is no side.

The new parameter is **`twist`: degrees of *footprint azimuth* per km of altitude.** It rotates where the column *is*, not where its texture is sampled, so the band becomes an actual helix with a near limb and a far limb that you can walk around and look up into. It required reordering the vertex shader -- `km` is now computed first, because the azimuth depends on altitude, altitude depends on the per-column terms, and every one of those is a function of `km`, which itself depends only on `aU`.

The gate's vortex check now requires **both** `shear > 0.8` and `twist > 0.1` on every band, which is precisely the failure that shipped last round.

#### Flaming is brightness, not structure

> *there's not any pale light racing up into the sky as it describes*

Same class of mistake. Round three built flaming out of `shear` plus a negative `drift`, so what travelled upward was the *fold pattern* -- and a fold moving up an already-twisting column is not separable by eye from the twist.

Real flaming aurora is a disturbance propagating along a field line, and **the thing that moves is brightness**. So `flame` is a travelling wave on the deposition curve in the fragment shader:

```glsl
float wave = 0.5 + 0.5 * sin( ( h * 2.8 - uTime * 1.1 ) * 6.2832 + km * 0.055 );
dep *= mix( 1.0, 0.20 + 1.90 * pow( wave, 3.0 ), vCol.w );
```

This is **the one legitimate altitude term in the whole system**. §13's rule is that all *structure* is field-aligned and therefore no structural noise may contain a height term -- put one in the ray or fold lookup and the aurora becomes coloured fog. A brightness wave is not structure: it rides on `dep`, which is already a function of height, and nothing that defines the silhouette can see it. The gate asserts both halves -- that the wave is on `dep`, and that the ray lookup still contains no `h`.

#### Retiring forms without losing them

Four forms were cut: diffuse patches, pulsating patches, SAR arc and smoke plume. They are **not commented out.** Each row carries a `retired: '<why>'` string and `PATTERNS` is filtered out of a full `ALL` array.

A commented-out block is dead text -- nothing parses it, so its numbers drift out of agreement with the shader, and by the time you want the form back it no longer runs. A retired row is still a live object: the gate's geometry sweeps still see it, so it still has to fit the far plane, and it can be restored by deleting one line. The cost is exactly one new failure mode -- a retired row leaking back into `PATTERNS` -- which is what the two new checks catch.

Retiring diffuse patches had a consequence that nearly shipped as a bug: **it held `floor: true` and the two reserved slots**, so cutting it would have removed the guarantee that the sky is never empty. `quiet arc` was promoted to the floor and given a second band, which keeps `FLOOR_BANDS = 2` and `SLOTS = 11` exactly as they were.

One more: `STEVE` was declared the rarest form with `gate: 0.78` on a 24.8 h period, and drew **zero frames in a simulated fortnight**. Thirteen cycles of the selector noise is too few draws for a threshold that high, so "rarest" had quietly become "never". A shorter period (19.3 h) and a slightly lower gate (0.72) give the same ~0.6% duty at a sample count where that number means something. The pre-existing "every named form actually occurs" check is what caught it.

Twelve forms, `rMax 405 of 444 km`, `elev 16.5..75.2`, and the same eleven slots and 35,640 triangles as round three.

### Round six: the shader did not compile

The auroras were not dim, not mis-sited and not badly tuned. They did not exist.

`float mScale = 250.0 / A.x;` was declared twice in the same scope of the vertex shader's `main()` -- once for the swoop and once, a hundred and ninety lines later, for the meander. GLSL ES rejects a same-scope redeclaration, so the program never linked, so the mesh drew nothing, at every hour, under every pattern, from the moment round five landed. The error was sitting in the browser console the whole time.

Two things made it survive a full gate run and a round of re-tuning on top of that.

The first is that **this gate runs in node and cannot link a program.** Everything it knows about the shaders it knows from reading their source as text, so the entire class of "the GLSL does not compile" was invisible to it, and that class is fatal to every other check in the file at once.

The second is worse, and is a lesson about how to write a source assertion. The gate contained this check:

```js
check(/float mScale = 250\.0 \/ A\.x;/.test(auroraSrc), 'and that wave is measured in degrees of sky ...')
```

**A presence check cannot see a duplicate.** Two copies of the line satisfied it twice over, so the very assertion guarding the feature was reporting green *because* of the bug. Written as a count rather than a match, it would have failed immediately.

The fix is one deleted line. The check added alongside it is a same-scope redeclaration scan: pull every template literal containing a `main()` out of the shader-bearing files, strip comments, keep the first branch of each preprocessor conditional, walk the braces with one scope Set per block, and report any name declared twice in the same Set. Not a compiler and not trying to be -- it catches the one error class that is invisible to every other check here. It was verified the only way a check like this can be verified, by putting the bug back and watching it fail.

### Round six: apparent size is not a free variable

Round five below moved every band outward to put its hem near the horizon, verified that the hems had arrived, and shipped. The report was **"no auroras show up at all"**, and it was accurate.

What the gate never measured was what the move cost. Distance and apparent size are one knob, not two: pushing a band from 263 km to 1,180 km drops its hem from 20.8 degrees to -0.4, and in the same stroke shrinks it from 11.8 degrees of sky to 3.4. The always-on quiet arc became two ribbons 3.4 and 5.1 degrees tall, sitting in the part of the sky where the extinction term was also cutting them to a fifth. On an ordinary night -- which is quiet-arc-only, since it is the floor form -- that is a faint smear along the horizon and nothing else. Two thin dim ribbons is, for practical purposes, no aurora.

The way out is the third variable, which had been sitting untouched at ~170-250 km: **the top of the band**. Both the hem angle and the top angle scale as 1/distance, so raising `alt1` restores the angular height that distance took away, at any distance. And it is nearly free in two separate ways. It is free physically, because rayed structures genuinely reach 300-400 km -- the red-topped tall rayed band is one of the most photographed shapes there is. And it is free in the shader, because the deposition profile is normalised over each column's own height (`h = (alt - base) / (top - base)`), so a 300 km column is a *bigger* band, not a dimmer one.

Every form was re-sited a second time on that basis, as a **ladder rather than a shove**: a far low band whose hem is 0-5 degrees up, plus nearer bands that carry the mass. `multiple arcs` now runs 1,160 km / 620 / 300, from a band whose base is 0.2 degrees *below* the horizon to one reaching 38 degrees up -- 38 degrees of sky in one form, with a genuine below-the-horizon accent in it. The quiet arc is 960 km and 300 km, 1.7 to 40 degrees. Every named form is at least 10 degrees tall and ten of the twelve span 25 or more, against a headset field of view of about 50 degrees vertical.

The horizon extinction was narrowed to match. It reached full brightness at 5.7 degrees, which is precisely the band of sky the curvature term had just been built to fill -- so it was deleting the thing it was supposed to make possible. Now half strength on the horizon line and full by 2.6 degrees. The hard cutoff below -2.6 stays, because it is what stops a band whose base has sunk below the horizon from being drawn out over open ground past the edge of the terrain, where there is no depth buffer to occlude it.

Four checks were added, and they are the point of the round more than the numbers are. The gate now prints every form's vertical extent and asserts a floor on it, a floor on how many forms are "large", a separate floor on the always-on form, and a ceiling of 450 km on `alt1` so a form cannot buy its size by leaving the atmosphere. **A gate that measures where something is and not how big it looks will pass a catalogue that has been optimised into invisibility**, which is what happened, and it is the kind of failure that only a check written in the user's units can catch.

### Round five: it was a polar graph, and the far plane was buying nothing

Three complaints, and the first two turn out to be the same bug: *"they still seem like mostly straight, slightly wavery -- they're not folding back and forth on top of each other... the same segment never folds back over itself, but it should"*, *"many times the aurora should appear like just above the horizon, maybe even coming up from below the horizon, and quite large scale"*, and *"is that just a limitation of the shader?"*

**It was a limitation, and it was one line.** The footprint was

```glsl
vec3 p = dir * ( dist + fold ) + vec3( 0.0, alt, 0.0 );
```

which is a **polar graph**: radius as a function of azimuth. A polar graph is single-valued in its angle by construction. No amplitude, no octave count and no noise seed can make it double back, because two points on the band can never share a bearing. It can wander toward and away from the viewer, and perspective turns that into a hem that rises and falls -- so it *flaps* -- but a fold-back is topologically unavailable. Every round up to four had been tuning the amplitude of a shape that could not fold.

The fix is a **tangential** component. `aurFold` returns a `vec2` now: `x` along the footprint normal as before, `y` along the tangent, and the position is

```glsl
vec3 p = dir * gd + tng * f0.y + vec3( 0.0, alt - drop, 0.0 );
```

That makes the footprint a general parametric curve in the ground plane, and a general curve may loop. Walking the band, along-track speed is `1 + d(tangential)/d(km)`; where that goes negative the track reverses and the same stretch of sky gets two pieces of curtain, one behind the other. Being optically thin and additive, the overlap is *brighter*, which is what the photographs show.

The tangential octaves are **the same noise sampled a quarter wavelength along**. A quarter-wave offset between two components traces a circle, so each octave contributes a loop rolled along the band -- the trochoid family, which is what an auroral curl physically is. Independent noise in the second axis was tried first and gives a curve that wanders in two axes without closing: jitter, not coiling.

`curl` is the per-form tangential amplitude as a multiple of the radial one, and it is allowed past 1 because the two axes cost different things: the radial component is depth, which the eye barely reads at 300 km, while the tangential component is all visible.

#### The gate had to grow a noise implementation

"Does it fold back" cannot be read off a parameter -- two bands with identical `curl` fold a different number of times depending on fold wavelength, span and distance. So `aurHash`/`aurNoise`/`aurFold` are ported to JS in `check-daynight.mjs` (the uint32 wrap is `Math.imul(x >>> 0, k) >>> 0`), the footprint is walked, and the measurement is **the number of times its bearing reverses** -- zero being exactly the old polar graph. Measured per frame, worst band of each form:

| | | | |
|---|---|---|---|
| quiet arc 5.4 | multiple arcs 6.3 | rayed band 15.5 | drapery 18.1 |
| corona 8.6 | breakup 28.4 | omega band 2.9 | picket fence 4.6 |
| STEVE 0.3 | vapour spiral 2.2 | rising column 4.3 | flaming aurora 12.4 |

Two reversals is one loop. The gate asserts at least nine of twelve forms average two or more, that the always-on floor form is one of them, **and that at least one form stays straight** -- STEVE is a narrow ribbon, not a curtain, and a catalogue where everything writhes is as wrong as one where nothing does.

The three structural octaves were also slowed about a third (0.020/0.055/0.130 -> 0.014/0.038/0.085). A fold that comes and goes in eight seconds reads as flicker; the same fold over twelve to fifteen seconds reads as the sheet winding and unwinding. The fourth octave stays fast on purpose: that one is the breakup flicker.

#### The shell: the far plane was pricing something nobody could see

The near-horizon half of the request was blocked by arithmetic. A 100 km band whose hem sits 4 degrees up is 1,400 km away; at 45 units/km that is 63,000 units against a 20,000-unit far plane. Three rounds had been spent trimming folds and altitudes to fit inside 444 km.

But **an aurora's distance is not an observable.** It is sky-locked (walking the whole 16 km world moves it under 5 degrees) and 250 km is infinity to a 64 mm interpupillary baseline, so there is no parallax and no stereo disparity. Everything you can see about an aurora is its direction and its colour. So the finished position is normalised onto a shell at 14,000 units -- past the far corner of the world (11,600) and inside the far plane -- and distance becomes free.

This *improves* occlusion rather than compromising it: every aurora fragment is now further away than every mountain, so the only thing that can hide an arc is a silhouette in front of it, which is the only thing that should.

#### And then the Earth had to be round

Freeing the distance was not enough on its own, because on flat ground elevation is `atan(alt / dist)` and a 100 km band at 1,200 km is still 4.8 degrees up -- it never reaches the horizon, it just asymptotes. The missing term is the ground falling away:

```glsl
float drop = gd * gd / 12742.0;   // d^2 / 2R, R = 6371 km
```

Under a band 1,000 km away the ground has dropped 78 km below the tangent plane you are standing on, so a base at 101 km altitude is 23 km above *your* horizontal -- 1.3 degrees, not 5.8. Past about 1,130 km the base has gone under the horizon and only the tops of the rays show. That is the requested sight, and it is not a hack: it is the single largest effect acting on where a distant band appears, and every photograph of a low arc is showing it.

It is applied **only to the position**. `vShape` carries the true altitude, because altitude is what sets the colour and the deposition profile and neither cares where the observer stands. The gate asserts the ordering in the source, which makes the mistake structurally impossible rather than merely absent.

It also uses `gd` (distance *including* the radial fold) rather than the band's nominal distance, so a stretch folding 60 km further out sinks another 11 km and the hem weaves across the horizon line for free -- the honest version of what the `swoop` hack approximates.

#### Two lengths are now measured in degrees, not kilometres

The **meander** and the **swoop** are the structures whose size the eye judges angularly. Left metric, a 1,000 km arc showed four times the swings of a 250 km one across the same span of sky -- texture instead of a course. Both are now scaled by `mScale = 250 / dist`, normalising them to a 250 km reference band. Everything else stays metric, because folds, curls and rays are real lengths and really should get finer with distance.

The swoop also gained a cap, `min(fold, 26)`. Amplitude was tied to `fold` so a form has one sinuousness knob, but the far bands now carry folds of 60-130 km, and a hem sliding 60 km up and down is not a swoop -- it is the band leaving the altitude range that gives it its colour.

Extinction was widened to match: `smoothstep(-0.05, 0.10, view.y)` from `(-0.03, 0.14)`. The old window reached full brightness by 8 degrees, which was fine when nothing was catalogued below 13 and would have deleted the picket fence and most of the far arcs outright.

#### The catalogue, re-sited

Distances went from 94-288 km to 94-1,180 km, and hems from 16-75 degrees to **-0.4 to 69**. Eight of twenty-nine bands sit within five degrees of the horizon, including the floor form's, so an ordinary night has a low arc. `picket fence` moved to 900 km, where it stands on the skyline at 2.3 degrees, which is how picket fences are actually seen. `corona` did not move at all -- it is the zenith form.

`MAX_RADIUS_KM` changed meaning with everything else: it was a projection-matrix limit (365 km), it is now a physical one (1,600 km), the distance at which curvature has swallowed even the tallest band's top.

Twelve forms, hems -0.4 to 69 degrees, and the same eleven slots and 35,640 triangles as round three.

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
   **The Blender half is built** -- `tools/props/`, `npm run props`, gated by `scripts/check-props.mjs` (in `npm run check`). 160 assets in 4 size classes, 78.4k triangles across every LOD, 122 texture layers of a 256 guarantee, 4.68 MB on disk. The LOD question it was blocking on is answered and derived in `scripts/probe-prop-lod.mjs`: **two mesh tiers plus the impostor, and the ladder is per size class** -- see §5's table and §9 for the pipeline itself.
   **"One species end-to-end before forty" earned its place, several times over.** Every bug worth finding was silent: the exporter dropped every baked vertex colour because no material node read the layer (loads fine, renders flat), the normalisation helpers were written against +Y when Blender's world is +Z (150 assets exported half-buried, looks fine in the viewport), the decimator leaves the vertices it collapses in the mesh, so every measurement taken after it reads the pre-decimation silhouette and the renormalisation pass runs as a no-op (assets export the wrong size, looking like a decimation artefact), and `transform_apply` bakes an object's *local* basis only, so a mesh parented to a Megascans `world_root` empty kept that empty's 0.01 scale and -90° rotation in the node hierarchy and shipped 100× too large and on its side while every in-Blender measurement read correct. None is visible in a screenshot; all four are one assertion each against the exported GLB bytes.
   **What the pipeline cannot do is the finding to carry into step 5.** The collapse decimator will not collapse across an open boundary and does not report that it stopped, so buildings floor out well above target -- which is *why* §5 now has a one-mesh-tier `structure` class -- and photoreal card foliage cannot be decimated at all (1.4M → 274k tris for a 500 target). Four such assets were built, measured and excluded. Sources have to be game-ready or get authored as cross-cards; there is no conversion setting that rescues them.
   **A second shopping run then turned that finding into a purchasing rule.** 18 candidates, every one measured by `probe-source.py` before anything was built, which is the instrument the first round's four build-and-measure rejections paid for. **Photoscans are the ideal source and photoreal card foliage is the worst**, and the two are two orders of magnitude apart on the one statistic that matters: Megascans "Raw" scans measure 0.0-0.1% boundary edges and drop from 2M triangles to exactly 500 in a single round, while the card foliage in the same batch measured 42-52% and floored an order of magnitude over budget. 13 were accepted, three rejected on that floor, and two on grounds that have nothing to do with triangles (a tropical croton in a snowy range; a tree whose bark and leaf atlases are separate unreferenced materials). The rule for future shopping: **ask for photoscans or game-ready meshes, never for photoreal foliage, and probe before adding.**
   **Still open:** the runtime half. Nothing loads `public/props` yet -- `src/props/scatter.js` still builds its geometry procedurally. Compression (meshopt + KTX2) is not done, and the KTX2 *array*-texture round-trip is still unverified.
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
