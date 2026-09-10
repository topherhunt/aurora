import THREE from './three-instance.js'
import {
  tileLogs,
  tilePlanks,
  tileThatch,
  tileShingles,
  tileStone,
  tilePlaster,
  tileFringe,
  tileGlass,
  sheetIron,
  sheetRunes,
} from './buildings/tiles.js'
import { mushroomCapSheet, mushroomCaveSheet, mushroomFleshSheet } from './props/mushroom-texture.js'
import { crabShellSheet } from './props/crab-texture.js'
import { butterflyWingSheet } from './props/butterfly-texture.js'

// ---------------------------------------------------------------------------
// The one prop texture. Every prop texture in the world is a layer of this.
// DESIGN.md §9 carries the argument and the sizing tables; this is the registry.
//
// The art direction is low-poly geometry with N64-resolution textures (Ocarina
// of Time / a lower-res Skyrim), NOT flat-shaded untextured low-poly.
//
// A DataArrayTexture, NOT a packed atlas, and that is the load-bearing decision
// of the whole pipeline. An atlas mips over the WHOLE image, so at coarse levels
// a leaf averages with its neighbour and turns bark-brown; and a sub-rectangle
// has no repeat mode, so bark cannot tile up a trunk. Array layers mip
// independently and get the full [0,1] space with real RepeatWrapping. It costs
// the same as an atlas at the thing atlases exist for: ONE binding, one
// material, so BatchedMesh collapses everything into one multi-draw call (§5).
//
// ONE MESH, SEVERAL LAYERS. `texLayer` is per-VERTEX, not a per-object uniform,
// so one geometry in one batch wears different textures on different parts of
// itself -- a trunk in BARK, its canopy cards in NEEDLES, one draw call. Adding
// a species means adding a layer, not a material.
//
// THE ONE REAL CONSTRAINT: every layer must share dimensions and format, so
// TEX_SIZE is an invariant of the asset pipeline, not a knob. See below.
//
// Procedural tiles below are placeholders that exist so the spike exercises the
// real path (one sampler2DArray, alphaTest, mipmaps) and are not meant to look
// good. Image layers are real PNGs loaded from `public/`.
// ---------------------------------------------------------------------------

// INVARIANT, not a preference. A DataArrayTexture is one allocation of
// LAYER_COUNT identically-sized slices, so this is the slice format for every
// asset that will ever enter the array. 128 is what the pipeline already emits:
// all 40 layers in public/props/layers/ and all three fronds in public/ferns/
// are 128x128. Changing it means re-cutting every one of them.
export const TEX_SIZE = 128

