## 5. Rendering architecture

> **Covers:** the quadtree LOD scheme, `LOD.triDeg`, the triangle budget table, `BatchedMesh` vs `InstancedMesh`, and the prop LOD ladder.
> **Read this when:** anything renders more or fewer triangles than it did. This is where the budget lives.

### The load-bearing decisions

1. `THREE.BatchedMesh` **for props,** `InstancedMesh` **for the far card bands.** `InstancedMesh` draws N copies of one geometry. `BatchedMesh` uses `WEBGL_multi_draw` to draw many *different* geometries in one call, provided they share a material. The entire prop library -- every tree variant, rock, building, and LOD tier -- collapses into a handful of draw calls. Per-object frustum culling is built in. LOD switching is `setGeometryIdAt(instanceId, geometryId)`: one call, no rebuild, no change in draw call count. **But** `BatchedMesh` **charges for that culling every frame, per instance, on the CPU** -- see "the crossover" below, which is why the far foliage bands do not use it.
2. **One material for all props**, backed by one `sampler2DArray`. See §9.
3. **Alpha test, never alpha blend, for anything batched.** See §7.

4. **Terrain goes through** `BatchedMesh` **too** -- decided at build step 2, and not what the original draft assumed. See below.

Water, sky, and weather each get their own material and their own draw calls. That is expected and budgeted.

### Terrain is batched, for the same reason props are

The first draft of this section said terrain "gets its own material and its own draw calls. That is expected and budgeted," on the assumption that a quadtree produces a handful of chunks. It does not. At the shipped step-2 parameters the selector returned **502 leaves**, which as one `THREE.Mesh` per chunk is 502 draw calls against the 60 the §0 measurements allow -- before a single tree exists.

So terrain uses one `BatchedMesh` with a pre-allocated pool of fixed-size geometry slots, and streaming a chunk in is `setGeometryAt()` on a recycled slot rather than an add/remove from the scene graph. **The whole 16 km world is one draw call.**

This is legal only because every chunk has identical topology -- same `CHUNK_RES`, therefore the same vertex and index count -- so a freed slot always fits whatever arrives next. **If chunk resolution ever varies by LOD level, the slot pool has to become size-classed.** That is the constraint to remember before "optimising" coarse rings to a lower resolution.

Verified on `three@0.180`: `setGeometryAt` reuses a slot in place and throws only if the incoming geometry exceeds the reserved counts; it re-clones `boundingSphere` from the source on every call, so per-instance frustum culling stays correct across reuse; and the batch index widens to `Uint32` automatically once the pooled vertex count passes 65535.

### Hole-free LOD swaps: three separate things have to hold

The reported artifact was a square of terrain blinking out to the horizon colour for a few frames while flying *away* from close detail, then reappearing low-poly. Not wrong terrain -- **no** terrain, with the sky showing through. Guarded now by `scripts/probe-hole.mjs`, whose worker stub delays replies by six frames; the existing checks never saw any of this because their stubs answer inside the requesting frame, so no chunk is ever actually absent.

1. **Every node needs a loaded ancestor.** Depths 0-2 (21 chunks, 256 m cells) are pinned forever so an unloaded node can always draw *something*. They were never being built: `_seedBaseLayer` pushed its requests onto `terrain.queue`, and `_select` replaces that queue wholesale from the desired set on the first `update()`, before `_pump` has ever run. Measured on a settled camera: depths 0 and 1 were **0/1 and 0/4 resident**, depth 2 was 4/16, and the only reason those four existed is that they were far enough away to be desired in their own right. `_loadedAncestor` was therefore returning null ~2100 times over a 2 km back-away, and a node with no stand-in draws nothing. The base layer now has its own queue that selection cannot discard.

2. **Coarsening has to look DOWN the tree, not up.** A coarse node is not in the desired set while you are standing on top of it, so it is never requested and the LRU drops it; receding puts it back in the set cold. Its children are resident and cover exactly the same ground -- so `_select` tries a complete cover of loaded descendants *before* an ancestor. All-or-nothing: a partial cover is the same hole in a more interesting shape. With this disabled, backing away falls through to the base layer and draws 256 m cells sitting 69 m below the ridge; with it, the coarsest cell drawn within 250 m stays at 4 m and the worst error is 6 m. This is the mechanism the request asked for -- the low-poly tile phases in *before* the high-poly one is released -- and it costs no slots, because a cover is made of chunks that were already resident and already being drawn.

