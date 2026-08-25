## 19. Procedural buildings

> **Covers:** the Nordic building kit under `src/buildings/` -- the tile set, the geometry vocabulary, the grammar that combines them, and the LOD ladder.
> **Read this when:** adding a building part, a wall style, a kind, or a texture layer for one. Read the layer rule in §9 first; it decides whether your new texture is allowed to exist.

Skyrim-adjacent Nordic vernacular: log cabins, thatch huts, stocky timber, rough-hewn iron, small warped panes. Low-poly geometry wearing 128² textures, which is the same art direction as everything else here (§9) and not a separate look for buildings.

### The files

| File | Holds | Imports three.js |
|---|---|---|
| `src/buildings/tiles.js` | The pixel generators for all thirteen building layers | no |
| `src/buildings/plan.js` | The grammar. Pure data: masses, walls, openings, attachments | **no** -- §1's porting rule |
| `src/buildings/parts.js` | The `Builder` and the geometry vocabulary | yes |
| `src/buildings/building.js` | `buildBuilding(plan, {detail})` -- the translation, deliberately thin | yes |
| `tools/buildings/imageops.mjs` | decode / crop / flip / heal the wrap / resample / grade / encode | no (node) |
| `tools/buildings/cut-tiles.mjs` | Cuts the eight shipped non-thatch PNGs from their sources | no (node) |
| `tools/props/extract-thatch.mjs` | Cuts the two shipped thatch PNGs out of the photograph | no (node) |

`plan.js` staying three-free is what makes `scripts/check-buildings.mjs` able to plan 1,200 buildings in half a millisecond each and assert every one, rather than sampling. The bugs in a grammar live in the combinations nobody thought to look at, so exhaustive coverage is the point.

`gen-building.html` + `src/gen-building-main.js` is the tuning bench, in the same family as `gen-fern.html` and `gen-tree.html`. It runs the **real** shared `DataArrayTexture` and the real `createPropMaterial()`, because the whole premise is that one array plus a per-vertex `texLayer` puts thatch, logs, stone and glass in one draw call, and a previewer faking that with four materials would be checking the thing that is not in question.

### Thirteen layers, and the three that were refused

The layer registry and the reasoning live in `src/textures.js`. `TIMBER_BEAM`, `TIMBER_HEWN`, `TIMBER_PLANK`, `THATCH`, `SHINGLE`, `ROOF_TILE`, `STONE`, `PLASTER`, `THATCH_FRINGE`, `GLASS`, plus three decal sheets, `IRON`, `RUNE` and `DOOR`. 13 × 64 KB = 832 KB, taking the array from 9 layers to 26 of the 256 §9 measured as available. Indices are **appended, never renumbered** -- a layer index is baked into every `texLayer` attribute already shipped, so renumbering is a silent re-skin of the whole library.

Refused under §9's rule that *a layer has to earn itself by reading as different at the distance it will be seen*:

- **Slate roof.** It is `SHINGLE` at a colder tint. At 128 px from the 15 m a roof is seen at, the shake pattern is what you read and hue is what names the material, and hue is free.
- **Chimney masonry.** It is `STONE`. Same rubble, same hands, same building. Dressed ashlar for a manor would be a new layer for a new building class, not a second version of this one.
- **Moss on thatch.** Not a texture: a per-vertex colour multiply driven by height above the eave and which way the slope faces. A moss layer would need a second blended pass, which means a second material, which splits the batch.

`ROOF_TILE` is the case that tests that rule rather than breaking it. A pantile differs from a shake in **shape** -- a row of half-circles against a row of rectangles -- and shape is exactly what survives 128 px from fifteen metres. No tint rounds a corner, so it cannot be a tinted `SHINGLE` the way slate can.

**Three timber layers, and each one is a different tool mark.** `TIMBER_BEAM` is a raw log -- bark-adjacent, checked, two courses to the tile -- and it is what every `prism()` member and every log wall is lit by. `TIMBER_HEWN` is rough-sawn boarding at three boards to the tile: porch decks, soffits, wide planking. `TIMBER_PLANK` is the finished sawn board: staves, shutters, window surrounds. That is not three tints of one material, it is the difference between what an axe leaves, what a pit saw leaves and what a plane leaves, and it reads at arm's length because the rounded members it wraps are exactly the parts a player stands next to. A plank tile stretched over a five-sided log is the one combination that makes the rounding look like a mistake rather than a shape.

