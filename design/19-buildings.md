## 19. Procedural buildings

> **Covers:** the Nordic building kit under `src/buildings/` -- the tile set, the geometry vocabulary, the grammar that combines them, and the LOD ladder.
> **Read this when:** adding a building part, a wall style, a kind, or a texture layer for one. Read the layer rule in §9 first; it decides whether your new texture is allowed to exist.

Skyrim-adjacent Nordic vernacular: log cabins, thatch huts, stocky timber, rough-hewn iron, small warped panes. Low-poly geometry wearing 128² textures, which is the same art direction as everything else here (§9) and not a separate look for buildings.

### The files

| File | Holds | Imports three.js |
|---|---|---|
| `src/buildings/tiles.js` | The pixel generators for all thirteen building layers | no |
| `src/buildings/plan.js` | The grammar. Pure data: masses, walls, openings, attachments | **no** -- §1's porting rule |
| `src/buildings/parts.js` | v1: the `Builder` and the geometry vocabulary | yes |
| `src/buildings/building.js` | v1: `buildBuilding(plan, {detail})` -- the translation, deliberately thin | yes |
| `src/buildings/v2/warp.js` | The displacement field and the per-building character | no |
| `src/buildings/v2/parts.js` | v2's vocabulary: what v1 draws, subdivided enough to bend | yes |
| `src/buildings/v2/building.js` | `buildBuilding2(plan, {detail, strength, character, smoothAngle})` | yes |
| `tools/buildings/imageops.mjs` | decode / crop / flip / heal the wrap / resample / grade / encode | no (node) |
| `tools/buildings/cut-tiles.mjs` | Cuts the eight shipped non-thatch PNGs from their sources | no (node) |
| `tools/props/extract-thatch.mjs` | Cuts the two shipped thatch PNGs out of the photograph | no (node) |

`plan.js` staying three-free is what makes `scripts/check-buildings.mjs` able to plan 1,200 buildings in half a millisecond each and assert every one, rather than sampling. The bugs in a grammar live in the combinations nobody thought to look at, so exhaustive coverage is the point.

**v2 is the geometry layer; v1 is kept as the straight control.** Both build the same `plan.js` output -- the grammar, the styles, the bays and the terrain response are shared and unchanged, which is the whole reason v2 is a second geometry layer and not a second generator. v1 stays because "is the crooked version better" needs a "than what", and because its gate passing is what says the warp did not break something that used to work.

`gen-building.html` and `gen-building-v2.html` are the tuning benches, in the same family as `gen-fern.html` and `gen-tree.html`. They run the **real** shared `DataArrayTexture` and the real `createPropMaterial()`, because the whole premise is that one array plus a per-vertex `texLayer` puts thatch, logs, stone and glass in one draw call, and a previewer faking that with four materials would be checking the thing that is not in question. The v2 bench adds a master **strength** slider that reaches 0 -- the straight building, on the same page -- per-term multipliers so a building that looks wrong can be traced to the term that did it, and a `vs straight` mode that stands the two side by side.

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

Every *surface* takes its UVs from world extents ÷ `TILE_METRES[layer]`. Two consequences, and they are the payoff:

- Texel density is constant across the whole kit without anyone deciding. A cottage wall and an inn wall get the same log courses per metre, which is most of what makes a procedural kit look authored rather than generated.
- Nothing is re-UV'd when a mass is resized. The previewer's sliders change extents freely and the texture simply covers more wall.

The numbers themselves are art direction, tuned by eye against a 1.75 m figure on the bench, not a spec.

**The exception is anything that is an object rather than a piece of surface**, which takes a whole number of tiles fitted to its own rectangle instead -- `fitUV(layer, w, h)`, rounding `w ÷ TILE_METRES` to at least 1. A pane, a shutter leaf, a window's flat LOD1 stand-in: each one is a thing with edges, and world-addressed UVs cut the tile wherever the object happened to land, so two shutters on the same wall wore two different crops of the same board and a warped pane sampled a diagonal slice of glass. Fitting keeps texel density approximately right -- it is rounding, not stretching, so the error is bounded by half a tile over the object -- and buys the tile lining up with the edges of the thing wearing it. Walls are emphatically *not* fitted: absolute world height is the whole reason log courses run level around a corner (see Conventions), and fitting a wall would step them at every one.

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

