import THREE from './three-instance.js'
import { LAYER, SNOW_LAYERS, SNOW_CARD_LAYERS, SNOW_ROCK_LAYERS, SNOW_WOOD_LAYERS, MOSS_LAYERS } from './textures.js'

// ---------------------------------------------------------------------------
// Snow, and moss, which is snow upside down.
//
// A handful of uniforms for the whole world, shared by reference into every
// program this module compiles, so `setSnow` and `setMoss` drive props and
// buildings together and cost nothing per frame. There is no per-object snow or
// moss DATA and there does not need to be: what a prop wears is derived in the
// vertex shader from where it STANDS, by testing its own root against a line.
// Two pines a hundred metres apart in elevation wear visibly different loads
// from the same uniform, and a boulder in a damp wood is green where the same
// boulder on a ridge is bare.
//
// The two lines run in opposite directions -- snow fills IN above its line,
// moss thins OUT above its own -- and they are separate numbers because they
// are separate facts: snow is about cold, moss is about damp, and the height
// that strips moss off a rock is where the wind takes the soil, well below the
// snow. See setSnowLine and setMossLine.
//
// The test uses the instance ORIGIN, not the fragment's own height. With a 47 m
// band a 25 m tree spans half of it, so per-fragment would paint a gradient up
// a single trunk -- white crown, green skirt -- which is not what a treeline
// looks like. A tree is snowed by where it grows, as a whole.
//
// What this does NOT read is the PAINTED snow-line delta (SnowField.deltaAt):
// the shader knows the base and the band, not the editor's local edits. Where a
// delta has been painted a tree will disagree with the ground under it by that
// delta. Fixing it properly means a per-instance channel -- BatchedMesh's own
// per-instance colour is already spent on stand tinting, so it would be a new
// DataTexture indexed by batchId. Worth it only if painted deltas get large.
//
// It lands only on the layers textures.js lists, and it lands DIFFERENTLY on the
// two FAMILIES those lists make up: SNOW_LAYERS is foliage and wears clumps,
// while SNOW_ROCK_LAYERS and SNOW_WOOD_LAYERS together are the hard surfaces --
// stone, bark, heartwood -- and wear a cap with a wandering rim (SNOW_ROCK_UP
// and friends). Two lists there and one uniform here, because "which layers are
// stone" and "which layers are wood" are two facts while "fills in from the top
// down" is one recipe. See SNOW_HARD_LAYERS. Both families
// are tested with a fixed loop rather than by indexing a mask array with
// vTexLayer. Note that three emits `#version 300 es` for every non-raw material
// and shims the ES 1.00 spelling with #defines (WebGLProgram.js), so the compiled
// language is ES 3.00 and a dynamic index WOULD be legal -- the loops stay
// because at ten iterations of abs+step, unrolled by any compiler, they cost the
// same and say what they mean. The whole block is inside a `uSnow > 0.0` branch
// that is uniform across the draw and therefore free when the sun is out.
//
// That ES 3.00 fact is also what lets the edge use fwidth() without an extension
// guard -- see SNOW_EDGE_MIN.
// ---------------------------------------------------------------------------

const snowAmount = { value: 0 }
const snowLayers = { value: Float32Array.from(SNOW_LAYERS) }
// ONE FAMILY, one uniform: the surfaces that fill in from the top down. Stone
// and wood are two lists in textures.js because they are two facts about the
// world, and they arrive here concatenated because they are one recipe -- a log
// takes exactly the weight a boulder does (SNOW_ROCK_UP), so a second list in
// the shader would buy a third loop and a second branch and spend them on
// nothing. Everything that reads a length reads THIS one.
//
// The uniform keeps its rock name because stone was the whole of the family when
// it was named, and because scripts/check-rocks.mjs matches the string.
const SNOW_HARD_LAYERS = [...SNOW_ROCK_LAYERS, ...SNOW_WOOD_LAYERS]
const snowRockLayers = { value: Float32Array.from(SNOW_HARD_LAYERS) }

// The flat-photograph subset of the foliage list. A third mask rather than a
// third recipe: it picks how the snow is APPLIED, not how much falls. See
// SNOW_CARD_LAYERS in textures.js for why a card cannot use the threshold the
// meshes use once the blob field has faded out from under it.
const snowCardLayers = { value: Float32Array.from(SNOW_CARD_LAYERS) }

const mossAmount = { value: 0 }
const mossLayers = { value: Float32Array.from(MOSS_LAYERS) }

// The moss line, in world metres, and the band it fades over. Moss runs the
// OTHER WAY from snow -- full below the line, gone above it -- so the default is
// +1e6 rather than -1e6: every prop in the world is below it and `uMoss` alone
// drives the whole scene until the game calls setMossLine. That is what
// /gen-rock wants, where there is no terrain and the slider means what it says.
const mossLine = { value: 1e6 }
const mossBand = { value: 1 }
// The range of the ceiling an instance can roll. (1,1) = every instance wears
// the full ceiling, which is a no-op. See setMossVary.
const mossVary = { value: new THREE.Vector2(1, 1) }

// The snow line, in world metres, and how many metres it takes to go from bare
// to loaded. Defaults are a deliberate NO-OP: a line at -1e6 puts every prop in
// the world above it, so `uSnow` alone drives the whole scene until the game
// calls setSnowLine. That is what /gen-tree wants, where there is no terrain.
const snowLine = { value: -1e6 }
const snowBand = { value: 1 }
// Snow's mirror of mossVary, same no-op default. See setSnowVary.
const snowVary = { value: new THREE.Vector2(1, 1) }
// And the same range again for FOLIAGE, which is a separate uniform rather than
// a widening of the one above because the two are tuned against different
// surfaces: snowVary's band is chosen so a boulder is not a white boulder, and a
// canopy asks a different question entirely. Same no-op default, same reason.
// See setLeafSnowVary.
const leafSnowVary = { value: new THREE.Vector2(1, 1) }

/**
 * Season, 0 = bare, 1 = nearly all white. This is a CEILING, not the value each
 * prop wears: what a prop actually gets is this scaled by where it stands
 * against the snow line. Takes effect on the next frame.
 */
export function setSnow(amount) {
  if (!Number.isFinite(amount)) throw new Error(`setSnow: need a number, got ${amount}`)
  snowAmount.value = Math.min(1, Math.max(0, amount))
}

export function getSnow() {
  return snowAmount.value
}

/**
 * How mossy the world is, 0 = bare, 1 = every mossable surface covered. A
 * CEILING, exactly as setSnow is: what a prop actually wears is this cut down by
 * where it stands against the moss line. Takes effect on the next frame.
 */
export function setMoss(amount) {
  if (!Number.isFinite(amount)) throw new Error(`setMoss: need a number, got ${amount}`)
  mossAmount.value = Math.min(1, Math.max(0, amount))
}

export function getMoss() {
  return mossAmount.value
}

/**
 * Where moss STOPS, and over how many metres it thins out.
 *
 * The mirror of setSnowLine and deliberately not the same number: snow is about
 * cold and moss is about damp, and the altitude that kills moss on a rock is the
 * one where the wind takes the soil with it, which sits well below the snow.
 * Pass a base somewhere under `layers.snow.base` and a band wide enough that the
 * treeline and the moss line are not the same contour.
 *
 * WHY THIS IS A LINE AND NOT A PER-INSTANCE VALUE. There is no per-instance
 * channel left -- BatchedMesh's colour is spent on the stone tint and its alpha
 * on the fade distance -- so the elevation cue has to be derived in the shader
 * from something already there, and the instance's own root height is exactly
 * that. It costs the smoothstep and one varying, and it rides the matrix-vector
 * product the snow line already pays for.
 */
export function setMossLine(base, band) {
  if (!Number.isFinite(base)) throw new Error(`setMossLine: need a number for base, got ${base}`)
  if (!(band > 0)) throw new Error(`setMossLine: band must be positive, got ${band}`)
  mossLine.value = base
  mossBand.value = band
}

export function getMossLine() {
  return { base: mossLine.value, band: mossBand.value }
}

/**
 * The RANGE of the moss ceiling, as a fraction of what `setMoss` asks for. Each
 * instance rolls its own number in [lo, hi] and wears `setMoss() * that`, so
 * (0, 0.5) means the greenest rock in the wood is half mossed and plenty are
 * bare, while (1, 1) means every mossable prop wears the full ceiling.
 *
 * (1, 1) IS THE DEFAULT AND IT IS A NO-OP, for the same reason mossLine defaults
 * to +1e6: /gen-rock shows one rock and its moss slider has to mean what it says.
 * The world narrows this; the bench never does.
 *
 * THE ROLL IS A HASH OF THE INSTANCE ROOT'S WORLD XZ, because there is still no
 * per-instance channel to put it in -- the colour texture's RGB is the stone
 * tint and its alpha is the fade distance. Same routing-around the moss LINE
 * already does, and it rides the same matrix-vector product: the root's world
 * position was being computed anyway and only its .y was being read.
 */
export function setMossVary(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`setMossVary: need two numbers, got ${lo} and ${hi}`)
  }
  if (hi < lo) throw new Error(`setMossVary: hi ${hi} is below lo ${lo}`)
  mossVary.value.set(Math.min(1, Math.max(0, lo)), Math.min(1, Math.max(0, hi)))
}

export function getMossVary() {
  return { lo: mossVary.value.x, hi: mossVary.value.y }
}

/**
 * Where snow starts, and over how many metres it comes in. Pass the same
 * numbers the terrain shades itself with (`layers.snow.base` / `.band`) so a
 * tree and the ground it stands on cross the line together.
 */
export function setSnowLine(base, band) {
  if (!Number.isFinite(base)) throw new Error(`setSnowLine: need a number for base, got ${base}`)
  if (!(band > 0)) throw new Error(`setSnowLine: band must be positive, got ${band}`)
  snowLine.value = base
  snowBand.value = band
}

export function getSnowLine() {
  return { base: snowLine.value, band: snowBand.value }
}

/**
 * The RANGE of the snow ceiling, per instance, exactly as setMossVary is for
 * moss and rolled off the same hash of the root's world XZ.
 *
 * HARD SURFACES ONLY -- stone and wood. Foliage rolls too, but off its OWN
 * uniform: the vertex shader gates this roll on SNOW_HARD_LAYERS, the same list
 * the fragment shader picks the stone recipe from, so a boulder and a fallen log
 * roll this range and a canopy rolls setLeafSnowVary's instead. Two ranges
 * because they answer two different questions -- see setLeafSnowVary -- and the
 * two lists are disjoint, so no surface in the world rolls both. Moss has no such
 * split and wants none: every layer it grows on is a surface whose mossiness is
 * meant to vary from neighbour to neighbour.
 *
 * WHAT IT IS FOR is the one thing a scene-wide `setSnow` cannot express: a rock
 * at full load is not a snowy rock, it is a WHITE rock. Stone leans on `up`
 * harder than foliage does, 0.65 against 0.45 (SNOW_ROCK_UP), so by the time the
 * mask has covered the top it is already well down the sides, and a load of 1.0
 * takes the undersides too and throws the stone away. A narrow band up around a
 * third -- (0.3, 0.5) -- caps every rock somewhere between a dusted crown and a
 * loaded one, and the variation between neighbours is what stops a snowfield of
 * boulders reading as one material.
 *
 * The roll is INDEPENDENT of moss's: same hash, different constants, so a rock
 * that rolled bare of moss has no tendency to roll bare of snow.
 */
export function setSnowVary(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`setSnowVary: need two numbers, got ${lo} and ${hi}`)
  }
  if (hi < lo) throw new Error(`setSnowVary: hi ${hi} is below lo ${lo}`)
  snowVary.value.set(Math.min(1, Math.max(0, lo)), Math.min(1, Math.max(0, hi)))
}

export function getSnowVary() {
  return { lo: snowVary.value.x, hi: snowVary.value.y }
}

/**
 * The RANGE of the snow ceiling for FOLIAGE, the same shape of knob as
 * setSnowVary and rolled off the same hash. (1, 1) is the default and a no-op,
 * so /gen-tree's slider still means exactly what it says.
 *
 * IT IS A SECOND UNIFORM RATHER THAN A WIDER FIRST ONE, and the reason is that
 * the two ranges are answering different questions. setSnowVary's band exists
 * because a rock at a full load stops being a rock; a canopy at a full load is
 * fine on its own terms -- a tree buried in snow after a storm is a real tree.
 * The problem foliage actually has is one the single instance never shows: a
 * STAND of them, every canopy in the wood carrying the identical ceiling because
 * the ceiling is a scene uniform, which reads as a paint job over the forest
 * rather than as weather that fell on it. Handing foliage setSnowVary's stone
 * band would fix the stand by making every tree a rock's colour of snow.
 *
 * WHAT THE WORLD DRIVES IT WITH is a band like (0.25, 0.6): the lightest canopy
 * is dusted, the heaviest is loaded but not buried, and no tree in the world is
 * at 1.0. The spread between neighbours is the whole point, exactly as it is for
 * boulders.
 *
 * THE ROLL IS THE SAME `snowRoll` the hard surfaces use, deliberately: a tree's
 * canopy and its own trunk share one instance root, so they hash to one number
 * and a heavily loaded crown sits on a heavily loaded trunk. SNOW_LAYERS and
 * SNOW_HARD_LAYERS are disjoint (check-rocks asserts it), so a given surface is
 * scaled by exactly one of the two ranges and never by both.
 */
export function setLeafSnowVary(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`setLeafSnowVary: need two numbers, got ${lo} and ${hi}`)
  }
  if (hi < lo) throw new Error(`setLeafSnowVary: hi ${hi} is below lo ${lo}`)
  leafSnowVary.value.set(Math.min(1, Math.max(0, lo)), Math.min(1, Math.max(0, hi)))
}

export function getLeafSnowVary() {
  return { lo: leafSnowVary.value.x, hi: leafSnowVary.value.y }
}

// Blob size, in cycles per world metre. At 6.4 a clump is roughly 15 cm across,
// so a 2 m spray card carries a dozen or so and the snow reads as settled
// PATCHES rather than as paint. Twice the size this field ran at before: at 7.5
// cm the clumps were fine enough to read as a grain on the surface rather than
// as snow lying on it, and the drift they cut wanted to be something you could
// see the shape of from a few metres away.
const SNOW_FREQ = 6.4

// The three numbers that shape the blob field both masks are cut out of. What
// they DO is argued at blobField() in SNOW_COMMON, which is where the mechanism
// is; what each one is worth is here.
//
// All three are in units of the CALLER's own frequency, never in metres, so they
// mean the same thing to the snow at 6.4 and the moss at 24.0 and neither has
// to be re-tuned when the other moves.
//
// The warp is sampled at 0.46 of the caller's frequency -- a bit over twice the
// blob size. It has to be COARSER than the blobs it is bending, or it displaces
// each blob's rim by roughly the same amount everywhere along that rim and the
// blob merely moves; at half the frequency the displacement varies over a scale
// larger than a blob, which is what makes rims wander and neighbours merge.
const BLOB_WARP_FREQ = 0.46
// How far the sample point is dragged, in lattice cells. Around two cells, which
// is deliberately much further than the half-cell that shaped this field before:
// under about one cell the lattice survives the bend and the eye still finds the
// rows, and it is the long drag that now supplies the ragged rim a second octave
// used to buy.
const BLOB_WARP = 1.9
// How hard the field is stretched about its midpoint. 1.55 is the most that can
// be spent before the clamp starts flattening real area to 0 and 1 -- past about
// 1.8 the patches acquire hard shoulders and the cut has nothing left to feather
// against.
const BLOB_CONTRAST = 1.55

// Where the world-space blobs stop being resolvable and start shimmering.
// Procedural noise has NO MIP CHAIN: a blob under a pixel across is undersampled
// noise, and undersampled noise crawls when you move your head -- which in a
// headset is the worst artefact there is. Past SNOW_FADE_FAR the noise is
// blended to its own mean, so a distant tree gets the slider's average coverage
// flat, which is what a mip would have converged to anyway.
//
// These two are DELIBERATELY EARLIER than the blobs now need. At 7.5 cm a blob
// was under a pixel past ten metres or so and 12-40 m was sized against that; at
// 15 cm it holds a pixel to about twice that range, so the fade now begins on a
// field that is still resolvable. What that costs is a little patch detail on
// props in the middle distance; what it buys is the ~145 ALU of blobField() off
// everything past forty metres, which at a forest's instance count is the reason
// the fade exists at all. Sized against the blob again only if the patches ever
// have to read at range.
const SNOW_FADE_NEAR = 12.0
const SNOW_FADE_FAR = 40.0

// Half-width of the snow's edge, as a range of `drift`. The edge is meant to be
// a CUTOVER, not a gradient -- snow has a rim, and a soft ramp reads as airbrush
// -- so the width is taken from fwidth(), which is the amount `drift` changes
// across one screen pixel. That makes the edge exactly one pixel wide at any
// distance: as firm as a step() but without the crawling a raw step() would give
// on noise this fine. The floor keeps it from ever becoming a true step; the
// CEILING is load-bearing, because SNOW_CUT_BIAS below is sized against it.
const SNOW_EDGE_MIN = 0.002
const SNOW_EDGE_MAX = 0.06

