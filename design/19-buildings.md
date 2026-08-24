## 19. Procedural buildings

> **Covers:** the Nordic building kit under `src/buildings/` -- the tile set, the geometry vocabulary, the grammar that combines them, and the LOD ladder.
> **Read this when:** adding a building part, a wall style, a kind, or a texture layer for one. Read the layer rule in §9 first; it decides whether your new texture is allowed to exist.

Skyrim-adjacent Nordic vernacular: log cabins, thatch huts, stocky timber, rough-hewn iron, small warped panes. Low-poly geometry wearing 128² textures, which is the same art direction as everything else here (§9) and not a separate look for buildings.

### The files

| File | Holds | Imports three.js |
|---|---|---|
| `src/buildings/tiles.js` | The pixel generators for all twelve building layers | no |
| `src/buildings/plan.js` | The grammar. Pure data: masses, walls, openings, attachments | **no** -- §1's porting rule |
| `src/buildings/parts.js` | The `Builder` and the geometry vocabulary | yes |
| `src/buildings/building.js` | `buildBuilding(plan, {detail})` -- the translation, deliberately thin | yes |
| `tools/buildings/imageops.mjs` | decode / crop / flip / heal the wrap / resample / grade / encode | no (node) |
| `tools/buildings/cut-tiles.mjs` | Cuts the seven shipped non-thatch PNGs from their sources | no (node) |
| `tools/props/extract-thatch.mjs` | Cuts the two shipped thatch PNGs out of the photograph | no (node) |

`plan.js` staying three-free is what makes `scripts/check-buildings.mjs` able to plan 1,200 buildings in half a millisecond each and assert every one, rather than sampling. The bugs in a grammar live in the combinations nobody thought to look at, so exhaustive coverage is the point.

`gen-building.html` + `src/gen-building-main.js` is the tuning bench, in the same family as `gen-fern.html` and `gen-tree.html`. It runs the **real** shared `DataArrayTexture` and the real `createPropMaterial()`, because the whole premise is that one array plus a per-vertex `texLayer` puts thatch, logs, stone and glass in one draw call, and a previewer faking that with four materials would be checking the thing that is not in question.

### Twelve layers, and the three that were refused

The layer registry and the reasoning live in `src/textures.js`. `TIMBER_HEWN`, `TIMBER_PLANK`, `THATCH`, `SHINGLE`, `ROOF_TILE`, `STONE`, `PLASTER`, `THATCH_FRINGE`, `GLASS`, plus three decal sheets, `IRON`, `RUNE` and `DOOR`. 12 × 64 KB = 768 KB, taking the array from 9 layers to 25 of the 256 §9 measured as available. Indices are **appended, never renumbered** -- a layer index is baked into every `texLayer` attribute already shipped, so renumbering is a silent re-skin of the whole library.

Refused under §9's rule that *a layer has to earn itself by reading as different at the distance it will be seen*:

- **Slate roof.** It is `SHINGLE` at a colder tint. At 128 px from the 15 m a roof is seen at, the shake pattern is what you read and hue is what names the material, and hue is free.
- **Chimney masonry.** It is `STONE`. Same rubble, same hands, same building. Dressed ashlar for a manor would be a new layer for a new building class, not a second version of this one.
- **Moss on thatch.** Not a texture: a per-vertex colour multiply driven by height above the eave and which way the slope faces. A moss layer would need a second blended pass, which means a second material, which splits the batch.

`ROOF_TILE` is the case that tests that rule rather than breaking it. A pantile differs from a shake in **shape** -- a row of half-circles against a row of rectangles -- and shape is exactly what survives 128 px from fifteen metres. No tint rounds a corner, so it cannot be a tinted `SHINGLE` the way slate can.

`DOOR` is the case where a layer *saves* triangles. It is one photographed leaf with its hinge straps and ring pull already on it, addressed 0..1 by island like the other decal sheets, so `doorway()` stopped emitting three doubled `IRON` decals when it landed: a door leaf costs 4 triangles instead of 16.

The moss photograph is used and is still not a layer. It is composited into `STONE`'s own crevices at cut time, steered by the pack's height and ambient-occlusion maps -- the only moss this renderer can afford is moss already baked into another material's texels.

Two decal sheets share the same `RepeatWrapping` array as the tiling layers. That is legal because wrap mode only bites outside the unit square and every island's UVs stay inside it, subject to two rules the gate enforces: a **4-texel transparent gutter** so bilinear cannot reach a neighbour, and **one material family per sheet**, because coarse mips average the whole layer and iron bleeding into iron is invisible where iron bleeding into a rune is not.