Three consequences in the kit, each of them a place where two parts have to meet along a line and used to fail to:

- **A roof is a zero-thickness sheet, and the walls are cut to meet it.** Not a slab: a slab has a soffit, four edge bands and a mitre at every corner of every slope, and it buys one thing -- the eave reading as depth rather than as an outline. That thing is bought more cheaply by the parts that hang off the sheet. The thatch fringe is a skirt off the eave line, an object with a front and a back, and it is silhouette against the sky where a soffit is a dark strip nobody is under. What the slab also bought was **bleedthrough**: a wall drawn to a flat top and a roof laid on it at a pitch leaves the wall's top corners standing through the covering, which was papered over by making the slab thick enough to hide them. The sheet cannot hide anything, so instead every roof exposes `heightAt(x, z)` -- an exact ray against the *triangles*, not an inversion of the formula they came from -- and every part that has to stop under the covering asks it.

  **Where the wall is split matters as much as what it is asked.** A covering is a chorded grid, so its surface is folded along every cell boundary and every split diagonal; a wall whose top edge is sampled at evenly spaced columns lays a straight chord across those folds, which is a slot of daylight on one side of a fold and a stab through the covering on the other. So the roof also answers `breaksAlong(x0, z0, x1, z1)` -- every parameter along a plan segment at which it folds, both slopes, because a gable end walks up one, over the ridge and down the other -- and the wall merges those with the columns the warp wanted. Two boundaries closer than 12 cm collapse, and **the highest survives**: first-wins loses the ridge to a diagonal 10 cm short of it and slices the peak off the gable, which is how that was found. Measured against the drawn mesh, a wall top follows the covering to within 1.6 cm before the 2.5 cm tuck, and the tuck exists only to absorb the warp: the field moves the wall's top vertex and the three corners of the roof triangle above it, metres away, by different amounts, so the covering lands a centimetre or two off the plane its own corners promised.

  **A post or a window ducks rather than being cut.** A wall has a top edge to shape; a corner post and a king post are single timbers, so `clearUnder(topAt, x, z, r)` takes the lowest covering over the post's own footprint rather than over its centre line, and the post stops there. A window is a rigid figure and cannot be shortened at all, so if its head, its frame or a splayed shutter would come out through the roof the whole unit slides *down* the wall until it fits, and is dropped only if that would cost it three quarters of its height. Over 1,200 buildings that moves 17.6% of windows, a median of 10 cm, and drops none.
- **`gableEnd()` and `leanEnd()` survive only at detail 0.** Above it a gable end is simply a wall whose top follows the roof, which is the same code path as every other wall and one seam fewer: the wall/gable joint was a place two independently drawn parts had to agree about a sloping line, and it is now a place where nothing has to agree because there is only one part. Detail 0 still needs them, because there the mass is a flat-topped box.
- **A cross-wing's roof has to oversail far enough to actually reach the roof it abuts.** On a T-plan the main roof only rises above the wing's ridge within `(mainRidge − wingRidge)/rise × runHalf` of the main ridge line; stop the wing roof at its own gable wall plus a normal verge and it ends in mid-air short of that. That notch is not a missing face either -- the two roofs simply have to overlap, and `wingVerge()` works out by how much. It returns nothing for an L-plan, where the wing meets the main slope sideways and the overhang already carries it inside.

A porch is a boarded deck on a rubble footing down to the plinth bottom, not a floating rectangle, for the same reason.

**Neither gate can see a blade, and that is their known blind spot.** A back-to-back doubled quad is airtight, has honestly zero volume, is *declared* as having zero volume, and passes -- and it is still a face with no thickness. The stone-base offset course was one: 6 cm of ledge standing out of the wall at the top of the masonry with nothing between its two sides, so from anywhere near its own height it was a paper edge on a stone building. It is a swept member now. The rule the gates cannot state is that **a sheet is only allowed where nothing has to read as thick** -- a fringe, an iron strap, a shutter leaf, a pane of glass -- and anything the eye reads as *stone* or *timber* needs a section.

