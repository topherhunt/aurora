# §18 -- v2: baked heightmap + authored content layers

The v1 world (`src/sim/`, `src/terrain/`, `index.html`) is fully procedural: `TerrainHeight.heightAt` is the only author, and the only way to move a mountain is to move a noise constant and watch the whole world move with it. v2 is the alternative: **the coarse shape is an imported image, the fine shape is procedural, and everything a human wants to place by hand is a CONTENT LAYER on top.**

v2 does not replace v1 and does not import from `src/terrain/`. It lives entirely under `src/v2/` behind `v2.html`, and it may freely import the leaf modules v1 also uses (`src/sim/noise.js`, `src/sim/mathx.js`, `src/clock.js`, `src/sky.js`, `src/stars.js`, `src/aurora.js`, `src/lighting.js`, `src/player.js`, `src/input.js`, `src/water.js`, `src/terrain/terrain-material.js`) -- those are shared, not v1-owned. It must not import `src/sim/terrain-height.js` or `src/sim/phase-a.js`; the whole point is that the height field comes from somewhere else.

**Constraint 3 from DESIGN.md still binds.** Everything under `src/v2/height/` and `src/v2/layers/` imports no three.js and runs in node, which is what lets `scripts/check-v2.mjs` gate it headlessly. three.js starts at `src/v2/terrain/`, `src/v2/render/`, `src/v2/edit/`, `src/v2/ui/`.

## The two-representation rule

This is the single idea the whole editor rests on, and every CONTENT layer obeys it. The terrain brush does not, deliberately -- see the exception below.

- **Stored representation is PARAMETRIC and tiny.** A river is a handful of control points. A snow line is a handful of (position, deviation) pairs. The entire world document is kilobytes of JSON, diffable, hand-editable, and cheap to ship to a worker on every edit.
- **Runtime representation is BAKED and O(1) to query.** A uniform spatial index over segments; a rasterised grid for the snow line. No per-vertex loop ever walks a list of authored objects.

**The one exception is the terrain brush**, which writes texels of the imported coarse field itself and saves them back to `height.png`. A sculpt has no parametric form: "I pushed this ridge down and dragged that saddle across" is not a shape, it is a history, and storing the history would replay a growing list of strokes on every worker at every boot -- unbounded work in the one place every vertex already pays for. The image IS the compact representation of an arbitrary height edit, and it is a fixed 1024x1024 that does not grow with how long you sculpt. The cost is that a sculpt is not diffable in git and not undoable from `layers.json`, which is why the editor keeps a per-stroke undo in memory and why Save is explicit.

The bridge between them is a **bake step** keyed on an integer `epoch`. Editing bumps the epoch, the bake reruns over the dirty region only, and the chunk streamer re-meshes only the chunks whose AABB the edit touched.

## Module layout