// The cut runs from SNOW_CUT_BIAS down by SNOW_CUT_SPAN as an instance's own
// load (vSnowPos.w) goes 0->1. Both ends are promises. At a load of 0 the cut MINUS a full-width edge still sits
// above drift's ceiling of 1.0, so "off" means off and not a faint rime; at
// a load of 1 the cut PLUS a full-width edge sits below drift's floor of 0.0, so the
// upward lean stops mattering and the whole canopy goes white. The span is only
// just wide enough to keep the second promise (1.08 + 0.06 = 1.14) because any
// slack past that is slider travel spent on a canopy that is already fully white.
const SNOW_CUT_BIAS = 1.08
const SNOW_CUT_SPAN = 1.16

// --- and the ONE number that differs between the two families ---------------
//
// Everything above serves a boulder as written. The only thing SNOW_HARD_LAYERS
// changes is how hard the drift leans on `up`: SNOW_ROCK_UP at 0.65 for stone
// and wood, against SNOW_FOLIAGE_UP at 0.45 for a canopy. Same blob size, same
// cutover rim, same span, same linear ramp. The hard number is named for stone
// because stone is what it was argued against, and a log wears it unchanged --
// the brief below is a fallen log's brief word for word.
//
// BOTH LEAN UPWARD MOSTLY AND NEITHER LEANS COMPLETELY, and that gap is the
// constraint the pair is tuned against rather than an accident of taste. Lean
// `up` to 0.8 and you get a clean white cap whose rim is a contour of the
// surface normal -- which is wrong here for a reason a smooth surface never
// exposes: A ROCK HAS FLAT FACES. `up` is CONSTANT across a cut facet, so a mask
// that `up` dominates puts the whole facet on the same side of the cut, every
// facet flips as a unit, and the snowline runs along the facet edges as a hard
// straight seam. No amount of softening the rim fixes that, because the seam is
// in the mask and not in the edge; the only thing that breaks it is noise
// carrying enough weight to vary WITHIN a face. Two earlier attempts at this
// section made that mistake twice, and the argument is untouched by the move to
// 0.65 -- what the move needs is a number for where the flip actually starts.
//
// THERE IS ONE, AND IT IS 0.83. blobField() spans the whole of [0,1] (see
// BLOB_CONTRAST), so on a facet whose `up` is fixed the only thing moving
// `drift` is the noise, over a span of exactly (1 - w). That facet is therefore
// PART covered -- some patches, not a flipped unit -- across a stretch of the
// load slider worth (1 - w + 2 * SNOW_EDGE_MAX) / SNOW_CUT_SPAN, and check-rocks
// holds that stretch to a quarter of the travel. Solve it and the quarter is
// reached at w = 0.83: past there a facet spends the slider snapping bare to
// white in one step, which IS the straight-seam artefact written as a number.
// 0.65 leaves 40% of the travel patchy and 0.45 leaves 58%, so both sit well
// inside the safe side of it with room to spare. What the 0.15 over the old 0.5
// buys is the thing the change was made for: the top whitens decisively ahead of
// the sides instead of the two arriving nearly together.
//
// AND A LEAF CARD IS ALSO A FLAT QUAD, which is why foliage moved with stone and
// why it stopped short too. A spray card is one quad with ONE authored normal,
// so `up` is constant across the whole card exactly as it is across a facet --
// the flat-face argument is not a stone argument, it is a constant-normal
// argument, and foliage is constant-normal at card scale. Foliage stays the
// lighter of the two because a canopy is a stack of cards at every angle where a
// rock is a solid, so the same weight reads as a heavier cap on it; 0.45 lifts
// the lean far enough that snow sits ON the leaves rather than mixing evenly
// THROUGH them, and leaves the noise the larger share.
//
// What the pair buys, and it is the whole brief: the top whitens first, a sheer
// side is well short of covered by the time the top is solid, an underside is
// the last thing to go -- and a full winter still covers everything, foliage
// included. There is no face the slider cannot reach.
//
// WHERE THE NOISE IS SAMPLED matters more than any of this, and it is worth
// stating because it is the question a UV-projected texture would raise:
// vSnowPos.xyz is WORLD POSITION, not UV. rock.js gives each face its own
// dominant-axis projection with a seam at every facet edge, and the snow does
// not care, because the noise field is continuous through the solid. Nothing
// here needs a UV unwrap, a second projection, or a baked variant.
const SNOW_ROCK_UP = 0.65
const SNOW_FOLIAGE_UP = 0.45

// Exported ONLY so scripts/check-rocks.mjs can hold the promises above to
// account without a GL context. Nothing at runtime reads this: the numbers are
// compiled into the GLSL as literals. The shared ones are here too, because what
// the gate is checking is the rock's behaviour under all of them together.
export const SNOW_ROCK = Object.freeze({
  up: SNOW_ROCK_UP,
  // The KEY keeps its name -- /gen-deadwood's weather panel and check-rocks both
  // read `foliageUp` -- but the value is the module const now, so the shader and
  // the gate can no longer drift apart the way a repeated literal let them.
  foliageUp: SNOW_FOLIAGE_UP,
  freq: SNOW_FREQ,
  blobWarp: BLOB_WARP,
  blobContrast: BLOB_CONTRAST,
  cutBias: SNOW_CUT_BIAS,
  cutSpan: SNOW_CUT_SPAN,
  edgeMax: SNOW_EDGE_MAX,
})

// Cold white rather than 1.0 flat: snow in daylight is the sky's colour, and a
// pure-white canopy against this game's blue night reads as a hole in the tree.
const SNOW_TINT = 'vec3( 0.93, 0.95, 1.0 )'

// How dark the darkest snowed fragment gets, as a fraction of that tint. Snow
// is not a flat fill -- it takes the LEAF'S OWN LUMINANCE, throws the hue away
// and stretches what is left across this range, so the spray's shape and its
// internal shading still read through the white. The stretch is the point: a
// leaf's luminance only spans about 0.1 to 0.45, and lifting that straight
// toward white would leave four percent of contrast, which is invisible.
const SNOW_FLOOR = 0.62
const SNOW_LUM_HI = 0.45

// ---------------------------------------------------------------------------
// MOSS, which is snow's opposite in every way that matters.
//
// Snow RECOLOURS what is already there: it needs no texture, because at 128 px
// snow has no grain worth the name and a tint plus the surface's own luminance
// is a better snow than a photograph of snow would be. Moss has nothing but
// grain -- take the grain away and it is a green stain -- so it is a real atlas
// fetch of LAYER.MOSS laid over the rock, and it is the only thing in this
// shader that samples a layer no geometry wears.
//
// One extra texture() on a shared material is a thing to be careful about, so
// note what actually pays it: the outer branch is on uMoss, a uniform, so a
// mossless scene costs nothing anywhere; the inner branch is on the layer, so
// only MOSS_LAYERS surfaces sample. And the branch is QUAD-UNIFORM -- helper
// lanes come from the same primitive, so the same instance, so the same
// vTexLayer -- which is what makes a texture fetch inside it legal at all. The
// derivatives are well defined because the whole quad takes the same path.
//
// Applied BEFORE the snow, and that ordering is the whole reason moss sits in
// this function rather than in its own: snow falls on moss, moss does not grow
// through snow.
// ---------------------------------------------------------------------------

// Moss creeps up from the shaded flanks rather than sitting on the crown, so its
// lean is on the DOWN-facing half -- the mirror of snow's. Lighter than snow's
// lean, at 0.35: moss cares much less about which way a face points than snow
// does, because what actually decides where it grows is damp, and damp on a
// boulder is a matter of crevices and which side the weather comes from. That is
// what the noise is standing in for, so the noise gets the larger share.
const MOSS_DOWN = 0.35

// Patches around 4 cm, against snow's 8 cm -- so moss is the FINER of the two
// fields, which is the opposite of what it was and the opposite of what the
// obvious argument suggests.
//
// The obvious argument, and it was the old comment here, is that moss grows in
// colonies and a colony is a bigger thing than a drift of crystals, so moss
// wants the lower frequency. What that misses is that the two fields are not
// doing the same job. Snow's blobs ARE the snow -- there is nothing under them
// but a tint. Moss's blobs are only the SHAPE OF THE STAIN; the thing that
// reads as moss is the photograph inside it, tiled at MOSS_TILE. So the blob
// field is competing with the texture for the same spatial frequency band, and
// at 6.0 it lost: a handful of colony-sized lobes on a boulder read as a
// paint job with the grain buried inside it.
//
// At 24.0 there are dozens of small patches instead, they run into each other
// where the noise is high and break into flecks at the edges, and the texture
// is the only thing carrying detail below the patch size. That is what moss on
// a rock actually looks like, and it is what the wide MOSS_BLEND below depends
// on -- a soft-edged patch only reads as growth rather than as blur if the
// patch is small enough that its rim is a fraction of the rock.
const MOSS_FREQ = 24.0

// Offset so the moss field and the snow field are not the same picture at two
// scales. Value noise at two frequencies is close to uncorrelated already, but
// this is one add and it removes the question.
const MOSS_NOISE_OFFSET = 'vec3( 31.7, 12.3, 47.1 )'

// Moss is sampled through the SAME UV the surface's own tile uses, multiplied.
// On a rock that UV is per-face and scales with the rock (rock.js), so moss
// scales with the rock too -- which is the right answer for the same reason it
// was for the granite: nobody knows how big a moss clump is, so it only ever
// reads as relative texture, and a moss tile fixed in metres would make a 14 m
// crag wear one photograph repeated forty times.
const MOSS_TILE = 2.0

// Fade the noise to its mean at distance, exactly as snow does and for the same
// reason -- procedural noise has no mip chain and undersampled noise crawls.
// NEARER than snow's 12-40, in proportion to the patches now being under half
// the size: what decides this is the distance at which a patch stops covering a
// pixel, and that scales with the patch and not with anything else.
const MOSS_FADE_NEAR = 10.0
const MOSS_FADE_FAR = 34.0

// Half-width of the moss's edge, and unlike snow's it is a FIXED width in mask
// units rather than one screen pixel of fwidth().
//
// Snow has a rim you can put your hand on -- a drift ends, and a feathered
// drift reads as airbrush -- so its edge is deliberately the narrowest thing
// that will not crawl. MOSS HAS NO RIM. It thins out: the colony gets sparser
// toward its margin until what is left is flecks in the pits of the stone, and
// there is no line anywhere on a real mossy boulder where moss stops. A
// one-pixel cutover renders that as a green shape stamped on grey, which is
// exactly the hard cutover line this replaces.
//
// 0.14 against a mask that spans 0 to 1 means the transition occupies better
// than a quarter of the field's range, so a typical patch spends more of its
// area blending than solid. Fixed rather than fwidth() because the width wanted
// here is a property of the MOSS -- how gradually a colony gives out -- and not
// of the screen: a boulder ten metres off should show the same soft margin it
// does at two, and fwidth() would sharpen it as you back away.
const MOSS_BLEND = 0.14

// AND THE BLEND IS NOT SYMMETRIC ABOUT THE CUT. The ramp runs from
// `cut - MOSS_BLEND` up to `cut + MOSS_BLEND * MOSS_BLEND_SKEW`, so at 0.3 it
// is a bit over three times as long on the way in as on the way out.
//
// A symmetric ramp spends half its width above the cut, which is the side where
// there is already more than enough moss -- all that width buys is a softer
// CORE, and a colony's core is the one part of it that does have a definite
// look. The margin is where the interesting behaviour is, so nearly all of the
// blend is spent below the cut, thinning out. The visible consequence is that
// the patch keeps a recognisable body and grows a long ragged skirt, rather
// than reading as one evenly blurred lobe.
const MOSS_BLEND_SKEW = 0.3

// The thin margin is DARKER moss, not merely less of it.
//
// Coverage alone says a fragment at the edge of a colony is 20% moss and 80%
// stone, and blending the two at those weights gives a pale minty wash -- which
// is not what sparse moss looks like. What is actually there is flecks of moss
// down in the pits and pores of the stone, and a pit is in shadow: the moss you
// can see at a colony's margin is the moss that is sheltered, so it reads
// darker and wetter than the sheet of it in the middle, not lighter.
//
// So the moss colour is scaled by MOSS_FRINGE where coverage is 0 and by 1.0
// where it is full, before the coverage blend. At 0.78 the margin is a shade
// over a fifth darker, which is enough to kill the wash without turning the rim
// into a black outline. Note the two ends of the ramp are unaffected by
// construction -- at coverage 0 nothing of the moss is mixed in at all -- so
// this only ever acts on the transition band, which is the point.
const MOSS_FRINGE = 0.78

// MOSS DOES NOT CLIMB. Height above the instance's own root, in world metres,
// at which the moss starts giving out, and the band over which it goes.
//
// Every other term in this file is about which WAY a surface faces, which was
// enough while moss only grew on boulders, because a boulder is roughly as tall
// as it is wide and every part of it is near the ground. Bark broke that: a
// pine is twenty metres of trunk and moss belongs on the bottom two of it. With
// no height term the whole trunk mosses evenly and the tree reads as painted.
//
// 1.6 m with a 2.2 m band puts the moss thick around the foot of a snag, fading
// out by shoulder height and gone by just under four metres, which is where it
// sits on a real trunk -- the damp comes from the ground and from the litter
// against the base, and it does not get up the tree.
//
// A FALLEN LOG NEEDS NO SPECIAL CASE, which is the reason this is measured from
// the instance root and not from the world's terrain height. A log lies down,
// so every part of it is within a trunk diameter of its own root, the rise term
// is ~1 the whole length of it, and the log mosses end to end -- which is
// exactly right, and is what a windfall in a wet forest actually looks like. An
// ordinary boulder gets the same treatment for the same reason: at 0.8 to 3 m
// tall it is inside the band or barely into it, so the cue costs it nothing.
const MOSS_RISE = 1.6
const MOSS_RISE_BAND = 2.2

// MOSS LOAD IS A COVERAGE FRACTION, AND THE CUT HAS TO EARN THAT.
//
// A linear cut -- `bias - load * span`, which is what snow still uses and what
// this used to be -- does NOT give you a load that means anything. Sweeping the
// cut linearly assumes `creep` is spread evenly over its range, and it is not:
// creep is blob*0.65 + down*0.35 with blob a smoothed value noise, so it piles
// up around its median and thins out fast at both tails. Measured over a
// boulder's surface it reaches both ends of [0,1] but sits between 0.23 and
// 0.77 for eight tenths of that surface. A linear sweep therefore spends its
// travel outside the range where creep actually lives: a load of 0.2 covered
// 0.2% of the rock and a load of 0.5 jumped to 50%. Setting the world's range
// to a plausible-sounding 0 - 0.5 bought a forest full of bare stone, which is
// exactly what it looked like.
//
// What we want is coverage(load) = load. Coverage at a given cut IS the
// complementary CDF of creep, so the cut that yields coverage c is creep's
// (1 - c) quantile -- and creep's CDF turns out to be very nearly LOGISTIC.
// Sampled at 200k points its quantiles fit `MOSS_CUT_MID - MOSS_CUT_WIDTH *
// log(c / (1 - c))` to within 0.01 across the whole usable range, so that is
// what the shader evaluates: one log and one divide.
//
// The logit also hands us both end promises for free, which the linear pair had
// to be hand-sized to keep, and it keeps them against the far end of the BLEND
// rather than against the cut itself -- what has to clear creep's range is the
// place the ramp starts, not its midpoint. As load -> 0 the cut runs away above
// every creep there is: 1.679 at the guard, and the ramp starts a further
// MOSS_BLEND below that at 1.539, against a ceiling of 1.0. So no moss means no
// moss. As load -> 1 it runs away below the floor: -0.679, and the ramp ENDS at
// -0.679 + MOSS_BLEND * MOSS_BLEND_SKEW = -0.637, against a floor of 0.0. So a
// fully mossed rock is fully mossed. The guard is what keeps log() off its
// asymptote; it is not a fudge factor and moving it moves both ends.
//
// The height cue folds in HERE, by multiplying the load rather than by shifting
// the cut -- see MOSS_RISE. That is the only place it can go and still keep the
// promises above: coverage is load * rise, so a fragment above the band has an
// effective load of 0, which is the same bare stone that a world moss setting
// of 0 gives, through the same arithmetic.
//
// BOTH NUMBERS ARE MEASURED, NOT CHOSEN, AND THEY ARE TIED TO TWO OTHER THINGS.
//
// THE WIDTH IS creep's logistic scale, so it belongs to blobField rather than to
// moss: anything that changes the SPREAD of that field -- BLOB_CONTRAST, the
// warp, adding or dropping an octave -- invalidates it. The 0.082 this replaced
// was fitted to a narrower two-octave field, and left behind on the current one
// it overshot badly (a load of 0.1 painted 22% of the rock, and 0.2 painted 32%).
//
// THE MID BELONGS TO THE MASK'S EDGE, because the edge is ASYMMETRIC. The cover
// term is smoothstep( cut - MOSS_BLEND, cut + MOSS_BLEND * MOSS_BLEND_SKEW ),
// whose transition midpoint sits MOSS_BLEND * (1 - SKEW) / 2 = 0.049 BELOW the
// cut. The mask therefore turns on earlier than the cut nominally says, and a
// mid of 0.50 -- correct for a symmetric edge -- ran coverage a third high
// through the middle of the range (a load of 0.3 painted 0.40). Raising the mid
// by exactly that offset puts it back. Change MOSS_BLEND or MOSS_BLEND_SKEW and
// this has to move with them.
//
// Solved against the real mask rather than the hard-threshold approximation:
// rms error 0.007 over loads 0.1 to 0.85, and the two end promises still clear
// with room (see above). scratchpad/moss-refit.mjs does the fit.
const MOSS_CUT_MID = 0.550
const MOSS_CUT_WIDTH = 0.134
const MOSS_CUT_GUARD = 1e-4