### What is a photograph and what is generated

Nine of the twelve layers ship as PNGs cut from photographs; `PLASTER`, `IRON` and `RUNE` are still generated, for want of a source. `IMAGE_LAYERS` patches each over its generator a few frames after load, the same arrangement `BARK` and `LEAVES` already have; the generated versions stay, because they are what is on screen until the fetch lands.

Two tools, sharing one pipeline in `tools/buildings/imageops.mjs` (`decode → heal the wrap → resample to 128 → grade → write`). `tools/props/extract-thatch.mjs` does the two thatch layers, which are a special case worth its own script; `tools/buildings/cut-tiles.mjs` does the other seven and carries the per-source reasoning for each crop, flip and grade.

The rule across all of them is **hybrid, not replacement**. A generated tile is a description of a material and a photograph is a sample of one: at 128 px the description wins on layout, because it knows exactly where a course line belongs, and loses badly on everything that is not layout. So where a tile's layout carries meaning the generator keeps it and the photograph supplies only the material -- `TIMBER_HEWN` is beam grain multiplied by generated two-course cylinder shading, and `THATCH` is straw with generated butt lines -- and where the photograph already has the right layout it is used whole.

Three things recur and are the whole value of the tools:

- **Which way up.** Row 0 of a shipped PNG is v = 0, which on a roof is the **eave** (there is no flip anywhere between the file and the sampler -- `flipY` is false on a `DataArrayTexture` and `UNPACK_FLIP_Y` does not apply to `texImage3D`). Every roof is photographed the way a roof is looked at, courses lapping toward the bottom of the frame, so every roof source is flipped on the way in. Unflipped, the shakes lap uphill: nothing looks wrong in an image viewer and nothing looks obviously wrong on the building either, it just sheds water into itself. Gated for `SHINGLE` and `THATCH` by measuring that the butt half of each course is brighter than the head half. Not gated for `ROOF_TILE`, where the direction is carried by the scallop's shape and the two halves measure 1.003 apart -- checked by eye instead, and the gate says so.
- **It cannot be tinted as shot.** Old thatch, slate, moss and pitch-tarred timber are all per-vertex colour *multiplies*, and a multiply only ever takes light away. Every tile is graded per channel onto the shared palette with a ceiling, so there is headroom in every direction. Per channel and not against one shared luminance, which is the obvious way to write it and leaves the source's cast exactly where it was.
- **It does not wrap.** Healed by cross-fade rather than by mirroring: mirroring puts an axis of symmetry down the tile, and once you have seen the butterfly you see it on every roof in the village. The band is dropped from one end and dissolved into the other, so the output's two edges are pixels that were genuinely adjacent in the source. Where the content has structure the crop has to respect it -- `TIMBER_PLANK` is cut groove-to-groove at exactly three boards, because a crop anywhere else either doubles a groove at the wrap or splits a board.

`STONE` is where the moss photograph goes. Where moss belongs is not a judgement call: moss grows where water sits, water sits in the joints, and the pack's height and ambient-occlusion maps mark the joints. Both are used, because height alone puts moss on any low stone and AO alone puts it in any shadow, while the product is specifically *low and enclosed*. The crevice mask is then blurred before use -- a joint at 128 px is one texel wide, and used raw it draws a green pen line around every stone instead of growth creeping out of one -- and multiplied by a low-frequency patch field, because a wall with moss in every joint and nowhere else reads as a diagram of a wall.

Thatch gets all three of those (1.24 in u and 4.00 in v before healing, 0.82 / 0.93 after) and then one more, which is why it keeps its own script. **It has no courses.** It was shot as a wall panel, so there is no butt line anywhere in it -- and the butt line is the only hard line real thatch has, combed rather than lapped, and most of what says "roof" instead of "hay bale". Added back procedurally, phase-varied per course so the four lines are not parallel.

**The fringe takes RGB from the photo and keeps the generated ALPHA.** There is no cut edge anywhere in the source -- it is a continuous field -- so the hanging profile has to be generated whichever way round you do it, and the generated one is already gated. What the photograph supplies is the straw the fringe is made of, which is exactly the half that has to match the roof it hangs off. This is why one script writes both files: a fringe cut from one straw field and a roof cut from another do not join at the eave.

### `TILE_METRES`: why nothing is UV-unwrapped

