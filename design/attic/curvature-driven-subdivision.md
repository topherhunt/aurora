# Spend triangles on shape, not on distance

Status: **wish list, not built.** Raised 2026-08-29. Nothing in the tree implements or references this.

## The idea

> What DOES need subdividing are edges that produce a horizontal crease from the camera perspective -- where one triangle of the edge is blocked from view by the edge itself and the tris on its "near" side. In other words, edges where exactly 1 adjacent tri's inner face faces the camera should be subdivided 1 level beyond the default for that chunk. NOT counting skirts, only counting surface tris.

That predicate has a name: it is the **silhouette edge** test, and it is the standard one -- shadow-volume extrusion and outline rendering both use exactly `dot(n1, v) * dot(n2, v) < 0`, two dot products and a sign compare per edge. It is the right predicate for the right reason. What reads as polygonal on a mountain is the line where ground meets sky, and that line is view-dependent in a way no elevation test can capture.

It supersedes an earlier version of this idea (subdivide around local maxima), which was wrong for a reason worth keeping: refining peaks makes summits rounder, and roundness is the opposite of the jaggedness being chased. The silhouette runs *across* slopes far more often than it runs over summits.

## The three things that stop it being built as stated

**1. The quadtree splits CHUNKS, not triangles.** There is no path in `terrain-v2.js` or `chunk-mesh-v2.js` that refines one edge. Every chunk is a fixed 17x17 grid, 512 surface triangles plus 128 skirt, and that fixity is what makes `BatchedMesh` slot recycling work at all -- a slot is a fixed vertex and index reservation. Non-uniform tessellation inside a chunk means variable index counts, which means reserving every slot for the worst case, which is 4x memory on 1024 slots to serve the handful of chunks that need it on any given frame.

**2. It is view-dependent, so it re-meshes as she walks.** Chunks are baked once by the worker and cached. A silhouette set changes with every few metres of movement and with altitude especially -- fly up 50 m and every ridge you were looking at edge-on is now a slope. Making geometry a function of camera position puts the mesher back in the per-move path, which is precisely what killed [the skyline profile target](skyline-profile-target.md) (3.7 ms desktop, 15-25 ms Quest per 4 m of movement). Skyline rebuilt a *table*; this would rebuild *vertex buffers*.

**3. Subdividing a silhouette edge moves the silhouette onto the two new edges.** They are still straight, still faceted. What you gain is one octave of whatever detail the height field actually holds at the new spacing -- which is real, but bounded, and the improvement per doubling falls off fast.

That third point had to be checked rather than assumed, because it turns on whether the source data has anything left to reveal. It does: the imported heightmap is 1024 texels over 8192 m (8.0 m/texel, `public/world/height.json`), so on its own everything below depth 6 would be pure Catmull-Rom interpolation -- but `detail.js` adds a band-limited fractal from 512 m down to **25 cm**, and `field.js` takes a `cell` argument that band-limits it to the chunk's own sample spacing. So a chunk genuinely carries more shape as its cells shrink, all the way to 25 cm. At the XR route's `maxDepth = 10` the cells are 50 cm, i.e. one octave short of the floor. There is exactly one doubling of real detail left to buy, and none below it.

## The version that survives

Two of the three objections are objections to **view-dependence**, and both dissolve if the predicate is evaluated at bake time instead of at render time. A silhouette edge from *some* direction is a crease -- a large dihedral angle between adjacent faces. Ridge lines are silhouettes from many directions; a lakebed is a silhouette from none.

> Bake, offline, a per-node **crease density**: the fraction of interior edges whose adjacent-face dihedral angle exceeds some threshold, or simply the mean absolute dihedral. Store it beside the `minY`/`maxY` bounds that `terrain-v2.js` already learns per node and hands to `selectNodes` as `info`. Fold it into the split rule as a multiplier on the angular target, so smooth nodes take a coarser target and creased ones a finer one.

Why this is the version worth building:

- **View-independent and static.** Bakes into the heightmap sidecar once, costs zero main-thread time forever, and never re-meshes anything. That is the exact property the skyline target lacked.
- **It rides the existing structure.** `selectNodes` already looks up per-node `info` for the 3D range term (`quadtree-v2.js`, `nodeRange`); crease density is another field on the same record and one more multiply in the same comparison. No new pass, no new data flow, no change to the mesher or the streamer.
- **It cuts where the range rule is blindest.** The split rule is `size / CHUNK_RES > range * tan(triDeg)` -- range and nothing else. It has no idea whether the ground it is refining is a cliff or a dead-flat lakebed, so a featureless plain 40 m away gets exactly the resolution a shattered ridge 40 m away gets. On a world that is mostly smooth between mountains that is the single largest source of triangles that buy nothing.
- **It fails safe.** A missing crease density reads as "assume rough", which over-refines -- the same direction the missing-`info` fallback already takes.

What it gives up against the original: it cannot tell a ridge seen edge-on from the same ridge seen face-on, so it refines both. That is a real loss, and it is the price of never touching the mesher at render time.

## What to measure before building it

The whole case rests on the world actually being smooth in places, and that is not yet checked. The number to get first is the **distribution of per-node crease density across the selected set at `triDeg 5.72`**. If the median node is nearly as creased as the roughest, there is no headroom here and this stays in the attic.

Second, and more important: this saves TRIANGLES, and as of 2026-08-29 the Quest 2 is **not established to be triangle-bound**. 115k triangles at 72 Hz is 8.3 M tri/s, which an Adreno 650 does not notice; the same frame is 7.0 Mpixel across two eyes at 506 Mpixel/s. See §18 of [`18-v2-world.md`](../18-v2-world.md). If the headset is fragment-bound, this whole line of work moves the wrong number.