// Exported for scripts/check-rocks.mjs, on the same terms as SNOW_ROCK: nothing
// reads it at runtime.
export const MOSS = Object.freeze({
  down: MOSS_DOWN,
  freq: MOSS_FREQ,
  tile: MOSS_TILE,
  cutMid: MOSS_CUT_MID,
  cutWidth: MOSS_CUT_WIDTH,
  cutGuard: MOSS_CUT_GUARD,
  blend: MOSS_BLEND,
  blendSkew: MOSS_BLEND_SKEW,
  fringe: MOSS_FRINGE,
  rise: MOSS_RISE,
  riseBand: MOSS_RISE_BAND,
  fadeNear: MOSS_FADE_NEAR,
  fadeFar: MOSS_FADE_FAR,
})

/**
 * The cut a given moss load asks for. Exported so the gate can assert the two
 * end promises and the coverage-tracks-load claim without transliterating the
 * shader; the shader evaluates the same expression inline.
 */
export function mossCutFor(load) {
  if (!Number.isFinite(load)) throw new Error(`mossCutFor: need a number, got ${load}`)
  const c = Math.min(1 - MOSS_CUT_GUARD, Math.max(MOSS_CUT_GUARD, load))
  return MOSS_CUT_MID - MOSS_CUT_WIDTH * Math.log(c / (1 - c))
}

const MOSS_COMMON = /* glsl */ `
  uniform float uMoss;
  uniform float uMossLayers[ ${MOSS_LAYERS.length} ];
  // .x is the per-instance load, .y is height above this instance's own root in
  // world metres -- see MOSS_RISE. The vertex shader has both to hand and the
  // fragment shader has no other way to get the second, so they travel together.
  varying vec2 vMoss;
`

const MOSS_APPLY = /* glsl */ `
  if ( uMoss > 0.0 ) {
    float mossMask = 0.0;
    for ( int i = 0; i < ${MOSS_LAYERS.length}; i++ ) {
      mossMask += step( abs( vTexLayer - uMossLayers[ i ] ), 0.5 );
    }
    if ( mossMask > 0.0 ) {
      // WORLD down. The same trap snow fell into applies here and would be
      // harder to spot, because moss has no obvious right answer to be wrong
      // against -- see the note at 'up' below.
      float down = clamp(
        0.5 - inverseTransformDirection( normal, viewMatrix ).y * 0.5, 0.0, 1.0 );
      float mossNear = smoothstep( ${MOSS_FADE_FAR.toFixed(1)}, ${MOSS_FADE_NEAR.toFixed(1)},
        length( vViewPosition ) );
      // vSnowPos.xyz is world position -- it carries the snow's per-instance
      // load in .w and is named for that, but the xyz is just where this
      // fragment is, and moss wants the same thing.
      // Gated on the fade for the same reason snow's is, and safe for the same
      // reason: blobField is pure ALU. The texture() further down is NOT inside
      // this branch, and must not be moved into one.
      float blob = 0.5;
      if ( mossNear > 0.004 ) {
        blob = mix( 0.5,
          blobField( vSnowPos.xyz * ${MOSS_FREQ.toFixed(2)} + ${MOSS_NOISE_OFFSET} ), mossNear );
      }
      float creep = blob * ( 1.0 - ${MOSS_DOWN} ) + down * ${MOSS_DOWN};
      // THE BRANCH STAYS ON THE UNIFORM and only the cut moves to the
      // per-instance load. That split is load bearing: uMoss > 0.0 is
      // quad-uniform, which is what makes the texture() fetch below legal, and
      // vMoss.x > 0.0 is not -- a varying can differ across a quad in
      // principle, and putting a fetch behind it would make the derivatives
      // undefined. An instance whose vMoss.x is 0 still enters the branch and
      // pays for it; the cut then sits above the mask's ceiling, so it comes
      // out bare.
      // See MOSS_CUT_MID: a logit, so vMoss.x reads as the FRACTION of the rock
      // that comes out green rather than as a position on an arbitrary sweep.
      // The clamp keeps log() off both asymptotes and is what makes the two end
      // promises exact -- do not drop it, and do not widen it.
      // MOSS DOES NOT CLIMB -- see MOSS_RISE. vMoss.y is metres above THIS
      // INSTANCE'S OWN ROOT, not above the terrain, which is what lets one
      // expression cover both cases: a standing snag goes bare above the litter
      // line, and a fallen log is within a trunk diameter of its root along its
      // whole length so it stays at rise ~1 and mosses end to end.
      float rise = 1.0 - smoothstep( ${MOSS_RISE}, ${(MOSS_RISE + MOSS_RISE_BAND).toFixed(1)}, vMoss.y );
      // Folded into the LOAD rather than into the cut, so coverage is load *
      // rise and a fragment out of the band goes bare through exactly the same
      // arithmetic as a world moss setting of 0.
      float mossLoad = clamp( vMoss.x * rise, ${MOSS_CUT_GUARD}, 1.0 - ${MOSS_CUT_GUARD} );
      float cut = ${MOSS_CUT_MID} - ${MOSS_CUT_WIDTH} * log( mossLoad / ( 1.0 - mossLoad ) );
      // A fixed soft margin rather than snow's one-pixel cutover -- see
      // MOSS_BLEND. Moss thins out; it does not stop. No fwidth() term here,
      // deliberately: a max( MOSS_BLEND, clamp( fwidth( creep ), SNOW_EDGE_MIN,
      // SNOW_EDGE_MAX ) ) floor would be arithmetically inert, because the
      // clamp's ceiling of 0.06 is well under MOSS_BLEND and the max() could
      // therefore never pick the fwidth. It would cost a derivative per fragment
      // to compute a number that can never win. If MOSS_BLEND is ever taken
      // below SNOW_EDGE_MAX the floor starts to matter and should come back.
      float w = ${MOSS_BLEND};
      // Straight over the top of the rock's own diffuse, tint and all. Reached
      // here AFTER color_fragment, so diffuseColor already carries the
      // per-instance stone tint -- which moss deliberately does not inherit,
      // because moss on basalt and moss on sandstone are the same green.
      // Long on the way in, short on the way out -- see MOSS_BLEND_SKEW. The
      // patch keeps a body and grows a ragged skirt instead of blurring evenly.
      float cover = smoothstep( cut - w, cut + w * ${MOSS_BLEND_SKEW}, creep );
      vec3 moss = texture( uAtlas,
        vec3( vUvProj * ${MOSS_TILE.toFixed(1)}, ${LAYER.MOSS}.0 ) ).rgb;
      // BLENDED, not cut over, and the thin end is darker as well as thinner --
      // see MOSS_FRINGE. Sparse moss is flecks down in the pits of the stone,
      // and a pit is in shadow, so the margin has to darken or it reads as a
      // pale wash of green sitting on top of the rock.
      diffuseColor.rgb = mix( diffuseColor.rgb,
        moss * mix( ${MOSS_FRINGE}, 1.0, cover ), cover );
    }
  }
`

const SNOW_COMMON = /* glsl */ `
  uniform float uSnow;
  uniform float uSnowLayers[ ${SNOW_LAYERS.length} ];
  uniform float uSnowRockLayers[ ${SNOW_HARD_LAYERS.length} ];
  uniform float uSnowCardLayers[ ${SNOW_CARD_LAYERS.length} ];
  varying vec4 vSnowPos;

  float snowHash( vec3 p ) {
    p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
  }

  // One octave of value noise, on a cubic lattice.
  float snowNoise( vec3 x ) {
    vec3 i = floor( x );
    vec3 f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix(
      mix( mix( snowHash( i + vec3( 0.0, 0.0, 0.0 ) ), snowHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
           mix( snowHash( i + vec3( 0.0, 1.0, 0.0 ) ), snowHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
      mix( mix( snowHash( i + vec3( 0.0, 0.0, 1.0 ) ), snowHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
           mix( snowHash( i + vec3( 0.0, 1.0, 1.0 ) ), snowHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
  }

  // Domain warp, then contrast. Two things this fixes about a single octave of
  // value noise, and neither is fixed by changing its frequency.
  //
  // A raw value-noise blob is ROUND and all its blobs are the same size, because
  // the field is an interpolation over one lattice -- so snow reads as spots and
  // moss reads as green polka dots. Warping the SAMPLE POINT by a coarser copy
  // of the same field drags each blob's rim sideways by an amount that varies
  // over a scale LARGER than the blob itself, so rims wander, neighbouring
  // patches reach for each other and merge, and a run of them stretches. That is
  // what a drift and a colony actually look like.
  //
  // Then contrast, symmetric about 0.5. Value noise spends most of its range
  // near its mean, so a threshold anywhere in the middle cuts through a soft
  // gradient and gives a lot of half-covered surface. Stretching about the
  // midpoint puts more of the field at the extremes, which is what makes a patch
  // read as a PATCH with an interior rather than as a smear.
  //
  // SYMMETRIC IS LOAD BEARING. The mean is preserved exactly, which two things
  // downstream depend on: the distance fade mixes toward 0.5 as its stand-in for
  // the mip a procedural field does not have, and every end promise below is
  // sized against a field that spans [0,1]. A reshape that moved the mean would
  // quietly break both.
  //
  // WHAT IT REPLACED, because the trade is not all one way. The field here used
  // to be a half-cell warp plus a SECOND OCTAVE at 2.07x and 28% weight, and the
  // octave was there to perturb the contour -- a blob's ragged rim. The long
  // warp buys that back, because at nearly two cells the displacement varies
  // enough along a rim to break it up on its own; what the octave cost was a
  // third noise evaluation and, worse, a NARROWER field, since a weighted sum of
  // two near-independent samples pulls in toward the mean exactly where the cut
  // has to live.
  //
  // The cost is honest and worth naming: TWO noise evaluations, at ~145 ALU
  // each, so a scene that is both snowy and mossy pays four. It is still inside
  // the uSnow > 0.0 / uMoss > 0.0 uniform branches, so a bare season and a
  // mossless world both cost nothing at all, and both call sites gate it again
  // on the distance fade being worth anything -- see snowNear.
  float blobField( vec3 p ) {
    float w = snowNoise( p * ${BLOB_WARP_FREQ.toFixed(2)} + vec3( 23.1, 5.7, 61.3 ) );
    float f = snowNoise( p + vec3( w, w * 1.7, -w ) * ${BLOB_WARP.toFixed(2)} );
    return clamp( ( f - 0.5 ) * ${BLOB_CONTRAST.toFixed(2)} + 0.5, 0.0, 1.0 );
  }
`

// ---------------------------------------------------------------------------
// The single shared prop material.
//
// This is the load-bearing constraint of the whole renderer (DESIGN.md §5):
// every prop, every LOD tier, every species uses this one material so that
// BatchedMesh can collapse them into one multi-draw call. Adding a second prop
// material splits every batch.
//
// MeshLambertMaterial rather than Standard: no PBR cost, and all our lighting
// is baked anyway (DESIGN.md §8). Meta's guidance is one real-time light max.
//
// Patched via onBeforeCompile to sample a sampler2DArray. We deliberately do
// NOT use material.map -- three's map path assumes sampler2D. Instead we carry
// our own uv varying plus a per-vertex texLayer index.
// ---------------------------------------------------------------------------

// Applied between the double-sided normal flip and the back-facing ramp, so a
// snowed leaf is shaded like the leaf it is sitting on rather than glowing flat
// white on the shaded side of a canopy.
const SNOW_APPLY = /* glsl */ `
  // Outer test is on the UNIFORM, so a bare season costs nothing anywhere. The
  // inner test is on the varying, which is per-instance and therefore constant
  // across every fragment of a given tree -- a warp never straddles it except
  // on the seam between two trees, so the divergence is cheap and it buys back
  // the whole noise cost for every prop standing below the snow line.
  if ( uSnow > 0.0 && vSnowPos.w > 0.0 ) {
    float snowMask = 0.0;
    for ( int i = 0; i < ${SNOW_LAYERS.length}; i++ ) {
      snowMask += step( abs( vTexLayer - uSnowLayers[ i ] ), 0.5 );
    }
    // The second list is the HARD surfaces -- stone and wood, concatenated into
    // one uniform (SNOW_HARD_LAYERS) -- rather than foliage. It selects a
    // different weight below, not a different branch: the noise is the expensive
    // part and both kinds of snow want the same noise at the same size, so the
    // two recipes ride the same instructions and differ in exactly one mix().
    // The families are disjoint, so 'rock' is 0 or 1 and never both.
    float rockMask = 0.0;
    for ( int i = 0; i < ${SNOW_HARD_LAYERS.length}; i++ ) {
      rockMask += step( abs( vTexLayer - uSnowRockLayers[ i ] ), 0.5 );
    }
    if ( snowMask + rockMask > 0.0 ) {
      float rock = min( rockMask, 1.0 );
      // Blobs, leaning upward: snow settles on what faces the sky, and without
      // that lean a fully snowed tree reads as bleached rather than as loaded.
      // Both families lean MOSTLY upward and neither leans completely -- stone
      // at 0.65 against foliage's 0.45 (see SNOW_ROCK_UP) -- so both fill in from
      // the top down while the noise keeps a third of the say or better, which is
      // what stops a flat face, cut facet or leaf card, flipping as a whole unit.
      // WORLD up, not normal.y. At this point in the shader "normal" is
      // normalize( vNormal ), which three built with the normalMatrix and is
      // therefore in VIEW space -- its .y is "up relative to the camera". Snow
      // taken from that sweeps around a rock as you orbit it and cuts a hard rim
      // across whatever face is pointing at you, because a camera-facing normal
      // sits exactly on the threshold. inverseTransformDirection is three's own
      // helper out of <common>, and viewMatrix is in the fragment prefix, so
      // this is three dots and a normalize. Taken AFTER the faceDirection flip
      // above, so a double-sided card is judged by the side you can see.
      float up = clamp(
        inverseTransformDirection( normal, viewMatrix ).y * 0.5 + 0.5, 0.0, 1.0 );
      float snowNear = smoothstep( ${SNOW_FADE_FAR.toFixed(1)}, ${SNOW_FADE_NEAR.toFixed(1)},
        length( vViewPosition ) );
      // Past the fade the mix would return 0.5 to within a thousandth anyway, so
      // skipping it there is exact to the eye and free. Legal ONLY because
      // blobField is pure ALU: a texture() with an implicit LOD inside
      // non-quad-uniform control flow would be undefined, and there is none here.
      float blob = 0.5;
      if ( snowNear > 0.004 ) {
        blob = mix( 0.5, blobField( vSnowPos.xyz * ${SNOW_FREQ.toFixed(2)} ), snowNear );
      }
      // The one number stone changes. Everything else below is shared. Both ends
      // are module consts, so nothing here is a literal the gate can fall out of
      // step with -- see SNOW_ROCK_UP.
      float upWeight = mix( ${SNOW_FOLIAGE_UP}, ${SNOW_ROCK_UP}, rock );
      float drift = blob * ( 1.0 - upWeight ) + up * upWeight;
      float cut = ${SNOW_CUT_BIAS} - vSnowPos.w * ${SNOW_CUT_SPAN};
      // Grayscale-and-tint rather than a flat fill. Eleven ALU against the ~145
      // the noise above already costs, so this is free in every sense that
      // matters -- and it is what stops a snowed canopy reading as a white
      // cut-out of a tree.
      float snowLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      vec3 snowCol = ${SNOW_TINT} * mix( ${SNOW_FLOOR}, 1.0,
        smoothstep( 0.0, ${SNOW_LUM_HI}, snowLum ) );
      // A one-pixel cutover -- see SNOW_EDGE_MIN. fwidth is core in GLSL ES
      // 3.00, which is what three compiles this to. Stone wants this every bit
      // as much as foliage does: snow has a rim, and a feathered rim on a
      // boulder reads as airbrush.
      float edge = clamp( fwidth( drift ), ${SNOW_EDGE_MIN}, ${SNOW_EDGE_MAX} );
      float cover = smoothstep( cut - edge, cut + edge, drift );
      // A FLAT PHOTOGRAPH CANNOT USE THAT THRESHOLD once the noise is gone.
      // Past SNOW_FADE_FAR the blob is the constant above and an impostor's
      // normal is uniform over the whole quad, so drift is one number for
      // every fragment of the card and the smoothstep returns 0 or 1 for all
      // of it -- the tree goes pure white or stays pure green, and at these
      // constants it whitens at a load of 0.306, which most trees clear. So a
      // card takes its own instance's snow LOAD as a coverage fraction
      // instead. vSnowPos.w already carries the per-tree roll and the foliage
      // cap, so the far forest still varies tree to tree.
      //
      // CROSSFADED ON THE SAME snowNear THAT FADES THE NOISE, in the same
      // direction: where the blob field is still running it broke the card up
      // fine and the threshold is the better picture, so it keeps it. The two
      // meet where the noise has already gone to its constant, which is what
      // makes the boundary invisible rather than merely gradual.
      float cardMask = 0.0;
      for ( int i = 0; i < ${SNOW_CARD_LAYERS.length}; i++ ) {
        cardMask += step( abs( vTexLayer - uSnowCardLayers[ i ] ), 0.5 );
      }
      cover = mix( cover, mix( vSnowPos.w, cover, snowNear ), min( cardMask, 1.0 ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, snowCol, cover );
    }
  }
`