```
v2.html                            route
src/v2/config.js                   all v2 constants in one place (three-free)
src/v2/height/png.js               zero-dep PNG decode AND encode, browser + node (three-free)
src/v2/height/heightmap.js         Heightmap: bicubic sample of the imported coarse field, and the one choke point `crease` swaps (three-free)
src/v2/height/detail.js            band-limited fractal detail (three-free)
src/v2/height/sculpt.js            terrain brush kernel: falloff, dirty rects, one stamp (three-free)
src/v2/height/relief.js            the opt-in jaggedness knob table, its validator and its transport (three-free)
src/v2/height/exposure.js          ExposureField: baked multi-scale convexity, in sigmas (three-free)
src/v2/height/crag.js              the 24-96 m crease band cut into convex steep ground (three-free)
src/v2/height/ridge.js             RidgeField: baked ridge axes; `ridge` ribbing and `shatter` facets cut along them (three-free)
src/v2/height/crease.js            CreaseField: the kinked reconstruction of the import -- crests corner instead of doming (three-free)
src/v2/height/erode.js             thermal (talus) relaxation of the import toward a repose angle (three-free)
src/v2/height/field.js             V2Height: the composed field the mesher and player both read (three-free)
src/v2/layers/doc.js               WorldDoc: schema, defaults, (de)serialise, validate (three-free)
src/v2/layers/grid.js              UniformGrid: the shared spatial index (three-free)
src/v2/layers/spline.js            centripetal Catmull-Rom + arc-length + per-point width (three-free)
src/v2/layers/snowline.js          SnowField: point list -> baked delta grid, dirty-rect rebake (three-free)
src/v2/layers/water-bodies.js      LakeSet: footprint test + basin carve (three-free)
src/v2/layers/paths.js             PathSet: rivers and roads -- index, distance query, carve (three-free)
src/v2/layers/layers.js            Layers: owns the doc + all four bakes, one epoch, one carve entry point (three-free)
src/v2/terrain/quadtree-v2.js      LOD selection, MAX_DEPTH 13
src/v2/terrain/skyline.js          the profile LOD target: max pyramid + horizon table (three-free)
src/v2/terrain/chunk-mesh-v2.js    mesher (three-free, but lives here because only the renderer calls it)
src/v2/terrain/worker.js           worker shell
src/v2/terrain/terrain-v2.js       BatchedMesh chunk manager + epoch invalidation
src/v2/render/water-surfaces.js    lake discs + river ribbons from layer data
src/v2/render/road-surfaces.js     road ribbons
src/v2/render/markers.js           editor handle gizmos (snowline points, spline points)
src/v2/edit/gizmo.js               three TransformControls wrapper: one active object, T/R/S modes
src/v2/edit/editor.js              tool state machine, picking, selection, undo, save/load
src/v2/edit/sculptor.js            the brush's stroke timing, worker throttle, undo stack and PNG save
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

**A third target for ground that draws a silhouette edge** (`src/v2/terrain/skyline.js`, `K` toggles it). The angular rule is right for a surface and wrong for an edge: a 3-degree facet in the middle of a hillside is hidden by its own shading, and the same facet on a ridge crest is a 3-degree corner cut out of the sky. So a node whose top stands above the ground *behind* it -- out to `backdropX` times its own range, which is why a near ridge crossing a far mountain counts and not only ground against sky -- is graded toward `profileDeg 1.2` instead. Graded, not switched: a binary flip puts its discontinuity exactly on the silhouette, the one place in the frame guaranteed to be looked at.

It is a **refinement only** and never a veto, which is the invariant v1's elevation bias broke by gating descent. The detector reads a max-mipmap over the imported field and a camera-centred horizon table (256 azimuths x 40 log-spaced range buckets, rebuilt when the eye moves 4 m, 3.6 ms), never the mesher's lazily-learned `info` table -- classifying on what has been meshed would make refinement depend on meshing and meshing depend on refinement.

It reaches about 6% of the leaves past 600 m and costs 14k triangles on top of a flat `triDeg 3.0`, against the 206k that buying the same silhouette by refining everything would cost. The corollary is the interesting one: `triDeg 5.72` *plus* the profile target draws 70k where a flat 3.0 draws 95k, so a coarser default with a fine silhouette is both cheaper and better-looking, and that is the pair to reach for on the XR route. `scripts/check-v2-skyline.mjs` prints the whole ladder.

This does **not** fix summit truncation, and the two are easy to confuse. A summit landing between coarse vertices is simply missed -- 17 m at the median for a 64 m cell over the 150 highest summits, 6-7x what typical ground loses -- and that is a one-sided bias removable by a shifted sample at zero triangle cost (`chunk-mesh-v2.js`'s crest term, `RELIEF_KNOBS` `crest`). Refining removes it only the slow way. The profile target is for the residual: the polygonal edge that remains once the peak height is right.

### The import, and what a JPEG costs

The source is a baseline JPEG, which is two lossy steps away from a height field and both leave marks that a 6 cm LOD will show:

- **8-bit quantisation.** 256 levels across the vertical range; at 900 m of relief that is a 3.5 m step per level, and at 8 m/texel those steps are 8 m apart in plan, so the terracing they would produce is gentle rather than stair-like. Bicubic interpolation puts a smooth surface *through* those samples rather than terracing between them, so the residual is a gentle ripple of at most half a step, and the procedural detail term is an order of magnitude larger than it at every wavelength it occupies.
- **DCT ringing.** 8x8 block artifacts, which bicubic will faithfully reproduce as 32 m corduroy. The import therefore runs one deblocking pass before writing the baked field, and that pass has to remove block edges without rounding off ridge lines -- an edge-preserving filter, not a Gaussian.

The import writes `public/world/height.png` as `rg16` (16-bit height split across the R and G channels of an 8-bit PNG) so nothing downstream re-pays the JPEG's quantisation, plus `height.json` carrying the metre range and the fit.

## The composed height field

`V2Height.heightAt(x, z, cell = 0)` is the one function. `cell` is the sampling spacing in metres and is used **only** to band-limit detail octaves; pass 0 (the default) for the exact, fully-detailed field, which is what collision and the editor must use. Evaluation order, and it is an order not a set:

1. **coarse** -- `Heightmap.sample(x, z)`, bicubic (Catmull-Rom) over the imported image, or over the eroded copy of it when `erode` is on, or a reconstruction of the same texels that kinks at crests instead of doming over them when `crease` is on (see Relief).
2. **detail** -- `+ detailAt(x, z, cell)`, fractal, amplitude modulated by the coarse slope and, when `exposure` is on, by convexity.
3. **ridge / shatter** -- `+` the directed terms, when either is on: two operators over one baked structure, gated by their own ridgeness rather than by convexity, additive so either alone or both at once, and suppressed wherever a layer has flattened the ground.
4. **crag** -- `+` the crease band, when `crag` is on: gated to convex, steep ground and suppressed wherever a layer has flattened the ground.
5. **rivers** -- carve. Channels cut through whatever is there.
6. **lakes** -- basin carve, for lakes with `carve` set.
7. **roads** -- smooth. Last, so a road crossing a river reads as a causeway rather than dipping into it.

Steps 2 to 4 are one expression (`_micro`) and are skipped outright when no relief knob that touches geometry is on, so a default world evaluates exactly what it evaluated before relief existed. `crease` is not a step in that list because it is inside step 1: it changes what `Heightmap.sample` returns, so it reaches every caller of `sample` -- the mesher, collision, the scatter, the editor's raycast -- and is unaffected by the `_micro` early-out.

Bicubic, not bilinear, is load-bearing: bilinear over an 8 m/texel image puts a slope discontinuity on every texel edge, which is invisible at v1's 1 m leaf and unmissable at 6 cm. The same tangent rule that buys that C1 continuity also forces a dome onto every crest, which is the whole subject of the `crease` knob below.

### Detail (`src/v2/height/detail.js`)

```js
detailAt(x, z, cell, slope01)
```

Octaves `k = 0..K-1` with wavelength `LAMBDA0 / 2**k`, `LAMBDA0 = 512`, down to `LAMBDA_MIN = 0.25` (K = 12). Amplitude `A_k = ROUGH * lambda_k ** H` with `H = 0.95`, `ROUGH` tuned so `A_0` lands near 25 m. Modulated by `(1 + SLOPE_BOOST * slope01)` -- steep ground is rockier -- and by the flatten mask the road and lake layers contribute.

Band limit: octave weight `w_k = smoothstep(cell * 4, cell * 2, lambda_k)`, so an octave **fades** out as the sampling cell approaches its Nyquist rather than snapping off. Fading is the difference between LOD swaps that breathe and LOD swaps that pop. With `cell = 0` every weight is 1.

The field is a pure function of `(x, z)` at `cell = 0`. Two chunks at different depths sampling the same point get answers that differ only by the band limit -- never by seed, never by history.

### Relief -- the opt-in jaggedness knobs (`src/v2/height/relief.js`)

§3 asks for jagged peaks; the composed field as first shipped could not deliver them, and the reasons are structural rather than aesthetic. The first is spectral. The import is 8 m/texel and `detail.js`'s SHOULDER rolls the fractal off hard above its Nyquist (correctly -- uncorrelated noise over authored relief puts a hill in the author's valley), then `calibrateRough` divides by the import's 3x `exaggeration`. Between them the field carries almost nothing between 32 and 512 m, measured: rms slope stops growing below a 32 m lag. That is exactly the band crags, buttresses, ribs and couloirs occupy, and a mountain with an empty 32-512 m band is a mountain made of clay. The second is the reconstruction rather than the content: Catmull-Rom is forced to dome every crest, so even the structure the import does carry arrives rounded off. `crag`, `ridge` and `shatter` answer the first by adding bands back; `crease` answers the second by reading the same texels differently.

Twelve knobs, each **off by default and off means bit-identical** -- with an all-zero relief every branch is skipped and `V2Height` computes the expression it computed before any of this existed. `check-v2-field.mjs` asserts that against a field built with no relief argument at all, because a default that quietly changed the world would make every other measurement in that gate a measurement of a different terrain.

| knob | what it does |
| --- | --- |
| `bare` | fades the procedural detail term out, up to showing the imported macro field alone |
| `sharpen` | rectifies each detail octave into creased ribs instead of gaussian lumps |
| `exposure` | convexity drives detail amplitude -- ribs rough, hollows smooth |
| `crag` | metres of crease relief on convex steep ground at 24-96 m: ribs up, bowls down |
| `aniso` | stretches the crag band down the fall line, so gullies run downhill |
| `ridge` | metres of half-range of ribbing cut ALONG the spines the coarse field already has -- superseded by `shatter`, kept for the A/B; same units as `crag` |
| `shatter` | metres a maximal shard stands proud: faceted rock on those same spines, tilted pyramids meeting at crisp edges -- a PEAK and not an rms, so 45 here is about `ridge` 12 |
| `crease` | reconstructs the macro field so crests KINK instead of doming -- an exaggeration of the corner the imported texels already hold, NOT metres, so it is not comparable to the three above at equal numbers |
| `erode` | thermal (talus) relaxation passes over the import, producing planar faces that meet at sharp edges |
| `talus` | the repose angle `erode` relaxes toward |
| `snowJag` | metres the snow line follows exposure -- ribs blow clear, hollows fill in |
| `crest` | coarse chunks bias toward the local max, so distant ridges keep their edge |

`bare` is the only one that takes something away, and it is the first to reach for when the question is what the import is actually shaped like. It scales the DETAIL stack and nothing else -- the crag, ridge and shatter bands are separate terms with their own knobs and their own amplitudes, and muting them from one switch would make "what does the macro field look like" depend on knobs this one does not name. The fade is applied OUTSIDE `Detail` rather than by scaling `rough`, because `calibrateRough` fits the stack against the import's own structure function and a factor inside that fit would simply be re-measured away; applied outside it, the octave table does not move as the knob scrubs, so 0.5 is exactly half the detail term and scrubbing 0 -> 1 -> 0 lands back on the field you started from.

`RELIEF_KNOBS` is the single table: the HUD builds itself from it, the validator clamps from it, and the gate iterates it, so a knob cannot be added to the panel and forgotten in the transport. `normalizeRelief` THROWS on an unknown key rather than dropping it.

**Why this is a module and not an options bag.** The field is evaluated in three places that do not share memory: the main thread (collision, editor picking, prop scatter) and each terrain worker (the mesher). A knob that reaches one and not the others throws nothing -- the ground she is drawn standing on and the ground she collides with become two different surfaces, silently. So there is one shape, one validator, and a transport (`TerrainV2.setRelief`) that refuses anything that did not come through it. `main.js`'s `onRelief` is the only fan-out point, and its order is load-bearing: field first, then the workers, then everything that caches a height (props, snow line, the player).

**Three operators, one shape.** `sharpen`, `crag` and `ridge` all cut with `sqrt(n^2 + r^2)`, subtracted: `|n|` is near zero along the noise's zero contour -- a connected curvilinear network -- and near 1 at its extrema, so subtracting it digs the extrema into hollows and leaves the zero contour standing as arêtes. `r` rounds the derivative discontinuity at `n = 0`, and in the first two it must **widen with the cell** (`CRAG_VERTEX_CELLS`): a fixed `r` gives a vertex whose width in metres tracks the octave's wavelength, not the mesh's, and the ridge saw-tooths as chunks swap LOD. That was measured, not guessed -- at a 4 m cell the crag term's own second difference was 126% of the whole terrain's before the fix. `ridge` is the `r = 0` member, plain `|n|`, one band per detection scale rather than an octave stack. "Crease" here names that SHAPE, a band whose derivative breaks along the zero contour of a noise field; the `crease` KNOB below is a different thing entirely and adds no band at all.

**The two directed terms share one baked structure and differ only in the operator applied to it.** An undirected crease-shaped noise field is isotropic BY CONSTRUCTION, which is why `crag` reads as warble however hard it is pushed, so `ridge.js` takes a ridge AXIS from the coarse field's own Hessian at three radii (2, 6, 18 texels, roughly 32/96/288 m) and bakes a `ridgeness` gate: convexity ACROSS the axis, times flatness ALONG it (a dome scores zero, having no axis to be right about), times local prominence, so a 200 m arete outscores a 2 m hummock of the same cross-section. It self-calibrates by PERCENTILE, `RIDGE_GATE_LO` 0.50 to `RIDGE_GATE_HI` 0.90 -- an rms would land below every non-zero value, ridgeness being exactly zero on all concave ground -- and is blurred at the radius that found it, so faces inherit ridgeness from the crest above; unblurred it sits on the crest LINE and moves peak curvature by 1.01x. It gates by LANDFORM, not steepness: 2.3x on peak ground against gentle, where `crag` is 554x. Nine `Uint8` grids, 9 MB per thread; derivation in `ridge.js`'s header. **`ridge` is the first operator over it and `shatter` supersedes it.** It filters isotropic noise ACROSS the axis, leaving a function of along-crest position alone extruded down both faces, and level sets of a one-variable function are PARALLEL LINES: the crease breaks at evenly spaced intervals and the result is corduroy -- at standing scale, a fingerprint. Not a tuning failure but what the construction computes, and the standard recipe for synthesising zebra and fingerprint textures. Its numbers all came in (directionality 1.89x / 1.99x / 1.95x per scale against `crag`'s 1.00x, 3.5x the 2 m curvature on peak ground at 12, 2.4 walkability points, elongation about 2x), which is the lesson: smearing noise along a direction field cannot make rock at any amplitude. The knob stays for the A/B; the operator is pinned at `design/attic/ridge-lic-v1.js`.

**`shatter` keeps that bake entire and swaps the operator for the upper envelope of a jittered Voronoi lattice of tilted pyramids**, `h(p) = max(0, max over nearby cells c of [a_c - taper * d_c(p) + tilt * u_c])`. That crease family breaks the derivative only along a CURVE, so it yields rounded ribs and rounded troughs at any amplitude; rock is PIECEWISE PLANAR and wants the break across REGIONS, irregular spacing that band-limited noise cannot give having one wavelength by definition, and isolated tall maxima for spires. ENVELOPE, not partition, is the whole design -- a partition assigns each point to a cell and asks that cell's height, so the boundaries are the only structure and the result is a net; an envelope asks which pyramid is HIGHEST, so a tall cell overruns its small neighbours and the surviving spacing sets itself. `d_c` is Chebyshev in a per-cell rotated frame, so level sets are squares and a shard is a four-faced pyramid, not a cone; it therefore reaches `sqrt(2) / (taper - tilt)` cells along its diagonal, which the constructor asserts stays under 1 so the 3x3 neighbourhood is the whole support -- the bound without that sqrt(2) truncated shard corners one cell out, a faint square grid over the world, 13 of 120,000 samples off by up to 5.9e-2 m. The first draft gave each cell a flat elevation and blended across the walls, and read as CRAZING -- the crack web in an old glaze -- for three reasons no dial reached: every cell was displaced, so it tiled the plane; half sank, elevations running -1..1; each interior was a flat table, so the only structure was the rim.

`SHATTER_HURST` is 1.0, not `RIDGE_HURST`'s 0.35: a shard is a solid whose width the lattice fixes, so height and width together fix its face angle, and at 0.35 the coarse shards measured 13 degrees and the fine ones 63 -- gentle hips and needles in one frame. **Its units are not `ridge`'s despite both being metres**, so the two are not comparable at equal numbers the way `ridge` and `crag` are: `ridge` normalises to an rms, `shatter` to a PEAK, the height a maximal shard stands proud summed over the scales, since a field that is zero over most of its domain and spikes over the rest has an rms nowhere near its extremes -- under rms scaling the knob read 14 and delivered 40 m shards. Its ON is 45, the amount matching `ridge` 12's rms displacement on saturated ground, so a switch compares the two operators and not two amplitudes. Per `heightAt` sample, every row measured in one run at 300k calls with every field warmed by 60k calls before any of them is timed: 0.715 us off, 0.896 at `crag` 12 (1.25x), 1.413 at `ridge` 12 (1.98x), 1.208 at `shatter` 45 (1.69x), 1.914 with both (2.68x), 1.376 at `crease` 3 (1.92x), 1.866 at `crease` 3 plus `shatter` 45 (2.61x) -- `shatter` is the cheaper of the two directed terms, nine table lookups a cell against fifteen simplex taps, and it shares `ridge`'s bake outright rather than adding one: 7 ms off, 56 crag, 284 ridge, 269 shatter, 291 both. Over 40 km of transects at 45 -- 200 lines of 200 m walked in 1 cm steps -- the largest value jump across any single step is 0.024 m, a 67 degree face, with the p99 step at 44 degrees: steep but continuous, no cliff and no lattice seam anywhere.

**`crease` is the only knob here that changes how the imported field is READ, rather than adding a term on top of it or scaling one that is already there.** It changes what `Heightmap.sample` returns. The macro layer is a 1024x1024 PNG over 8192 m, so 8.0078 m per texel, reconstructed with Catmull-Rom, whose tangent at texel k is `(h[k+1] - h[k-1]) / 2`. On a crest both neighbours are lower, so the tangent goes to zero and the cubic leaves flat and falls away both sides: the interpolant is GUARANTEED to put a dome on every crest, and `crag`, `ridge` and `shatter` all put an edge back on top of that dome. `crease` declines to round it off in the first place.

**The corner is really in the imported texels, measured rather than assumed.** Fit a 4-parameter tent and a 4-parameter dome -- same parameter count, same points, free apex -- to every 7-texel crest cross-section in the RAW texels, never through `sample()`: the shipped import prefers the tent at 75.3% of crests with a residual ratio of 0.733, the same field blurred 3x3 prefers it at 48.8% with ratio 1.034, and a synthetic field of pure tents reads 97.3% and 0.018. Stratified by landform the gap widens -- over 50 m of local relief the import reads 0.774 against the blurred control's 1.947. So Catmull-Rom is discarding a crease the data has, and this is a recovery rather than an invention.

**The operator is one line of geometry.** Near a crest the interpolant is a parabola along the across-crest axis, `h(u) = h_c - k/2 * (u - u_c)^2`. The faces either side are straight; extend them and they meet above the rounded cap, and the corner is exactly their difference, `delta(u) = k/2 * (reach - |u - u_c|)^2` for `|u - u_c| < reach`, peaking at `k/2 * reach^2`. Both its value and its slope vanish at +/- reach, so it grafts onto the untouched bicubic with no seam; the only break in the whole construction is the corner itself, which is the point of it. It therefore SCALES ITSELF and there is no crest detector anywhere in it: `k` is the terrain's own curvature, so a broad hilltop gets a few centimetres and an arete gets metres, which is what "jaggedness inferred from where the protrusions are" reduces to.

**The curvature cannot come from Catmull-Rom**, and that is the one non-obvious dependency. Catmull-Rom is C1 and not C2 -- its second derivative jumps at every knot -- and tooth height is proportional to `k`, so a discontinuous `k` is a discontinuous surface: 26 m across one millimetre, the same jump at every probe step. The gradient and Hessian therefore come from a uniform cubic B-spline over the same 4x4 block, which is C2. It does not interpolate the texels and does not need to, being asked only where the ridge runs and how sharply it crests; the surface itself is still the untouched Catmull-Rom. That single change took the worst 1 cm step from 26.07 m to 0.132 m.

**The axis is the terrain's, not a draw**: the principal curvature direction, the eigenvector of the most negative Hessian eigenvalue, so it is perpendicular to the ridge all along the ridge and the teeth chain into a continuous serrated crest. An earlier attempt used a random per-cell axis and produced isolated blisters with bright rims that could never join into a ridge, because neighbouring cells creased in unrelated directions. Two further fixes were needed here. The 2x2 eigenvector must be chosen on the SIGN of `(hxx - hzz)/2` rather than on `|hxz|` vs `|dif|`: the two algebraic forms are exactly parallel but each collapses to the zero vector in a different regime, and picking the collapsed one swung the axis 90 degrees across a tenth of a millimetre -- a 0.13 m tear. And an anisotropy fade is needed because near an umbilic the axis rotates about 20 degrees per millimetre and drags the tooth height with it: an 87 degree wall, continuous but wrong.

**The cell-bombing is for unevenness, not position.** Each Voronoi cell draws an amplitude, skewed as `q^2` so a good share of cells stay near zero and leave plateaus between the teeth, and a rotation of up to 0.45 rad off the true ridge normal, which leans a tooth, weakens it and slides it off the crest line. The teeth stay connected because the axis under them is continuous; they stop being regular because the draw is not. Site jitter is confined to the middle half of each cell, which is a correctness requirement and not a taste: with a free site a cell two away can be nearer than the home cell, so a 3x3 search would return the wrong nearest and the surface would tear. Constants: cell 70 m, reach 13 m, jitter 0.45 rad, cap 10 m, sill 1.5 m, aniso 0.15, floor 0.15.

**It does not stairstep**, which a separable scheme would: one can only kink along x and z, so a diagonal arete comes out of it as steps. Nothing here knows which way the texel grid runs -- the axis comes from the surface, so on a diagonal arete it points along the diagonal.

**Its units are an EXAGGERATION and not metres**, so it is not comparable to `crag` / `ridge` / `shatter` at equal numbers: 1 restores exactly the corner the geometry implies and 3 overdraws it 3x. ON is 3 rather than a faithful 1 because the knob table is an ablation tool. Over 60k points spanning +/-3500 m, at lift 1 / 2 / 3: departure rms 0.128 / 0.256 / 0.384 m, departure max +3.89 / +7.77 / +11.66 m, departure min exactly 0.0000 m at every lift -- it only ever raises -- and the departure field's worst 1 cm step 0.0495 / 0.0991 / 0.1486 m with p99 0.0024 / 0.0047 / 0.0071 m. At lift 1 it leaves 65% of sampled points untouched. The worst 1 cm step in the full creased field, 0.2558 m and 87.8 degrees, is the shipped world's OWN cliff: the plain bicubic gives an identical number at that point and crease contributes 0.000 m there. **The cost is an open one rather than a solved one.** `Heightmap.sample` goes from 0.076 us to 0.200 us, 2.6x on the engine's hottest function -- but `heightAt` takes FIVE samples, one for the height and four for `slopeAt`'s central-difference stencil, so the operator is paid five times per composed evaluation. That lands it at 1.92x the all-off `heightAt` cost in the table above, which makes it dearer than `crag` or `shatter` and not the most expensive knob in the set -- `ridge` is, at 1.98x -- and `crease` with `shatter` costs about what `ridge` with `shatter` costs, so the crisp-rock combination is not a new order of expense.

**Where it hooks, and why it goes last.** It hangs off `Heightmap` via `attachCrease` and branches at the top of `sample()`, because `sample` is the one choke point: `slopeAt` and `gradientAt` are four `sample` calls each, `detail.js` takes its `coarse` from it, and `field.js` reads it at seven sites. Hooking any of those individually would give the mesher one surface and the collision, the scatter and the raycast another. It is attached at the END of `V2Height._rebuild`, after `calibrateRough` and after `ExposureField` and `RidgeField` bake, because `calibrateRough` fits the detail amplitude to the ground's structure function and a creased surface has more energy at texel scale -- calibrating against it would pull `rough` down and change the detail term over the entire world, flat valley floors included, in response to a knob whose whole claim is that it only touches crests.

Two things about measuring these knobs, both learned the expensive way. The composed field's curvature **kurtosis is not estimable** at any sample size a gate can afford (4.7 at 1500 sites, 66.8 at 20000 -- ten sites carry 86% of the fourth moment); judge `sharpen` on the detail stack alone, which converges. And a smooth odd curve applied per octave is the **identity after summation** -- the central limit theorem re-gaussianizes twelve reshaped histograms. Only a crease, being structural rather than distributional, survives being summed.

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

Tools: `select`, `snowline`, `lake`, `river`, `road`, `sculpt`. Each placement tool is one raycast against the terrain `BatchedMesh` per click. Splines are built by clicking successive points; `Enter` ends the spline. Selecting any handle attaches the gizmo; `G` / `R` / `S` switch translate / rotate / scale, matching the muscle memory the request named -- and the panel draws the same three as buttons, because a mode reachable only by a key nobody mentioned is a mode nobody finds.

A click within 10 px of an existing handle SELECTS it rather than placing something new behind it: the ray gets first refusal, and only when it hits nothing does screen-space proximity get a say, so a handle drawn on top of the pixel you clicked always wins over one that is merely nearer.

Handles are sized in three regimes and only the first is angular: constant 22 px out to 120 m, constant WORLD size beyond that so they recede with the ground, and a floor at 3 px wide so a far-off river is still findable. Holding 22 px all the way out -- the first version -- turned a river drawn across the valley into a chain of beads the size of houses, in front of the terrain the author was trying to look at. The 10 px pick radius is unaffected by any of it, so a 3 px handle is still a 20 px click target.

Scale means different things to different selections and the editor writes the parameter rather than storing a transform: a lake takes `rx`/`rz`, a snow point its `radius`, a spline point its `width`. Each has a multiplicative floor, so a drag can shrink something small but never to an unrecoverable zero.

Right-click on a handle opens a context menu: delete, and on a spline point **split before** / **split after** -- a new control point at the midpoint of that segment with the two widths averaged. Past either end there is no segment to halve, so the path extends instead by half the last segment, taking its Y from the ground. That is the only way to lengthen a river after its draft is committed. The editor builds the items and the panel draws them; deciding what is legal to do to a river point is not the DOM layer's job. The placement arithmetic is `src/v2/edit/split.js`, three-free so the gate can reach it.

**The terrain brush** (`sculpt`) is the one tool with no gizmo and no handles: it is a radius on the ground, and holding the button raises, lowers or smooths whatever it covers. Rate is per SECOND, not per stamp, so a 120 Hz machine does not dig twice as fast as a 60 Hz one; `strength` is metres per second and `smoothRate` is the fraction of the way to the local mean per second, two sliders because metres per second means nothing to a blur. A ground-conforming ring is drawn at the cursor -- without it the radius is a number with no referent. The brush writes the main thread's copy of the field in place, so a stroke is under the player's feet in the same frame it is drawn, and the workers (which hold their own copies, since a `SharedArrayBuffer` would need COOP/COEP headers this dev server does not set) are sent only the texels that moved, accumulated into one dirty rect and flushed every ~90 ms. Posting a patch per stamp would re-mesh the same ground sixty times a second and the world would stop redrawing exactly while it is being sculpted.

Sculpt undo is a SECOND stack, one entry per stroke, holding that stroke's pre-stroke heights: while the brush is armed `Ctrl-Z` takes strokes back until there are none and then falls through to the document stack. Merging the two would mean snapshotting 4 MB of field per document undo entry. Strokes are clamped to the encoding's range (`minY`..`maxY` from `height.json`) and the panel reports how many texels are sitting at the limit -- a brush silently doing nothing at the top of a mountain is the one failure of this tool that looks exactly like a slow brush.

Edits are debounced (~120 ms) before the worker sees them, so a drag is one remesh per frame-ish and not one per mousemove.

**An invalidated chunk keeps its old mesh on screen until the replacement lands** (`invalidationAction` in `stream-policy.js`). Freeing the slot at invalidation time -- the obvious order, and the first one -- put a hole where every re-meshing chunk was for the length of the bake, and the hole went all the way through to the sky, because an edit's dirty rect also catches the PINNED depth 0-2 chunks that contain it, so the ancestor fallback had nothing left to fall back to. Dragging any gizmo flashed sky at 60 Hz. Holding costs one slot per invalidated chunk for one bake, and that fits the budget only because eviction counts HELD SLOTS rather than ready states -- a held chunk is back in state `queued` and is very much still spending one of the 1024. The replacement is written into the same slot, so there is no frame in which neither mesh is drawn.

**Persistence:** autosave to `localStorage` on every commit; Export / Import JSON buttons; and, under the dev server only, a `POST /__world` middleware in `vite.config.js` that writes `public/world/layers.json` so the authored world can be committed.

A sculpted heightmap rides the same Save button through a second endpoint, `POST /__height`, which writes `public/world/height.png` and stamps `sculpted: true` into `height.json`. It has no `localStorage` tier and no export button on purpose: a megabyte of PNG per commit would blow the storage quota, and a sculpt that exists only in a browser profile is a sculpt nobody else will ever see. That flag is also a guard -- `scripts/make-heightmap.mjs` refuses to re-bake over a sculpted file without `--force`, and `check-v2-heightmap.mjs` demotes its "shipped PNG is the import, pixel for pixel" assertions to printed measurements once it is set.

## The panel

One panel, top-left, replacing v1's `#desktop-hud` block-of-lines. Two zones:

- **Status**, compact: a dense two-column key/value grid rather than one fact per line -- fps, draw tris, terrain (chunks resident/drawn plus the triangles those drawn chunks cost), `triDeg/profileDeg`, position, ground height, snow line here, mode. It is what v1's HUD said, in about a third of the height. Every layer prints its own triangle share, terrain included, so no layer's cost has to be inferred by subtraction.
- **Relief**: one row per `RELIEF_KNOBS` entry, each a toggle plus a scrubbable value, persisted to `localStorage` and applied live. It is an ablation tool rather than a settings screen: the `on` values are chosen to be clearly visible rather than tasteful, and a knob with a `needs` greys out until its dependency is up.
- **Tools**: the tool row, the gizmo's mode buttons, the selected object's numeric fields (editable), the layer list with visibility toggles and per-item delete, and save/load. Visibility is EDITOR-LOCAL and hides the actual surface -- `mesh.visible` on the water and road meshes, not a skipped build -- so hiding costs no remesh and no undo entry, and `levelAt`/`lakeBoxes` keep answering the gameplay questions (prop scatter, spawn search, where the player is standing) about a lake you have merely stopped looking at.

The XR canvas mirror keeps showing status only. Editing is a desktop activity and the gizmo has no controller binding.

## The gate (`scripts/check-v2.mjs`)