`DOOR` is the case where a layer *saves* triangles. It is one photographed leaf with its hinge straps and ring pull already on it, addressed 0..1 by island like the other decal sheets, so `doorway()` stopped emitting three doubled `IRON` decals when it landed: a door leaf costs 4 triangles instead of 16.

The moss photograph is used and is still not a layer. It is composited into `STONE`'s own crevices at cut time, steered by the pack's height and ambient-occlusion maps -- the only moss this renderer can afford is moss already baked into another material's texels.

Two decal sheets share the same `RepeatWrapping` array as the tiling layers. That is legal because wrap mode only bites outside the unit square and every island's UVs stay inside it, subject to two rules the gate enforces: a **4-texel transparent gutter** so bilinear cannot reach a neighbour, and **one material family per sheet**, because coarse mips average the whole layer and iron bleeding into iron is invisible where iron bleeding into a rune is not.

### What is a photograph and what is generated

Ten of the thirteen layers ship as PNGs cut from photographs; `PLASTER`, `IRON` and `RUNE` are still generated, for want of a source. `IMAGE_LAYERS` patches each over its generator a few frames after load, the same arrangement `BARK` and `LEAVES` already have; the generated versions stay, because they are what is on screen until the fetch lands.

Two tools, sharing one pipeline in `tools/buildings/imageops.mjs` (`decode → heal the wrap → resample to 128 → grade → write`). `tools/props/extract-thatch.mjs` does the two thatch layers, which are a special case worth its own script; `tools/buildings/cut-tiles.mjs` does the other eight and carries the per-source reasoning for each crop, flip and grade.

The rule across all of them is **hybrid, not replacement**. A generated tile is a description of a material and a photograph is a sample of one: at 128 px the description wins on layout, because it knows exactly where a course line belongs, and loses badly on everything that is not layout. So where a tile's layout carries meaning the generator keeps it and the photograph supplies only the material -- `TIMBER_BEAM` is beam grain multiplied by generated two-course cylinder shading, `TIMBER_HEWN` is the same grain under generated board grooves, and `THATCH` is straw with generated butt lines -- and where the photograph already has the right layout it is used whole.

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

### Rough-hewn: why the timber is not boxes

**A box says "extruded", and no texture argues it out of that, because silhouette is decided before the sampler is reached.** Every timber in a Nordic building was shaped with an axe against the grain of a tree that was never straight, and the single thing that says so is that its section is not a rectangle. So the second primitive is `prism(a, b, section)`: a closed loop swept along an axis, with `roughSection(n, hu, hv, seed)` producing the loop -- `n` between 5 and 7 drawn from the seed, `round` blending the bounding rectangle toward the ellipse inscribed in it, and each corner's radius and angle jittered. `member()` wraps the two for the common case. 4n−4 triangles against a box's 12, so a six-sided member is 20.

Four things about it are load-bearing:

- **Corner angles are jittered by less than half their own spacing**, so two corners can never cross and the loop stays wound anticlockwise. `prism()`'s outward winding and both cap fans depend on that, and a crossed section is an inside-out shell that still balances every edge -- the exact failure the volume half of the gate exists for.
- **`sectionEnd` must be the same loop scaled, never a re-roll.** It is what lets a chimney batter inward as it rises without stacking a second solid on the first. Re-rolling the angles twists the facets down the length, and a twisted post reads as a modelling error rather than as a hand-shaped one.
- **`uAlongAxis` swaps U and V.** The beam tile is a photograph of a log lying down, so its grain runs along U; a standing post's grain runs along its own axis. Swapping is how one tile serves both without a second layer. `vWorldY` then measures the sweep in absolute world height, so a standing post courses in with the wall behind it exactly as `box()` does -- and must be **off** for anything sweeping horizontally, where it would hold V constant down the whole length and collapse the texture to a line.
- **Jitter comes from a stateless `hash(seed, i)`, not a running PRNG.** A running generator re-rolls the entire village the day somebody inserts a part in the middle of a function, which is a silent, total, invisible-in-review change to every building.