// ---------------------------------------------------------------------------
// TRUE CAMERA-FACING BILLBOARDS, and why they are a shader patch rather than a
// rotation anybody writes down.
//
// A billboard is not a world transform you compute per instance on the CPU and
// push into the batch every frame -- that is 22,000 matrix writes a frame for a
// fern carpet and it is what makes people think billboards are expensive. It is
// a VERTEX PROGRAM: the quad is authored in object space, and the shader spins
// it about its own Y axis toward the eye as it transforms it. Zero CPU, zero
// per-frame writes, and it composes with whatever instancing the draw is using
// because it happens strictly before the projection.
//
// CYLINDRICAL, NOT SPHERICAL, and that distinction is the whole difference
// between foliage and a particle. A spherical billboard also pitches to face
// the camera: stand on a ridge looking down at a fern bed and every fern lies
// on its back with its base lifted off the ground. Yaw-only keeps the plant
// standing on the soil, which is what a plant does.
//
// IT CANCELS THE INSTANCE'S OWN YAW rather than requiring instances be placed
// unrotated. The same instance is a MESH close up -- where a random yaw is the
// only thing stopping a carpet reading as cloned -- and a billboard far away.
// One instance, one matrix, two behaviours, so the shader has to undo the yaw
// baked into the matrix rather than the placement having to omit it. That is
// what the `axis` term is: the instance's own object +X, in world space, used
// as a unit complex number and divided out.
//
// SELECTION IS BY TEXTURE LAYER, and it is a per-MATERIAL list rather than a
// global one. The same `uvProj`/`texLayer` layout every prop already carries
// tells the shader which geometries are billboards, so this needs no new vertex
// attribute -- which matters more than it sounds, because BatchedMesh throws if
// any geometry entering the arena is missing an attribute the arena has, so a
// new attribute is a change to every generator in the project. It is the same
// mechanism `uSnowLayers` already uses one screen up. Per-material because v1's
// scatter draws the SAME impostor layers as fixed crossed cards, and spinning a
// cross about its own axis is visibly wrong -- so v1 opts out by not asking.
//
// LAYER AND THEN NORMAL, because a layer is no longer enough on its own. v2's
// tree ladder draws a crossed card AND a billboard of the same species, off the
// same baked layer, in the same batch. What separates them is that a card meant
// to be spun is authored with an exactly vertical normal and a fixed cross is
// not, so the mask is `layer match AND normal.y > CARD_UP_MARK`. No new
// attribute, no duplicate texture layer, no second bake -- see billboardVertex.
//
// WHAT IT COSTS: 2 triangles per instance instead of the crossed card's 4. At a
// sparse tree scatter that is nothing and DESIGN.md §5 says so. At a 2/m^2 fern
// carpet it is ~18,000 quads, which is ~36k triangles, which is not nothing.
//
// WHAT IT GIVES UP: a billboard has one silhouette and no depth at all, so the
// range it becomes legal at is the parallax rule's, not the crossed card's.
// And in a headset it is flat in the strong sense -- a screen-facing quad has
// no binocular disparity across its own surface, so it reads as a cutout at a
// fixed depth. Both are fine past the ~14 m the rule allows for a 0.5 m plant
// and neither is fine before it.
// ---------------------------------------------------------------------------

/**
 * The vertex-shader billboard, appended to `begin_vertex`.
 *
 * Runs after `batching_vertex` and `beginnormal_vertex` (see the chunk order in
 * ShaderLib/meshlambert.glsl.js) so `batchingMatrix` is in scope and the normal
 * has already been transformed -- which is deliberate, see below.
 *
 * THE NORMAL IS NOT SPUN WITH THE QUAD, and that is a decision rather than an
 * oversight. Turning it toward the eye makes N.L a function of where the player
 * is standing, so the whole fern bed brightens and dims as they turn on the
 * spot, which is the single most obvious artefact a billboard can have. The
 * card is authored with a vertical normal instead (see buildBillboardCard) and
 * keeps it: at the range this draws, a fern bed IS a ground surface, and
 * lighting it like one is both stable and closer to true than lighting 18,000
 * independent vertical cards.
 */
/**
 * The line in `normal.y` that separates a card meant to be SPUN from one meant
 * to stay put, when the two share a baked texture layer.
 *
 * It is 0.99 and not 0.5 because the cross tier's normals are no longer
 * horizontal. buildImpostorCard's canopy fan leans them mostly UP so that three
 * planes stop being three brightnesses (see the normal note in impostor.js),
 * which took the marker's old 0.5 out from between the two cases. What is left
 * is exact rather than approximate: `upNormal` authors literally (0, 1, 0), the
 * attribute is read here before anything transforms it, and every other card
 * this project builds tops out at 0.876. buildImpostorCard asserts both sides.
 */
export const CARD_UP_MARK = 0.99

// ---------------------------------------------------------------------------
// CYLINDRICAL OR SPHERICAL, and it is one flag because it is one decision made
// per BED rather than per card.
//
// The default is cylindrical: the card yaws about world Y and its height stays
// vertical however the camera is pitched. For anything that grows out of the
// ground that is not an approximation, it is the truth -- a tree trunk IS
// vertical, and a spherical tree card seen from a hillside above would lie its
// trunk back along the ground, which is worse than the foreshortening it fixes.
//
// A ROCK IS NOT A TREE. It has no up. Look down at a boulder field from a ridge
// -- which in this world is most of the time anyone is looking at one, because
// the beds that reach card range are the scree and the giants and both of them
// live on slopes -- and every cylindrical card in it is a vertical signboard
// presenting the rock's SIDE elevation to a camera that should be seeing its
// top. The rocks read as cardboard standees the moment the view tips, and the
// tell is that they all tip together.
//
// THE PIVOT IS THE CARD'S FOOT, not its middle, and that is the whole reason
// this needs no extra attribute. A centre pivot would keep the rock's mass
// exactly over its map position and swing the bottom half of the card under the
// hill; a foot pivot keeps the card's ground contact and lays the rock back
// away from the eye as the view tips over it. Ground contact is the cue that
// matters at this range -- a rock that has come unstuck from the hillside is
// visible at a kilometre and a rock displaced half its own height along the
// ground is not.
//
// COST: it replaces a 2D rotation with a 3x3, which is about a dozen more
// vertex ops on a two-triangle card -- four vertices per rock, at the range
// where a rock is four vertices. It is not measurable.
/**
 * The two questions about a vertex that both the billboard spin and the wind
 * want answered, computed ONCE ahead of either.
 *
 * `propCard` -- is this vertex on a baked impostor card at all, as opposed to
 * mesh geometry? That is exactly the billboard layer list, and it is what tells
 * the wind whether `uvProj.y` is a height fraction it can trust or a bark
 * repeat it cannot.
 *
 * `propSpun` -- is it a card that WANTS SPINNING? A crossed card and a
 * billboard of the same species share one baked layer, so the layer alone
 * cannot separate them -- but the normal already does, and for free. A card
 * built to be spun is authored with an exactly vertical normal
 * (buildImpostorCard's `upNormal`, set exactly when `billboard` is); a fixed
 * cross leans its normals off vertical. So `normal.y` IS the marker for "turn
 * me", and it costs no attribute and no second layer. See CARD_UP_MARK for
 * where the line sits and why. Grass is unaffected: its tuft tiers already live
 * on a different layer.
 *
 * Hoisting these out of billboardVertex is what keeps the wind from paying for
 * a second copy of the layer loop. A material with no billboard layers gets the
 * constants and the compiler folds every use away.
 */
function propCardMask(layerCount) {
  if (!layerCount) {
    return /* glsl */ `
    float propCard = 0.0;
    float propSpun = 0.0;`
  }
  // min() and not the raw sum: the spin only ever tested this against zero, but
  // the wind uses both as a mix() factor, and a layer listed twice would push the
  // factor past 1 and extrapolate instead of blending.
  return /* glsl */ `
    float propCard = 0.0;
    for ( int i = 0; i < ${layerCount}; i++ ) {
      propCard += step( abs( texLayer - uBillboardLayers[ i ] ), 0.5 );
    }
    propCard = min( propCard, 1.0 );
    float propSpun = propCard * step( ${CARD_UP_MARK}, normal.y );`
}

function billboardVertex(spherical) {
  // Screen right and screen up, in world space: rows 0 and 1 of the view
  // matrix's rotation. VIEW-PLANE aligned rather than a true look-at, which is
  // both cheaper and steadier -- a look-at billboard swings as the card crosses
  // the screen, and on a hillside covered in them that swing is a shimmer.
  const spin = spherical
    ? /* glsl */ `
      vec3 bbRw = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
      vec3 bbUw = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );

      // The world-from-object linear map for this instance. We are about to
      // build the answer in WORLD space and have to hand it back in the object
      // space three is expecting, so what is wanted here is that map read
      // backwards.
      //
      // THIS IS EXACT ONLY BECAUSE THE SCALE IS UNIFORM. For M = s*R the upper
      // 3x3 inverse is transpose / s2, and s2 is the squared length of any
      // column. rocks.js composes every instance with _s.set(scale, scale,
      // scale) -- one number on all three axes -- so the identity holds. A bed
      // that ever starts stretching an axis would need a real inverse here, and
      // would get a sheared card instead, so: keep rock instances uniform.
      mat3 bbM = mat3( modelMatrix );
      #ifdef USE_BATCHING
        bbM = bbM * mat3( batchingMatrix );
      #endif
      #ifdef USE_INSTANCING
        bbM = bbM * mat3( instanceMatrix );
      #endif
      float bbS2 = dot( bbM[ 0 ], bbM[ 0 ] );

      // The card spans local X for its width and local Y for its height, with
      // its foot on y = 0 (buildImpostorCard). So the foot pivot is free: y is
      // already measured up from it, and the two axes go straight onto screen
      // right and screen up.
      //
      // THOSE LOCAL METRES ARE THE CARD AT SCALE 1, and the instance scale has
      // to multiply them exactly as it multiplies a mesh vertex. Dividing by s2
      // here is the plain inverse, which maps the world offset back untouched --
      // so the matrix reapplies s on the way out, the s cancels, and every spun
      // card in the bed draws at its raw bank size no matter how big the rock
      // is. That is not a subtle error and it is not a rare one: a crust cap
      // sits at scale 4.10 in the median and 8.33 at the top, so its billboard
      // came out at a quarter of the mesh it replaced and sometimes an eighth,
      // while an underfoot pebble at 0.23 came out four times too big. 87% of
      // placed rocks drew a card under 0.8x its mesh.
      //
      // Rolling the scale into the inverse costs nothing. We want M-inverse
      // applied to (s * bbW), and M-inverse is transpose / s2, so the two
      // constants collapse to transpose / s -- one inversesqrt where there used
      // to be a divide. The cylindrical branch below never had this bug: it
      // rotates within object space and never leaves it, so the scale is never
      // divided out to begin with.
      vec3 bbW = transformed.x * bbRw + transformed.y * bbUw;
      // v * M is M-transpose * v in GLSL, which is the inverse rotation.
      transformed = ( bbW * bbM ) * inversesqrt( bbS2 );`
    : /* glsl */ `
      // Face: the horizontal direction from the plant to the eye. Degenerate
      // only when the camera is exactly on the axis, where any answer is right.
      vec2 bbTo = cameraPosition.xz - bbOrigin.xz;
      float bbLen = length( bbTo );
      vec2 bbF = bbLen > 1e-4 ? bbTo / bbLen : vec2( 0.0, 1.0 );
      // Screen-right, in world XZ: up x face, which is (f.z, -f.x).
      vec2 bbR = vec2( bbF.y, -bbF.x );

      // The instance yaw, as a unit complex number, and the rotation that takes
      // it to bbR: bbR * conj(axis). Composed in object space, so what the
      // matrix does afterwards lands us exactly on bbR.
      vec2 bbC = vec2( bbR.x * bbA.x + bbR.y * bbA.y, bbR.y * bbA.x - bbR.x * bbA.y );

      // Rotate (x, z) by bbC. RHS is fully evaluated before the assignment, so
      // reading transformed.x twice here is safe.
      transformed.xz = vec2(
        transformed.x * bbC.x - transformed.z * bbC.y,
        transformed.x * bbC.y + transformed.z * bbC.x
      );`

  return /* glsl */ `
  {
    if ( propSpun > 0.0 ) {
      // The instance's origin and its own +X axis, both in world space. The
      // origin is where we look at the camera FROM; the axis is the yaw we have
      // to divide out. Both go through modelMatrix so this stays correct if the
      // batch is ever added under a rotated parent.
      vec4 bbOrigin = vec4( 0.0, 0.0, 0.0, 1.0 );
      vec4 bbAxis = vec4( 1.0, 0.0, 0.0, 0.0 );
      #ifdef USE_BATCHING
        bbOrigin = batchingMatrix * bbOrigin;
        bbAxis = batchingMatrix * bbAxis;
      #endif
      #ifdef USE_INSTANCING
        bbOrigin = instanceMatrix * bbOrigin;
        bbAxis = instanceMatrix * bbAxis;
      #endif
      bbOrigin = modelMatrix * bbOrigin;
      bbAxis = modelMatrix * bbAxis;

      // The instance's own yaw as a unit complex number. The cylindrical spin
      // divides it out; the spherical one throws it away entirely. Both want it
      // for the u-flip below.
      vec2 bbA = normalize( vec2( bbAxis.x, bbAxis.z ) );
${spin}

      // One free bit of variety: the instance's own yaw, which the spin has
      // just thrown away, decides whether this card reads its picture
      // backwards. Stable per instance -- it does not flicker as the camera
      // moves -- and it doubles the number of distinct silhouettes in the bed
      // without a second bake or a second layer.
      if ( bbA.x < 0.0 ) vUvProj.x = 1.0 - vUvProj.x;
    }
  }`
}

// ---------------------------------------------------------------------------
// DISSOLVE: a prop appears and disappears by fading, not by popping.
//
// The problem it solves is not the LOD ladder -- it is the OUTER EDGE of a
// scatter. A tree that materialises the instant it comes inside the draw radius
// is a black dot switching on in the middle of an empty hillside, and the eye
// catches it every time even at a kilometre. Same for a scatter that thins with
// distance: every tree there has its own range at which it stops being drawn,
// and crossing that range is a pop.
//
// HOW IT IS FED: A CLOCK, NOT A DISTANCE, and it used to be the other way. Each
// instance carried the distance at which it should be gone, the shader compared
// that against its live distance to the camera, and nothing was written per
// frame at all -- the fade was a pure function of where the player stood. That
// is as cheap as this can possibly be and it has one steady state nothing in the
// shader can fix: A PROP PARKED IN ITS OWN FADE BAND IS PARKED IN A STIPPLE.
// Stand still and it dithers forever, and because the band is a fixed FRACTION
// of each instance's own range rather than a shell at the horizon, a flat 15% of
// every prop past the full-density radius sat in one, at every distance out to
// the draw radius. See src/v2/render/rim.js, which owns the replacement: the
// same crossing now stamps a start time and the transition RESOLVES.
//
// So both dissolves are clocks, and the CPU's job in each is the same one: watch
// for the crossing, stamp both ends of it, and reclaim when the window is up.
//
// WHERE THE NUMBER LIVES: the alpha channel of BatchedMesh's per-instance colour
// texture, which three allocates as RGBA-float, fills with 1, and then only ever
// writes .rgb of (setColorAt takes a THREE.Color, which has no alpha; the shader
// chunk reads .rgb). So the channel is present, per-instance, already uploaded,
// and unused. Using it needs no new vertex attribute -- which matters more than
// it sounds, because BatchedMesh throws if a geometry entering the arena is
// missing an attribute the arena has, so a new attribute is a change to every
// generator in the project. Reaching for `_colorsTexture` is reaching past a
// private field, so the two writers below validate it loudly rather than writing
// into whatever it finds.
//
// 1.0 MEANS NEVER FADE, which is three's own initial value, so every caller that
// does not opt in -- v1's scatter, the ferns, the buildings -- is unaffected and
// compiles the same branch to a constant 1.
//
// WHY DITHER RATHER THAN BLEND: this material is a binary cutout by
// architecture (DESIGN.md §7 -- alpha blending cannot be sorted inside a batched
// draw call), so a real alpha ramp is not available at any price. A per-pixel
// threshold against the fade gives a raster dissolve that needs no sorting, no
// second pass, no MSAA and no blend state, and it reuses the discard the
// alphaTest is already paying for. The stipple is only visible if you are close
// enough to resolve individual pixels of it, and nothing fades close. The
// threshold comes from interleaved gradient noise rather than an ordered
// matrix -- see ign() for why.
//
// WHY NOT SHRINK, which is what v1's scatter.js does at its rim: a shrinking
// tree reads as a GROWING tree when you walk toward it, and the thinning bands
// here sit at a few hundred metres where a tree is still tens of pixels tall.
// Shrinking is the cheaper trick and the right one for a 26 m grass disc.
//
// THE CHANNEL ALSO CARRIES THE LOD TIER SWAP, which is where the clock came
// from. A swap has never had a distance version to fall back on: the instance is
// at a fixed range when it happens, and the whole point is that it RESOLVES --
// stand still after crossing a band and the duplicate has to be evicted and the
// stipple has to go away, or standing still costs a permanent second mesh and
// permanent dots. That argument turned out to be the rim's argument too, which
// is why there is now one mechanism rather than two.
//
// The scheme is symmetric and costs one CPU write per instance per swap, not per
// frame: the caller stamps a START TIME into the channel of both halves -- the
// arriving tier fading IN, a duplicate holding the departing tier fading OUT --
// and the shader turns `uPropClock - t0` into the fade. Everything after the
// stamp is the GPU's; the CPU's only other job is to notice the fade has run out
// and hand the duplicate back.
//
// A RIM FADE IS THE SAME STAMP WITH NO SECOND HALF. There is no duplicate,
// because there is no arriving tier -- the instance is going away entirely, or
// coming back from having gone -- so one of the two thresholds simply goes
// unused and the prop dithers against an empty background. Which means the rim
// and the swap CANNOT SHARE AN INSTANCE, since there is one slot: rim.js and the
// scatters resolve that by letting the rim win, on the grounds that which LOD
// tier a departing prop was wearing is not a question anybody is asking.
//
// THE TWO HALVES TAKE COMPLEMENTARY THRESHOLDS (`ign` on one, `1 - ign` on the
// other), so at every pixel exactly one of them survives. Coverage is conserved
// through the whole transition and the silhouette never thins or doubles -- the
// alternative, both halves dithering against the same threshold, is solid where
// the noise is low and holed where it is high, in both halves at once.
// ---------------------------------------------------------------------------

