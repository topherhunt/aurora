## 2. World structure and resolution

> **Covers:** world size, grid resolutions, and Phase A as built -- priority-flood, D8 flow accumulation, least-cost breaching, biome fields, village siting.
> **Read this when:** touching `src/sim/hydrology.js`, `src/sim/phase-a.js`, or `map.html`.

**Bounded world: 16 km × 16 km.** Bounded is a feature -- coherent hydrology needs to know where the outflow is, and infinite terrain with correct rivers is an open research problem. At walking pace she will never find an edge.

### Resolution: three distinct grids, do not conflate them

This is the answer to "does a 7.8 m cell mean 8 m flat polygons?" -- **no.** There are three separate resolutions and only the finest one is ever rendered.

| Grid | Resolution | What it is for | Rendered? |
| --- | --- | --- | --- |
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

> `g(next) = max(g(current), barrier)`**, not** `g(current) + barrier`**.** A *sum* cost minimises the total volume cut, and volume grows with length, so it forces near-shortest paths -- a straight line with a wiggle. A **bottleneck (minimax)** cost asks only *how high is the highest thing I must cross*, and once the path is under that height it is free to wander. That one substitution is the difference between a river network and a road network: it makes the channel hug the valley floor instead of striking out across it. Sum cost was tried first and reduced the straightness without curing it.

Two smaller things that fall out of it. The bottleneck and the low-ground tie-break must be carried in **separate arrays** and combined only into the heap key -- folding the tie-break into the running cost lets it accumulate through every subsequent `max()` and slowly turns the bottleneck back into a sum, which is the exact thing being avoided. And a tie-break is *required*: below the bottleneck height every cell is free, which is the same degenerate flat the spanning tree had, so without a small preference for lower ground the straight lines come straight back.

**The straight lattice was not caused by the breach, and assuming it was would have wasted the round.** The first hypothesis was the obvious one. It was disproved by rendering flow accumulation with breaching disabled entirely -- the lattice was already there, produced by routing over the 43% of the map that filling had raised to flat lake surfaces. The breach was reproducing a defect it inherited. `flowDirections` still resolves flats by following the flood tree, so **a residual lattice remains in the raw flow field wherever a flat survives; Garbrecht & Martz flat resolution is the standard fix and is a named follow-up.**

**The knob is "how much surface area a lake may keep", and that framing was arrived at by measuring and rejecting three others.** Worth recording, because each of the three is the obvious first idea:

1. *Cap the cut depth, refuse anything deeper.* Binary on this terrain -- a cap of 85 m leaves 33% of the map as lake, a cap of 100 m leaves none. Every basin here is 85-100 m deep, so they all flip together and no setting yields "a few lakes."
2. *Cap the cut, incise partially, iterate to convergence.* Not idempotent, and not convergent: a partially drained basin still has a floor with no lower neighbour, so each pass incises another `maxDepth`. Ten passes never converged. Iterating is just full breaching taking longer.
3. *Cap the retained depth.* Idempotent and continuous, but it makes every lake exactly as deep as the cap. At 1-2 m a 0.7 km² body is a flooded meadow.

**The world currently has no lakes at all, and that is a decision rather than a default nobody looked at.** Measured sweep of `BREACH.maxLakeArea` on seed 20260804 at 1024²:

| max lake area | water | bodies | biggest | passes to converge |
| --- | --- | --- | --- | --- |
| 0 km² | 0.00% | 0 | \-- | 7 |
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

**Phase A does not write its carve back into** `TerrainHeight`**.** `heightAt` stays a pure function of the noise stack, every existing gate still measures the surface it has always measured, and nothing the player walks on has moved. The pass returns `base` (raw analytic) and `elev` (carved) side by side, and applying the delta per chunk is Phase B's job -- it needs the D8 path splined and given a channel profile before it touches a 0.5 m heightmap. **Until that exists, the streams here are correct routes over a surface the renderer does not yet show.**

**The 1-3 second budget above is not met.** Measured at 1024²: 3,850 ms total, of which elevation sampling is ~950 and breaching ~2,400 (7 passes, deepest cut 99 m). Breaching roughly tripled when the spanning-tree walk became a Dijkstra search, which is the price of the shape and worth paying. At 2048² this extrapolates to roughly 15 seconds. Sampling dominates, and it is embarrassingly parallel, so the two outs are a worker pool or accepting a 1024² sim grid -- note that §2's own resolution table treats 8 m as a floor for *stream topology*, not for anything the player sees. Not resolved.

`scripts/check-phase-a.mjs` gates all of this in nine sections (43 checks) and is part of `npm run check`, which is now 102 checks across the three suites. The hydrology invariants are the load-bearing ones: no receiver uphill, no receiver out of priority-flood order, nothing filled below its original height, the flow graph acyclic, and mass balance exact -- all 4,194,304 cells reaching the edge at full 2048².

`map.html` **is the 2D canvas map view §14 step 3 asks for**, and it is the eye that "tune it by eye" refers to. Nine layers (relief, elevation, breach cuts, depression depth, flow accumulation, moisture, biome, slope/walkable, reachability) with four overlays and a per-cell readout, running Phase A in a real Web Worker so the load-path arrangement gets exercised rather than simulated. It is strictly a reader -- it recomputes nothing except hillshade, which is presentation -- because on this project's record the fastest way to get a twelfth drifted instrument is to let the debug view compute its own version of the field.

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