Where it is spent is the whole argument, because it is not spent evenly: **log ends at the corners of a cabin, the eave against the sky, the door surround you walk through, the porch posts you stand between.** Those are seen at eye level from a metre away and they are the entire silhouette of the style. A window surround is one *swept ring* rather than four members -- an n-gon section carried around a mitred rectangular path, 8n triangles, no caps and no boundary, so it is airtight by construction and its corners are real mitres rather than a lap joint.

The one thing that is not a swept prism is a **slab**: a plinth, a doorstep, a porch deck. `roughSlab()` is a box whose top arris (and bottom, where it is not buried) is broken by a chamfer drawn **per corner and per axis** -- the four corners of a split stone are never broken by the same amount, and a uniform 45 degrees is just a smaller machine -- with the shoulder heights jittered on the same terms, which is what turns a chamfer into a break. 28 triangles against a box's 12, or 20 when the underside is in the ground. Its corner ring is wound **clockwise seen from above**, because a side quad's normal is (ring tangent) × up: anticlockwise gives four inward faces and a shell that balances every edge while being inside out, which is precisely the pair of properties the gate below exists to separate.

A slab is where this is worth the most per triangle, because it is the one part of a building the player's **feet** are level with.

Two things a slab needs that are not chamfers:

- **A stair flight stands on stringers.** Each tread overhangs the one below by a whole tread depth, so a stack of tread boxes is correct in section and obviously floating from the side -- which is the angle anyone walking up to a door sees it from. Two raking timber members, just outboard of the treads and overlapping them by 2 cm so there is no seam between the two.
- **Masses interpenetrate, so their plinths do too.** An ell butts its wing *into* the main range, which on flat ground gives two plinth ledges at exactly the same height over the strip where they overlap: coincident coplanar faces, which z-fight and crawl as the head moves. Each mass lifts its plinth by `id × 3 mm` -- invisible in rubble, and it decides the depth test once and for all. **Upward, never downward**: down opens a hairline between the ledge and the wall standing on it.

Everything here is gated at `detail >= 2`. Detail 1 keeps the massing and the flat panels, so the rounding costs nothing past 60 m.

### Openings are never cut

A door or a window is a surround standing **proud** of the wall, with the leaf or the glass set inside it. Not a shortcut: cutting a hole leaves a boundary edge, and the collapse decimator refuses to collapse edges that border a hole -- which is exactly why the props stall at 896 → 544 triangles and never reach target. Keeping every wall a closed quad is what keeps LOD-by-re-generation available.

Glass is **opaque** by necessity (§7): alpha blending cannot be depth-sorted inside a batched draw call. Which is also what a small-paned window looks like from outside in daylight -- not a hole, a bright grey sheet with the sky in it.

### Airtight, and wound outwards

Every mesh the kit emits is a closed surface with outward normals. Both halves are gated, and they are **different properties** -- the second is the first one's blind spot.

- **Airtight**: over quantised positions, `count(a→b) === count(b→a)` for every directed edge. Deliberately *not* "every edge is shared by exactly two triangles", which is the rule everybody writes first and which this kit fails by design: it is a union of **interpenetrating solids** -- a chimney driven through a roof slope, a log end driven through a wall -- so an edge can legitimately be shared by four triangles where two shells touch along a line. Counting directions passes that, because each shell balances on its own. It also passes the back-to-back doubled quads that alpha-shaped parts are made of (fringe, ironwork), which the two-triangle rule rejects outright. What it still catches is every genuinely missing face.
- **Wound outwards**: signed volume by the divergence theorem. A shell wound inside out balances every edge just as neatly as a correct one and, under back-face culling, renders as exactly the same hole. Solid parts must come out positive; the honestly zero-thickness ones are declared as such rather than skipped. This is what found both slopes of every **z-ridged gable roof** facing down and inward -- the along-axis runs +x for an x-ridge and +z for a z-ridge, but the across-axis it is crossed with does not change sign to match, so the handedness of (along, across) flips with the ridge axis and the winding has to flip back.