// Fraction of the gone-distance at which the OLD distance-driven dissolve
// started. 0.85 made the band 15% of the range, so a tree that vanished at
// 1500 m began dissolving at 1275 m.
//
// It is no longer the trigger. The rim runs on the clock now and fires at a
// single distance, `RIM_AT = (1 + FADE_BAND) / 2` in v2/render/rim.js -- the
// MIDPOINT of that old band, which is where a hard cut preserves the coverage
// the symmetric smoothstep used to average out to. FADE_BAND survives as the
// definition of the band whose midpoint that is, and as the divisor below.
//
// Exported because a caller that wants a prop SOLID up to some distance has to
// divide by this to get the gone-distance to hand `RimFade.place`: the number is
// where the prop is gone, not where it starts going. See RockBed._fadeFloor,
// which is exactly that sum -- a rock has to still be whole when it reaches the
// distance its billboard takes over at, or it dissolves as a mesh instead.
export const FADE_BAND = 0.85

/**
 * How long an LOD cross-dissolve takes, in seconds. Long enough that the eye
 * reads a transition rather than a flicker, short enough that a walker is never
 * carrying many duplicates at once. Exported because the scatter that stamps the
 * timers has to know when to reclaim them, and two definitions of this number
 * would drift apart into duplicates that outlive their fade.
 *
 * A QUARTER SECOND, DOWN FROM A HALF, and the reason is the front of the ramp
 * rather than its length. A cross-dissolve conserves coverage: the prop is fully
 * covered from the first frame to the last, and all that changes is which tier
 * owns each pixel. That is the whole point of the complementary thresholds
 * below, and it is also why the transition is INVISIBLE while p is small -- at
 * 10% the arriving tier is a sprinkle of isolated pixels over a silhouette that
 * still looks solid. So the eye does not see a fade start at t=0, it sees
 * nothing happen and then a dissolve begin somewhere around a third of the way
 * in. At 500 ms that dead-looking opening was ~150 ms, which reads as a lag
 * between crossing the band and the animation starting. The ramp is also eased
 * (see fadeP below) so that opening is short in p as well as in seconds.
 */
export const PROP_FADE_SECONDS = 0.25

// Where the packing lives. A start time is stored NEGATED, which is what leaves
// the positive side of the float free for the never-fade 1.0 -- and, when the
// rim ran on distance, for a gone-distance in metres. The two DIRECTIONS are
// told apart within the negative range by magnitude: a fade-OUT start is biased
// by 1 and a fade-IN start by 4096, and
// the clock wraps at 1024 so the two ranges (1..1025 and 4096..5120) cannot
// meet. The bias of 1 on the out half is not decoration: an unbiased start of
// t0 = 0 would encode as -0.0, which compares equal to 0.0 and would be read as
// the never-fade default.
//
// Float32 at 5120 resolves to about half a millisecond, so a 250 ms fade still
// has ~500 distinct steps. The wrap is what keeps that true: an unbounded
// performance.now() clock would be at 1e5 seconds after a day and the fade would
// quantise to a tenth of itself.
const PROP_CLOCK_WRAP = 1024
const FADE_OUT_BIAS = 1
const FADE_IN_BIAS = 4096

// Shared by reference into every program this module compiles, exactly as
// snowAmount is -- so one setPropClock call moves the trees, and will move the
// grass and the ferns the day they opt in, with no registry of materials.
const propClock = { value: 0 }

/**
 * Advance the clock the LOD cross-dissolves run on. Call ONCE per frame, with
 * seconds; the value wraps at 1024 s.
 *
 * The wrap is visible to callers because it has to be: a scatter holding fades
 * in flight across the wrap sees `now` jump backwards past its start times, and
 * must finish those fades rather than let them restart. Trees does this in its
 * sweep -- a fade whose age is outside [0, PROP_FADE_SECONDS] is over.
 */
export function setPropClock(seconds) {
  if (!Number.isFinite(seconds)) throw new Error(`setPropClock: need a number, got ${seconds}`)
  propClock.value = seconds % PROP_CLOCK_WRAP
}

/** The current prop clock, for a scatter deciding when a fade it stamped is up. */
export function getPropClock() {
  return propClock.value
}

/**
 * The per-instance dissolve, computed at vertex rate and dithered at fragment
 * rate. Both halves are no-ops when the instance's channel holds three's
 * default of 1, which is what keeps every existing caller unchanged.
 *
 * The index expression mirrors what `color_vertex` uses for getBatchingColor,
 * because it is the same texel -- we are reading the channel beside the tint.
 */
const FADE_VERTEX = /* glsl */ `
  float propFade = 1.0;
  #if defined( USE_BATCHING ) && defined( USE_BATCHING_COLOR )
  {
    int fadeIdx = int( getIndirectIndex( gl_DrawID ) );
    int fadeSize = textureSize( batchingColorTexture, 0 ).x;
    float fadeSlot = texelFetch( batchingColorTexture,
      ivec2( fadeIdx % fadeSize, fadeIdx / fadeSize ), 0 ).a;
    // NEGATIVE is a biased clock reading, and it is now the ONLY thing this slot
    // carries apart from the never-fade 1.0 every instance starts at. Both
    // dissolves are stamped starts: the LOD cross-fade and the rim. See
    // setPropFadeTimerAt for the packing and the dissolve header for the shape.
    if ( fadeSlot < 0.0 ) {
      float fadeBias = -fadeSlot;
      bool fadeIn = fadeBias > ${(FADE_IN_BIAS + PROP_CLOCK_WRAP) / 2}.0;
      float fadeT0 = fadeBias - ( fadeIn ? ${FADE_IN_BIAS}.0 : ${FADE_OUT_BIAS}.0 );
      float fadeP = clamp( ( uPropClock - fadeT0 ) *
        ${(1 / PROP_FADE_SECONDS).toFixed(6)}, 0.0, 1.0 );
      // EASED OUT, not linear, and this is the fix for "the fade takes a moment
      // to get going". Coverage is conserved through the whole dissolve, so the
      // only visible signal is the MIX, and a mix under about a fifth is not a
      // visible signal at all -- the arriving tier is scattered single pixels on
      // a silhouette the departing tier still fills. A linear ramp therefore
      // spends its first fifth looking like nothing has happened yet, which is
      // read as latency between crossing the band and the animation starting.
      // p*(2-p) is a quadratic ease-out: it clears a fifth in the first tenth of
      // the window and half in the first three tenths, so the dissolve is
      // visibly underway within a frame or two, and it decelerates into the end
      // where the last few departing pixels are what the eye is tracking. Any
      // remap is safe here as long as BOTH halves get the same one, which they
      // do -- they are computed from this single fadeP below.
      fadeP = fadeP * ( 2.0 - fadeP );
      // The two halves are complements in MAGNITUDE -- the departing tier keeps
      // 1-p of its pixels while the arriving one keeps p -- and the SIGN is how
      // the fragment stage knows which of the two thresholds to test against.
      propFade = fadeIn ? -fadeP : 1.0 - fadeP;
    }
  }
  #endif
  vPropFade = propFade;`

/**
 * Interleaved gradient noise (Jimenez, "Next Generation Post Processing in Call
 * of Duty: Advanced Warfare", SIGGRAPH 2014), the dissolve's threshold source.
 *
 * Three ALU ops and no texture, and it REPLACED a mat4 constant, so it is at
 * worst a wash on cost and probably cheaper.
 *
 * WHAT IT BUYS, measured in float32 over 512x512 against the 4x4 Bayer it
 * replaced. Two things, and the second was the reason for the change:
 *
 *   COVERAGE. Bayer has 16 threshold levels, so it can only quantise the fade
 *   to sixteenths: asked for 5% it keeps 6.25%, a 25% relative error, and the
 *   dissolve advances in visible steps at the ends of its ramp. IGN's worst
 *   coverage error over the same sweep is 0.03%.
 *
 *   STRUCTURE. Bayer's 50% level set is EXACTLY a period-2 checkerboard --
 *   measured 100% self-similarity at a 2 px horizontal shift -- and that
 *   2-pixel lattice is the diagonal diamond cross-hatch that is Bayer's
 *   signature at every size (8x8 gives the same diamonds, larger). IGN is not
 *   structureless either, and it is worth being honest about that: it still
 *   measures 98.3% self-similar under a 15 px diagonal shift. But 15 px of
 *   faint diagonal is perceptually a different thing from 2 px of hard lattice,
 *   and its longest same-state run at 50% is 2 px, so it stays evenly spread.
 *
 * A plain hash of gl_FragCoord would also be free and IS structureless (50.4%,
 * i.e. none), but it is WHITE noise, which clumps: measured 16 px same-state
 * runs at half coverage, so you get visible blobs and holes rather than an even
 * spread. Blue noise is the thing that is both structureless AND evenly spaced,
 * and IGN is the cheapest way to get most of it. A tiled 64x64 blue-noise
 * texture is the step up from here if this is not clean enough -- one
 * texelFetch inside the branch that already exists -- and it is the only reason
 * to spend a texture unit on this. The R2 low-discrepancy pair
 * (0.7548776662, 0.5698402909) is the other candidate and measures slightly
 * better on coverage and slightly worse on run length; it was a coin toss.
 *
 * SCREEN SPACE AND FIXED, as the Bayer matrix was, and for the same reason: the
 * threshold is a function of gl_FragCoord and nothing else, so the stipple sits
 * still while the object slides across it. Feeding it time or view direction
 * makes it boil as the head moves, which is far more visible than the pop it is
 * replacing.
 *
 * IN STEREO the fixed screen-space pattern is a known compromise, unchanged by
 * this: both eyes sample DIFFERENT thresholds at the same surface point, so a
 * half-dissolved prop is solid to one eye and holed to the other, which is
 * binocular rivalry. Keying off the card's own UV instead would fix it and make
 * the stipple swim with the object. Not decided; wants a headset.
 */
const IGN_GLSL = /* glsl */ `
  float ign( vec2 p ) {
    return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
  }`

const FADE_FRAGMENT = /* glsl */ `
  if ( vPropFade < 1.0 ) {
    float fadeT = ign( gl_FragCoord.xy );
    // A NEGATIVE fade is the arriving half of a cross-dissolve, and it takes the
    // COMPLEMENTARY threshold. That is the whole trick: the departing half keeps
    // the pixels where ign < 1-p and the arriving half keeps the ones where
    // ign > 1-p, so every pixel is covered by exactly one of them and the
    // silhouette neither thins nor doubles anywhere in the transition. Testing
    // both against the same threshold would instead make them solid together
    // where the noise is low and holed together where it is high.
    if ( vPropFade < 0.0 ) fadeT = 1.0 - fadeT;
    // <= rather than <, so a fully dissolved instance (vPropFade == 0.0) loses
    // every fragment even where the threshold is also 0.0. With Bayer the
    // smallest threshold was 1/32 and the case could not arise; ign() really
    // does reach zero, and one surviving pixel per few thousand at the draw
    // radius is exactly the black dot the dissolve exists to prevent.
    if ( abs( vPropFade ) <= fadeT ) discard;
  }`

/**
 * Put one instance back to "never fade", which is three's own initial value for
 * the channel and the steady state of every prop that is neither mid-dissolve
 * nor hidden.
 *
 * Called at the END of a transition as well as before one. A finished fade-OUT
 * leaves an invisible instance holding a clock reading, and a clock reading that
 * outlives the fade it described is a stale number waiting to be misread the
 * next time the pool hands that id out; clearing it means the only two values
 * the slot ever holds at rest are 1.0 and nothing.
 *
 * The batch must already have a colour texture -- BatchedMesh creates it lazily
 * on the first setColorAt -- because there is no public way to make one, and
 * conjuring it here would mean duplicating three's sizing rule.
 */
export function setPropSolidAt(batch, instanceId) {
  const tex = batch._colorsTexture
  if (!tex || !(tex.image.data instanceof Float32Array)) {
    throw new Error(
      'setPropSolidAt: batch has no float colour texture -- call setColorAt at least once first'
    )
  }
  tex.image.data[instanceId * 4 + 3] = 1
  tex.needsUpdate = true
}

/**
 * Stamp a dissolve onto an instance: from `startTime` on the prop clock it
 * dithers IN over PROP_FADE_SECONDS if `fadeIn`, or OUT if not. Written ONCE per
 * transition; the shader does the rest.
 *
 * Used by both dissolves. An LOD cross-fade stamps a PAIR -- the arriving tier
 * in, a duplicate holding the departing tier out -- and the two must carry the
 * SAME start, or their complementary thresholds stop summing to full coverage
 * and the prop flickers thin or double for the length of the fade. A rim fade
 * stamps one instance alone and lets the other threshold go unused.
 *
 * There is ONE slot, so an instance cannot be in both at once, and a caller that
 * stamps over a transition in flight has silently cancelled it -- the fade is
 * still counted, still holds a duplicate, and now has a start time describing
 * some other event. Every caller here resolves that explicitly before stamping:
 * see RimFade._startFade and the `running` check at the top of _crossFade.
 */
export function setPropFadeTimerAt(batch, instanceId, startTime, fadeIn) {
  const tex = batch._colorsTexture
  if (!tex || !(tex.image.data instanceof Float32Array)) {
    throw new Error(
      'setPropFadeTimerAt: batch has no float colour texture -- call setColorAt at least once first'
    )
  }
  tex.image.data[instanceId * 4 + 3] = -(startTime + (fadeIn ? FADE_IN_BIAS : FADE_OUT_BIAS))
  tex.needsUpdate = true
}