Every surface takes its UVs from world extents ÷ `TILE_METRES[layer]`. Two consequences, and they are the payoff:

- Texel density is constant across the whole kit without anyone deciding. A cottage wall and an inn wall get the same log courses per metre, which is most of what makes a procedural kit look authored rather than generated.
- Nothing is re-UV'd when a mass is resized. The previewer's sliders change extents freely and the texture simply covers more wall.

The numbers themselves are art direction, tuned by eye against a 1.75 m figure on the bench, not a spec.

### Conventions

Inherited from `src/village/shapes.js` and **not negotiable** -- the spur-path router depends on both:

- Everything sits on `y = 0` and is centred on XZ.
- **The front door is on local +Z.** The primary mass's long axis therefore runs along X, so its ridge does too and both gables face ±X, which is what leaves the +Z frontage a long eaves wall with room for a door and windows.

Two more, set here:

- **Wall V is measured in absolute world height.** That is what makes log courses meet at the corners, run level around the whole building, and stay level across a wing built at a different floor height. Measuring from each wall's own base is the classic way to get logs that step at every corner.
- **Roof V runs up the slope, U along the eave**, fixed by how `tileThatch` and `tileShingles` are drawn.
- **Row 0 of a tile buffer is `v = 0`, and so is row 0 of a shipped PNG.** `DataArrayTexture.flipY` is false and cannot be otherwise -- `UNPACK_FLIP_Y_WEBGL` does not apply to the `texImage3D` an array texture uploads with -- and `loadImageLayers` decodes through `drawImage`/`getImageData`, which is image order. There is no flip to compensate for anywhere in the chain. Believing there was mirrored every tile in `tiles.js` top to bottom: invisible on logs, plaster and rubble, and visible on the one tile whose entire content is a direction, the thatch fringe, which hung its ragged tips along the ridge and pressed its solid edge into the sky. `public/buildings/thatch_fringe.png` therefore looks upside down in an image viewer and is right on the roof.

### The Builder

`quad(a, b, c, d, opts)` is the whole vocabulary. `a→b` is the U axis, `a→d` is the V axis, and the outward normal falls out of the same ordering as `cross(b-a, d-a)` -- so a face that is textured right is also facing the right way, and there is one thing to get wrong instead of two.

**Why not `BoxGeometry` + `mergeGeometries()`:** box UVs run 0-1 *per face*, so a 4 m wall and a 0.2 m post would each get the texture exactly once and the wall's logs would be twenty times the size of the post's. Fixing that means rewriting every UV after the merge, at which point the geometry classes have bought nothing.

`box()` still takes a `skip` list and **nothing uses it**. Dropping the face buried in a wall used to look like free budget -- a timber frame is dozens of boxes and at 2 triangles a face the buried ones are a fifth of a building. What it actually bought was a mesh full of holes, visible from inside the building and through every roof valley, and it is why the kit is airtight-by-gate now instead of thrifty-by-hand.

`quad()` and `tri()` take `double`, which emits the back face **with the same UV frame** rather than a re-derived one. Re-winding `d→c→b→a` would reverse U and V with it, which mirrors a decal and hangs the thatch fringe upside down on its far side.

### Openings are never cut

A door or a window is a surround standing **proud** of the wall, with the leaf or the glass set inside it. Not a shortcut: cutting a hole leaves a boundary edge, and the collapse decimator refuses to collapse edges that border a hole -- which is exactly why the props stall at 896 → 544 triangles and never reach target. Keeping every wall a closed quad is what keeps LOD-by-re-generation available.

Glass is **opaque** by necessity (§7): alpha blending cannot be depth-sorted inside a batched draw call. Which is also what a small-paned window looks like from outside in daylight -- not a hole, a bright grey sheet with the sky in it.

### Airtight, and wound outwards

Every mesh the kit emits is a closed surface with outward normals. Both halves are gated, and they are **different properties** -- the second is the first one's blind spot.