The roof is the deliberate exception and it proves the rule rather than breaking it, because **the thing that has to read as thick is the eave, and the eave is not part of the sheet.** A metre of combed thatch is the fattest thing on a building and it is entirely carried by the fringe hanging off the eave line, which is an object with a front and a back. There was a swept roll along the ridge as well and it went, because it was never load-bearing: the two slopes share their ridge points bit for bit, so it hid no seam, and the ridge is the one line of a building that is already a hard silhouette against the sky -- the most expensive place in the kit to buy an edge that is legible without it. The plane between them is only ever seen face-on from below or in silhouette edge-on from the side, and edge-on it is behind its own fringe. The declaration in the gate is `sheet`, and a sheet has to come out at zero volume *or better* -- interpenetrating solids can push it positive, and there is nothing wrong with that; what it must never be is negative.

### Nothing is quite straight: the warp field

v1 was correct and generic. Straight lines, square corners, a chimney with a flange on it -- every part individually right and the whole thing reading as a kit rather than as a building somebody put up. v2's answer is **one displacement field over space**, applied to the finished vertex array as a post-pass, normals rebuilt after.

**The field is a pure function of position** -- `f(x,y,z) -> (x',y',z')`, continuous, deterministic, with no knowledge of which part it is bending. That one property is why it can be this large without breaking anything:

- **Airtightness survives exactly.** Two vertices that were coincident had the same input, so they get the same output and are still coincident. The directed-edge count is untouched. This is the whole reason it is a field over space rather than a per-part jitter: **per-part jitter has to be threaded through every seam by hand, and one of them is always missed.** Draw straight, warp once.
- **Winding survives**, as long as the displacement stays small against the local feature size -- which is what the gate's strength sweep past 1 is measuring.
- **UVs survive and are not warped.** They are computed from the *unwarped* geometry, so texel density stays uniform. Warping them too would smear the tile exactly where the geometry has become interesting.

**A building is warped as one object with one character, not as a pile of independently wobbly components.** `makeCharacter(seed, strength)` draws the personality once and every part takes it: the two noise octaves, the settle (a lean growing as `height^1.35`, so the eaves lean and the plinth does not), roof sag and buckle, ridge droop, eave reach and sway, how far this building's roof oversails at all, how much more it oversails at the ridge than at the eave, how the fringe is cut, chimney flare, window taper and tilt, shutter splay, post bow. That distinction is most of what separates *hand-built* from *noisy* -- a real crooked house is crooked in a consistent direction, because it settled that way. `strength` scales all of it at once and at 0 v2 builds exactly what v1 builds.

**What the field cannot do is why half of `parts.js` had to be rewritten.** A warp can only bend geometry that *has vertices to bend*. A wall drawn as one quad has four corners and no middle, so the field translates and shears it and cannot bow it. So v2's parts carry interior vertices v1's did not:

- **A roof plane is an `nu × nv` grid**, not a quad -- one to three columns along the eave by three rows up the slope, which is what "each roof piece needs two horizontal seams so it can buckle under the weight of the tiles" costs. Row displacement is explicit rather than left to the field: sag on a half-sine between eave and ridge, a wandering buckle on the interior rows, an **eave row that reaches out past its nominal overhang and sways along its length**, and the ridge drooping (or hogging, on a negative draw) on a half-sine along its own length. Its UVs are passed explicitly from the unwarped parameterisation, because letting `quad()` derive a frame per cell would step the tile at every seam once the cells stop being planar.
- **The ridge is shared by construction, not by agreement.** Two slopes meet along it and walk it in *opposite directions*, so anything applied there has to come out bit-identical from both sides or the roof opens along its spine. The ridge height is therefore a function of the roof's own droop and the position along the ridge and **nothing else** -- no per-slope seed reaches it -- and the row's along-axis coordinates are the same numbers in both slopes. The eave, which nothing has to agree with, is where the per-slope wobble lives.
- **The eave is not one line.** How far a slope oversails is drawn per building, how much *more* it oversails at the verge ends than in the middle is a second draw that can go either way (`vergeSplay`: positive throws the gable corners out, negative tucks them in), and the fringe hanging off it leans by a third (`rake`). Splay is applied only to **decorative** verges: a verge that `wingVerge()` computed is structural -- it is the overlap that closes a T-plan valley -- and scaling or splaying that one opens a hole.
- **Walls subdivide** into up to four evenly spaced columns so a long wall can bow instead of shearing, *plus* a column at every fold in the covering above them -- 6.6 columns on average and up to 14, which is what buys the top edge that actually meets the roof. The even columns are what the field wants and it does not care where they are; the folds are what the covering wants and it cares exactly. Four triangles a column is what the roof gave up its soffit to be able to afford here.
- **Posts and rails are segmented and bowed** by a `sin` that leaves both ends exactly where the caller put them -- a member whose ends have drifted is a member that has come out of its mortice.
- **A window is distorted as a rigid figure, not per vertex.** One taper and one rotation, both about the opening's own centre, applied to every point of the frame, the glass, the shutters and the ironwork through a single `W(across, up)`. Displacing the four corners independently is the obvious way to write it and it is wrong: an opening is the one thing on a building that was *made*, by someone with a square, and four independent corners read as melted rather than as settled. It can lean and it can be wider at the head than at the sill; it cannot be a trapezium with a kink in it. Below detail 2 the transform stays and only the ornament goes.
- **The chimney is one flared prism**: a four-corner section with each corner's jitter drawn per axis, scaled outward at the crown. v1's battered stack plus corbelled cap was 48 triangles and read as masonry catalogue; this is 12 and reads as a chimney somebody built.