// ---------------------------------------------------------------------------
// STRIP TILING: one quad that draws its cutout N times, each copy different.
//
// For the grass strips a region is carpeted with -- v2/render/grass.js. A strip is a long flat
// rectangle whose `uvProj.x` runs 0..N instead of 0..1, so the atlas' repeat
// wrap draws N copies of the tuft across it. That alone is a row of N IDENTICAL
// clumps at even spacing, which is a picket fence. This block spends a handful
// of ALU per fragment turning it into a row of clumps that are individually
// mirrored, slid, shortened and occasionally missing.
//
// WHAT EACH LINE COSTS IN COVERAGE, because they are not the same and the
// difference decides the whole economics of the strip system. A strip is TWO
// TRIANGLES whatever this block does to it, so `discard` saves nothing on the
// triangle bill -- it only removes grass, which then has to be bought back by
// scattering more strips. Dropping two tiles in three costs exactly a factor of
// three in strips, which is exactly the factor the strip system was worth in
// the first place. So:
//
//   MIRROR is FREE. One compare, no coverage lost, and it is the single
//   highest-value line here: it halves the number of distinct silhouettes the
//   eye has to notice before it decides the row repeats.
//   FLARE is BETTER than free -- it adds area. The top of the card is widened
//   about its own centre, so a strip is an upside-down trapezoid and the row of
//   clumps fans out as it rises instead of standing in a column. It is a
//   vertex-stage line, so it costs nothing per fragment -- but only once the
//   TILE GRID IS FLARED WITH IT. Widening the quad alone draws the same clumps
//   over more metres, which is a horizontal stretch of up to uStripFlare at the
//   top of every card; STRIP_VERTEX displaces the coordinate by the same amount
//   the vertex moved, so the extra width is extra grass instead.
//   SHRINK costs its own square. Each tile is scaled about its FOOT so the
//   strip's skyline is ragged rather than the same outline N times -- and it is
//   scaled in BOTH AXES, which is the whole subtlety of this block. Scaling v
//   alone squashes the clump into a wide short one; the picture has to lose
//   width at the same rate it loses height or the grass reads as trodden.
//   Because it shrinks in two axes it costs s^2, not s, so it is the second most
//   expensive line here and not the near-free one it looks like.
//   SLIDE is FREE, and it is free BECAUSE of the shrink. A tile scaled to s of
//   its width has 1-s of slack to sit anywhere in, so consecutive tiles stop
//   sharing a vertical seam without any wrapping. The earlier wrapped slide had
//   to go: once a tile is inset it no longer meets its neighbours, so a wrap
//   cuts a hard vertical edge through the middle of the tuft with nothing beside
//   it to complete the picture.
//   MASK is EXPENSIVE, at 1:1 against the whole point of the system. It is OFF
//   by default (uKeep 1.0) because the variety it used to buy is now bought
//   for nothing by the per-instance TILE COUNT -- a strip is 3 to 6 tiles long
//   (STRIP_TILES in v2/render/grass.js), so the runs already break up, and the
//   gaps are between strips rather than punched out of paid-for card. Left as a
//   knob, because the first few gaps are worth more than the last few.
//
// HOW MANY TILES: read out of the INSTANCE MATRIX, not baked into the geometry.
// The bank's `uvProj.x` runs 0..T where T is whatever count draws the cutout
// unstretched at the bank's own proportions, and the vertex stage rescales that
// by the instance's own x/y scale ratio. So a tile keeps ONE aspect for every
// instance and the count is whatever length JS gave the card -- one geometry, a
// strip of any length, and no way for a matrix to stretch the picture by
// accident. That aspect is NOT 1: a tile borrows the shape the tuft bed draws
// the same cutout at, which is 0.68 wide per unit tall, because the tuft's card
// is a chord and its width follows the square root of its height. Drawing the
// square photo square made every clump 1.5x too wide -- see STRIP_TILE_ASPECT
// in props/grass-bank.js. That last
// clause is the point: the aspect bug this replaced was invisible in every
// per-vertex gate and obvious the moment it was on screen.
//
// WHY textureGrad AND NOT texture. The mirror and the slide are done on `u`
// AFTER it has been wrapped into the tile, so the coordinate the sampler sees
// jumps at every tile boundary. Implicit derivatives across that jump are huge,
// the hardware picks the coarsest mip for that one pixel column, and every tile
// boundary becomes a bright blurred vertical line -- the exact artefact this is
// here to remove. Taking the gradients from the CONTINUOUS coordinate and
// sampling explicitly fixes it. Note that plain tiling would NOT need this:
// wrapping is the sampler's job and the interpolated coordinate stays smooth. It
// is the mirror and the slide that cost the textureGrad, not the repeat.
// textureGrad on a sampler2DArray takes vec2 gradients (the layer index is not
// differentiated) and is core GLSL ES 3.00, which is all we target.
// ---------------------------------------------------------------------------

// Fraction of tiles that survive the mask. 1.0 is an unbroken run of grass, and
// it is the default -- see the note above for why lowering this is not free and
// what now does the job it used to do.
const stripKeep = { value: 1 }

// The shortest a tile may be scaled to, about its own foot. 0.5 means a tile's
// clump ranges from half size to full, in BOTH axes, so the smallest one is a
// quarter of a tile's area sitting somewhere along its width.
const stripShort = { value: 0.5 }

// How far the top of a card is widened, as a fraction of its own length, at the
// top of the range -- each instance takes a uniform draw from 0 to this. The
// foot is untouched, which is what keeps a strip sitting exactly on the line
// between its two ground samples however hard it flares.
const stripFlare = { value: 0.35 }

// Degrees, the range a strip's far top corner leans OUT OF ITS OWN PLANE. Each
// instance takes a uniform draw from this range and a random side, so a strip is
// a warped ribbon rather than a flat sheet: upright at one end, leaning by up to
// 30 degrees at the other, twisting continuously between.
//
// IT IS NOT A LIGHTING EFFECT. Every strip vertex carries the normal (0,1,0) --
// grass is lit as if it were ground, which is what stops a card going black when
// it turns away from the sun -- so the twist changes the SILHOUETTE and nothing
// else. What it buys is that a strip no longer presents one flat plane whose
// clumps all go edge-on at the same instant.
const stripTwistDeg = { value: [10, 30] }
const uStripTwist = { value: new THREE.Vector2() }
function syncStripTwist() {
  const [lo, hi] = stripTwistDeg.value
  uStripTwist.value.set(Math.tan((lo * Math.PI) / 180), Math.tan((hi * Math.PI) / 180))
}
syncStripTwist()

/** Live knobs for the grass strips. Held by reference, like the snow. */
export function setStripTiling({ keep, short, flare, twist } = {}) {
  if (keep !== undefined) stripKeep.value = keep
  if (short !== undefined) stripShort.value = short
  if (flare !== undefined) stripFlare.value = flare
  if (twist !== undefined) { stripTwistDeg.value = twist; syncStripTwist() }
}

export function getStripTiling() {
  return {
    keep: stripKeep.value,
    short: stripShort.value,
    flare: stripFlare.value,
    twist: stripTwistDeg.value,
  }
}

/**
 * The mean per-tile scale, E[s] over s uniform on [short, 1].
 *
 * What a tile is scaled to is what a CLUMP's size is, so this is half of the
 * answer to "is strip grass the same size as tuft grass" -- STRIP_HEIGHT in
 * v2/render/grass.js is set to this number's reciprocal times the tuft bed's own
 * mean clump height, and check-grass.mjs gates the product. Distinct from
 * stripCoverage()'s E[s^2], which is about AREA and is a different question.
 */
export function stripClumpScale() {
  return (1 + stripShort.value) / 2
}

/**
 * What one strip actually draws, as a multiple of its own base rectangle.
 *
 * The mask, the shrink and the flare all change how much grass a card of a given
 * size ends up carrying, and NONE of them are visible to a gate that measures
 * instance matrices. Without this the strip bed's coverage would be quoted a
 * third too high and the whole comparison against the tuft carpet would flatter
 * itself -- so scripts/check-grass.mjs multiplies by this, and it lives here
 * because it has to move whenever the shader above does.
 *
 * A tile of unit size draws its clump at scale s in BOTH axes, so it carries
 * `s^2` of itself, and averaged over s uniform on [short, 1] that is
 *   E[s^2] = (1 + short + short^2) / 3.
 * The flare then multiplies the whole card's area by `1 + F/2` (a trapezoid
 * whose top is `1 + F` times its foot), and -- since the tile grid flares with
 * the geometry rather than being stretched by it, see STRIP_VERTEX -- the extra
 * area carries grass at the same rate the rest does. F's own mean draw is half
 * its maximum, hence flare/4.
 *
 * The twist costs a little, and it is the one term here that is MODELLED rather
 * than exact. Leaning a card about its own long axis turns its normal off
 * horizontal, so a near-horizontal view sees `cos(lean)` of it; the lean ramps
 * from 0 at one end of a strip to the drawn angle at the other, whose average is
 * `sin(t)/t`, and that is then averaged over the angle range by Simpson. It is
 * about 2% at the default 10-30 degrees -- small enough to ignore and cheap
 * enough not to, and stating it is what stops the next resize inheriting a
 * silent 2%.
 */
export function stripCoverage() {
  const q = stripShort.value
  const e2 = (1 + q + q * q) / 3
  return stripKeep.value * e2 * (1 + stripFlare.value / 4) * stripTwistCoverage()
}

/** E[ sin(t)/t ] over the twist range: see the note above. */
export function stripTwistCoverage() {
  const [lo, hi] = stripTwistDeg.value.map((d) => (d * Math.PI) / 180)
  const f = (t) => (t < 1e-6 ? 1 : Math.sin(t) / t)
  return (f(lo) + 4 * f((lo + hi) / 2) + f(hi)) / 6
}

// One instance's seed, from where the strip stands. Per INSTANCE and not per
// tile: the fragment stage folds this together with the tile index, so two
// strips side by side get different runs out of the same geometry. Cheap enough
// to be worth a varying rather than a second attribute -- BatchedMesh throws if
// a geometry entering the arena lacks an attribute the arena has, so a new
// attribute is a change to every generator in the project (see the note by
// setPropSolidAt, which is the same argument).
const STRIP_VERTEX = /* glsl */ `
  {
    mat4 stM = mat4( 1.0 );
    #ifdef USE_BATCHING
      stM = batchingMatrix;
    #endif
    #ifdef USE_INSTANCING
      stM = instanceMatrix;
    #endif
    vec4 stRoot = stM * vec4( 0.0, 0.0, 0.0, 1.0 );
    // fract() FIRST, so the sin() is fed a small number. World coordinates run
    // to a few thousand metres here and sin(43758 * 3000) is noise about the
    // float32 grid rather than a hash.
    vStripSeed = fract( sin( dot( fract( stRoot.xz * 0.0371 ),
      vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );

    // The instance's own x/y scale ratio, which is how many of the bank's baked
    // tiles fit across it -- see the header. The rotation in the matrix is
    // orthonormal, so a column's length is its scale.
    float stScale = length( stM[ 0 ].xyz ) / max( length( stM[ 1 ].xyz ), 1e-6 );

    // Flare: widen the card about its own centre, in proportion to how far up
    // the card this vertex is. uvProj.y is 1 at the foot and 0 at the top (see
    // buildGrassStrip), so the foot takes no displacement at all and the tilt
    // that seated it on the ground survives untouched. xz and not x, so the
    // crossed-plane variant widens along each plane's own chord.
    float stF = 1.0 + uStripFlare
      * fract( vStripSeed * 71.17 + 0.37 ) * ( 1.0 - uvProj.y );
    transformed.xz *= stF;

    // ...AND THE TILE GRID FLARES WITH IT, which is the whole reason this is a
    // varying rather than a fragment-side product. Widening the quad without
    // widening the coordinate draws the same clumps across more metres -- a
    // horizontal stretch of up to uStripFlare at the top of every card, tapering
    // to none at the foot, which is exactly the shear a trapezoid gives you for
    // free if you let it. Displacing the coordinate by the same amount the
    // vertex moved keeps a tile a fixed number of METRES wide at every height,
    // so the flare reveals more grass at the top corners instead of pulling the
    // grass that is there sideways.
    //
    // position.x is the vertex's offset from the strip's own centre (the quad is
    // built symmetric, see buildGrassStrip), and uvProj.x is position.x + w/2
    // exactly, because STRIP_BASE fixes the baked u span to equal the geometry
    // width. That identity is what lets this be written without knowing either
    // number, and check-grass.mjs gates it.
    vStripTx = ( uvProj.x + ( stF - 1.0 ) * position.x ) * stScale;

    // TWIST: ONE top corner out of the card's own plane, which is the cheapest
    // way to stop a strip being a plane at all. Move both and the quad stays
    // flat and merely leans; move one and the two triangles the quad is made of
    // take different attitudes, so the ribbon is upright at one end and leaning
    // at the other with a continuous twist between. Zero triangles, zero
    // attributes, and it applies to the corner on the shared diagonal (the +x
    // top vertex -- see the index order in buildGrassStrip) so that BOTH
    // triangles are warped rather than just one.
    //
    // THE FOOT IS UNTOUCHED, for the same reason the flare leaves it alone: the
    // strip is seated on the ground by a tilt between its two end samples, and
    // anything that displaces a foot lifts it off that line.
    //
    // WHY DIVIDE BY stScale. The displacement wants to be an ANGLE against the
    // card's own height, but local z is scaled by the instance's x scale (the
    // long axis: render/grass.js composes (sx, sy, sx), and z is only ever 0 in
    // this geometry so nothing before now cared). Dividing by sx/sy converts the
    // offset into the y scale's units, and a strip then leans by the same angle
    // whether it is three clumps long or six.
    float stTwist = mix( uStripTwist.x, uStripTwist.y,
      fract( vStripSeed * 113.71 + 0.61 ) )
      * sign( fract( vStripSeed * 29.43 + 0.13 ) - 0.5 );
    transformed.z += stTwist * transformed.y
      * step( 0.0, position.x ) * ( 1.0 - uvProj.y ) / max( stScale, 1e-6 );
  }`

// Four decorrelated values from one float -- Hoskins' hash. Four is what the
// block below needs (mask, mirror, shrink, slide) and they must not correlate,
// or the short tiles are also the mirrored ones and the row acquires a rhythm.
const STRIP_FRAGMENT = /* glsl */ `
  vec4 stripHash( float n ) {
    vec4 p = fract( vec4( n ) * vec4( 0.1031, 0.1030, 0.0973, 0.1099 ) );
    p += dot( p, p.wzxy + 33.33 );
    return fract( ( p.xxyz + p.yzzw ) * p.zywx );
  }`

const STRIP_SAMPLE = /* glsl */ `
  {
    // The CONTINUOUS coordinate, before any wrapping: one unit of it is one
    // tile, however long JS made this instance and however hard the vertex stage
    // flared it. Its derivatives are the honest footprint of this pixel on the
    // texture and they are what the sampler has to be handed -- see the header.
    float stTx = vStripTx;
    vec2 stDx = vec2( dFdx( stTx ), dFdx( vUvProj.y ) );
    vec2 stDy = vec2( dFdy( stTx ), dFdy( vUvProj.y ) );

    float stI = floor( stTx );
    float stU = stTx - stI;
    // The tile index and the instance seed, folded. The multiplier is large and
    // odd so neighbouring tiles of neighbouring strips do not land on the same
    // draw.
    vec4 stH = stripHash( stI + vStripSeed * 977.0 );

    if ( stH.x > uStripKeep ) discard;

    // Mirror. Operates inside the tile, so the sampler sees a discontinuity at
    // every boundary -- which is exactly what textureGrad is holding harmless.
    if ( stH.y < 0.5 ) stU = 1.0 - stU;

    // Shrink about the FOOT, IN BOTH AXES. v = 0 is the top of the tuft and
    // v = 1 is its base (see buildGrassTuft), so the foot is the fixed point and
    // a scale below 1 pushes the top of the picture off the top of the quad --
    // where there is no picture, and the fragment is dropped. Doing this to v
    // alone is what made every short tile a squashed one: a clump has one right
    // aspect, so it has to give up width at exactly the rate it gives up
    // height.
    float stS = mix( uStripShort, 1.0, stH.w );
    float stV = 1.0 - ( 1.0 - vUvProj.y ) / stS;
    if ( stV < 0.0 ) discard;

    // ...and the width the shrink freed up is where the slide lives. A clump s
    // wide has 1-s of slack to sit anywhere in, so no two neighbours share a
    // vertical seam and nothing has to wrap. Outside its own clump the tile is
    // empty, which is the gap between grass rather than a repeat of it.
    float stUu = ( stU - ( 1.0 - stS ) * stH.z ) / stS;
    if ( stUu < 0.0 || stUu > 1.0 ) discard;

    // Both axes now, or a short tile draws a mip that is too sharp and sparkles.
    stDx /= stS;
    stDy /= stS;

    diffuseColor *= textureGrad( uAtlas, vec3( stUu, stV, vTexLayer ), stDx, stDy );
  }`

// ---------------------------------------------------------------------------
// WIND: foliage bends, and the bend is a pure function of where the plant
// stands, how far up it you are, and the clock. No attribute, no CPU, no state.
//
// EVERY INPUT THIS NEEDS WAS ALREADY IN THE VERTEX STAGE. `uPropClock` is bound
// into every program here and advanced once a frame by v2/main.js; the instance
// root falls out of `batchingMatrix`; the height fraction is `1 - uvProj.y` on
// any card (buildImpostorCard authors v = 0 at the top) and object-space y on a
// mesh. So the whole effect is arithmetic on values that were being computed or
// carried anyway, which is the reason it is affordable at 50,000 instances.
//
// AND IT HAD TO BE. A per-vertex stiffness weight is how you would normally do
// this, and it is unavailable: BatchedMesh throws if a geometry entering the
// arena lacks an attribute the arena has, so one new attribute is a change to
// every generator in the project. Same constraint that shaped billboardVertex's
// layer mask and the fade slot's packing, and it pushes to the same answer --
// derive it from what is already there.
//
// BEND AS AN ANGLE, NOT A DISTANCE. The displacement is `amp * y`, so it is
// dimensionless: the instance matrix scales it afterwards along with everything
// else, and a 12 m spruce and a 0.3 m tuft lean by the same ANGLE with no
// per-instance height uniform. src/props-main.js's preview sway needs `uHeight`
// only because it builds one material per asset; a batch cannot, and does not
// have to.
//
// A TRAVELLING WAVE, NOT A PER-INSTANCE PHASE. The phase is
// `dot(rootXZ, windDir) * k - t * w`, so a gust crosses the meadow instead of
// every plant twitching on its own schedule. Worth saying that this is the CHEAP
// option as well as the better-looking one: it is a dot and a multiply-add,
// where the per-instance hash it replaces would be the 5-6 ops of the mossRoll /
// snowRoll pattern one screen up. There was no trade to make.
//
// THE DISTANCE RAMP IS THE WHOLE COST CONTROL, and it is deliberately a ramp
// rather than a tier test. Sway is not meant to read past ~100 m, and for the
// forest that line falls exactly on trees.js LOD_BANDS[2] where the billboard
// tier starts -- so gating on the tier is the obvious move and it is wrong. A
// tier swap is CROSS-DISSOLVED over PROP_FADE_SECONDS with both tiers standing
// at the same matrix; gate on tier and the departing crossed card sways while
// the arriving billboard stands still, as a double image, every time a tree
// crosses 100 m. Amplitude off the root's DISTANCE gives both halves the same
// number from the same root, so the dissolve stays coherent for free.
//
// It also generalises where a tier test would not: ferns draw to 90 m and grass
// to 70, so their beds are entirely inside the ramp and every one of them sways,
// billboards included. One rule, three classes, no special cases.
//
// WHAT IT DOES NOT BUY: inertia (a trunk still swinging after the gust has
// passed), branches whipping independently of the canopy, anything parting
// around the player. All three want per-vertex data or CPU state, which is where
// the price stops being near-zero.
// ---------------------------------------------------------------------------