3. **Eviction has to be counted in slots, not cache entries.** The cap used to apply to `cache.size`, which counts queued entries holding no slot at all -- a different number by a hundred or more while streaming. A frame that requested 150 chunks would push the cache over its cap and evict ground that was being drawn to make room for nodes that own nothing yet. That is a hole *produced by the eviction policy*, and it appeared the moment the base layer started working. The target is now ready (slot-holding) entries, set to `SLOT_COUNT` minus the in-flight cap so every reply that lands between two `_evict` calls is guaranteed a free slot -- which is what makes the "slot pool exhausted" throw unreachable rather than merely unlikely.

Stand-in retention is bounded (`maxReady − desired − 21`) and spent nearest-node-first, and `_evict` will reclaim stand-ins as a last resort rather than throw. Measured peak: 39 chunks over the desired count, 704 of 768 slots, zero missing sample points across a 85 m/s back-away, a 60 m/s climb, a full spin, and a 765 m/s stress run that cannot stream fast enough and correctly degrades to the base layer instead of to sky.

### What actually binds, per resource

Triangles are the only budget this document tracked for its first six months, and they are not the one that binds for a dense foliage carpet. Measured on desktop (`tmp/` benchmarks, 2026-08-24), these are the four separate ceilings and what each one is actually made of:

| Resource | Cost, measured | What it scales with |
| --- | --- | --- |
| **Triangles** | ~350k/frame on Quest 2 | tris/prop x visible props |
| **Per-instance CPU** | **37 ns / visible instance / frame** in `BatchedMesh.onBeforeRender` with `sortObjects` on (24% of it is the sort; 31 ns with sorting off) | instance count, *regardless of triangle count* |
| **Placement CPU** | `TerrainHeight.heightAndSlopeAt` is **4,912 ns**. The hash that yields position, tint, scale, yaw and variant is **34 ns** -- 145x cheaper | terrain field queries, not randomness |
| **Fill rate** | a 2 ferns/m² carpet with cards to 510 m is **1.73x one eye buffer** of alpha-tested quads, and **82% of that is the nearest 12 m** | near-field density, *not* draw distance |

Four consequences, all of which contradict something an earlier draft of this section assumed:

- **A billboard is not cheap because it has 2 triangles; it is expensive because it is an instance.** At 76,000 individual cards -- what 2 ferns/m² with density halving per distance doubling produces out to 510 m -- `BatchedMesh` spends 2.8 ms/frame on desktop, ~11 ms on Quest 2, on nothing but culling and sorting. That is the whole frame. The triangles for the same scene are 208k, which Quest 2 can nearly afford.
- **Draw distance is almost free; near density is not.** The 25-510 m card band costs 0.15x the eye buffer in fill. The nearest 12 m costs 1.42x. Pushing cards from 60 m out to 510 m is a rounding error on fill rate; doubling density at your feet is not. So **push the draw distance out and tune the near density down**, which is the opposite of the instinct.
- **Procedural randomness is free and terrain queries are not.** See §6 -- placement must sample a cached raster, never the height field.
- **Below ~10 triangles per instance, the mesh class matters more than the mesh.** Hence the crossover below.

### The `BatchedMesh` / `InstancedMesh` crossover

Verified against `three@0.180` sources and benchmarked:

`BatchedMesh.onBeforeRender` loops over **every** allocated instance every frame -- reading its matrix, transforming its bounding sphere, frustum-testing it, and pushing survivors into a list that is then sorted. That is what buys per-instance culling and per-instance geometry selection, and it costs 37 ns each.

`InstancedMesh` has **no** `onBeforeRender` **at all**. It is one draw call, culled as a single object against its own bounding sphere. Per-instance per-frame CPU is exactly zero. What it gives up is per-instance geometry choice (one geometry per mesh) and per-instance culling.

So the rule is not "batched is better", it is:

> **Many geometries, few instances ->** `BatchedMesh`**. Few geometries, many instances ->** `InstancedMesh`**, tiled.**