// Layer indices. Vertex `texLayer` attributes point at these.
export const LAYER = {
  BARK: 0,
  BARK_BIRCH: 1,
  NEEDLES: 2,
  LEAVES: 3,
  ROCK: 4,
  SNOW: 5,
  DIRT: 6,
  GRASS: 7,
  // Real scan, cut by tools/props/extract-frond.mjs.
  //
  // ONE, not the three the extractor produced. All three are the same Lady Fern
  // sheet: coverage 31.2/36.3/30.3%, mean RGB (28,41,4)/(28,40,4)/(29,44,1), and
  // the only differences are that one is gappier at the top and another blunter
  // at the tip. On a card 0.38 as wide as tall, at 128 px, from two metres, that
  // is nothing.
  //
  // THE RULE THIS SETS, cited all through this file: A LAYER HAS TO EARN ITSELF
  // BY READING AS DIFFERENT AT THE DISTANCE IT WILL BE SEEN. Scan-to-scan noise
  // between two photographs of the same plant does not; species-to-species leaf
  // shape does. So one leaf layer per tree SPECIES, one shared bark, one grass.
  // The variety a player sees comes from geometry (16 mesh variants x yaw x
  // scale x per-frond jitter), which is where it should be bought. Being wrong
  // is cheap either way: a layer is 64 KB, no draw call, no per-frame cost.
  FROND_0: 8,

  // --- buildings (DESIGN.md §19) -------------------------------------------
  //
  // Ten here, plus ROOF_TILE, DOOR and TIMBER_BEAM appended at the end of the
  // registry when real photographic sources turned up. Thirteen is what it takes
  // to make a building read as ONE object rather than a pile of parts. Three
  // candidates failed FROND_0's rule and are not here:
  //
  //   Slate roof. SHINGLE at a colder tint and lower value. At 128 px from the
  //   15 m a roof is seen at, the shake pattern is what you read and the hue is
  //   what names the material -- and hue is free.
  //
  //   Chimney masonry. STONE. Same rubble, same hands, same building. Dressed
  //   ashlar for a manor would be a new layer for a new BUILDING class.
  //
  //   Moss on thatch. A per-vertex colour multiply keyed on roof height, normal
  //   and distance from the eave: zero layers, zero triangles, varies per
  //   building for free. There IS a LAYER.MOSS now and a roof could join
  //   MOSS_LAYERS any day -- the blended second pass costs a branch and a fetch
  //   inside the shared material, not a second material. The multiply stays
  //   regardless, because it is doing a different job: a WEATHERING gradient,
  //   damp at the eave and bleached at the ridge, which a tiled photograph
  //   cannot express. A roof wanting real clumps wants BOTH.
  //
  // 13 x 64 KB = 832 KB, taking the array from 9 to 26 of the 256 layers §9
  // measured as available.
  TIMBER_HEWN: 9, // rough-sawn boarding -- porch decks, soffits, wide planking
  TIMBER_PLANK: 10, // sawn boards -- stave walls, shutters, window frames, rails
  THATCH: 11, // straw roof
  SHINGLE: 12, // wood shakes; tint cold for slate
  STONE: 13, // rubble masonry -- plinths, foundations, chimneys
  PLASTER: 14, // lime daub, the infill of a half-timbered panel
  THATCH_FRINGE: 15, // alpha-cut ragged eave edge; tiles in u, clamped in v
  GLASS: 16, // leaded panes, warped -- the one window material
  IRON: 17, // decal sheet: hinges, ring handles, nails, brackets
  RUNE: 18, // decal sheet: knotwork bands and carved staves

  // --- procedural trees (src/props/tree.js) ---------------------------------
  //
  // Appended rather than slotted in beside BARK and LEAVES, because a layer
  // index is a value baked into every `texLayer` attribute already in the
  // library -- renumbering is a silent re-skin of everything that ships.
  //
  // These three earn themselves under the FROND_0 rule above. Pine bark is
  // red-brown plates against oak's grey-green fissures, which is a hue AND a
  // pattern apart at any distance you can see a trunk from. Ash's paired
  // leaflets and aspen's round coins are different silhouettes, and silhouette
  // is the whole of what a leaf card is. What did NOT earn a layer: a separate
  // birch leaf (it wears LEAF_ASH), and any second bark for aspen (it wears
  // BARK_BIRCH -- both are pale and lenticelled, which is the botany).
  BARK_PINE: 19,
  LEAF_ASH: 20,
  LEAF_ASPEN: 21,
  // The pine spray a procedural tree wears. Same art as NEEDLES but cut with
  // transparent side margin, which is left over from a tiled-branch scheme that
  // is gone (see tree.js) and is still the better card of the two: a spray with
  // air around it reads as one twig rather than as a slab. NEEDLES stays,
  // cropped tight, because the scanned props address it.
  SPRAY_PINE: 22,

  // --- buildings, second pass (real photographic sources) -------------------
  //
  // Three the first nine could not cover, appended: an index is baked into every
  // shipped `texLayer`, so this list only ever grows at the end.
  //
  // ROOF_TILE contradicts the slate argument above only in appearance. That
  // argument stands -- slate is a shake in a colder hue -- and it is exactly why
  // a scalloped pantile is NOT: its silhouette is a row of half-circles where a
  // shake roof is rectangles, and silhouette is what survives 128 px from
  // fifteen metres. A tint cannot round a corner.
  //
  // DOOR is a decal sheet, not a tiling layer: one photographed leaf addressed
  // 0..1 by island, like IRON and RUNE. It pays for itself in TRIANGLES -- the
  // scan already has its hinge straps and ring pull painted on, so doorway()
  // stopped emitting six doubled decal quads when this landed.
  //
  // TIMBER_BEAM splits what was one wood layer into the two things a Nordic
  // building is made of. TIMBER_HEWN was a squared beam with log-course shading
  // multiplied in, serving as round logs, posts and boarding at once and reading
  // as none well. TIMBER_BEAM is a weathered baulk with its checks and splits,
  // worn by every raw member -- log courses, log ends, posts, rails, jambs.
  // TIMBER_HEWN kept its own source and is now rough-SAWN boarding: porch decks,
  // soffits, planking that is cut but not planed. Worth 64 KB because it is a
  // silhouette distinction as much as a texture one -- the beam tile is what
  // prism() members are lit by, and a plank tile on a five-sided log is the one
  // combination that makes the rounding look like a mistake.
  ROOF_TILE: 23, // red scalloped pantile -- the roof a prosperous inn has
  DOOR: 24, // decal sheet: one plank door leaf, ironwork included
  TIMBER_BEAM: 25, // raw uncut baulk -- log courses, posts, rails, every member

  // --- tree impostors (src/props/impostor.js) -------------------------------
  //
  // NOT ART. The only layers here with no source of their own: written at load
  // by rendering each species' LOD0 tree side-on into a 128x128 target and
  // reading the pixels back. Same argument fern-bank.js makes against an offline
  // bake -- an impostor generated from the mesh cannot disagree with the mesh,
  // and a PNG on disk can, silently, for as long as nobody looks.
  //
  // They pass the FROND_0 rule in the opposite direction from everything else
  // here: what a player sees at 30 m IS this layer, so a pine impostor and a
  // birch impostor are different TREES, not merely different textures. One per
  // SPECIES, because the scatter gives every instance a yaw and the card is
  // three planes -- spinning it is three apparent silhouettes from one bake.
  //
  // The only layers whose UVs are NOT tiled: addressed 0..1 exactly once, so
  // RepeatWrapping must never reach them. The bake leaves a transparent margin
  // on three sides for that reason.
  IMPOSTOR_PINE: 26,
  IMPOSTOR_OAK: 27,
  IMPOSTOR_BIRCH: 28,
  IMPOSTOR_ASPEN: 29,

  // --- fern impostors (src/props/fern-bank.js) ------------------------------
  //
  // Same machinery and the same "written at load, never on disk" argument as the
  // four above. What differs is the UNIT: a tree impostor is one per SPECIES and
  // there is only one fern species, so the question is which slice of a
  // 16-variant bank earns a bake.
  //
  // TWO, cut on `arch`, and the FROND_0 rule picks the axis. The card takes over
  // at 26 m (§5), where a 0.55 m fern is ~20 px tall -- small, but nowhere near
  // the 3 px where everything is a smudge. At 20 px an `arch` 0.6 fern is a
  // narrow upright shuttlecock and an `arch` 2 one is a wide flat spray: a
  // silhouette apart, so it earns a layer. The other three axes do not. `pitch`
  // 1.0 vs 1.4 tilts fronds a few degrees, `fronds` 5 vs 9 changes coverage
  // inside an unchanged outline, and `taper` only touches the last centimetre of
  // a tip. Sixteen bakes would spend 1 MB redrawing the same two outlines eight
  // times each; one would put every fern in the world at one silhouette. The
  // rest of the variety at this range is per-instance and free: yaw spins a
  // crossed pair through four apparent silhouettes, `scale` is drawn from
  // [0.75, 1.35] (props/scatter.js).
  //
  // The 20 px figure is arithmetic, not a looked-at judgement.
  // `gen-fern.html`'s `card` button is where it gets confirmed.
  IMPOSTOR_FERN_UPRIGHT: 30, // baked from the low-`arch` half of the bank
  IMPOSTOR_FERN_ARCHED: 31, // ...and the high-`arch` half

  // --- the ground itself (src/terrain/terrain-material.js) ------------------
  //
  // The meadow tile. 32 was the rock card's old scratch layer, free since the
  // bank moved to the per-shape run at the bottom of this table. Its pair,
  // TERRAIN_SNOW, sits at the far end of the table for want of a second hole;
  // the two are read together and neither is ever worn as a `texLayer`, so their
  // indices being apart costs nothing but this sentence.
  //
  // NOT AN ALBEDO, which is what makes one tile enough for a world of grass.
  // terrain-material.js divides it by its own linear mean (GRASS_TILE_MEAN
  // below) and multiplies the palette by the result, so what ships is a contrast
  // field averaging (1,1,1): the photograph's grain and its blade-to-soil colour
  // swing, without moving the green everything else there was tuned against.
  // Same trick and same reasons as LAYER.ROCK on a cliff face.
  //
  // Cut from tmp/grass.jpg by tools/props/cut-terrain.mjs, which is where the
  // grade -- and what `spread` and `desaturate` decide -- is argued.
  TERRAIN_GRASS: 32,

  // --- grass (src/props/grass-bank.js, src/v2/render/grass.js) --------------
  //
  // The EZ-Tree tuft, cut by tools/trees/layers.py and staged at
  // public/grass/grass_tuft.png. This is the SAME image the generated grass
  // props in public/props/ wear, and it is here rather than reused from there
  // because public/props is a build tree that `npm run props --clean` deletes;
  // see the note in layers.py's main().
  //
  // IT IS GREYSCALE ON PURPOSE and that is what makes one layer enough. Measured
  // over the file: mean RGB 141/141/141, mean chroma 0.0, 18.9% opaque. All the
  // colour arrives as the instance TINT, so lush, dry and autumn grass -- and
  // the per-instance variation the carpet is scattered with -- cost nothing
  // beyond this one slice. The tints the /props asset ships are sRGB
  // (0.30, 0.50, 0.20), (0.42, 0.52, 0.24) and (0.60, 0.56, 0.30), and
  // generate.mjs calibrates them against v1's procedural blades: a dry tint
  // through a mid-grey texel lands near linear (0.03, 0.047, 0.010), which is
  // the same brightness as shapes.js's BLADE_BASE.
  GRASS_TUFT: 33,

  // The grass impostor, baked at load from the 3-plane LOD0 tuft.
  //
  // ONE layer, and the reason it needs a layer of its own is mechanical rather
  // than artistic: material.js picks what to BILLBOARD by texture layer, so a
  // spinning single quad cannot wear GRASS_TUFT without every crossed quad in
  // the same batch spinning with it. The fern's two impostor layers were a
  // judgement about silhouette; this one is forced.
  //
  // Given that it has to exist, it is a photograph of the 3-plane cross rather
  // than a copy of the tuft, which costs one 512² render at load and buys a
  // fuller outline: a single blade card is a third of what a tuft looks like
  // from the side, and the far tier carries about 80% of the instances.
  IMPOSTOR_GRASS: 34,

  // --- moss (src/material.js MOSS_APPLY) ------------------------------------
  //
  // Cut from a photograph by tools/props/cut-moss.mjs. Not a prop: nothing in
  // the world carries MOSS as its `texLayer`. The SHADER samples it, as a second
  // fetch over whatever the surface already is, wherever MOSS_LAYERS says moss
  // grows. That is what earns it a slot under §9's rule, and the arithmetic is
  // unusually good: ONE layer puts moss on every rock, trunk, snag, fallen log
  // and building member in the world, at no triangles, no second material and no
  // per-prop authoring. Mossy VARIANTS of the tiles that want moss would cost a
  // layer each and still could not vary within one surface.
  //
  // The first layer deliberately NOT tintable. stone.png is graded bright and
  // neutral so a per-instance tint decides its hue; moss is graded to its final
  // colour, because moss on basalt and moss on sandstone are the same green.
  MOSS: 35,

  // --- mushrooms (src/props/mushroom-texture.js) -----------------------------
  //
  // Three SHEETS, not three textures: each is a 2x2 grid of 64 px cells and a
  // mushroom picks its cell by UV offset, so three slots carry eight cap colours
  // and four fleshes inside the one shared prop material -- no extra draw call,
  // no extra vertex attribute. That is why mushrooms did not get a material of
  // their own: they will be the most numerous and smallest prop in the world,
  // and the smallest prop is the worst thing to spend a draw call on.
  //
  // The first layers with NO photograph behind them and none coming. Everything
  // else here that looks generated is a stand-in waiting for loadImageLayers();
  // these are the shipping art, because a cap is a flat colour, a rim shade and
  // one pattern, and a photo of that would be storing the output of a function.
  // Zero bytes on disk, no `npm run props`, and a new colour is an array edit.
  //
  // Split forest/cave by WHERE rather than by hue, because that is the decision
  // the scatter makes and it keeps a cave palette from bleeding into a forest
  // one across a mip boundary. FLESH is shared: gills and stalks are the same
  // picture at different contrast, argued in mushroom-texture.js.
  MUSHROOM_CAP: 36,
  MUSHROOM_CAP_CAVE: 37,
  MUSHROOM_FLESH: 38,

  // The mushroom's card tiers, ONE PHOTOGRAPH PER SPECIES. Written at load by
  // photographing the mesh, like the fern and grass impostors: RAM, zero bytes
  // of disk, and they cannot disagree with the geometry they stand in for.
  //
  // Per SPECIES, not per variant, which is why there are five and not thirty.
  // mushroom-bank.js builds six shape variants of each and every one wears its
  // species' single card at its own width and height -- the same trade
  // tree-bank makes for four sizes of pine, and cheaper here, because a
  // mushroom's variants differ by stem length and cap dish rather than by having
  // a different number of parts.
  //
  // Per species and not one for ALL of them, which is the line worth holding: at
  // card range these five are still five COLOURS -- scarlet cap, chestnut, amber
  // funnel, pale parasol, dark ink cap -- and colour is the last thing to
  // survive as a prop shrinks. Shape is what a card gives up; hue is what it is
  // for. Five layers is 320 KB against 256 KB saved by sharing one, and sharing
  // would put one hue on the whole forest floor.
  //
  // Both card tiers of a species share its layer -- the two-plane cross at LOD1
  // and the spun billboard at LOD2 -- exactly as the four tree impostors do:
  // same photograph seen two ways, and material.js's billboardVertex tells them
  // apart by vertex NORMAL rather than by layer. See treeImpostorLayers.
  IMPOSTOR_MUSHROOM_AGARIC: 39,
  IMPOSTOR_MUSHROOM_PORCINI: 40,
  IMPOSTOR_MUSHROOM_CHANTERELLE: 41,
  IMPOSTOR_MUSHROOM_PARASOL: 42,
  IMPOSTOR_MUSHROOM_INKCAP: 43,

  // --- strewn litter (src/props/litter.js) ----------------------------------
  //
  // Written at load like the impostors, by the same argument, but photographing
  // something that never exists as a mesh: a few dozen small stones dropped at
  // random on a patch of ground, shot from STRAIGHT ABOVE, stamped on the
  // terrain as a flat quad. One layer buys a square metre of stony ground for
  // two triangles.
  //
  // WHY IT EXISTS: the scatter used to draw that look as geometry -- an 11 cm
  // stone every 1.7 m across every cliff and wood, forty-one of them for every
  // rock big enough to read as a rock, each a full BatchedMesh instance whatever
  // its triangle count. The look is worth having and the geometry was not, which
  // is exactly what a texture is for. See the underfoot bed in
  // v2/render/rocks.js for the other half.
  //
  // FOUR AND NOT ONE, because a single patch stamped over a hillside is a repeat
  // the eye finds immediately -- the mushroom cards' argument, and cheaper here:
  // the scatter yaws each stamp, so four layers x four right-angle turns is
  // sixteen apparent patches before mirroring. 256 KB for the set.
  //
  // NOT IN ANY SNOW LIST, deliberately. The ground under a patch is terrain, and
  // terrain does its own snow in its own shader; whitening the patch too would
  // put a second, differently shaped snow line on top of the first at the exact
  // place they are guaranteed to be compared. Bare stone showing through the
  // ground's snow is cheaper and reads as wind-scoured scree.
  LITTER_0: 44,
  LITTER_1: 45,
  LITTER_2: 46,
  LITTER_3: 47,

  // --- dead wood (src/props/deadwood.js) ------------------------------------
  //
  // Written at load, like every other IMPOSTOR_* above. Two layers for eighteen
  // variants, and the split is by ATTITUDE rather than by species: a standing
  // stump and a fallen log have nothing in common in silhouette, which is the
  // only thing a billboard carries, while an oak log and a pine log have the
  // same outline and differ only in a bark tile the card is too far away to
  // resolve.
  //
  // THE SPECIES ARE THEREFORE APPROXIMATED, and birch is the case that pays for
  // it -- a dead birch is pale where oak and pine are dark, and one photograph
  // cannot be both. Two arguments for wearing it anyway: the deadwood family is
  // tinted as a whole (DEADWOOD_TINT) so the three are already closer than their
  // tiles are, and the card does not start until 20 m, where a 2 m log is under
  // 100 px and its colour is doing the work its shape cannot. If it ever reads
  // wrong the fix is a third layer for birch, not six.
  IMPOSTOR_DEADWOOD_SNAG: 48,
  IMPOSTOR_DEADWOOD_LOG: 49,

  // --- building impostors (src/buildings/v2/card.js) ------------------------
  //
  // A BLOCK OF 20, indexed by MATERIAL rather than by building: one photograph
  // per wall style x roof kind, borrowed by every building wearing that pair.
  // The run is `IMPOSTOR_BUILDING` to `IMPOSTOR_BUILDING + CARD_COMBOS.length-1`;
  // card.js owns the order and LAYER_COUNT has to leave room for all of it.
  //
  // The arithmetic is the whole argument. Per variant is 148 slices of 64 KB --
  // 9.3 MB to put 4-triangle specks on a hillside, and 19 MB when a card took
  // two planes. Per material pair it is 20 slices, 1.25 MB, and it is complete:
  // the four kinds' legal style x roof grids union to exactly 20 and a cottage
  // can be built for every one, so a cottage is what gets photographed. A
  // distant building then wears the right WALL and right ROOF at the wrong
  // proportions -- the trade named in card.js, worth about three pixels at card
  // range. The cross still stands its planes at the real building's TRUE widths
  // and height, so the silhouette is the building's; only the picture inside it
  // is borrowed, and stretched to fit.
  IMPOSTOR_BUILDING: 50, // base of a 20-layer run, one per wall style x roof kind

  // --- rock impostors (src/props/rock-bank.js, src/v2/render/rocks.js) ------
  //
  // ONE PHOTOGRAPH PER SHAPE, and the bank has two. Every carded rock in every
  // bed reads one of these two layers, which is the whole card cost for stone.
  //
  // THE TWO PICTURES CANNOT BE ONE. A cap is an open-bottomed shell, so its
  // silhouette is a low dome roughly a fifth as tall as it is wide, against the
  // boulder's blunt block at three fifths; a card is stretched to the quad it is
  // drawn on, so sharing a photograph would print the boulder's crown squashed
  // into the cap's frame at exactly the distance where nothing else is left to
  // tell the two apart.
  //
  // 72..94 ARE FREE and are not yet reclaimed: this was a 25-layer run, one
  // picture per variant, and collapsing the bank emptied all but the base.
  // Renumbering means moving every layer above it, which is a change with a
  // blast radius out of proportion to the ~1.4 MB it reclaims.
  IMPOSTOR_ROCK: 70,
  IMPOSTOR_ROCK_CAP: 71,

  // Crab sheet, same reasoning as the mushroom's: a crab's shape is geometry
  // (props/crab.js) and its texture is a mottled shell colour, cheap
  // arithmetic -- so this is the shipping art, zero bytes on disk. Every
  // surface -- carapace and every limb -- reads this one layer. See
  // props/crab-texture.js.
  CRAB_SHELL: 95,

  // Butterfly sheet, same reasoning as the crab's -- see props/butterfly-texture.js.
  // Wing patterns and paired body tones, four 64px cells in one 128px layer.
  BUTTERFLY_WING: 97,

  // TERRAIN_GRASS's pair -- see the note at layer 32 for what these two are and
  // why they are not albedos. Appended rather than slotted beside it because 32
  // was the only hole left in the table.
  //
  // Cut from tmp/snow.jpg by tools/props/cut-terrain.mjs.
  TERRAIN_SNOW: 98,

  // NOT AN ALBEDO. A height field: grey fractal noise, read only by the prop
  // material's bump block (src/material.js, `bump: true`) and never sampled for
  // colour by anything. It is the rock's grit, and it is a layer of its own because
  // the alternative -- reading the stone photograph's luminance -- makes tone into
  // relief, so a pale mineral vein comes out as a ridge and a wet patch as a pit.
  // Generated, seamless, and tiled independently of the albedo (uBumpTile), so how
  // coarse the grit reads is not welded to how coarse the stone reads.
  ROCK_BUMP: 99,

  // --- the WARPED leaf cuts (tools/trees/gen-layers.mjs, /gen-tree-v2) -------
  //
  // The same four sprays as NEEDLES / LEAVES / LEAF_ASH / LEAF_ASPEN, cut from a
  // hand-marked QUAD instead of an axis-aligned box, so the art fills the square
  // instead of leaving a third of it as air: 30 -> 56% opaque on pine, 25 -> 41%
  // on ash. A crown's cost is the card AREA it hangs, and the opaque fraction is
  // the exchange rate between area and canopy -- at twice the fill, the same
  // crown needs half the overlapping cards.
  //
  // These do not replace the four above, because a v1 tree cannot wear them: the
  // card has to be built at the quad's own proportions to reverse the warp
  // (`sprayQuad` in tree.js), and a v1 card is a rectangle. Both sets ship so
  // /gen-tree-v2 can put the two schemes side by side. Whichever wins, the loser
  // and its four layers come out.
  LEAF2_PINE: 100,
  LEAF2_OAK: 101,
  LEAF2_ASH: 102,
  LEAF2_ASPEN: 103,

  // --- the foliage MATS (src/props/tree-v8.js, src/props/tree-oak.js) --------
  //
  // Not cards: a v8 bough and an oak scoop are geometry with their own outline,
  // and the mat is a TILED, fully opaque surface run several repeats across
  // each -- what the array's RepeatWrapping is for. One per species, since a
  // needle mat and a leaf mat are a hue and a pattern apart. Both benches
  // sample the same files; pine's and aspen's ship at 360 and 369 pixels there
  // and are cut to TEX_SIZE for the array.
  MAT_PINE: 104,
  MAT_OAK: 105,
  MAT_ASPEN: 106,
  MAT_BIRCH: 107,
}
export const LAYER_COUNT = 108