// Wind direction as a unit vector in world XZ, and a global strength multiplier.
// Shared BY REFERENCE into every program compiled here, exactly as snowAmount
// is, so one setWind call moves the forest, the ferns and the grass together and
// no registry of materials is needed. Strength 0 is a true off switch: the
// arithmetic still runs, but nothing moves.
const windDir = { value: new THREE.Vector2(0.8660254, 0.5) }
const windStrength = { value: 1 }
const windDirDeg = { value: 30 }

/**
 * Live knobs for the wind. `strength` scales every class at once (0 is off,
 * 1 is the tuned look); `degrees` turns the direction in world XZ.
 *
 * This is the seam §10 weather plugs into when it exists -- a gust front is this
 * pair animated, and nothing else in the pipeline has to learn about it.
 */
export function setWind({ strength, degrees } = {}) {
  if (strength !== undefined) {
    if (!Number.isFinite(strength)) throw new Error(`setWind: strength must be a number, got ${strength}`)
    windStrength.value = strength
  }
  if (degrees !== undefined) {
    if (!Number.isFinite(degrees)) throw new Error(`setWind: degrees must be a number, got ${degrees}`)
    windDirDeg.value = degrees
    const r = (degrees * Math.PI) / 180
    windDir.value.set(Math.cos(r), Math.sin(r))
  }
}

export function getWind() {
  return { strength: windStrength.value, degrees: windDirDeg.value }
}

/**
 * Snap an angular frequency to the nearest whole number of cycles per clock
 * wrap, so `sin( uPropClock * w )` is CONTINUOUS across the wrap.
 *
 * setPropClock wraps at PROP_CLOCK_WRAP seconds because the fade packing needs
 * the float32 resolution (see the packing note). Anything reading that clock
 * through a sine inherits the wrap, and an unsnapped frequency puts a phase step
 * in every plant in the world once every 17 minutes -- rare enough to survive
 * every play session you would debug it in, and instantly obvious once you are
 * told it is there. One round() at build time removes it.
 */
function windFreq(hzPerSecond) {
  const quantum = (2 * Math.PI) / PROP_CLOCK_WRAP
  return Math.max(1, Math.round(hzPerSecond / quantum)) * quantum
}

/**
 * Per-class wind constants, folded into the GLSL at compile time.
 *
 * Compile-time and not uniforms because each of the three scatters builds its
 * OWN material (trees.js, ferns.js, grass.js each call createPropMaterial), so
 * the numbers never have to vary within a program -- and this shader is already
 * carrying fifteen uniforms. Only the two things that are genuinely global, the
 * direction and the strength, are uniforms.
 *
 *   amp    the tip's lean as a fraction of the plant's own height, so a
 *          dimensionless angle. Starting values are src/props-main.js's SWAY
 *          table, which was tuned by eye against these same assets on the props
 *          preview page.
 *   stiff  exponent on the height fraction. High pins the trunk and moves the
 *          canopy; low bends the whole plant from the ground.
 *   pin    METRES of the plant, measured up from its foot, over which the mesh
 *          weight ramps in. Only meshes read it -- cards get the exact fraction
 *          out of their uv. It is a length and not a fraction on purpose: tree
 *          variants run from a 2.0 m birch sapling to a ~12 m pine, so a shared
 *          height fraction would leave the saplings frozen solid. "The lowest
 *          3 m of trunk is stiff" is true of both and needs nothing per variant.
 *   carrier / envelope   the fast sway and the slow gust, rad/s, both snapped.
 *   waveK / gustK        how fast phase advances across the ground, rad/m. The
 *          gust's is much smaller, so a gust is a broad front crossing the
 *          meadow while the carrier ripples inside it.
 *   branch how much the phase varies with the vertex's own object-space XZ. On a
 *          mesh this is what stops two branches of one tree moving in lockstep,
 *          for one dot; on a card the same term varies across the quad and reads
 *          as the foliage rippling rather than the card shearing, which is why
 *          it stays small.
 */
export const WIND_PRESETS = {
  // pin MUST stay under the SHORTEST variant the bank builds, and for trees that
  // is not the 9 m default -- treeVariants crosses four species with TREE_SIZES,
  // so the floor is a 6 m birch at 0.33, or 1.98 m. An earlier 3.0 m pin was
  // longer than that whole tree: its tip weight capped at (1.98/3)^2.6 = 0.35 and
  // it swayed 8 mm while the 12 m pine beside it swayed 140 mm, which does not
  // read as a stiff sapling, it reads as a sapling nailed to the ground. See
  // check-wind, which asserts this against the bank rather than against a
  // remembered number. 1.2 m buys less trunk stiffness on the tall end than 3.0,
  // and that is the cheaper thing to give up -- on a 12 m pine the eye is on the
  // canopy either way, and pow( wH, stiff ) still carries the motion upward.
  tree: { amp: 0.012, stiff: 2.6, pin: 1.2, carrier: 1.7, envelope: 0.31, waveK: 0.06, gustK: 0.012, branch: 0.55 },
  fern: { amp: 0.075, stiff: 1.3, pin: 0.35, carrier: 2.3, envelope: 0.37, waveK: 0.22, gustK: 0.02, branch: 0.8 },
  grass: { amp: 0.075, stiff: 1.3, pin: 0.3, carrier: 2.6, envelope: 0.41, waveK: 0.3, gustK: 0.025, branch: 0.5 },
}

// Where the amplitude ramps out, in metres from the camera. Shared by all three
// classes: it is a statement about what an eye can resolve, not about the plant.
const WIND_NEAR = 60
const WIND_FAR = 100

/**
 * The bend, appended to `begin_vertex` AFTER `propObjPos` has been captured and
 * BEFORE the billboard spin. Both halves of that sentence are load-bearing.
 *
 * AFTER propObjPos: the snow and moss fields sample the vertex's UNSWAYED
 * position, so a drift stays put on a moving branch instead of swimming along
 * it. That is the same reason the billboard spin is excluded from it, and it
 * costs nothing to inherit -- the capture already happens one line up.
 *
 * BEFORE the spin: a spun card's local +X is mapped onto screen-right by
 * billboardVertex, so a displacement written into `transformed.x` here comes out
 * as sway across the screen no matter which way the card ends up facing. That is
 * the cheat, and it is the right one -- a billboard has no depth to give it
 * away, and the alternative is an inverse rotation to put an honest world
 * direction into a card that will be turned to face you regardless. Fixed
 * geometry (meshes, the crossed-card tier, grass strips) does NOT take the
 * cheat: it gets the true world direction, rotated into object space by
 * dividing out the instance's own yaw the way billboardVertex divides it out.
 */
function windVertex(w, { strip = false, cards = false } = {}) {
  const carrier = windFreq(w.carrier).toFixed(6)
  const envelope = windFreq(w.envelope).toFixed(6)
  // A strip is the one class whose instances are NOT uniformly scaled --
  // grass.js composes (sx, sy, sx) -- and local x and z are both scaled by sx
  // while the lever arm y is scaled by sy. Dividing by sx/sy turns the
  // displacement back into an angle against the card's own height, so a six-
  // clump strip leans by the same angle as a three-clump one. Exactly the
  // correction STRIP_VERTEX's twist makes, for exactly the same reason.
  const scaleFix = strip
    ? /* glsl */ `
      float wSx = length( wM[ 0 ].xyz );
      float wSy = max( length( wM[ 1 ].xyz ), 1e-6 );
      float wAspect = max( wSx / wSy, 1e-6 );`
    : /* glsl */ `
      float wAspect = 1.0;`
  // A strip is several metres of grass on one card, so bending it as a unit
  // reads as a waving plank -- the one place this could look worse than
  // nothing. uvProj.x is the vertex's distance along the strip (STRIP_BASE
  // fixes the baked u span to equal the geometry width, see buildGrassStrip), so
  // scaling it by the instance's aspect gives metres along the strip and feeding
  // that into the phase makes each clump lag its neighbour. The flare correction
  // STRIP_VERTEX applies to vStripTx is not wanted here and not needed: this is
  // a phase offset, not a texture coordinate.
  const along = strip ? /* glsl */ `+ uvProj.x * wAspect * ${w.waveK.toFixed(6)}` : ''
  // Cards carry an EXACT height fraction and meshes do not. v = 0 is the top of
  // any card buildImpostorCard makes and v = 1 is its foot, so `1 - uvProj.y` is
  // the fraction with no constant to get wrong and no per-variant height to
  // know. A mesh's uvProj is a bark repeat or a spray projection (tree.js), so
  // it falls back to object y over the pin length.
  const height = strip
    ? /* glsl */ `float wH = 1.0 - uvProj.y;`
    : cards
      ? /* glsl */ `float wH = mix( clamp( transformed.y * ${(1 / w.pin).toFixed(6)}, 0.0, 1.0 ),
          1.0 - uvProj.y, propCard );`
      : /* glsl */ `float wH = clamp( transformed.y * ${(1 / w.pin).toFixed(6)}, 0.0, 1.0 );`
  return /* glsl */ `
  {
    mat4 wM = mat4( 1.0 );
    #ifdef USE_BATCHING
      wM = batchingMatrix;
    #endif
    #ifdef USE_INSTANCING
      wM = instanceMatrix;
    #endif
    // Where this plant stands, in world space. The phase is taken from the ROOT
    // and not from the vertex, which is what makes a plant move as one object:
    // sample the vertex instead and the wave runs THROUGH each tree as well as
    // across the wood, and a canopy shears.
    vec3 wRoot = ( modelMatrix * wM * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
${scaleFix}

    // Off past WIND_FAR, and the same value for both halves of a cross-dissolve
    // because both halves share this root. See the header.
    float wReach = 1.0 - smoothstep( ${WIND_NEAR}.0, ${WIND_FAR}.0,
      distance( cameraPosition, wRoot ) );

    float wRun = dot( wRoot.xz, uWindDir );
    // Slow envelope over fast carrier: what makes it read as gusting rather than
    // as a metronome. The envelope never reaches zero -- foliage in a breeze is
    // never quite still -- and never exceeds 1, so amp stays the honest
    // maximum lean rather than a number the gust can overshoot.
    float wGust = 0.65 + 0.35 * sin( wRun * ${w.gustK.toFixed(6)} - uPropClock * ${envelope} );
    float wPhase = wRun * ${w.waveK.toFixed(6)} - uPropClock * ${carrier}
      + dot( transformed.xz, vec2( 0.7, 1.3 ) ) * ${w.branch.toFixed(6)} ${along};

${height}
    // Multiplying by transformed.y is what makes this an angle: the foot is
    // pinned because y is zero there, and the tip leans by amp times its own
    // height whatever
    // the instance was scaled to.
    float wLean = pow( wH, ${w.stiff.toFixed(3)} ) * transformed.y
      * ${w.amp.toFixed(6)} * uWindStrength * wReach * wGust * sin( wPhase ) / wAspect;

    // The instance's own +X in world XZ, as a unit complex number -- the same
    // quantity billboardVertex calls bbA, and needed here for the same reason:
    // a scatter yaws its instances at random, so an object-space displacement
    // would send every plant a different way and the wood would stir rather
    // than blow. The 2x2 is orthonormal, so world-to-object is its transpose:
    // object +X is wA and object +Z is perp(wA).
    vec3 wAxisW = ( modelMatrix * wM * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz;
    // GUARDED, where billboardVertex's identical normalize is not, and the
    // difference is which geometry reaches it. A billboard is always Y-up, so
    // its +X can never be vertical; this block also runs on grass strips, which
    // are TILTED to sit on the ground (up to about 22 degrees, see
    // check-grass). That is nowhere near vertical, so the guard should never
    // fire -- but a NaN here would not be a subtle error, it would fling one
    // strip's vertices across the screen, so it is worth three instructions.
    vec2 wAxisXZ = vec2( wAxisW.x, wAxisW.z );
    float wAxisLen = length( wAxisXZ );
    vec2 wA = wAxisLen > 1e-4 ? wAxisXZ / wAxisLen : vec2( 1.0, 0.0 );
    vec2 wDirObj = vec2( dot( uWindDir, wA ), dot( uWindDir, vec2( -wA.y, wA.x ) ) );

    // Branchless pick between the honest direction and the screen-parallel
    // cheat. propSpun is 0 for everything that is not a card about to be turned
    // to face the camera, and vec2(1, 0) is that card's own width axis.
    transformed.xz += mix( wDirObj, vec2( 1.0, 0.0 ), propSpun ) * wLean;
  }`
}

/**
 * `vertexColors` opts into a per-vertex tint multiplied over the array sample.
 *
 * Off for props, and it has to stay off for them: turning it on changes the
 * program, and every geometry in a batch would then need a `color` attribute it
 * does not have. Buildings pass true, because they are a SEPARATE merged mesh
 * (DESIGN.md §6 -- a village is ~450 static pieces inside 240 m, so per-instance
 * culling would cull nothing and one merged mesh beats a BatchedMesh), so the
 * cost of the second program is one extra draw call for a whole village.
 *
 * What it buys is most of the variation the buildings need without spending
 * texture layers on it: thatch weathering from new straw to grey, moss on the
 * north side of a roof, grime up a plaster panel, one shared timber tile
 * reading as oak on one cottage and pine on the next.
 */
