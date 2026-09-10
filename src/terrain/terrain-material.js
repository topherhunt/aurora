import THREE from '../three-instance.js'
import { LAYER, ROCK_TILE_MEAN, GRASS_TILE_MEAN } from '../textures.js'
import { GRIT_GRAD_SCALE, GRIT_LAYER, terrainDetailTextures } from './grit-texture.js'

// ---------------------------------------------------------------------------
// The terrain material: Lambert + vertex colours + FOUR TEXTURE FETCHES. The
// argument is DESIGN.md §7, which carries the measurements; this is the contract.
//
// THE FIELDS ARE BAKED, AND THAT WAS THE LARGEST PERFORMANCE DECISION IN THE
// RENDERER. It used to be ~20 evaluations of a hash-based value noise per
// fragment. On device: terrain hidden 85 fps, terrain drawn with STOCK Lambert
// 85, terrain drawn with this file's patch 30 -- same meshes, triangles, draw
// calls, fog and lights. The terrain was never triangle bound. See
// grit-texture.js for how the noise was baked and what a tileable texture costs
// that world-space noise does not.
//
// WHAT THE SURFACE IS MADE OF, coarsest to finest, each a channel of one of two
// 256 px tiles rather than a layer of its own:
//
//   MACRO      1024 m/tile, EVERY FRAGMENT AT EVERY DISTANCE. .a wanders the
//              snow line off the vertex grid, .r darkens and tints regions.
//   MACRO      137 m/tile, rotated ~37 deg, gated on the HAZE. Its own fbm runs
//              137 m down to ~4 m: the mid-range mottle.
//   GRIT       11.7 m/tile, colour inside FADE_FAR and relief out to
//              RELIEF_FAR. 4.6 cm a texel magnified NEAREST --
//              preview-stage.js's bench ground at the same texel size -- which is
//              the whole look, and the only thing on a hillside small enough to
//              move visibly, so it is what makes speed legible (1.45 m/s and
//              14 m/s look identical on a smooth slope). Its .gb carry the slope,
//              so the fetch that colours also lights.
//   GRIT       2.3 m/tile, rotated, inside MICRO_FAR. Sub-centimetre texels: the
//              fleck tint, the snow sparkle, the finest rung of relief. Also
//              what stops the 11.7 m sample reading as a repeating tile.
//
// FOUR FETCHES IS THE WORST CASE, near field only: three past 40 m, two past
// 95 m, one past the haze gate. THE FADES ARE ABOUT NOT PAYING for a fetch that
// has stopped changing the pixel, not about hiding a crawl -- a mipped texture
// cannot alias -- which is why every number below could move outward safely.
//
// THE MACRO PAIR DOES NOT FADE AND MUST NOT: everything past the near fades used
// to read flat green or flat grey, and the cause was never a thin palette, it
// was that the only thing varying the palette had already faded out.
//
// GRASS ALSO WEARS A PHOTOGRAPH -- one metre of meadow, tiled -- and where it
// applies the grit layers turn off rather than lying under it. See the
// GROUND_METRES block for why snow does not get one. Snow and rock keep the grit
// at every distance, and grass gets it back past GROUND_FAR at 150 m.
//
// This is a step-2 stand-in. §7's real material (splat blending, height-blend,
// triplanar, KTX2 arrays) replaces it at build step 6.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE NEAR FADES, and why they are so much tighter than they were.
//
// They used to run out to 95 m (grain), 40 m (micro) and 150 m (the meadow
// photograph), on the argument quoted below: a mipped texture cannot alias, so
// the only thing a fade buys is not PAYING for a fetch. That argument is sound
// about aliasing and it missed the other failure -- a TILE CAN REPEAT. The
// meadow photograph is one square metre; from fifty metres up, a hundred copies
// of it are on screen at once and the eye reads the lattice, not the blades. A
// mip cannot help with that, because the pattern is still perfectly resolved,
// it is just visibly periodic.
//
// So the rule now is: a layer's fade ends where its TILE would start reading as
// a grid, which is roughly where one repeat drops under about a degree of arc.
// For the 11.7 m grit that is ~26 m, for the 2.3 m fine grit ~16 m, and for the
// 1 m meadow ~30 m. Everything past those distances is carried by the macro
// pair, whose repeats are 137 m and 1 km.
//
// This is also the single biggest fill saving in the file, and it is free in
// the sense that matters: it removes fetches from fragments that were being
// made WORSE by them.
//
// Grain is at full strength inside FADE_NEAR and gone by FADE_FAR.
const FADE_NEAR = 8
const FADE_FAR = 26

// RELIEF OUTLIVES GRAIN, on the same fetch. The tiling argument above is about
// a pattern the eye can TRACE -- blotches of colour repeating in a lattice --
// and the .gb channels are not that. They are a slope, they reach the pixel
// only through N.L, and a repeated slope field reads as a rough hillside rather
// than as a grid. So the colour half of the coarse grit dies at FADE_FAR and
// the lighting half keeps going, which is why these are two fades and not one.
//
// 55 m is where the DATA gives out, not where the look does. The coarse tile's
// texels are 4.6 cm, so face-on they fall under the headset's ~8.6e-4 rad pixel
// at about 53 m and the sampler starts climbing the mip chain. Mipping a packed
// gradient averages it toward 0.5, which unpacks to FLAT -- so past there the
// relief is extinguishing itself whatever this constant says, and a fade that
// ends at 55 is just declining to pay for a fetch that has stopped tilting
// anything. Ground looked at across a plain gives out sooner still, since a
// grazing footprint climbs the chain faster; the case 55 is actually buying is
// the one that reads, a slope or a cliff seen close to face-on.
//
// What it costs: the coarse fetch now runs on the annulus between 26 and 55 m,
// which at eye height is about 4% of the below-horizon screen area (26 m
// already covers ~92% of it). The colour work inside is guarded separately so
// those fragments pay for the fetch and the bump and nothing else.
const RELIEF_NEAR = 8
const RELIEF_FAR = 55

// ---- The four sampling scales, in metres of world per tile.
//
// THE RATIOS ARE THE INTERESTING PART, not the absolute sizes. Both textures
// tile, so every scale sampled from one of them repeats; two scales off the
// same tile repeat TOGETHER only where their periods coincide, so the pairs are
// picked to make that coincidence as distant as a pair of floats can. 11.7 and
// 2.3 first agree after 269 m; 1024 and 137 after 20 km, which is past the far
// edge of an 8 km world.
//
// GRIT_METRES is also what fixes the texel size, and that is a look decision
// rather than a range one: 256 texels over 11.7 m is 4.6 cm a texel, which is
// the bench ground's 4.7 cm (preview-stage.js runs 64 px over 3 m). Magnified
// NEAREST, so those texels are visible squares underfoot. Change this number
// and the ground stops looking like the bench, whatever else it does.
//
// MACRO_METRES is a full kilometre because it carries the snow line's wander,
// and a snow line that repeated every couple of hundred metres would draw the
// same border around every peak in the range.
const GRIT_METRES = 11.7
const GRIT_FINE_METRES = 2.3
const MACRO_METRES = 1024
const MACRO_FINE_METRES = 137

// The rotation applied to the finer sample of each pair, as its matrix. Not
// decoration: both textures are square lattices, so two samples of one tile at
// different scales carry the same axis-aligned grid, and up close that grid
// lines up with the chunk grid the mesher goes to some trouble to hide. Turning
// the fine sample off-axis decorrelates them. ~37 degrees, which is far from
// every multiple of 45 and therefore from every way a square can agree with
// itself.
const ROT = 'mat2( 0.80, 0.60, -0.60, 0.80 )'

// ROT's inverse, which for a rotation is its transpose.
//
// Needed because a fetch taken through ROT reports its packed derivative in
// the ROTATED frame: if uv = ROT * (p * k) then dh/dp = k * ROT^T * grad_uv.
// A world-space bump wants dh/dp, so the fine grit sample's .gb has to be
// turned back before it can be added to one. Getting this wrong does not look
// like an error -- it looks like lighting that is subtly lit from the wrong
// side, which is much harder to notice and much harder to find.
const ROT_T = 'mat2( 0.80, -0.60, 0.60, 0.80 )'

// Where a surface has been eaten by the haze far enough that its own colour
// variation cannot read, as a fraction of its colour that survives to the eye.
//
// The gate that hangs off this is keyed to TRANSMITTANCE rather than to a
// distance, and that is the load-bearing choice. `scene.fog` is FogExp2 driven
// by clock.js's `hazeDensity`, which swings more than 5x over a day: 0.00113 at
// noon, 0.00021 at night. "Past 1.5 km it is all hazy blue" is exactly true at
// the noon value -- 5.7% of the surface survives there -- and wrong by a factor
// of five at the night one, where 1.5 km still delivers 91%. A hard-coded 1500
// would erase the snow line's shape and flatten every distant hillside on a
// clear night. Transmittance is the very number the fog chunk multiplies this
// fragment by a few lines later, so gating on it says precisely what is meant:
// stop paying for detail that the fog is about to eat.
//
// At the noon density these two land at about 1.59 km and 1.24 km.
const HAZE_GONE = 0.04
const HAZE_FULL = 0.14

// The micro layer's own fade, tighter than the grain's because its TILE is
// smaller -- 2.3 m, which is a visible lattice from much closer than the coarse
// sample's 11.7 m. See the block above FADE_NEAR. MICRO_FAR is the number to
// lower if the speckle ever reads as a disc of detail travelling with the
// camera rather than as detail resolving when you get close to it.
const MICRO_NEAR = 6
const MICRO_FAR = 16

// ---- The stone layer, and the one place a photograph gets into the terrain.
//
// Everything else in this shader is noise. Noise is isotropic and self-similar,
// which is exactly wrong for a cliff: real rock has BEDDING -- bands, fracture
// lines, a direction. So the rock surface gets rocks/stone.png, the same tile
// the boulders wear, so that a boulder sitting against the cliff it fell off
// reads as the same material rather than as a prop parked on a noise field.
//
// TWO OCTAVES, because one cannot cover the range. STONE_METRES is the coarse
// one at 16 m per tile: that is the bedding, and its features are metres across,
// so it stays legible from most of the way across a valley and has to fade out
// far later than anything else here. FINE_METRES is 2 m, added only up close,
// where the coarse tile has gone soft and there is nothing left to look at.
//
// TRIPLANAR, and not optional: the whole point is cliffs, and a cliff is where a
// flat xz projection stretches a 16 m tile into vertical smears.
const STONE_METRES = 16
const FINE_METRES = 2
// The coarse tile's own fade. Far out past everything else in this file --
// mipping takes the tile to its own mean at distance, and since the shader
// divides by that mean the layer converges to a no-op on its own. The fade is
// therefore about not PAYING for three texture fetches once they stop changing
// any pixels, rather than about hiding a pop.
const STONE_NEAR = 220
const STONE_FAR = 650
// The fine octave's. A 2 m feature is still ~40 px at 90 m, so it earns a range
// well past the 10 cm micro layer's 40 m, but it is three more fetches and the
// coarse layer is carrying the surface by then.
const FINE_NEAR = 30
const FINE_FAR = 130

// ---- The ground tile: the meadow, photographed. §7 has the argument.
//
// Same trick as the stone above: noise is isotropic and self-similar and a lawn
// is not -- it has blades, they lie in directions, and they clump.
// LAYER.TERRAIN_GRASS is one square metre cut from a photograph by
// tools/props/cut-terrain.mjs.
//
// A CONTRAST FIELD, NOT AN ALBEDO: divided by its own linear per-channel mean
// (GRASS_TILE_MEAN in textures.js) so it averages (1,1,1) and adds grain and
// blade-to-soil swing without moving a palette that was tuned untextured.
//
// ONE METRE PER TILE at 128 px is 8 mm a texel -- a blade is a texel or two, a
// clump a dozen -- so this is by far the finest layer here. It cannot alias: as
// it goes sub-pixel its mips converge to its own mean, the divide takes that to
// 1.0, and the layer fades itself out. GROUND_FAR is about not PAYING for that
// fetch, not about hiding a pop.
//
// PLANAR, where the stone is triplanar, and that is fill rate rather than
// quality: ground is most of the screen. The xz projection stretches by
// 1/cos(slope), 15% at 30 degrees, and by the angle where that would show
// chunk-mesh has already classified the fragment as rock.
//
// THERE WAS A SNOW TILE HERE AND IT DID NOT WORK -- a photograph beats noise
// only where the surface has real STRUCTURE at the scale drawn, and snow has
// almost none, so all the tile contributed was its own 1 m repeat with nothing
// to hide it behind. The grit tile draws snow now at two incommensurate,
// mutually rotated scales, which is the property the photograph could not have.
//
// WHAT THE TILE TURNS OFF, inside its fade and ON GRASS ONLY: the brightness
// speckle, the dirt/moss mottle, and the grass half of the 10 cm micro tint --
// the same job done worse, and running both is two textures at one scale, which
// reads as mud. It turns them off THROUGH auroraGreenBase, which is why that
// value has to reach a true 1.0; see the block on it in the fragment shader.
// What stays: the snow SPARKLE (a specular stand-in), the macro layers (they are
// regional and the tile is not), and the whole normal pass (the tile carries no
// relief). Snow and rock now suppress nothing, having no tile at this scale.
const GROUND_METRES = 1
// The tile's own fade, and by far the tightest here because the tile is by far
// the smallest. At 60/150 this was the layer drawing the visible grid across
// every hillside seen from any height -- one square metre, repeated, a hundred
// times inside one view. 12/30 keeps it to the range where a repeat is still
// several degrees of arc and the blades read as blades. See the block above
// FADE_NEAR.
const GROUND_NEAR = 12
const GROUND_FAR = 30