// --- which layers snow settles on (src/material.js, uSnow) -------------------
//
// Snow is a global uniform on the one shared prop material, so the shader knows
// nothing about what it is drawing except the layer index -- and that is exactly
// enough, because "is this foliage" IS a property of the layer. No vertex
// attribute, no second material, no geometry change.
//
// The four TREE IMPOSTORS are in on purpose. They are pictures of a whole tree,
// trunk included, so snowing one whitens its trunk -- which is what the mesh
// tiers do too now (see SNOW_WOOD_LAYERS). It was right even before that: a
// green tree at 130 m in a white forest is the worse error by a wide margin, and
// snow does sit along real branches. The bake is unlit and snow-free, so the
// card stays dynamic -- turning snow up whitens LOD2 without rebaking. How MUCH
// is SNOW_CARD_LAYERS' business: being in this list buys a card the foliage
// recipe, not the mesh's threshold.
//
// DELIBERATELY OUT, each one line to add: FROND_0, GRASS, GRASS_TUFT, and the
// fern and grass impostors. All would snow in a real winter, but they sit ON the
// ground, and the ground is a separate argument (a snowy world wants a snow
// TERRAIN shader, not white ferns on green grass) that has not been had. A tree
// is IN because a canopy reads against the sky and can be believed on its own;
// nothing at ankle height can. An impostor always moves with the art it
// replaces, which is why IMPOSTOR_FERN_* follow FROND_0 out and IMPOSTOR_GRASS
// follows GRASS_TUFT: a mesh plant and a card plant either side of an LOD
// boundary would otherwise be green and white.
export const SNOW_LAYERS = [
  LAYER.NEEDLES,
  LAYER.LEAVES,
  LAYER.LEAF_ASH,
  LAYER.LEAF_ASPEN,
  LAYER.SPRAY_PINE,
  LAYER.LEAF2_PINE,
  LAYER.LEAF2_OAK,
  LAYER.LEAF2_ASH,
  LAYER.LEAF2_ASPEN,
  // The mats the shipped crowns (tree-bank.js) are tiled from.
  LAYER.MAT_PINE,
  LAYER.MAT_OAK,
  LAYER.MAT_ASPEN,
  LAYER.MAT_BIRCH,
  LAYER.IMPOSTOR_PINE,
  LAYER.IMPOSTOR_OAK,
  LAYER.IMPOSTOR_BIRCH,
  LAYER.IMPOSTOR_ASPEN,
  // The two dead-wood cards, and they are here rather than with the wood they
  // replace because of what a card IS, not what it is a picture of. Wood snows
  // through the HARD-SURFACE recipe, which leans hard on which way the surface
  // faces -- and a billboard's normal is vertical by construction, so the hard
  // recipe would read the whole quad as a horizontal top face and paint it
  // solid white. The card recipe below takes the instance's own snow load as a
  // coverage fraction instead, which is the only one of the three that says
  // anything sensible about a flat photograph. See SNOW_CARD_LAYERS.
  //
  // Out of the lists entirely was the other option and it is worse: a fallen log
  // white at 19 m and bare at 21 is a pop at a boundary the player walks across
  // constantly.
  LAYER.IMPOSTOR_DEADWOOD_SNAG,
  LAYER.IMPOSTOR_DEADWOOD_LOG,
]

