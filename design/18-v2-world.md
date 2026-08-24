# §18 -- v2: baked heightmap + authored content layers

The v1 world (`src/sim/`, `src/terrain/`, `index.html`) is fully procedural: `TerrainHeight.heightAt` is the only author, and the only way to move a mountain is to move a noise constant and watch the whole world move with it. v2 is the alternative: **the coarse shape is an imported image, the fine shape is procedural, and everything a human wants to place by hand is a CONTENT LAYER on top.**

v2 does not replace v1 and does not import from `src/terrain/`. It lives entirely under `src/v2/` behind `v2.html`, and it may freely import the leaf modules v1 also uses (`src/sim/noise.js`, `src/sim/mathx.js`, `src/clock.js`, `src/sky.js`, `src/stars.js`, `src/aurora.js`, `src/lighting.js`, `src/player.js`, `src/input.js`, `src/water.js`, `src/terrain/terrain-material.js`) -- those are shared, not v1-owned. It must not import `src/sim/terrain-height.js` or `src/sim/phase-a.js`; the whole point is that the height field comes from somewhere else.

**Constraint 3 from DESIGN.md still binds.** Everything under `src/v2/height/` and `src/v2/layers/` imports no three.js and runs in node, which is what lets `scripts/check-v2.mjs` gate it headlessly. three.js starts at `src/v2/terrain/`, `src/v2/render/`, `src/v2/edit/`, `src/v2/ui/`.

## The two-representation rule

This is the single idea the whole editor rests on, and every layer obeys it.

- **Stored representation is PARAMETRIC and tiny.** A river is a handful of control points. A snow line is a handful of (position, deviation) pairs. The entire world document is kilobytes of JSON, diffable, hand-editable, and cheap to ship to a worker on every edit.
- **Runtime representation is BAKED and O(1) to query.** A uniform spatial index over segments; a rasterised grid for the snow line. No per-vertex loop ever walks a list of authored objects.

The bridge between them is a **bake step** keyed on an integer `epoch`. Editing bumps the epoch, the bake reruns over the dirty region only, and the chunk streamer re-meshes only the chunks whose AABB the edit touched.

## Module layout

```
v2.html                            route
src/v2/config.js                   all v2 constants in one place (three-free)
src/v2/height/png.js               zero-dep PNG decode, browser + node (three-free)
src/v2/height/heightmap.js         Heightmap: bicubic sample of the imported coarse field (three-free)
src/v2/height/detail.js            band-limited fractal detail (three-free)
src/v2/height/field.js             V2Height: the composed field the mesher and player both read (three-free)
src/v2/layers/doc.js               WorldDoc: schema, defaults, (de)serialise, validate (three-free)
src/v2/layers/grid.js              UniformGrid: the shared spatial index (three-free)
src/v2/layers/spline.js            centripetal Catmull-Rom + arc-length + per-point width (three-free)
src/v2/layers/snowline.js          SnowField: point list -> baked delta grid, dirty-rect rebake (three-free)
src/v2/layers/water-bodies.js      LakeSet: footprint test + basin carve (three-free)
src/v2/layers/paths.js             PathSet: rivers and roads -- index, distance query, carve (three-free)
src/v2/layers/layers.js            Layers: owns the doc + all four bakes, one epoch, one carve entry point (three-free)
src/v2/terrain/quadtree-v2.js      LOD selection, MAX_DEPTH 13
src/v2/terrain/chunk-mesh-v2.js    mesher (three-free, but lives here because only the renderer calls it)
src/v2/terrain/worker.js           worker shell
src/v2/terrain/terrain-v2.js       BatchedMesh chunk manager + epoch invalidation
src/v2/render/water-surfaces.js    lake discs + river ribbons from layer data
src/v2/render/road-surfaces.js     road ribbons
src/v2/render/markers.js           editor handle gizmos (snowline points, spline points)
src/v2/edit/gizmo.js               three TransformControls wrapper: one active object, T/R/S modes
src/v2/edit/editor.js              tool state machine, picking, selection, undo, save/load
src/v2/ui/panel.js                 the compact status + tools panel
src/v2/main.js                     entry: boot order, the sky wiring, the edit -> world channel, /v2's frame loop
scripts/make-heightmap.mjs         writes public/world/height.png + height.json
scripts/check-v2.mjs               the gate
```

