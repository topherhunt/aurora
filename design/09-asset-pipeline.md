## 9. Asset pipeline

> **Covers:** the headless Blender pipeline under `tools/props/` -- decimation, UV consolidation, baking, impostors, the texture array, and the sourcing rules.
> **Read this when:** adding or rebuilding a prop asset. Read the sourcing rule before buying anything.

### Bootstrap assets (in hand)

`tmp/placeholder-props/Ultimate Nature Pack - Jun 2019/` -- 150 Quaternius CC0 meshes in OBJ/FBX/Blend. Key findings from inspection:

- **No textures and no UVs at all.** Each mesh carries 2-3 materials that are solid `Kd` colors (`Green`, `Wood`). Flat-shaded.
- Poly counts are above target. ⚠️ **Corrected:** the counts first recorded here were *quads*, not triangles, and were therefore half the real cost. Measured after triangulation: `CommonTree_1` = **2,888** tris (recorded 1,444), `PineTree_1` = **1,920** (recorded 958), `Rock_1` = **70** (recorded 36). `len(mesh.polygons)` is the trap -- see `tools/props/common.py:tri_count`. **Decimation is required even for these**, and by twice as much as it looked.
- `_Snow` **variants exist for nearly every species** (`PineTree_Snow`, `CommonTree_Snow`, `BirchTree_Snow`, `Bush_Snow`, `Rock_Snow`, `TreeStump_Snow`, `Willow_Snow`). Directly usable for a snowy mountainscape and for a snow-accumulation swap.
- ~40 distinct species prefixes, most with 5 variants each. Ample variety for the whole project.

Also present: `tmp/placeholder-props/high-poly-to-decimate/` -- 23 zipped higher-poly assets (cabins, watchtower, windmill, boulders, ferns, grasses) needing heavy decimation.

### Texture array, not atlas

**Art direction, stated precisely so it does not drift again: low-poly geometry with N64-resolution textures.** Ocarina/Majora, or a lower-res Skyrim. Explicitly **not** the flat-shaded untextured low-poly look. The Quaternius bootstrap assets happen to be flat-colored; that is a property of the placeholders, not the target.

Textures live in a `DataArrayTexture` rather than a packed 2048² atlas. Each vertex carries a `texLayer` index attribute; the shader samples `texture(sampler2DArray, vec3(uv, layer))`. One texture binding, so still one material, so `BatchedMesh` still batches everything (§5). Layer sizing is settled below -- 128×128, in two arrays.

Why the array wins at this texture size:

|  | Atlas | Texture array |
| --- | --- | --- |
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

|  | **Class A -- tiling surfaces** | **Class B -- per-asset UV atlases** |
| --- | --- | --- |
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

### Procedural variant banks: baked once at load, never per instance

`buildFern()` is a *generator*, and the temptation it creates is to call it per instance so no two ferns in the world are alike. Don't. The runtime model is a **fixed bank of N baked variants**, built once, added to the batch as N geometry IDs, and assigned to instances by hash. Per-instance uniqueness comes from the transform and the tint, not from the mesh: yaw, uniform and non-uniform scale, lean, and hue/value multiply. Those cost nothing and read as more variety than mesh topology does at any distance past arm's reach.

The reason is not generation speed, it is that a per-instance mesh cannot be batched. `BatchedMesh` draws many geometries in one call because they are *resident* -- each has a reserved vertex range and a geometry ID. A mesh that exists for one instance and then never again defeats the entire §5 architecture, and it also defeats LOD, since `setGeometryIdAt` swaps between *pre-existing* tiers.

The bank is cheap enough that variant count is not a budget conversation. Measured (`scripts/probe-variants.mjs`, the fern generator at 5 shape axes × 3 values):

| Bank | Vertex + index bytes | Build time | Avg / max tris per variant |
| --- | --- | --- | --- |
| 6 variants | 10.4 KB | 1.1 ms | 35 / 54 |
| 12 variants | 22.4 KB | 0.7 ms | 39 / 72 |
| 40 variants | 77.7 KB | 1.3 ms | 41 / 72 |

