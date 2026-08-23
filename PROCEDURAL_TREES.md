# Procedural trees and foliage

A build-time generator that grows trees, bushes and grass to a triangle budget instead of decimating scanned meshes down to one. Status: working proof of concept, 10 assets in the library, passing the props gate. Not yet judged good enough to replace the scanned foliage.

## Why this exists

The hand-collected prop library could not produce usable foliage. The collapse decimator will not collapse across an open boundary, and alpha-card foliage is very nearly all boundary, so trees and grass had a hard triangle floor well above budget. Four grass variants and two trees had to be dropped outright for that reason. A generator has no such floor because the budget is an input rather than a target to approach.

Goal: a LOD0 tree under 500 triangles that still reads as lush, with LOD1 and a billboard that do not visibly thin out or pop.

## Running it

```
npm run props:generate     # node generator + Blender atlas builder (writes tmp/generated-props/)
npm run props:manifest     # folds generated.json into tools/props/manifest.json (164 assets)
npm run props              # Blender build of the whole library into public/props/
node scripts/check-props.mjs
```

`props:generate` must run before `props:manifest`, and both before `props`. The atlases are staged in `tmp/generated-props/layers/` rather than written straight to `public/props/` because `npm run props` runs `build.py --clean`, which wipes the output tree immediately before building. They are inputs to the build, not products of it, and `build_generated` copies each into place as the asset referencing it is built.

## Pipeline

| Stage | File | Produces |
|---|---|---|
| Grow tiers | `tools/trees/generate.mjs` | one GLB per tier in `tmp/generated-props/`, plus `generated.json` |
| Build atlases | `tools/trees/layers.py` (Blender) | 5 shared 128x128 PNGs in `tmp/generated-props/layers/` |
| Finish and export | `build_generated` in `tools/props/build.py` | `public/props/assets/*.glb` + `public/props/layers/*.png` |
| Register | `tools/props/make-manifest.mjs` | folds `generated.json` in beside the 154 scanned assets |

EZ-Tree (`@dgreenheck/ez-tree` 1.1.0, MIT) is a **devDependency**. Its logic runs at build time only; nothing ships to the runtime. It needs a DOM shim (a stub `document.createElementNS` returning a fake `img`) because it expects a browser.

Generated assets are folded into the same manifest, build, gate and previewer as the scanned ones rather than kept in a parallel pipeline. The question this POC answers is whether generated foliage can be a normal citizen of the library, and a second pipeline beside the first would be assuming it cannot.

## Design decisions

### Budget allocation

Three rules, all of which exist because the first version produced a bare pole with a dozen sprigs at 484 triangles. The search had been maximizing triangles under budget without caring what it spent them on, and put ~450 into eleven tapered branch cylinders.

1. **Branch tessellation is pinned, never searched.** The trunk gets 5 sides and 5 sections at a 400+ budget, stepping down to 4 and then 3 as the budget shrinks. A 5x5 trunk costs 50 triangles, which is most of a 130-triangle LOD1 spent before a single leaf. Child branches are always 3 sides and 2 sections, a straight untapered stub at 12 triangles. Branch *count* is what reads as a conifer; branch curvature is what nobody can see.
2. **Branches get a fixed share of the budget.** `BRANCH_SHARE = 0.4`, found by bisecting branch count. Without a ceiling the branches take everything, because they are what the preset scales first. Because it is a fraction rather than an absolute, every tier splits 40/60 regardless of size, which is what keeps the leaf-to-branch ratio constant across tiers.
3. **Leaf size grows as leaf count falls**, as the square root of the density shortfall, capped at `MAX_LEAF_SCALE = 8`. Pine Medium's own canopy is 82 branches x 30 leaves = 2,460 cards; ours is ~150. The same crown volume with 6% of the cards is see-through unless each card grows to cover the gap. The cap is reported when it binds, because a bound cap is exactly the case where a tier ends up thinner than the one above it.

`fillLeaves` measures to a fixed point rather than computing, because `leaves.count` is not simply cards-per-branch: which branches bear leaves depends on `levels` and `leaves.start`. The arithmetic estimate came out roughly half right (an oak asked for 155 cards and got 78).

`tune` searches each branching depth from the preset's own down to 1 and keeps the tree with the most **leaf** triangles that fits, not the most triangles.