The rounding of the section is `boxSection()` and **not** `roughSection(4, ...)`, which is a trap worth naming: `roughSection` places its points at evenly spaced *angles*, so at n=4 they land on the rectangle's edge midpoints and give a diamond, not a jittered box.

The measured cost of all this is roughly nothing, because the chimney, the window surrounds and then the roof slabs paid for it: **worst 2,532 against v1's 2,472, mean 1,360 against 1,211.** The sheet roof is what bought the last round -- full-length log walls, gable-end wall profiles and a king post under every gable all landed in the same pass and the mean still went *down*, because a slab roof was spending its triangles on a soffit nobody is under.

### Which edges are hard: `smoothNormals()`

Smooth shading is a **per-vertex** decision, made in the geometry. Not per object and not per material: the only material-level knob is `flatShading`, which is all-or-nothing across a batch that carries the entire village, so it could only ever answer the question wrong for most of it. What decides whether an edge looks like a crease is whether the two faces meeting there *share a vertex with one averaged normal* or each keep their own.

It costs **nothing** -- no triangles, no memory, no draw calls. `Builder.vertex()` already emits four fresh vertices per quad and never dedupes, so the vertices a smooth join needs already exist and are already paid for; the pass only overwrites numbers in the normal array. That is the same non-deduping that makes `computeVertexNormals()` safe here, read the other way round.

Two rules, and both are needed:

- **A crease angle**, 78° by default and exposed on the bench. Faces meeting at less than that share an averaged normal; past it they stay separate. A five-sided log's arrises are 72° apart and round into a cylinder; a box corner is 90° and stays an arris; the sawn end of a log meets its side at 90° and stays a cut face, which is the one that matters -- an all-smooth log has ends that look like melted wax.
- **A layer whitelist**, `SMOOTH_LAYERS` = the three timbers. Rounding is a claim about how a material was *shaped*, and it is true of a log and false of everything else here. Rubble, plaster, thatch and shingle are broken and lapped surfaces whose whole character is that the facets disagree; averaging them lights a chimney like an inflated balloon.

Grouping is by (layer, quantised position), so two parts that happen to touch only merge their shading if they are the same material -- a log wall meeting a stone plinth keeps its edge for free, without anyone listing the pair.

### The grammar

Footprint-first and additive. One or two axis-aligned masses; **room count is not a knob**, it falls out of floor area. What the caller picks is a *kind*, and the kind sets area, height, and which shapes and styles are legal -- a whitelist rather than a weight table, because a half-timbered woodcutter's hut is not less likely, it is wrong.

| Kind | Area m² | Shapes | Styles |
|---|---|---|---|
| `hut` | 11-17 | single, outshut | log, stave |
| `cottage` | 22-34 | single, outshut, ell, wing | all four |
| `longhouse` | 48-72 | single, outshut, wing | log, stave |
| `inn` | 58-84 | ell, tee, wing | halfTimber, stoneBase, stave |

Wall styles: **horizontal log courses**, **vertical stave/plank** between corner posts, **half-timber** with plaster infill and a proud frame, **stone base with timber above**.