// Values are LINEAR, not sRGB -- three treats vertex colours and plain Color
// uniforms as working-space. Roughly: linear 0.05 reads as sRGB 0.25.
//
// THE GRASS FOUR ARE TUNED AGAINST A MEASURED MEAN, not by eye, and the mean
// that matters is THE ONE ON SCREEN. Every one of them is a mix DESTINATION, so
// what the meadow reads as is the average of the whole tint chain -- then
// multiplied by a light near (2.12, 2.05, 1.93) and encoded to sRGB, which is
// where the eye reads the answer. Two rounds were tuned on albedo and both
// missed. On distant grass, where only the palette is left: a flat uGrassShade
// of 0.85 gives screen 80,105,60 at g/r 1.81 (olive); these four with uGrassTone
// give 56,106,41 at g/r 3.71 (verdant). The green channel is the SAME in both --
// red and blue came down by a third, which is the whole difference between waxy
// and vivid, and why the knob is a vec3 and not a float.
//
// DIRT and DRY are the only two members with g <= r, so over-firing them
// neutralises the meadow -- and the equalised fields WERE over-firing them, see
// the threshold block in the fragment shader.
const DIRT = new THREE.Color(0.044, 0.036, 0.019) // exposed soil and grit
const MOSS = new THREE.Color(0.005, 0.026, 0.005) // the darker green in the mix

// The macro palette. Each one is a plausible neighbour of the base colour it
// tints, not a different material -- these read as "that slope is drier" and
// "that face is stained", not as painted patches.
const DRY = new THREE.Color(0.042, 0.044, 0.017) // sun-bleached ochre grass
const DEEP = new THREE.Color(0.009, 0.04, 0.009) // damp, shadowed green
const STAIN = new THREE.Color(0.062, 0.05, 0.042) // warm mineral staining on rock

// The two ends of the boundary dither. These must track C_SNOW and C_ROCK in
// chunk-mesh.js: the dither's whole job is to push a transition fragment the
// rest of the way to one side or the other, and if the destination is not the
// colour the mesher would have given it, the dither reads as a stain instead of
// as a border.
const SNOW = new THREE.Color(0.86, 0.88, 0.93)
const ROCK = new THREE.Color(0.085, 0.082, 0.078)

// The micro palette: a light and a dark neighbour for each surface, which is
// all a fleck needs to be. Grass is not here because it already has a pair --
// DIRT and MOSS -- and giving the 10 cm layer its own greens would put two
// unrelated colour families on the same hillside at two scales.
//
// Both pairs straddle their base colour rather than sitting to one side of it,
// so the layer averages back to the base as it fades out and there is no
// brightness step at the fade edge.
const GRIT = new THREE.Color(0.155, 0.152, 0.146) // pale mineral grain on rock
const SOOT = new THREE.Color(0.042, 0.041, 0.039) // the pits between the grains
const FROST = new THREE.Color(1.0, 1.0, 1.0) // a crystal face square to the sun
const SHADE = new THREE.Color(0.74, 0.76, 0.82) // the hollow beside it

// The darkest albedo this palette can put on screen, picked from the palette
// itself rather than written down a second time.
//
// It exists for the WATER (§11): where a mountain blocks the lake's reflection
// the silhouette has to be about as dark as the mountain casting it, and the
// only way to know how dark that is, is to ask the palette. Writing "the dark
// blue is roughly 0.03" into water.js instead would be one more constant that
// drifts out from under the thing it names the first time a colour here moves.
//
// Only the dark half of the palette is a candidate: snow and frost are the
// brightest things in the world and would make nonsense of a minimum. Speckle,
// micro-relief and ambient occlusion all push real fragments DARKER than this
// from here, so this is the bright end of the dark end -- which is the safe
// direction to be wrong in, since it is a floor being matched, not a mean.
export const TERRAIN_DARKEST = [DIRT, MOSS, DRY, DEEP, STAIN, ROCK, GRIT, SOOT].reduce((a, b) =>
  luminance(a) <= luminance(b) ? a : b
)