Three consequences in the kit, all of them things that used to be a hole you could see the inside of the building through:

- **A roof plane is a slab, not a quad**: top surface, plank soffit, and a plumb-cut band of the covering around all four edges. The thickness is **vertical rather than normal to the slope**, which is both cheaper and more correct -- a roof is rafters and covering cut plumb at the eave. A dark soffit is also most of what makes an overhang read as depth instead of as a thick outline. 0.46 m for thatch, 0.14 m for shingle, 0.15 m for pantile. That band is two or three stacked rings rather than one, bulged out on a half-sine, so a thatch eave is a rolled edge instead of a knife cut -- a combed thatch eave is a metre-thick bundle and is the fattest thing on the building. The bulge is applied at **30% strength at the ridge corners**: pushing all four corners out by the full amount drives each slope through the other above the ridge.
- **An outshut needs `leanEnd()`**: its side walls stop at its own eave while its roof carries on up to the main wall, leaving a right triangle of open sky at each end that no amount of double-siding the roof would have closed, because the face was never there.
- **A cross-wing's roof has to oversail far enough to actually reach the roof it abuts.** On a T-plan the main roof only rises above the wing's ridge within `(mainRidge − wingRidge)/rise × runHalf` of the main ridge line; stop the wing roof at its own gable wall plus a normal verge and it ends in mid-air short of that. That notch is not a missing face either -- the two roofs simply have to overlap, and `wingVerge()` works out by how much. It returns nothing for an L-plan, where the wing meets the main slope sideways and the overhang already carries it inside.

A porch is a boarded deck on a rubble footing down to the plinth bottom, not a floating rectangle, for the same reason.

**Neither gate can see a blade, and that is their known blind spot.** A back-to-back doubled quad is airtight, has honestly zero volume, is *declared* as having zero volume, and passes -- and it is still a face with no thickness. The stone-base offset course was one: 6 cm of ledge standing out of the wall at the top of the masonry with nothing between its two sides, so from anywhere near its own height it was a paper edge on a stone building. It is a swept member now. The rule the gates cannot state is that **doubled quads are for things that are genuinely sheets** -- a fringe, an iron strap, a shutter leaf, a pane of glass -- and anything the eye reads as *stone* or *timber* needs a section.

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
| detail 2 | to 60 m | everything: hewn members, log ends, rounded eave, frames, ironwork, corbelled cap, porch posts, broken slab arrises, stair stringers | ~1,210 tris |
| detail 1 | to 170 m | massing, roof, gables, plinth, chimney, flat door and glass -- **plus the thatch fringe and the porch roof**, which are silhouette | ~190 tris |
| detail 0 | to the card | box and roof prism | ~70 tris |

The fringe stays at detail 1 against the general rule because dropping it would pop the outline of the roof at the LOD0 boundary, and four triangles is not worth that.

Measured over 1,200 buildings: **mean 1,211 tris, worst 2,472** (`inn`), against §5's 2,500 for the `structure` class and its 20 × 1,210 = 24k village allotment. The worst case is a genuine outlier -- the next eleven buildings sit at 2,280-2,372 and only one seed in 1,200 clears 2,400 -- which leaves the ceiling with **28 triangles of headroom on the tail, and nothing on it at all for the next feature**.

**Those two §5 numbers were raised once, for the rounding, and are not to be raised again casually.** Boxes measured 766 mean / 1,660 worst against 1800 and 16k. Hewn prisms are +40% and the trade was made deliberately: the silhouette is what the whole style rests on, it is spent only at detail 2, and the ladder means it is spent on the handful of buildings actually within 60 m. The next thing that wants triangles takes them from somewhere else.

The two places the increase was bought back are worth knowing, because both were pure waste rather than detail:

- **A half-timbered wall owns the post at its start corner only.** Closing the bay loop at both ends put two independently jittered posts inside every corner of every mass -- eight buried, interpenetrating members on an inn, 160 triangles of nothing.
- **The window surround is one swept ring**, 40 triangles at five sides, where four overlapping boxes were 48 with eight faces per stick buried inside its neighbour. An inn carries fifteen windows, so the surround is the single most expensive thing on the building either way; this way it is also round.

### The gate

`scripts/check-buildings.mjs`, in the `npm run check` chain. Asserts, over every seed of every kind: the door faces +Z and sits on the front wall; no window overlaps the doorway or overflows its own wall; every chimney is seated on the roof surface and clears the ridge; the footprint hull closes and covers the plan area; nothing floats or buries its sill on a slope. Over the geometry: every tier carries the full attribute set (a mismatch makes the village merge return `null`, which is a silent disappearance rather than an error), no non-finite positions or UVs, no stray non-building `texLayer`, tiers strictly decreasing, the budget, and **airtight with positive enclosed volume**.

And over every part **on its own, at every orientation**, which is the sharper half. The whole-building pass reports "hut/2 detail 2 has an unpaired edge", which is a hole somewhere in nine hundred triangles; building one part into one `Builder` names the function with the bug. More usefully it covers orientations the grammar happens not to produce -- windows land on all four walls of every building, but a lean-to only ever gets the outshut directions a plan picks, and the winding of a part is exactly the thing that is right on one axis and inside out on another. Each part declares itself `solid` or `flat` and the volume has to agree. `gen-building.html` runs both probes live on the geometry that is on screen.

Over the tiles: the **seam score**, which is the wrap-edge step divided by the strongest interior step in the same axis. The baseline took three wrong answers to reach -- one interior pair (usually in a smooth region, so every deliberate line scores as a seam), the whole-tile mean (the tile's own hard lines drag it down, and an integer course count puts one of them exactly on the boundary), and the 95th percentile (a tile with four strong lines has them all above p95). The max is the right question: *is the boundary worse than the strongest line this tile already contains?* ≤ 1 means indistinguishable from the tile's own periodic detail.

The shipped PNGs face the same metric, and that is not belt-and-braces: `loadImageLayers` overwrites a gated tile with an ungated one a few frames after load, so without this a PNG that is the wrong size, upside down, or non-tiling replaces a tile that was none of those and nothing anywhere reports it. The upload resolves, and the roof is simply wrong. So each shipped file is re-decoded and asserted on its own terms: 128², RGBA, seam ≤ 1.05 on both axes for the nine tiling ones; `door.png` exempt from the seam (it is island-addressed, so its edges are a doorframe and are meant to be a step) but required to be fully opaque, since `alphaTest` would punch holes in a leaf that carried the source's cutout alpha; every one of them kept below the multiply ceiling so the vertex tint has headroom; and the two lapped roofs measured for direction.

**The seam metric must include alpha.** The RGB-only version passed a fringe tile whose straw indices were not taken mod the straw count, so the last straw blended toward a phantom neighbour and the eave got one wrongly-cut straw every repeat. Alpha is where that tile keeps its shape, and the check that ignored it saw nothing.

Related: a value-noise lattice is periodic with period exactly 1, so it must **always** be sampled as `f(u, v)`, never `f(u*1.6, v*0.35)`. Anisotropy goes in the lattice dimensions, not the argument scale. Getting this wrong put a bright line down five of these tiles at scores of 3.5 to 29.

### Open

- `PLASTER`, `IRON` and `RUNE` are still procedural, for want of a source. `PLASTER` can stay that way -- a wall's texture is not its silhouette, only texel scale matters, and that is a UV decision. The other two cannot, or not comfortably: alpha carries their shape, so the placeholder *is* the asset rather than a stand-in for it.
- `tools/props/extract-thatch.mjs` still carries its own copies of the decode/heal/resample helpers, which now live in `tools/buildings/imageops.mjs`. Two implementations of the same cross-fade is exactly how the fringe and the roof drift apart at the eave.
- `src/village/*` still generates its own vertex-coloured placeholder buildings and has not been migrated onto this kit. The old kit's architectural range is not a constraint on this one.