Forty fern variants are **78 KB and one millisecond**. Against a download budget measured in megabytes (above) and a 1-2 s load, the honest answer is that 6 and 40 are the same price and the choice should be made on whether a seventh shape is *visible*, not on cost. Extrapolated to trees at ~500 tris (the fern runs ~49 bytes per triangle), 6 kinds × 6 variants × two mesh tiers is roughly **1.1 MB** -- still not the constraint.

What a variant *does* cost, and the three things to watch:

- **Space in the batch's shared vertex arena, and nothing more.** There is no fixed number of "geometry slots": `BatchedMesh` takes `maxVertexCount` / `maxIndexCount` at construction and grows its geometry list freely inside that arena. `scatter.js` sizes the arena by summing the variants it is about to add and calls `addGeometry(g)` with no reservation, so **variants pack tight and the only cost of one more is its own vertices.** Terrain is the opposite case and deliberately so -- it reserves uniform `CHUNK_VERTS`-sized ranges because chunks are *recycled* through `setGeometryAt`. Reserve a uniform size only if a geometry will be overwritten in place; a variant bank never is.
- **Nothing per frame.** Variant count does not appear in the per-frame cost at all -- `onBeforeRender` walks *instances*, not geometries, and multi-draw submits one call regardless. This is the asymmetry worth internalising: **geometries are nearly free, instances are not.** It is the same fact as the crossover in §5, seen from the asset side.
- **One texture, or the bank stops being cheap.** All variants must share a material and a texture layer, which for the fern means the atlas-joining constraint in the header of `src/props/fern.js` (`uv` renamed to `uvProj`, a constant `texLayer` attribute). A variant that needs its own layer is a new *kind*, not a variant, and it pays §9's per-layer costs.

The far card tier is exempt from all of this and deliberately so: cards live in `InstancedMesh` (§5), which draws *one* geometry, so the entire variant bank collapses to a single quad past the card crossover. Variety out there is tint and scale only, which is all that survives at 20 px anyway.

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

Stages, in order, each placed where it is for a reason recorded in the source: **import → join → ground+centre → weld/triangulate → scale to declared height → vertex colours → AO bake → LOD chain (and, per tier, unwrap + bake its own atlas + finalise its material) → billboard render → swap the atlas for an export stub → GLB**.

The texture bake sits *inside* the LOD loop rather than once before it, and that placement is load-bearing -- see "the atlas has to be baked per tier" below.

**Source classes, detected not declared.** The manifest cannot know which a file is without opening it, so the pipeline branches on what it finds:

| Class | Detect | Colour path | Layer cost | Count |
| --- | --- | --- | --- | --- |
| Textured | a Base Color image | Smart UV Project + Cycles bake into a 128² layer, per mesh tier | 1 layer per mesh tier | 7 |
| Flat `Kd` | materials, no images | material colour → vertex colours | **0 layers** | 138 |
| Vertex-coloured | a colour attribute and no materials | kept as-is | **0 layers** | 1 (scanned PLY) |
| Scanned, maps loose | `base_color_map` in the manifest | material built from the files, then Textured | 1 layer per mesh tier | 8 |

The last row is the one exception to "detected not declared", and it has to be. Megascans ships its FBX with **no material at all** and the maps as loose JPGs beside it, so detection correctly answers "no images" and sends a photoscanned birch log down the flat-colour path -- discarding the only reason to use a photoscan. `attach_loose_textures` reads two paths out of the manifest entry (base colour, and opacity for the cutout foliage) and builds the ordinary Principled tree everything downstream already expects, so it is one generic field rather than a per-asset code path. The other seven maps in those packs -- normal, cavity, gloss, specular, displacement, translucency -- have no consumer: the runtime is one Lambert pass with a 128² albedo layer and baked AO (§8), and a normal map would not survive resampling to 128² anyway.