export function luminance(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

/**
 * @param {object} [opts]
 * @param {THREE.DataArrayTexture} [opts.atlas] The prop texture array, for the
 *   stone layer. OPT-IN: without it no sampler is declared and the two stone
 *   blocks are not compiled at all, so v1's terrain and check-daynight's
 *   standalone material are byte-identical to what they were. Pass the SAME
 *   array the props use -- the point is that a cliff and the boulders on it are
 *   sampling one tile.
 * @param {boolean} [opts.lofi] Compile the TWO-FETCH variant. See the LO-FI
 *   block below. Implies no atlas: the stone and meadow photographs are the
 *   layers it exists to remove.
 * @param {boolean} [opts.lean] Compile the ONE-FETCH variant. Implies lofi and
 *   then cuts two of the three fetches it left. See the LEAN block below.
 * @param {boolean} [opts.axis] Swap lean's triplanar rock for a DOMINANT-AXIS
 *   projection. Implies lean. See the AXIS block below.
 * @param {boolean} [opts.grain] Cut the near block to GRAIN AND RELIEF ONLY.
 *   Implies axis. See the GRAIN block below.
 */
export function createTerrainMaterial({ atlas = null, lofi: lofiOpt = false, lean: leanOpt = false, axis: axisOpt = false, grain = false } = {}) {
  // EACH RUNG RIDES THE ONE BELOW IT rather than growing its own set of branches
  // that would every one of them have read `lofi || lean || axis || grain`. Lean
  // is lo-fi plus two cuts, axis is lean with one projection swapped, grain is
  // axis with the colour half cut back. Everything lo-fi drops, all of them drop.
  const axis = axisOpt || grain
  const lean = leanOpt || axis
  const lofi = lofiOpt || lean
  const material = new THREE.MeshLambertMaterial({ vertexColors: true })

  // ---- LO-FI: the same world, with the photographs taken out.
  //
  // THE MEASURED PROBLEM: on a Quest the `landscape shader` row is worth ~20 fps
  // between `full` and a stock Lambert. At 7 Mpixel a frame the ground is fill
  // bound in this fragment shader, and the fetches are most of it.
  //
  // The budget, per fragment, not counting lighting.js's fragment patch (which
  // adds 3 to every one of these):
  //
  //                     full            lo-fi           lean
  //   far / mid          2               1               0
  //   near grass         5               2, or 3 inside  1
  //                                      MICRO_FAR
  //   near rock         10               2, or 3 -- 4    1, or 3 on a
  //                                      and 5 on a      steep face
  //                                      steep face
  //
  // It is not a different world. Same palette, same snow line, same regions,
  // same grit, same relief. It is the same world with the layers that cost the
  // most per unit of visible difference removed.
  //
  // WHAT IT DROPS, and why each is the right thing to lose first:
  //
  //   the stone photograph   6 fetches on near rock and 3 out to 650 m, the
  //                          most expensive thing in the file, because triplanar
  //                          triples every octave. What replaces it is the grit
  //                          array's ROCK layer, which carries a coarser
  //                          mottle and a heavier grain of its own --
  //                          so the character survives at a third of the price,
  //                          and it goes triplanar HERE, on the one octave that
  //                          needs it, instead of on two.
  //   the meadow photograph  1 fetch over most of the near ground, and the layer
  //                          that was drawing the visible 1 m grid.
  //   the fine macro sample  1 fetch on every fragment the haze has not eaten,
  //                          which is most of the screen. Its mid-range mottle
  //                          is the smallest visible difference per fetch here:
  //                          the region octave above it and the grit below it
  //                          both still run.
  //
  // WHAT IT KEEPS: the coarse macro fetch (the snow line and the 1 km regions --
  // one fetch, and the only one every fragment in the world pays), and BOTH grit
  // rungs. The fine grit rung is what stops the coarse rung reading as a
  // repeating 11.7 m tile underfoot, and it carries the snow sparkle and the
  // 4 cm flecks besides.
  //
  // ---- LEAN: lo-fi with the last two full-screen fetches taken out.
  //
  // MEASURED ON A QUEST 2, trees and grass loaded, under medium load: plain 73
  // fps, lean 60, lo-fi 57, full 46 -- 13.70 ms, 16.67, 17.54, 21.74. Lean costs
  // 2.97 ms over the control and beats lo-fi on cost AND on looks, which is why
  // the headset ships it and the middle rungs are gone from main.js's row.
  //
  //                                share of screen   fetch-screens
  //   1 km macro, UNGUARDED             100%             1.00
  //   coarse grit, inside RELIEF_FAR     ~45%            0.45
  //   fine grit, inside MICRO_FAR        ~35%            0.35
  //   triplanar's 2 extra, steep rock    ~10%            0.10
  //
  // FETCHES ARE NOT THE COST, and this table is what disproves it rather than
  // what predicts it. Lo-fi runs 1.90 of those fetch-screens for 3.84 ms and lean
  // runs 0.55 for 2.97: the step between removed 1.35 and bought 0.87 ms, 0.64 ms
  // each, where full -> lo-fi implied ~1.4. No single rate fits both, so cutting
  // a fetch buys progressively less -- there is enough arithmetic around each one
  // to hide its latency behind.
  //
  // LEAN DROPS THE FIRST AND THE THIRD anyway. The macro layer moves to the
  // VERTEX shader unchanged -- same field, same channels, evaluated per vertex
  // and interpolated -- and the fine grit rung goes outright, taking the snow
  // sparkle, the 4 cm flecks and the 10 cm relief octave with it. That second one
  // is what lean costs to LOOK at: the coarse rung is unaccompanied at 11.7 m
  // now, so if the ground reads as a lattice underfoot, this is why.
  //
  // WHAT IS LEFT IS ALL NEAR FIELD. Fold the `auroraRelief > 0.004` block away
  // and lean is 37 SPIR-V ALU over a stock Lambert with ZERO fetches and ZERO
  // branches -- that is the entire far-field colour chain, the snow and rock
  // mixes, the region tint and the two exposure multiplies. The block itself is
  // +97 ALU, 4 fetches and 20 branches and none of it survives RELIEF_FAR. So a
  // distant mountain is already nearly free here and there is nothing to win at
  // range; every remaining millisecond is spent inside 55 m.
  //
  // IT KEEPS THE COARSE RUNG'S RELIEF, which rides free on a fetch already there,
  // and it keeps the TRIPLANAR GATE exactly where it is, which is the part worth
  // writing down because the gate looks like an obvious 0.37 ms and is not. Both
  // ways to tighten it put a seam on screen. A distance gate inside RELIEF_FAR is
  // visible because RELIEF_FAR is the distance at which both of that block's
  // outputs have already faded to nothing, and at 15 m neither has -- auroraNear
  // is still 0.61 there -- so the mottle would change pattern along a ring that
  // follows the camera. The steepness gate is worse: 0.86 is not taste, it is
  // where pow(abs(n), 4) leaves the triplanar blend 89% the xz projection anyway,
  // so the two paths agree across it. At 0.62 they agree 28%, which draws a hard
  // line along one contour of every hill in the world.
  // ---- AXIS: lean, with the triplanar rock branch replaced rather than removed.
  //
  // WHAT IT IS FOR. Ablating the shipped lean shader puts its near block at ~97
  // SPIR-V ALU over a stock Lambert, and the TRIPLANAR BRANCH ALONE is 47 of them
  // plus 3 of the block's 4 fetches. Nothing else in there is worth cutting by
  // comparison: the speckle is 4 ALU, dirt and moss together are 9, and the bump
  // normals are 30 only because deleting them also kills the .gb decode on a
  // fetch that stays. So the branch is the near field, and everything else is
  // rounding error.
  //
  // AND THE OP COUNT UNDERSTATES IT, which is the part worth writing down. Its
  // condition is `rock && auroraWN.y < 0.86`, and that flips fragment to fragment
  // along every rock/grass boundary and every 0.86-slope contour in view. A quad
  // that straddles one executes BOTH sides masked -- 3 fetches and 1, plus the
  // three-way blend -- so the honest weighting is not "10% of screen takes the
  // expensive path", it is "every quad touching one of those contours pays all
  // four". It is the only divergent branch in this file that gates fetches.
  //
  // THE SWAP. Sample the ONE plane the geometric normal most faces, instead of
  // three blended by weight. Same swizzles the triplanar helper uses, so the rock
  // layer's 3.5:1 anisotropy still lands with its long axis horizontal on a wall;
  // same textureGrad, because this still sits inside a guard that is not
  // quad-uniform. The selection is ternaries on vec2, which compile to selects
  // rather than to control flow, so the fetch sits at one place in uniform flow
  // and the divergence is gone with the branch.
  //
  // WHAT IT COSTS TO LOOK AT, and it is a narrow thing. Below 45 degrees the y
  // component still dominates, so the plane chosen IS the xz plane and the result
  // is bit-identical to lean's planar path -- which is most of the walkable world.
  // Past 45 the projection FLIPS between planes along one contour, and the field
  // on either side is the same field at a different phase. That reads as a change
  // of pattern and not of brightness, which in 4.6 cm rank-equalised noise with no
  // directional structure is about as invisible as a seam gets; but it is a seam,
  // and the headset is the only thing that can say whether it shows.
  //
  // The band between the two is where it differs from lean without differing from
  // planar: from 30.7 degrees (auroraWN.y = 0.86, where lean turns triplanar on)
  // to 45, axis stays on xz where lean blends. That blend is 89% xz at its own
  // gate, so there is nothing there to see either.
  //
  // IT MEASURED FREE, NOT FASTER: a Quest 2 under load reads axis and lean at the
  // same 53 fps, twice, though axis removes 3 of lean's 4 fetches, 7 of its 26
  // branches and the only divergent fetch-gating branch in the file. It is what
  // ships because it is strictly less code for the same frame time, but it is the
  // measurement that ended the search for a fetch- or branch-shaped win here: the
  // near field is neither fetch bound nor branch bound.
  // ---- GRAIN: axis, with the near field cut to the two things you can see.
  //
  // WHAT IS LEFT: one grit fetch on the dominant plane, its .r driving the
  // brightness speckle, its .gb driving the relief normals. What goes: the dirt
  // and moss mixes, and the `auroraNear > 0.004` guard that used to wrap all
  // three. So the ground still has readable grain and still lights as a rough
  // surface, and green ground loses its soil and moss flecking inside FADE_FAR.
  //
  // THE GUARD GOES BECAUSE THE BODY SHRANK. It was worth a branch when it wrapped
  // a speckle and two smoothstep mixes for fragments between FADE_FAR and
  // RELIEF_FAR that would arrive at auroraGrain = 0.5 and change nothing. With
  // the mixes gone the body is three ops, the fade is already arithmetic, and the
  // branch costs more than it skips.
  //
  // WHAT IT IS WORTH, and this is the honest part. A Quest 2 under load measures
  // lean 53 / axis 53 / plain 62, with the whole near block folded away at 57 --
  // so the block entire is 1.33 ms of a 2.74 ms gap. Grain takes 12 SPIR-V ALU and
  // 3 branches out of the 66 ALU that block still holds under axis, which is 18%
  // of it, or about 0.24 ms if the two scale together. Under one fps. It is here
  // because the features it drops are the least visible in the block, not because
  // the arithmetic promises much, and the ladder above says nothing left inside
  // that block promises much either.
  const stone = atlas && !lofi

  const detail = terrainDetailTextures()

  material.userData.uniforms = {
    // The two baked fields every layer below is now a channel of. Shared across
    // every material this factory makes -- see terrainDetailTextures. The grit
    // one is a THREE-LAYER ARRAY, one field per surface; see GRIT_LAYER.
    uGritArr: { value: detail.grit },
    uMacroMap: { value: detail.macro },
    uSpeckle: { value: 0.46 }, // +/- brightness swing, applied to every surface
    uDirtAmount: { value: 0.8 },
    uMossAmount: { value: 0.65 },
    uDirt: { value: DIRT },
    uMoss: { value: MOSS },
    uMacroValue: { value: 0.38 }, // +/- brightness swing at every distance
    uMacroTint: { value: 0.55 }, // how far the macro palette pulls the hue
    // ---- The REGION octave: a THIRD macro wavelength at ~90 m, and the coarsest
    // colour variation in the shader. §7 has the argument.
    //
    // A tiled photograph is the same square metre everywhere, so whatever it buys
    // up close it buys nothing at range, and the 27 m / 10 m pair below has
    // averaged itself flat by the time a hillside is 300 m off. A new octave
    // rather than resizing that pair, which was itself divided down FROM 110 m and
    // 38 m because at that size the two overlapped into one muddy middle tone.
    //
    // Three destinations from one field: the value multiply darkens and lifts
    // whole regions, the high end pulls toward uDirt and the low end toward uDeep.
    // Reusing those two rather than a coarse palette of its own, on the same
    // argument the micro layer reuses them. Snow gets the value swing at half
    // weight (wind scours a drift into bright and dull ground, which reads as
    // snow) and none of the tint (brown snow reads as dirty snow).
    uRegionValue: { value: 0.32 }, // +/- brightness swing over ~90 m regions
    uRegionTint: { value: 0.5 }, // how far a region pulls toward dirt or deep green
    uDry: { value: DRY },
    uDeep: { value: DEEP },
    uStain: { value: STAIN },
    uSnow: { value: SNOW },
    uRock: { value: ROCK },
    // How far the snow/rock border is allowed to wander from where the vertex
    // colours put it, in units of the classification's own 0..1 range. 0 restores
    // the old hard interpolated edge.
    //
    // THE CEILING IS NOT A TASTE CALL. Half the amplitude has to stay inside the
    // dead zone of the sharpening smoothstep( 0.25, 0.75 ) below, because that
    // dead zone is the only thing confining the dither to the transition band:
    // vColor saturates to "no snow" somewhat below the line and reads the same for
    // the whole rest of the world, so past that point the noise starts flecking
    // valley floors. At 0.65 the extreme excursion lands at 0.325 and comes out
    // under a tenth white -- a stranded patch rather than a dissolved border.
    //
    // An earlier pass ran 1.0 behind an explicit world-height guard. That is gone
    // deliberately: the snow line is a FIELD now (SNOW.swing in
    // sim/terrain-height.js), so any fixed height window is wrong by up to 22 m in
    // both directions and would shut the dither off exactly where the line sits
    // low. The regional variation it bought headroom for is done properly one
    // layer up.
    uBoundary: { value: 0.65 },
    // ---- THE NORMAL PASS, which is what makes a dimple deepen as the sun goes
    // down, and the reason it is worth more than its cost.
    //
    // The grit fetch's .gb IS the derivative of the .r that coloured the
    // fragment (grit-texture.js bakes them together), so a bump here is not a
    // second texture bolted on -- it is the SAME field, read as a slope. That
    // slope perturbs the shading normal at normal_fragment_begin, which feeds
    // Lambert's N.L, which is a function of the sun direction. So the relief is
    // lit rather than painted: at noon a pit is a faint darkening and at a low
    // sun it is a hard-edged shadow with a bright rim, and nothing in the
    // shader has to know what time it is.
    //
    // It is also the cheapest thing in this file per unit of look. The fetch is
    // already paid for by the colour pass; the whole normal pass is two
    // subtracts, a multiply and a normalize.
    //
    // 0 disables the whole block, which is the escape hatch if the headset is
    // still fill bound.
    //
    // RETUNED for the three-layer array. The old single field's packed gradient
    // averaged 5.785 per tile-unit; the three that ship average 4.86 (grass),
    // 5.94 (rock) and 4.66 (snow), so 5.15 across them. 0.126 was the mean
    // tangent the look was tuned at, and 0.126 * 11.7 / 5.15 is 0.286.
    uRelief: { value: 0.286 },
    // How much of the coarse rung each surface gets. FLAT NOW, and that is a
    // change: it used to be rock 1.0, grass 0.5, snow 0.2, because one shared
    // field had to stand in for three materials and a half-metre lump of it on
    // snow read as gravel rather than as drift. The field is per-surface now --
    // snow's is a smooth, directional wind-scour with no half-metre fizz in it
    // at all -- so the weight that was compensating for the wrong field is
    // compensating for nothing, and the drifts, blade clumps and crags all
    // catch the light at the strength their own field was baked with.
    //
    // Left as a uniform rather than deleted because it is the knob to reach for
    // if snow at a low sun turns out to read as too busy.
    uReliefSnow: { value: 1.0 },
    // The relief ladder's fine rung, from the FINE grit fetch: ~1 cm bumps and
    // divots, on every surface.
    //
    // Its own uniform rather than a weight inside uRelief because it rides the
    // MICRO fade (gone by 16 m) instead of the grain fade (26 m), its tile being
    // five times smaller and so five times closer to reading as a lattice.
    // Flat across all three surfaces, like the coarse rung above.
    //
    // Retuned twice. The old 10 cm octave averaged 4.2576 per metre, so 0.018
    // bought a tangent of 0.0766; against the three-layer array's 5.15 mean per
    // tile-unit over a 2.3 m tile, which is 2.2391 per metre, 0.034 buys the
    // same. Nested inside the uRelief guard on purpose -- uRelief = 0 must still
    // kill the whole normal pass.
    uMicroRelief: { value: 0.034 },
    // Glitter on snow. Small because it is thresholded to a few percent of
    // fragments -- this is specular sparkle standing in for a spec model Lambert
    // does not have, not a brightness change.
    uSnowSparkle: { value: 0.3 },
    // The ~10 cm layer. uMicroTint is how far a fleck pulls toward its palette
    // colour, uMicroValue the brightness swing underneath it. 0 on uMicroTint does
    // NOT disable the layer -- uMicroValue is independent; set both to 0.
    //
    // Both are HALF what the first pass shipped (0.55 and 0.14), because at full
    // strength the flecks read as garish and pixelly rather than as grit. Halving
    // the KNOB rather than moving GRIT/SOOT/FROST/SHADE halfway to their base
    // colours: these are only ever applied as mix( base, C, t ), and
    // mix( base, C, t/2 ) == mix( base, (base+C)/2, t ) exactly. Same pixels, one
    // number instead of four, and the constants stay legible as the extreme each
    // surface tints TOWARD. It also covers grass, whose targets are the shared
    // DIRT and MOSS and cannot be moved without dragging the macro and grain
    // layers along.
    //
    // uMicroRelief is deliberately NOT halved with these: shading and albedo are
    // what make a surface read as gritty at this scale, and the complaint was
    // about colour intensity. If it still reads pixelly at 0.275, that layer is
    // the next one to pull down.
    uMicroTint: { value: 0.275 },
    uMicroValue: { value: 0.1 },
    uGrit: { value: GRIT },
    uSoot: { value: SOOT },
    uFrost: { value: FROST },
    uShade: { value: SHADE },

    // ---- EXPOSURE. Two scale factors applied to the finished albedo, keyed on
    // the surface, and the only two numbers in this file that are about the
    // renderer rather than about the ground. §7 carries the full table.
    //
    // THE RENDERER HAS NO TONE MAPPING (`toneMapping: none` in v2's main, by
    // choice), so the transfer curve is linear albedo times light, hard-clipped at
    // 1.0, then sRGB. There is no shoulder: anything above 1.0 is not "bright", it
    // is GONE, and everything drawn on top of it is gone with it. Snow was landing
    // there -- C_SNOW 0.88 against a 2.1 sun and 0.85 hemisphere computes ~2.15,
    // clipped by more than 2x at every daylight angle -- which is why the
    // snowfield read as a flat white sheet with the sparkle, flecks, grain and
    // relief all computed correctly and then thrown away.
    //
    // WITH NO SHOULDER, LEVEL AND TEXTURE ARE THE SAME KNOB. At N.L 0.75 (level
    // ground under this scene's 49-degree sun), as mean screen grey / 5th-to-95th
    // spread / share the clamp flattens: 0.40 -> 216, 193..239, 0% (grey, reads as
    // dirty snow); 0.55 -> 245, 223..255, 35%; 0.65 -> 253, 240..255, 74% (HERE);
    // 0.75 -> 255, 255..255, 95% (washout). Washout is not taste, it is the row
    // where the spread reaches zero; 0.65 is the midpoint to it by the parameter
    // and by the surviving spread alike. Read the clipped share against SLOPE, not
    // as one number: what clips first is the sparkle, and the faces that clip
    // hardest are square to the sun, which is where real snow IS one value.
    //
    // WHY THIS IS NOT A FIX IN chunk-mesh's C_SNOW: that constant is the snow
    // albedo AND the classification channel this shader reads (auroraVertexSnow
    // thresholds vColor.b), so darkening it would silently stop the shader
    // recognising snow as snow. The mesher's colour is the classification; this
    // stage owns the shading. Consequence to watch: props carry their own snow
    // (SNOW_TINT in material.js) and are clipped the same way, so a snow-capped
    // boulder reads brighter than the ground until that one is scaled to match.
    //
    // uGrassTone is a LOOK choice and not a clipping one -- grass at 0.088 was
    // never near the clamp -- and it is PER CHANNEL because what reads as "waxy"
    // is low chroma, and the only cure is to take red and blue down while green
    // stays. Measured on screen: a flat 0.85 landed on 80,105,60 (g/r 1.81), these
    // three land on 56,106,41 (g/r 3.71) at the same green. It also does most of
    // the work on the brown flecks in the ground tile: a dirt-coloured blotch
    // needs red, and this halves red everywhere on grass.
    uSnowAlbedo: { value: 0.65 },
    uGrassTone: { value: new THREE.Color(0.45, 0.92, 0.45) },
  }

  if (stone) {
    material.userData.uniforms.uAtlas = { value: atlas }
    // How far each stone octave is allowed to swing the surface, as a fraction
    // of the fully-applied tile. The tile is a photograph with a lot of contrast
    // in it -- divided by its own mean it ranges roughly 0.2x to 2.3x -- so 1.0
    // here would make the terrain read as wallpaper. 0.55 lands it as rock that
    // has grain in it; the fine octave is deliberately about a third of that
    // because the user's ask for it was "fainter", and because it is layered on
    // top of the coarse one rather than instead of it.
    material.userData.uniforms.uStone = { value: 0.55 }
    material.userData.uniforms.uStoneFine = { value: 0.2 }
    // The tile's own linear mean, per channel. Dividing by it is what turns a
    // photograph into a CONTRAST FIELD: the result averages (1,1,1), so
    // multiplying by it adds the tile's grain and its mineral colour variation
    // without moving the terrain palette a single step darker or warmer. Every
    // colour in this file was tuned against a surface with no texture on it, and
    // this is the only way to add one without invalidating all of them.
    material.userData.uniforms.uStoneMean = {
      value: new THREE.Vector3(ROCK_TILE_MEAN[0], ROCK_TILE_MEAN[1], ROCK_TILE_MEAN[2]),
    }

    // How far the ground tile is allowed to swing its surface. Same units as
    // uStone -- a fraction of the fully-applied contrast field. Turn it to 0 to
    // see the noise layers this replaced, which is the comparison the whole
    // GROUND_METRES block above is making.
    //
    // WHAT SHIPS IS THE PRODUCT of the weight here and the cut's relative sd,
    // which cut-terrain.mjs grades to 0.60, so the meadow lands at 0.48. Push
    // the CONTRAST from the cut rather than from here: past 1.0 this mix()
    // extrapolates, and an extrapolated field goes negative in its low tail,
    // which clamps to black specks rather than to deep shadow.
    material.userData.uniforms.uGrassTile = { value: 0.8 }
    material.userData.uniforms.uGrassTileMean = {
      value: new THREE.Vector3(GRASS_TILE_MEAN[0], GRASS_TILE_MEAN[1], GRASS_TILE_MEAN[2]),
    }
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.uniforms)

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
 varying vec3 vWorldPos;${lean ? `
        uniform sampler2D uMacroMap;
        varying vec2 vMacro;` : ''}`)
      // After project_vertex, so `batchingMatrix` is already in scope. Terrain
      // chunks are batched, and their local vertices are chunk-relative -- the
      // batch matrix is the only thing that knows where in the world they are.
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 auroraWorld = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          auroraWorld = batchingMatrix * auroraWorld;
        #endif
        vWorldPos = ( modelMatrix * auroraWorld ).xyz;${lean ? `
        // LEAN's whole far field, sampled once per VERTEX instead of once per
        // fragment. textureLod and not texture because a vertex shader has no
        // derivatives to pick a level from, and level 0 is the right one to pin:
        // the LOD selector keeps a chunk's triangles at a roughly constant
        // ANGULAR size, so vertex spacing is a fixed fraction of the screen at
        // every distance and the field is resampled at the same screen rate
        // wherever it is read.
        //
        // A VERTEX TEXTURE FETCH ON AN ADRENO, which §5 of design/05-rendering.md
        // names as one of the three reasons BatchedMesh was slower here than
        // instancing. It is still the right trade, and by an order of magnitude:
        // the terrain runs roughly 12 fragments per vertex, so moving one fetch
        // across that boundary removes about 12 of them for every 1 it adds --
        // and this stage was already fetching the batch matrix out of a data
        // texture, so the path is warm rather than newly opened.
        //
        // WHAT IT COSTS IN LOOKS, so it is not discovered later: the snow
        // boundary's wander is now resolved at vertex spacing rather than at
        // pixel spacing, so its finest wobble is one triangle long. The level
        // contour the dither exists to break is broken either way -- that
        // happens on the field's 100 m-1 km lobes, which interpolate exactly --
        // but the sub-triangle detail on the border is gone.
        vMacro = textureLod( uMacroMap, vWorldPos.xz * ${(1 / MACRO_METRES).toFixed(8)}, 0.0 ).ra;` : ''}`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorldPos;
        precision highp sampler2DArray;
        uniform sampler2DArray uGritArr;
${lean ? '        varying vec2 vMacro;' : '        uniform sampler2D uMacroMap;'}
        uniform float uSpeckle;
        uniform float uDirtAmount;
        uniform float uMossAmount;
        uniform vec3 uDirt;
        uniform vec3 uMoss;
        uniform float uMacroValue;
        uniform float uMacroTint;
        uniform float uRegionValue;
        uniform float uRegionTint;
        uniform vec3 uDry;
        uniform vec3 uDeep;
        uniform vec3 uStain;
        uniform vec3 uSnow;
        uniform vec3 uRock;
        uniform float uBoundary;
        uniform float uRelief;
        uniform float uReliefSnow;
        uniform float uMicroRelief;
        uniform float uSnowSparkle;
        uniform float uMicroTint;
        uniform float uMicroValue;
        uniform vec3 uGrit;
        uniform vec3 uSoot;
        uniform vec3 uFrost;
        uniform vec3 uShade;
        uniform float uSnowAlbedo;
        uniform vec3 uGrassTone;
${stone ? `        uniform sampler2DArray uAtlas;
        uniform float uStone;
        uniform float uStoneFine;
        uniform vec3 uStoneMean;
        uniform float uGrassTile;
        uniform vec3 uGrassTileMean;

        // One triplanar sample of LAYER.ROCK at 1/\`k\` metres per tile, blended
        // by pre-normalised world-axis weights. Three fetches, and there is no
        // cheaper honest version: picking the dominant axis instead costs one
        // fetch and draws a visible seam along every 45-degree edge, which on a
        // mountain is most of the edges.
        //
        // textureGrad, and the gradients are passed in rather than taken here,
        // because every call site is inside a branch that is NOT quad-uniform
        // -- the guard folds in distance and the rock/grass classification, so
        // a quad straddling the foot of a crag has some lanes in and some out.
        // An implicit-LOD fetch there is undefined, and the way it actually
        // fails is the sharpest mip on a fragment that should have had the
        // blurriest: a line of sparkling pixels down every grass border. The
        // caller takes dFdx/dFdy of the world position ONCE, outside the
        // branch where it is legal, and both octaves scale the same pair --
        // the uv is a plain multiple of position, so its derivative is too.
        vec3 auroraStone( vec3 p, vec3 dx, vec3 dy, vec3 w, float k ) {
          return textureGrad( uAtlas, vec3( p.zy * k, ${LAYER.ROCK}.0 ), dx.zy * k, dy.zy * k ).rgb * w.x
               + textureGrad( uAtlas, vec3( p.xz * k, ${LAYER.ROCK}.0 ), dx.xz * k, dy.xz * k ).rgb * w.y
               + textureGrad( uAtlas, vec3( p.xy * k, ${LAYER.ROCK}.0 ), dx.xy * k, dy.xy * k ).rgb * w.z;
        }

        // One PLANAR sample of a ground tile at 1/\`k\` metres per tile. See the
        // GROUND_METRES block for why the ground gets one fetch where a cliff
        // gets three, and textureGrad for the same reason auroraStone has it:
        // both call sites sit inside a guard that folds in distance and the
        // surface classification, so the flow is not quad-uniform and an
        // implicit LOD there is undefined.
        vec3 auroraGroundTile( vec3 p, vec3 dx, vec3 dy, float layer, float k ) {
          return textureGrad( uAtlas, vec3( p.xz * k, layer ), dx.xz * k, dy.xz * k ).rgb;
        }
` : ''}
        // ---- ONE GRIT FETCH, PLANAR, on the xz plane.
        //
        // The layer index is the SURFACE, and it is what makes grass, rock and
        // snow three different materials rather than three tints of one field.
        // Costs nothing: a sampler2DArray fetch is one fetch whatever the layer.
        //
        // textureGrad for the reason every fetch in this file has it -- see the
        // note further down. The gradients are the caller's, taken once outside
        // every branch.
        vec4 auroraGritP( vec2 uv, vec2 dx, vec2 dy, float layer ) {
          return textureGrad( uGritArr, vec3( uv, layer ), dx, dy );
        }
${axis ? `
        // ---- THE SAME FETCH, ON THE ONE PLANE THE SURFACE MOST FACES.
        //
        // Replaces the triplanar helper below it. See the AXIS block for what
        // that buys and the single thing it costs to look at.
        //
        // THE SWIZZLES ARE THE TRIPLANAR ONE'S, unchanged, so the rock layer's
        // anisotropy lands the same way: u is a horizontal world axis in all
        // three projections (z, x, x), which puts the long axis of its features
        // across a wall and the short one up it, and that is bedding.
        //
        // ARITHMETIC SELECTION, and the first draft got this wrong in a way
        // worth recording: written as \`?:\` chains this compiles to CONTROL FLOW,
        // not to selects. glslang emitted OpSelectionMerge per ternary and
        // spirv-opt did not flatten them, taking the shader from 26 branches to
        // 57 -- trading one divergent branch for nine. step() and mix() are
        // arithmetic by construction, so the whole selection is straight-line
        // and the fetch sits at ONE place in uniform flow, which is the entire
        // point of the exercise.
        //
        // Two weights, both exactly 0 or 1: wy picks the xz plane over both
        // walls, wx picks which wall.
        //
        // \`bump\` is in world space, ready to add to auroraBump. Each plane
        // perturbs the two world axes that lie in it and leaves its own alone.
        float auroraGritAxis( vec3 p, vec3 dx, vec3 dy, vec3 n, float k, float layer, float gk, out vec3 bump ) {
          vec3 an = abs( n );
          float wy = step( max( an.x, an.z ), an.y );
          float wx = step( an.z, an.x );
          vec2 uv  = mix( mix( p.xy,  p.zy,  wx ), p.xz,  wy );
          vec2 ddx = mix( mix( dx.xy, dx.zy, wx ), dx.xz, wy );
          vec2 ddy = mix( mix( dy.xy, dy.zy, wx ), dy.xz, wy );
          vec4 t = textureGrad( uGritArr, vec3( uv * k, layer ), ddx * k, ddy * k );
          vec2 s = ( t.gb - 0.5 ) * gk;
          bump = mix( mix( vec3( -s.x, -s.y, 0.0 ),   // xy: u = x, v = y
                           vec3( 0.0, -s.y, -s.x ), wx ),  // zy: u = z, v = y
                      vec3( -s.x, 0.0, -s.y ), wy );   // xz: u = x, v = z
          return t.r;
        }
` : ''}${lofi && !axis ? `
        // ---- THE SAME FETCH, TRIPLANAR, and rock only. Three fetches.
        //
        // The lo-fi variant drops the stone photograph, which was the only
        // triplanar thing in the shader, and a cliff is exactly where a flat xz
        // projection fails: it stretches a tile into vertical smears down every
        // steep face. So the triplanar moves onto the layer that replaced it.
        // It is affordable here in a way it was not there because it is ONE
        // octave rather than two, and because the guard folds in both the
        // surface and the near fade -- outside the crags and past ${RELIEF_FAR} m
        // nothing pays for it.
        //
        // THE BUMP IS BLENDED IN THE THREE PLANES, not in one. Each tap's .gb is
        // dh/du and dh/dv measured IN ITS OWN PROJECTION, so each perturbs the
        // two world axes that lie in that plane and leaves the projection axis
        // alone. Getting a swizzle wrong here does not look like an error, it
        // looks like a cliff lit from slightly the wrong side, so the mapping is
        // spelled out per line.
        //
        // THE ROCK LAYER'S ANISOTROPY LANDS CORRECTLY HERE FOR FREE, and it is
        // worth knowing why before anyone "fixes" a swizzle. Its features are
        // 3.5x longer along the tile's u than its v, and in all three
        // projections u is a HORIZONTAL world axis (z, x, x) while v is the
        // other horizontal one or y. So on a vertical face the long axis is
        // horizontal and the short one runs up the wall, which is bedding.
        //
        // Returns the VALUE channel only. The decorrelated .a has no reader on
        // the coarse rung -- the sparkle and the flecks are the fine rung's --
        // and blending a channel nothing reads is three multiply-adds a
        // fragment on the most expensive path in the file.
        //
        // \`bump\` is in world space, ready to add to auroraBump.
        float auroraGritTri( vec3 p, vec3 dx, vec3 dy, vec3 w, float k, float layer, float gk, out vec3 bump ) {
          vec4 tx = textureGrad( uGritArr, vec3( p.zy * k, layer ), dx.zy * k, dy.zy * k );
          vec4 ty = textureGrad( uGritArr, vec3( p.xz * k, layer ), dx.xz * k, dy.xz * k );
          vec4 tz = textureGrad( uGritArr, vec3( p.xy * k, layer ), dx.xy * k, dy.xy * k );
          vec2 sx = ( tx.gb - 0.5 ) * gk; // u = z, v = y  -> perturbs z and y
          vec2 sy = ( ty.gb - 0.5 ) * gk; // u = x, v = z  -> perturbs x and z
          vec2 sz = ( tz.gb - 0.5 ) * gk; // u = x, v = y  -> perturbs x and y
          bump = vec3( 0.0, -sx.y, -sx.x ) * w.x
               + vec3( -sy.x, 0.0, -sy.y ) * w.y
               + vec3( -sz.x, -sz.y, 0.0 ) * w.z;
          return tx.r * w.x + ty.r * w.y + tz.r * w.z;
        }
` : ''}
        // The normal perturbation, accumulated where the grit fetches happen
        // and applied at normal_fragment_begin. It lives at file scope because
        // those are two different chunk includes and nothing else crosses
        // between them any more: the classifications and fades used to be up
        // here too, back when the normal pass computed its own bumps and needed
        // them. It does not -- the SLOPE arrives in the .gb of the very fetches
        // the colour pass is already making, and re-fetching them one include
        // later to read two more channels would double the most expensive thing
        // left in this shader -- so this is the only survivor.
        vec3 auroraBump;

        // ---- Why there is no noise function in this file any more.
        //
        // There was, and it was correct: an integer-hash value noise, chosen
        // over the usual fract-of-a-big-multiply because that one collapses at
        // world scale. Measured on a 400-cell row at the sparkle octave it gave
        // 148 distinct values out of 400 at the origin, 16 at 1 km, and at 6 km
        // TWO -- a comb with a period of 50 m, which is what drew the snow
        // flecks in dashed parallel lines. The uint version fixed that outright:
        // 400/400 distinct at every distance to the world edge.
        //
        // It cost three integer multiplies a hash, four hashes a sample, and
        // about twenty samples a near-field fragment. Its own note said "on
        // Adreno these are slower than the float ops they replace -- this is
        // the first thing to look at if the Quest turns out to be fill bound
        // here." The Quest turned out to be fill bound here.
        //
        // Both problems -- the collapse at distance and the cost -- are gone for
        // the same reason. A texture fetch has no precision to lose: the lattice
        // is 256 texels and the wrap is exact however far from the origin the
        // sample is taken. See grit-texture.js.
        //
        // EVERY FETCH BELOW IS textureGrad AND THE GRADIENTS COME FROM ONE PAIR
        // OF DERIVATIVES TAKEN OUTSIDE ALL THE BRANCHES. Every guard in this
        // shader folds in distance and the surface classification, so none of
        // them is quad-uniform -- a quad at the foot of a crag has some lanes in
        // and some out. An implicit-LOD fetch there has no defined result per
        // the ES spec, and the way it actually fails is the sharpest mip on a
        // fragment that wanted the blurriest: a line of sparkling pixels down
        // every border. Since every uv here is a plain (optionally rotated)
        // multiple of world XZ, one pair of world-position derivatives scales
        // to all of them.
        //
        // (The wording above dodges one particular word on purpose --
        // check-daynight.mjs greps the assembled source for it as its
        // unresolved-template tripwire, and a comment must not trip a gate.)`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Surface classification, shared by both layers. Read off the vertex
          // colour so batched geometry stays position/normal/colour: grass is
          // green-dominant by construction in chunk-mesh.js, snow is the only
          // thing with a high blue channel, and rock is whatever is left.
          //
          // IT HAS TO REACH 1.0 ON REAL GRASS, and for a long time it did not.
          // C_GRASS is (0.048, 0.088, 0.030), so g - max(r, b) is 0.040 and the
          // old times-20 clamp topped out at 0.80 on the greenest ground in the
          // world. That 0.80 then multiplied five separate things -- the ground
          // tile's weight, the green tints, the grass exposure, and (through
          // auroraProc, which is 1 - tileFade * this) the procedural grain and
          // fleck layers the tile exists to REPLACE. The meadow got 80% of the
          // photograph plus 20% of a flat palette plus 20% of the noise the
          // photograph was standing in for: three surfaces at one scale, which
          // is the muddy, waxy, low-chroma ground this was reported as.
          //
          // The upper edge is therefore inside C_GRASS's own margin rather than
          // past it, so pure grass saturates and auroraProc is exactly 0 there.
          // The lower edge is what still lets the altitude ramp toward C_SCRUB
          // (g - max(r, b) = -0.005) and the steepness ramp toward C_ROCK fade
          // this out smoothly; snow is far negative and never registers.
          float auroraGreenBase = smoothstep( 0.004, 0.030, vColor.g - max( vColor.r, vColor.b ) );
          float auroraVertexSnow = smoothstep( 0.30, 0.60, vColor.b );

          // Hoisted above every layer below because the FIRST of them needs it.
          float auroraDist = length( vWorldPos - cameraPosition );

          // ONE PAIR OF DERIVATIVES FOR THE WHOLE SHADER, taken here where the
          // flow is still quad-uniform. Every fetch below sits inside a guard
          // that folds in distance and the surface classification, so none of
          // them may take its own -- see the note in <common>.
          vec3 auroraDPx = dFdx( vWorldPos );
          vec3 auroraDPy = dFdy( vWorldPos );
          mat2 auroraRot = ${ROT};

          // Filled by the two grit fetches below and applied at
          // normal_fragment_begin, which is a different chunk include.
          auroraBump = vec3( 0.0 );

          // How much of this surface's own colour survives the haze, 0..1, and
          // the gate the colour-detail layers hang off. See HAZE_GONE.
          //
          // The USE_FOG guard is not defensive tidiness: createTerrainMaterial is
          // also worn by the preview stages and by MacroTerrain, which may run in
          // a scene with no fog at all. No haze means no licence to simplify, so
          // the fallback is the full-detail answer rather than a cheaper one.
          float auroraSeen = 1.0;
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              float auroraHazeF = fogDensity * auroraDist;
              auroraSeen = exp( - auroraHazeF * auroraHazeF );
            #else
              auroraSeen = 1.0 - smoothstep( fogNear, fogFar, auroraDist );
            #endif
          #endif
          float auroraDetailK = smoothstep( ${HAZE_GONE.toFixed(3)}, ${HAZE_FULL.toFixed(3)}, auroraSeen );

          // ---- The macro tile, coarse sample. ONE KILOMETRE PER TILE.
          //
          // Its fbm ladder runs the whole tile down to a thirty-second of it, so
          // one sample carries ~1 km regions through ~32 m mottle. Two channels
          // are read: .r is regional value and tint, .a is where the snow line
          // wanders.
          //
          // WHERE IT IS SAMPLED is the largest single cost decision in the file.
          // In full and lo-fi it is a fragment fetch, and the only one every
          // fragment in the world pays unconditionally -- half of what the lo-fi
          // rung costs over a stock Lambert on a Quest. LEAN reads it in the
          // vertex shader and interpolates the two channels down; see the LEAN
          // block and the vertex patch.
          //
          // texture() and not textureGrad, alone among the fetches in this
          // shader, and it is safe for exactly one reason: this is the only one
          // that sits at top-level flow rather than inside a guard, so it is
          // quad-uniform and the implicit derivative is defined. It is also the
          // SAME derivative -- dFdx( auroraMU ) is dFdx( vWorldPos.xz ) times
          // the same constant the explicit form multiplies by.
${lean ? `          float auroraMR = vMacro.x;
          float auroraMA = vMacro.y;` : `          vec2 auroraMU = vWorldPos.xz * ${(1 / MACRO_METRES).toFixed(8)};
          vec4 auroraM = texture( uMacroMap, auroraMU );
          float auroraMR = auroraM.r;
          float auroraMA = auroraM.a;`}

          // ---- The macro tile, fine sample: ${MACRO_FINE_METRES} m per tile, rotated.
          //
          // FETCHED HERE, ABOVE THE SNOW LINE, because the boundary dither wants
          // its .a and the mid-range tint block below wants its .r and .g. One
          // fetch, two consumers, and hoisting it is what stops the second from
          // being a second fetch.
          //
          // Defaults to the field's own mean when the haze gate is shut, so
          // every consumer of it degrades to "this octave contributes nothing"
          // rather than to a wrong value.
          vec4 auroraMF = vec4( 0.5 );
${lofi ? '' : `          if ( auroraDetailK > 0.004 ) {
            auroraMF = textureGrad( uMacroMap, auroraRot * ( vWorldPos.xz * ${(1 / MACRO_FINE_METRES).toFixed(8)} ),
              auroraRot * ( auroraDPx.xz * ${(1 / MACRO_FINE_METRES).toFixed(8)} ),
              auroraRot * ( auroraDPy.xz * ${(1 / MACRO_FINE_METRES).toFixed(8)} ) );
          }`}

          // ---- Boundary dither.
          //
          // The snow line arrives here as a smooth ramp interpolated across
          // triangles, so wherever it crosses the grid at an angle it steps.
          // Alternating the mesh diagonal (chunk-mesh.js) stops that step being
          // REGULAR, but the boundary is still resolved at vertex spacing --
          // 50 cm at the leaf and far coarser in the LOD rings, which is where
          // it is most visible.
          //
          // Displacing the classification by a world-space field moves the
          // decision off the grid entirely: the border now wanders on the
          // field's wavelengths, which are the same at every LOD and every
          // distance.
          //
          // TWO SAMPLES, and the coarse one is the reason this reads at range.
          // An early version had only ~11 m and ~3 m of wobble, which is plenty
          // standing next to it and useless a kilometre away: 11 m at 2 km
          // subtends about 0.3 degrees, so it averages to a flat tint and what
          // survives is the vertex ramp underneath -- and that ramp is a
          // function of elevation alone, so it draws a level contour line around
          // every distant peak. The 1 km sample is specifically what stopped
          // that, so it is NOT distance-gated: it is the same snow line seen
          // from further away, so it should be the same shape, and up close she
          // is simply standing inside one lobe of it. Physically that is the
          // right variable to jitter anyway -- a real snow line is not level,
          // since aspect, wind loading and shading move it by tens of metres
          // over a few hundred metres of ground.
          //
          // The fine sample is gated, on the haze rather than on a distance:
          // its finest wavelengths are a few metres and subtend a fraction of a
          // pixel from anywhere the gate is shut.
          //
          // Its weight is HANDED UP rather than dropped as it fades. Dropping it
          // would shrink the displacement at range, which is the exact failure
          // the coarse sample exists to fix; renormalising keeps the boundary
          // wandering just as far, on wavelengths the distance can still
          // resolve. With the gate open the arithmetic is the same as the
          // ungated version, term for term.
          float auroraBW = ${lofi ? '0.72' : '0.72 + 0.28 * auroraDetailK'};
          float auroraBN = 0.5 + ( ( auroraMA - 0.5 ) * 0.72
                                 + ( auroraMF.a - 0.5 ) * 0.28 * auroraDetailK ) / auroraBW;

          float auroraSnowD = clamp( auroraVertexSnow + ( auroraBN - 0.5 ) * uBoundary, 0.0, 1.0 );
          float auroraSnowBase = smoothstep( 0.25, 0.75, auroraSnowD );
          // SNOW GETS ITS ALBEDO HERE, not from the vertex, and the difference
          // is most of what "snow" looks like. shade() in chunk-mesh-v2.js does
          // two jobs with one number: its snow factor is the COVERAGE, cut by
          // steepness so cliffs do not read as white walls, and it is also the
          // weight it lerps the vertex colour toward C_SNOW by. On a 40 degree
          // flank -- an ordinary snowfield, not a cliff -- coverage is 0.71, so
          // the vertex arrives at (0.634, 0.647, 0.677): 74% of C_SNOW's level
          // and mixed a quarter of the way into dark grey rock, which is pale
          // rock, because that is literally what it is. Meanwhile
          // auroraVertexSnow reads 1.0 there, so every OTHER thing this shader
          // does to snow -- the exposure, the sparkle, the frost pair, the
          // relief weight -- was being applied at full strength to an albedo
          // that had already been quietly darkened by an unrelated mechanism.
          //
          // Mixing to uSnow by auroraSnowBase is what makes the fragment agree
          // with itself: the weight is the shader's own snow decision, the same
          // one every line below reads, so a fragment shaded as 100% snow now
          // starts from 100% snow albedo and a boundary fragment blends. It
          // subsumes the old snowBase-minus-vertexSnow push, which could only
          // ever add the dither's EXCESS on top of the diluted colour; the rock
          // half of the dither below is unchanged.
          //
          // Nothing that was not already snow moves: where auroraVertexSnow is
          // 0 the two expressions are the same expression, so grass, rock and
          // every cliff past ~48 degrees (where vColor.b has fallen under the
          // 0.30 that auroraVertexSnow thresholds) are bit-identical. The two
          // differ only on ground the mesher had already called partly white.
          diffuseColor.rgb = mix( diffuseColor.rgb, uSnow, auroraSnowBase );
          diffuseColor.rgb = mix( diffuseColor.rgb, uRock, clamp( auroraVertexSnow - auroraSnowBase, 0.0, 1.0 ) * ( 1.0 - auroraGreenBase ) );

          float auroraRockBase = ( 1.0 - auroraGreenBase ) * ( 1.0 - auroraSnowBase );

          // ---- The region layer: the coarsest colour variation in the world,
          // and UNGATED, on purpose.
          //
          // It runs at every distance because that is the whole job: everything
          // past the near fades used to be flat green or flat grey, and the
          // reason was never that the palette was too simple -- it was that the
          // only thing varying the palette had already faded out. A distance
          // fade would put the flatness back exactly where this exists to
          // remove it.
          //
          // It is also free, which is what changed. It used to be its own
          // auroraNoise call and one of the three that survived the haze gate;
          // now it is two more channels of a fetch the snow line has already
          // paid for, so gating it would save six multiplies and a smoothstep.
          //
          // Three destinations from one field, which is what "browner, darker,
          // greener" is: the value multiply darkens and lifts whole regions, the
          // high end pulls toward uDirt and the low end toward uDeep. Wide
          // thresholds, because a region is either dry or it is lush or it is
          // neither, and a smoothstep that started at the mean would tint every
          // fragment in the world and average back to the base colour -- which
          // is the flat green this is here to break.
          //
          // Snow gets the value swing at half weight (wind scours a drift into
          // bright and dull ground and that reads as snow) and none of the tint
          // (brown snow reads as dirty snow).
          //
          // ---- WHY THESE THRESHOLDS ARE NOT THE ONES THE COMMENTS DESCRIBE
          //
          // Every tint pair in this shader -- here, the mottle below, the grain
          // and the micro flecks -- was tuned against value noise, whose
          // distribution is centrally concentrated: p01 0.16, p99 0.84 for a
          // two-octave sum. The baked fields are RANK-EQUALISED, so they are
          // exactly uniform on [0,1], and every threshold that had been sitting
          // out in a thin tail suddenly had two to three times as many
          // fragments past it. Measured over 200k fragments, coverage went
          // 12.5% -> 21.0% for the pair on this line alone, and 7.6% -> 24.0%
          // for the mottle's dry end.
          //
          // The visible result was the meadow going grey: DIRT and DRY are the
          // only palette members with g <= r, and tripling their share pulls
          // the average straight off green without changing the brightness much
          // at all. See the measured rows above the palette constants.
          //
          // So each pair was RE-SOLVED for the coverage the palette was tuned
          // against, numerically, on the shipped texture's own bytes -- outer
          // edge pinned where the old field's tail effectively ended (which is
          // 1.0 or 0.0 in rank terms, since the old noise almost never reached
          // its own extremes), inner edge bisected until the mean weight came
          // back. The green ends (uDeep, uMoss) are then deliberately let out
          // to ~1.35x the old coverage: they are the layers that make the
          // ground read as grass rather than as tinted ground, and they are the
          // cheap half of "darker and more verdant".
          //
          // The numbers are therefore NOT hand-picked and NOT meaningful to
          // read as fractions of anything. Change the bake and they are wrong;
          // re-solve them rather than nudging them.
          diffuseColor.rgb *= 1.0 + ( auroraMR - 0.5 ) * uRegionValue * ( 1.0 - auroraSnowBase * 0.5 );
          diffuseColor.rgb = mix( diffuseColor.rgb, uDirt, smoothstep( 0.752, 1.0, auroraMR ) * auroraGreenBase * uRegionTint );
          diffuseColor.rgb = mix( diffuseColor.rgb, uDeep, smoothstep( 0.285, 0.0, auroraMR ) * auroraGreenBase * uRegionTint );

          // ---- The mid-range mottle: ~30 m down to ~4 m, off the fine macro
          // sample fetched above the snow line.
          //
          // Gated on the HAZE and not on a distance, and the difference matters.
          // Its job is the same as the region layer's -- keep a hillside from
          // reading as one colour -- so a distance fade would put the flatness
          // back exactly where it exists to remove it. Transmittance is not that
          // gate. At auroraDetailK zero the fog has already replaced this
          // fragment with its own colour to within a few percent, so there is no
          // flatness left to reveal: the layer is not being faded out, it is
          // being skipped where it can no longer change the pixel.
          //
          // These wavelengths were once 110 m and 38 m and got divided by four,
          // because at that size the two tint layers overlapped across most of
          // any hillside you could see and averaged into one muddy middle tone.
          // The variation was there; it was just too coarse to read as variation
          // rather than as the base colour. The coarse end came back later as
          // the region layer above, which is a separate sample rather than a
          // resizing of this one, so the mid-range mottle is untouched and the
          // gap above it is what got filled.
${lofi ? '' : `          if ( auroraDetailK > 0.004 ) {
            // Snow gets a fraction of the brightness swing and none of the tint.
            // Blotchy snow reads as dirty snow, and the shading already gives it
            // all the form it needs.
            diffuseColor.rgb *= 1.0 + ( auroraMF.r - 0.5 ) * uMacroValue * ( 1.0 - auroraSnowBase * 0.6 );

            // Re-solved for an equalised field. See the region layer's
            // threshold note above; the old pair here was 0.58/0.94.
            diffuseColor.rgb = mix( diffuseColor.rgb, uDry, smoothstep( 0.856, 1.0, auroraMF.r ) * auroraGreenBase * uMacroTint );
            diffuseColor.rgb = mix( diffuseColor.rgb, uDeep, smoothstep( 0.218, 0.0, auroraMF.r ) * auroraGreenBase * uMacroTint );
            // Rock stains on a DECORRELATED channel of the same fetch, not on
            // the one that just tinted the grass: mineral banding follows the
            // face, not the valley, so it should not track the meadow's dry
            // patches. Free, because the fetch returned it either way.
            // Re-solved for an equalised field like the grass pairs above --
            // 0.52/0.95 caught 17.5% of a rock face under value noise and 26.5%
            // under this one. No coverage boost here: rock was not the surface
            // that read wrong, so it just goes back to where it was.
            diffuseColor.rgb = mix( diffuseColor.rgb, uStain, smoothstep( 0.65, 1.0, auroraMF.g ) * auroraRockBase * uMacroTint * 0.8 );
          }`}

          float auroraNear = 1.0 - smoothstep( ${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, auroraDist );
          float auroraRelief = 1.0 - smoothstep( ${RELIEF_NEAR.toFixed(1)}, ${RELIEF_FAR.toFixed(1)}, auroraDist );
${lean ? '' : `          float auroraMicroFade = 1.0 - smoothstep( ${MICRO_NEAR.toFixed(1)}, ${MICRO_FAR.toFixed(1)}, auroraDist );`}
          // How much of grass's and snow's texture the photographed ground tiles
          // are carrying at this fragment: 1 inside GROUND_NEAR, 0 past
          // GROUND_FAR, and 0 ALWAYS when there is no atlas to sample. The grit
          // layers read it to get out of the way of whatever it is covering, so
          // its default has to be the one that leaves the untextured shader
          // exactly as it was. Overwritten by the ground-tile block below
          // wherever there is an atlas.
          float auroraTileFade = 0.0;
${stone ? `
          // ---- Stone. See the header block above STONE_METRES.
          //
          // BEFORE the grain and micro layers rather than after, so those keep
          // the last word: they are the layers that were tuned to sit on top of
          // whatever the surface is, and speckle over stone reads as stone,
          // where stone over speckle reads as a decal.
          //
          // The fade folds auroraRockBase in, so the guard skips the fetches
          // entirely on grass and on snow -- which, below the snow line and
          // outside the crags, is nearly every fragment.
          float auroraStoneK = ( 1.0 - smoothstep( ${STONE_NEAR.toFixed(1)}, ${STONE_FAR.toFixed(1)}, auroraDist ) ) * auroraRockBase;
          // The derivatives these fetches need were taken at the top of the
          // block, outside every guard -- a derivative is only defined in
          // quad-uniform flow and this guard is not. See auroraStone.
          if ( auroraStoneK > 0.004 ) {
            // The GEOMETRIC normal, deliberately: this runs before
            // normal_fragment_begin, so the relief pass has not perturbed
            // anything yet, and a triplanar blend keyed off bump normals would
            // make the projection swim over a surface that is not moving.
            vec3 auroraWN = normalize( inverseTransformDirection( normalize( vNormal ), viewMatrix ) );
            vec3 auroraTri = pow( abs( auroraWN ), vec3( 4.0 ) );
            auroraTri /= ( auroraTri.x + auroraTri.y + auroraTri.z );

            vec3 auroraRockTex = auroraStone( vWorldPos, auroraDPx, auroraDPy, auroraTri, ${(1 / STONE_METRES).toFixed(6)} ) / uStoneMean;
            diffuseColor.rgb *= mix( vec3( 1.0 ), auroraRockTex, uStone * auroraStoneK );

            float auroraFineK = ( 1.0 - smoothstep( ${FINE_NEAR.toFixed(1)}, ${FINE_FAR.toFixed(1)}, auroraDist ) ) * auroraStoneK;
            if ( auroraFineK > 0.004 ) {
              // LUMINANCE only, where the coarse octave keeps its colour. Two
              // decorrelated copies of the same tile's mineral tinting stacked
              // on one fragment reads as chromatic noise rather than as more
              // rock, and dropping the chroma here also means the near octave
              // cannot push the palette anywhere the coarse one has not
              // already been allowed to.
              vec3 auroraFineTex = auroraStone( vWorldPos, auroraDPx, auroraDPy, auroraTri, ${(1 / FINE_METRES).toFixed(6)} );
              float auroraFineL = dot( auroraFineTex, vec3( 0.2126, 0.7152, 0.0722 ) )
                / dot( uStoneMean, vec3( 0.2126, 0.7152, 0.0722 ) );
              diffuseColor.rgb *= mix( 1.0, auroraFineL, uStoneFine * auroraFineK );
            }
          }

          // ---- The ground tile. See the GROUND_METRES block above.
          //
          // GRASS ONLY. There was a snow tile here too and it is gone: a
          // photograph of snow is a photograph of an almost-featureless white
          // surface, so nearly all of what it carried was the one thing a tile
          // cannot hide -- its own repeat. Grass gets away with tiling because
          // blades are high-frequency and the eye reads the frequency rather
          // than the period; snow has no such cover, and a 4 m square of subtle
          // grey shading laid end to end is a visible grid.
          //
          // What replaces it is nothing new: the grain, fleck and sparkle
          // layers below already draw snow, and were merely being SUPPRESSED
          // wherever the tile claimed to be carrying that scale already (see
          // auroraProc). Dropping the tile hands snow back to them, and they do
          // not tile -- the grit tile's two scales are incommensurate and
          // mutually rotated. It is also one fewer fetch on every snow fragment
          // inside 150 m.
          //
          // Same shape as the stone block, one fetch instead of three, and the
          // guard folds the surface in so nothing above the snow line pays for
          // it at all. It reuses the derivatives taken outside the stone guard:
          // the uv is a plain multiple of world position, so its derivative is
          // one too.
          auroraTileFade = 1.0 - smoothstep( ${GROUND_NEAR.toFixed(1)}, ${GROUND_FAR.toFixed(1)}, auroraDist );

          float auroraGrassK = auroraTileFade * auroraGreenBase;
          if ( auroraGrassK > 0.004 ) {
            vec3 auroraGrassTex = auroraGroundTile( vWorldPos, auroraDPx, auroraDPy, ${LAYER.TERRAIN_GRASS}.0, ${(1 / GROUND_METRES).toFixed(6)} ) / uGrassTileMean;
            diffuseColor.rgb *= mix( vec3( 1.0 ), auroraGrassTex, uGrassTile * auroraGrassK );
          }
` : ''}
          // Opened on the LONGER of the two coarse-grit fades, because one fetch
          // feeds both and the lighting half reaches further than the colour
          // half. See the block above RELIEF_NEAR.
          if ( auroraRelief > 0.004 ) {
            // HOW MUCH OF THIS FRAGMENT THE PHOTOGRAPH IS NOT CARRYING. Rock is
            // always 1 -- it has a tile of its own but that one is bedding at
            // 16 m, which says nothing at half a metre. SNOW IS ALSO ALWAYS 1
            // NOW: its tile is gone (see the ground-tile block), so the grit
            // below is not standing in for a photograph on snow, it is the only
            // thing drawing snow at this scale. Only grass falls to 0 inside
            // GROUND_NEAR and comes back as its tile fades out.
            float auroraProc = clamp( 1.0 - auroraTileFade * auroraGreenBase, 0.0, 1.0 );

            // ---- WHICH GRIT. Three baked fields live in one sampler2DArray --
            // fine blotchy grass, coarse grainy rock, drifted snow -- and
            // a layer index costs nothing: an array fetch reads one layer, so
            // three characters of surface arrive at the price of the one field
            // that used to serve all three.
            //
            // A HARD SWITCH, not a blend. Blending would mean two fetches on
            // every fragment near a boundary to hide a seam that lands
            // mid-ramp, where auroraGreenBase is already swinging the palette
            // from green to grey; the palette change reads as the transition
            // and the grain change rides along under it.
            float auroraGritLayer = auroraSnowBase > 0.5 ? ${GRIT_LAYER.SNOW}.0
              : ( auroraGreenBase > 0.5 ? ${GRIT_LAYER.GRASS}.0 : ${GRIT_LAYER.ROCK}.0 );

            // ---- THE GRIT TILE, COARSE SAMPLE: ${GRIT_METRES} m, 4.6 cm texels, NEAREST.
            //
            // This one fetch is what four auroraNoise calls and two auroraGrad
            // calls used to be -- a ~3.5 m patch noise, a ~0.5 m grain, and two
            // octaves of normal relief at ~1.4 m and ~0.45 m. Its baked fbm
            // covers 2.9 m down to 18 cm and its per-texel speckle covers 4.6 cm,
            // which is that whole ladder; its .gb are the slope of the very
            // field its .r colours, so the surface is lit by the thing it is
            // made of instead of by a second, independent noise.
            //
            // auroraGSlope is the world-space tilt this sample asks for, at unit
            // amplitude. The planar path builds it from .gb; the triplanar path
            // below returns it already assembled, because there the tilt has to
            // come out of three differently-oriented fetches.
            float auroraGR;
            vec3 auroraGSlope;
${lofi ? `            // The GEOMETRIC normal, deliberately: this runs before
            // normal_fragment_begin, so nothing has perturbed it yet, and a
            // projection keyed off bump normals would swim over a surface that
            // is not moving.
            vec3 auroraWN = normalize( inverseTransformDirection( normalize( vNormal ), viewMatrix ) );
${axis ? `            // ONE FETCH ON THE DOMINANT PLANE, every surface, no branch. On
            // anything under 45 degrees this IS the xz projection the planar
            // path takes, so the rock guard the triplanar version needed has
            // nothing left to guard. See the AXIS block.
            auroraGR = auroraGritAxis( vWorldPos, auroraDPx, auroraDPy, auroraWN,
              ${(1 / GRIT_METRES).toFixed(8)}, auroraGritLayer,
              ${(GRIT_GRAD_SCALE / GRIT_METRES).toFixed(6)}, auroraGSlope );
` : `            // TRIPLANAR, ROCK ONLY, AND ONLY WHERE ROCK IS ACTUALLY STEEP.
            // Without an atlas this is the only thing keeping a cliff from
            // wearing a vertically smeared xz projection, and the whole reason
            // it is affordable is that the guard is narrow twice over: rock
            // fragments only, steep ones only, inside RELIEF_FAR only. A flat
            // rock shelf takes the planar path because at auroraWN.y near 1 the
            // triplanar blend IS the xz projection, at three times the price.
            if ( auroraGritLayer == ${GRIT_LAYER.ROCK}.0 && auroraWN.y < 0.86 ) {
              vec3 auroraTri = pow( abs( auroraWN ), vec3( 4.0 ) );
              auroraTri /= ( auroraTri.x + auroraTri.y + auroraTri.z );
              vec3 auroraTB;
              auroraGR = auroraGritTri( vWorldPos, auroraDPx, auroraDPy, auroraTri,
                ${(1 / GRIT_METRES).toFixed(8)}, ${GRIT_LAYER.ROCK}.0,
                ${(GRIT_GRAD_SCALE / GRIT_METRES).toFixed(6)}, auroraTB );
              auroraGSlope = auroraTB;
            } else {
              vec4 auroraG = auroraGritP( vWorldPos.xz * ${(1 / GRIT_METRES).toFixed(8)},
                auroraDPx.xz * ${(1 / GRIT_METRES).toFixed(8)},
                auroraDPy.xz * ${(1 / GRIT_METRES).toFixed(8)}, auroraGritLayer );
              auroraGR = auroraG.r;
              vec2 auroraS = ( auroraG.gb - 0.5 ) * ${(GRIT_GRAD_SCALE / GRIT_METRES).toFixed(6)};
              auroraGSlope = vec3( -auroraS.x, 0.0, -auroraS.y );
            }
`}` : `            {
              vec4 auroraG = auroraGritP( vWorldPos.xz * ${(1 / GRIT_METRES).toFixed(8)},
                auroraDPx.xz * ${(1 / GRIT_METRES).toFixed(8)},
                auroraDPy.xz * ${(1 / GRIT_METRES).toFixed(8)}, auroraGritLayer );
              auroraGR = auroraG.r;
              vec2 auroraS = ( auroraG.gb - 0.5 ) * ${(GRIT_GRAD_SCALE / GRIT_METRES).toFixed(6)};
              auroraGSlope = vec3( -auroraS.x, 0.0, -auroraS.y );
            }
`}
            // ---- The COLOUR half of the coarse rung, which stops at FADE_FAR
            // where its tile would start reading as a lattice.
${grain ? `            // UNGUARDED, because grain has cut the body to three ops and the
            // guard now costs more than it saves. auroraNear reaching 0 already
            // takes auroraGrain to exactly 0.5, which multiplies by 1.0 and
            // changes nothing, so the fade is arithmetic and the branch was only
            // ever an optimisation.
            float auroraGrain = mix( 0.5, auroraGR, auroraNear );
            diffuseColor.rgb *= 1.0 + ( auroraGrain - 0.5 ) * uSpeckle * auroraProc;
` : `            // Its own guard, so the fragments between FADE_FAR and RELIEF_FAR
            // pay for the fetch and the bump below and nothing else -- without
            // it every one of them would run the speckle and both mixes to
            // arrive at auroraGrain = 0.5 and change nothing.
            if ( auroraNear > 0.004 ) {
              // Faded toward the field's own mean rather than toward zero, so
              // the layer leaves the surface where it found it as it goes.
              float auroraGrain = mix( 0.5, auroraGR, auroraNear );

              // Brightness speckle. Applies to grass, rock and snow alike --
              // snow without it is a flat white void with no readable surface.
              diffuseColor.rgb *= 1.0 + ( auroraGrain - 0.5 ) * uSpeckle * auroraProc;

              // Dirt and moss only show through on green ground, and only close
              // enough to see them -- and only where the meadow tile is not
              // already drawing the soil between the blades, which up close is
              // everywhere. The thresholds mean exactly what they read as: the
              // grit field is rank-equalised, so dirt catches the top 19% of
              // texels and moss the bottom 29%. See equalise() in
              // grit-texture.js.
              float auroraGreen = auroraGreenBase * auroraNear * ( 1.0 - auroraTileFade );
              diffuseColor.rgb = mix( diffuseColor.rgb, uDirt, smoothstep( 0.813, 1.0, auroraGrain ) * auroraGreen * uDirtAmount );
              diffuseColor.rgb = mix( diffuseColor.rgb, uMoss, smoothstep( 0.292, 0.0, auroraGrain ) * auroraGreen * uMossAmount );
            }
`}
            // ---- Relief, coarse rung. See uRelief.
            //
            // .gb is dh/du in TILE units, so dividing by the tile's size in
            // metres is what turns it into a real slope -- and it is why the two
            // rungs can share one amplitude convention despite being five times
            // apart in size. That division is folded into auroraGSlope above.
            //
            // FLAT ACROSS SURFACES. Each layer carries its own relief in its
            // own baked field, and the bake's per-spec relief factor has already
            // put the three on one mean slope, so weighting them differently
            // here would be fighting it for control of the same quantity.
            // uReliefSnow is the one knob left, and it exists because snow is
            // the surface where a wrong answer is loudest: it is nearly white,
            // so N.L is the only thing drawing it and any relief error is the
            // whole pixel.
            //
            // On auroraRelief rather than auroraNear: this is the half of the
            // fetch that outlives the grain. See the block above RELIEF_NEAR.
            if ( uRelief > 0.0 ) {
              float auroraReliefAmt = auroraRelief * uRelief *
                ( 1.0 - auroraSnowBase * ( 1.0 - uReliefSnow ) );
              auroraBump += auroraGSlope * auroraReliefAmt;
            }

${lean ? '' : `            // ---- THE GRIT TILE, FINE SAMPLE: ${GRIT_FINE_METRES} m, 9 mm texels, rotated.
            //
            // Nested inside the coarse block because its fade is strictly
            // inside both of that block's -- at MICRO_FAR auroraNear is still
            // 0.58 and auroraRelief 0.92 -- so there is no distance at which
            // this is wanted and the coarse sample is not. It replaces the
            // sparkle, the fleck tint and the 10 cm relief octave, which between
            // them were five auroraNoise calls.
            //
            // It is also what stops the coarse sample reading as a repeating
            // 11.7 m tile underfoot. Rotated ~37 degrees off it for the same
            // reason, and the rotation is why the slope it returns has to be
            // turned BACK before it can be added to a world-space bump: the
            // gradient a rotated fetch reports is in the rotated frame, and the
            // transpose of a rotation is its inverse.
            //
            // PLANAR even where the coarse rung went triplanar. At ${GRIT_FINE_METRES} m the
            // features are 4 cm flecks; the vertical smear a wall would give
            // them is a smear of specks, which is still specks. Triplanar here
            // would triple the cost of the near-field's second fetch to fix
            // something nobody can see.
            if ( auroraMicroFade > 0.004 ) {
              vec4 auroraGF = auroraGritP( auroraRot * ( vWorldPos.xz * ${(1 / GRIT_FINE_METRES).toFixed(8)} ),
                auroraRot * ( auroraDPx.xz * ${(1 / GRIT_FINE_METRES).toFixed(8)} ),
                auroraRot * ( auroraDPy.xz * ${(1 / GRIT_FINE_METRES).toFixed(8)} ), auroraGritLayer );

              // ---- Snow glitter.
              //
              // Snow's problem is the opposite of grass's: it is already bright,
              // so darkening it with grain reads as dirt rather than as texture.
              // What real snow gives you at walking distance is individual
              // crystals catching the sun -- isolated points BRIGHTER than the
              // surface, on a surface that is otherwise smooth.
              //
              // So: the fine tile's DECORRELATED channel, thresholded hard so
              // only the top few percent survive, added rather than multiplied.
              // The threshold is what makes it read as discrete points; a smooth
              // version of this is just noise and looks like static.
              //
              // 0.93 was the WRONG number and it is worth saying why, because
              // the reasoning that produced it was backwards: "equalised, so
              // 0.93 is exactly the top 7%" is true and is exactly the bug. The
              // old field was value noise at 8.3 m and 0.93 caught 0.33% of it,
              // not 7% -- a bell curve barely reaches its own extremes. Twenty
              // times as many crystals is not a sparkle, it is a sheen, and a
              // sheen that ADDS is a white film over the snow. 0.994 puts the
              // count back where uSnowSparkle was set for it.
              //
              // .a and not .r because .r is quantised to six steps for the
              // pixelated look, and a hard threshold on a staircase either
              // catches a whole tread or none of it.
              diffuseColor.rgb += smoothstep( 0.994, 1.0, auroraGF.a ) * auroraSnowBase * auroraNear * uSnowSparkle;

              // ---- Micro layer: ~4 cm flecks, on every surface, near only.
              //
              // ONE FIELD FEEDING BOTH ENDS OF EACH PAIR: the light fleck sits
              // where it peaks and the dark fleck in the valleys between, which
              // is how the grain layer above already works. The thresholds are
              // tighter than the grain's -- 0.62/0.90 rather than 0.56/0.88 --
              // so this reads as discrete specks scattered over the coarser
              // mottling rather than as a second wash of it. That is the whole
              // difference between "speckled" and "muddy" at this size.
              //
              // Re-solved for an equalised field. See the region layer's
              // threshold note; the old pair here was 0.62/0.90, and the gap
              // between the two pairs is preserved in coverage rather than in
              // value -- what "tighter than the grain's" has to mean once the
              // field underneath is uniform.
              float auroraMicroN = auroraGF.r;
              float auroraMicroHi = smoothstep( 0.747, 0.98, auroraMicroN );
              float auroraMicroLo = smoothstep( 0.351, 0.02, auroraMicroN );
              float auroraMicroK = auroraMicroFade * uMicroTint;
              // The grass tile resolves 8 mm, so on grass it has already drawn
              // this scale and drawn it from a photograph. Rock keeps its pair
              // whole -- the stone tile it wears is 16 m of bedding, which is
              // four scales coarser than a fleck -- and so does SNOW, which no
              // longer has a tile at all, and for which this pair plus the
              // sparkle is now the entire near-field surface.
              float auroraMicroProc = 1.0 - auroraTileFade * auroraGreenBase;

              diffuseColor.rgb *= 1.0 + ( auroraMicroN - 0.5 ) * uMicroValue * auroraMicroFade * auroraProc;

              // Grass reuses DIRT and MOSS on purpose -- see the note on the
              // micro palette. Rock and snow get the pairs of their own.
              diffuseColor.rgb = mix( diffuseColor.rgb, uDirt, auroraMicroHi * auroraGreenBase * auroraMicroK * auroraMicroProc );
              diffuseColor.rgb = mix( diffuseColor.rgb, uMoss, auroraMicroLo * auroraGreenBase * auroraMicroK * auroraMicroProc );
              diffuseColor.rgb = mix( diffuseColor.rgb, uGrit, auroraMicroHi * auroraRockBase * auroraMicroK );
              diffuseColor.rgb = mix( diffuseColor.rgb, uSoot, auroraMicroLo * auroraRockBase * auroraMicroK );
              diffuseColor.rgb = mix( diffuseColor.rgb, uFrost, auroraMicroHi * auroraSnowBase * auroraMicroK * auroraMicroProc );
              diffuseColor.rgb = mix( diffuseColor.rgb, uShade, auroraMicroLo * auroraSnowBase * auroraMicroK * auroraMicroProc );

              // ---- Relief, fine rung. Added to the same bump vector rather
              // than applied as a second normalize: two successive normalizes
              // would let the coarse tilt swallow the fine one wherever the
              // coarse tilt is large, which is on rock -- precisely where this
              // rung is meant to be strongest.
              //
              // Nested inside the uRelief guard on purpose: if the headset ever
              // needs the whole normal pass gone, uRelief = 0 must still kill it.
              if ( uRelief > 0.0 && uMicroRelief > 0.0 ) {
                // Flat across surfaces, for the reason given on the coarse rung.
                float auroraMicroAmt = auroraMicroFade * uMicroRelief;
                vec2 auroraMS = ${ROT_T} * ( ( auroraGF.gb - 0.5 ) * ${(GRIT_GRAD_SCALE / GRIT_FINE_METRES).toFixed(6)} );
                auroraBump += vec3( -auroraMS.x, 0.0, -auroraMS.y ) * auroraMicroAmt;
              }
            }`}
          }

          // ---- Exposure, LAST. See uSnowAlbedo.
          //
          // At the very end and as a plain scale on the finished colour, which
          // is what makes it safe: every layer above it -- the tints, the tile,
          // the flecks, the sparkle -- is scaled by the same factor, so the
          // whole chain keeps its ratios and only the absolute level moves. Put
          // this anywhere earlier and each subsequent mix() toward an absolute
          // palette colour would drag the surface back up, and the sparkle,
          // which ADDS, would drag it up hardest of all.
          diffuseColor.rgb *= mix( 1.0, uSnowAlbedo, auroraSnowBase );
          diffuseColor.rgb *= mix( vec3( 1.0 ), uGrassTone, auroraGreenBase );
        }`
      )
      // ---- Near-field relief: APPLY ONLY. The slopes were accumulated into
      // auroraBump up in <color_fragment>, by the same two grit fetches that
      // coloured the fragment -- which is the entire reason this is cheap now.
      // It used to call auroraGrad three times here, nine value-noise evaluations
      // and thirty-six integer hashes, off fields that had nothing to do with the
      // ones doing the colouring, so the surface was lit as though it were made of
      // something other than what it looked like. Now .gb of each grit fetch IS
      // the derivative of the .r that coloured it.
      //
      // IT DELIBERATELY DOES NOT GO IN THE HEIGHT FIELD. The leaf chunk resolves
      // 1.00 m cells, so a seventh detail octave would land at ~0.7 m wavelength,
      // below Nyquist for the mesh that has to carry it: it would alias into a
      // crawling pattern that changes every time a chunk rebuilds, cost five more
      // field evaluations on the collision path, and manufacture exactly the
      // sub-metre slope refusals §4 removed. Perturbing the shading normal buys
      // the look with none of that -- geometry-free, keyed to world XZ so it does
      // not rescale across LOD rings, and riding the same near fades as the colour
      // so it is gone before it can alias. §7 has the amplitude derivations.
      //
      // Placed at normal_fragment_begin, which runs after color_fragment, so
      // auroraBump is already filled. `normal` is in VIEW space here, hence the
      // viewMatrix on the perturbation -- as a direction, so translation drops
      // out. No guard on uRelief: the two blocks that write auroraBump are
      // themselves guarded, so with relief off this is normalize() of an
      // unchanged normal, which is what the chunk just did anyway.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal = normalize( normal + ( viewMatrix * vec4( auroraBump, 0.0 ) ).xyz );`
      )
  }

  // Distinct cache key so this never gets conflated with an unpatched Lambert,
  // and distinct BETWEEN the variants: the atlas, the lofi flag and the lean
  // flag each change the compiled source, so no two of them may share a program.
  // Lean is the only one that changes the VERTEX shader as well.
  const key = `aurora-terrain-v11${stone ? '-stone' : ''}${grain ? '-grain' : axis ? '-axis' : lean ? '-lean' : lofi ? '-lofi' : ''}`
  material.customProgramCacheKey = () => key

  return material
}

