## 19. Procedural buildings

> **Covers:** the Nordic building kit under `src/buildings/` -- the tile set, the geometry vocabulary, the grammar that combines them, and the LOD ladder.
> **Read this when:** adding a building part, a wall style, a kind, or a texture layer for one. Read the layer rule in §9 first; it decides whether your new texture is allowed to exist.

Skyrim-adjacent Nordic vernacular: log cabins, thatch huts, stocky timber, rough-hewn iron, small warped panes. Low-poly geometry wearing 128² textures, which is the same art direction as everything else here (§9) and not a separate look for buildings.

### The files

| File | Holds | Imports three.js |
|---|---|---|
| `src/buildings/tiles.js` | The pixel generators for all ten building layers | no |
| `src/buildings/plan.js` | The grammar. Pure data: masses, walls, openings, attachments | **no** -- §1's porting rule |
| `src/buildings/parts.js` | The `Builder` and the geometry vocabulary | yes |
| `src/buildings/building.js` | `buildBuilding(plan, {detail})` -- the translation, deliberately thin | yes |
| `tools/props/extract-thatch.mjs` | Cuts the two shipped thatch PNGs out of the photograph | no (node) |

`plan.js` staying three-free is what makes `scripts/check-buildings.mjs` able to plan 1,200 buildings in half a millisecond each and assert every one, rather than sampling. The bugs in a grammar live in the combinations nobody thought to look at, so exhaustive coverage is the point.

`gen-building.html` + `src/gen-building-main.js` is the tuning bench, in the same family as `gen-fern.html` and `gen-tree.html`. It runs the **real** shared `DataArrayTexture` and the real `createPropMaterial()`, because the whole premise is that one array plus a per-vertex `texLayer` puts thatch, logs, stone and glass in one draw call, and a previewer faking that with four materials would be checking the thing that is not in question.

### Ten layers, and the three that were refused

The layer registry and the reasoning live in `src/textures.js`. `TIMBER_HEWN`, `TIMBER_PLANK`, `THATCH`, `SHINGLE`, `STONE`, `PLASTER`, `THATCH_FRINGE`, `GLASS`, plus two decal sheets, `IRON` and `RUNE`. 10 × 64 KB = 640 KB, taking the array from 9 layers to 19 of the 256 §9 measured as available.

Refused under §9's rule that *a layer has to earn itself by reading as different at the distance it will be seen*:

- **Slate roof.** It is `SHINGLE` at a colder tint. At 128 px from the 15 m a roof is seen at, the shake pattern is what you read and hue is what names the material, and hue is free.
- **Chimney masonry.** It is `STONE`. Same rubble, same hands, same building. Dressed ashlar for a manor would be a new layer for a new building class, not a second version of this one.
- **Moss on thatch.** Not a texture: a per-vertex colour multiply driven by height above the eave and which way the slope faces. A moss layer would need a second blended pass, which means a second material, which splits the batch.

Two decal sheets share the same `RepeatWrapping` array as the tiling layers. That is legal because wrap mode only bites outside the unit square and every island's UVs stay inside it, subject to two rules the gate enforces: a **4-texel transparent gutter** so bilinear cannot reach a neighbour, and **one material family per sheet**, because coarse mips average the whole layer and iron bleeding into iron is invisible where iron bleeding into a rune is not.

### What is a photograph and what is generated

`tools/props/extract-thatch.mjs` cuts `public/buildings/thatch.png` and `public/buildings/thatch_fringe.png` from the one genuinely usable source in `tmp/downloaded-to-maybe-use/` -- a 614² photograph of combed straw, already running the right way down the frame. `IMAGE_LAYERS` patches both over their generators a few frames after load, the same arrangement `BARK` and `LEAVES` already have; the generated versions stay, because they are what is on screen until the fetch lands.

The photo needs three things done to it, and the script's value is entirely in those three:

- **It does not wrap.** 1.24 in u and 4.00 in v on the metric below. Healed by cross-fade rather than by mirroring: mirroring puts an axis of symmetry down the tile, and once you have seen the butterfly you see it on every roof in the village. The band is dropped from one end and dissolved into the other, so the output's two edges are pixels that were genuinely adjacent in the source. Lands at 0.82 / 0.93.
- **It has no courses.** It was shot as a wall panel, so there is no butt line anywhere in it -- and the butt line is the only hard line real thatch has, combed rather than lapped, and most of what says "roof" instead of "hay bale". Added back procedurally, phase-varied per course so the four lines are not parallel.
- **It cannot be tinted as shot.** Old thatch, new thatch and moss are all per-vertex colour *multiplies*, and a multiply only ever takes light away. Graded per channel onto the shared straw palette with a ceiling, so there is headroom in every direction. Per channel and not against one shared luminance, which is the obvious way to write it and leaves the orange cast exactly where it was.

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

### The Builder