That is the finding that matters for the `MAX_ARRAY_TEXTURE_LAYERS ≥ 256` worry above: **154 assets need 21 albedo layers, not 154**, because 138 of them carry flat material colours that become vertex colours and cost nothing but geometry. The 21 is 15 textured assets across their mesh tiers, since each tier is unwrapped and baked separately. The other 99 layers are impostor sheets, one per asset that gets a billboard (every `large` and every `structure`), so the total is **120 of a guaranteed 256**. The ceiling is not close, and the ~9.8 MB uncompressed estimate does not apply to the current library.

**AO goes into vertex colours, not into a texture** (§8 asked for "the asset's own texture"). Vertex colours because the runtime is already `vertexColors: true`, they cost no layer, and at 500 tris the vertex density is comparable to what a 128² unwrap resolves. Raw AO is floored at 0.45 -- black bottoms-out reads as a hole rather than as shadow under one directional light plus ambient, and a crevice outdoors is lit by ambient, which is never zero. AO ray length is a fraction of the asset (`height × 0.25`), not a constant: 1 m on a 14 m tree turns the canopy into a black mass and 1 m on a 0.4 m grass tuft occludes nothing.

**Decimation only works after welding.** These FBXs are exported per-face or per-leaf-card, and the collapse decimator cannot collapse across a seam it reads as a boundary. Measured on the pine sources, welding first is the difference between reaching 500 tris and stalling around 3,000.

⚠️ **The collapse decimator has a hard floor at open boundaries, and it does not report it.** It takes a ratio, not a target, and silently returns whatever it reached. Anything with many boundary loops -- every building, all photoreal card foliage -- stops well above target. `build.py` therefore records `stalled` and `overshoot` per LOD, and `check-props.mjs` prints them, because a chain that quietly returns 917 tris for a 130 target is the most expensive lie this pipeline could tell. Structures get a planar-dissolve pre-pass (`planar_collapse`), which clears real ground (896 → 544, 2,366 → 1,514) but never reaches the target -- hence the one-mesh-tier `structure` class in §5.

**Not every stall is a floor, and the difference is one line of cleanup.** `decimate_to` iterates -- aim, measure, re-aim -- because the modifier takes a ratio and stops early. It used to run a fixed six rounds without cleaning up in between, and that plateaus long before the real floor: the debris of the previous round (the collapsed-but-not-deleted vertices of bug 4 below) presents a topology the next round can barely touch. Validating and dropping loose geometry *inside* the loop, and running it until it stops improving rather than a fixed count, took `wild_grass` from 253 triangles to the 16 asked for. Two assets previously recorded as boundary stalls were not stalled at all. Read a `stalled` flag as "measure it", not as "reject it" -- `probe-source.py` prints the whole trajectory precisely so a plateau (`5.9k → 1.4k → 1.4k`) is distinguishable from a descent that ran out of rounds (`253 → 66 → 28 → 16`).

**The atlas has to be baked per tier, and one bake shared across the chain is not a saving -- it is a silent corruption.** This is the single worst defect the pipeline has had, and the gate could not see any part of it.

`consolidate_texture` used to run once on the full-res object, and the LOD chain was decimated from it afterwards. But an atlas addresses a mesh through UVs that Smart UV Project laid out for a *specific triangulation*. Decimation collapses vertices and drags their UVs with them, so islands smear across their own seams and triangles come to rest wherever the interpolation puts them -- usually the transparent gutter between islands, which alpha test then discards outright. Nothing in the pipeline rechecked this, and nothing could look wrong: the GLB loads, the manifest is self-consistent, `check-props.mjs` passes byte-for-byte, and the asset renders as **nothing at all**.

Measured across the library by rasterising each tier's UV footprint into its own layer: 11 of 21 textured assets kept under 75% of the area they address, and five kept **zero** -- `forest_floor_cluster`, `log_mossy_scan`, `log_birch_scan`, `grass_tall_scan_b`, `grass_tall_scan_c` were fully invisible. It tracked decimation depth exactly, which is what you would expect if the UVs are only valid for the topology they were made for: cabins keeping 8-18% of their source triangles were fine, photoscans keeping 0.01-0.6% were not. Baking per tier took `grass_tall_scan_a` from 5% to 89% and `forest_floor_cluster` from 0% to 100%.

