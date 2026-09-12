# §27 -- the creature pipeline

Wildlife and people, made from a sentence. One bench, `/gen-creature`, runs the whole chain: a candidate image, a mesh and texture generated from it, a skeleton, and animation clips -- each stage previewed before the next is paid for.

This is the first pipeline in the tree that **spends real money per click**, and that fact shapes every design decision below far more than the rendering does.

## Why a vendor at all

The tree already has two home-grown asset pipelines and both stay:

- `tools/characters/` -- chromakey a generated sheet, loft a mesh from the silhouette, rig, animate. Good for humanoids seen at village distance, and free per asset after the image.
- `tools/fauna/` -- the same idea for fish, where a lofted profile IS the animal.

Both work because their subjects are approximately extrusions of a silhouette. A fox is not. The loft has no answer for four legs that occlude each other, for antlers, or for a muzzle that is a different width than the skull. Rather than grow the loft into a general reconstruction engine, this pipeline hands that one job -- silhouette to volume -- to a vendor and keeps everything else local.

## Why Tripo and not Meshy

Meshy was researched first and rejected on one hard fact: **its rigging and animation API is biped-only.** There is no `rig_type` parameter, no quadruped entries in the API changelog through 2026-08-28, and every animation preview in its library is served under `biped/`. Its webapp guide claims "humanoid and quadruped characters", which contradicts its own API reference; the API is the thing being integrated, so the API wins. A pipeline that cannot rig a fox does not solve the problem that motivated it.

Tripo exposes seven skeleton families -- `biped`, `quadruped`, `hexapod`, `octopod`, `avian`, `serpentine`, `aquatic` -- which covers the whole intended roster.

**Tripo's animation library is nevertheless lopsided**, and this is the pipeline's one real gap. Bipeds get eleven presets on the v2.5 rig model; quadruped, hexapod and octopod get a single `walk` each, serpentine and aquatic a single `march`, and **avian gets none at all**. So Tripo is used for the mesh and the *skeleton*, and everything past the first gait is authored here. That is workable because `tools/characters/animations.mjs` already writes clips as functions of a 0..1 phase against a fixed bone hierarchy, and Tripo's `spec: 'mixamo'` yields Mixamo-compatible bone names -- the same names those clips are already written against, with no mapping table in between.

`PRESETS` in `tools/creatures/tripo.mjs` is the honest record of that coverage, including the empty `avian` array. `scripts/check-creatures.mjs` asserts the biped/quadruped asymmetry rather than papering over it, so the day it changes, the gate says so.

## The 128px texture is the gate, not the polycount

This is the load-bearing idea of the whole section.

Everything in this world ships with a 128px texture. Triangle budget is a solved problem -- `face_limit` handles it, and `src/budget.js` says what the number has to be. The unsolved problem is that **a mesh's UV layout decides whether its texture survives being 128 pixels wide**, and nothing about the triangle count tells you that.

A high-fidelity model that is decimated down to budget gets its UVs re-solved after the fact, and an auto-unwrap of a decimated surface produces a scatter of many small islands. At 128px each island is a handful of texels; the smallest ones round away to nothing, and bilinear filtering bleeds neighbouring islands across every seam because there is no room left for a gutter. The full-size texture looks fine. The shipped one is mush.

**P1 Smart Mesh (`P1-20260311`) is the default for this reason.** It generates native quad topology with coherent edge flow rather than decimating a dense surface, so the unwrap yields fewer and larger islands, and those survive the downrez. It is also all-inclusive on price where H3 stacks surcharges, which makes the default the cheap option too.

The bench is built around checking this and nothing else is as important: `#texRow` draws the same texture into a 256px and a 128px canvas side by side, `image-rendering: pixelated` so the browser's smoothing does not flatter it. **Judge a candidate on the small panel** -- and the preview mesh wears the 128px version by default for the same reason, because a creature evaluated under a 2k texture is a creature evaluated as it will never ship. Clicking either panel puts that resolution on the model, so the comparison is one click rather than a rebuild. A third panel shows Tripo's roughness map (the G channel of its metallicRoughness texture) at 128px when the mesh was generated with `pbr` on, which is the default: it is the only per-region shininess signal in the pipeline, and the panel is where to judge whether a fish's scales or a shieldmaiden's mail separate from the matte parts at the shipping resolution. H3 (`v3.1-20260211`) stays selectable for the case where a creature genuinely needs the fidelity and someone has looked at both panels and decided.

## The stages