`quad(a, b, c, d, opts)` is the whole vocabulary. `a→b` is the U axis, `a→d` is the V axis, and the outward normal falls out of the same ordering as `cross(b-a, d-a)` -- so a face that is textured right is also facing the right way, and there is one thing to get wrong instead of two.

**Why not `BoxGeometry` + `mergeGeometries()`:** box UVs run 0-1 *per face*, so a 4 m wall and a 0.2 m post would each get the texture exactly once and the wall's logs would be twenty times the size of the post's. Fixing that means rewriting every UV after the merge, at which point the geometry classes have bought nothing.

`box()` takes a `skip` list. Dropping the face buried in a wall is not a micro-optimisation: a timber frame is dozens of boxes and at 2 triangles a face the buried ones are a fifth of a building's budget for something no one can ever see.

### Openings are never cut

A door or a window is a surround standing **proud** of the wall, with the leaf or the glass set inside it. Not a shortcut: cutting a hole leaves a boundary edge, and the collapse decimator refuses to collapse edges that border a hole -- which is exactly why the props stall at 896 → 544 triangles and never reach target. Keeping every wall a closed quad is what keeps LOD-by-re-generation available.

Glass is **opaque** by necessity (§7): alpha blending cannot be depth-sorted inside a batched draw call. Which is also what a small-paned window looks like from outside in daylight -- not a hole, a bright grey sheet with the sky in it.

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
| detail 2 | to 60 m | everything: log ends, frames, ironwork, corbelled cap, porch posts | ~700 tris |
| detail 1 | to 170 m | massing, roof, gables, plinth, chimney, flat door and glass -- **plus the thatch fringe and the porch roof**, which are silhouette | ~80 tris |
| detail 0 | to the card | box and roof prism | ~28 tris |

The fringe stays at detail 1 against the general rule because dropping it would pop the outline of the roof at the LOD0 boundary, and four triangles is not worth that.

Measured over 240 buildings: mean 705 tris, worst 1,670 (`inn`), against §5's 1800 for the `structure` class and its 20 × 800 = 16k village allotment.

### The gate

`scripts/check-buildings.mjs`, in the `npm run check` chain. Asserts, over every seed of every kind: the door faces +Z and sits on the front wall; no window overlaps the doorway or overflows its own wall; every chimney is seated on the roof surface and clears the ridge; the footprint hull closes and covers the plan area; nothing floats or buries its sill on a slope. Over the geometry: every tier carries the full attribute set (a mismatch makes the village merge return `null`, which is a silent disappearance rather than an error), no non-finite positions or UVs, no stray non-building `texLayer`, tiers strictly decreasing, and the budget.

Over the tiles: the **seam score**, which is the wrap-edge step divided by the strongest interior step in the same axis. The baseline took three wrong answers to reach -- one interior pair (usually in a smooth region, so every deliberate line scores as a seam), the whole-tile mean (the tile's own hard lines drag it down, and an integer course count puts one of them exactly on the boundary), and the 95th percentile (a tile with four strong lines has them all above p95). The max is the right question: *is the boundary worse than the strongest line this tile already contains?* ≤ 1 means indistinguishable from the tile's own periodic detail.

The shipped PNGs face the same metric, and that is not belt-and-braces: `loadImageLayers` overwrites a gated tile with an ungated one a few frames after load, so without this a PNG that is the wrong size, upside down, or non-tiling replaces a tile that was none of those and nothing anywhere reports it. The upload resolves, and the roof is simply wrong.

**The seam metric must include alpha.** The RGB-only version passed a fringe tile whose straw indices were not taken mod the straw count, so the last straw blended toward a phantom neighbour and the eave got one wrongly-cut straw every repeat. Alpha is where that tile keeps its shape, and the check that ignored it saw nothing.

Related: a value-noise lattice is periodic with period exactly 1, so it must **always** be sampled as `f(u, v)`, never `f(u*1.6, v*0.35)`. Anisotropy goes in the lattice dimensions, not the argument scale. Getting this wrong put a bright line down five of these tiles at scores of 3.5 to 29.

### Open

- Six of the eight tiling layers are still procedural, deliberately. A wall's texture is not its silhouette -- only texel scale matters, and that is a UV decision -- so they can be replaced without touching geometry. The exceptions are the three where alpha carries shape and the placeholder therefore *is* the asset: `THATCH_FRINGE` (shipped), `IRON` and `RUNE` (not).
- Sources still to cut: `TIMBER_HEWN` from `MI_Old_Railroad_Tie`, `TIMBER_PLANK` from `MI_Old_Wooden_Beam`, `PLASTER` and a door leaf from `MI_Medieval_Modular_Door`, `STONE` from `MI_Mossy_Stone_Wall`, `SHINGLE` rebuilt from a handful of cards in `MI_Modular_Wooden_Roof`. None is a drop-in tile: despite "Modular" in the filenames they are per-asset UV unwraps, so each needs the same heal-grade-resample pass the thatch got.
- `src/village/*` still generates its own vertex-coloured placeholder buildings and has not been migrated onto this kit. The old kit's architectural range is not a constraint on this one.