// ---------------------------------------------------------------------------
// THE PLAIN RUNG, which is what the headset draws: the mesher's vertex colours
// under a stock Lambert, with the two EXPOSURE stages off the bottom of the full
// shader and nothing else. No atlas fetch, no near block, no macro layers, no
// branches. Everything this file spends its milliseconds on is gone.
//
// WHY THOSE TWO STAGES SURVIVE THE CUT WHEN THE REST DOES NOT. Every other layer
// above ADDS surface detail the vertex colours cannot carry, so dropping it costs
// variety and nothing else. These two add nothing -- they SCALE what shade()
// already wrote -- and dropping them draws the palette at the wrong level in two
// specific places. Green ground reads grey and waxy without uGrassTone, because
// low chroma is what waxy IS and the cure is red and blue down while green stays.
// And snow, at C_SNOW 0.88 against a 2.1 sun with no tone mapping anywhere in the
// renderer, computes about 2.15 and hard-clips to a flat white sheet; uSnowAlbedo
// is the only thing between the snowfield and that.
//
// AT HALF STRENGTH ON GRASS -- PLAIN_GRASS_TONE. The full multiply is tuned
// against a fragment shader that then lays moss, dirt and a photograph over it,
// and landing all of it on bare vertex colours overshoots into a green too
// saturated to read as ground.
//
// IN THE VERTEX SHADER, which is what makes it nearly free: a smoothstep and two
// multiplies, once per vertex rather than once per fragment, on an attribute the
// mesher already writes. The masks are the same functions of vColor the fragment
// stage computes at auroraGreenBase and auroraVertexSnow, so this rung classifies
// the surface identically to the ones it is measured against.
export const PLAIN_GRASS_TONE = 0.5