The log wall is the one that changed shape. It used to be a flat quad with notched log *ends* stuck on at the corners, which is the silhouette a texture cannot supply -- and it was two decorative sticks per corner pretending to be a wall built of them. It is now the same swept member run the **whole length of the wall**, one per course, alternating which end sticks out past the corner. The sweep is inset so only 5 cm of each log stands proud of the wall plane, which is enough to break the corner and the eave line against the sky and not enough to swallow a window: the logs are 0.45 m through, so a centred sweep would bury every opening on the building. That inset is why detail-2 glass sits at half the frame depth rather than a third. One style per building; mixing them makes it read as several buildings shoved together.

Openings land in **bays**, so a long wall gets more windows rather than wider-spaced ones. A bay is skipped where another mass is behind it. Window density is weighted by side -- frontage 1.0, ends 0.62, back 0.4 -- because glass was expensive and nobody glazed the north gable to look at their own woodpile; that asymmetry is most of what gives a generated building a front.

**Terrain drives the attachments, not a style knob.** The floor goes at the highest footprint corner and the plinth reaches down to the lowest, so nothing floats and no doorsill is buried. Where the resulting drop is large enough, the plan raises steps and a porch. A village on a slope therefore grows porches and a village on the flat does not, for free and correctly.

The chimney rides a gable end, offset in from the verge so it visibly pierces the slope. Its base comes from `roofHeightAt()`, which `plan.js` exports precisely so `parts.js` and the gate are reading the same maths -- two copies would drift, and a chimney hovering four centimetres above its own thatch is invisible until someone stands under it.

### LOD by re-generation

Not decimation, for the boundary-edge reason above. Three tiers from the **same plan**, so they cannot drift out of agreement:

| Tier | Range (§5 `structure`) | Holds | Typical (v2) |
|---|---|---|---|
| detail 2 | to 60 m | everything: hewn members, full-length logs, roof grid with a hanging fringe, king posts, mitred frames, ironwork, splayed shutters, porch posts, broken slab arrises, stair stringers | ~1,360 tris |
| detail 1 | to 170 m | the massing and **the warp**, with the bevelling, rounding and 3D joinery gone: roof sheets at one column, walls unsubdivided but still cut to the roof, windows/frames/shutters one flat rectangle each, the stair flight coarsened to two risers -- **plus the thatch fringe and the porch roof**, which are silhouette | ~190 tris |
| detail 0 | to the card | a box per mass, a four-triangle roof sheet with no overhang, and one flat rectangle for the door and each window -- still warped | ~70 tris |

Every tier goes through the same field. **detail 0 is warped too**, which is not thoroughness -- the silhouette is all there is at that range, and a straight LOD0 under a leaning LOD1 pops on the swap.

Two things survive further down the ladder than the general rule would put them, and both are the same argument. The **fringe** stays at detail 1 because dropping it pops the outline of the roof at the LOD0 boundary and four triangles is not worth that. The **openings** stay at detail 0, as one flat rectangle each, because a box with a roof on it and no windows is a crate: the pattern of openings is the entire difference between a building and a shed at that range, and it is what makes a village read as inhabited from the far side of a valley. That is paid for by detail 0 giving up its overhang -- the eave is a dark pixel out there and the windows are not.

**Detail 1 targets an eighth of detail 2 and measures a seventh, and the floor is the windows.** A detail-1 rectangle has to be `double: true` to pair its directed edges for the airtightness gate, so it is 4 triangles and not 2, and a shuttered window is 16. An inn with twelve shuttered windows and three plain ones spends 216 triangles on openings before a wall, roof or plinth is drawn. Reaching a literal eighth means dropping the shutters, and a shutterless inn at 30 m reads as a blank wall. So the gate is on the **mean** (0.141 measured, 0.18 allowed), which governs what a village costs, plus **absolute caps of 460 triangles at detail 1 and 140 at detail 0**, which govern the worst frame. Per-building ratio is deliberately not gated, because it measures how many openings a building has rather than how thrifty its far tier is: the worst is a small cottage at 0.222, four windows and a door on a building with almost no wall to spread them over.