The near bands are hundreds of instances across dozens of variants: `BatchedMesh`, as built. The far card bands are tens of thousands of instances of *one* geometry: `InstancedMesh`, one per world tile so the scene graph culls whole tiles for free. At 128 m tiles a 510 m reach is ~64 tiles, of which ~20 are in frustum -- about 20 draw calls against the 40-50 Quest 2 allows, and **zero** per-frame per-instance cost. Rewriting a tile's matrices costs 32 ns each and is paid only when that tile is rebuilt, one tile per frame (§6).

This is the regime §0 flagged as untested and guessed wrong about: it assumed batching's win was "thousands of cheap objects", and thousands of cheap objects is precisely where batching loses.

### Budget

Per eye, at 72 Hz. three.js renders once per eye (no multiview -- `OCULUS_multiview` has never been merged into three.js core), so `renderer.info` reports roughly double the per-eye figures.

**Ceiling: ~350k triangles per frame as** `renderer.info` **reports them (§0, derived).**

Treat the per-layer numbers below as a budget to be *defended*, not a floor to build up from. If a layer wants more, another layer gives it up.

| Layer | Visible count | Tris each | Total (HUD) |
| --- | --- | --- | --- |
| Terrain, `triDeg` 5.72 | 71 drawn chunks | 640 | 45k |
| Trees 0-30 m | 30 | 500 | 15k |
| Trees 30-130 m | 120 | 130 | 16k |
| Trees 130-500 m (3 quads) | 900 | 6 | 5k |
| Forest clump cards past 500 m | ~200 | 6 | 1k |
| Ferns 0-5 m (LOD0, 6 seg) | 39 | 84 | 3k |
| Ferns 5-10 m (LOD1, 4 seg) | 118 | 56 | 7k |
| Ferns 10-26 m (LOD2, 2 seg) | 610 | 28 | 17k |
| Fern cards past 26 m, clumped | \-- | 2 | not built |
| Boulders 0-430 m | 440 | 20 | 9k |
| Grass class 0-23 m | 1,600 | 4 | 6k |
| Village buildings | 20 | 800 | 16k |
| Water surfaces | \-- | \-- | 5k |
| Snow particles | 1 draw | \-- | 4k |
| Sky dome + aurora | \-- | \-- | 2k |
| **Total** | ~5,300 instances |  | **~151k** |

**~151k against a 350k ceiling is 43%**, leaving ~199k for thermal margin and for the rows that are still estimates. Terrain and the four fern/boulder rows are measured -- the fern rows come from a settled `Scatter` at 114,39 (767 ferns, 27.3k triangles), the boulder row from the same run. Every other row is still an estimate.

The fern rows are also the honest record of a shortfall: they are what a **0.46 ferns/m²** scatter produces, not the 2 ferns/m² this document prices everywhere else. The binding cost is the rebuild, not the triangles -- every candidate cell in the disc pays a hash and most survivors pay a `heightAndSlopeAt`, and the cell count goes as `(radius / spacing)²`. Closing the gap by tightening spacing is quadratic in rebuild time and would blow the frame. The fix is that ferns grow in patches: scatter a few cluster centres and fill each one, which buys high local density for a fraction of the candidate cells. That is a placement change and it is not built.

Two things changed to make this fit, and both are decisions rather than tuning:

- **Terrain coarsened from a 1.2° triangle cap to 5.72°**, 371 drawn leaves to 71, 237k triangles to 45k. On Quest 2 the ground cannot have 68% of the frame, and this is the single largest triangle recovery available anywhere in the project -- 192k, more than the entire prop budget. `[` and `]` live tuning stays.
- **Instance count is now a budgeted quantity, not a footnote.** ~9,500 visible instances at 37 ns is 0.35 ms/frame desktop, ~1.4 ms on Quest 2, which fits. The far card bands are excluded from that figure because they are `InstancedMesh` and cost nothing per instance -- which is the only reason the row above them can afford 3,700 cards.

### Download budget -- a non-issue, which is the liberating part

- Texture arrays, 128×128 × ~150 layers, RGBA8: ~9.8 MB uncompressed, **~1.5 MB with ASTC 6×6**. See §9 -- compression is required, not optional
- ~80 assets × ~500 tris, meshopt-compressed: **~1-2 MB**
- World data: **0 bytes** (it is a seed)

**Under 10 MB total.** Go wide on asset variety. The constraint is `MAX_ARRAY_TEXTURE_LAYERS` and Meshy generation time, not bandwidth.

### Distance tiering

