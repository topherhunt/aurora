# §28 -- solid trees, reconstructed then painted

A tree that a Quest 2 can afford to draw, made from a sentence. One bench, `/gen-tree-v9`, runs the chain: a candidate image, a solid mesh reconstructed from it, our own decimation, and a paint pass that dresses its faces in this world's tiling textures.

It reuses §27's vendor client wholesale and departs from it in exactly two places. Both departures are the section.

## Why this exists: alpha is the cost, not the triangles

The EZ-Tree generator (`tools/trees/generate.mjs`) makes trees that look superb and **halve the frame rate on a Quest 2**. The triangle count is not the problem -- a tree runs ~480 tris at LOD0 and `src/budget.js` has room. The problem is that its foliage is alpha-tested cards, and on Adreno an alpha-tested draw loses low-resolution-Z for the whole draw. `tools/trees/solidify-leaves.mjs` states it in one line -- "a leaf cut is ~25% opaque, so wearing it means an alpha test" -- and §26 is the first attempt at living with it, by building crowns out of solid voxels.

So the deliverable is a **solid opaque shell**: no cutouts, no cards, nothing for the depth pre-pass to give up on. Everything in this pipeline exists to end up with one.

## Departure one: ask for a picture of the mesh you want, not of a tree

Every image-to-3D model fails the same way on vegetation. Structure thinner than a few pixels -- twigs, needle sprays, single leaves -- reconstructs as mush, because a photograph of a gap between two leaves carries no depth information.

Two passes were spent trying to prompt around that, and both failed in a way worth recording:

1. **Order the canopy closed.** It asked for foliage "like carved foam or modelling clay" and got exactly that: smooth, symmetrical, lumpy, a lollipop rather than a tree. The clause was not misread; it was granted.
2. **Order a real photograph.** A survey photo on an overcast day, camera named, proportions as ratios, irregularity spelled out. The pictures came back genuinely good -- and reconstructed as *a contorted agglomeration of lollipops*, because a dense lush crown gives the reconstruction nothing to be right about. **The better the photograph, the worse the mesh.**

So the prompt asks for the thing there is going to be a mesh of: **a clean low-poly model of the tree**, the kind sold as a game asset. Large flat facets, foliage as five or six big smooth masses, no individual leaves, no twigs, no holes smaller than a branch, one closed watertight object. Tripo reconstructs that well for the same reason it fails on leaves -- every surface in the picture is a surface the mesh can actually have -- and the decimator downstream is then reducing a shape that was already polygonal.

It is worth being explicit that **the picture is not the deliverable.** Judging a candidate on whether it is a beautiful tree is what bought two rounds of lovely images and no usable mesh.

Three clauses survive from the failed passes, because they are still the difference between a usable mesh and a paid-for one that is not:

- **Proportions as ratios, not adjectives.** "A broad crown on a thick trunk" is drawn as a specimen diagram; "a crown one and a third times as wide as the tree is tall, on a trunk a tenth of its height thick" is drawn as an oak.
- **Where the lowest branches start**, per species. The paint step can only paint faces that exist, and a canopy swallowing the trunk to the ground has no bark region in it. One shared "a clear length of bare trunk" is what gave the pine a bare pole halfway up itself, so the pine says it in pine terms.
- **Irregularity**, named outright: masses at different heights and sizes, one side heavier, the crown off-centre. A mirror-symmetrical tree is the surest tell that a mesh was generated.

The pine costs more passes than the other three, and the reason is worth keeping: **counting the boughs is what stacks them.** "Six or seven boughs" is drawn as six or seven evenly spaced plates -- a bonsai -- and no amount of "nothing tiered" alongside it holds. It is asked for as one merged ragged cone instead, and the two shapes it defaults to (stacked plates, and an umbrella on a bare pole) are refused by name. The silhouette is also stated positively, bottom upward, rather than left to a bare-trunk fraction: the widest masses attach a quarter of the way up and shorten to a point.

### One editable field

The crown / trunk / description split existed to force proportions to be stated, and it did its job, but three boxes are three places to edit for one change. **Each species now carries a single `prompt`** holding everything specific to that tree, and the bench edits it as one textarea. `buildTreePrompt` appends only the staging every later stage depends on and nobody should have to retype: one closed object, a three-quarter view, a margin on all four sides, a plain mid-grey background, flat even light. Those serve the reconstruction and `src/lighting.js`, not the tree.