### Canopy carry-down

This is the most important decision in the file, and it is what makes distant trees hold up.

Lower tiers do **not** re-grow their canopy. The obvious approach is to run the same search at a smaller budget, and that was the first implementation. It failed in a way that equal total leaf area did not fix: a pine LOD1 with a quarter of LOD0's branches can only afford about four branches, so every leaf piles onto those four and the same quantity of foliage arrives as two dense whorls with a bare leader spiking out of the top. Same lushness, wrong tree, and the transition reads as the crown reassembling itself as you approach, which is worse than reading as thin.

So LOD0's cards are carried down instead. `readCards` reads LOD0's leaf quads straight out of the buffer (EZ-Tree with `billboard: 'single'` emits exactly one quad per card, four vertices with indices n,n+1,n+2,n,n+2,n+3, verified against the generated mesh). `mergeCards` k-means clusters them by position, and each cluster collapses to one card: the cluster's own most-central member, moved to the cluster centroid and grown by the square root of how many cards it stands in for.

Three properties then hold by construction rather than by tuning:

- **crown shape**: cards only ever appear where LOD0 had cards, so the silhouette is LOD0's resampled rather than a new one
- **local density**: area is conserved per cluster, not just in total, so a thick lower whorl stays thicker than a sparse leader
- **colour balance**: same atlas, same tint, same card aspect, only the count changes

It is also exact and needs no search: the tier gets precisely as many cards as its leftover triangles allow.

Details that matter: k-means++ seeding via a deterministic LCG, because a canopy that reshuffles between builds makes every diff meaningless. Plain spatial binning was the cheaper option and is wrong, because a fixed grid cuts a crown at cell walls rather than where foliage clumps, landing a card in the gap between two whorls where LOD0 has nothing. The representative is a real member rather than a synthetic average, because averaging four corners across cards of differing orientation collapses the quad toward its own centre and the card comes out shrunken and skewed.

Lower tiers also pin `branch.levels` to 1 rather than searching it. Sub-branches are hidden under a merged canopy at every range the tier is drawn at.

### Billboards

Rendered from **LOD0**, not generated separately. `render_billboard(lod_objs[0], ...)` is an orthographic side render with EMIT shading, so the impostor carries albedo and nothing else. Any baked-in directional light would be wrong the moment the sun moves, and the sun moves continuously here. This holds for the scanned assets too.

Side view only, one image. An octahedral impostor (8 to 16 view directions) would give real parallax but costs 8 to 16 array layers per asset against a `MAX_ARRAY_TEXTURE_LAYERS` guarantee of 256, which spends the entire budget on impostors for ten assets. Flatness is hidden by the thing that makes billboards necessary in the first place: at the distance they switch in, the forest is dense enough that no single tree is separable.

The billboard render doubles as the cheapest honest check on UV orientation. A brown trunk and green leaves means the V flip is right; the reverse means it is not.

### Shared atlases

Five 128x128 RGBA PNGs (`leaf_pine`, `leaf_oak`, `leaf_aspen`, `leaf_ash`, `grass_tuft`), about 64 KB total, serve all 10 generated assets across every tier.

This is possible only because the tiers are **authored rather than decimated**. `build.py` bakes one layer per asset per tier for the scanned path because decimation invalidates a tier's UVs; `tree_dead_standing` alone ships three near-identical 40 KB PNGs. Nothing in the generated path invalidates UVs, so every tier of every tree of a species can address one image. Seven tree species and three grass variants cost 5 layers instead of 20.

Layout, in glTF UV space (v=0 at the top of the image):

```
v 0.00 .. 0.75    leaf art, cropped to its alpha bounds and resampled
v 0.75 .. 1.00    solid opaque white, sampled by every bark vertex at (0.5, 0.875)
```

The opaque patch exists because the live prop path uses a single `map` per material. `src/material.js` `createPropMaterial` does have per-vertex `texLayer` and `uvProj` attributes that would let bark and leaves index different array layers, but it is imported only by `src/spike-main.js`; `src/props/scatter.js` and `src/props-main.js` both use one image. So bark and leaves must share one layer, and bark takes a single opaque texel.