// --- and which of those are FLAT PHOTOGRAPHS rather than cut foliage ----------
//
// A subset of SNOW_LAYERS, not a rival: everything here is foliage and snows as
// foliage. What changes is HOW, because the ordinary recipe has a failure mode
// only a card can hit.
//
// SNOW ON FOLIAGE IS A THRESHOLD, not a blend -- `drift > cut`, with a one-pixel
// rim -- and it works because drift VARIES across a real canopy: every leaf card
// faces its own way and the blob field varies over the crown. A flat card has
// neither. Past SNOW_FADE_FAR the blob field is switched off for a constant 0.5
// (invisible at that range, ~145 ALU), and an impostor's normal is uniform over
// the quad by construction -- exactly vertical on the spun billboard. Both terms
// of drift go constant, the quad crosses the threshold as ONE UNIT, and a tree
// is pure white or pure green with nothing between. At the shipping constants
// that flips at a load of 0.306, so with the foliage cap at 0.25-0.6 it whitens
// about five trees in six.
//
// SO A CARD TAKES ITS OWN INSTANCE'S SNOW LOAD AS A COVERAGE FRACTION instead,
// once the noise that would have broken it up is gone. That load already carries
// the per-tree roll, so the far forest varies tree to tree the way it did up
// close, and it is free -- the shader has the number either way. Near enough for
// the blob field to still run, the threshold is still the better picture and
// still what draws; the two crossfade on the same `snowNear` that fades the
// noise, so nothing pops.
//
// The recipe and the fade were tuned against meshes, and a noise-dominated
// recipe survives being flattened onto a card only while there IS noise. Past
// 40 m there is none left to dominate.
export const SNOW_CARD_LAYERS = [
  LAYER.IMPOSTOR_PINE,
  LAYER.IMPOSTOR_OAK,
  LAYER.IMPOSTOR_BIRCH,
  LAYER.IMPOSTOR_ASPEN,
  LAYER.IMPOSTOR_DEADWOOD_SNAG,
  LAYER.IMPOSTOR_DEADWOOD_LOG,
]

// --- and which layers snow settles on AS STONE rather than as foliage --------
//
// Same uniform, same noise at the same size, same one material -- a second list
// rather than more entries in the first, because a boulder fills in from the top
// down more decisively than a canopy does. Both are patches of noise; stone
// leans twice as hard on which way the surface faces, so the top whitens first
// and an underside goes last. That is ONE weight, SNOW_ROCK_UP in
// src/material.js, where the reasoning lives -- including why leaning harder
// than that is wrong on a faceted rock.
//
// The lists must stay DISJOINT: a layer in both is counted by both masks and
// takes the foliage weight, which is silently the wrong look rather than an
// error. scripts/check-rocks.mjs gates it.
//
// THE ROCK CARDS are out for a sharper reason than the fern cards. A rock card
// cannot wear the stone lean at all -- its normals are outward and horizontal by
// construction (impostor.js), so every fragment reads as a sheer face and the
// lean has nothing to bite on. So a snowed rock's LOD2 shows bare stone, one
// more entry on the bench's case against a rock card; if the ladder ever ships
// one, the card has to bake its snow in.
export const SNOW_ROCK_LAYERS = [LAYER.ROCK]

// --- and the same recipe again, on WOOD --------------------------------------
//
// Wood fills in from the top down exactly as stone does, and the brief stone was
// written against fits a log word for word: the upper surface whitens first, the
// flanks are about half covered by the time the top is solid, the underside goes
// last. So this takes the SAME weight -- SNOW_ROCK_UP in src/material.js -- and
// is a separate NAME rather than a separate recipe. material.js concatenates the
// two into one uniform because "surfaces that fill in from the top down" is ONE
// family; they are two lists because "stone" and "wood" are two facts, and the
// day one wants its own weight the split is already made.
//
// THIS IS A REAL CHANGE TO WHAT SHIPS: tree TRUNKS now snow. Before, a winter
// forest was white canopies on bare brown trunks -- while the LOD2 impostor of
// the same tree, a photograph of the WHOLE tree, whitened as one picture. The
// mesh tiers and the card tier disagreed across an LOD boundary; this removes an
// inconsistency that was already shipping rather than inventing a look.
//
// TIMBER_BEAM carries it onto buildings, since it is what every raw member wears
// -- log courses, posts, rails, jambs. A log wall is a stack of logs, and snow on
// a log is snow on a log whether somebody built with it or it fell over.
//
// Must stay DISJOINT from SNOW_LAYERS on exactly the stone list's terms: a layer
// in both is counted twice and silently takes the foliage weight.
export const SNOW_WOOD_LAYERS = [LAYER.BARK, LAYER.BARK_BIRCH, LAYER.BARK_PINE, LAYER.TIMBER_BEAM]

