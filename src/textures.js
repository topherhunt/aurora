import * as THREE from 'three'
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

// ---------------------------------------------------------------------------
// The one prop texture. Every prop texture in the world is a layer of this.
//
// The shipping art direction is low-poly geometry with N64-resolution textures
// (Ocarina of Time / a lower-res Skyrim), NOT flat-shaded untextured low-poly.
//
// WHY AN ARRAY AND NOT A PACKED ATLAS PNG. This is the load-bearing decision of
// the whole texture pipeline, and packing everything into one big image is the
// obvious idea that does not work:
//
//   Mips bleed. In a packed atlas the mip chain is built over the WHOLE image,
//   so at coarse levels a leaf averages with whatever tile sits next to it.
//   That is not "blurry at distance", which is fine and expected -- it is a
//   leaf turning bark-brown. Array layers each mip independently, so distance
//   blur stays within one texture and never picks up a neighbour's colour.
//
//   Atlas tiles cannot wrap. A sub-rectangle has no repeat mode, so bark cannot
//   tile up a trunk -- UVs past 1.0 walk into the next tile. Array layers get
//   the full [0,1] space and real RepeatWrapping, which is exactly what a trunk
//   needs and a frond card does not.
//
// And an array costs the same as an atlas at the thing atlases exist for: ONE
// texture binding, so one material, so BatchedMesh collapses everything into a
// single multi-draw call (DESIGN.md §5). We get the draw-call win without the
// two costs above.
//
// ONE MESH, SEVERAL LAYERS. `texLayer` is a per-VERTEX attribute, not a
// per-object uniform, so a single geometry in a single batch can wear different
// textures on different parts of itself. A tree's trunk vertices carry BARK
// while its canopy cards carry NEEDLES or LEAVES; one draw call, one material,
// no split. `src/props.js` already assigns layers this way per material group.
// Adding a species means adding a layer, not a material.
//
// THE ONE REAL CONSTRAINT: every layer in a DataArrayTexture must share
// dimensions and format. TEX_SIZE is therefore an invariant of the whole asset
// pipeline, not a knob -- see the note on it below.
//
// Layers come from two places. Procedural tiles (below) are placeholders that
// exist so the spike exercises the real path -- one sampler2DArray, alphaTest,
// mipmaps -- and are not meant to look good. Image layers are real PNGs loaded
// from `public/`, which is where the fern fronds and the baked prop layers live.
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
  // sheet: coverage 31.2/36.3/30.3%, mean RGB (28,41,4)/(28,40,4)/(29,44,1),
  // and side by side the only differences are that one is slightly gappier at
  // the top and another slightly blunter at the tip. On a card 0.38 as wide as
  // it is tall, at 128px, from two metres, that is nothing.
  //
  // THE RULE THIS SETS, because trees and grass are next: a layer has to earn
  // itself by reading as different AT THE DISTANCE IT WILL BE SEEN. Scan-to-scan
  // noise between two photographs of the same plant does not. Species-to-species
  // leaf shape does. So: one leaf layer per tree SPECIES, one shared bark, one
  // grass -- not three variants of each. The variety a player actually sees
  // comes from geometry (16 mesh variants x yaw x scale x per-frond jitter),
  // and geometry is where it should be bought.
  //
  // The cost of being wrong here is small in both directions: another layer is
  // 64 KB, no draw call and no per-frame cost, so if three fronds that genuinely
  // differ ever turn up, adding them back is a two-line change.
  FROND_0: 8,

  // --- buildings (DESIGN.md §19) -------------------------------------------
  //
  // Ten layers here, plus ROOF_TILE, DOOR and TIMBER_BEAM appended at the end
  // of the registry once real photographic sources for them turned up. Thirteen
  // is what it takes to make a building read as ONE object rather than as a
  // pile of parts. The test each of them passed is the one FROND_0 sets -- a
  // layer has to read as different at the distance it will be seen -- and three
  // candidates failed it and are not here:
  //
  //   Slate roof. It is SHINGLE at a colder tint and a lower value. At 128 px
  //   from the 15 m a roof is normally seen at, the shake pattern is what you
  //   read and the hue is what tells you the material, and hue is free.
  //
  //   Chimney masonry. It is STONE. A chimney and a plinth are the same rubble
  //   laid by the same hands on the same building; if we later want dressed
  //   ashlar for a manor chimney that is a new layer for a new BUILDING class,
  //   not a second version of this one.
  //
  //   Moss on thatch. Not a texture -- it is a per-vertex colour multiply
  //   driven by roof height, normal and distance from the eave, which costs
  //   zero layers and zero triangles and varies per building for free.
  //
  //   There IS a moss texture now (LAYER.MOSS), and a roof could join
  //   MOSS_LAYERS the day somebody wants it: the second blended pass it needs
  //   turned out to cost a branch and a fetch inside the one shared material
  //   rather than a second material, so the batch-splitting argument that used
  //   to end this paragraph was wrong. The per-vertex multiply stays anyway,
  //   because what it is doing on a roof is not what moss does on a rock: it is
  //   a WEATHERING gradient -- damp at the eave, bleached at the ridge -- and a
  //   tiled photograph cannot express a gradient that runs the length of a
  //   surface. If a roof ever wants real moss clumps, it wants BOTH.
  //
  // 13 building layers x 64 KB = 832 KB, taking the array from 9 to 26 of the
  // 256 layers §9 measured as available.
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
  // cropped tight, because the scanned props in src/props.js address it.
  SPRAY_PINE: 22,

  // --- buildings, second pass (real photographic sources) -------------------
  //
  // Three layers the first nine could not cover, appended for the same reason
  // the tree layers were: an index is baked into every shipped `texLayer`, so
  // this list only ever grows at the end.
  //
  // ROOF_TILE is the one that contradicts the argument made above for slate.
  // That argument stands -- slate is a shake in a colder hue, and hue is free
  // -- and it is precisely why a scalloped pantile is NOT: its silhouette is a
  // row of half-circles where a shake roof is a row of rectangles, and
  // silhouette is the thing that survives 128 px from fifteen metres. A tint
  // cannot round a corner.
  //
  // DOOR is a decal sheet, not a tiling layer: one photographed leaf addressed
  // 0..1 by island, the way IRON and RUNE are. It pays for itself in triangles
  // rather than costing them -- the scan already has its hinge straps and its
  // ring pull painted on, so doorway() stopped emitting six doubled decal quads
  // when this landed.
  //
  // TIMBER_BEAM is the split of what used to be one wood layer into the two
  // things a Nordic building is actually made of. TIMBER_HEWN was cut from a
  // squared beam and then had log-course shading multiplied into it, which made
  // it serve as round logs, as posts and as boarding all at once and read as
  // none of them well. The photograph here is a weathered baulk with the checks
  // and the splits still in it, and it is what every raw member wears -- log
  // courses, log ends, posts, rails, jambs. TIMBER_HEWN kept its own source and
  // is now rough-SAWN boarding: the porch deck, the soffit under an eave, the
  // wide planking that is cut but not planed. The distinction is worth 64 KB
  // because it is a silhouette distinction as much as a texture one; the beam
  // tile is what prism() members are lit by, and a plank tile on a five-sided
  // log is the one combination that makes the rounding look like a mistake.
  ROOF_TILE: 23, // red scalloped pantile -- the roof a prosperous inn has
  DOOR: 24, // decal sheet: one plank door leaf, ironwork included
  TIMBER_BEAM: 25, // raw uncut baulk -- log courses, posts, rails, every member

  // --- tree impostors (src/props/impostor.js) -------------------------------
  //
  // NOT ART. These four are the only layers in the registry with no source of
  // their own: they are written at load, by rendering the LOD0 tree of each
  // species side-on into a 128x128 target and reading the pixels back. That is
  // the same argument fern-bank.js makes for having no offline bake step --
  // an impostor generated from the mesh cannot disagree with the mesh, and a
  // PNG on disk can, silently, for as long as nobody looks.
  //
  // They pass the FROND_0 rule easily and in the opposite direction from
  // everything else here: what a player sees at 30 m IS this layer, so a pine
  // impostor and a birch impostor are not merely different textures, they are
  // different trees. One per SPECIES rather than per variant, because the
  // scatter already gives every instance a yaw and the card is three planes --
  // spinning it is three apparent silhouettes from one bake.
  //
  // They are also the only layers whose UVs are not tiled: an impostor is
  // addressed 0..1 exactly once, so RepeatWrapping must never reach them. The
  // bake leaves a transparent margin on three sides for exactly that reason.
  IMPOSTOR_PINE: 26,
  IMPOSTOR_OAK: 27,
  IMPOSTOR_BIRCH: 28,
  IMPOSTOR_ASPEN: 29,

  // --- fern impostors (src/props/fern-bank.js) ------------------------------
  //
  // Same machinery as the four above and the same "written at load, never on
  // disk" argument. What is different is the UNIT: a tree impostor is one per
  // SPECIES, and there is only one fern species, so the question becomes which
  // slice of a 16-variant bank earns a bake of its own.
  //
  // TWO, cut on `arch`, and the FROND_0 rule is what picks the axis. The card
  // takes over at 26 m (DESIGN.md §5), where a 0.55 m fern is about 20 px tall
  // -- small, but nowhere near the 3 px where everything is a smudge. At 20 px
  // an `arch` 0.6 fern is a narrow upright shuttlecock and an `arch` 2 one is a
  // wide flat spray, which is a silhouette apart and therefore earns a layer.
  // The other three axes do not: `pitch` 1.0 vs 1.4 tilts fronds a few degrees,
  // `fronds` 5 vs 9 changes coverage inside an outline that stays the same
  // shape, and `taper` only ever touched the last centimetre of a tip. Baking
  // all sixteen would spend 1 MB to redraw the same two outlines eight times
  // each; baking one would put every fern in the world at one silhouette.
  //
  // The variety a player sees at this range is still mostly per-instance: yaw
  // spins a crossed pair through four apparent silhouettes and `scale` is drawn
  // from [0.75, 1.35] (props/scatter.js), both of which cost nothing.
  //
  // The 20 px figure -- and so this whole call -- is arithmetic, not a looked-at
  // judgement. `gen-fern.html`'s `card` button is where it gets confirmed.
  IMPOSTOR_FERN_UPRIGHT: 30, // baked from the low-`arch` half of the bank
  IMPOSTOR_FERN_ARCHED: 31, // ...and the high-`arch` half

  // --- rock impostor (src/props/rock.js) ------------------------------------
  //
  // ONE scratch layer, and it is deliberately not yet a decision. The fern's
  // two layers were cut on `arch` because the bank was already settled and the
  // axis that survives to 26 px was known; the rock bank is not settled -- what
  // gen-rock.html exists for is to find out which shapes we actually want --
  // so committing N impostor layers now would be committing to a bank nobody
  // has chosen. The bench bakes into this one so the card tier can be LOOKED at
  // while the shapes are being picked, and the split into per-shape layers is a
  // thing to do once the shapes exist.
  //
  // Note that a rock's card is a much weaker idea than a fern's, and the bench
  // says so on screen: a fern is a lacy volume that a flat photograph flatters,
  // while a rock is an OPAQUE CONVEX LUMP whose whole read is the way its
  // facets catch the light as you walk past. Crossed planes give a rock a
  // visible X-shaped intersection where a fern's fronds hide it. The honest
  // ladder may well be "8-triangle LOD2, then cull" -- §5's boulder row already
  // assumes exactly that -- and the card button is how that gets confirmed
  // rather than assumed.
  IMPOSTOR_ROCK: 32,

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
  // Cut from a photograph by tools/props/cut-moss.mjs. Not a prop and not worn
  // by any geometry: nothing in the world carries MOSS as its `texLayer`. It is
  // sampled by the SHADER, as a second fetch laid over whatever the surface
  // already is, wherever MOSS_LAYERS says moss grows.
  //
  // That is what makes it worth a slot under §9's earns-its-layer rule, and the
  // arithmetic is unusually good: ONE layer puts moss on every rock in the
  // world, and on every trunk, snag, fallen log and building member with them,
  // at no triangles, no second material and no per-prop authoring. The
  // alternative -- mossy VARIANTS of the tiles that want moss -- costs a layer
  // per tile and still cannot vary within one surface.
  //
  // It is also the first layer that is deliberately NOT tintable. stone.png is
  // graded bright and neutral so a per-instance tint decides its hue; moss is
  // graded to its final colour, because moss on basalt and moss on sandstone are
  // the same green.
  MOSS: 35,

  // --- mushrooms (src/props/mushroom-texture.js) -----------------------------
  //
  // Three SHEETS, not three textures: each is a 2x2 grid of 64 px cells, and a
  // mushroom picks its cell by UV offset. So these three slots carry eight cap
  // colours and four fleshes -- twelve materials' worth of variety inside the
  // one shared prop material, at no extra draw call and no extra vertex
  // attribute. That is the whole reason mushrooms went this way instead of
  // getting a material of their own: they will be the most numerous and the
  // smallest prop in the world, and the smallest prop is the worst possible
  // thing to spend a draw call on.
  //
  // They are also the first layers with NO photograph behind them and none
  // coming. Everything else here that looks generated is a stand-in waiting for
  // loadImageLayers(); these are the shipping art, because a cap is a flat
  // colour, a rim shade and one pattern, and storing a photo of that would be
  // storing the output of a function. Zero bytes on disk, no `npm run props`,
  // and a new colour is an edit to an array rather than a trip through Blender.
  //
  // Split forest/cave by WHERE rather than by hue because that is the decision
  // the scatter makes, and because it keeps a cave's palette from bleeding into
  // a forest one across a mip boundary. FLESH is shared: gills and stalks are
  // the same picture at different contrast, argued in mushroom-texture.js.
  MUSHROOM_CAP: 36,
  MUSHROOM_CAP_CAVE: 37,
  MUSHROOM_FLESH: 38,

  // The mushroom's card tiers, ONE PHOTOGRAPH PER SPECIES. Written at load by
  // photographing the mesh, like the fern and grass impostors, so they are RAM
  // and zero bytes of disk and they cannot disagree with the geometry they stand
  // in for.
  //
  // Per SPECIES and not per variant, which is the whole reason there are five of
  // these and not thirty. mushroom-bank.js builds six shape variants of each
  // species and every one of them wears its species' single card at its own
  // width and height -- the same trade tree-bank makes for four sizes of pine,
  // and it costs less here, because a mushroom's variants differ by stem length
  // and cap dish rather than by having a different number of parts.
  //
  // Per species and not one for ALL of them, though, and that is the line worth
  // holding: at the range the card comes in these five are still five COLOURS --
  // a scarlet cap, a chestnut one, an amber funnel, a pale parasol and a dark
  // ink cap -- and colour is the last thing to survive as a prop shrinks. Shape
  // is what a card gives up; hue is what it is for. Five layers is 320 KB of the
  // array against 256 KB saved by sharing one, and sharing would put one hue on
  // the whole forest floor.
  //
  // Both card tiers of a species share its layer -- the two-plane cross at LOD1
  // and the spun billboard at LOD2 -- exactly as the four tree impostors do, and
  // for the same reason: they are the same photograph seen two ways, and
  // material.js's billboardVertex tells them apart by their vertex NORMAL rather
  // than by their layer. See the note on treeImpostorLayers.
  IMPOSTOR_MUSHROOM_AGARIC: 39,
  IMPOSTOR_MUSHROOM_PORCINI: 40,
  IMPOSTOR_MUSHROOM_CHANTERELLE: 41,
  IMPOSTOR_MUSHROOM_PARASOL: 42,
  IMPOSTOR_MUSHROOM_INKCAP: 43,

  // --- strewn litter (src/props/litter.js) ----------------------------------
  //
  // Written at load like the impostors above, and by the same argument, but
  // photographing something that never exists as a mesh at all: a few dozen
  // small stones dropped at random on a patch of ground, shot from STRAIGHT
  // ABOVE. The result is stamped on the terrain as a flat quad, so one layer
  // buys a whole square metre of stony ground for two triangles.
  //
  // WHY THIS EXISTS AT ALL: the scatter used to draw that look as geometry, at
  // a stone every 1.7 m across every cliff and every wood, and the stones were
  // 11 cm across. Forty-one of them for every rock big enough to read as a
  // rock, each costing a full BatchedMesh instance whatever its triangle count,
  // and the whole budget going to things too small to see. The look is worth
  // having and the geometry was not, which is exactly the trade a texture is
  // for. See the underfoot bed in v2/render/rocks.js for the other half.
  //
  // FOUR AND NOT ONE, because a single patch stamped over a hillside is a
  // repeat the eye finds immediately -- the same argument the mushroom cards
  // make for five layers over one, and it is cheaper here: the scatter gives
  // each stamp a yaw as well, so four layers times four right-angle turns is
  // sixteen apparent patches before mirroring. 256 KB for the set.
  //
  // NOT IN ANY SNOW LIST, and that is a decision rather than an oversight. The
  // ground under a litter patch is terrain, and terrain does its own snow in
  // its own shader; whitening the patch as well would put a second, differently
  // shaped snow line on top of the first one at the exact place they are
  // guaranteed to be compared. Bare stone showing through the ground's snow is
  // both the cheaper answer and the one that looks like wind-scoured scree.
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
  // A BLOCK OF 20, NOT ONE PER VARIANT, and the block is indexed by MATERIAL
  // rather than by building: one photograph per wall style x roof kind, and
  // every building wearing that pair borrows it. `IMPOSTOR_BUILDING` is the
  // base of the run and `IMPOSTOR_BUILDING + CARD_COMBOS.length - 1` is the top;
  // card.js owns the order and `LAYER_COUNT` below has to leave room for all of
  // it.
  //
  // The arithmetic is the whole argument. A photograph per variant is 148
  // slices of 64 KB -- 9.3 MB of texture to put 4-triangle specks on a
  // hillside, and 19 MB back when a card took two. Per material pair it is 20
  // slices, 1.25 MB, and it is complete: the four kinds' legal style x roof
  // grids union to exactly 20 and a cottage can be built for every one of them,
  // so a cottage is what gets photographed. What a distant building then wears
  // is the right WALL and the right ROOF at the wrong proportions, which is the
  // trade named in card.js and is worth about three pixels at the range the
  // card comes in.
  //
  // The cross still stands its two planes at the real building's own TRUE
  // widths and height, so the silhouette is the building's; only the picture
  // inside it is borrowed, and stretched to fit.
  IMPOSTOR_BUILDING: 50, // base of a 20-layer run, one per wall style x roof kind
}
export const LAYER_COUNT = 70