Added to `npm run check`. It must be able to fail. Sections:

1. **heightmap** -- decode `public/world/height.png` in node; assert the decoded metre range matches `height.json`; assert bicubic sampling is C1 across a texel boundary (finite-difference slope is continuous to 1e-3) and that bilinear is not, so the check is measuring the thing it claims.
2. **field determinism** -- `heightAt(x, z, 0)` is stable across calls and independent of evaluation order; the band limit is monotone in `cell`; `heightAt(x, z, cell)` converges to `heightAt(x, z, 0)` as `cell -> 0`.
3. **relief** -- an all-off relief is `===` the field built with no relief argument at all, at every site and in the calibration, with no eroded copy allocated; every knob's `on` value moves the field it claims to move and nothing else; `bare` is an exact fade -- 0 is the field built with no relief argument bit for bit, 1 is EXACTLY `heightmap.sample` with no detail left under it, 0.5 removes exactly half, the octave table does not move across any of it, and the crag band comes through untouched; the crag band is zero-mean and lands on convex ground rather than everywhere; the ridge band is zero-mean too (`|mean|/rms` under 0.1), the 9 MB of shared structure is not baked at all unless `ridge` or `shatter` is up, the band is EXACTLY twice at twice the knob in the term itself and twice to within 1e-9 m through the composed field, is EXACTLY 0 at a cell computed from the baked wavelengths rather than written down while still cutting at over a quarter of sites at cell 0, and raises peak-ground 2 m curvature by more than 3x -- that last one is asserted as well as printed, the summary line reading `ridge=12 m against all off, over 3000 sites: rms 1.6527 m, mean -0.0503 m (|mean|/rms 0.0304), and 3.7x the 2 m curvature on peak ground (0.3108 m -> 1.1604 m over 345 sites)`. That 3.7x is not the 3.5x quoted above: the gate uses its own smaller site set and a different scatter seed. `shatter` takes the same assertions on its own knob -- zero-mean, exactly linear in the amount, exactly 0 at the band-limit cell -- plus a continuity transect, an envelope of pyramids being the one operator here that could produce a genuine cliff or a visible lattice seam. `crease` is checked on the claim it rests on and not only on its output: a tent and a dome of equal parameter count are fitted to every 7-texel crest cross-section in the RAW texels, against a blurred control, so "the corner is in the data" is a measurement rather than an assertion; and its 3x3 Voronoi neighbourhood is verified against a 5x5 reference over 200k points, which found zero disagreements -- the same claim about `shatter` was wrong by a factor of sqrt(2) when it was merely reasoned about. Erosion conserves mass, and an eight-stamp sculpt drag over an eroded world leaves the derived field bit-identical to a full re-erode (it is spliced into the standing copy -- substituting `thermalErode`'s return value reverted 8.8% of the world to the raw import); and `sharpen` raises the curvature kurtosis of the detail stack alone -- **not** of the composed field, whose kurtosis is not estimable at any affordable sample size. Every knob's walkability cost is PRINTED rather than asserted, since these are opt-in and a threshold would be asserting a taste; the all-off number is asserted, because that one is the shipped world.
4. **terrain brush** -- the falloff's derivative is ~0 at both rim and centre (a cone would leave a crease ring around every stamp, at 6.25 cm cells); the dirty rect covers every texel inside the radius plus the smoothing stencil and no more; the world box handed to the mesher is widened by the 2-texel Catmull-Rom stencil; `smooth` blurs off a snapshot, checked on the texel stamped immediately AFTER a spike (in place it comes out 9x too low); strokes clamp to the encoding's range and report how many texels hit it; a sculpted field survives `toPng` -> `decodePng` to within half a quantisation level; and, headlessly, a `Sculptor` drag of eight stamps costs at most two worker patches, sends every texel it moved, and undoes to bit-exact original heights.
5. **snow line** -- the interpolant passes through every authored point to <1e-3 m; returns exactly `base` outside every radius; a 200-point cluster costs O(1) per query after bake; dirty-rect rebake is bit-identical to a full rebake.
6. **paths** -- a river carve reaches `depth` at the centreline and 0 at `halfWidth * 2`; a road's surface is within 1 cm of the spline `y` inside `halfWidth`; a tight S-bend does not self-intersect (centripetal, not uniform).
7. **slot pool** -- worst-case selection over a few hundred camera positions at `MAX_DEPTH 13`, plus pinned chunks, fits `SLOT_COUNT`.
8. **layer culling** -- over a sampled sweep, the fraction of chunks that early-out is above 95% for a world with a dozen authored objects. This is the claim "compact and performance-efficient" reduces to, so it is the one that gets a number.
9. **host wiring** -- `src/v2/main.js` constructs a `WebGLRenderer` on its first line, so node cannot import it and no section above can reach it. The rules its collaborators' headers state as "the host must" are asserted textually instead, comment lines stripped first: it does not call `markers.update()` (the editor owns that call and two callers race on the handle scale), it does not transform `water.group` (the shader reads world position off `modelMatrix`), it patches `roads.material` in `vertex` mode (or the road is the one surface that stays lit after dark), it calls `setVisibility` on all three surfaces that draw authored geometry (miss one and the panel's hide toggle silently does nothing to that layer), and `probe.update()` runs before `renderer.render()`. Each corresponds to a failure that is invisible in the frame it happens in, which is what makes a weak check worth more than none.

Everything DOM, three.js, XR and gizmo on the `/v2` route is still unexercised by any gate: node reaches none of it, and there is no browser harness. The first click through the markers -> editor -> gizmo path will be a human's.