// --- and which layers moss grows on ------------------------------------------
//
// A third list, and unlike the two above it selects whether MOSS_APPLY runs at
// all rather than which weight. Snow recolours what is already there; moss lays
// a SECOND TEXTURE over it, so this is the set of surfaces paying an extra atlas
// fetch -- a reason to keep it short.
//
// STONE AND WOOD. Bark was out for one stated reason -- moss up a trunk wants a
// HEIGHT cue, because it grows at the foot and gives out a metre or two up, and
// the rock recipe had none -- and that is now answered: MOSS_RISE in
// src/material.js measures from the instance's OWN root rather than sea level,
// so a standing trunk is green at the foot and clean at the break. A FALLEN LOG
// then needs no special case, which is what makes the cue worth having rather
// than bolted on for snags: every part of a log on the ground is within a
// diameter of its own root height, so the cue reads ~1 end to end and it is
// mossy the whole way.
//
// THE ROCK CARDS are out for a duller reason than in the snow lists: a card is
// photographed from the mesh, so if the mesh was mossy when baked, the moss is
// already in the picture and mossing it again would double it.
export const MOSS_LAYERS = [LAYER.ROCK, LAYER.BARK, LAYER.BARK_BIRCH, LAYER.BARK_PINE, LAYER.TIMBER_BEAM]

// --- what LAYER.ROCK actually looks like -------------------------------------
//
// The mean of rocks/stone.png in LINEAR space, per channel. Measured off the
// shipped file (scripts/check-rocks.mjs re-measures it and fails if these drift
// more than 2%), and it lives here rather than beside either of its two callers
// because it is a property of the TILE and both of them need it for the same
// reason: to divide the photograph's own brightness and warmth back out.
//
// stone.png is a photograph of granite -- warm, and dark at a mean luma of
// 88/255. Anything that multiplies it by an authored colour has to know that, or
// it is not tinting the tile, it is tinting the tile AND darkening it AND
// pushing it further orange. rock-bank.js divides by this to turn a tint into a
// destination rather than a reduction; terrain-material.js divides by it to turn
// the tile into a neutral contrast field it can lay over a cliff without moving
// the terrain palette.
export const ROCK_TILE_MEAN = [0.1148, 0.0933, 0.077]

// --- and the same number for the two GROUND tiles ----------------------------
//
// Measured off the shipped files by tools/props/cut-terrain.mjs, which prints
// them at the end of every run to be copied here. Same purpose as
// ROCK_TILE_MEAN: terrain-material.js divides the tile by this, turning a
// photograph into a contrast field averaging (1,1,1), so the tile adds grain and
// colour VARIATION and moves the palette neither darker nor warmer.
//
// A STALE VALUE DOES NOT FAIL, it quietly regrades every metre of ground in the
// world -- the divide is a multiply by 1/mean, so a copy 20% low makes the whole
// meadow 20% brighter. Hence the gate: scripts/check-rocks.mjs re-measures both
// PNGs and fails on more than 2% drift, the same guard ROCK_TILE_MEAN has.
//
// The two PLACEHOLDER constants are the sRGB bytes these means decode from.
// buildTextureArray fills the slices with them flat, so for the few frames
// before loadImageLayers lands the field is exactly 1.0 and the ground is the
// untextured palette rather than -- as an unpatched transparent-black slice
// would make it -- black.
export const GRASS_TILE_MEAN = [0.0502, 0.0813, 0.0177]
export const SNOW_TILE_MEAN = [0.3419, 0.3467, 0.3663]
export const TERRAIN_GRASS_PLACEHOLDER = [63, 81, 36]
export const TERRAIN_SNOW_PLACEHOLDER = [158, 159, 163]

// ---------------------------------------------------------------------------
// How many world METRES one [0,1] UV span of a tiling layer covers.
//
// This table is why buildings need no per-face UV unwrapping: every surface the
// parts kit emits takes its UVs from world-space extents divided by the entry
// here, so a 3.6 m log wall gets u from 0 to 4 and RepeatWrapping does the rest.
// The payoff is two things. Texel density is automatically constant -- a cottage
// wall and an inn wall get the same log courses per metre without anyone
// deciding, which is what most makes a procedural kit look authored. And nothing
// has to be re-UV'd when a mass is resized; the previewer's sliders change
// extents freely and the texture covers more wall.
//
// The NUMBERS are art direction and belong to the previewer, not to a spec: they
// answer "how big is one log", tuned by eye against a 1.75 m door. Layers absent
// from this table are decal sheets, addressed by island and never scaled.
// ---------------------------------------------------------------------------
export const TILE_METRES = {
  // These follow the SHIPPED tile, not the generator that stands in for it for
  // the first few frames: the photograph is what the player looks at, so it is
  // the photograph's content that has to be the right size. Where the two
  // disagree the generator is briefly the wrong scale, which is invisible.
  [LAYER.TIMBER_BEAM]: 0.84, // 2 log courses per tile -> a 0.42 m log
  [LAYER.TIMBER_HEWN]: 0.9, // 3 rough boards per tile -> a 0.3 m board
  [LAYER.TIMBER_PLANK]: 0.72, // 3 sawn boards per tile -> a 0.24 m board
  [LAYER.THATCH]: 1.6, // 3 courses per tile
  [LAYER.SHINGLE]: 2.2, // 6 x 6 shakes per tile -> a 0.37 m shake
  [LAYER.ROOF_TILE]: 1.35, // 5 x 6 pantiles per tile -> a 0.27 x 0.22 m tile
  [LAYER.STONE]: 2.4, // roughly 8 rubble stones across -> a 0.3 m stone
  [LAYER.PLASTER]: 2.2, // deliberately large; the panel should read as flat
  [LAYER.THATCH_FRINGE]: 1.6, // matches THATCH so straws line up across the eave
  [LAYER.GLASS]: 0.46, // 2 x 2 panes per tile -> a 0.23 m quarry
  // LAYER.ROCK IS DELIBERATELY ABSENT, and it is the one exception to everything
  // said above. It had an entry here (0.9 m) on exactly the argument this table
  // makes: constant texel density, so a 12 cm cobble and a 14 m outcrop wear the
  // same size of crystal. It looks wrong, because a building is made of parts
  // whose real size the player knows -- a log, a shake, a pane -- and a rock is
  // not. Under a fixed tile a big rock is just the same speckle repeated more
  // times, which reads as fabric. So rock.js sizes its tile as a fraction of the
  // ROCK (`texRepeat`, plus a per-seed jitter) and never asks this table.
}