Measured over 1,200 buildings: **mean 1,361 tris, worst 2,544** (`inn`), against a `structure` ceiling of 2,600 and a 20 × 1,361 = 27k village allotment. v1 measured 1,211 / 2,472 against 2,500. The warp is close to free -- the roof grid, the full-length logs and the king posts are paid for by the chimney (48 → 12), by the window surround dropping from a five-or-six-sided ring to four-or-five across as many as fifteen windows on an inn, and by the roof giving up its soffit and edge bands.

**Those two §5 numbers have been raised twice -- once for the rounding, once for the warp -- and are not to be raised again casually.** Boxes measured 766 mean / 1,660 worst against 1800 and 16k. Hewn prisms are +40% and the trade was made deliberately: the silhouette is what the whole style rests on, it is spent only at detail 2, and the ladder means it is spent on the handful of buildings actually within 60 m. The next thing that wants triangles takes them from somewhere else.

The two places the increase was bought back are worth knowing, because both were pure waste rather than detail:

- **A half-timbered wall owns the post at its start corner only.** Closing the bay loop at both ends put two independently jittered posts inside every corner of every mass -- eight buried, interpenetrating members on an inn, 160 triangles of nothing.
- **The window surround is one swept ring**, 40 triangles at five sides, where four overlapping boxes were 48 with eight faces per stick buried inside its neighbour. An inn carries fifteen windows, so the surround is the single most expensive thing on the building either way; this way it is also round.

### The gate