// --- which layers snow settles on (src/material.js, uSnow) -------------------
//
// Snow is a global uniform on the one shared prop material, so the shader has
// no idea what it is drawing except the layer index it was handed -- and that
// turns out to be exactly enough, because "is this foliage" IS a property of
// the layer. No vertex attribute, no second material, no geometry change.
//
// The four IMPOSTOR layers are in the list on purpose. They are pictures of a
// whole tree, trunk included, so snowing one whitens its trunk too -- which is
// now what the mesh tiers do as well, because the bark layers snow as wood (see
// SNOW_WOOD_LAYERS below). It was the right call even when they did not: a green
// tree at 130 m standing in a white forest is the worse error by a wide margin,
// and snow does sit along real branches anyway. The impostor bake is unlit and
// snow-free, so the card stays dynamic: turning snow up whitens LOD2 without
// rebaking. How MUCH it whitens them is SNOW_CARD_LAYERS' business, below --
// being in this list buys a card the foliage recipe, not the mesh's threshold.
//
// DELIBERATELY OUT, and each is one line to add: FROND_0, GRASS, GRASS_TUFT,
// and the fern and grass impostors. All of them would snow in a real winter,
// but they sit ON the ground, and the ground is a separate argument (a snowy
// world wants a snow-covered TERRAIN shader, not white ferns on green grass)
// that has not been had yet. A tree is IN because a canopy reads against the
// sky and can be believed on its own; nothing at ankle height can.
//
// An impostor always moves with the art it replaces. IMPOSTOR_FERN_* are out
// because FROND_0 is out and IMPOSTOR_GRASS is out because GRASS_TUFT is: a
// mesh plant and a card plant standing either side of an LOD boundary would
// otherwise be green and white. That is the same reasoning that puts the four
// TREE impostors IN -- they match the foliage they replace.
export const SNOW_LAYERS = [
  LAYER.NEEDLES,
  LAYER.LEAVES,
  LAYER.LEAF_ASH,
  LAYER.LEAF_ASPEN,
  LAYER.SPRAY_PINE,
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
// A subset of SNOW_LAYERS, not a rival to it: everything here is foliage and
// snows as foliage. What this list changes is HOW the snow is applied, and it
// exists because the ordinary recipe has a failure mode that only a card can
// hit.
//
// SNOW ON FOLIAGE IS A THRESHOLD, not a blend -- `drift > cut`, with a
// one-pixel rim. That works because drift VARIES across a real canopy: every
// leaf card faces its own way, and the blob field varies over the crown. A
// flat card has neither. Past SNOW_FADE_FAR the blob field is switched off for
// a constant 0.5 (it is invisible at that range and costs ~145 ALU), and an
// impostor's normal is uniform over the whole quad by construction -- exactly
// vertical on the spun billboard. So both terms of drift are constant, the
// quad crosses the threshold as ONE UNIT, and a tree is either pure white or
// pure green with nothing between. At the shipping constants that flips at a
// load of 0.306, so with the foliage cap at 0.25-0.6 it whitens about five
// trees in six.
//
// SO A CARD TAKES ITS OWN INSTANCE'S SNOW LOAD AS A COVERAGE FRACTION instead,
// once the noise that would have broken it up is gone. That load already
// carries the per-tree roll, so the far forest varies tree to tree the way it
// did up close, and it is free: the shader has the number in hand either way.
// Near enough for the blob field to still be running, the threshold is still
// the better picture and still what draws -- the two are crossfaded on the
// same `snowNear` that fades the noise, so nothing pops at the boundary.
//
// This is the one thing the SNOW_LAYERS note above got wrong when it said a
// noise-dominated recipe survives being flattened onto a card. It survives
// while there is noise. The recipe and the fade were tuned against meshes, and
// past 40 m there is no noise left to dominate.
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
// rather than more entries in the first one, because a boulder fills in from the
// top down more decisively than a canopy does. Both are patches of noise; stone
// simply leans twice as hard on which way the surface faces, so the top whitens
// first and an underside goes last. That is ONE weight, SNOW_ROCK_UP in
// src/material.js, and the reasoning lives with it -- including why leaning it
// any harder than that is the wrong answer on a faceted rock.
//
// The lists must stay DISJOINT. A layer in both would be counted by both masks
// and take the foliage weight, which is silently the wrong look rather than an
// error; scripts/check-rocks.mjs gates it.
//
// IMPOSTOR_ROCK is deliberately not here, and the reason is sharper than the one
// that keeps the fern cards out. A rock card cannot wear the stone lean at all:
// its normals are outward and horizontal by construction (impostor.js), so every
// fragment of it reads as a sheer face and the lean has nothing to bite on. The
// four TREE impostors are in the foliage list because a noise-dominated recipe
// does survive being flattened onto a card. So a snowed rock's LOD2 shows bare
// stone, which is one more entry on the bench's running case against a rock card
// (see LAYER.IMPOSTOR_ROCK above); if the ladder ever ships one, the card has to
// bake its snow in.
export const SNOW_ROCK_LAYERS = [LAYER.ROCK]

// --- and the same recipe again, on WOOD --------------------------------------
//
// Wood fills in from the top down exactly as stone does, and the brief stone was
// written against fits a log word for word: a fallen log's upper surface
// whitens first, its flanks are about half covered by the time that top is
// solid, and its underside is the last thing to go. So this list takes the SAME
// weight as stone -- SNOW_ROCK_UP, in src/material.js -- and it is a separate
// NAME rather than a separate recipe. material.js concatenates the two into one
// uniform because "surfaces that fill in from the top down" is ONE family; they
// are two lists here because "stone" and "wood" are two facts, and the day one
// of them wants its own weight the split is already made.
//
// THIS IS A REAL CHANGE TO WHAT SHIPS, and the honest way to put it is that tree
// TRUNKS now snow. What a winter forest looked like before was white canopies
// standing on bare brown trunks -- while the LOD2 impostor of the same tree,
// which is a photograph of the WHOLE tree, trunk included, whitened as one
// picture. So the mesh tiers and the card tier disagreed with each other across
// an LOD boundary, and this removes an inconsistency that was already shipping
// rather than inventing a look.
//
// TIMBER_BEAM carries the change onto buildings as well, because it is what
// every raw member of one wears -- log courses, posts, rails, jambs. That is the
// same answer for the same reason: a log wall is a stack of logs, and snow on a
// log is snow on a log whether somebody built with it or it fell over.
//
// Must stay DISJOINT from SNOW_LAYERS, on exactly the terms the stone list is: a
// layer in both is counted by both masks and then silently takes the foliage
// weight, which is a wrong picture rather than an error.
export const SNOW_WOOD_LAYERS = [LAYER.BARK, LAYER.BARK_BIRCH, LAYER.BARK_PINE, LAYER.TIMBER_BEAM]

// --- and which layers moss grows on ------------------------------------------
//
// A third list, and unlike the two above it does not select weights -- it
// selects whether MOSS_APPLY runs at all. Snow recolours what is already there;
// moss lays a SECOND TEXTURE over it, so this list is the set of surfaces that
// pay an extra atlas fetch, and that is a reason to keep it short.
//
// STONE AND WOOD. Bark was out of this list for one stated reason -- moss up a
// trunk wants a HEIGHT cue, because it grows at the foot and gives out a metre
// or two up, and the rock recipe had no notion of one -- and that reason is now
// answered: MOSS_RISE in src/material.js is the cue, measured from the
// instance's OWN root rather than from sea level, so a standing trunk is green
// at the foot and clean at the break.
//
// A FALLEN LOG then needs no special case at all, which is what makes the cue
// worth having rather than a thing bolted on for snags: every part of a log
// lying on the ground is within a diameter of its own root height, so the cue
// reads ~1 down the log's whole length and it is mossy end to end.
//
// IMPOSTOR_ROCK is out for a duller reason than it is out of the snow lists: a
// card is photographed from the mesh, so if the mesh was mossy when it was
// baked, the moss is already in the picture. Mossing it again would double it.
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

// ---------------------------------------------------------------------------
// How many world METRES one [0,1] UV span of a tiling layer covers.
//
// This table is why buildings do not need per-face UV unwrapping. Every surface
// the parts kit emits takes its UVs straight from world-space extents divided
// by the entry here, so a 3.6 m log wall gets u from 0 to 4 and RepeatWrapping
// does the rest. Two consequences worth stating because they are the payoff:
//
//   Texel density is automatically constant. A cottage wall and an inn wall get
//   the same number of log courses per metre without anyone deciding, which is
//   the single thing that most makes a procedural kit look authored.
//
//   Nothing has to be re-UV'd when a mass is resized. The previewer's sliders
//   change extents freely and the texture simply covers more of the wall.
//
// The NUMBERS are art direction and belong to the previewer, not to a spec:
// they are the answer to "how big is one log", and they are meant to be tuned
// by eye against a 1.75 m door. Layers absent from this table are decal sheets,
// which are addressed by island and never scaled.
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
  // Cut from EZ-Tree's grass.glb by tools/trees/layers.py, which also copies it
  // here. IMPOSTOR_GRASS is deliberately absent: it is baked at load from this
  // one (grass-bank.js), the same way the tree and fern cards are.
  //
  // It is the one layer that does not reach the array as the file has it: the
  // foot of the picture is frayed on the way in. See LAYER_SHAPERS.
  [LAYER.GRASS_TUFT]: 'grass/grass_tuft.png',
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

// The tuft PNG's bottom quarter is its densest and its darkest -- 45-52% of
// each row opaque against 4-20% higher up, mean luminance 81-120 against
// 160-190 -- and it ends in a straight cut at the last row. Every card in the
// carpet wears that same picture, so a bed of them shares ONE horizontal dark
// line, which is the most obviously synthetic thing about the grass.
//
// THE LINE THE EYE FINDS IS NOT THE CARD'S OWN EDGE. render/grass.js sinks
// every tuft by PLACEMENT.sink scaled with the instance, which is a constant
// 0.04 / 0.55 = 7.3% of the card's height at any size, so the terrain cuts the
// picture at v = 0.927 and the rows below that are buried whatever we do here.
// The fray therefore has to bite WELL above that line to be worth anything,
// which is what `top` is set against: the deepest column is cut 25 texels clear
// of the ground line, so that most of the band the fray works in is a band the
// player can see. Confined to the card's own bottom eighth it was work done
// underground, and the hem survived.
//
// EACH COLUMN OF THE PICTURE GETS ITS OWN CUT HEIGHT and THE TEXEL'S OWN
// BRIGHTNESS LIFTS IT BACK, so the foot of the card becomes a row of separate
// stalks instead of a hem: 21.5% of the tuft's opaque texels go, and at the
// ground row 33 of 58 survive, in clumps rather than in a line. The two terms
// are not weighted against each other: the column
// roll sets a floor and brightness raises the texel from there toward the foot
// of the card, so a fully lit blade reaches the bottom of the square in ANY
// column. That is what makes this eat the dark away rather than shorten the
// card -- the shadowed mass at the base of the clump goes and the lit blades
// running through it stay, standing on the ground rather than hovering over it.
//
// AT LOAD, NOT IN THE FRAGMENT SHADER, and the density is what settles it.
// Grass is about 45% of the world's rasterised pixels (render/grass.js), so a
// per-fragment fray would recompute a decision that never changes some two
// million times a frame. Doing it once into the layer also carries it into the
// far tier for nothing: bakeGrassImpostor photographs THIS layer after this has
// run, so the billboard is a picture of a frayed tuft and the silhouette does
// not change across the LOD swap.
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