// Layers whose pixels come from a PNG rather than from a generator here.
// Relative URLs, because vite.config.js sets `base: './'`.
//
// The tree layers are cut from EZ-Tree's art by `tools/trees/gen-layers.mjs`.
// The two thatch layers are cut from the thatch photograph by
// `tools/props/extract-thatch.mjs` (DESIGN.md §19).
//
// Note that every building layer here, and BARK, BARK_BIRCH, NEEDLES and
// LEAVES, ALSO have procedural generators below and are filled by them first:
// `loadImageLayers` patches over that a few frames later, so a trunk is
// placeholder bark for an instant rather than invisible. Do not delete those
// generators thinking they are dead.
//
// The building tiles are cut from the photographs in tmp/building-src/ by
// `tools/buildings/cut-tiles.mjs`, which is also where the reasoning for each
// crop, flip and grade lives.
export const IMAGE_LAYERS = {
  [LAYER.FROND_0]: 'ferns/fern_frond_0.png',
  // Cut from stone-1.jpg by `tools/props/cut-rock.mjs`, which is also where the
  // argument for grading it bright and near-neutral lives: it is one tile for
  // every rock in the world, and the environments are told apart by a
  // per-instance TINT rather than by more layers.
  [LAYER.ROCK]: 'rocks/stone.png',
  // Cut from moss.png by `tools/props/cut-moss.mjs`, which is where the argument
  // for grading it to a final colour rather than to tint headroom lives.
  [LAYER.MOSS]: 'rocks/moss.png',
  [LAYER.THATCH]: 'buildings/thatch.png',
  [LAYER.THATCH_FRINGE]: 'buildings/thatch_fringe.png',
  [LAYER.TIMBER_BEAM]: 'buildings/timber_beam.png',
  [LAYER.TIMBER_HEWN]: 'buildings/timber_hewn.png',
  [LAYER.TIMBER_PLANK]: 'buildings/timber_plank.png',
  [LAYER.SHINGLE]: 'buildings/shingle.png',
  [LAYER.ROOF_TILE]: 'buildings/roof_tile.png',
  [LAYER.STONE]: 'buildings/stone.png',
  [LAYER.GLASS]: 'buildings/glass.png',
  [LAYER.DOOR]: 'buildings/door.png',
  [LAYER.BARK]: 'trees/bark_oak.png',
  [LAYER.BARK_BIRCH]: 'trees/bark_birch.png',
  [LAYER.BARK_PINE]: 'trees/bark_pine.png',
  [LAYER.NEEDLES]: 'trees/leaf_pine.png',
  [LAYER.LEAVES]: 'trees/leaf_oak.png',
  [LAYER.LEAF_ASH]: 'trees/leaf_ash.png',
  [LAYER.LEAF_ASPEN]: 'trees/leaf_aspen.png',
  [LAYER.SPRAY_PINE]: 'trees/spray_pine.png',
  [LAYER.LEAF2_PINE]: 'trees/leaf2_pine.png',
  [LAYER.LEAF2_OAK]: 'trees/leaf2_oak.png',
  [LAYER.LEAF2_ASH]: 'trees/leaf2_ash.png',
  [LAYER.LEAF2_ASPEN]: 'trees/leaf2_aspen.png',
  [LAYER.MAT_PINE]: 'trees/mat_pine_128.png',
  [LAYER.MAT_OAK]: 'trees/mat_oak.png',
  [LAYER.MAT_ASPEN]: 'trees/mat_aspen_128.png',
  [LAYER.MAT_BIRCH]: 'trees/mat_birch.png',
  // Cut from EZ-Tree's grass.glb by tools/trees/layers.py, which also copies it
  // here. IMPOSTOR_GRASS is deliberately absent: it is baked at load from this
  // one (grass-bank.js), the same way the tree and fern cards are.
  //
  // It is the one layer that does not reach the array as the file has it: the
  // foot of the picture is frayed on the way in. See LAYER_SHAPERS.
  [LAYER.GRASS_TUFT]: 'grass/grass_tuft.png',
  // The two ground tiles, cut by tools/props/cut-terrain.mjs. Unlike everything
  // above them these are sampled by the TERRAIN shader rather than worn by any
  // geometry -- see the note at LAYER.TERRAIN_GRASS -- which is the same
  // arrangement LAYER.MOSS has.
  [LAYER.TERRAIN_GRASS]: 'terrain/grass.png',
  [LAYER.TERRAIN_SNOW]: 'terrain/snow.png',
}