- **Airtight**: over quantised positions, `count(a→b) === count(b→a)` for every directed edge. Deliberately *not* "every edge is shared by exactly two triangles", which is the rule everybody writes first and which this kit fails by design: it is a union of **interpenetrating solids** -- a chimney driven through a roof slope, a log end driven through a wall -- so an edge can legitimately be shared by four triangles where two shells touch along a line. Counting directions passes that, because each shell balances on its own. It also passes the back-to-back doubled quads that alpha-shaped parts are made of (fringe, ironwork), which the two-triangle rule rejects outright. What it still catches is every genuinely missing face.
- **Wound outwards**: signed volume by the divergence theorem. A shell wound inside out balances every edge just as neatly as a correct one and, under back-face culling, renders as exactly the same hole. Solid parts must come out positive; the honestly zero-thickness ones are declared as such rather than skipped. This is what found both slopes of every **z-ridged gable roof** facing down and inward -- the along-axis runs +x for an x-ridge and +z for a z-ridge, but the across-axis it is crossed with does not change sign to match, so the handedness of (along, across) flips with the ridge axis and the winding has to flip back.

Three consequences in the kit, all of them things that used to be a hole you could see the inside of the building through:

- **A roof plane is a slab, not a quad**: top surface, plank soffit, and a plumb-cut band of the covering around all four edges. The thickness is **vertical rather than normal to the slope**, which is both cheaper and more correct -- a roof is rafters and covering cut plumb at the eave. A dark soffit is also most of what makes an overhang read as depth instead of as a thick outline. 0.30 m for thatch, 0.11 m for shingle.
- **An outshut needs `leanEnd()`**: its side walls stop at its own eave while its roof carries on up to the main wall, leaving a right triangle of open sky at each end that no amount of double-siding the roof would have closed, because the face was never there.
- **A cross-wing's roof has to oversail far enough to actually reach the roof it abuts.** On a T-plan the main roof only rises above the wing's ridge within `(mainRidge − wingRidge)/rise × runHalf` of the main ridge line; stop the wing roof at its own gable wall plus a normal verge and it ends in mid-air short of that. That notch is not a missing face either -- the two roofs simply have to overlap, and `wingVerge()` works out by how much. It returns nothing for an L-plan, where the wing meets the main slope sideways and the overhang already carries it inside.

A porch is a boarded deck on a rubble footing down to the plinth bottom, not a floating rectangle, for the same reason.

### The grammar

Footprint-first and additive. One or two axis-aligned masses; **room count is not a knob**, it falls out of floor area. What the caller picks is a *kind*, and the kind sets area, height, and which shapes and styles are legal -- a whitelist rather than a weight table, because a half-timbered woodcutter's hut is not less likely, it is wrong.

| Kind | Area m² | Shapes | Styles |
|---|---|---|---|
| `hut` | 11-17 | single, outshut | log, stave |
| `cottage` | 22-34 | single, outshut, ell, wing | all four |
| `longhouse` | 48-72 | single, outshut, wing | log, stave |
| `inn` | 58-84 | ell, tee, wing | halfTimber, stoneBase, stave |

Wall styles: **horizontal log courses** (with alternating notched log ends at the corners -- the silhouette a flat texture alone cannot supply), **vertical stave/plank** between corner posts, **half-timber** with plaster infill and a proud frame, **stone base with timber above**. One style per building; mixing them makes it read as several buildings shoved together.

Openings land in **bays**, so a long wall gets more windows rather than wider-spaced ones. A bay is skipped where another mass is behind it. Window density is weighted by side -- frontage 1.0, ends 0.62, back 0.4 -- because glass was expensive and nobody glazed the north gable to look at their own woodpile; that asymmetry is most of what gives a generated building a front.

**Terrain drives the attachments, not a style knob.** The floor goes at the highest footprint corner and the plinth reaches down to the lowest, so nothing floats and no doorsill is buried. Where the resulting drop is large enough, the plan raises steps and a porch. A village on a slope therefore grows porches and a village on the flat does not, for free and correctly.

The chimney rides a gable end, offset in from the verge so it visibly pierces the slope. Its base comes from `roofHeightAt()`, which `plan.js` exports precisely so `parts.js` and the gate are reading the same maths -- two copies would drift, and a chimney hovering four centimetres above its own thatch is invisible until someone stands under it.

### LOD by re-generation

Not decimation, for the boundary-edge reason above. Three tiers from the **same plan**, so they cannot drift out of agreement:

| Tier | Range (§5 `structure`) | Holds | Typical |
|---|---|---|---|
| detail 2 | to 60 m | everything: log ends, frames, ironwork, corbelled cap, porch posts | ~780 tris |
| detail 1 | to 170 m | massing, roof, gables, plinth, chimney, flat door and glass -- **plus the thatch fringe and the porch roof**, which are silhouette | ~190 tris |
| detail 0 | to the card | box and roof prism | ~70 tris |