**Terrain LOD: one rule, one knob, one unit.** Quadtree chunks at a **constant** `CHUNK_RES` (16), splitting while `cell > range * tan(LOD.triDeg)` -- cell being the node's grid spacing in metres and range the 3D distance from the eye to its box. A length over a range is an angle, so the rule reads straight off the screen: **refine until no triangle looks wider than** `triDeg` **degrees.** Every visible triangle, underfoot or on the horizon, gets the same angular size, and it is bounded by construction rather than on average. Chunk size halves with depth; vertex *density* therefore doubles, but vertex *count* stays fixed -- which is what lets every chunk share one slot size in the batch. **Skirts** (vertical flanges at chunk edges) hide cracks between adjacent levels -- far simpler than stitching and invisible in practice. Fog and atmospheric desaturation hide popping and do most of the work of selling scale.

This replaced a raw distance test (`boxDistance < size * splitK`) plus a per-node elevation bias, which produced angular inversions -- near ground blockier than far ground, with a hard seam at quadrant boundaries. A per-node **geometric error** term was also built, measured and removed: this height field is fbm, so its roughness is scale-invariant, which makes a cell-size cap already an error cap. Both arguments are written out in full at the top of `src/terrain/quadtree.js`, including why raising `CHUNK_RES` to buy back angular error costs *more* triangles at equal quality rather than fewer. `triDeg` is live-tunable with `[` and `]` because it is a judgement call that has to be made looking at ridgelines in a headset.

**The cap is the terrain's entire share of the frame, and it is the biggest single lever in the project.** Two ceilings, not one: *selection* holds slot-pool entries and must never overrun `SLOT_COUNT` (768) because the current selection is exempt from eviction and overrunning throws; *drawn* is the part inside the 110° eye cone, and that is what spends triangles. Worst case over 606 positions × 4 headings, half of them airborne (`scripts/probe-trideg.mjs`, same cameras and cone as `check-sim.mjs` section 5):

| `triDeg` | selection + 21 pinned | drawn leaves | drawn tris | % of 350k |
| --- | --- | --- | --- | --- |
| 1.2 (was the default) | 670 | 371 | 237k | 68% |
| 1.8 | 424 | 219 | 140k | 40% |
| 2.2 | 340 | 176 | 113k | 32% |
| 3.0 | 277 | 123 | 79k | 22% |
| 4.0 | 223 | 95 | 61k | 17% |
| **5.72** (ships) | **163** | **71** | **45k** | **13%** |
| 7.0 | 139 | 59 | 38k | 11% |
| 7.2 | 22 | 1 | 1k | 0% |

**5.72° ships.** It was picked by eye with the `[` `]` keys on a ridgeline and then measured, which is the right order for a knob whose whole purpose is a judgement about how chunky is tolerable. It is coarse and it is meant to be: the ground is the backdrop, and 192k triangles is more than the entire prop budget.

**10% of the frame is not reachable with this knob**, and the reason is a floor rather than a tuning failure. Below about 11% the cost stops being "how many splits" and becomes "how many chunks × 640 triangles each", and 640 is fixed by `CHUNK_RES` 16 -- 512 surface triangles plus **128 of skirt, 20% of every chunk drawn**. The levers that would actually reach 35k are `CHUNK_RES`, cheaper skirts, or a smaller `VIEW_HALF_ANGLE`; none of them is this knob, and none is worth spending before the ceiling itself is measured on the device.

**The 7.2° row is a cliff, not a data point, and** `MAX_TRI_DEG` **now stops short of it.** Range is floored at a node's own half-size, so for any node containing the camera the split test reduces to a constant:

> `cell / range = (size / CHUNK_RES) / (size / 2) = 2 / CHUNK_RES = 1/8`

Size cancels, so past `atan(1/8) = 7.125°` *no node containing the camera ever splits* and the entire 16 km world draws as one chunk with 1 km triangles. `MAX_TRI_DEG` was 8.0, which put that inside the reach of the `]` key -- the same class of bug `MIN_TRI_DEG` exists to prevent at the other end. It is now 7.0, and the ceiling moves if `CHUNK_RES` does.

`periphDeg` **is clamped up to** `triDeg` **at the point of use.** The periphery is a *coarser* target; the pair silently inverted the moment `triDeg` passed the 5.0 periphery, refining ground behind the player harder than ground in front of her. Measured at 5.72: 178 slots inverted, 163 clamped, identical drawn triangles. At the shipped cap the clamp binds and the grading does nothing, which is the better outcome anyway with the pool 79% empty -- and the grading resumes on its own if the knob goes back below 5.