**Framing is pinned with a margin**, because asked for loosely ("whole tree in frame, nothing cropped") the pine came back with its trunk running off the bottom edge -- and the foot of the trunk is what `groundAndScale` measures from.

A meta saved under the old three-field bench is folded into one prompt on read (`foldLegacyMeta` in `workspace.mjs`), so an edit made before this change survives rather than silently reverting to the species seed.

`scripts/check-tree-v9.mjs` pins the shape of all of it -- including that nothing asks for a photograph again, which is the mistake that repeats.

### The model matters less now

Both offered models draw this brief well: FLUX.2 Klein 4B returns crisper facets, Nano Banana (`google/gemini-2.5-flash-image`) follows the stated proportions more closely -- a wide crown and a low fork where FLUX draws a narrower, more symmetrical tree. On the photographic brief the gap was decisive; on this one it is a preference, and FLUX is a third of the price. The bench defaults to Nano Banana and offers both.

The list is `IMAGE_MODELS` in `tools/characters/openrouter.mjs`, cheapest first, and it is an **allow-list, not a menu**: the id arrives from the browser and decides what the account is billed for, on a dev server bound to the LAN, so `requireImageModel` refuses anything not on it. Nano Banana Pro is ten times FLUX per click, which is the reason that check exists. Prices there are estimates for printing on a button; what gets recorded is the `usage.cost` the response carries back.

## Departure two: projection, not unwrap

§27's load-bearing worry is the 128px texture over a scattered unwrap. This pipeline does not have that problem, because **it never solves an unwrap at all.** `src/mesh/paint.js` computes a face's UV from where it sits in space, divided by how many metres one tile of its texture covers.

Three consequences, and they are why the whole stage is cheap:

- **Texel density is constant by construction.** Two trunks of different girth wear the same size of bark, because both divide by the same metres-per-tile.
- **There are no islands**, so no gutter to lose and no neighbour to bleed in from. The atlas is a `DataArrayTexture` with `RepeatWrapping` and each layer owns its whole `[0,1]` (`src/textures.js`), so a `u` of 3.7 is three tiles and a bit.
- **Tripo's own unwrap is discarded**, which is what lets the decimator run in `'drop'` mode with no seams to pin. §27's reduction ceiling is a direct measurement of how badly the atlas shattered; here there is no ceiling because there is no atlas.

It also means Tripo's texture is not worth buying. `runMesh` defaults `texture: false` -- the one parameter that differs from the creature pipeline's call -- which saves 10 credits and brings the price of a tree to **40 credits (~$0.40)** against a creature's 105. It stays switchable, because the vendor's own texture is the fastest way to see whether the *reconstruction* is right before deciding the paint job is wrong.

### The two projections

`planar` is per-face off the dominant world axis, and is the projection every rock in this world already wears (`src/props/rock.js`) -- the axis mapping matches exactly. Adjacent faces that pick different axes get a UV discontinuity at their shared edge, which is visible on a texture with strong directional structure and invisible on the isotropic ones this is for: leaf mats, moss, stone.

`cylindrical` exists for the one texture that has a direction: **bark runs up.** It wraps about the vertical axis through the slot's own faces, and its one real decision is that **tileability beats exact size**. The texture closes on itself around a trunk only if the number of repeats around is a whole number, so the asked-for size picks the nearest integer count at the mean radius and the **achieved** size is reported back in the slot table, usually a few percent off.

Two details that look like implementation and are not:

- `u` is an **angle fraction times the repeat count**, not an arc length. Arc length keeps density honest on a taper but makes the repeat count vary with radius, so the texture closes at only one height -- which is the failure being avoided. A trunk that tapers 2:1 wears bark 2:1 wider at the foot; that reads as a big tree, and a seam does not.
- **The branch cut is per face.** `atan2` jumps by 2π across the -X meridian and a face straddling it would stretch the whole texture backwards across one triangle, so every vertex angle is wrapped into the half-turn either side of its own face's centroid. This is why the mesh is unwelded first, and the gate asserts that no face spans more than half a turn.

## The output is the attribute set that already ships

