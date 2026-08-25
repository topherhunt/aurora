import * as THREE from 'three'
import { LAYER, SNOW_LAYERS, SNOW_ROCK_LAYERS, MOSS_LAYERS } from './textures.js'

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
// two lists it keeps: SNOW_LAYERS is foliage and wears clumps, SNOW_ROCK_LAYERS
// is stone and wears a cap with a wandering rim (SNOW_ROCK_UP and friends). Both
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
const snowRockLayers = { value: Float32Array.from(SNOW_ROCK_LAYERS) }

const mossAmount = { value: 0 }
const mossLayers = { value: Float32Array.from(MOSS_LAYERS) }

// The moss line, in world metres, and the band it fades over. Moss runs the
// OTHER WAY from snow -- full below the line, gone above it -- so the default is
// +1e6 rather than -1e6: every prop in the world is below it and `uMoss` alone
// drives the whole scene until the game calls setMossLine. That is what
// /gen-rock wants, where there is no terrain and the slider means what it says.
const mossLine = { value: 1e6 }
const mossBand = { value: 1 }

// The snow line, in world metres, and how many metres it takes to go from bare
// to loaded. Defaults are a deliberate NO-OP: a line at -1e6 puts every prop in
// the world above it, so `uSnow` alone drives the whole scene until the game
// calls setSnowLine. That is what /gen-tree wants, where there is no terrain.
const snowLine = { value: -1e6 }
const snowBand = { value: 1 }

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

// Blob size, in cycles per world metre. At 12.8 a clump is roughly 7.5 cm
// across, so a 2 m spray card carries a couple of dozen and the snow reads as
// settled crystals rather than as paint.
const SNOW_FREQ = 12.8

// Where the world-space blobs stop being resolvable and start shimmering.
// Procedural noise has NO MIP CHAIN: at 7.5 cm a blob is under a pixel past ten
// metres or so, and undersampled noise crawls when you move your head -- which
// in a headset is the worst artefact there is. Past SNOW_FADE_FAR the noise is
// blended to its own mean, so a distant tree gets the slider's average coverage
// flat, which is what a mip would have converged to anyway.
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

// --- and the ONE number that differs for stone ------------------------------
//
// Everything above serves a boulder as written. The only thing SNOW_ROCK_LAYERS
// changes is how hard the drift leans on `up`: 0.5, against 0.25 for foliage.
// Same blob size, same cutover rim, same span, same linear ramp.
//
// It is deliberately not more than that, and two earlier attempts at this
// section were the same mistake twice. Lean `up` to 0.8 and you get a clean
// white cap whose rim is a contour of the surface normal -- which is wrong for a
// rock for a reason a canopy never exposes: A ROCK HAS FLAT FACES. `up` is
// CONSTANT across a cut facet, so a mask that `up` dominates puts the whole
// facet on the same side of the cut, every facet flips as a unit, and the
// snowline runs along the facet edges as a hard straight seam. No amount of
// softening the rim fixes that, because the seam is in the mask and not in the
// edge; the only thing that breaks it is noise carrying enough weight to vary
// WITHIN a face. At 0.5 it does, which is why the patches read as settled snow
// rather than as paint, and why sharing the canopy's other numbers is not
// laziness but the actual answer.
//
// What 0.5 buys, and it is the whole brief: the top whitens first, a sheer side
// is about half covered by the time the top is solid, an underside is the last
// thing to go -- and a full winter still covers everything, exactly as foliage
// does. There is no face the slider cannot reach.
//
// WHERE THE NOISE IS SAMPLED matters more than any of this, and it is worth
// stating because it is the question a UV-projected texture would raise:
// vSnowPos.xyz is WORLD POSITION, not UV. rock.js gives each face its own
// dominant-axis projection with a seam at every facet edge, and the snow does
// not care, because the noise field is continuous through the solid. Nothing
// here needs a UV unwrap, a second projection, or a baked variant.
const SNOW_ROCK_UP = 0.5