Two levers exist besides the cap, and neither replaces it. `VIEW_HALF_ANGLE` (the streaming margin, 90°) buys slots almost for free -- 45% of the selection sits outside the eye cone and is GPU-culled per instance -- but it buys little in *drawn* triangles. **Per-eye stereo** is the other: three renders once per eye with no multiview, so this cost is paid twice, and it is why the ground could never have two thirds of the budget.

The pool is now heavily oversized for the default -- 163 slots used of 768 -- because `SLOT_COUNT` has to cover `MIN_TRI_DEG`, the finest the `[` key can reach. That is roughly 15 MB of vertex and index buffer held for a setting nobody ships. **Shrinking the pool means giving up the fine end of the knob**, which is a trade to make on the device, not before it.

Regenerate the table with `node scripts/probe-trideg.mjs`.

**Prop LOD: two mesh tiers plus the impostor, and the ladder is per size class.** Derived in `scripts/probe-prop-lod.mjs`, which prints the whole argument; the short version is below. The table this replaces assumed one chain served every prop and that triangles were what forced the crossovers. Neither is true.

**Four classes, and foliage is split three ways by SIZE rather than by whether it is a plant.** A fern is not a grass tuft with a different texture -- it is 20x the volume, and giving them one triangle budget starved the fern to feed the grass. The `small` row below used to read "grass, ferns, flowers | 16 tris", and the shipped fern generator produces 28 to 108 depending on tier and variant.

| Class | Mesh tiers | Card | LOD0 to | Card from | Cull | Mesh class |
| --- | --- | --- | --- | --- | --- | --- |
| **structure** (cabins, tower, mill) | 1800 | 3 quads | 60 m | 170 m | 400 m | Batched |
| **tree** (trees) | 500, 130 | 3 quads | 30 m | 130 m | 500 m + clumps | Batched, then Instanced |
| **bush** (ferns, bushes, boulders, stumps, logs) | 84, 56, 28 | 1 quad | 5 m | 26 m | 500 m + clumps | Batched, then Instanced |
| **grass** (grass, flowers, moss, leaf scatter) | 4 | none | 23 m | \-- | 23 m | Batched |

**Triangles are not what binds, and neither are they what the card tier is for.** The prop budget is ~190k (350k ceiling − 45k terrain − ~115k everything else). Within that, the crossovers above are set by perception and by instance count, not by arithmetic on triangles -- pushing LOD0 out to where its triangles stop being worth it would put it past 400 m.

**Parallax is what binds.** A billboard's defect is not that it lacks detail -- a 128 px impostor carries more foliage than a 45-triangle decimated conifer does. Its defect is that it does not turn as you walk past it, and that error is an angle, `atan(depth / distance)`, which no triangle count touches. Under ~2° it stops reading as wrong at walking pace, which gives the rule the table above is built from:

> **billboard crossover ≈ prop depth ÷ tan(2°) ≈ depth × 28.6**

That is 120 m for a 4.2 m deep tree, ~170 m for a 6 m deep cabin, 17 m for a 0.6 m boulder and **14 m for a 0.5 m deep fern**. The rule scaling with prop size is why the ladder is per class and not global.

The bush class takes its card at 26 m rather than the 14 m the rule permits, because the 12 m in between is bought by a 28-triangle LOD2 at a few hundred instances, which is cheap in every budget at once. The rule sets the point past which a card is *allowed*, not the point at which it is *required*.

**The bush class shipped with three mesh tiers, not two, and the "why not a third tier" argument below does not reach it.** That argument is about trees: a third conifer tier installs a 45-triangle canopy with no silhouette in place of a 128 px impostor whose only defect is already under 2°. The bush class is the opposite case on both counts. Its tiers are not decimations of one mesh but *re-generations at a different segment count* -- 6, 4 and 2 segments per frond -- so a tier costs one more entry in a generated bank rather than a hand-authored asset, and the whole 48-geometry bank is 134 KB. And the thing the tiers control is the smoothness of a frond's arc, which is the fern's silhouette rather than a detail inside it. Judged in `gen-fern.html`: 4 → 6 segments is an obvious gain, 6 → 8 is close to undetectable. So the finest tier only has to reach as far as that arc is legible, which is why LOD0 stops at 5 m instead of the 12 m the class allows, and the two tiers behind it carry the rest for a third of the triangles. A single 6-segment tier out to 25 m costs 82k against this ladder's 42k at the same density.