export function createPropMaterial(
  textureArray,
  {
    vertexColors = false, billboardLayers = null, sphericalBillboard = false, stripTiling = false,
    wind = null,
  } = {}
) {
  const billboards = billboardLayers && billboardLayers.length ? Array.from(billboardLayers) : null
  // A flag with nothing to act on is a caller who thinks their cards are being
  // spun differently and is looking at unchanged pixels. Say so instead.
  if (sphericalBillboard && !billboards) {
    throw new Error('createPropMaterial: sphericalBillboard needs billboardLayers to spin')
  }
  // A preset NAME is the normal way to ask; an object is for a caller tuning one
  // off the presets. A typo in the name would otherwise compile a material that
  // silently never moves, so fail on it here where the list is.
  const windSpec = typeof wind === 'string' ? WIND_PRESETS[wind] : wind
  if (wind && !windSpec) {
    throw new Error(`createPropMaterial: unknown wind preset '${wind}' (have ${Object.keys(WIND_PRESETS).join(', ')})`)
  }

  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    // Binary cutout only. Alpha blending cannot be sorted within a batched
    // draw call, so it is architecturally unavailable to us (DESIGN.md §7).
    alphaTest: 0.5,
    transparent: false,
    // Foliage cards are single-sided geometry, and both of their sides are the
    // same leaf. See the normal_fragment_begin patch below: three's flip is
    // undone so a card is lit by its authored normal from either side.
    side: THREE.DoubleSide,
    vertexColors,
  })

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: textureArray }
    // By REFERENCE, so one setSnow call moves every program compiled here.
    shader.uniforms.uSnow = snowAmount
    shader.uniforms.uSnowLayers = snowLayers
    shader.uniforms.uSnowRockLayers = snowRockLayers
    shader.uniforms.uSnowCardLayers = snowCardLayers
    shader.uniforms.uSnowLine = snowLine
    shader.uniforms.uSnowBand = snowBand
    shader.uniforms.uSnowVary = snowVary
    shader.uniforms.uLeafSnowVary = leafSnowVary
    shader.uniforms.uMoss = mossAmount
    shader.uniforms.uMossLayers = mossLayers
    shader.uniforms.uMossLine = mossLine
    shader.uniforms.uMossBand = mossBand
    shader.uniforms.uMossVary = mossVary
    shader.uniforms.uPropClock = propClock
    if (billboards) shader.uniforms.uBillboardLayers = { value: billboards }
    if (windSpec) {
      shader.uniforms.uWindDir = windDir
      shader.uniforms.uWindStrength = windStrength
    }
    if (stripTiling) {
      shader.uniforms.uStripKeep = stripKeep
      shader.uniforms.uStripShort = stripShort
      shader.uniforms.uStripFlare = stripFlare
      shader.uniforms.uStripTwist = uStripTwist
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float texLayer;
        attribute vec2 uvProj;
        varying float vTexLayer;
        varying vec2 vUvProj;
        uniform float uSnow;
        uniform float uSnowLine;
        uniform float uSnowBand;
        uniform vec2 uSnowVary;
        uniform vec2 uLeafSnowVary;
        // The FOLIAGE list, which this stage did not need until the leaf roll
        // arrived -- the fragment stage has had it all along (SNOW_APPLY), and
        // the uniform is the same object bound to both.
        uniform float uSnowLayers[ ${SNOW_LAYERS.length} ];
        uniform float uSnowRockLayers[ ${SNOW_HARD_LAYERS.length} ];
        uniform float uMoss;
        uniform float uMossLine;
        uniform float uMossBand;
        uniform vec2 uMossVary;
        // WHERE MOSS MAY GROW, the same list the fragment stage masks with
        // (MOSS_APPLY) and the same uniform object bound to both. This stage
        // needs it because the per-instance moss roll is gated on it -- see the
        // mossV loop below.
        uniform float uMossLayers[ ${MOSS_LAYERS.length} ];
        uniform float uPropClock;
        varying vec4 vSnowPos;
        varying vec2 vMoss;
        varying float vPropFade;
        ${billboards ? `uniform float uBillboardLayers[ ${billboards.length} ];` : ''}
        ${windSpec ? `uniform vec2 uWindDir;
        uniform float uWindStrength;` : ''}
        ${stripTiling ? `varying float vStripSeed;
        varying float vStripTx;
        uniform float uStripFlare;
        uniform vec2 uStripTwist;` : ''}`
      )
      // `propObjPos` is `transformed` BEFORE the billboard spins it, and the
      // snow patch below samples that rather than the live value. A billboard's
      // vertices move in world space every time the player turns, so sampling
      // world noise at them would make the drift swim across the card; sampling
      // where the card WOULD be if it were not turning holds it still. Identical
      // to `transformed` for everything that is not a billboard.
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTexLayer = texLayer;
        vUvProj = uvProj;
        vec3 propObjPos = transformed;
        ${propCardMask(billboards ? billboards.length : 0)}
        ${FADE_VERTEX}
        ${windSpec ? windVertex(windSpec, { strip: stripTiling, cards: !!billboards }) : ''}
        ${billboards ? billboardVertex(sphericalBillboard) : ''}
        ${stripTiling ? STRIP_VERTEX : ''}`
      )
      // Snow is placed in WORLD space so that two instances of the same tree
      // standing side by side do not wear identical drifts, and so a drift does
      // not slide around a trunk when the instance is yawed. That means undoing
      // batching and instancing the way project_vertex does -- `transformed` is
      // still object space here, and modelMatrix alone would put a whole
      // BatchedMesh's worth of trees at one spot.
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 snowWorld = vec4( propObjPos, 1.0 );
        vec4 snowRoot = vec4( 0.0, 0.0, 0.0, 1.0 );
        #ifdef USE_BATCHING
          snowWorld = batchingMatrix * snowWorld;
          snowRoot = batchingMatrix * snowRoot;
        #endif
        #ifdef USE_INSTANCING
          snowWorld = instanceMatrix * snowWorld;
          snowRoot = instanceMatrix * snowRoot;
        #endif
        // Where this vertex is and where its instance stands, both in world
        // space, both computed ONCE. Three things read them: the noise fields
        // sample propWorld, the two season lines test propRootY, and the moss
        // height cue is the difference (see MOSS_RISE) -- so hoisting the product
        // out is one matrix-vector product saved at vertex rate and, more to the
        // point, the guarantee that the cue is measured against the same root the
        // lines are.
        vec3 propWorld = ( modelMatrix * snowWorld ).xyz;
        vec3 propRootW = ( modelMatrix * snowRoot ).xyz;
        float propRootY = propRootW.y;
        // TWO ROLLS OFF THE ROOT'S WORLD XZ, one per season. Both are constant
        // across every vertex of an instance, because the root is, so neither
        // can vary across a face -- which is the whole reason this is a hash and
        // not a per-instance attribute: there is no channel left (see
        // setMossVary). Different constants in each so a rock that rolled bare of
        // moss has no tendency to roll bare of snow.
        float mossRoll = fract( sin( dot( propRootW.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        float snowRoll = fract( sin( dot( propRootW.xz, vec2( 39.3467, 11.135 ) ) ) * 24634.6345 );
        // EVERY ROLL ASKS WHICH SURFACE IT IS ON, and the three gates below are
        // the tests. uSnowVary, uLeafSnowVary and uMossVary are global uniforms
        // like everything else here, but each exists to fix a problem that
        // belongs to a particular kind of surface, so each has to ask its own
        // question:
        //
        //   rockV -- "does this wear the ROCK RECIPE", which since wood joined
        //   SNOW_HARD_LAYERS means stone AND wood. That is the right gate for
        //   uSnowVary, because the problem is the recipe's: a surface leaning on
        //   'up' harder than foliage does takes its own undersides at a full load
        //   and stops being stone, or being wood (see setSnowVary).
        //
        //   leafV -- "is this FOLIAGE", over SNOW_LAYERS, and it is a genuine
        //   membership test rather than the complement of rockV on purpose:
        //   "not a hard surface" also catches grass, fronds, the terrain and
        //   every building layer, none of which is a canopy. It answers a
        //   different problem from rockV's, and the difference is the number of
        //   trees you are looking at. ONE canopy at a full load is a loaded tree
        //   and perfectly correct; a whole STAND of them at a full load is every
        //   tree in the wood wearing the identical ceiling, because the ceiling
        //   is a scene uniform -- which reads as paint over the forest rather
        //   than as weather that fell on it. uLeafSnowVary is the answer to that
        //   one, and it is a separate uniform because stone's band is tuned
        //   against a rock going white and would be the wrong band here (see
        //   setLeafSnowVary).
        //
        //   mossV -- "can this grow moss at all", over MOSS_LAYERS, and it is
        //   the same list and the same uniform the fragment stage masks moss
        //   with. Moss varies per instance EVERYWHERE it grows: on the boulder,
        //   on the living trunk, on the village beam and on the fallen log, all
        //   off one roll and one range. A narrower gate here would mean a rock
        //   rolling bare next to a trunk wearing the flat world ceiling, which
        //   is the same weather landing two ways. Leaves are excluded for free,
        //   because moss does not grow on a canopy and MOSS_LAYERS never listed
        //   one.
        //
        // rockV reads uSnowRockLayers, which is legal for a hard-surface test
        // because SNOW_HARD_LAYERS is built stone-first (see its definition).
        // leafV reads uSnowLayers, the foliage list, and mossV reads uMossLayers;
        // both had to be DECLARED in this stage for it, the fragment stage having
        // always had them. Three loops of ten, five and five iterations at vertex
        // rate, against the matrix-vector product already here.
        float rockV = 0.0;
        for ( int i = 0; i < ${SNOW_HARD_LAYERS.length}; i++ ) {
          rockV += step( abs( texLayer - uSnowRockLayers[ i ] ), 0.5 );
        }
        float leafV = 0.0;
        for ( int i = 0; i < ${SNOW_LAYERS.length}; i++ ) {
          leafV += step( abs( texLayer - uSnowLayers[ i ] ), 0.5 );
        }
        float mossV = 0.0;
        for ( int i = 0; i < ${MOSS_LAYERS.length}; i++ ) {
          mossV += step( abs( texLayer - uMossLayers[ i ] ), 0.5 );
        }
        // .w is this INSTANCE's snow load: the season ceiling, rolled into
        // [uSnowVary.x, uSnowVary.y] if this is a hard surface or into
        // [uLeafSnowVary.x, uLeafSnowVary.y] if it is foliage, and cut down by
        // how far its own root sits above the snow line. Linear in the roll,
        // unlike moss below: the bands this is meant to be driven with are narrow,
        // and shaping a narrow band only pushes instances onto its two ends.
        //
        // TWO MIXES, ONE ROLL, and both facts are deliberate. The two lists are
        // disjoint (check-rocks asserts it), so at most one of the mixes is ever
        // anything but 1.0 and a surface is never scaled twice; and sharing
        // snowRoll means a tree's canopy and its own trunk hash off the same
        // instance root and therefore take a COHERENT load, a heavy crown over a
        // heavy trunk rather than two independent draws on one tree.
        vSnowPos = vec4( propWorld,
          uSnow * mix( 1.0, mix( uSnowVary.x, uSnowVary.y, snowRoll ), min( rockV, 1.0 ) )
            * mix( 1.0, mix( uLeafSnowVary.x, uLeafSnowVary.y, snowRoll ), min( leafV, 1.0 ) )
            * smoothstep( uSnowLine - uSnowBand * 0.5, uSnowLine + uSnowBand * 0.5,
              propRootY ) );
        // Moss runs the other way: full below its line, gone above it. Same
        // root, same one matrix-vector product, opposite smoothstep.
        //
        // Its roll IS shaped, because the range it is driven with is wide and
        // both of its ends are meant to be reachable: crushing the bottom of the
        // roll parks roughly a sixth of the rocks exactly on uMossVary.x -- and
        // when that is 0, genuinely bare stone is the point -- while holding the
        // top short of 1.0 keeps a few at the full ceiling instead of everything
        // landing in the middle.
        //
        // AND IT IS GATED ON MOSS_LAYERS -- everywhere moss grows and nowhere
        // else, so stone, bark and timber all vary and a canopy never does. See
        // mossV above.
        //
        // .y IS THIS FRAGMENT'S HEIGHT ABOVE ITS OWN INSTANCE ROOT, in world
        // metres, and it is the whole reason vMoss became a vec2. Moss lives on
        // damp, damp on wood is the foot of a standing trunk and the underside of
        // a fallen log, and neither is four metres up a snag -- so the fragment
        // stage needs to know where up the object it is, which the load alone
        // cannot tell it. See MOSS_RISE for what is done with it.
        //
        // Measured from the INSTANCE ROOT and not from sea level, so it is a fact
        // about the object rather than about the mountain; the altitude question
        // is uMossLine's and is answered on the line below. It costs one subtract
        // and one float of interpolator, both of which ride terms that were
        // already here.
        vMoss = vec2(
          uMoss
            * mix( 1.0, mix( uMossVary.x, uMossVary.y, smoothstep( 0.15, 0.95, mossRoll ) ),
              min( mossV, 1.0 ) )
            * ( 1.0 - smoothstep( uMossLine - uMossBand * 0.5,
              uMossLine + uMossBand * 0.5, propRootY ) ),
          propWorld.y - propRootY );`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        varying float vTexLayer;
        varying vec2 vUvProj;
        varying float vPropFade;
        ${IGN_GLSL}
        ${SNOW_COMMON}
        ${MOSS_COMMON}
        ${stripTiling ? `varying float vStripSeed;
        varying float vStripTx;
        uniform float uStripKeep;
        uniform float uStripShort;
        ${STRIP_FRAGMENT}` : ''}`
      )
      // BOTH SIDES OF A CUTOUT ARE THE SAME SURFACE. Three's double-sided path
      // flips the normal toward the VIEWER (`normal *= faceDirection` in
      // normal_fragment_begin), which is right for a solid seen from inside and
      // catastrophic for a leaf: stand under a canopy, look up, and every card
      // hands the lighting a normal pointing at the ground -- dotNL 0 from the
      // sun and the hemisphere's near-black ground colour -- so the whole
      // underside of the tree goes black. Undoing the flip (faceDirection twice
      // is the identity) means a fragment is lit by the normal the GEOMETRY
      // authored, whichever side you are on. tree.js gives every leaf vertex
      // the canopy shell's normal for exactly this reason, and a leaf really is
      // one cell thick and lit from every side at once.
      //
      // What is left is a gentle darkening when you are looking at the back of
      // that normal, which is the underside of a canopy and the inside of a
      // wall. Ramped rather than stepped so a solid's silhouette, where the dot
      // passes through zero, does not get a hard rim.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal *= faceDirection;
        ${MOSS_APPLY}
        ${SNOW_APPLY}
        diffuseColor.rgb *= mix( 0.72, 1.0,
          smoothstep( -0.35, 0.15, dot( normal, normalize( vViewPosition ) ) ) );`
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
        ${stripTiling ? STRIP_SAMPLE : 'diffuseColor *= texture( uAtlas, vec3( vUvProj, vTexLayer ) );'}
        ${FADE_FRAGMENT}`
      )

    material.userData.shader = shader
  }

  // Force a distinct program cache key so this patched material never gets
  // conflated with an unpatched MeshLambertMaterial. The billboard list is part
  // of the key because it is compiled INTO the shader (an array size and a loop
  // bound cannot be uniforms), so two materials differing only in which layers
  // billboard are two different programs. So is `sphericalBillboard`, for the
  // same reason and with a sharper failure: it selects between two different
  // bodies for the same branch, so two materials agreeing on the layer list and
  // differing only here would silently share whichever compiled first -- and
  // the symptom is a hillside of rocks spinning like trees, or a forest lying
  // its trunks down, depending on the order they happened to be built in.
  const key = `prop-moss-v4${vertexColors ? '-vc' : ''}${billboards ? `-bb${billboards.join('.')}` : ''}${sphericalBillboard ? '-sph' : ''}${stripTiling ? '-strip' : ''}`
  material.customProgramCacheKey = () => key

  return material
}

/**
 * The material an IMPOSTOR IS BAKED WITH -- not one anything in the world is
 * drawn with.
 *
 * This looks like it breaks the one-material rule at the top of this file, and
 * it does not: that rule is about what BatchedMesh can collapse into one
 * multi-draw call, and nothing drawn with this ever enters a batch. It is used
 * for exactly one offscreen render into a 128x128 target, after which the
 * result is bytes in a texture layer and this material is disposed.
 *
 * LAMBERT, NOT BASIC, and it was Basic for a long time on an argument that
 * turned out to be half right. The argument: an impostor is shaded TWICE if you
 * let it be, once when the tree is captured and again when the card carrying
 * that capture is lit, so bake flat albedo and leave all the shading to the
 * card's own normals.
 *
 * What that misses is that a CARD HAS FOUR NORMALS AND A TREE HAS THOUSANDS.
 * The shading a card's own normals can produce is one smooth gradient across a
 * quad; the shading it is standing in for is a crown of ten thousand leaves,
 * most of which are behind other leaves. Baking flat albedo does not remove the
 * second kind of shading, it just deletes it -- and what comes back is exactly
 * what a flat photograph of a leaf looks like: the whole canopy at full leaf
 * albedo, no interior, no underside, LIGHTER than the grass it is standing on
 * when a real canopy at distance is a third to a half of leaf albedo because
 * most of what you see is in its own shadow.
 *
 * So the bake is lit, and the rig below is chosen so that it captures the part
 * the card cannot: SELF-SHADOWING, not direction. There is a key light, but a
 * modest one, and it comes from above and slightly behind the camera so it
 * cannot carve a strong left-right terminator into a picture that will later be
 * seen from every angle. The work is done by the hemisphere, whose ground
 * colour is nearly black -- that is what darkens the underside of the crown,
 * the inside of the trunk line and every leaf facing down, which is the
 * self-shadowing a single quad has no way to express. The card's own lighting
 * then multiplies a directional term on top, and the two compose the way a
 * texture and a light are supposed to.
 *
 * `toneMapped: false` stays: the renderer applies none, and the bake must not
 * be the one surface in the project that guesses about that.
 *
 * `vertexColors` HAS TO BE ASKED FOR, and a building has to ask. A prop keeps
 * its colour in the atlas and carries no `color` attribute at all, but the
 * building kit keeps a lot of its colour per vertex -- a slate roof IS the
 * shingle tile under a measured tint, and the thatch weathering, the moss at
 * the eave and every wall tint are the same mechanism. Baking a building
 * through the prop's material photographs it with all of that switched off,
 * which puts a brown card in front of a grey roof at the swap distance: the
 * one artefact an impostor is least allowed to have. It is an option rather
 * than the default because three requires the attribute once it is on, and a
 * fern geometry does not have one.
 */
export function createImpostorBakeMaterial(textureArray, { vertexColors = false } = {}) {
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    alphaTest: 0.5,
    transparent: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    vertexColors,
  })

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: textureArray }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float texLayer;
        attribute vec2 uvProj;
        varying float vTexLayer;
        varying vec2 vUvProj;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTexLayer = texLayer;
        vUvProj = uvProj;`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        varying float vTexLayer;
        varying vec2 vUvProj;`
      )
      // Same undo as createPropMaterial's, and for the same reason: a leaf is
      // one cell thick and the geometry's authored normal is the truth from
      // either side. Without this, three flips every far-side leaf's normal
      // toward the camera and the crown's own back lights up as brightly as its
      // front -- which would erase precisely the self-shadowing this bake is
      // being made lit in order to capture.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal *= faceDirection;`
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
        diffuseColor *= texture( uAtlas, vec3( vUvProj, vTexLayer ) );`
      )
  }

  material.customProgramCacheKey = () => `impostor-bake-lit-v1${vertexColors ? '-vc' : ''}`
  return material
}