// Exported ONLY so scripts/check-rocks.mjs can hold the promises above to
// account without a GL context. Nothing at runtime reads this: the numbers are
// compiled into the GLSL as literals. The shared ones are here too, because what
// the gate is checking is the rock's behaviour under all of them together.
export const SNOW_ROCK = Object.freeze({
  up: SNOW_ROCK_UP,
  foliageUp: 0.25,
  freq: SNOW_FREQ,
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

// Patches around 17 cm, against snow's 8 cm. Moss grows in colonies and a colony
// is a bigger thing than a drift of crystals; run it at snow's frequency and it
// reads as green speckle rather than as something alive.
const MOSS_FREQ = 6.0

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
// Further out than snow's 12-40 because the patches are twice the size.
const MOSS_FADE_NEAR = 20.0
const MOSS_FADE_FAR = 70.0

// Same two promises as SNOW_CUT_BIAS, and the reasoning there covers these: at 0
// the cut minus a full-width edge clears the mask's ceiling of 1.0, so no moss
// means no moss; at 1 the cut plus a full-width edge is under its floor of 0.0,
// so a fully mossed rock is fully mossed. Its own pair rather than the snow's
// because moss is new and nobody has looked at it yet -- if the ramp wants
// shaping, it should not drag the trees' snow with it.
const MOSS_CUT_BIAS = 1.08
const MOSS_CUT_SPAN = 1.16

// Exported for scripts/check-rocks.mjs, on the same terms as SNOW_ROCK: nothing
// reads it at runtime.
export const MOSS = Object.freeze({
  down: MOSS_DOWN,
  freq: MOSS_FREQ,
  tile: MOSS_TILE,
  cutBias: MOSS_CUT_BIAS,
  cutSpan: MOSS_CUT_SPAN,
  edgeMax: SNOW_EDGE_MAX,
})

const MOSS_COMMON = /* glsl */ `
  uniform float uMoss;
  uniform float uMossLayers[ ${MOSS_LAYERS.length} ];
  varying float vMoss;
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
      float blob = mix( 0.5,
        snowNoise( vSnowPos.xyz * ${MOSS_FREQ.toFixed(2)} + ${MOSS_NOISE_OFFSET} ), mossNear );
      float creep = blob * ( 1.0 - ${MOSS_DOWN} ) + down * ${MOSS_DOWN};
      // THE BRANCH STAYS ON THE UNIFORM and only the cut moves to the
      // per-instance load. That split is load bearing: uMoss > 0.0 is
      // quad-uniform, which is what makes the texture() fetch below legal, and
      // vMoss > 0.0 is not -- a varying can differ across a quad in principle,
      // and putting a fetch behind it would make the derivatives undefined. An
      // instance whose vMoss is 0 still enters the branch and pays for it; the
      // cut then sits above the mask's ceiling, so it comes out bare.
      float cut = ${MOSS_CUT_BIAS} - vMoss * ${MOSS_CUT_SPAN};
      float edge = clamp( fwidth( creep ), ${SNOW_EDGE_MIN}, ${SNOW_EDGE_MAX} );
      // Straight over the top of the rock's own diffuse, tint and all. Reached
      // here AFTER color_fragment, so diffuseColor already carries the
      // per-instance stone tint -- which moss deliberately does not inherit,
      // because moss on basalt and moss on sandstone are the same green.
      vec3 moss = texture( uAtlas,
        vec3( vUvProj * ${MOSS_TILE.toFixed(1)}, ${LAYER.MOSS}.0 ) ).rgb;
      diffuseColor.rgb = mix( diffuseColor.rgb, moss,
        smoothstep( cut - edge, cut + edge, creep ) );
    }
  }
`

const SNOW_COMMON = /* glsl */ `
  uniform float uSnow;
  uniform float uSnowLayers[ ${SNOW_LAYERS.length} ];
  uniform float uSnowRockLayers[ ${SNOW_ROCK_LAYERS.length} ];
  varying vec4 vSnowPos;

  float snowHash( vec3 p ) {
    p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
  }

  // One octave of value noise. Blobs want a single low frequency; a second
  // octave only adds per-pixel fizz that the mip chain then eats anyway.
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
    // The second list is stone rather than foliage (textures.js). It selects a
    // different weight below, not a different branch: the noise is the expensive
    // part and both kinds of snow want the same noise at the same size, so the
    // two recipes ride the same instructions and differ in exactly one mix().
    // The lists are disjoint, so 'rock' is 0 or 1 and never both.
    float rockMask = 0.0;
    for ( int i = 0; i < ${SNOW_ROCK_LAYERS.length}; i++ ) {
      rockMask += step( abs( vTexLayer - uSnowRockLayers[ i ] ), 0.5 );
    }
    if ( snowMask + rockMask > 0.0 ) {
      float rock = min( rockMask, 1.0 );
      // Blobs, leaning upward: snow settles on what faces the sky, and without
      // that lean a fully snowed tree reads as bleached rather than as loaded.
      // Stone leans twice as hard -- see SNOW_ROCK_UP -- so it fills in from the
      // top down, but the noise still keeps half the say, which is what stops
      // flat cut faces flipping as whole units.
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
      float blob = mix( 0.5, snowNoise( vSnowPos.xyz * ${SNOW_FREQ.toFixed(2)} ), snowNear );
      // The one number stone changes. Everything else below is shared.
      float upWeight = mix( 0.25, ${SNOW_ROCK_UP}, rock );
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
      diffuseColor.rgb = mix( diffuseColor.rgb, snowCol,
        smoothstep( cut - edge, cut + edge, drift ) );
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
// to be spun is authored with a vertical normal and a fixed cross is not, so
// the mask is `layer match AND normal.y > 0.5`. No new attribute, no duplicate
// texture layer, no second bake -- see billboardVertex.
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
function billboardVertex(layerCount) {
  return /* glsl */ `
  {
    float bbMask = 0.0;
    for ( int i = 0; i < ${layerCount}; i++ ) {
      bbMask += step( abs( texLayer - uBillboardLayers[ i ] ), 0.5 );
    }
    // ...AND the quad has to be one that WANTS spinning. A crossed card and a
    // billboard of the same species share one baked layer, so the layer alone
    // cannot separate them -- but the normal already does, and for free. A card
    // built to be spun is authored with a vertical normal (buildImpostorCard's
    // 'upNormal', set exactly when 'billboard' is, see the note above); a fixed
    // cross keeps its planes' own horizontal normals. So 'normal.y' IS the
    // marker for "turn me", and it costs no attribute and no second layer.
    // Grass is unaffected: its tuft tiers already live on a different layer.
    bbMask *= step( 0.5, normal.y );
    if ( bbMask > 0.0 ) {
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
      vec2 bbA = normalize( vec2( bbAxis.x, bbAxis.z ) );
      vec2 bbC = vec2( bbR.x * bbA.x + bbR.y * bbA.y, bbR.y * bbA.x - bbR.x * bbA.y );

      // Rotate (x, z) by bbC. RHS is fully evaluated before the assignment, so
      // reading transformed.x twice here is safe.
      transformed.xz = vec2(
        transformed.x * bbC.x - transformed.z * bbC.y,
        transformed.x * bbC.y + transformed.z * bbC.x
      );

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
// HOW IT IS FED, and why it costs nothing per frame. Each instance carries ONE
// number -- the distance at which it should be completely gone -- and the shader
// compares that against the instance's live distance to the camera. Nothing is
// animated on the CPU, no timers are kept, nothing is written per frame: the
// fade is a pure function of where the player is standing, so it plays forwards
// as they approach and backwards as they retreat, and it costs the same whether
// ten instances or ten thousand are mid-dissolve.
//
// WHERE THE NUMBER LIVES: the alpha channel of BatchedMesh's per-instance colour
// texture, which three allocates as RGBA-float, fills with 1, and then only ever
// writes .rgb of (setColorAt takes a THREE.Color, which has no alpha; the shader
// chunk reads .rgb). So the channel is present, per-instance, already uploaded,
// and unused. Using it needs no new vertex attribute -- which matters more than
// it sounds, because BatchedMesh throws if a geometry entering the arena is
// missing an attribute the arena has, so a new attribute is a change to every
// generator in the project. Reaching for `_colorsTexture` is reaching past a
// private field, so setPropFadeAt below validates it loudly rather than writing
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
// THE SAME CHANNEL ALSO CARRIES A TIMER, which is what cross-dissolves an LOD
// tier swap. A swap is not a function of distance the way the rim is: the
// instance is at a fixed range when it happens, and the whole point is that it
// RESOLVES -- stand still after crossing a band and the duplicate has to be
// evicted and the stipple has to go away, or standing still costs a permanent
// second mesh and permanent dots. So the pair is driven by a clock instead.
//
// The scheme is symmetric and costs one CPU write per instance per swap, not per
// frame: the caller stamps a START TIME into the channel of both halves -- the
// arriving tier fading IN, a duplicate holding the departing tier fading OUT --
// and the shader turns `uPropClock - t0` into the fade. Everything after the
// stamp is the GPU's, exactly as the distance dissolve is; the CPU's only other
// job is to notice the fade has run out and hand the duplicate back.
//
// THE TWO HALVES TAKE COMPLEMENTARY THRESHOLDS (`ign` on one, `1 - ign` on the
// other), so at every pixel exactly one of them survives. Coverage is conserved
// through the whole transition and the silhouette never thins or doubles -- the
// alternative, both halves dithering against the same threshold, is solid where
// the noise is low and holed where it is high, in both halves at once.
// ---------------------------------------------------------------------------

// Fraction of the gone-distance at which the dissolve starts. 0.85 makes the
// band 15% of the range, so a tree that vanishes at 1500 m starts dissolving at
// 1275 m -- over two minutes of walking, which is as gradual as it gets.
const FADE_BAND = 0.85

/**
 * How long an LOD cross-dissolve takes, in seconds. Long enough that the eye
 * reads a transition rather than a flicker, short enough that a walker is never
 * carrying many duplicates at once. Exported because the scatter that stamps the
 * timers has to know when to reclaim them, and two definitions of this number
 * would drift apart into duplicates that outlive their fade.
 */
export const PROP_FADE_SECONDS = 0.5

// Where the packing lives. A fade timer rides in the SAME float as the
// gone-distance, distinguished by sign: positive is a distance, negative is a
// clock reading. Within the negative range the two directions are told apart by
// magnitude -- a fade-OUT start is biased by 1 and a fade-IN start by 4096, and
// the clock wraps at 1024 so the two ranges (1..1025 and 4096..5120) cannot
// meet. The bias of 1 on the out half is not decoration: an unbiased start of
// t0 = 0 would encode as -0.0, which compares equal to 0.0 and would be read as
// the never-fade default.
//
// Float32 at 5120 resolves to about half a millisecond, so a 500 ms fade still
// has ~1000 distinct steps. The wrap is what keeps that true: an unbounded
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
    // POSITIVE is a gone-distance, and anything at or below 1 metre is the
    // "never fade" default rather than a real range -- no scatter in this
    // project fades anything inside 80 m.
    if ( fadeSlot > 1.0 ) {
      vec3 fadeRoot = ( modelMatrix * batchingMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
      propFade = 1.0 - smoothstep( fadeSlot * ${FADE_BAND}, fadeSlot,
        distance( cameraPosition, fadeRoot ) );
    // NEGATIVE is a biased clock reading: half of an LOD cross-dissolve. See
    // setPropFadeTimerAt for the packing and the dissolve header for the shape.
    } else if ( fadeSlot < 0.0 ) {
      float fadeBias = -fadeSlot;
      bool fadeIn = fadeBias > ${(FADE_IN_BIAS + PROP_CLOCK_WRAP) / 2}.0;
      float fadeT0 = fadeBias - ( fadeIn ? ${FADE_IN_BIAS}.0 : ${FADE_OUT_BIAS}.0 );
      float fadeP = clamp( ( uPropClock - fadeT0 ) *
        ${(1 / PROP_FADE_SECONDS).toFixed(6)}, 0.0, 1.0 );
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
 * Set the distance at which one instance is completely dissolved away.
 *
 * `gone` is metres from the camera; the dissolve occupies the outer 15% of it.
 * Pass 1 (or anything <= 1) to switch the effect off for that instance, which is
 * also the state every instance starts in.
 *
 * The batch must already have a colour texture -- BatchedMesh creates it lazily
 * on the first setColorAt -- because there is no public way to make one, and
 * conjuring it here would mean duplicating three's sizing rule.
 */
export function setPropFadeAt(batch, instanceId, gone) {
  const tex = batch._colorsTexture
  if (!tex || !(tex.image.data instanceof Float32Array)) {
    throw new Error(
      'setPropFadeAt: batch has no float colour texture -- call setColorAt at least once first'
    )
  }
  tex.image.data[instanceId * 4 + 3] = gone
  tex.needsUpdate = true
}

/**
 * Stamp one half of an LOD cross-dissolve onto an instance: from `startTime` on
 * the prop clock it dithers IN over PROP_FADE_SECONDS if `fadeIn`, or OUT if
 * not. Written ONCE per swap; the shader does the rest.
 *
 * The two halves of a pair must be stamped with the SAME start, or their
 * complementary thresholds stop summing to full coverage and the tree flickers
 * thin or double for the length of the fade.
 *
 * This OVERWRITES whatever gone-distance the instance carried, because there is
 * one channel and it cannot hold both. The caller has to put the distance back
 * when the fade expires. That is not the compromise it looks like: a tier swap
 * only ever happens inside the near set, and the rim dissolve only ever starts
 * at 85% of a gone-distance that is hundreds of metres out, so an instance in a
 * position to want both at once does not exist.
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
export function createPropMaterial(textureArray, { vertexColors = false, billboardLayers = null } = {}) {
  const billboards = billboardLayers && billboardLayers.length ? Array.from(billboardLayers) : null

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
    shader.uniforms.uSnowLine = snowLine
    shader.uniforms.uSnowBand = snowBand
    shader.uniforms.uMoss = mossAmount
    shader.uniforms.uMossLayers = mossLayers
    shader.uniforms.uMossLine = mossLine
    shader.uniforms.uMossBand = mossBand
    shader.uniforms.uPropClock = propClock
    if (billboards) shader.uniforms.uBillboardLayers = { value: billboards }

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
        uniform float uMoss;
        uniform float uMossLine;
        uniform float uMossBand;
        uniform float uPropClock;
        varying vec4 vSnowPos;
        varying float vMoss;
        varying float vPropFade;
        ${billboards ? `uniform float uBillboardLayers[ ${billboards.length} ];` : ''}`
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
        ${FADE_VERTEX}
        ${billboards ? billboardVertex(billboards.length) : ''}`
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
        // .w is this INSTANCE's snow load: the season ceiling, cut down by how
        // far its own root sits above the snow line. One extra matrix-vector
        // product at vertex rate, and it rides in the varying we already had.
        float propRootY = ( modelMatrix * snowRoot ).y;
        vSnowPos = vec4( ( modelMatrix * snowWorld ).xyz,
          uSnow * smoothstep( uSnowLine - uSnowBand * 0.5, uSnowLine + uSnowBand * 0.5,
            propRootY ) );
        // Moss runs the other way: full below its line, gone above it. Same
        // root, same one matrix-vector product, opposite smoothstep.
        vMoss = uMoss * ( 1.0 - smoothstep( uMossLine - uMossBand * 0.5,
          uMossLine + uMossBand * 0.5, propRootY ) );`
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
        ${MOSS_COMMON}`
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
        diffuseColor *= texture( uAtlas, vec3( vUvProj, vTexLayer ) );
        ${FADE_FRAGMENT}`
      )

    material.userData.shader = shader
  }

  // Force a distinct program cache key so this patched material never gets
  // conflated with an unpatched MeshLambertMaterial. The billboard list is part
  // of the key because it is compiled INTO the shader (an array size and a loop
  // bound cannot be uniforms), so two materials differing only in which layers
  // billboard are two different programs.
  const key = `prop-moss-v1${vertexColors ? '-vc' : ''}${billboards ? `-bb${billboards.join('.')}` : ''}`
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
 * Basic rather than Lambert, and that is the whole point of its existing.
 * An impostor is shaded TWICE if you let it be: once when the tree is captured
 * and again when the card carrying that capture is lit. Baking unlit albedo
 * leaves all the shading to the card's own normals, which is the same choice
 * tree.js makes for its canopy -- see the canopy-normal pass at the bottom of
 * buildTree, which hands every leaf the crown shell's normal. The impostor card
 * carries an outward horizontal normal per plane for the same reason, so a tree
 * shades the same way either side of the LOD swap.
 */
export function createImpostorBakeMaterial(textureArray) {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    alphaTest: 0.5,
    transparent: false,
    side: THREE.DoubleSide,
    toneMapped: false,
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
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
        diffuseColor *= texture( uAtlas, vec3( vUvProj, vTexLayer ) );`
      )
  }

  material.customProgramCacheKey = () => 'impostor-bake-v1'
  return material
}