## Constants (`src/v2/config.js`)

```js
export const WORLD_SIZE = 8192       // m, centred on origin -- the IMPORT decides the scale
export const WORLD_HALF = 4096
export const CHUNK_RES = 16          // cells per chunk edge; identical topology per chunk, as v1
export const MAX_DEPTH = 13          // 8192 / 2^13 = 1 m leaf node -> 6.25 cm cells
export const SLOT_COUNT = 1024       // measured by check-v2 §"slot pool"; overflow throws
```

**The world is 8 km, not v1's 16 km, because the coarse shape is imported and the import decides the scale.** `reference/skyrim-height-map.jpg` measures 8 km edge to edge horizontally. The source is 1024 x 873 and therefore not square, while the quadtree needs a square root node, so the box is 8192 m on both axes: the image covers the full width and 6984 m of depth, centred, and the import mirror-extends the edge rows over the remaining 604 m at each Z edge. Clamping instead would extrude the last row into flat ridges running the width of the map. That fit happens once, at bake, so the shipped PNG is square and the runtime loader never branches on the shape of whatever image the world came from.

At 1024 px across 8192 m the imported field is **8 m/texel**, and that -- not `WORLD_SIZE` -- is the number the rest of v2 is sized against: the detail band limit, the snow grid's resolution, the slope stencil. It is derived, not independent, and it moves whenever the world box does.

One near-agreement is worth recording rather than rediscovering. `scripts/heightmap-png.mjs` has described the same reference image as "~4 miles (6437 m) across at 1024 px, i.e. 6.29 m/px" since build step 2, and every §3 terrain-character comparison made against it used that scale. 8 km is the number this build uses, and it is within 27% of that older reading, so those §3 comparisons stay roughly meaningful rather than being off by half.

`MAX_DEPTH 13` is what "down to 10 cm" means in this file's units. The split rule is v1's, unchanged -- refine while `cell > range * tan(triDeg)` -- so the depth actually reached is a function of range, not of the cap: at eye height (1.65 m) and `triDeg 3.0`, the target cell is 8.6 cm and selection lands on depth 12 (12.5 cm) or 13 (6.25 cm). The cap exists so it *can* get there; the angular rule decides when.

### The import, and what a JPEG costs

The source is a baseline JPEG, which is two lossy steps away from a height field and both leave marks that a 6 cm LOD will show:

- **8-bit quantisation.** 256 levels across the vertical range; at 900 m of relief that is a 3.5 m step per level, and at 8 m/texel those steps are 8 m apart in plan, so the terracing they would produce is gentle rather than stair-like. Bicubic interpolation puts a smooth surface *through* those samples rather than terracing between them, so the residual is a gentle ripple of at most half a step, and the procedural detail term is an order of magnitude larger than it at every wavelength it occupies.
- **DCT ringing.** 8x8 block artifacts, which bicubic will faithfully reproduce as 32 m corduroy. The import therefore runs one deblocking pass before writing the baked field, and that pass has to remove block edges without rounding off ridge lines -- an edge-preserving filter, not a Gaussian.

The import writes `public/world/height.png` as `rg16` (16-bit height split across the R and G channels of an 8-bit PNG) so nothing downstream re-pays the JPEG's quantisation, plus `height.json` carrying the metre range and the fit.

## The composed height field

`V2Height.heightAt(x, z, cell = 0)` is the one function. `cell` is the sampling spacing in metres and is used **only** to band-limit detail octaves; pass 0 (the default) for the exact, fully-detailed field, which is what collision and the editor must use. Evaluation order, and it is an order not a set:

1. **coarse** -- `Heightmap.sample(x, z)`, bicubic (Catmull-Rom) over the imported image.
2. **detail** -- `+ detailAt(x, z, cell)`, fractal, amplitude modulated by the coarse slope.
3. **rivers** -- carve. Channels cut through whatever is there.
4. **lakes** -- basin carve, for lakes with `carve` set.
5. **roads** -- smooth. Last, so a road crossing a river reads as a causeway rather than dipping into it.

Bicubic, not bilinear, is load-bearing: bilinear over an 8 m/texel image puts a slope discontinuity on every texel edge, which is invisible at v1's 1 m leaf and unmissable at 6 cm.

### Detail (`src/v2/height/detail.js`)

```js
detailAt(x, z, cell, slope01)
```

Octaves `k = 0..K-1` with wavelength `LAMBDA0 / 2**k`, `LAMBDA0 = 512`, down to `LAMBDA_MIN = 0.25` (K = 12). Amplitude `A_k = ROUGH * lambda_k ** H` with `H = 0.95`, `ROUGH` tuned so `A_0` lands near 25 m. Modulated by `(1 + SLOPE_BOOST * slope01)` -- steep ground is rockier -- and by the flatten mask the road and lake layers contribute.

Band limit: octave weight `w_k = smoothstep(cell * 4, cell * 2, lambda_k)`, so an octave **fades** out as the sampling cell approaches its Nyquist rather than snapping off. Fading is the difference between LOD swaps that breathe and LOD swaps that pop. With `cell = 0` every weight is 1.

The field is a pure function of `(x, z)` at `cell = 0`. Two chunks at different depths sampling the same point get answers that differ only by the band limit -- never by seed, never by history.

## Content layers

### Document schema (`src/v2/layers/doc.js`)

Arrays-of-numbers, not objects-of-keys, for anything there are many of.

```json
{
  "v": 1,
  "snow": { "base": 148, "band": 47, "points": [[x, z, delta, radius], ...] },
  "lakes": [{ "id": "l3", "x": 0, "z": 0, "y": 120, "rx": 80, "rz": 55, "rot": 0.4, "shape": 0, "carve": 1, "depth": 8 }],
  "rivers": [{ "id": "r1", "depth": 2.0, "pts": [[x, y, z, width], ...] }],
  "roads":  [{ "id": "d1", "feather": 8, "pts": [[x, y, z, width], ...] }]
}
```

`shape` 0 = ellipse, 1 = rectangle. `y` on a lake is the water level. `y` on a river/road point is the surface elevation at that point; the editor seeds it from the terrain and the move gizmo can lift it.

`snow.base` and `snow.band` are elevations in metres and therefore belong to whatever vertical range the import chose, so neither is a constant anywhere in the code. A new world takes them from the loaded image: `snowDefaults(V2Height.bands)` in `src/v2/layers/doc.js` puts the base at the p75 texel elevation and the band at half the p50..p90 spread, which on the shipped bake (0..900 m) is **582.7 m +/- 106.1 m**, a quarter of the world in snow. `DEFAULT_SNOW_BASE` / `DEFAULT_SNOW_BAND` in `doc.js` are 148/47 and exist only for documents built with no heightmap in the room -- every node gate -- none of which asserts an elevation. The altitude ramp in the mesher's shading is derived the same way, off `bands.altLo` / `bands.altSpan`.

**The band is CENTRED on the line**, so the mesher's cover opens at `base - band/2` and closes at `base + band/2` and the authored elevation is the half-cover contour. It used to stack above the line, which made every authored number read about half a band low: an author clicking the mountain where the snow should start got bare ground there and white 35 m higher, then dragged the point down by roughly that much, every time.

### Snow line -- the interpolation scheme

The requirement: one global default elevation; authored points that the line must pass **through**; clusters of points give tight local control; cost per queried vertex is O(1) and independent of how many points exist.

**Stored:** `[x, z, delta, radius]` per point, 16 bytes. `delta` is metres of deviation from `snow.base`, so an unedited world is an empty array and a point dragged in a flat region is one number. A new point's `radius` defaults to `WORLD_SIZE / 20` (409.6 m), which is about one mountain on an 8 km world -- `/40` was the first guess and took a dozen points to lift the line over one massif. `GRID_RES` is unrelated to it: that sets how finely the deviation field is SAMPLED, not how far one point reaches.