`painted.glb` carries `position`, `normal`, `uvProj`, `texLayer` -- exactly what `createPropMaterial` compiles against (`src/material.js` samples `texture(uAtlas, vec3(vUvProj, vTexLayer))`) and what every rock in the world already carries. **No shader work is required to render one of these.**

Every mesh in the paint stage is unwelded, three positions per face. `texLayer` and `uvProj` are per-vertex while painting is per-face, so two faces wearing different layers cannot share a vertex. It triples the vertex buffer of a 1000-triangle mesh, which is 3000 vertices; `props/rock.js` has always done the same thing.

`paint.json` is saved beside the GLB and is the more important half. The GLB's `texLayer` is a bare number; the sidecar records which *file* each slot meant, how its UVs were solved, and the per-face assignment. The mesh can be bought again for 40 credits; the paint job cannot.

## The stages

| # | stage | vendor | cost | writes |
|---|-------|--------|------|--------|
| 1 | candidate image | OpenRouter (FLUX or Nano Banana) | $0.015-$0.15 | `candidates/<n>.png` |
| 2 | pick an image | -- | free | `source.png` |
| 3 | mesh | Tripo image-to-model, P1 | 40 credits (50 with texture) | `meshes/<n>.glb` |
| 4 | pick a mesh | -- | free | `mesh.glb` |
| 5 | decimate | ours, in the tab | free | `mesh-lod<n>.glb` |
| 6 | paint | ours, in the tab | free | `painted.glb` + `paint.json` |

There is **no rig and no animation stage**. A tree does not move under its own power; wind is a vertex shader (`src/material.js`). §27's rig and animation stages have no analogue here.

Both bought stages are galleries: images and meshes alike accumulate as numbered candidates, and picking one copies it to the fixed name the next stage reads (`source.png`, `mesh.glb`). Picking a mesh is free and reversible, so four reconstructions of the same picture can be compared before one is decimated.

Working files live under `tools/trees/v9/work/<id>/` and are gitignored -- paid-for sources, not shipped assets. As in §27, `state.json` is written the moment a task is created, *before* the wait: a task id is the only handle on work already paid for, and a dev-server restart mid-generation must lose the poll and not the purchase.

## The bench

Two orange buttons and nothing fires on its own. Left-drag paints, right-drag orbits, and the three brush modes are one face, a sphere of a given radius in metres, and a flood fill.

**Both buy buttons queue rather than block.** They grey for one second and the request runs in the background, so several images and several meshes can be in flight at once and a 90-second Tripo job does not hold the tab. That makes the slot claim in `runMesh` load-bearing: the landing mesh takes the first free number in `meshes/` in a stretch with **no `await` in it**, written with the `wx` flag. A number read before an await is a number two tasks can both win, and the loser's 40 credits are overwritten silently. The gate reads that stretch as text and fails on an `await` appearing in it.

Each image candidate carries a trash button, behind a confirm that names what it cost -- a candidate is cheap but not reproducible, since the same prompt does not return the same picture.

**The flood fill measures each step against the neighbour it walked from, not against the seed.** Against the seed, a 40° cone stops a quarter of the way round a cylinder; against the neighbour, the fill walks all the way round because each step is a small turn, and still stops dead at the crown where the surface genuinely creases. That difference is what makes one click select a trunk, and it is a one-word edit to lose, so the gate pins it with a 16-segment tube.

The preview atlas is **bench-local**: it is built from whichever pool files are in the slot table, because the `_solid` foliage mats in `public/trees/` are on disk but are not yet registered layers in `src/textures.js`. The slot table's `layer` column is the world layer the export writes into `texLayer`, and `paint.json` names the file behind each slot. Promoting these textures into the world atlas is a separate edit, and nothing in the bench silently assumes it has already happened.

## What is not done yet

- The `_solid` foliage textures are not `src/textures.js` layers, so a painted tree cannot be dropped into the world until they are.
- Nothing in `src/v2/` loads a GLB prop -- trees are built at runtime by `src/props/tree-bank.js`. Shipping a painted tree needs a loader and a scatter entry.
- `mat_aspen.png` (369²) and `mat_pine.png` (360²) violate the 128px atlas invariant and the pool marks them unusable rather than hiding them.