| # | stage | vendor | cost | writes |
|---|---|---|---|---|
| 1 | species | -- | free | (form state) |
| 2 | candidate image | OpenRouter, FLUX.2 Klein 4B | ~$0.015 | `candidates/<n>.png` |
| 3 | mesh + texture | Tripo image-to-model | $0.40--$0.55 | `meshes/<n>.glb\|.fbx` |
| 3b | LOD ladder + card cross | **ours** (`src/mesh/decimate.js`, `src/props/impostor.js`) | free | `meshes/<n>-lod<k>.glb` |
| 4a | rig-check | Tripo | **free** | -- |
| 4b | rig | Tripo | $0.25 | `rig.glb` |
| 5 | animations | Tripo retarget | $0.10 each | `anim-<preset>.glb` |

A full creature -- P1 mesh with texture, a rig, three clips -- is **105 credits, $1.05**. `check-creatures.mjs` pins that number, so a change to any price or default that moves it fails the gate rather than surprising the next invoice.

### Stage 2: the image is not a character sheet

`tools/creatures/creature-prompt.mjs` is deliberately not `tools/characters/sheet-prompt.mjs` and must not drift toward it. Those images get chroma-keyed and measured; this one gets handed whole to a reconstruction model that paints a texture from it. Three consequences:

- **Neutral light-grey background, never `#FF00FF`.** A saturated key bleeds a magenta rim into the fur of the shipped texture. The gate asserts no prompt asks for a chroma key.
- **Flat shadowless light.** Any cast shadow or rim light bakes into base colour and then fights `src/lighting.js` forever. Not undoable downstream.
- **Three-quarter view, not orthographic front.** Reconstruction wants depth; the chromakey loft wanted a flat measurable profile.

The pose clause is selected by rig type, because **a limb tucked against the torso is the documented cause of a bad auto-rig** -- the solver cannot find a leg it cannot see. Each clause asks for limbs held clear of the body; the serpentine clause, having no limbs to separate, forbids the body coiling across itself instead, which is the same failure in a different shape.

### Stage 3: quad topology, and what the +5 credits buy

H3 charges 5 extra credits for `quad: true`. **P1 rejects the field outright** (code 1004) rather than charging nothing for it, because quads are what it generates and there is nothing to ask for. `createMeshTask` omits `quad` for P1 for that reason -- `REJECTS_QUAD` is the list. The server's own error text says quad is supported only by `P2-20260801`; that is wrong, `v3.1` and `v2.5` both accept it, and P1 is the sole refusal.

**glTF has no quad primitive.** Mode 4 is TRIANGLES and there is no other option, so whichever model produced it, `mesh.glb` arrives triangulated and no runtime anywhere in this repo will ever see a quad. Paying for quad mode does not buy a different file format. It buys a different *arrangement* of the triangles inside the same format: a quad-generated mesh is triangle pairs that were coplanar quads a moment earlier, laid out in edge loops that follow the form.

That arrangement is not cosmetic, and it matters for exactly one reason -- the one the previous section is about. Edge loops that follow the form unwrap into few large UV islands. Scattered triangles unwrap into many small ones. At 128px the second kind is mush.

`estimateQuadFraction()` in `src/mesh/decimate.js` measures what survived: it greedily pairs adjacent triangles whose face normals agree to within `cosTol` and reports the fraction claimed. It is a lower bound and it is ambiguous on flat regions -- on a plane every neighbour is coplanar, so a flat grid reads ~0.91 rather than 1.0 while genuinely-independent planar quads read exactly 1.0. As a comparator between two meshes of the same creature it is still the right instrument, and the bench prints it next to the island count where the comparison is easy.

**Every Tripo mesh is drawn with backface culling, in the benches and in the world.** Tripo writes `doubleSided: true` and GLTFLoader honours it, but a Tripo creature's thin parts -- fins above all -- are closed slabs whose two sheets sit 0--0.1 mm apart wearing different texture islands, so drawn double-sided they z-fight at every distance. The meshes are consistently wound (0--4 conflicting edges in ~750 on the fish), so culling removes exactly the far sheet from any viewpoint. `src/tripo-culling.js` is the one place that rule lives; every loader of Tripo output calls it, `check-creatures.mjs` asserts they import it, and a world placement that needs double-sided has to say why at its call site. Welding near-coincident vertices does not help: half of a Tripo mesh's vertices are UV-seam splits at the exact same position, and the two sheets' triangulations do not line up, so no weld threshold merges them.

**Practically: pay it on H3, or use P1 and do not think about it.** P1 is the default and its price is all-inclusive, so the surcharge only ever arises when someone has deliberately chosen H3 for fidelity -- and having made that choice, refusing the 5 credits gives up the property that made H3 worth choosing. Five credits is $0.05 against a $1.05 creature.