The grass class gets no card at all, and here the rule is not the reason -- a 4-triangle tuft and a 2-triangle card are the same instance, so a card saves nothing that matters and adds a pop. Grass gets one tier and a hard cull.

**Why not a third mesh tier.** Compared at equal budget, a third tier does push real geometry from 151 m out to 234 m. But what it puts there is a 45-triangle conifer at 94 px with no needles and no silhouette, replacing a 128 px impostor of the real canopy whose only defect -- parallax -- is already under 2° at that range. The third tier spends a geometry slot, a build step and a pop event to install a *worse* representation. Two mesh tiers.

**Density near the eye is the lever; draw distance is nearly free.** Measured for a 2 ferns/m² carpet with cards running to 510 m: the 25-510 m band is 0.15x an eye buffer of fill and, as `InstancedMesh`, zero per-frame CPU. The nearest 12 m is 1.42x -- **82% of the whole carpet's fill cost lives inside 12 metres**, and it scales linearly with near density. So the tuning order is: set near density against fill, then push the card distance out as far as it reads, because the far bands cost almost nothing.

**Card reach is set by pixels, and it is further out than it feels.** A 0.55 m fern on Quest 2's default eye buffer (~16.2 px/deg):

| Fern subtends | Distance |
| --- | --- |
| 20 px | 25 m |
| 10 px | 51 m |
| 5 px | 102 m |
| 3 px | 170 m |
| 1 px | 510 m |

So "cards until each is under 3 px" is **170 m**, not 500 m; 500 m is where a fern is one pixel. Both are far past where a card would previously have been culled, and the fill-rate numbers above say both are affordable.

**Clump cards are the tier that makes the far bands legal, and instance count is why.** At 2 ferns/m² with density halving per distance doubling, individual cards out to 510 m is **76,000 instances**. In `BatchedMesh` that is 2.8 ms/frame on desktop and ~11 ms on Quest 2, spent entirely on culling and sorting 2-triangle quads. Two independent fixes, and the ladder uses both:

| Ladder | Instances | Triangles | BatchedMesh CPU (Quest 2 est.) |
| --- | --- | --- | --- |
| card per fern to 510 m | 76,000 | 208k | ~11.2 ms -- the whole frame |
| clumps of 8 past 170 m | 31,100 | 118k | ~4.6 ms |
| clumps of 8 past 60 m, 32 past 170 m | 11,800 | 79k | ~1.7 ms |

...and moving the far bands to tiled `InstancedMesh` takes that last column to **zero** regardless of which row you pick, at the cost of ~20 draw calls. The clumping still earns its place on triangles and on rebuild cost, and it looks better: one card baked from 8 ferns has the silhouette of a patch, and sparse individual cards at distance look like a comb-over.

**Beyond the card reach: bake the foliage into the terrain.** Use the same noise field that *would have* placed props to modulate the terrain material's albedo and normal (darker, greener, mottled). This is what shipped open-world games do, and it costs essentially nothing. It is the layer *under* the cards, not a replacement for them -- the terrain modulation runs everywhere including underfoot, and the cards sit on top of it out to wherever they stop being worth an instance.

**Why not a lower near density instead.** Because near density is the one thing you can actually see. 2 ferns/m² is what "lush" means at walking pace, and 1.42x an eye buffer of alpha-tested quads at 2/m² is inside the ~2x Quest 2 sustains -- with nothing else in the frame contributing overdraw, which is the caveat to hold onto. If fill rate turns out to bind on-device, the near band is where it binds, and the fix is a shorter grass class or fewer fronds per fern, not a shorter draw distance.

### Per Meta's WebXR best practices

- Sort opaque front-to-back
- **One real-time light maximum** (the sun/moon directional). Everything else is baked -- §8
- **No shadow map passes** -- they double draw calls
- KTX2/Basis texture compression throughout
- Stagger CPU work: sway, weather, and animation logic at 30 Hz while rendering at 72 Hz
- Render alpha-tested foliage *after* all opaque geometry

---