The fringe stays at detail 1 against the general rule because dropping it would pop the outline of the roof at the LOD0 boundary, and four triangles is not worth that.

Measured over 240 buildings: mean 778 tris, worst 1,672 (`inn`), against §5's 1800 for the `structure` class and its 20 × 800 = 16k village allotment.

Closing the kit cost about 200 triangles and the worst case had to buy them back somewhere. It came out of the **window surround**, which was four overlapping boxes at 48 triangles and is now one mitred extruded ring at 32. An inn carries fifteen windows, so that alone was 720 triangles of a 1800 budget, most of it spent on faces buried inside the neighbouring stick -- and the ring has proper mitres rather than a lap joint.

### The gate

`scripts/check-buildings.mjs`, in the `npm run check` chain. Asserts, over every seed of every kind: the door faces +Z and sits on the front wall; no window overlaps the doorway or overflows its own wall; every chimney is seated on the roof surface and clears the ridge; the footprint hull closes and covers the plan area; nothing floats or buries its sill on a slope. Over the geometry: every tier carries the full attribute set (a mismatch makes the village merge return `null`, which is a silent disappearance rather than an error), no non-finite positions or UVs, no stray non-building `texLayer`, tiers strictly decreasing, the budget, and **airtight with positive enclosed volume**.

And over every part **on its own, at every orientation**, which is the sharper half. The whole-building pass reports "hut/2 detail 2 has an unpaired edge", which is a hole somewhere in nine hundred triangles; building one part into one `Builder` names the function with the bug. More usefully it covers orientations the grammar happens not to produce -- windows land on all four walls of every building, but a lean-to only ever gets the outshut directions a plan picks, and the winding of a part is exactly the thing that is right on one axis and inside out on another. Each part declares itself `solid` or `flat` and the volume has to agree. `gen-building.html` runs both probes live on the geometry that is on screen.

Over the tiles: the **seam score**, which is the wrap-edge step divided by the strongest interior step in the same axis. The baseline took three wrong answers to reach -- one interior pair (usually in a smooth region, so every deliberate line scores as a seam), the whole-tile mean (the tile's own hard lines drag it down, and an integer course count puts one of them exactly on the boundary), and the 95th percentile (a tile with four strong lines has them all above p95). The max is the right question: *is the boundary worse than the strongest line this tile already contains?* ≤ 1 means indistinguishable from the tile's own periodic detail.

The shipped PNGs face the same metric, and that is not belt-and-braces: `loadImageLayers` overwrites a gated tile with an ungated one a few frames after load, so without this a PNG that is the wrong size, upside down, or non-tiling replaces a tile that was none of those and nothing anywhere reports it. The upload resolves, and the roof is simply wrong. So each shipped file is re-decoded and asserted on its own terms: 128², RGBA, seam ≤ 1.05 on both axes for the eight tiling ones; `door.png` exempt from the seam (it is island-addressed, so its edges are a doorframe and are meant to be a step) but required to be fully opaque, since `alphaTest` would punch holes in a leaf that carried the source's cutout alpha; every one of them kept below the multiply ceiling so the vertex tint has headroom; and the two lapped roofs measured for direction.

**The seam metric must include alpha.** The RGB-only version passed a fringe tile whose straw indices were not taken mod the straw count, so the last straw blended toward a phantom neighbour and the eave got one wrongly-cut straw every repeat. Alpha is where that tile keeps its shape, and the check that ignored it saw nothing.

Related: a value-noise lattice is periodic with period exactly 1, so it must **always** be sampled as `f(u, v)`, never `f(u*1.6, v*0.35)`. Anisotropy goes in the lattice dimensions, not the argument scale. Getting this wrong put a bright line down five of these tiles at scores of 3.5 to 29.

### Open

- `PLASTER`, `IRON` and `RUNE` are still procedural, for want of a source. `PLASTER` can stay that way -- a wall's texture is not its silhouette, only texel scale matters, and that is a UV decision. The other two cannot, or not comfortably: alpha carries their shape, so the placeholder *is* the asset rather than a stand-in for it.
- `tools/props/extract-thatch.mjs` still carries its own copies of the decode/heal/resample helpers, which now live in `tools/buildings/imageops.mjs`. Two implementations of the same cross-fade is exactly how the fringe and the roof drift apart at the eave.
- `src/village/*` still generates its own vertex-coloured placeholder buildings and has not been migrated onto this kit. The old kit's architectural range is not a constraint on this one.