### Stage 3b: the LOD ladder is ours

Tripo will also sell retopology. Buying it would put the one step that can be iterated for free behind a per-attempt charge, so `src/mesh/decimate.js` does it instead: quadric error metric, half-edge collapse, plain arrays in and out, no dependency on three so the same code runs in the bench tab and under `scripts/check-decimate.mjs` in node.

**The one rule: no vertex attribute is ever interpolated or invented.** Collapses are half-edge, so the surviving vertex stays exactly where it was and every position, UV and normal in the output is one the input already had. The gate asserts it directly -- zero foreign UVs -- because a decimator that computes new texture coordinates is one that can put a corner in the wrong island, and that is the 128px failure arriving by a different road.

Geometric boundary vertices are pinned. **UV seam vertices are not.** A welded point on a seam carries several *wedges*, one corner per island meeting there. A collapse `u -> v` is legal when a consistent map from u's wedges to v's corners can be read off the faces that contain both u and v, and each rewritten corner takes its mapped one. Because the correspondence is sourced from shared faces, every rewritten corner moves along an edge of a triangle the atlas already had: islands shrink, and no triangle can jump to unrelated texture. Where no consistent map exists -- a junction where three or more islands meet, whose wedges the shared faces never all mention -- the collapse is refused. `seamCollapse: false` restores the pinned behaviour and exists so the gate can measure the difference between them.

three's `SimplifyModifier` was read and rejected. It carries a `uv` attribute through, but `computeEdgeCollapseCost` is `edgelength * curvature` with no attribute term at all, and its border-cost branch is commented out. On a textured mesh it will happily collapse across a seam.

**The atlas floor is the ceiling, and it is a measurement.** Preserving the atlas cannot take a mesh below roughly one triangle per UV island, however the algorithm is tuned. The bench reports that floor directly -- it runs one throwaway `decimate(mesh, 1, { uvMode: 'preserve' })` and prints where it stopped -- next to the island count, the pinned fraction and the unremovable-face floor, so a stalled tier is explained before it is run rather than after.

The first real Tripo mesh, a P1 red fox at a 4000 face limit, came back at **487 triangles in 112 UV islands**, with 240 of its 250 welded points on a seam. That is not the closed organic surface with a single unwrap the vendor is sold as: 33 islands are one triangle, 24 are two, 19 are three, so **76 of the 112 are three triangles or fewer**. Wedge collapses take it from 485 triangles (0.4% off) to 291 (40% off), zero foreign UVs, islands 112 -> 105. **291 is the fox's atlas floor**, and no target below it is reachable with the atlas intact.

**`uvMode` is the way past it.** `preserve` is the behaviour above. `stretch` collapses the same edges `preserve` refuses, but every surviving corner keeps the UV it already had while its position moves: the UV triangle is an input UV triangle verbatim, only the 3D face under it changed shape, so the island's texels stretch over the new face and the tier still wears the original texture. Reduction is then bounded by geometry alone, and the price is texture sliding by one edge length per collapse -- on a 128px atlas seen at LOD distance, invisible. `drop` gives the atlas up entirely; the output carries no `uv` attribute, because two corners of one output triangle can come from unrelated islands and a `uv` slot filled anyway would look usable. In its place each output vertex carries a `sampleUvs` entry, where that vertex sat in the *original* atlas, which the bench reads the source texture at and bakes into vertex colours. `stretch` and `drop` produce identical geometry (the roster probe agrees to four decimals), so `drop` buys nothing but the loss of the texture; it stays as the fallback for a mesh that arrives without one. `auto`, what the bench uses, runs `preserve` first and switches to `stretch` only when preserving demonstrably missed the target; the mode that actually ran is in `stats.uvMode` and in the bench's tier table.

On the fox, `auto` at targets 244 / 122 / 49 returns **243 / 121 / 49**, every tier textured, zero foreign UVs. A sub-50-triangle fox exists.