// Deterministic value noise so the placeholder looks the same every run.
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function tile(fn, seed) {
  const n = TEX_SIZE
  const data = new Uint8Array(n * n * 4)
  const rand = mulberry32(seed)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4
      const [r, g, b, a] = fn(x / n, y / n, rand, x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return data
}

const mix = (a, b, t) => a + (b - a) * t

// Vertical streaking, which is what reads as bark at this resolution.
function bark(base, streak, seed) {
  return tile((u, v, rand) => {
    const s = Math.sin(u * Math.PI * 14 + Math.sin(v * 5) * 1.4) * 0.5 + 0.5
    const t = s * 0.6 + rand() * 0.4
    return [
      mix(base[0], streak[0], t),
      mix(base[1], streak[1], t),
      mix(base[2], streak[2], t),
      255,
    ]
  }, seed)
}

function mottled(base, alt, scale, seed) {
  return tile((u, v, rand) => {
    const s =
      Math.sin(u * Math.PI * scale) * Math.sin(v * Math.PI * scale) * 0.5 + 0.5
    const t = s * 0.5 + rand() * 0.5
    return [
      mix(base[0], alt[0], t),
      mix(base[1], alt[1], t),
      mix(base[2], alt[2], t),
      255,
    ]
  }, seed)
}

// Seamless fractal value noise, as a grey height field -- LAYER.ROCK_BUMP, and the
// only generator here whose output is never looked at directly.
//
// SEAMLESS IS THE WHOLE DIFFICULTY. Every other tile above is per-pixel `rand()`,
// which hides its edges because white noise has no structure to break; a bump map
// is read through a DERIVATIVE, so a discontinuity at the tile edge is not a faint
// seam but a bright line of wrongly-lit pixels ruled across the rock every repeat.
// Hence a lattice hash that wraps at the octave's period, which makes the tile join
// itself exactly.
//
// FOUR OCTAVES FROM 8 CELLS, halving in amplitude. The coarse ones are the pocking
// that catches a low sun; the fine ones are what the eye reads as grit up close and
// what the mip chain quietly removes as the rock recedes.
function latticeNoise(u, v, period, seed) {
  const x = u * period
  const y = v * period
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const wrap = (i) => ((i % period) + period) % period
  const x0 = wrap(ix)
  const y0 = wrap(iy)
  const x1 = wrap(ix + 1)
  const y1 = wrap(iy + 1)
  const at = (gx, gy) => {
    let h = Math.imul(gx | 0, 374761393) ^ Math.imul(gy | 0, 668265263) ^ Math.imul(seed | 0, 2246822519)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    h ^= h >>> 16
    return (h >>> 0) / 4294967295
  }
  const a = at(x0, y0)
  const b = at(x1, y0)
  const c = at(x0, y1)
  const d = at(x1, y1)
  return mix(mix(a, b, sx), mix(c, d, sx), sy)
}

function grit(seed) {
  return tile((u, v) => {
    let h = 0
    let amp = 1
    let norm = 0
    let period = 8
    for (let o = 0; o < 4; o++) {
      h += amp * latticeNoise(u, v, period, seed + o * 7919)
      norm += amp
      amp *= 0.5
      period *= 2
    }
    const g = Math.round(255 * (h / norm))
    return [g, g, g, 255]
  }, seed)
}

// A flat fill. The only generator here that is not trying to look like anything:
// it is what the two ground tiles stand in as, and its whole job is to be
// EXACTLY their mean, so the contrast field the terrain shader builds out of it
// is 1.0 and the untextured palette shows through unchanged. See the note on
// GRASS_TILE_MEAN for why a transparent slice will not do.
function flatFill([r, g, b]) {
  return tile(() => [r, g, b, 255], 0)
}

// Foliage carries genuine alpha cutouts so alphaTest is actually exercised
// rather than being a no-op that only bites us later.
function foliage(base, alt, seed, cutout) {
  return tile((u, v, rand) => {
    const s = Math.sin(u * Math.PI * 9) * Math.sin(v * Math.PI * 11) * 0.5 + 0.5
    const t = s * 0.55 + rand() * 0.45
    const a = cutout && rand() < 0.18 ? 0 : 255
    return [
      mix(base[0], alt[0], t),
      mix(base[1], alt[1], t),
      mix(base[2], alt[2], t),
      a,
    ]
  }, seed)
}

export function buildTextureArray() {
  const n = TEX_SIZE
  const layers = new Array(LAYER_COUNT)

  layers[LAYER.BARK] = bark([61, 43, 31], [96, 71, 52], 11)
  layers[LAYER.BARK_BIRCH] = bark([206, 202, 191], [74, 70, 66], 12)
  layers[LAYER.NEEDLES] = foliage([28, 56, 34], [52, 88, 51], 13, true)
  layers[LAYER.LEAVES] = foliage([46, 82, 40], [88, 122, 55], 14, true)
  // The three tree layers added for src/props/tree.js. Same job as the four
  // above: stand in for the PNG for the few frames before loadImageLayers()
  // lands, tinted to roughly where the real art sits so the swap is not a
  // flash of a different colour. LEAF_ASPEN is yellow because EZ-Tree's aspen
  // atlas is in autumn.
  layers[LAYER.BARK_PINE] = bark([84, 46, 30], [132, 84, 56], 19)
  layers[LAYER.LEAF_ASH] = foliage([44, 76, 34], [96, 132, 58], 20, true)
  layers[LAYER.LEAF_ASPEN] = foliage([146, 108, 26], [214, 172, 52], 21, true)
  layers[LAYER.SPRAY_PINE] = foliage([28, 56, 34], [52, 88, 51], 22, true)
  // The warped cuts stand in as the SAME colour as the boxed cut of the same
  // species: they are the same photograph, differently framed.
  layers[LAYER.LEAF2_PINE] = foliage([28, 56, 34], [52, 88, 51], 23, true)
  layers[LAYER.LEAF2_OAK] = foliage([46, 82, 40], [88, 122, 55], 24, true)
  layers[LAYER.LEAF2_ASH] = foliage([44, 76, 34], [96, 132, 58], 25, true)
  layers[LAYER.LEAF2_ASPEN] = foliage([146, 108, 26], [214, 172, 52], 26, true)
  // The mats stand in SOLID, since the art is: a hole in a placeholder would
  // show the far side of a scoop through it for those frames.
  layers[LAYER.MAT_PINE] = foliage([28, 56, 34], [52, 88, 51], 27, false)
  layers[LAYER.MAT_OAK] = foliage([46, 82, 40], [88, 122, 55], 28, false)
  layers[LAYER.MAT_ASPEN] = foliage([150, 92, 28], [222, 156, 48], 29, false)
  layers[LAYER.MAT_BIRCH] = foliage([44, 76, 34], [96, 132, 58], 30, false)
  // ROCK now has a photograph over it (IMAGE_LAYERS), so this is a stand-in for
  // the few frames before it lands. Its light end is 138 against the PNG's mean
  // of 142, which is why the swap is invisible rather than a flash of a
  // different grey -- keep them together if either moves.
  layers[LAYER.ROCK] = mottled([92, 92, 96], [138, 137, 132], 7, 15)
  // Same job for moss, and here it matters more than usual: MOSS is only ever
  // read through a blend, so an unpatched transparent-black slice would not be
  // discarded by alphaTest -- it would paint the moss patches BLACK for the few
  // frames before the PNG lands. Light end 92/116/60 against the PNG's mean of
  // 73/93/48; keep them together if either moves.
  layers[LAYER.MOSS] = mottled([50, 66, 32], [92, 116, 60], 8, 23)
  layers[LAYER.SNOW] = mottled([222, 230, 240], [255, 255, 255], 5, 16)
  layers[LAYER.DIRT] = mottled([94, 76, 58], [126, 106, 82], 9, 17)
  layers[LAYER.GRASS] = foliage([58, 92, 44], [96, 130, 62], 18, false)

  // Building layers. These live in src/buildings/tiles.js rather than here
  // because they are ten times the code of the four generators above and this
  // file's job is to be the layer REGISTRY -- the thing you read to find out
  // what a texLayer value means. Which of them are provisional and which are
  // shipping art is argued there.
  layers[LAYER.TIMBER_HEWN] = tileLogs(n)
  layers[LAYER.TIMBER_PLANK] = tilePlanks(n)
  layers[LAYER.THATCH] = tileThatch(n)
  layers[LAYER.SHINGLE] = tileShingles(n)
  layers[LAYER.STONE] = tileStone(n)
  layers[LAYER.PLASTER] = tilePlaster(n)
  layers[LAYER.THATCH_FRINGE] = tileFringe(n)
  layers[LAYER.GLASS] = tileGlass(n)
  layers[LAYER.IRON] = sheetIron(n)
  layers[LAYER.RUNE] = sheetRunes(n)
  // The two photographic-only layers have no generator of their own, so they
  // borrow the nearest one purely to avoid a transparent hole in the frames
  // before loadImageLayers() lands: a pantile roof stands in as shakes (right
  // layout, wrong hue, for about three frames), and a door leaf as the plank
  // tile it used to be drawn with.
  layers[LAYER.ROOF_TILE] = tileShingles(n)
  layers[LAYER.DOOR] = tilePlanks(n)
  layers[LAYER.TIMBER_BEAM] = tileLogs(n)

  // Mushroom sheets. Unlike every generator above these are not stand-ins for a
  // PNG that is coming -- they are the art. See the LAYER entries.
  layers[LAYER.MUSHROOM_CAP] = mushroomCapSheet()
  layers[LAYER.MUSHROOM_CAP_CAVE] = mushroomCaveSheet()
  layers[LAYER.MUSHROOM_FLESH] = mushroomFleshSheet()

  // Crab sheet, same reasoning -- see the LAYER entry.
  layers[LAYER.CRAB_SHELL] = crabShellSheet()

  // Butterfly sheet, same reasoning -- see the LAYER entry.
  layers[LAYER.BUTTERFLY_WING] = butterflyWingSheet()

  // The two ground tiles. Flat at the shipped tiles' own means, so the terrain
  // is untextured for the few frames before the PNGs land rather than black.
  layers[LAYER.TERRAIN_GRASS] = flatFill(TERRAIN_GRASS_PLACEHOLDER)
  layers[LAYER.TERRAIN_SNOW] = flatFill(TERRAIN_SNOW_PLACEHOLDER)

  // The rock's height field. Shipping art, not a stand-in -- see the LAYER entry.
  layers[LAYER.ROCK_BUMP] = grit(37)

  // DataArrayTexture wants one contiguous buffer, layers back to back. Image
  // layers are left at zero -- fully transparent, so alphaTest discards them --
  // until loadImageLayers() patches their bytes in.
  const data = new Uint8Array(n * n * 4 * LAYER_COUNT)
  for (let i = 0; i < LAYER_COUNT; i++) {
    if (layers[i]) data.set(layers[i], i * n * n * 4)
  }

  const tex = new THREE.DataArrayTexture(data, n, n, LAYER_COUNT)
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  // Bilinear + mips is what the N64 actually did. Swap magFilter to
  // NearestFilter if we decide we want the crunchier PS1 look instead.
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// Real PNG layers.
//
// Called once at startup with the texture buildTextureArray() returned. The
// array is usable before this resolves -- image layers are transparent, so
// alphaTest discards them and a fern is simply invisible for the first frames
// rather than being a magenta rectangle.
//
// This is deliberately NOT tolerant. A layer that fails to load or arrives at
// the wrong size is a broken build, and the failure mode if we swallowed it is
// an invisible prop that nobody traces back to a 404 for a week. Throw.
// ---------------------------------------------------------------------------

async function decodeLayer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`texture layer ${url}: HTTP ${res.status}`)
  const bitmap = await createImageBitmap(await res.blob())
  if (bitmap.width !== TEX_SIZE || bitmap.height !== TEX_SIZE) {
    throw new Error(
      `texture layer ${url}: ${bitmap.width}x${bitmap.height}, but every layer ` +
        `of a DataArrayTexture must be ${TEX_SIZE}x${TEX_SIZE}`
    )
  }
  const canvas = new OffscreenCanvas(TEX_SIZE, TEX_SIZE)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Uint8Array(ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE).data.buffer)
}

// ---------------------------------------------------------------------------
// Layer SHAPERS: the one place a decoded PNG is edited on its way into the
// array. A layer whose pixels are wrong should be fixed in the tool that cuts
// it, so there is exactly one entry here and the bar for a second is high.
//
// WHY GRASS_TUFT IS THE EXCEPTION. Its pixels are lifted whole out of EZ-Tree's
// grass.glb by tools/trees/layers.py, which needs Blender to run and writes the
// same file the /props browser draws. What follows is not a fix to that cut --
// it is a decision about how the v2 CARPET stands on the ground, it wants to be
// tuned against a screenshot rather than against a Blender run, and the PNG on
// disk stays the art as EZ-Tree drew it.
// ---------------------------------------------------------------------------