`scripts/check-buildings.mjs` and `scripts/check-buildings-v2.mjs`, both in the `npm run check` chain. The v2 gate does **not** re-run the tile checks -- v2 shares every texture layer with v1 and there is one set of tiles -- and adds the two invariants v2 is most likely to break and least likely to break visibly: **airtightness under the warp** (the claim in `warp.js` is an argument, not a proof that the code implements it; a part computing its own jitter instead of taking the field's would pass every visual check and leave a hairline you can see the inside of the building through) and **winding under the warp**, at strengths 0, 0.5, 1 and 1.6, because the previewer's slider goes past 1 and "how far can it go before it breaks" should be measured rather than assumed. It also asserts the field is deterministic to the byte, that strength 0 builds no warp at all, and that strength 1 moves the worst vertex by a derived amount -- swept over a sample of the corpus rather than one plan, because the worst case is a tall building with a long eave and any single seed is very unlikely to be it.

**And one gate that reads the covering rather than the code that fits things under it.** A wall that stops 20 cm short of the roof is airtight, positively wound and inside budget: it passes everything else here and it is a slot of daylight under the eave. So a third section builds one planned roof plus one part under it -- each wall style on each of the four wall lines, windows at four sill heights, a bare corner post -- and measures both directions against the covering's **drawn triangles**. Asking `heightAt()` instead would only prove the surface agrees with itself, and the two bugs that caused this (a smooth answer for a folded surface, and a chord laid across a fold) are invisible from there. Nothing but masonry may stand through the covering; a chimney is supposed to. Character strength is 1 throughout, because a roof at strength 0 is a flat plane with no folds to align to; what varies is whether the field is applied, and only the unwarped run is asked about shortfall, where the arithmetic is exact. Measured: nothing comes closer than 1.7 cm to the covering from below, and the wall top follows it to 3.6 cm including the tuck. Removing `breaksAlong` from the wall takes that to 9.6 cm, which is the point.

The scene is deliberately one roof and one part, because on a whole building the question is ill-posed: an ell's wing wall stands well above the main range's overhang where it passes under it, quite legitimately, and no rule stated in world space tells that apart from a wall through a roof. A geometry-wide version of this check was written and thrown away after it reported a 2.8 m overshoot that was correct geometry.

**That last one measures the field, not the difference between two builds**, and the distinction became load-bearing the day the character started changing vertex *counts*. Differencing the strength-0 and strength-1 position arrays index by index is the obvious implementation and it silently assumes the two builds emit the same vertices in the same order. They do not: a log wall stops a course short when the sagged eave lowers its top, so one array is 12 floats shorter and every index past that point is comparing a log to its neighbour. It reported a 22 m displacement on a 14 m building. The gate now builds *once*, straight, and applies the field to those positions -- which is the thing being claimed anyway.

v1's gate asserts, over every seed of every kind: the door faces +Z and sits on the front wall; no window overlaps the doorway or overflows its own wall; every chimney is seated on the roof surface and clears the ridge; the footprint hull closes and covers the plan area; nothing floats or buries its sill on a slope. Over the geometry: every tier carries the full attribute set (a mismatch makes the village merge return `null`, which is a silent disappearance rather than an error), no non-finite positions or UVs, no stray non-building `texLayer`, tiers strictly decreasing, the budget, and **airtight with positive enclosed volume**.

And over every part **on its own, at every orientation**, which is the sharper half. The whole-building pass reports "hut/2 detail 2 has an unpaired edge", which is a hole somewhere in nine hundred triangles; building one part into one `Builder` names the function with the bug. More usefully it covers orientations the grammar happens not to produce -- windows land on all four walls of every building, but a lean-to only ever gets the outshut directions a plan picks, and the winding of a part is exactly the thing that is right on one axis and inside out on another. Each part declares itself `solid`, `sheet` or `flat` and the volume has to agree -- positive, non-negative, and zero respectively; `sheet` exists because a roof plane is honestly zero-thickness but can be pushed positive by whatever interpenetrates it, and the failure worth catching there is a slope wound inward, not a slope with volume. The v2 gate runs the same sweep over 64 parts *warped*, at every strength. Both benches run the two probes live on the geometry that is on screen -- which in v2 is the `warp.js` claim being checked on the building you are currently looking at, at whatever strength you have set.

Over the tiles: the **seam score**, which is the wrap-edge step divided by the strongest interior step in the same axis. The baseline took three wrong answers to reach -- one interior pair (usually in a smooth region, so every deliberate line scores as a seam), the whole-tile mean (the tile's own hard lines drag it down, and an integer course count puts one of them exactly on the boundary), and the 95th percentile (a tile with four strong lines has them all above p95). The max is the right question: *is the boundary worse than the strongest line this tile already contains?* ≤ 1 means indistinguishable from the tile's own periodic detail.

The shipped PNGs face the same metric, and that is not belt-and-braces: `loadImageLayers` overwrites a gated tile with an ungated one a few frames after load, so without this a PNG that is the wrong size, upside down, or non-tiling replaces a tile that was none of those and nothing anywhere reports it. The upload resolves, and the roof is simply wrong. So each shipped file is re-decoded and asserted on its own terms: 128², RGBA, seam ≤ 1.05 on both axes for the nine tiling ones; `door.png` exempt from the seam (it is island-addressed, so its edges are a doorframe and are meant to be a step) but required to be fully opaque, since `alphaTest` would punch holes in a leaf that carried the source's cutout alpha; every one of them kept below the multiply ceiling so the vertex tint has headroom; and the two lapped roofs measured for direction.

**The seam metric must include alpha.** The RGB-only version passed a fringe tile whose straw indices were not taken mod the straw count, so the last straw blended toward a phantom neighbour and the eave got one wrongly-cut straw every repeat. Alpha is where that tile keeps its shape, and the check that ignored it saw nothing.

Related: a value-noise lattice is periodic with period exactly 1, so it must **always** be sampled as `f(u, v)`, never `f(u*1.6, v*0.35)`. Anisotropy goes in the lattice dimensions, not the argument scale. Getting this wrong put a bright line down five of these tiles at scores of 3.5 to 29.

### Open

- `PLASTER`, `IRON` and `RUNE` are still procedural, for want of a source. `PLASTER` can stay that way -- a wall's texture is not its silhouette, only texel scale matters, and that is a UV decision. The other two cannot, or not comfortably: alpha carries their shape, so the placeholder *is* the asset rather than a stand-in for it.
- `tools/props/extract-thatch.mjs` still carries its own copies of the decode/heal/resample helpers, which now live in `tools/buildings/imageops.mjs`. Two implementations of the same cross-fade is exactly how the fringe and the roof drift apart at the eave.
- `src/village/*` still generates its own vertex-coloured placeholder buildings and has not been migrated onto this kit. The old kit's architectural range is not a constraint on this one. Until it is migrated, §5's `structure` and village rows describe what the kit measures rather than what a frame currently draws -- as they did before v2.
- **v1 is kept, and it is not free.** Two geometry layers over one plan layer is two places a part can be fixed, and `parts.js`/`v2/parts.js` already share only what v2 re-exports unchanged. It stays as long as the straight control is worth having; when the village is on v2 and the strength is chosen, v1 goes.