**Detached pieces are deleted, not collapsed, and pillows fold.** The fen-dragon (1848 triangles, 775 islands) is 46 geometric pieces (`piecesOf`: faces joined by a manifold edge or an unpinned point): the body, loose four-face tetrahedra, and its crest, which is a comb of *pillows* -- two faces back to back on the same three points, chained along the ridge by shared vertices -- on a few percent of the surface between them. Under `preserve` the tetrahedra's points are all seam-locked; and a pillow's base edge has one vertex opposite it, not two, so the classic link condition (exactly two shared neighbours) made every pillow immortal, and 58 of the coarsest tier's 184 triangles were ridge scales the size of a texel. Two things fix it. The link condition now asks that the shared neighbours be exactly the vertices opposite the edge in the faces containing it -- two on a manifold edge, one on a pillow -- so a pillow's tip folds in and takes both faces with it (a collapse that would leave no face at all is the one refusal). And `dropIslands` (on by default) prices deleting a whole piece at `(area + feature weight) * (diagonal / 2)^2`, pushes that into the same heap as the collapses, and removes the piece when it comes up cheaper than the next collapse; the largest piece is never a candidate. With deletion off the 10% tier is 86 triangles of spines standing on a 98-triangle body -- a row of teeth with no dragon under it. With both, `auto` at 924 / 462 / 185 leaves 7, 2 and 1 pieces (17, 5 and 1 of them deleted whole, the rest folded away), the coarsest tier has 9 triangles under 0.05% of the surface instead of 58, and every one of its 184 triangles is on the body: a dragon with wings, tail, head and legs. `analyzeMesh` reports the piece count and how many faces sit off the main one; the bench prints those next to the island count and, per tier, pieces in, pieces left and how many went whole.

**Reaching fifty triangles is not the hard part; still being a fox at fifty is.** What kills the ears is not the quadric being wrong, it is the quadric being *area-weighted*: an ear carries about one percent of the surface, so every collapse inside it is priced at one percent of a collapse across the flank and the ears are gone long before the torso has given anything up. Small features are cheap in proportion to how small they are, which is the opposite of what a silhouette wants. The second cause is that a plane quadric is blind along its own plane, which is exactly the direction a thin spike runs -- sliding an ear tip down to its base barely leaves any of the ear's own planes.

One term fixes both. Each point gets a *point* quadric, `w * |x - p|^2` in the same 10-float form, so it adds into the plane quadric and rides through every collapse; its weight is `featureWeight * importance * meanMass`, where `meanMass` is one point's share of the whole surface and so does **not** scale with the point's own area. Every point then resists dragging by the same absolute amount and `importance` decides how much it cares. `importance` is `turn + extreme`: `turn = 1 - |sum of area-weighted face normals| / area` is exactly zero on a flat patch of any size and near one both at an ear tip, where the normals fan, and in the notch *between* the ears, where they oppose -- lopping the ears off and welding the gap shut are the same failure seen twice. `extreme` is one for any point that is furthest along one of 64 Fibonacci-sphere directions, which is the definition of a silhouette point: nose, ear tips, toes, tail, the ridge of the back, nothing mid-flank. Global extrema, not local ones -- marking every point that beats its graph neighbours dilutes the signal to nothing (coarsest-tier IoU 0.770 against 0.790, maxDev 181mm against 153mm). Positions are never moved, so the one rule holds.