/**
 * @param {THREE.Material} source  the material createTerrainMaterial built, for
 *   uGrassTone and uSnowAlbedo. Held BY REFERENCE, so retuning the exposure
 *   retunes this rung with it.
 * @param {boolean} [opts.stipple]  the plain rung plus the STIPPLE block below:
 *   one implicit-LOD fetch of the grit field per fragment, on a per-FACE frame
 *   the mesher baked into a `stipple` vertex attribute (chunk-mesh-v2 STIPPLE
 *   FRAME), and nothing else of the shipping shader's ladder. See the block.
 */
export function createPlainTerrainMaterial(source, { stipple = false } = {}) {
  const src = source?.userData?.uniforms
  if (!src?.uGrassTone || !src?.uSnowAlbedo) {
    throw new Error('createPlainTerrainMaterial: needs the terrain material, for uGrassTone and uSnowAlbedo')
  }
  if (stipple && !src.uGritArr) {
    throw new Error('createPlainTerrainMaterial: stipple needs the terrain material\'s uGritArr')
  }

  const material = new THREE.MeshLambertMaterial({ vertexColors: true })
  material.userData.uniforms = { uGrassTone: src.uGrassTone, uSnowAlbedo: src.uSnowAlbedo }
  if (stipple) {
    Object.assign(material.userData.uniforms, {
      // The shipping shader's grit array, by reference. ONE layer for every
      // surface: the vertex colours say grass from rock from snow, the stipple
      // only roughens.
      uGritArr: src.uGritArr,
      uStippleLayer: { value: GRIT_LAYER.GRASS },
      // +/- brightness about a ZERO MEAN (see the block), seeded from uSpeckle.
      uStippleGrit: { value: 0.46 },
      // Tilt per unit of the field's gradient IN TILE UNITS, not metres: the
      // relief a face shows is the same whatever its tile size, which is what
      // keeps the far ground as rough on screen as the near. 0.286 * 64 / 11.7
      // is the shipping uRelief at the shipping tile size.
      uStippleBump: { value: 1.56 },
    })
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uGrassTone;
        uniform float uSnowAlbedo;${stipple ? `
        attribute vec4 stipple;
        flat varying vec3 vStipFrame;
        flat varying vec2 vStipOrigin;
        varying vec2 vStipXZ;` : ''}`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        // BOTH MASKS BEFORE EITHER MULTIPLY. The grass tone takes blue down by
        // more than a quarter, so reading the snow knee off an already-toned
        // vColor would classify toned grass against a moved threshold.
        //
        // SWIZZLED, AND NEVER BARE vColor. The three A-Frame 1.8 ships -- the
        // three every headset page runs, see three-instance.js -- declares vColor
        // a vec4 unconditionally, where npm's r180 gives a vec3 unless
        // USE_COLOR_ALPHA. A bare vColor *= vec3 does not compile there at all,
        // and a bare vColor *= float compiles and quietly scales alpha, which
        // that fork's color_fragment then multiplies into diffuseColor whole.
        // Same trap as COLOR_FRAGMENT in material.js. A swizzle is right on both.
        float auroraGreenBase = smoothstep( 0.004, 0.030, vColor.g - max( vColor.r, vColor.b ) );
        float auroraVertexSnow = smoothstep( 0.30, 0.60, vColor.b );
        vColor.rgb *= mix( vec3( 1.0 ), uGrassTone, auroraGreenBase * ${PLAIN_GRASS_TONE.toFixed(2)} );
        vColor.rgb *= mix( 1.0, uSnowAlbedo, auroraVertexSnow );`)
    if (stipple) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        // ---- THE STIPPLE FRAME, one per FACE. stipple is (angle, tiles/m,
        // offset u, offset v), baked by the mesher from the vertex's world
        // position and its distance from the camera at build time. The frame
        // is FLAT: whichever vertex provokes the triangle, its frame is the
        // triangle's, so a face is one rotation and one scale end to end and
        // the pattern breaks at every edge -- by design; the vertex colours
        // and the tiny scale step between neighbours keep the break quiet.
        // uv = k * R(angle) * (xz - xz_vertex) + offset, on chunk-local
        // transformed, which is small at every depth.
        float auroraStipC = cos( stipple.x );
        float auroraStipS = sin( stipple.x );
        vStipFrame = vec3( auroraStipC, auroraStipS, stipple.y );
        vStipOrigin = stipple.zw - stipple.y * vec2(
          auroraStipC * transformed.x - auroraStipS * transformed.z,
          auroraStipS * transformed.x + auroraStipC * transformed.z );
        vStipXZ = transformed.xz;`
      )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uGritArr;
        uniform float uStippleLayer;
        uniform float uStippleGrit;
        uniform float uStippleBump;
        flat varying vec3 vStipFrame;
        flat varying vec2 vStipOrigin;
        varying vec2 vStipXZ;
        // Filled at color_fragment, read at normal_fragment_begin.
        vec2 auroraStippleTilt;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        // ---- THE STIPPLE: what a prop's texture costs, on the ground.
        //
        // One fetch with the LOD left to the hardware, on a UV that is four
        // multiplies from the face frame, into a colour the vertex stage
        // already exposed. No derivatives, no distance guard, no
        // classification. The tile is sized to the face's distance, so the
        // pattern holds its screen size out to the fog instead of mipping
        // away.
        //
        // ZERO MEAN, and it has to stay so: TerrainTint paints every grass
        // clump the colour of the ground under it by replaying the plain chain
        // (see terrain-tint.js), and it knows nothing of this block. The field
        // is 0..1 about 0.5, so a clump sits at the ground's AVERAGE and the
        // stipple swings the ground around it.
        vec2 auroraStipUv = vStipOrigin + vStipFrame.z * vec2(
          vStipFrame.x * vStipXZ.x - vStipFrame.y * vStipXZ.y,
          vStipFrame.y * vStipXZ.x + vStipFrame.x * vStipXZ.y );
        vec4 auroraStippleG = texture( uGritArr, vec3( auroraStipUv, uStippleLayer ) );
        diffuseColor.rgb *= 1.0 + ( auroraStippleG.r - 0.5 ) * uStippleGrit;
        // .gb are the gradient of the .r this pixel was just coloured by, in
        // tile units; rotated back through R^T into world XZ. Not divided by
        // the tile size on purpose -- see uStippleBump.
        vec2 auroraStipGrad = auroraStippleG.gb - 0.5;
        auroraStippleTilt = vec2(
          vStipFrame.x * auroraStipGrad.x + vStipFrame.y * auroraStipGrad.y,
          -vStipFrame.y * auroraStipGrad.x + vStipFrame.x * auroraStipGrad.y );`)
        // Lambert lights per fragment in every three this runs on, so a tilted
        // normal is a tilted N.L. `normal` is view space here, so the world
        // tilt is rotated in, as the shipping shader does with auroraBump.
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize( normal + ( viewMatrix *
          vec4( -auroraStippleTilt.x, 0.0, -auroraStippleTilt.y, 0.0 ) ).xyz * uStippleBump );`)
    }
  }

  // Named rather than left to three's default, which stringifies the whole
  // onBeforeCompile above into the key. lighting.patch chains onto this one.
  material.customProgramCacheKey = () => (stipple ? 'aurora-terrain-plain-stipple' : 'aurora-terrain-plain')

  return material
}