Transparent texels are flooded white before saving. Mipmaps are on for the atlas (`src/textures.js`, `LinearMipmapLinearFilter`), and mip generation averages RGB without regard to alpha, so a black transparent background bleeds a dark rim into every leaf edge one mip down. Flooding white means the bleed goes toward the leaf's own brightness and reads as softening rather than as an outline. Cropping to the alpha>0.5 bounds first is worth roughly a third more effective resolution.

Grass gets no patch and uses all 128 rows. It is cards and nothing else, so there is no bark to give an opaque texel to, and it is the most-instanced asset in the world.

### Colour

Tints are written into COLOR_0, which is **linear** end to end (Blender colour attributes, the glTF spec, and three's `vertexColors` all agree). The species table authors them as sRGB and `generate.mjs` converts. Verified through the whole chain: bark authored at sRGB 0.30, 0.22, 0.17 came back from Blender as linear 0.0723, 0.0395, 0.0242, matching the prediction exactly.

Leaf tints are deliberately near-white. The atlases are photographic and already carry the species colour; tinting again would double it.

Blender's glTF importer names COLOR_0 `Color`, not `Col`. `adopt_generated_colors` renames it before `ensure_corner_col` runs, which otherwise creates a fresh white layer and discards every tint silently.

### V-axis flips

Four flips that do not cancel, so all UV work is defined in glTF space and converted once:

1. three.js puts v=0 at the image bottom
2. glTF puts v=0 at the top
3. Blender image rows start at the bottom
4. the runtime sets `flipY = false` (`props-main.js`) precisely because the UVs are glTF's

`leafV(v) = (1 - v) * (1 - PATCH_V)` takes three's v, flips it into glTF's, and squeezes it above the patch. An earlier `BARK_UV` of v=0.125 landed in the leaf art rather than the patch; caught by a Blender import probe.

### AO

Baked per tier with `isolate=True`, which hides every other mesh during the bake. The tiers are all grounded at the origin and fully interpenetrating, so without isolation LOD1 casts shadow onto LOD0.

Reach is `height_m * 0.06`, much shorter than the 0.25 the scanned assets use. AO rays do not know a leaf card is a cutout; to Cycles the canopy is a few hundred overlapping opaque quads, so a reach that spans the crown buries the tree in its own shadow. A short reach still darkens where cards genuinely stack.

## Current output

Reproduced by `npm run props:generate`. Species are defined in the `SPECIES` table in `generate.mjs`; `leafScale` is the LOD0 card growth factor, and lower tiers report how many LOD0 cards they merged.

| Asset | Class | Height | LOD0 | LOD1 | Cards |
|---|---|---|---|---|---|
| `gen_pine` | large | 11.0 m | 482/500 (194 branch + 288 leaf) | 130/130 (42 + 88) | 144 -> 44 |
| `gen_pine_young` | large | 5.5 m | 482/500 | 130/130 | 144 -> 44 |
| `gen_oak` | large | 9.0 m | 494/500 (198 + 296) | 130/130 (48 + 82) | 148 -> 41 |
| `gen_aspen` | large | 12.0 m | 494/500 | 130/130 | 148 -> 41 |
| `gen_ash` | large | 10.0 m | 494/500 | 130/130 | 148 -> 41 |
| `gen_bush` | medium | 1.1 m | 148/150 (76 + 72) | 60/60 (48 + 12) | 36 -> 6 |
| `gen_bush_berry` | medium | 0.9 m | 150/150 (56 + 94) | 60/60 (30 + 30) | 47 -> 15 |
| `gen_grass_tall` | small | 0.55 m | 6 (3 cards) | 4 (2 cards) | LOD2: 2 (1 card) |
| `gen_grass_dry` | small | 0.40 m | 6 | 4 | LOD2: 2 |
| `gen_grass_lush` | small | 0.35 m | 6 | 4 | LOD2: 2 |

Trees carry a 6-triangle billboard as their last tier. Bushes and grass do not: the `medium` and `small` classes are culled before a card would pay for itself.

GLB sizes run 60 to 62 KB for trees (all tiers plus impostor geometry), 22 KB for bushes, 5 KB for grass.

## Verified

- All 10 assets build, on budget, **one primitive per LOD**, which `check-props.mjs` requires
- `check-props.mjs` PASS: 40 texture layers of 256, zero orphaned PNGs. The gate needed no changes for shared layers, because it accumulates them into a `Set` keyed by path and dedupes for free. The 3 remaining decimator stalls are pre-existing scanned assets (`boulder_mossy`, `horsetail`, `log_birch_scan`)
- `check-sim`, `check-terrain`, `check-phase-a`, `check-water`, `check-water-shader`, `check-daynight`, `probe-popping` all pass
- Tier parity confirmed by rendering LOD0 and LOD1 from the same camera. Pine LOD1 at 130 triangles is visually the same tree as LOD0 at 482: same three whorls, same leader, same trunk length, same colour. It holds at the extreme too, with the bush carrying 36 cards down to 6

The comparison renderer is `tools/trees/compare-tiers.py`:

```
blender --background --factory-startup --python tools/trees/compare-tiers.py -- gen_pine gen_oak
```

It imports `build.py` as a module (importing runs nothing, guarded by `if __name__ == "__main__"`), walks each tier through the same finishing the real build applies, and renders each at 256px into `tmp/generated-props/compare/`. It is the only thing that catches a tier mismatch: an early LOD1 hit its budget exactly, at 100% of LOD0's total leaf area, and still rendered as two whorls with a bare leader. Nothing in the generator's own numbers could have caught that.

## Open problems

### LOD0 is sparse (the main one)

The tier machinery works, but the base mesh it faithfully reproduces is not good enough yet. The oak reads as a spindly sapling with a long bare trunk. Bushes read as weeds. The pine is the best of them and still thinner than it should be.

One fix was tried and reverted: weighting the branch-count cut toward deeper levels (`detail`, `detail^2`, `detail^3` for levels 0, 1, 2) on the theory that a primary limb draws more silhouette than a twig. The bisection simply solved for a different `detail` and landed on the same branch triangle count, so the oak rendered identically, while the higher level-0 floor cost pine's LOD1 twelve cards. **The sparseness is not in how the budget is split across branch levels.**

Where to look next, in rough order of promise:

- **Card size and aspect.** LOD0 pine already runs at 4.3x card growth while oak runs at 1.3x, and the oak is the one that looks bare. The baseline that growth is measured against is the preset's, which may simply be the wrong target for a 500-triangle tree.
- **Crown proportions.** Oak Medium has `length[0] = 37.24` for the trunk against `length[1] = 11.08` for branches, and `start[1] = 0.49`, so the crown occupies only the top half and reaches a third of the trunk's length out. That is fine at 2,460 cards and reads as bare at 148.
- **The leaf art itself.** 128x128 photographic sprays may be too small a spray. A denser, flatter, more stylized leaf mass would cover more per card, which is the N64 trick this whole approach is imitating.
- **More species presets.** Only Bush 2 and Bush 3 were tried for the medium class, and both are spindly.

### Texture provenance (blocks shipping, not the POC)

EZ-Tree is MIT and that covers its code. Its bark textures carry a sources README crediting texturecan.com and polyhaven. Its **leaf atlases and the grass tuft inside `grass.glb` carry no attribution anywhere in the package**, and they are photographic, so they did not originate with the project. Fine for a proof of concept, needs an answer before these reach a build anyone can play. Documented in the `layers.py` docstring. The fallback is painting four leaf sprays procedurally, which at 128x128 with an alpha cutout is tractable.

### Grass LOD tiers can never display

The `small` class has `lod0_m: 26` and `cull_m: 26`, so there is no range between LOD0 and the cull distance in which a lower tier could show. The three grass tiers are generated and built but tiers 1 and 2 are dead under the current ladder. Either widen the class ranges or stop generating the extra tiers.

### Smaller

- `wire_orphan_color` in `build.py` is now dead. Left in place pending a decision rather than deleted unasked.
- `public/props` git churn: 26 tracked `.obj`/`.mtl` files show as deleted, plus `tools/props/__pycache__` and `tools/props/manifest.json`.
- 133 of 164 manifest assets fail to build for missing sources (`tmp/placeholder-props/` is not fully present). Expected, unrelated to this work.
- `check-village.mjs` currently fails: 5 sites report no buildable arc for the great hall. `src/village/` is untouched by this work.

## Where to pick up

The LOD machinery is done and verified. The next session's job is LOD0 aesthetics, starting from the list above. Re-create the tier comparison renderer first, because triangle counts look correct even when the tree does not, and there is no other way to tell.