**Interpolant:** Shepard with a compactly-supported singular kernel, blended toward the base by a partition-of-unity mask.

```
t_i = clamp01(d_i / r_i)
k_i = (1 - t_i * t_i) ** 3            // compact, C2 at the edge, 1 at the centre
w_i = k_i / (d_i * d_i + EPS)         // singular at d = 0 -> exact interpolation
S = sum(w_i)   W = sum(w_i * delta_i)   A = max(k_i)
delta(p) = S > 0 ? A * (W / S) : 0
snowLine(p) = snow.base + delta(p)
```

At a point, `w_i` dominates the sum and `A = 1`, so the line passes exactly through the authored value. Outside every radius, `A = 0`, so it returns to the global default with no seam. Between clustered points the normalised Shepard term interpolates smoothly, which is the "several points near each other at a mountain pass" case working as asked.

**Baked:** a `1024 x 1024` Float32 delta grid over the world, 8 m/texel, 4 MB, queried bicubically. The interpolant above never runs per vertex -- it runs `1024^2` times at bake, and on an edit only inside the **dirty rect** (the union of the moved point's old and new radius boxes), which is what makes dragging a point interactive. This grid is also what the mesher's vertex-colour shading reads, so the CPU and the eventual GPU path cannot disagree.

Points are indexed in a `UniformGrid` so a bake texel visits only points whose radius reaches it.

### Lakes (`water-bodies.js`)

A lake is a transformable primitive, not a mesh: centre, half-extents `rx`/`rz`, rotation about Y, ellipse or rectangle. `footprint(x, z)` returns 0..1 (1 inside, feathering to 0 over the last 15% of the radius). With `carve` set, terrain inside is pulled down to `y - depth * footprint`, which guarantees the bank meets the water rather than poking through it.

**New lakes are RECTANGLES and do NOT carve**, which is the opposite of both original defaults and is an authoring decision, not a rendering one. A carved basin is the footprint, so a carving lake is exactly as round as its own outline and every shoreline in the world reads as stamped; a lake that carves nothing sits on whatever ground is there, and its waterline is the intersection of a flat plane with real terrain, which is irregular for free. That makes finding a hollow the author's job -- the placement click no longer guarantees the lake has a bed. `carve` is per lake and still switchable; `depth` stays on the record whether or not it is being used. Detail suppression follows carving (`flattenAt` skips non-carving lakes), because flattening under a lake that is meant to sit on the existing ground would erase the ground it is sitting on.

The surface drawn for it is an OCTAGON -- eight triangles, whatever the lake's size. Water is flat and its edge is under a bank, so the segment count buys nothing; what it costs is that the rim has to cover the basin the carve dug, in both shapes, or the four corners of a rectangular lake show bare bed. So the octagon CIRCUMSCRIBES the ellipse (each vertex 8.2% of the radius outside it, over ground the bank hides) and traces the rectangle EXACTLY, matching `footprint`'s hard `max(|ux|, |uz|)` test. Vertices are sampled on the unit shape and stretched by the half-extents afterwards, not ray-cast against the stretched one: otherwise a 100x10 m lake puts seven of its eight vertices at the ends and the rim along the flat falls to 0.58 of the footprint.

Indexed in a `UniformGrid` by AABB. Placement is one click on the terrain: centre at the hit XZ, `y = groundY + 1`, `rx = rz = 20`. Everything after that is the gizmo.

### Rivers and roads (`paths.js`)

Both are the same object -- a **centripetal Catmull-Rom** spline through control points, each carrying a width -- so they share one module, one index and one distance query. Centripetal (alpha = 0.5) rather than uniform because uniform Catmull-Rom overshoots and self-intersects on tight turns, and a river that loops back through itself carves a hole.

**Bake:** flatten each spline to a polyline at ~2 m spacing, storing per-sample `(x, y, z, halfWidth)`. Bin every segment into a `UniformGrid` by its swept AABB (segment box expanded by `halfWidth + feather`). Query at `(x, z)` visits only the bins under that point.

`nearest(x, z)` returns `{ dist, y, halfWidth, t }` for the closest sample, or null.

- **River carve:** inside `halfWidth`, subtract a parabolic channel reaching `depth` (default 2 m) at the centre; feather to zero over the next `halfWidth`. The bed elevation follows the spline's own `y`, so the channel does not climb when the terrain does.
- **Road smooth:** inside `halfWidth`, replace terrain height with the spline's `y`; over `feather` metres outward, `lerp` from that back to the terrain height. This flattens whatever it crosses, which is what a road does.

Per-chunk culling is the actual performance story: `Layers.overlaps(aabb)` answers "does any authored element touch this chunk" from the grids alone, and the overwhelming majority of chunks in the world get a single early-out instead of any per-vertex work at all.

### `Layers` (`layers.js`)

The one object the field, the mesher and the editor all hold.

```js
layers.epoch                       // integer, bumped by every mutation
layers.snowLineAt(x, z)            // baked bicubic tap
layers.carve(x, z, h)              // rivers -> lakes -> roads, in that order
layers.flattenAt(x, z)             // 0..1, how much detail to suppress (roads, carved lakes)
layers.overlaps(minX, minZ, maxX, maxZ)   // per-chunk early-out
layers.serialize() / Layers.deserialize(json)
layers.dirtyRect                   // {minX, minZ, maxX, maxZ} union since last consume, or null
```

## Editing

`TransformControls` from `three/addons/controls/TransformControls.js` is the move/scale/rotate widget. It is the Blender-style gizmo already written, tested and shipped with the dependency we already have; reimplementing it would be several hundred lines to arrive at something worse.

Tools: `select`, `snowline`, `lake`, `river`, `road`. Each placement tool is one raycast against the terrain `BatchedMesh` per click. Splines are built by clicking successive points; `Enter` ends the spline. Selecting any handle attaches the gizmo; `G` / `R` / `S` switch translate / rotate / scale, matching the muscle memory the request named -- and the panel draws the same three as buttons, because a mode reachable only by a key nobody mentioned is a mode nobody finds.

A click within 10 px of an existing handle SELECTS it rather than placing something new behind it: the ray gets first refusal, and only when it hits nothing does screen-space proximity get a say, so a handle drawn on top of the pixel you clicked always wins over one that is merely nearer.

Handles are sized in three regimes and only the first is angular: constant 22 px out to 120 m, constant WORLD size beyond that so they recede with the ground, and a floor at 3 px wide so a far-off river is still findable. Holding 22 px all the way out -- the first version -- turned a river drawn across the valley into a chain of beads the size of houses, in front of the terrain the author was trying to look at. The 10 px pick radius is unaffected by any of it, so a 3 px handle is still a 20 px click target.

Scale means different things to different selections and the editor writes the parameter rather than storing a transform: a lake takes `rx`/`rz`, a snow point its `radius`, a spline point its `width`. Each has a multiplicative floor, so a drag can shrink something small but never to an unrecoverable zero.

Right-click on a handle opens a context menu: delete, and on a spline point **split before** / **split after** -- a new control point at the midpoint of that segment with the two widths averaged. Past either end there is no segment to halve, so the path extends instead by half the last segment, taking its Y from the ground. That is the only way to lengthen a river after its draft is committed. The editor builds the items and the panel draws them; deciding what is legal to do to a river point is not the DOM layer's job. The placement arithmetic is `src/v2/edit/split.js`, three-free so the gate can reach it.

Edits are debounced (~120 ms) before the worker sees them, so a drag is one remesh per frame-ish and not one per mousemove.

**An invalidated chunk keeps its old mesh on screen until the replacement lands** (`invalidationAction` in `stream-policy.js`). Freeing the slot at invalidation time -- the obvious order, and the first one -- put a hole where every re-meshing chunk was for the length of the bake, and the hole went all the way through to the sky, because an edit's dirty rect also catches the PINNED depth 0-2 chunks that contain it, so the ancestor fallback had nothing left to fall back to. Dragging any gizmo flashed sky at 60 Hz. Holding costs one slot per invalidated chunk for one bake, and that fits the budget only because eviction counts HELD SLOTS rather than ready states -- a held chunk is back in state `queued` and is very much still spending one of the 1024. The replacement is written into the same slot, so there is no frame in which neither mesh is drawn.

**Persistence:** autosave to `localStorage` on every commit; Export / Import JSON buttons; and, under the dev server only, a `POST /__world` middleware in `vite.config.js` that writes `public/world/layers.json` so the authored world can be committed.

## The panel

One panel, top-left, replacing v1's `#desktop-hud` block-of-lines. Two zones:

- **Status**, compact: a dense two-column key/value grid rather than one fact per line -- fps, draw tris, chunks resident/drawn, triDeg, position, ground height, snow line here, mode. It is what v1's HUD said, in about a third of the height.
- **Tools**: the tool row, the gizmo's mode buttons, the selected object's numeric fields (editable), the layer list with visibility toggles and per-item delete, and save/load. Visibility is EDITOR-LOCAL and hides the actual surface -- `mesh.visible` on the water and road meshes, not a skipped build -- so hiding costs no remesh and no undo entry, and `levelAt`/`lakeBoxes` keep answering the gameplay questions (prop scatter, spawn search, where the player is standing) about a lake you have merely stopped looking at.

The XR canvas mirror keeps showing status only. Editing is a desktop activity and the gizmo has no controller binding.

## The gate (`scripts/check-v2.mjs`)

Added to `npm run check`. It must be able to fail. Sections:

1. **heightmap** -- decode `public/world/height.png` in node; assert the decoded metre range matches `height.json`; assert bicubic sampling is C1 across a texel boundary (finite-difference slope is continuous to 1e-3) and that bilinear is not, so the check is measuring the thing it claims.
2. **field determinism** -- `heightAt(x, z, 0)` is stable across calls and independent of evaluation order; the band limit is monotone in `cell`; `heightAt(x, z, cell)` converges to `heightAt(x, z, 0)` as `cell -> 0`.
3. **snow line** -- the interpolant passes through every authored point to <1e-3 m; returns exactly `base` outside every radius; a 200-point cluster costs O(1) per query after bake; dirty-rect rebake is bit-identical to a full rebake.
4. **paths** -- a river carve reaches `depth` at the centreline and 0 at `halfWidth * 2`; a road's surface is within 1 cm of the spline `y` inside `halfWidth`; a tight S-bend does not self-intersect (centripetal, not uniform).
5. **slot pool** -- worst-case selection over a few hundred camera positions at `MAX_DEPTH 13`, plus pinned chunks, fits `SLOT_COUNT`.
6. **layer culling** -- over a sampled sweep, the fraction of chunks that early-out is above 95% for a world with a dozen authored objects. This is the claim "compact and performance-efficient" reduces to, so it is the one that gets a number.
7. **host wiring** -- `src/v2/main.js` constructs a `WebGLRenderer` on its first line, so node cannot import it and no section above can reach it. The rules its collaborators' headers state as "the host must" are asserted textually instead, comment lines stripped first: it does not call `markers.update()` (the editor owns that call and two callers race on the handle scale), it does not transform `water.group` (the shader reads world position off `modelMatrix`), it patches `roads.material` in `vertex` mode (or the road is the one surface that stays lit after dark), it calls `setVisibility` on all three surfaces that draw authored geometry (miss one and the panel's hide toggle silently does nothing to that layer), and `probe.update()` runs before `renderer.render()`. Each corresponds to a failure that is invisible in the frame it happens in, which is what makes a weak check worth more than none.

Everything DOM, three.js, XR and gizmo on the `/v2` route is still unexercised by any gate: node reaches none of it, and there is no browser harness. The first click through the markers -> editor -> gizmo path will be a human's.