`scripts/probe-decimate-profile.mjs` is the measurement: it rasterises the source and each tier orthographically over 32 views (16 azimuths x elevations 0 and 25 degrees) at a **fixed frame**, so a shrunken silhouette cannot be rescaled back to full size and scored perfect. It reports IoU and **maxDev**, the worst symmetric one-sided gap in millimetres on a creature normalised to one metre tall -- symmetric, so a lopped ear and a filled notch both register. Over the whole creature roster (19 meshes, the bench's own 50/25/10% ladder, `stretch` mode with piece deletion on), the coarsest tier goes from **IoU 0.810 / maxDev 170mm at weight 0 to 0.828 / 109mm at weight 1**; across all tiers, 0.894 / 110mm to 0.907 / 64mm. The weight curve is a broad plateau from about 0.5 to 1.5 and `FEATURE_WEIGHT = 1` sits in the middle of it, so the figure is not load-bearing; 32 to 256 directions all land inside each other's noise. The term has a cost the silhouette score does not see: on the dragon at 184 triangles it spends the budget on claws, wingtips and jaw at the torso's expense, and at weight 0 the torso is rounder but the head flattens, the claws go and the worst silhouette gap grows from 106mm to 189mm. `preserve` mode improves too, but its numbers are not comparable -- it frequently stalls well above the target, which flatters any silhouette score.

Visually, on the fox at 46 triangles: with the term off the ear region is entirely missing and the front legs are largely gone; with it on the ears are there and the legs are solid. **The notch between the ears still fills in.** A saddle is neither a local maximum nor a minimum in any direction, so the extremal test cannot see it and only `turn` weights it -- and at 46 triangles there may be no vertex left to hold it open. `check-decimate.mjs` gates the mechanism on a fixture whose answer is known by construction: a coarse ball with two finely-tessellated cone ears grafted in, decimated to 40 triangles, must still reach both ear tips -- and must lose them at `featureWeight: 0`, at the same triangle count, so the check names what it is guarding.

**The plane quadric also cannot see triangle size or shape.** It prices every collapse across a flat patch at zero, whatever the triangle's size, so on a Tripo creature the big regular triangles of the back go as readily as the tiny ones on the snout, and it says nothing about the triangles a collapse leaves, so the back ends up a tangle of 3:1 and 4:1 slivers under a stretched texture while the snout and paws stay dense. Two more terms, both knobs in the bench's LOD box: a **size** term, `sizeWeight * meanMass` as a point quadric on every point, flat or not, which accumulates through collapses so the price of moving a vertex grows with how much surface has already folded into it and the cheapest collapse is always in the region coarsened least; and a **shape** term that multiplies the surface error by `(quality before / quality after) ^ shapeWeight` of the worst triangle the collapse reshapes, mean-ratio quality, relative rather than absolute because the eared ball's ears are slivers by construction and an absolute penalty made fixing them the cheapest thing on the mesh. The feature term rides in its own quadric added outside the multiplier, so it stays absolute. Both terms compete with the feature term on the same fixture, since a feature *is* small triangles: from `sizeWeight` 0.25 up the size term outbids it, and at `shapeWeight` 2 the eared ball loses one tip at 40 triangles. The shipping defaults are `SIZE_WEIGHT` 10 and `SHAPE_WEIGHT` 1, chosen by eye on the bench, where the fox at the 25% tier is a regular lattice everywhere and reads far better than any smaller weight; the price is paid at the 10% tier, where the size term wins outright and the fox loses its ears and its legs become stubs, and the eared ball at 40 triangles reaches 0.81 / 0.90 of its tips instead of 1.00 / 1.00. Over the pinned 19-creature roster at the coarsest tier, the silhouette score says the same thing: both terms off gives IoU 0.831 / maxDev 111mm with mean quality 0.617, p90 aspect 8.6:1 and 46% of triangles worse than 3:1; `sizeWeight` 0.05 gives 0.824 / 126mm at quality 0.671, p90 6.5:1, 39%; the default 10 gives 0.727 / 181mm at quality 0.746, p90 4.9:1, 24.5%. The score measures the coarsest tier, which is where a distant creature is a few pixels tall and the lattice cannot be seen anyway; the gate only asks the defaults to reach three quarters of both ears.

A quad term was tried and removed: pairing each face with the one across its longest edge when they lie within 18 degrees, and multiplying the cost of any collapse that leaves half a quad standing. A half-edge collapse reshapes every face around the vertex it removes, so the quads next to a "diagonal" collapse are distorted rather than orphaned and the penalty never bites; re-pairing after each collapse did not change that. Measured on five creatures at every tier the surviving clear-cut-quad fraction was the same with the term at 0, 3 and 10, and it cost silhouette. Keeping quads as quads needs a quad operator -- diagonal collapse with edge rotations, or poly-chord removal -- not a price on a triangle collapse.

Welding harder does not help and eventually hurts. Decimating the fox's geometry to 49 triangles reaches it at every tolerance from the default (`1e-6` of the bounding diagonal) up to 0.5%; at 1% it overshoots to 43, and at 2% it *stalls at 101* with 42 points locked, because fusing across a gap makes non-manifold edges that then pin themselves. The blocker was never positional duplication. The bench exposes the tolerance as a percentage of the bounding diagonal anyway, defaulting to the hair-thin value.

H3 with `smart_low_poly` (+10 credits, H3-only -- Tripo rejects it on P1) is the other lever: it retopologises and re-unwraps rather than decimating what P1 emitted, so it should arrive with a coarser atlas and a higher floor to begin with. The bench has a checkbox for it next to the model selector.

This repo's own props hit the ceiling for two different reasons, neither of which is the fox's:

| mesh | tris | islands | pinned | reached, asked 50% |
|---|---|---|---|---|
| `gen_oak_LOD0` | 494 | 2 | 88% | 28% |
| `tree_cracked_dead_LOD0` | 500 | 120 | 95% | 2% |

The oak is open surfaces -- leaf cards, an open trunk -- so almost every vertex is a geometric boundary, which stays pinned. The dead tree is atlas-mapped with roughly an island per face. Both are already-baked Blender LODs, measured before seam collapses existed.

Tiers are decimated from the tier above rather than from the original, so tier 2's vertices are a subset of tier 1's and swapping between them does not pop.

**A ladder belongs to the mesh candidate it was decimated from**, not to whichever candidate happens to be picked. The bench has a *selected* candidate as well as a picked one -- picking is what rigs and ships, selecting is what section 4 operates on -- so two candidates from the same image can have their ladders built and compared without committing to either. `saveLod` files each tier under the source candidate's stem and records its triangle count in `state.json`, which is how the table lists a saved ladder without opening every glb to count faces. Swapping between the source mesh and any of its tiers holds the camera where it was: a comparison whose viewpoint moves between the two frames is not one, and the eye reads the reframing as the change.

**The bottom rung is not a mesh.** Below about fifty triangles the silhouette is the whole of what reads, and the cheapest honest way to draw a silhouette is to photograph it: `bakeCardCross` in `gen-creature-main.js` takes two orthographic captures -- one along -Z, one along -X -- and hangs them on two crossed quads. **Four triangles, two 128px textures**, which is the same asset shape `src/props/impostor.js` already ships for ferns and whose pure pixel helpers it reuses. Captured at `SUPERSAMPLE` and boxed down in JS rather than rendered straight at 128, because an alpha-tested cutout rendered at its final size has a binary one-texel edge that every mip afterwards guesses at; then `dilate` pushes colour into the transparent margin, because bilinear filtering at the silhouette blends *toward* unwritten texels and an unwritten texel is transparent black. The bake rig is impostor.js's, with `BAKE_ROCK_BOUNCE` for the ground term rather than the near-black canopy value -- a fox has no shaded interior, and baked against a canopy bounce its underside comes out a black wedge. The key light rides each capture's own azimuth so no left-right terminator is burned into a card that gets seen from both sides.

The preview and the exported copy of a card carry the same bytes through different textures. Three uploads the raw array as-is, so what is on screen is exact; `GLTFExporter` can only serialise an image a canvas can draw, and a canvas backing store is premultiplied, which zeroes the colour of every fully transparent texel -- exactly the gutter `dilate` just wrote. The exported glb therefore loses the gutter and the preview keeps it, which is the right way round: the glb is for looking at, and the shipping card is re-photographed from the mesh by `bakeImpostor` into the prop atlas, dilating there.

### Stage 4: rig-check first, always

`POST /v3/animations/rig-check` costs nothing and returns `riggable` plus a recommended `rig_type`. It is the only way to learn that a mesh will not take a skeleton without paying 25 credits to find out. The bench offers it as its own non-orange button and writes Tripo's suggestion back into the rig-type selector.

`rigType: 'none'` is a real answer, not a gap. A butterfly wants two textured planes on a hinge -- `gen-butterfly.html` already does that better and cheaper than a rigged solid mesh would -- and a frog is small enough that a hop is a whole-body transform.

**The skeleton comes back sound and the NAMES on it come back wrong, and only the names matter.** Measured on the red fox with `scripts/probe-rig.mjs`, which prints each joint's name beside where that joint actually sits on the animal: the hierarchy is correct -- root, pelvis, spine, chest, neck, head, front legs off the chest, hind legs off the pelvis, tail off the root -- but the labels are shuffled. The fox's spine is called `0_Left_Limb_1`, its chest `Head_0`, its front-left shoulder `Spine_0`, and all four legs are unnamed `bone_9` through `bone_29`. Rigging the same mesh twice produces different labels, so this is a guess being re-rolled, not a convention.

**Retargeting matches by name, so wrong names are a paid no-op.** `preset:quadruped:walk` on that rig drives **7 of 36 bones**: the pelvis, the two bones it thinks are limbs (the spine and the chest), and the tail. Every leg is frozen at its rest rotation for the whole 2.6s clip. Worse, the two mis-named body bones are held **98 and 95 degrees off their rest pose** for the entire clip -- a constant offset, not a gait -- which folds the fox's front half down until both front paws are driven 7cm below the ground plane. What it looks like is an animal walking on its tail with its body dragged behind, which is what it is.

So **the presets are not usable for quadrupeds**, and buying more of them will not help: the failure is upstream of the clip. Renaming the bones locally cannot fix it either -- `createRetargetTask` posts a rig *task id*, so Tripo animates the skeleton it stored, not the file we hold, and our names never reach it.

What is left is to animate the rig ourselves, which is free per creature and already half-built for humanoids in `tools/characters/animations.mjs`. It needs anatomy read off the geometry rather than off the labels, which is `probe-rig.mjs`'s second column: a chain tip in the bottom fifth of the mesh that dropped further than it travelled sideways is a foot; the highest free tip is the head; the widest gap along the body axis -- taken from the joints' own covariance, since a creature can be authored at any yaw -- splits front feet from hind. That inference gets the fox's four feet, head and tail exactly right.

The bench's **bone names** checkbox draws the same labels over the preview, because a skeleton helper renders every bone as an identical white stick and which bone is which is the whole question.

## The spend model

The project's standing rule is that external API dollars are a separate budget from tokens and never get spent without a human deciding. That rule is implemented, not just documented:

- **Nothing fires on its own.** No retry loop, no auto-advance between stages, no batch. Each stage is one explicit click.
- **The price is on the button face**, computed by `estimateCredits` -- pure arithmetic, no network -- before the click. It lives beside the request builders in `tripo.mjs` so a cost-changing parameter cannot be added without the estimate landing in the same diff, and the gate pins the resulting table against Tripo's published prices.
- **Orange means it charges a card.** `button.spend` in `gen-creature.html`. `rig-check` is not orange.
- **The ledger sums server-reported costs only**, never client estimates -- what the page shows is what was actually billed.
- **`waitForTask` has a hard timeout and no retry.** A stuck task is something to look at, not to silently resubmit; a retry loop here spends money per iteration.

## State on disk survives a restart

Everything lands under `tools/creatures/work/<id>/` (gitignored -- these are working sources; the bake step is what writes `public/`):

```
candidates/<n>.png       every generated candidate image
source.png               the picked one -- the single image every Tripo step reads
meshes/<n>.glb|.fbx      every generated mesh, in the container Tripo sent
meshes/<n>-preview.png   Tripo's own render of it
meshes/<n>-lod<k>.glb    LOD tiers, decimated locally from that mesh
mesh.glb|.fbx            a copy of the picked mesh -- what the bench reads
rig.glb                  skeleton bound to the mesh
anim-<preset>.glb        one file per retargeted clip
state.json               task ids, credits, picks
```

**The container is read off the bytes, never assumed.** `quad: true` makes Tripo deliver FBX rather than glTF, because glTF has no quads -- and only on models that accept the flag, so a P1 run (where it is stripped) and an H3 run with identical parameters come back in different containers. `containerOf()` in `workspace.mjs` sniffs the magic before naming the file, so a candidate is `1.fbx` when that is what arrived; writing it blind to `.glb` surfaced much later, in GLTFLoader, as `Unexpected token 'K'` on the FBX header. The bench picks its loader from the extension. Rigging is unaffected either way: it is driven by the task id, and Tripo re-derives from its own copy.

**Nothing paid for is ever overwritten.** Images and meshes are both numbered candidates; the bench lists them and a pick copies one into the fixed name the next stage reads. Images are cheap enough to want several of, so the bench lets generations queue -- the button goes dead for a second and then takes another click, while meshes stay strictly one at a time at 50 credits apiece. Concurrent image writes mean the slot number cannot come from `state.candidates.length`: `saveCandidate` *claims* it on disk with an exclusive write, so two requests that pick the same number cannot both win it. An image can be deleted from the gallery (the only destructive control on the page, and the only one that asks first); `source.png` is a copy rather than a link, so deleting the picked candidate leaves the Tripo input intact and only clears the pick. `state.tasks[step]` holds the *current* handle only and is overwritten by the next run of that step, so it is not a record -- `state.taskLog` is, appending every task id the account was ever charged for whether or not a pick still points at it.

**A Tripo task id is the only handle on work already paid for.** `charge()` in `workspace.mjs` writes it the moment the task is created, *before* the wait, so a dev-server restart mid-generation loses the poll and not the purchase. For the same reason every output is downloaded to disk in the request that observed success: Tripo's result URLs are CDN links that expire, and there is no task-history endpoint (see below) -- a lost id is 50 credits that cannot be re-fetched.

Picking a mesh moves `tasks.mesh` with it. Rigging is driven by the task id rather than by the file, so a pick that left it behind would rig a different mesh than the one on screen.

The bench's stage buttons gate on `/__creature-assets`, which reads that directory, so a reload mid-pipeline resumes where it stopped rather than restarting.

## Where the pieces live

```
tools/creatures/tripo.mjs            v3 API client: upload, mesh, rig-check, rig, retarget, poll, and the credit table
tools/creatures/creature-prompt.mjs  the image prompt and its per-rig-type pose clause
tools/creatures/creature-roster.mjs  the starter roster (15 creatures)
tools/creatures/workspace.mjs        disk layout, the library index, the prompt store, the four orchestrated steps
src/mesh/decimate.js                 the LOD decimator -- three-free, runs in the tab and in node
src/props/impostor.js                the card bake's pixel helpers, shared with the fern and rock impostors
gen-creature.html                    the bench
src/gen-creature-main.js             its page logic, library, LOD ladder, card bake and 3D preview
scripts/check-creatures.mjs          the pipeline gate -- network-free, spends nothing
scripts/check-decimate.mjs           the decimator gate -- synthetic fixtures whose answers are known by construction
vite.config.js  creatureGen()        the dev-server endpoints; the only place the API keys are read
```

The bench's library overlay lists every creature the roster seeds *and* every directory under `work/`, with its prompt, its thumbnail, what stages exist for it and what it has cost so far. **The prompt is editable and saves into the creature's own `state.json`, not into the roster file.** That is what lets a creature be invented in the page and survive a reload without an edit to `creature-roster.mjs`; the roster stays a seed list, and promoting a settled creature into it is a separate, deliberate act.

**Nothing here reloads on save -- not the page, not the Node half.** Vite's HMR is off (see `server.hmr` in `vite.config.js`), and its restart-on-config-change rides the same disabled path and is deliberately not re-hung: a restart while a Tripo poll is open drops the connection on a job the vendor bills for regardless, and an agent saving `workspace.mjs` is enough to trigger one. So a change to any server-side file above needs a manual `npm run dev` restart, taken between generations rather than during one.

Orchestration lives in `workspace.mjs` rather than in the Vite plugin so a batch script can drive the same pipeline later without a browser. `creatureGen()` is a thin wrapper: it validates the creature id (`/^[a-z0-9-]+$/`) and returns JSON for every outcome including errors.

**The id validator is a security boundary, not tidiness.** It arrives from a query string and is concatenated into a filesystem path, and the dev server binds to the LAN (`server.host`). `../` in that string is an arbitrary file write. The gate tests it against traversal directly.

`TRIPO_API_KEY` and `OPENROUTER_API_KEY` live in `.env` (gitignored) and are read only by dev-server middleware. Neither ever reaches the browser.

## Adding a second vendor

The seam is `tools/creatures/tripo.mjs`. It exports a small surface -- `uploadImage`, `createMeshTask`, `createRigTask`, `createRetargetTask`, `waitForTask`, `estimateCredits` -- and `workspace.mjs` is the only caller. A Meshy client implementing the same surface would slot in behind a model selector, at the cost of losing non-biped rigging for creatures generated through it. Nothing else in the tree imports the vendor client.

## What the live API actually answers

Tripo's published docs are inconsistent about the base URL, showing both `api.tripo3d.ai/v2/openapi/...` and `openapi.tripo3d.ai/v3`, and the developer portal is a JS shell that a fetch tool cannot read. The paths below were settled by probing the live API instead. Every probe was free: upload costs nothing, and the existence checks POSTed an empty body, which fails argument validation before a chargeable task is created.

| what | v3 path | notes |
| --- | --- | --- |
| upload | `POST /v3/files` | returns `data.file_token`, prefixed `file_` |
| mesh | `POST /v3/generation/image-to-model` | |
| rig check | `POST /v3/animations/rig-check` | |
| rig | `POST /v3/animations/rig` | |
| retarget | `POST /v3/animations/retarget` | |
| task poll | `GET /v3/tasks/{id}` | |
| balance | `GET /v3/account/balance` | free; `{ balance, frozen }` in credits |

**The image goes in a nested `file` object** -- `{ file: { type: 'png', file_token } }`. A top-level `file_token` is not rejected, it is ignored, and the request fails as "file is required for image_to_model", which reads like the upload broke rather than like a wrong field name. The animation endpoints are the opposite shape: `input` is a bare task-id string, and nesting it there fails instead. No outer `type` field is needed anywhere; the path already names the operation.

**v3 renamed both the upload route and its field.** v2 was `POST /v2/openapi/upload` returning `image_token`; anything written against v2 will 404 with code 4001 ("No endpoint found") and no HTML page to make the cause obvious. `/v3/upload`, `/v3/upload/sts`, `/v3/file/upload`, `/v3/files/upload`, `/v3/uploads`, `/v3/balance`, `/v3/user/balance` and bare `POST /v3/generation` all do not exist.

Server-allowed mesh models are `P1-20260311, P2-20260801, v2.5-20250123, v3.0-20250812, v3.1-20260211`; rig models are `v1.0-20240301, v2.5-20260210`. **`P2-20260801` exists and this pipeline does not use it** -- P1 is still the default for the native low-poly reason above, and P2's pricing and topology are unmeasured.

The wallet is the other thing a first run discovers. The bench reads `/v3/account/balance` at startup and says so in the panel, because an empty wallet and a broken pipeline are indistinguishable from inside a spend button.