// The tuft PNG's bottom quarter is its densest and darkest -- 45-52% of each row
// opaque against 4-20% higher up, mean luminance 81-120 against 160-190 -- and
// it ends in a straight cut at the last row. Every card in the carpet wears that
// same picture, so the bed shares ONE horizontal dark line, the most obviously
// synthetic thing about the grass.
//
// THE LINE THE EYE FINDS IS NOT THE CARD'S OWN EDGE. render/grass.js sinks every
// tuft by PLACEMENT.sink scaled with the instance -- a constant 0.04 / 0.55 =
// 7.3% of card height at any size -- so the terrain cuts the picture at v = 0.927
// and everything below is buried whatever we do here. The fray has to bite WELL
// above that line, which is what `top` is set against: the deepest column is cut
// 25 texels clear of the ground line. Confined to the bottom eighth it was work
// done underground, and the hem survived.
//
// EACH COLUMN GETS ITS OWN CUT HEIGHT and THE TEXEL'S OWN BRIGHTNESS LIFTS IT
// BACK, so the foot becomes a row of separate stalks instead of a hem: 21.5% of
// the tuft's opaque texels go, and at the ground row 33 of 58 survive, in clumps
// rather than a line. The terms are not weighted against each other -- the column
// roll sets a floor and brightness raises the texel from there toward the foot,
// so a fully lit blade reaches the bottom of the square in ANY column. That is
// what eats the dark away rather than shortening the card: the shadowed mass at
// the base of the clump goes and the lit blades through it stay, standing on the
// ground rather than hovering over it.
//
// AT LOAD, NOT IN THE FRAGMENT SHADER, and density settles it: grass is ~45% of
// the world's rasterised pixels (render/grass.js), so a per-fragment fray would
// recompute an unchanging decision some two million times a frame. Baking it
// into the layer also carries it into the far tier for nothing --
// bakeGrassImpostor photographs THIS layer after this has run, so the silhouette
// does not change across the LOD swap.
//
// WHAT THAT COSTS is that all 23,000 tufts are frayed identically. The same
// argument grass-bank.js makes for TUFT_TWIST being a constant applies unchanged
// -- per-instance yaw turns the pattern to a different azimuth, alternate cards
// read their u backwards, and the 0.5-1.5 m height range puts the cut at a
// different world height on every tuft -- and unlike the shader version it is
// free.
const GRASS_FRAY = {
  // Where the DEEPEST column is cut, in v (0 at the top of the card, 1 at its
  // foot). See above: the terrain's own cut is at 0.927, so the band between
  // this and 1 is mostly underground unless this is well clear of it. At 0.74
  // the deepest cut stands 25 texels above the ground line, which is 9.6 cm of
  // daylight under the shortest tuft in the bed and 29 cm under the tallest.
  // Deeper than this stops reading as stalks and starts reading as a tuft
  // hovering: by 0.66 the clump has lost the mass at its own base.
  top: 0.74,
  // The brightness percentiles OF A ROW that map to fully-eaten and fully-kept.
  // A texel in the 10th percentile of its own row is exposed to whatever its
  // column rolled; one in the 80th is protected outright and reaches the foot of
  // the card. Brightness does not SHARE the cut height with the column roll, it
  // LIFTS it -- see `edge` in frayGrassBase.
  //
  // PER ROW, NOT PER PICTURE, because the band gets darker as it descends: the
  // 90th centile of a row's luminance runs 0.71 at v = 0.8, 0.55 at 0.89 and
  // 0.44 at 0.96. Measured against one fixed window the bottom rows are ALL
  // below it, so nothing down there is ever bright enough to be spared and the
  // fray shortens the card instead of opening it up -- which is the failure this
  // replaced. Measuring each row against its own texels asks the question that
  // was wanted all along: is this a lit blade, or is it the shadow between two?
  pct: [0.1, 0.8],
  // Feather, in v. About 4 texels: enough that a cut column ends in a taper
  // rather than a step, short enough that the taper is not itself a line.
  soft: 0.035,
  // Wavelength in texels and weight, per octave of the column noise. 10 texels
  // is the width of a clump of blades and 3.5 is about one blade, so the foot
  // undulates and is nibbled at the same time.
  octaves: [[10, 0.6], [3.5, 0.4]],
  seed: 0x9e37,
}

/** The fray's tuning, exported so scripts/check-grass.mjs gates these numbers. */
export const GRASS_FRAY_TUNING = GRASS_FRAY

/**
 * A cut height per texture column, in 0..1, from smoothed value noise.
 *
 * RANK-NORMALISED rather than scaled to its own range, and that is the whole
 * reason this is not two lines: a sum of octaves piles up around its mean, so
 * the raw field cuts nearly every column to nearly the same height and the fray
 * comes out as a slightly fuzzy straight line. Ranking spreads the cut depths
 * evenly across the columns while leaving their ORDER -- which is where the
 * clump-and-blade structure lives -- untouched.
 */
function frayColumnCut(width, seed, octaves) {
  const rand = mulberry32(seed)
  const raw = new Float32Array(width)
  for (const [wave, weight] of octaves) {
    const n = Math.max(2, Math.round(width / wave))
    const k = new Float32Array(n + 1)
    for (let i = 0; i < n; i++) k[i] = rand()
    k[n] = k[0] // wraps, so the two halves of a mirrored card still meet
    for (let x = 0; x < width; x++) {
      const s = (x / width) * n
      const i = Math.floor(s)
      const f = s - i
      raw[x] += weight * (k[i] + (k[i + 1] - k[i]) * (f * f * (3 - 2 * f)))
    }
  }
  const order = Array.from({ length: width }, (_, i) => i).sort((a, b) => raw[a] - raw[b])
  const cut = new Float32Array(width)
  order.forEach((x, r) => { cut[x] = r / (width - 1) })
  return cut
}

/**
 * Eat the foot of the grass tuft away, darkest texels first, in place.
 *
 * See GRASS_FRAY for what this is for and why it happens here. `px` is one
 * decoded TEX_SIZE^2 RGBA layer.
 */
/**
 * The luminance window for ONE row of the band: the `pct` percentiles of its own
 * opaque texels. Null when the row is too sparse or too flat to rank -- a few
 * blade tips have no shadow between them to eat, and dividing by their spread
 * would turn rounding into a decision.
 *
 * Rows are independent, so it does not matter that `frayGrassBase` is mutating
 * the rows above this one as it goes.
 */
function frayRowWindow(px, y, [pLo, pHi]) {
  const lum = []
  for (let x = 0; x < TEX_SIZE; x++) {
    const i = (y * TEX_SIZE + x) * 4
    if (px[i + 3] === 0) continue
    lum.push((px[i] + px[i + 1] + px[i + 2]) / 765)
  }
  if (lum.length < 8) return null
  lum.sort((a, b) => a - b)
  const at = (p) => lum[Math.round(p * (lum.length - 1))]
  const lo = at(pLo)
  const hi = at(pHi)
  return hi - lo < 0.02 ? null : [lo, hi]
}

function frayGrassBase(px) {
  const { top, pct, soft, octaves, seed } = GRASS_FRAY
  const cut = frayColumnCut(TEX_SIZE, seed, octaves)
  for (let y = 0; y < TEX_SIZE; y++) {
    const v = (y + 0.5) / TEX_SIZE
    if (v <= top) continue
    const win = frayRowWindow(px, y, pct)
    if (!win) continue
    const [lumLo, lumHi] = win
    for (let x = 0; x < TEX_SIZE; x++) {
      const i = (y * TEX_SIZE + x) * 4
      if (px[i + 3] === 0) continue
      const l = clamp01(((px[i] + px[i + 1] + px[i + 2]) / 765 - lumLo) / (lumHi - lumLo))
      // The v this texel is cut at. The column's roll sets a FLOOR somewhere in
      // top..1, and the texel's own brightness lifts it from there toward the
      // card's foot -- so a fully lit texel lands at exactly 1 whatever column
      // it stands in, and stays in contact with the bottom of the square. That
      // is the difference between eating the dark away and merely shortening
      // the card: a weighted average of the two terms (which is what this was)
      // caps even the brightest blade below 1 in a deep column, so the whole
      // silhouette lifts off the edge together and the hem comes back higher up.
      const base = top + (1 - top) * cut[x]
      const edge = base + (1 - base) * l
      px[i + 3] = Math.round(px[i + 3] * (1 - smoothstep01(edge, edge + soft, v)))
      // Flood what is now clear to white, the same rule and for the same reason
      // as tools/trees/layers.py's: mip generation averages RGB without regard
      // to alpha, so leaving the eaten texels their dark colour would bleed a
      // dark rim back along the fray one mip down -- which is the line this is
      // here to remove, redrawn softer.
      if (px[i + 3] < 128) px[i] = px[i + 1] = px[i + 2] = 255
    }
  }
  return px
}

/** Layer -> a transform applied to its decoded pixels before they are uploaded. */
const LAYER_SHAPERS = {
  [LAYER.GRASS_TUFT]: frayGrassBase,
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep01(a, b, x) {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/**
 * Patch every entry of IMAGE_LAYERS into `tex` in place. Loads in parallel and
 * uploads once, because each `needsUpdate` re-uploads the whole array and
 * regenerates every mip chain -- doing that per layer would cost LAYER_COUNT
 * times more than doing it once at the end.
 */
export async function loadImageLayers(tex, sources = IMAGE_LAYERS) {
  const entries = Object.entries(sources)
  const decoded = await Promise.all(entries.map(([, url]) => decodeLayer(url)))
  const stride = TEX_SIZE * TEX_SIZE * 4
  entries.forEach(([layer, url], i) => {
    const shaper = LAYER_SHAPERS[layer]
    tex.image.data.set(shaper ? shaper(decoded[i]) : decoded[i], Number(layer) * stride)
  })
  tex.needsUpdate = true
  return entries.length
}

/**
 * Run a layer's shaper over pixels that did not come through `loadImageLayers`.
 * Node-side checks decode the PNG themselves, and a gate that measured the file
 * rather than what the array holds would pass over any change to the fray.
 */
export function shapeImageLayer(layer, px) {
  const shaper = LAYER_SHAPERS[layer]
  return shaper ? shaper(px) : px
}