**What the reordering did *not* fix, contrary to what was written here: the decimation floor.** The claim was that Smart UV Project's island seams protect edges from the collapse decimator the way mesh boundaries do, so unwrapping after decimation would take them out of its path and let the stalled tiers descend. The stalled counts did not move by a single triangle. Measured directly on `grass_tall_scan_a` (13,605 triangles, 46.1% boundary edges), decimating the welded mesh to a 16-triangle target three ways: source UVs kept **83**, every UV layer removed **83**, Smart UV Project applied first **83**. UV seams cost this mesh nothing, because its boundary-edge fraction already sets a floor far above anything a seam adds. The earlier "15 before, 83 after" figure does not reproduce and should not be trusted. The remaining 4 stalled LODs (`plant_5`, `boulder_mossy`, `horsetail`, `log_birch_scan`) are boundary stalls and remain open.

The cost of the reordering is one Cycles bake per tier instead of one per asset, and 6 more array slices across the library (114 → 120 of 256, on the trimmed 154-asset library). Both are cheap. The alternative considered and rejected was raising the 66° angle limit for fewer, larger islands, which would have softened the smearing and done nothing about the corruption.

**Not fixable by decimation: photoreal card foliage.** Four downloads were built, measured and then excluded. Every leaf is its own quad, so the mesh is ~100% boundary edges and decimation does not slow down, it does nothing: `island_tree_02` went 1,432,638 → 273,971 tris for a 500 target (54 MB in one GLB, 88% of the library's entire on-disk size), `tall-grass-elegance` 537,210 → 14,847 for a 16 target. Getting these to budget means rebuilding them as a few cross-cards with a baked canopy texture -- authoring an asset, not converting one. Replacing them with game-ready low-poly sources is cheaper. Also excluded, for source reasons rather than topology: one ASCII FBX (Blender does not read it), one FBX whose texture records carry empty file paths, one `.rar`, and two pre-arranged grass *fields* that fight §6's per-tuft scatter. All reasons are recorded inline in `make-manifest.mjs` so nobody re-adds them without reading why.

**Five bugs the gate caught that looking at the render would not have.** Worth stating because each was silent:

1. **Up is +Z inside Blender**, Y only after `export_yup`. Writing the normalisation helpers against +Y scaled every prop along its *depth* axis and centred it vertically instead of standing it on the ground -- 150 assets exported half-buried at arbitrary sizes, and it looks fine in Blender's viewport. Only reading `POSITION.min` out of the GLB catches it.
2. **The glTF exporter drops a colour attribute no material node reads.** It logs a warning and writes a mesh that loads perfectly and renders flat and AO-less -- discarding the entire point of the pipeline. Fixed by collapsing each asset to one material that reads `Col` (which also gives one primitive per LOD, which is what `BatchedMesh` wants anyway).
3. **Decimation moves the bounds.** Collapsing a vertex removes an extreme, so every LOD came out shorter than its source and floating -- a 16-tri plant lost 28% of its height and hovered 15 cm. Each tier is now re-grounded and re-scaled, which also removes a visible shrink-and-hop at every LOD transition.
4. **The decimator does not delete the vertices it collapses**, it unhooks them from the faces and leaves them in the mesh -- 6,180 of `tree_deciduous_hi_LOD0`'s 7,285. Everything that measures the mesh afterwards then reads a ghost point-cloud of the *pre*-decimation silhouette, so the renormalisation in (3) computed a scale factor of 1.0 and applied it perfectly while the exporter -- which writes only face-referenced vertices -- shipped a tree 2% short and a fern 35% short and floating 4 cm. The reported vertex counts were fiction by the same margin, which is not cosmetic: `BatchedMesh` reserves storage against vertex count. This one cost a long hunt for a stale-depsgraph bug, because `obj.bound_box` *is* a lazily-refreshed cache and had the identical symptom; flushing the depsgraph produced bit-identical numbers, which is what finally ruled it out. `drop_loose` now runs at the end of every decimation.
5. `transform_apply` **bakes an object's LOCAL basis, not its world matrix.** Megascans (and any DCC export that carried a unit conversion) parents the mesh to an empty called `world_root` holding a 0.01 scale and a -90° X rotation. Applying transforms on the child bakes an identity and leaves the parent's scale and rotation exactly where they were: in the node hierarchy. Every helper in `common.py` measures `matrix_world`, so every measurement inside Blender was *right* and the build reported OK -- while what shipped was mesh data 100× too large, lying on its side, with a node transform to compensate. `forest_floor_cluster` exported at 167.75 m against a 1.15 m spec with its base 82 m below the floor. `import_any` now unparents keeping the world placement, before anything measures.

Note the shape all five share, because it is the argument for the gate: **the thing that looks at the mesh and the thing that ships the mesh were reading different data.** In (4) Blender saw vertices the exporter would not write; in (5) the exporter wrote a transform Blender had already folded into its measurement. No amount of checking inside the tool finds either. Only assertions against the exported bytes do.

**Four more bugs the gate could not catch, and the argument for** `props.html`**.** The five above were all found by asserting against exported bytes. These four were not, because every byte was valid -- the manifest, the GLB and the PNGs were internally consistent and individually correct, and the assets still rendered as black slabs, as magenta, or as nothing. What found them was building the previewer and looking:

6. **The albedo bake came unstuck from the mesh under decimation.** Described in full above. Five assets rendered fully transparent.
7. **Every textured asset's impostor sheet was solid black.** `render_billboard` re-shades LOD0's material as emission of its own base colour, and it ran *after* `finalize_material` had installed the 1×1 export stub. A textured asset's vertex colours are deliberately white (§8 puts only AO in them), so the emission shader had nothing to sample but the stub. All 9 affected; the 92 vertex-colour impostors were fine, which is exactly why nobody noticed. The stub swap now happens after the billboard render instead of before it.
8. `tree_oak_hero` **baked magenta.** (The asset was later excluded for an unrelated reason -- see below -- but the fix is general and the trap is common.) Its FBX names three textures at paths that do not exist -- two in a `source/` directory that ships them in a sibling `textures/`, one preserving the author's own machine (`C:/_Evan/PHOTSCANS/TREES/...`). `has_images` correctly answers yes, because the material genuinely has a Base Color image node; the image just has no pixels, and Blender substitutes magenta. So the asset took the textured path and baked (249, 0, 249) across 44% of its footprint. `resolve_missing_images` now runs `find_missing_files` outward from the mesh one directory at a time, stopping as soon as nothing is missing -- outward-in rather than starting wide, because all the packs live inside one download tree and a basename match across packs would quietly dress one asset in another's bark. Two false starts worth recording: `img.has_data` is the wrong test (Blender loads pixels lazily, so it reports healthy textures as missing), and the check has to run *after* `attach_loose_textures`, which replaces the broken material on the three `grass_tall_scan` assets outright.
9. `windmill` **baked pure black albedo, and the source was blameless.** One material, one clean UV layer, a 2048² sRGB texture with mean RGB (0.43, 0.28, 0.15). The material carried `metallicFactor: 1.0` from whatever generated it, and a Cycles **DIFFUSE** bake of a fully metallic surface is black by definition -- metal has no diffuse albedo. Cycles was right; the question was wrong. `neutralize_pbr` now zeroes Metallic, Transmission and Specular before every bake, links included, because `watchtower` drives the same input from a metallic-roughness map. None of these have a consumer downstream: §8 ships one directional light against a Lambert-ish pass, and the bake's only job is to capture albedo.

**Two more, found by rendering the built GLBs rather than by reading them.** Bugs 6-9 were caught by measuring the layer PNGs. These two survived that too, because the layers were *fine* -- the meshes underneath were not:

10. **A collapse decimator does not fail on a tuft of grass, it succeeds by flattening the blades.** `grass_tall_scan_a` shipped 83 triangles inside a 2.7 m bounding box holding **95 cm² of total surface area** -- 70 of the 83 under 1 cm². It rendered as a dozen specks. Every check passed it: the triangle count was plausible, the manifest matched the GLB, and the UV-footprint probe scored it **89% healthy**, because the surviving triangles still address perfectly good green texels. UV area and world area are independent quantities once a collapse flattens a triangle, and only the second one decides whether you can see it. Four variants were affected; raising the target does not rescue them but buys the area back at a price no scatter can pay -- measured on Var A, targets of 16 and 64 both land on 83 triangles and 0.1% of the source area, 200 buys 35%, 600 buys 79%, and it takes 2,000 to be intact. A 600-triangle grass tuft is a tree. All four are excluded, and `check-props.mjs` now fails any tier that is both >25% degenerate triangles and presenting <5% of its own silhouette. The two halves are deliberately an AND: a fern is legitimately 6 slivers in 15, and a wispy tuft is legitimately thin, but nothing healthy is both.
11. **"Textured" is per asset and materials are per slot, so an asset can be a chimera.** `has_images` answers yes if *any* material has a Base Color image, and the other slots then bake whatever Principled's default happens to be. `tree_deciduous_hi` shipped a correctly textured trunk under a canopy of 0.8 grey, because its `normal leaves` material has no image at all -- the green `leaves color.png` sits in the source folder and nothing in the FBX references it. Two related traps in the same asset class: an importer that wires a foliage atlas to **Alpha only** leaves Base Color at the same grey default (`wire_orphan_color` now fills an empty Base Color from an image the material already references), and that image is tagged **Non-Color**, so wiring it without re-tagging bakes sRGB green as if it were linear and crushes it to black. Both are fixed; what is not fixable in the build is the missing reference, so `untextured_slots` reports it and the gate repeats it.

And one that is not a pipeline bug at all, recorded because it looked exactly like one: `tree_oak_hero` **at its 1,703-triangle floor is 1,794 twig cards, 5 trunk polygons and zero leaves.** Its three source objects compete for a single budget, and the twig object wins for the reason the card foliage is excluded at all -- twig cards are boundary edges the collapse decimator cannot touch, while the solid trunk collapses freely. The hero oak was a bundle of bare sticks. Excluded. The lesson generalises: **a per-asset triangle budget is not per-object, and a mesh that mixes card geometry with solid geometry spends all of it on the cards.**

The shape these six share is different from the first five and worth naming separately: **the bytes were all valid and the picture was still wrong.** A gate that reads the output can only check invariants somebody thought to write down. `props.html` now carries the measurements (UV-footprint survival per tier, sheet coverage and luminance) so these failures announce themselves in the panel rather than needing to be rediscovered -- but the general lesson is that an asset pipeline needs an eye, not only an assertion.

One methodological note, because it cost two wrong conclusions in a row. **Measuring "does the texture reach the mesh" needs both a per-triangle probe and a per-area one, and either alone lies confidently.** Sampling each triangle at its UV centroid scores a healthy 6-triangle billboard as "83% cut", because a billboard is a few big quads over a sheet that is mostly transparent sky. Rasterising UV area instead scores a fully-smeared unwrap as "100% clean", because smearing collapses most triangles below one texel and an area measure skips them. Both instruments were built, both gave a wrong answer in opposite directions, and what works is rasterising the footprint *with a centroid fallback for sub-texel triangles* -- plus a separate whole-image measure for impostor sheets, which are not triangle-addressed in any meaningful sense.

And the sharper version of the same lesson, from bug 10: **every one of those instruments measures the texture, and none of them measures the mesh.** A tier can score 89% on the best of them and be invisible, because they all answer "what is under this triangle" and none answers "does this triangle have any area". `check-props.mjs` now asks both.

Still to do: **compression.** Geometry is meshopt-able and the layers want ASTC/KTX2. ⚠️ Verify that KTX2/Basis round-trips *array* textures through three's `KTX2Loader` before relying on it.

Get **one** species through end-to-end before doing forty -- this held up exactly as written. Every bug above was found on the three-asset smoke test or on the first full build, and each would have been far more expensive to isolate across 160.

---
