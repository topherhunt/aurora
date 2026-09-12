import THREE from './three-instance.js'
import { WORLD_HALF } from './sim/terrain-height.js'
import { SKY_GLSL } from './sky-glsl.js'
import { SAMPLE_GLSL } from './lighting.js'
import { PROBE } from './sky-probe.js'
import { WORLD_PROBE } from './world-probe.js'
import { TERRAIN_DARKEST, luminance } from './terrain/terrain-material.js'
import { paletteAt } from './clock.js'

/**
 * Lake surfaces (§11), built from Phase A's lake mask.
 *
 * WHY A MASK AND NOT A PLANE PER BODY. A lake is not a disc: filling a basin to
 * its outlet gives a shape with arms up every tributary, and a box or a radius
 * would put water over dry ground in every concave corner. The mask is the
 * shape, so the mask is what gets drawn.
 *
 * WHY THE SHORELINE IS NOT BLOCKY. The sim grid is 8 m, and stair steps that big
 * would be obvious from the ground, so the mask is DILATED by a cell before
 * meshing -- which pushes the polygon edge UNDER the terrain rather than leaving
 * it hanging in the air. The shoreline you see is then the line where the
 * full-resolution terrain mesh crosses the water plane: free, exact, and as
 * detailed as the LOD happens to be.
 *
 * WHAT THE SURFACE IS: a mirror, not a blue plane. Opaque, only slightly blue,
 * and almost all of what you see in it is sky coming back dimmer and bluer,
 * reflected about a normal four drifting layers of gradient noise keep bending.
 * No cubemap and no second pass -- sky-glsl.js computes sky colour from a
 * direction, so the water calls the same function along the reflected ray and is
 * correct at every hour, sunset included, with nothing to keep in step.
 *
 * Mountains come from the horizon map (§8), which already stores how high the
 * ground rises for every point and 16 compass directions: asking it along the
 * reflected ray says whether that ray escapes to sky or hits a ridge, for two
 * texture reads the terrain was already paying for.
 *
 * NOT reflected: the aurora and the stars, both separate additive meshes rather
 * than functions of direction, so there is nothing to call. The aurora is the
 * one that will be missed and it is not cheap to fix -- see §11.
 *
 * THERE ARE NO RIVERS, AND THAT IS A MEASURED DECISION. Flow is routed on the
 * CARVED surface, which has ~12,000 breach channels cut through ridges so the
 * world drains; the mesh is built from raw heightAt, where none of those cuts
 * exist. Measured on seed 20260804 at 1024^2:
 *
 *   - 47.4% of river segments run UPHILL on the rendered surface (0.26% on the
 *     carved one). 409 of 457 chains climb somewhere; the worst gains 925 m.
 *   - The rate is 45-50% in EVERY size band, so there is no subset of
 *     well-behaved trunk rivers to keep.
 *   - Steepest descent on the rendered surface -- downhill by construction --
 *     gives a median run of 39 m before it pits out. Of 21,014 traces, 8 exceed
 *     300 m and 1.7% reach a lake.
 *
 * The third number is the real one: this terrain does not drain. Rivers become
 * possible when the GENERATOR produces a draining surface -- fluvial erosion at
 * generation time -- and not before. Lakes are unaffected, being chosen and
 * verified against the raw surface, so they sit in basins that really exist.
 *
 * All of this works only because Phase A's `base` is sampled from the same
 * heightAt the chunk mesher uses, so a level computed on the sim grid is the
 * same level on the rendered ground.
 */

// One mesh per tile of the sim grid, so the frustum can reject most of the
// world's water instead of drawing every lake every frame.
const TILE = 64

// Scratch for syncShading, which runs every frame and must not allocate.
const shadeTmp = new THREE.Color()
const skyTmp = new THREE.Color()

// The hemisphere weight of the reference surface, i.e. 0.5 * dot( N, up ) + 0.5
// with N horizontal: a VERTICAL rock face, lit by half sky and half ground.
// That is the dark end of the range a hillside can occupy, and it is also what
// a mountain silhouette mostly consists of -- the faces steep enough to read as
// a silhouette at all.
const REF_HEMI_WEIGHT = 0.5

export const WATER = {
  // The body colour, and it is deliberately a MINORITY of what you see. Real
  // water at any distance is almost entirely a mirror; the blue is what leaks
  // through at steep angles where the Fresnel term is weakest. A lake painted
  // its own colour and lit like a diffuse surface is the single most common
  // reason game water reads as a sheet of blue plastic.
  tint: 0x18303f,
  // Fraction of the surface colour that is reflected sky when looking straight
  // DOWN into it. At grazing angles this goes to 1 on its own (Fresnel), so
  // this number alone decides how blue the lake at your feet is.
  mirrorDown: 0.72,

  // Wave slopes, not heights. The surface geometry stays a flat plane -- only
  // the normal moves -- so amplitude never appears; what the eye reads is the
  // slope, and the slope is what bends the reflection.
  chop: 1.0,

  // Global multiplier on every layer's drift speed, so the whole surface can be
  // calmed or whipped up from one place without disturbing the ratios between
  // the layers. The per-layer speeds below are already the fast ones.
  //
  // The table was written at 20x the physical speed, which was too far -- 0.5
  // lands it at 10x, which is where it sits now. This is the only place that
  // number lives, so the layer table below is still the physical ratios and
  // still reads as one decision per layer.
  flow: 0.5,

  // How hard the swell drags the ripples sideways, in ripple-wavelengths. This
  // is the knob that decides whether the surface reads as several independent
  // patterns laid on top of each other, or as one chaotic field. Zero looks
  // like a stack of transparencies; past about 1.0 the ripples smear into
  // streaks. See the domain-warp note in WAVE_GLSL.
  warp: 0.6,

  // Where the fine ripples fade out, in metres. Past this the normal relaxes
  // toward flat and the specular lobe broadens to compensate, which is the
  // aggregate of all the ripples inside one pixel rather than a random sample
  // of one of them. Without it, distant water is a field of crawling white
  // pixels -- the classic specular-aliasing failure, and it is worse in a
  // headset than on a monitor because the head never stops moving.
  detailFrom: 45,
  detailTo: 380,

  // Brightness of the sun and moon highlights, and they are deliberately past
  // 1.0: the glint is thresholded (see below), so the core clips to white and
  // only the rim keeps its tint. The moon's is higher because a moonlit lake is
  // mostly this -- the moon is 400,000 times dimmer than the sun, but the
  // glitter path is the brightest thing in a night scene.
  sunGlitter: 3.0,
  moonGlitter: 5.0,

  // Where the glint switches on, and how sharply. Sun glitter is not a smooth
  // falloff: a facet either points at the light or it does not, so what the eye
  // gets is crisp specks of blown-out white in dark water. `glintEdge` is the
  // lobe value the speck starts at; `glintWidth` is how wide the transition is,
  // and the whole point is that it is narrow.
  glintEdge: 0.45,
  glintWidth: 0.06,

  // The specular exponent at each end of the distance fade. Far water gets the
  // broad lobe because one pixel out there covers many wavelets and the honest
  // answer is their aggregate; near water gets the tight one because a pixel is
  // a fraction of a single wavelet.
  //
  // EXPONENTS, NOT SIZES, and the two do not scale together: for pow(cos t, n)
  // the half-maximum half-angle is sqrt(2 ln2 / n), so the blob goes as
  // 1/sqrt(n) and halving the apparent size of the distant sun costs a FACTOR OF
  // FOUR here.
  //
  // Sharpening the far end has a price: the broad lobe is half of the distance
  // anti-aliasing (the wave normal relaxing toward flat is the other half), so a
  // tighter far lobe buys realism with more sparkle crawl on distant water.
  sharpFar: 760,
  sharpNear: 2600,

  // Where a mountain blocks the sky. This is the HUE ONLY -- its brightness is
  // thrown away and recomputed every frame to match the darkest terrain the
  // world can currently draw. See `syncShading`.
  //
  // The mountain's own deep blue, not a dimmed copy of the sky: a dimmed grey
  // dawn is a grey mountain, and what reads as "solid land against sky" is a
  // shift in HUE as much as in brightness. Only the ratios between these three
  // channels survive, so editing this changes colour and never darkness.
  silhouetteTint: 0x14243f,

  // What the reflection loses on the way back out. Every reflection comes back
  // dimmer and bluer than the thing it reflects: the surface transmits some of
  // what arrives instead of bouncing it, and water swallows red first. Two
  // knobs because they are two decisions -- `reflTint` is the hue shift,
  // `reflDim` how much light is lost -- but they multiply into one uniform.
  reflTint: 0xc2d4ee,
  reflDim: 0.8,

  // HOW FAR YOU CAN SEE INTO IT, 0..1, and 0 reproduces the pinned look exactly
  // -- the material goes back into the opaque pass and not one line of the
  // composite below runs differently. That is the point of the knob: it is a
  // whole rendering decision on a dimmer switch.
  //
  // CONDITIONAL ON ANGLE AND DISTANCE. Looking down at water at your feet, most
  // of what reaches the eye came UP out of it, so the bed should be there;
  // looking along a lake a hundred metres off essentially all of it bounced. The
  // distance half reuses `near`, the term that already decides where ripples
  // fade, so "close enough to resolve the waves" and "close enough to see the
  // bottom" are one number instead of two that can disagree.
  //
  // THE ANGLE HALF IS GEOMETRIC, NOT FRESNEL. Fresnel is the physical answer to
  // this question and it is the wrong SHAPE: a fifth power is almost flat until
  // it is nearly grazing, so `1 - f` is still 0.88 at 20 degrees below the
  // horizontal and a rock forty-five metres out is as clear as one at your feet.
  // The complaint is about a view angle, so the term is a view angle --
  // `clarityAngle` degrees below the horizontal before any of it starts, full
  // looking straight down. Read off the FLAT view ray, not the wave normal, or
  // it flickers with every ripple.
  //
  // At its steepest this still transmits more than Fresnel allows. The exact
  // amount is `1 - mirror`, capped at 1 - mirrorDown = 0.28; the gap belongs to
  // `mirrorDown` being an artistic 0.72 where real water is nearer 0.02.
  //
  // COST: the material becomes `transparent`, moving to the sorted pass to blend
  // against the finished frame. XR-safe -- blending is the one way to read the
  // destination that works per-eye -- and free, because there is no new pass.
  // What it does not get is refraction, which would mean reading the frame as a
  // texture, and that is what does not survive the headset.
  clarity: 0.1,
  // Degrees below the horizontal at which seeing into it begins. Full effect
  // looking straight down; nothing at all at or above this.
  clarityAngle: 45,
}

// ---------------------------------------------------------------------------
// UNDERWATER (§11).
//
// Almost none of this is shader work. lighting.js's aerial-perspective chunk
// already fades every surface toward `uAirNear`/`uAirFar` at `scene.fog.density`
// on EVERY material in the scene, so underwater is that machinery told a
// different story: one colour at both ends of the ramp instead of two, and an
// extinction two orders of magnitude faster. Terrain, trees, rocks, grass,
// litter, mushrooms and buildings follow without knowing anything happened.
//
// The only shader needing a new path is this one, the water surface being the
// one thing you can be on the far side of.
// ---------------------------------------------------------------------------
export const UNDERWATER = {
  // The colour everything is eventually lost in, and the colour the light down
  // here is filtered to. One hex, three consumers, three colour spaces -- see
  // `murkAir` below, which is the trap this comment exists to mark.
  murk: 0x24414d,

  // How far you can see, in metres. NOT a fog density: densities are unreadable
  // and the thing actually being decided is a distance. `murkDensity` turns it
  // into the extinction coefficient the aerial chunk wants, and the gate checks
  // the round trip rather than trusting this comment.
  visibility: 20,

  // What is left of the two lights once they have come down through the water.
  // Two numbers because they are two quantities: the directional loses more,
  // since it arrives from one direction and has the longest path through the
  // surface, while the hemisphere is already the whole sky averaged.
  //
  // These matter for a narrower band than you would think. At 20 m visibility
  // almost everything on screen is most of the way to `murk` already, so what
  // these two actually decide is the look of the metre or two in front of her
  // face -- her own hands, a boulder she is standing beside, the lake bed.
  light: 0.3,
  ambient: 0.45,

  // How far the light COLOURS are pulled toward the murk, 0..1. Dimming alone
  // gives grey water, not blue-gray: water swallows red first, so what reaches
  // a rock down here is not white light turned down, it is the murk's own hue.
  tint: 0.75,

  // The underside of the surface, seen from below -- five knobs, below.
  //
  // How much of the sky survives the trip down through the surface. Well under
  // 1 because a good deal of what hits the surface from above bounces off it
  // instead of coming through.
  skyGain: 0.6,

  // How hard the waves bend where you are looking, as a multiple of the wave
  // normal's own tilt. This is the "with distortion" of the request and it is
  // nearly free -- the wave normal is already computed one line above, for the
  // top face.
  //
  // WELL OVER 1, AND IT HAS TO BE. This water's tilt runs about 0.1, so anything
  // under 1 bends the view by a couple of degrees -- a pane of glass, not a
  // ripple. Physics agrees: water to air, Snell's law AMPLIFIES angles by ~1.33
  // and runs away toward the critical angle, which is where most of this surface
  // is seen from. 2.5 is about fifteen degrees of wobble mid-window.
  distort: 2.5,

  // How far the window opens, as the cosine of the angle from straight up: full
  // sky above `windowOpen`, nothing below `windowShut`, smooth between.
  //
  // The real number is Snell's window -- everything above the surface squeezed
  // into a cone 48.6 degrees off vertical, mirror outside it, so cos 48.6 = 0.66.
  // A SQUARED COSINE HERE READS AS A BLUE PLANE: it is down to 0.44 at the edge
  // of a window that should still be wide open, and near zero across the whole
  // band you look through from a metre or two under. The window is not subtle in
  // real water.
  //
  // Soft rather than the hard edge physics has, because a crisp boundary inside
  // a rippling surface crawls.
  windowOpen: 0.78,
  windowShut: 0.3,

  // How much murk is left over the window even at its clearest, 0..1. The one
  // knob here that is not chasing realism: without it the middle of the window
  // is a clean hole punched through to the sky, and a hole does not read as a
  // surface. This is the "semi opaque with a slight blue-gray tint" of the
  // request, and it is the murk rather than a colour of its own so that the
  // window and the water around it stay one medium.
  veil: 0.18,

  // THE UNDERSIDE TAKES THE FULL MURK FADE, the same one the bed takes, and has
  // no knob of its own for it. Light off the far ceiling crosses the same
  // twenty metres of water as light off a far rock, so the rim where the
  // surface meets the bank is lost in the murk along with the bank -- a
  // crisp rim against a fogged bed is a plane intersecting terrain, not a
  // lake. A PARTIAL share is the one wrong answer: it leaves a fraction of
  // the rim crisp and greys the rest, which is the worst of both.
  //
  // What keeps this from being fog with ripples is `tirLit` below, not a
  // reduced fade: the near ceiling is lit brighter than the murk, so it
  // reads as a surface overhead and only RECEDES to murk with distance.

  // How much brighter the surface gets, outside the window, where the wave
  // tilts toward the vertical -- as a multiple of the murk it is modulating.
  //
  // OUTSIDE THE WINDOW IS NOT NOTHING. Past the critical angle the surface stops
  // transmitting and becomes a total internal MIRROR, and a mirror of the murk
  // is not a flat sheet of murk -- it is murk with the wave field's own
  // brightness moving across it. At 0 the grazing surface is flat. One multiply,
  // the bent direction being already in hand.
  tir: 1.4,

  // HOW MUCH DOWNWELLING LIGHT THE MIRROR CARRIES, 0..1, and this is the knob
  // that stops the ceiling reading as fog.
  //
  // A mirror painted in exactly `murk` is the defensible physics answer -- past
  // the critical angle you see the underwater world bounced back, and at a
  // grazing angle that world is twenty metres of murk -- and it is why the
  // ceiling reads as grayscale mist: a surface painted in the fog colour cannot
  // be seen through the fog.
  //
  // What that leaves out is that the water being mirrored is LIT, from above, by
  // the same sky the window is showing. So the mirror is tinted toward that sky
  // -- silver at noon, near-black at night, free because the sky value is in hand
  // two lines up. A FRACTION of it, not the sky itself, which would read as the
  // window never closing.
  tirLit: 0.4,

  // THE CAUSTIC NET on the bed -- the moving threads of focused sunlight. Three
  // knobs, and the pattern itself lives in lighting.js because it is applied by
  // the chunk that lights the terrain rather than by this shader; these are here
  // because they are underwater's numbers and belong beside the rest of them.
  //
  // `caustic` is peak added brightness in output space, on top of a surface
  // already darkened to a third by `light`, so it can afford to be assertive.
  //
  // `causticScale` is one cell of the net in METRES -- roughly the wavelength of
  // the ripples doing the focusing, which is why it is not a frequency: cells a
  // foot across read as sand in a stream, ten metres across as weather.
  //
  // `causticFade` is the depth over which the net dissolves, in metres. Not
  // `visibility`: that is light lost between the bed and her EYE, this is light
  // lost between the SURFACE and the bed, so a deep pool has a dark floor
  // however close she swims to it.
  caustic: 0.42,
  causticScale: 1.6,
  causticFade: 6,

  // What is left of the net once the sun is down, as a fraction of `caustic`.
  //
  // NOT zero. Caustics need a source small enough in the sky to cast a sharp
  // beam and at night there is one -- the moon, which this world keeps up for
  // most of the dark on purpose (§13). It is also one of the few cues down there
  // that the surface still exists.
  //
  // Rides the sun's ELEVATION on a ramp, not `isNight`: that is a threshold at
  // -6 degrees, and a fifth of the brightest thing in view arriving in one frame
  // is a pop you cannot unsee.
  causticNight: 0.2,
}

// --- the current (§11) -------------------------------------------------------
//
// A slow lateral push while she is under, so floating in a lake is not standing
// in one with a blue filter on. The only motion in this world she does not ask
// for, which is why every number is small and the period long: anything you can
// notice STARTING is a shove, and a shove in a headset makes people ill.
export const CURRENT = {
  // Peak displacement from where she would be standing still, in metres, along
  // the heading. She travels TWICE this side to side, which is the number to
  // read the knob by: 0.7 gives the 1.4 m of travel the effect was asked for.
  //
  // The measured peak runs about 4% over, because `cross` below is
  // perpendicular and so adds in quadrature rather than sharing this amplitude.
  // The true bound is sway * sqrt(1 + cross^2); the gate holds it to that.
  sway: 0.7,

  // Which way the current runs, as a compass bearing in degrees -- 0 is north,
  // 90 is east. Fixed for the whole world rather than per lake: there is no
  // flow field to ask, and a body of water big enough to swim across has one
  // prevailing set anyway.
  heading: 34,

  // The two periods, in seconds, and they are deliberately not commensurate.
  // ONE sine is a metronome, and a metronome is the thing that reads as a bug
  // rather than as water -- you feel the turn coming. Two whose ratio is not a
  // simple fraction take about two minutes to repeat, by which time nobody is
  // counting. The long one carries most of the amplitude; the short one is what
  // keeps the turn-around from being a clean stop.
  slow: 23,
  fast: 9.5,
  // How the amplitude is split between them. Must sum to 1, or the peak stops
  // being `sway` -- the gate checks it.
  slowShare: 0.7,

  // How much of the motion runs ACROSS the heading rather than along it, as a
  // fraction of `sway`. Small: this is what turns a line into a lazy figure
  // rather than a shuttle, and at 1 it would be a circle, which is a whirlpool.
  cross: 0.3,

  // Seconds to come up to full strength on going under, and to let go on
  // surfacing. Without it the push arrives and leaves in one frame, which is
  // exactly the shove this whole block is written to avoid, and it is worst at
  // the waterline where she is crossing the boundary repeatedly.
  ease: 2.5,
}

const _dirX = Math.sin((CURRENT.heading * Math.PI) / 180)
const _dirZ = -Math.cos((CURRENT.heading * Math.PI) / 180)

/**
 * Where the current has carried her, RELATIVE to where she would be standing
 * still, at time `t` seconds and at `strength` 0..1. Writes x and z into `out`
 * and zeroes y -- the push is lateral, because a vertical one fights the
 * submersion test at the waterline and would flicker the whole effect on and
 * off as her eye crossed the surface.
 *
 * PURE, and that is what makes it safe to apply as a difference: the caller
 * keeps the offset it last added, adds the change, and the total displacement
 * from her own path is always exactly this function's answer -- never an
 * integral of it, which would drift her across the map.
 */
export function currentDrift(t, strength, out) {
  const along =
    CURRENT.slowShare * Math.sin((2 * Math.PI * t) / CURRENT.slow) +
    (1 - CURRENT.slowShare) * Math.sin((2 * Math.PI * t) / CURRENT.fast + 1.7)
  // A third period again, and phase-shifted, so the across term never peaks
  // with the along term -- that is what makes the path an ellipse rather than a
  // diagonal line.
  const across = Math.sin((2 * Math.PI * t) / (CURRENT.slow * 0.61) + 0.9)

  const a = CURRENT.sway * strength * along
  const b = CURRENT.sway * CURRENT.cross * strength * across
  // (-dirZ, dirX) is the heading turned a quarter turn.
  out.x = _dirX * a - _dirZ * b
  out.y = 0
  out.z = _dirZ * a + _dirX * b
  return out
}

// Visibility in metres -> the extinction coefficient lighting.js's aerial chunk
// wants, which is also the FogExp2 density the water's own fog term reads.
//
// The chunk keeps a surface's own colour by `exp( -(d * density)^2 )`, so
// "visible" has to be given a threshold: RESIDUE is how much of a surface is
// still itself at exactly `visibility` metres. 2% is comfortably past the point
// where anything reads as anything, which is what "you cannot see further than
// 20 m" means in a medium that never truly cuts off.
//
// The relation is 1/d, not 1/d^2 -- the square is already inside the exponent
// -- so halving the visibility exactly doubles the density. The gate asserts
// that, because it is the line that would silently be wrong if this were ever
// rewritten as a lerp between two authored densities.
const RESIDUE = 0.02
export function murkDensity(visibility) {
  if (!(visibility > 0)) throw new Error(`murkDensity: visibility must be > 0, got ${visibility}`)
  return Math.sqrt(-Math.log(RESIDUE)) / visibility
}

// THE MURK IN TWO SPACES, and every wrong version of this looks plausible.
//
//   murkLinear  a THREE.Color in the renderer's working space, for the water
//               shader's uMurk (that shader mixes fog in LINEAR, before
//               colorspace_fragment) and for the lights, whose colours are
//               linear.
//   murkAir     the same colour as RAW sRGB COMPONENTS, for uAirNear/uAirFar,
//               because lighting.js's aerial mix happens AFTER
//               colorspace_fragment -- the same reason three uploads fogColor
//               unconverted.
//
// Swapping them gives a murk visibly too dark or visibly too light. Both derive
// from the one hex above, so editing the colour cannot leave one behind.
export const murkLinear = new THREE.Color(UNDERWATER.murk)
export const murkAir = (() => {
  const c = { r: 0, g: 0, b: 0 }
  murkLinear.getRGB(c, THREE.SRGBColorSpace)
  return new THREE.Vector3(c.r, c.g, c.b)
})()

// Five layers of gradient noise, drifting.
//
// NOT summed sine trains, which is the textbook answer and wrong for the reason
// it is textbook: a sum of periodic functions is periodic. Sines beat against
// each other on a lattice whose cell is the LCM of their wavelengths and the eye
// finds it almost immediately -- wallpaper sliding past. Choosing headings
// carefully does not help; the problem is that cos() comes back.
//
// So each layer is a slab of GRADIENT NOISE, which never repeats, with six
// independent knobs:
//
//   wavelength  the size of its features, in metres
//   slope       how hard it tilts the surface. A SLOPE, not an amplitude: the
//               plane is never displaced, so height never appears anywhere, and
//               the implied wave height is slope * wavelength if you want it
//               (2.9 m of swell down to 2 cm of catspaw). The chain-rule factor
//               of 1/wavelength is folded into this number rather than emitted,
//               which is what keeps the five comparable to each other.
//   rotate      the angle its noise lattice is turned to, so no two layers
//               share an axis and nothing lines up with the quads the mesher
//               emits or with the axes the noise hash is built on
//   offset      where in the infinite field it is sampled from, so two layers
//               of the same size are still different noise
//   heading     the compass direction it drifts, in degrees
//   speed       how fast it drifts, in metres per second
//
// `rotate` and `heading` are deliberately unrelated: a lattice turned 41 degrees
// says nothing about which way the water runs, and tying them puts a hidden
// correlation back into a field whose job is to have none.
//
// THE SPEEDS ARE RIVER SPEEDS, not ocean ones -- these are not what a 52 m swell
// does. Deliberate; WATER.flow scales all five.
//
// THE FIFTH LAYER, at 65 cm, gives grain rather than shape. Its slope is the
// smallest of the five because slope is a TILT: the others' number at 65 cm
// would make it as steep-sided as a 52 m swell, which is a rasp. And it is a
// detail layer, so it sits inside the distance branch and is domain-warped by
// the swell -- a catspaw not dragged around by the water under it reads as a
// texture painted on the surface.
export const WAVE_LAYERS = [
  { wavelength: 52.0, slope: 0.055, rotate: 13, offset: [148.2, 402.7], heading: 17, speed: 6.75, detail: false },
  { wavelength: 21.0, slope: 0.05, rotate: 41, offset: [317.4, -88.1], heading: 74, speed: 21.0, detail: false },
  { wavelength: 7.5, slope: 0.052, rotate: 97, offset: [-604.9, 251.3], heading: 131, speed: 12.0, detail: true },
  { wavelength: 2.6, slope: 0.042, rotate: 152, offset: [72.6, 933.8], heading: 168, speed: 7.0, detail: true },
  { wavelength: 0.65, slope: 0.03, rotate: 206, offset: [-441.5, -170.2], heading: 214, speed: 3.5, detail: true },
]

// Unrolled at build time rather than looped, so the constants are visible in
// the compiled shader instead of living in a uniform array that has to be
// uploaded and kept in step -- and so the two detail layers can sit inside a
// distance branch the driver can see through.
const layerTerm = ({ wavelength, slope, rotate, offset, heading, speed }, fadeExpr, warpExpr, setsWarp = false) => {
  const freq = 1 / wavelength
  const th = (rotate * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  // Compass heading: 0 is north, which is -z. Same convention as wlAzimuth.
  const hd = (heading * Math.PI) / 180
  const vx = Math.sin(hd) * speed
  const vz = -Math.cos(hd) * speed
  const f = (v) => v.toFixed(6)
  return `
    {
      vec2 q = ( p - vec2( ${f(vx)}, ${f(vz)} ) * uFlow * uTime ) * ${f(freq)};
      q = mat2( ${f(c)}, ${f(s)}, ${f(-s)}, ${f(c)} ) * q + vec2( ${f(offset[0])}, ${f(offset[1])} )${warpExpr};
      vec3 n = wNoise( q );
      // Chain rule back out through the rotation: dh/dp is R^T * (dn/dq),
      // times the scale, which is already folded into the slope. Forgetting the
      // TRANSPOSE is the classic way to get a normal field that looks
      // plausible in a still and rotates the wrong way when the light moves.
      g += ( ${f(slope)} * ${fadeExpr} ) * vec2(
        ${f(c)} * n.y + ${f(s)} * n.z,
        ${f(-s)} * n.y + ${f(c)} * n.z );
      ${setsWarp ? 'w = n.yz;' : ''}
    }`
}

const WAVE_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uChop;
  uniform float uFlow;
  uniform float uWarp;

  // A hash over the integer lattice. It must not go periodic at range: this
  // project has already shipped one hash that quietly collapsed at 6 km, and
  // the largest lattice coordinate here is world position over the smallest
  // wavelength, about 3100 for a 2.6 m layer at the edge of an 8 km world.
  // Returns a unit vector, which is what makes the gradient statistics below
  // independent of how good the hash actually is.
  vec2 wHashDir( vec2 c ) {
    vec3 p3 = fract( vec3( c.x, c.y, c.x ) * vec3( 0.1031, 0.1030, 0.0973 ) );
    p3 += dot( p3, p3.yzx + 33.33 );
    float a = fract( ( p3.x + p3.y ) * p3.z ) * 6.28318531;
    return vec2( cos( a ), sin( a ) );
  }

  // Gradient noise, returning ( value, d/dx, d/dy ). The derivative is
  // ANALYTIC rather than a finite difference: a finite difference needs a step
  // size, and any step size is wrong at some distance -- too small and it is
  // noise in the last bits of a float, too large and it flattens the ripples
  // it was meant to measure. The quintic fade and its derivative are the
  // standard pair; du is d/df of u.
  vec3 wNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = p - i;
    vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    vec2 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );

    vec2 ga = wHashDir( i );
    vec2 gb = wHashDir( i + vec2( 1.0, 0.0 ) );
    vec2 gc = wHashDir( i + vec2( 0.0, 1.0 ) );
    vec2 gd = wHashDir( i + vec2( 1.0, 1.0 ) );

    float va = dot( ga, f );
    float vb = dot( gb, f - vec2( 1.0, 0.0 ) );
    float vc = dot( gc, f - vec2( 0.0, 1.0 ) );
    float vd = dot( gd, f - vec2( 1.0, 1.0 ) );

    float k1 = vb - va;
    float k2 = vc - va;
    float k3 = va - vb - vc + vd;

    return vec3(
      va + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
      ga + u.x * ( gb - ga ) + u.y * ( gc - ga ) + u.x * u.y * ( ga - gb - gc + gd )
         + du * vec2( k1 + k3 * u.y, k2 + k3 * u.x ) );
  }

  // Gradient of the summed height field, which is all that is wanted: the plane
  // is never displaced. 'near' fades the two detail layers; 'far' relaxes
  // everything toward flat at extreme range.
  //
  // DOMAIN WARP: the two detail layers are sampled at a position pushed around
  // by the largest layer's gradient, so the ripples do not merely sit on top of
  // the swell, they are dragged by it -- which is what stops four independent
  // noise fields from reading as four independent noise fields. This is an
  // approximation and worth being honest about: the gradient returned is the
  // gradient of the layers AT the warped position, not the exact gradient of
  // the warped field, which would need the warp's own Jacobian. The exact
  // version costs two more multiplies and looks the same, because the warp is
  // small and slow compared to what it is warping.
  vec3 waveNormal( vec2 p, float near, float far ) {
    vec2 g = vec2( 0.0 );
    vec2 w = vec2( 0.0 );
    ${WAVE_LAYERS.filter((l) => !l.detail).map((l, k) => layerTerm(l, 'far', '', k === 0)).join('')}

    // Branching on distance is coherent -- neighbouring fragments are at
    // neighbouring distances -- so this genuinely skips the two expensive
    // layers over the far half of a lake rather than paying for both sides.
    if ( near > 0.004 ) {
      ${WAVE_LAYERS.filter((l) => l.detail).map((l) => layerTerm(l, 'near', ' + w * uWarp')).join('')}
    }

    return normalize( vec3( -g.x * uChop, 1.0, -g.y * uChop ) );
  }
`

export class Water {
  /**
   * `sky` and `lighting` are shared BY REFERENCE, not copied. The water reflects
   * whatever the sky dome is drawing, using the same function the dome does
   * (see sky-glsl.js), and it asks the horizon map where the mountains are using
   * the same sampler the terrain's shadows do (see lighting.js). Both must
   * therefore be constructed before the water.
   */
  constructor(scene, { sky, lighting, probe, world }) {
    if (!sky?.uniforms) throw new Error('Water needs the Sky, for the reflection')
    if (!lighting?.uniforms) throw new Error('Water needs WorldLighting, for the horizon map')
    if (!probe?.texture) throw new Error('Water needs the SkyProbe, for the aurora')
    if (!world?.textureA || !world?.textureB) throw new Error('Water needs the WorldProbe, for the trees and the bank')
    // Kept so update() can read the cross-fade off it every frame. See there.
    this.world = world

    this.scene = scene
    this.group = new THREE.Group()
    this.group.name = 'water'
    scene.add(this.group)

    // The three night terms, held BY REFERENCE like everything else out of
    // WorldLighting. They are NOT put in this.uniforms -- the shader must never
    // see them, for the reason spelled out on uHorizonMap below -- but
    // syncShading has to read them, because they are two thirds of how dark
    // a shadowed hillside is after sunset.
    this.night = {
      lift: lighting.uniforms.uNightLift,
      far: lighting.uniforms.uFarLight,
    }

    // WATER.silhouetteTint carries a hue and a brightness; only the hue is
    // wanted. Dividing it by its own luminance here leaves a colour whose
    // luminance is exactly 1, so multiplying it by a target luminance later
    // lands on that target with the hue intact -- and editing the hex in WATER
    // cannot change how dark the silhouette comes out.
    this.silHue = new THREE.Color(WATER.silhouetteTint)
    this.silHue.multiplyScalar(1 / luminance(this.silHue))

    // WATER.tint was picked by eye under a midday sky, so midday is the
    // exposure it is correct at, and every other hour is that colour times
    // however much less sky there is. Reading the reference out of the clock's
    // own noon keyframe rather than writing the number down here is the whole
    // point: retune the palette and this follows, and daylight water comes out
    // pixel-identical to what was tuned because the ratio is exactly 1 there.
    //
    // Sky only, no ground bounce: this is the tint of the water's BODY, which
    // is lit from above through a horizontal surface. That is the hemisphere
    // weight of an up-facing normal, 0.5 * 1 + 0.5, which drops the ground
    // term out entirely -- unlike the silhouette below, which stands in for a
    // vertical rock face and gets half of each.
    const noon = paletteAt(90)
    this.ambNoon = luminance(
      skyTmp.setRGB(...noon.hemiSky, THREE.SRGBColorSpace).multiplyScalar(noon.hemiIntensity)
    )
    this.tintDay = new THREE.Color(WATER.tint)

    this.uniforms = {
      ...THREE.UniformsLib.fog,
      ...sky.uniforms,
      // The horizon map only, taken by name rather than by spreading the whole
      // block. WorldLighting also carries uNightLift and uSkyFloor, which lift a
      // Lambert surface out of black after dark -- and a mirror must not be
      // lifted. Its darkness at night is the dark sky it is reflecting, which is
      // the correct answer arrived at for free; adding airglow on top would make
      // the lake glow brighter than the sky above it.
      uHorizonMap: lighting.uniforms.uHorizonMap,
      uSkyView: lighting.uniforms.uSkyView,
      uSunSky: lighting.uniforms.uSunSky,
      uTime: { value: 0 },
      uChop: { value: WATER.chop },
      uFlow: { value: WATER.flow },
      uWarp: { value: WATER.warp },
      // Scaled every frame by syncShading. WATER.tint is the colour as authored
      // under full daylight; what reaches the shader is that colour dimmed by
      // however much ambient light there actually is.
      uTint: { value: new THREE.Color(WATER.tint) },
      uMirrorDown: { value: WATER.mirrorDown },
      // Written every frame by syncShading, never by hand: the hue comes
      // from WATER.silhouetteTint and the brightness from the terrain palette.
      uSilTint: { value: new THREE.Color(0, 0, 0) },
      // Hue shift and light loss are two knobs in WATER because they are two
      // decisions, but nothing downstream needs them apart, so they arrive as
      // one multiply.
      uReflTint: { value: new THREE.Color(WATER.reflTint).multiplyScalar(WATER.reflDim) },
      uDetail: { value: new THREE.Vector2(WATER.detailFrom, WATER.detailTo) },
      uGlitter: { value: new THREE.Vector2(WATER.sunGlitter, WATER.moonGlitter) },
      uGlint: { value: new THREE.Vector2(WATER.glintEdge, WATER.glintWidth) },
      uSharp: { value: new THREE.Vector2(WATER.sharpFar, WATER.sharpNear) },
      // The aurora and the stars, which are meshes rather than functions of
      // direction and so cannot be answered analytically. See sky-probe.js.
      uProbe: { value: probe.texture },
      uProbeGain: { value: PROBE.gain },
      // The land, which the horizon map can only answer as a height and only for
      // terrain. rgb is its colour and ALPHA is its coverage. See world-probe.js.
      //
      // TWO of them, and they are bound once and never reassigned. The probe
      // ping-pongs between the pair so that a cube taken from a new vantage
      // point can be mixed in over the one it replaces instead of cutting to it;
      // what moves per frame is uWorldFade, a single float. Handing the shader
      // one sampler and swapping which texture it points at would work too, and
      // would recompile nothing -- but it also could not blend, which is the
      // whole feature.
      uWorldA: { value: world.textureA },
      uWorldB: { value: world.textureB },
      uWorldFade: { value: world.blend },
      uWorldMix: { value: WORLD_PROBE.mix },
      // 0 or 1, written by setSubmerged. A float rather than a bool so that
      // softening the switch into a blend later is a change to one line here
      // and none in the shader; today nothing between the two is drawn.
      uSubmerged: { value: 0 },
      // Linear, unlike the uAirNear/uAirFar that carry the same colour to every
      // other material in the world. See the note on murkLinear.
      uMurk: { value: murkLinear.clone() },
      // x: skyGain, y: distort, z: veil. Three of the underside's decisions,
      // packed because nothing downstream wants them apart.
      uUnder: { value: new THREE.Vector3(UNDERWATER.skyGain, UNDERWATER.distort, UNDERWATER.veil) },
      // x: windowShut, y: windowOpen -- the smoothstep edges of Snell's window,
      // kept apart from uUnder because they are a pair that is read as a pair.
      uWindow: { value: new THREE.Vector2(UNDERWATER.windowShut, UNDERWATER.windowOpen) },
      // x: the mirror sheen outside the window, y: how much downwelling light
      // that mirror carries. Both belong to the underside's mirror and neither
      // is read without the other being relevant.
      uTir: { value: new THREE.Vector2(UNDERWATER.tir, UNDERWATER.tirLit) },
      // x: how far you can see into the surface at its clearest. y: the SINE of
      // clarityAngle, which is what the shader compares against -- for a unit
      // view ray, -V.y IS the sine of the angle below the horizontal, so the
      // conversion belongs here and the shader gets to be one smoothstep.
      uClarity: { value: new THREE.Vector2(WATER.clarity, Math.sin((WATER.clarityAngle * Math.PI) / 180)) },
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      // THE TWO CUBE CAPTURES, COMPILED IN OR OUT. On, the surface reflects the
      // world: the sky probe's aurora and stars, and the world probe's trees,
      // bank and buildings. Off, it reflects the sky FUNCTION and nothing else
      // -- the analytic dome, the horizon map's ridge line, the glitter -- which
      // is a lake that is still lit correctly for the hour and still hides
      // behind mountains, but has no idea there is a forest on the far shore.
      //
      // A DEFINE AND NOT A UNIFORM, because the whole saving is the three
      // samplerCube fetches per water pixel that a zero multiply would still
      // pay for. See setCubeReflections for the cost of flipping it.
      defines: { WATER_CUBES: '' },
      // SEE-THROUGH ONLY IF WATER.clarity ASKS FOR IT, and at 0 this is the
      // opaque material it has always been -- same pass, same sort, same cost.
      //
      // What `transparent` buys is the destination: blending is the one way a
      // fragment can read the frame that has already been drawn, and crucially
      // the ONE way that survives WebXR, because the blend unit runs per-eye
      // inside the layer. Anything built on sampling the framebuffer instead --
      // refraction, screen-space anything -- exists on the desktop canvas and is
      // missing in the headset, which is why this file has no such thing in it.
      //
      // depthWrite STAYS ON, which is unusual for a transparent material and is
      // deliberate. This is not a cloud of particles, it is a sheet: exactly one
      // water fragment normally covers any given pixel, and the ordering problem
      // transparency usually brings does not arise. Keeping the depth write also
      // keeps everything drawn after it -- the aurora, the stars, the markers --
      // occluded by the lake exactly as they were before this knob existed.
      transparent: WATER.clarity > 0,
      depthWrite: true,
      fog: true,
      // DOUBLE-SIDED, so that the surface exists when you are under it. The
      // default FrontSide culls back-facing triangles before they are shaded,
      // and a lake plane seen from below is nothing but back-facing triangles
      // -- you would swim up and see straight through to the sky, with the
      // surface simply absent.
      //
      // It costs approximately nothing, and it is worth saying why rather than
      // trusting that it does. Culling only saves work when there is something
      // to cull, and a flat lake seen from above presents no back faces at all
      // -- the cull stage was rejecting zero triangles. The bill for turning it
      // off is therefore zero triangles' worth of fragment shading, plus the
      // rivers, where a channel dipping steeply away from the eye currently
      // drops a triangle and leaves a hole. Those come back, which is a fix.
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        #include <fog_pars_vertex>
        void main() {
          vWorldPos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorldPos;
        uniform vec3 uTint;
        uniform float uMirrorDown;
        uniform vec3 uSilTint;
        uniform vec3 uReflTint;
        uniform vec2 uDetail;
        uniform vec2 uGlitter;
        uniform vec2 uGlint;
        uniform vec2 uSharp;
        #ifdef WATER_CUBES
          uniform samplerCube uProbe;
          uniform samplerCube uWorldA;
          uniform samplerCube uWorldB;
          uniform float uWorldFade;
          uniform float uWorldMix;
          uniform float uProbeGain;
        #endif
        uniform float uSubmerged;
        uniform vec3 uMurk;
        uniform vec3 uUnder;
        uniform vec2 uWindow;
        uniform vec2 uTir;
        uniform vec2 uClarity;
        ${SKY_GLSL}
        ${SAMPLE_GLSL}
        ${WAVE_GLSL}
        #include <fog_pars_fragment>

        #ifdef USE_FOG
          // One decision, two callers: one fades toward the sky, the other
          // toward the murk, but HOW MUCH they fade is this expression and
          // lives in one place.
          float waterFogAmt() {
            #ifdef FOG_EXP2
              return 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
            #else
              return smoothstep( fogNear, fogFar, vFogDepth );
            #endif
          }
        #endif

        // THE LAND ALONG A RAY, as an rgb and a coverage, from two sources that
        // answer different halves of the question.
        //
        // wlBlocked is the terrain horizon map: 16 azimuths of "how high does
        // the ground rise this way", baked for terrain shadows and already paid
        // for. It reaches to the far mountains and it knows nothing whatever
        // about trees, because a spruce is not terrain.
        //
        // uWorld is a 128 px cube capture of the actual scene taken from just
        // above the water -- trees, rocks, buildings, bank and all. Its alpha is
        // the payload as much as its colour: the target clears to transparent
        // black, so alpha is 1 where geometry covered the texel, 0 where the ray
        // went out to sky, and a leaf's own alpha at the soft edge of a card.
        //
        // MAX rather than a sum or a mix: both answer the same yes/no question
        // and neither is a fraction of the other. A sum double-counts a tree
        // standing on a ridge; a mix lets the capture's zero ARGUE AWAY a
        // mountain the horizon map is certain about, and with only 128 pixels a
        // far ridge occupies very few of them.
        //
        // Colour comes from the capture where it has one and falls back to
        // uSilTint, so a distant peak the cube resolves poorly still reads as
        // land and the near bank reads as itself.
        //
        // THE CROSS-FADE lives here, the one place both faces of the surface ask
        // their question, so top and underside cannot end up mid-fade by
        // different amounts. Both ends are branched out rather than mixed
        // unconditionally: uWorldFade is a UNIFORM, so every fragment takes the
        // same side and the warp never diverges. That saves a second cube fetch
        // per water pixel for the several seconds between fades, and keeps
        // texture fetches out of non-uniform flow, where derivatives are
        // undefined -- moot with no mipmaps here, but worth the habit.
        //
        // Alpha is mixed with the colour, which is what makes a treeline appear
        // by growing solid rather than sliding in as a hard edge.
        //
        // WITHOUT THE CAPTURE it is the horizon map alone, which is the half of
        // the answer that costs nothing extra: the ridge is still there, still
        // in silhouette, and only the trees standing on it go missing.
        vec4 worldSilhouette( vec3 dir ) {
          float ridge = wlBlocked( vWorldPos.xz, dir );
          #ifdef WATER_CUBES
            vec4 wc = uWorldFade <= 0.0 ? texture( uWorldA, dir )
                    : uWorldFade >= 1.0 ? texture( uWorldB, dir )
                    : mix( texture( uWorldA, dir ), texture( uWorldB, dir ), uWorldFade );
            float cover = clamp( wc.a * uWorldMix, 0.0, 1.0 );
            return vec4( mix( uSilTint, wc.rgb, cover ), max( ridge, cover ) );
          #else
            return vec4( uSilTint, ridge );
          #endif
        }

        // THE UNDERSIDE OF THE SURFACE, which is a different question from the
        // top and not merely the top seen backwards.
        //
        // Straight up you see the sky through the surface, wobbling; along the
        // horizontal you see none of it, because past the critical angle the
        // surface stops transmitting and starts mirroring. With no screen-space
        // reflections to mirror WITH, that fade lands on the murk -- which is
        // what the water between you and it looks like anyway, so it is very
        // nearly right for free.
        //
        // A SMOOTHSTEPPED SNELL WINDOW, not a Fresnel term and not the hard cone
        // the physics has: a crisp edge inside a rippling surface crawls. Soft
        // is not the same as CLOSED, though -- a squared cosine is down to 0.44
        // at 48 degrees where the real window is still wide open, and near zero
        // across the band you look through from a metre or two under, which
        // reads as a flat blue plane. The edges are knobs either side of the
        // real 48.6 degrees; see UNDERWATER.windowOpen.
        vec3 underside( vec3 V, vec3 N ) {
          // The waves bend where you are looking. N is the surface's own
          // normal, so ( N - up ) is its TILT -- zero on flat water, and
          // roughly horizontal otherwise, which is the direction the wobble
          // wants to push in. Nearly free: the caller already has N.
          vec3 tilt = N - vec3( 0.0, 1.0, 0.0 );
          vec3 dir = normalize( V + tilt * uUnder.y );

          // A steep enough facet aims the look back DOWN through the surface,
          // which has no meaning. Folded up rather than clamped, for the same
          // reason the reflection above is folded rather than clamped: clamping
          // piles every such facet onto the horizontal at once and draws a
          // bright seam there.
          if ( dir.y < 0.0 ) dir.y = -dir.y;

          // 0.0: no hard sun or moon disc, for the top face's reason -- a disc
          // sampled through a rippling normal lands somewhere different every
          // pixel, which is static rather than glitter -- and because a disc
          // seen from below would be the sharpest thing in a view whose point
          // is that you cannot see well.
          //
          vec3 sky = skyRadiance( dir, 0.0 );

          // THE WORLD BEHIND THE SURFACE, from the SAME call the top face
          // makes, so the two sides of one surface cannot disagree about where
          // the land is. Bank, trees and ridge come through Snell's window,
          // wobbling with the waves because they are looked up through the same
          // bent direction as the sky.
          vec4 land = worldSilhouette( dir );
          float blocked = land.a;
          sky = mix( sky, land.rgb, blocked );

          // The aurora and the stars come down through the surface too, and
          // through the same distorted direction, so they wobble with the sky
          // they sit in rather than sliding across it. Scaled by what the ridge
          // left unblocked, or the aurora shines through the mountain.
          #ifdef WATER_CUBES
            sky += texture( uProbe, dir ).rgb * ( uProbeGain * ( 1.0 - blocked ) );
          #endif

          // Snell's window: everything above the water, squeezed into a cone
          // around straight up, murk outside it.
          float window = smoothstep( uWindow.x, uWindow.y, clamp( V.y, 0.0, 1.0 ) );

          // How much of the sky survives the trip down through the surface.
          // Named because it is now wanted twice -- once as the window itself,
          // and once as the light that falls on the water the mirror below is
          // made of.
          vec3 through = sky * uUnder.x;

          // OUTSIDE the window, where the surface is a mirror.
          //
          // Past the critical angle the surface is totally internally
          // reflecting, so what is there is the underwater world bounced back.
          // Two things about that world:
          //
          // It RIPPLES: how much each facet leans into the look, (N.xz . V.xz),
          // stepped and used to lighten. Wave tilts are ~0.1 so it is scaled
          // hard, and it falls off as the view tips up, which is where the
          // window takes over anyway.
          //
          // And it is LIT. Painted flat uMurk the ceiling is exactly the colour
          // of the water in front of it and disappears into its own medium;
          // uTir.y of the downwelling light puts it back -- silver at noon,
          // near-black at three in the morning, for a mix and a multiply.
          float lean = clamp( 0.5 + dot( N.xz, V.xz ) * 6.0, 0.0, 1.0 );
          vec3 sheen = mix( uMurk, through, uTir.y ) * mix( 1.0, uTir.x, lean );

          // uUnder.z of that sheen survives even at the window's clearest, so
          // what you look through still reads as a surface rather than a hole
          // punched to the sky. The sheen and not raw murk: the veil has to be
          // made of the same stuff as the mirror around it or the boundary
          // between them draws itself.
          return mix( sheen, mix( through, sheen, uUnder.z ), window );
        }

        // Sun and moon glitter, and it is a THRESHOLD rather than a falloff.
        //
        // pow( d, sharp ) is the statistical answer -- the average over all the
        // facets in one pixel -- which is right for water too far to resolve a
        // wavelet and wrong at your feet, where a facet either points at the
        // light or it does not and what you see is crisp specks of blown white
        // in dark water.
        //
        // So the threshold rides 'near': hard up close, relaxing to the smooth
        // lobe at range. The other way round turns every distant pixel into a
        // coin flip as the head moves, which is the specular aliasing the whole
        // distance-fade machinery exists to avoid. Above the threshold the value
        // is 1.0 and every gain is over 1, so the core clips to white and only
        // each speck's rim keeps the tint of the body that lit it.
        float glint( float d, float sharp, float near ) {
          float lobe = pow( d, sharp );
          return mix( lobe, smoothstep( uGlint.x - uGlint.y, uGlint.x + uGlint.y, lobe ), near );
        }

        void main() {
          vec3 toEye = cameraPosition - vWorldPos;
          float dist = length( toEye );
          vec3 V = -toEye / dist;

          // Two fades, both driven by distance, and they are the same idea
          // applied twice: a pixel covering many wavelengths cannot resolve the
          // individual waves, so the honest answer is the AVERAGE normal (flat)
          // with a WIDER highlight (the lobe those waves would have swept).
          // Fading one without the other gives either a fizzing mess or a dead
          // mirror; doing both is what makes distance read as calm.
          float far = 1.0 - smoothstep( uDetail.y, uDetail.y * 6.0, dist );
          float near = ( 1.0 - smoothstep( uDetail.x, uDetail.y, dist ) ) * far;

          vec3 N = waveNormal( vWorldPos.xz, near, far );

          // SEEN FROM UNDERNEATH. gl_FrontFacing makes this one material rather
          // than two -- same meshes, same draw calls, same uniforms, with the
          // side decided per fragment. uSubmerged is in the test too, because a
          // back face is also what you get looking up at a lake from inside a
          // cave, where the ordinary answer is still right.
          //
          // An early return, not an else-branch: the underside shares the wave
          // normal and nothing after it.
          if ( uSubmerged > 0.5 && ! gl_FrontFacing ) {
            vec3 ceiling = underside( V, N );

            // THE SAME MURK FADE THE BED TAKES, from the same expression, so the
            // rim of the ceiling and the bank it meets are lost at one distance
            // and the seam between them cannot be seen. Exp2 in distance, so the
            // metre or two straight overhead is untouched -- under 4% murk at
            // 2 m against 20 m visibility -- and what fades is the far end,
            // which is seen through twenty metres of water like anything else
            // that far off. See UNDERWATER for why the near ceiling stays lit
            // rather than being murk already.
            #ifdef USE_FOG
              ceiling = mix( ceiling, uMurk, waterFogAmt() );
            #endif

            // Alpha 1 whatever WATER.clarity says. Seen from below this is the
            // ceiling of the world -- there is no bed behind it to show through,
            // only scene.background, and blending against that punches a hole to
            // the clear colour.
            gl_FragColor = vec4( ceiling, 1.0 );
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            return;
          }

          vec3 R = reflect( V, N );

          // A steep enough facet points the reflection into the ground. Fold it
          // back up rather than clamping: clamping piles every such facet onto
          // the horizon direction at once and draws a bright seam along it.
          // Negating one component of a unit vector leaves it a unit vector.
          if ( R.y < 0.0 ) R.y = -R.y;

          // 0.0: no hard sun or moon disc in the reflection. A 1.1 degree disc
          // sampled through a rippled normal lands on a different answer every
          // pixel -- that is static, not glitter. The broadened highlight below
          // is what replaces it. See sky-glsl.js.
          vec3 refl = skyRadiance( R, 0.0 );

          // ...and it comes back dimmer and bluer than it went in. A mirror
          // that returns exactly what it reflects reads as a hole cut through
          // to a second sky rather than as a surface; this is the term that
          // says there is something there. Physically it is the light the
          // surface transmits instead of bouncing, and water takes red first.
          //
          // Applied to the sky only, not to the glitter added below: the
          // glitter has its own gains, and folding this into them would mean
          // two knobs fighting over one number.
          refl *= uReflTint;

          // The mountains. The horizon map already knows, for every point in the
          // world and 16 compass directions, how high the ground rises -- it was
          // baked for terrain shadows (§8) and this is the same question asked
          // along the reflected ray instead of along the sun's. So the sky
          // reflection cannot look through a ridge, at no cost beyond the two
          // texture reads the terrain was already paying.
          //
          // A POINT sample -- the skyline from this patch of water, not from
          // where the ray crosses the ridge -- right for a mountain kilometres
          // off, approximate for a bank a few metres away, and soft-edged at
          // sixteen azimuths. Both are the intended lo-fi.
          //
          // The horizon map structurally cannot hold TREES, being baked from
          // terrain; worldSilhouette combines the two.
          vec4 land = worldSilhouette( R );
          float blocked = land.a;

          // Declared next to what it derives from, and above BOTH its uses --
          // the probe and the glitter. GLSL wants declaration first, and a
          // ShaderMaterial that fails to compile does not draw a dimmer lake, it
          // draws nothing at all.
          float lit = 1.0 - blocked;

          // Where there is land, the reflection is that land. The fallback
          // colour uSilTint is arrived at whole on the CPU once a frame (see
          // syncShading), NOT derived here from the horizon's luminance: the sky
          // at the horizon is the brightest part of the sky, and a fraction of
          // it is not the same quantity as a shadowed hillside.
          refl = mix( refl, land.rgb, blocked );

          // The aurora and the stars, which no function can answer -- both are
          // meshes, so they are captured instead (sky-probe.js) and ADDED here.
          // Added, not mixed, because that is exactly how they are composited
          // into the sky itself: both draw additively over the dome, so the
          // reflected version agrees with the real one by construction rather
          // than by being tuned to match it.
          //
          // After the silhouette and scaled by the lit term, so a ridge hides the
          // aurora's reflection the same way it hides the aurora. Tinted like
          // everything else, because it loses the same light on the way back
          // out of the surface as the sky behind it does.
          #ifdef WATER_CUBES
            refl += texture( uProbe, R ).rgb * ( uProbeGain * lit ) * uReflTint;
          #endif

          // The glitter path. Broadening the lobe with distance is the other
          // half of the anti-aliasing above; multiplying by (1 - blocked) means
          // a mountain hides the moon's reflection the same way it hides the
          // moon.
          float sharp = mix( uSharp.x, uSharp.y, near * near );
          float sd = max( dot( R, uSunDir ), 0.0 );
          float md = max( dot( R, uMoonDir ), 0.0 );
          refl += vec3( 1.0, 0.94, 0.82 ) * ( glint( sd, sharp, near ) * uGlitter.x * uSunFade * lit );
          refl += vec3( 0.86, 0.91, 1.0 ) * ( glint( md, sharp, near ) * uGlitter.y * uMoon.y * lit );

          // Fresnel. Straight down you see some of the body of the water;
          // edge-on you see nothing but sky. This is the term that makes a flat
          // plane read as a surface rather than as a painted shape, and it is
          // why the far end of a lake is always brighter than the near end.
          float f = pow( 1.0 - clamp( dot( -V, N ), 0.0, 1.0 ), 5.0 );
          float mirror = mix( uMirrorDown, 1.0, f );

          // The body is occluded too, and this is what makes the silhouette
          // read as dark. uTint is what comes back OUT of the water, and the
          // light that went in came from the same piece of sky the mountain
          // stands in front of. Without this the (1 - mirror) share of uTint
          // survives at every angle and sets a floor no ridge can get under --
          // at noon three times the darkest terrain on screen, which is the
          // "shadowed water is lighter than black rock" bug. With both sides
          // taken to uSilTint a fully blocked patch composites to uSilTint
          // whatever the Fresnel does, keeping syncShading's promise.
          vec3 body = mix( uTint, land.rgb, blocked );

          vec3 color = mix( body, refl, mirror );

          // FOG, AND THE WATER IS EXEMPT FROM THE NIGHT RULE.
          //
          // Everything else fades toward scene.fog, whose colour is pulled well
          // below the sky's after dark to hide the far terrain the moon cannot
          // light. Water must not obey that: a distant lake is seen at a grazing
          // angle where Fresnel is essentially 1, so it is a near-perfect mirror
          // of the sky just above the horizon -- which is why a lake at night
          // reads BRIGHTER than the land, not darker.
          //
          // So the distance term stays, air still softening contrast over
          // kilometres, but it fades toward the sky along the HORIZONTAL part of
          // the view ray. At full distance a water pixel becomes exactly
          // skyRadiance at the horizon, which is what the dome behind it draws,
          // so the two meet with no seam -- for one more call to a function this
          // shader already has.
          //
          // Done in LINEAR, before output space, which is the opposite of
          // three's order (three fogs afterwards because fogColor is authored in
          // output space). The sky value here is linear and the dome does the
          // same thing in the same order.
          //
          // THE EXEMPTION IS ITSELF EXEMPT WHEN SHE IS UNDER: all of the above
          // holds only while the air between her and the lake is air. A second
          // lake seen across twenty metres of lake water is not brighter than
          // the water in front of it, it is gone. Left fading to horizon sky, a
          // top face across the lake reads as a lit hole in the murk.
          #ifdef USE_FOG
            vec2 flatV = V.xz;
            float flatLen = max( length( flatV ), 1e-4 );
            vec3 horizonDir = vec3( flatV.x / flatLen, 0.0, flatV.y / flatLen );
            vec3 fogTarget = mix( skyRadiance( horizonDir, 0.0 ) * uReflTint, uMurk, uSubmerged );
            color = mix( color, fogTarget, waterFogAmt() );
          #endif

          // SEEING INTO IT. See WATER.clarity for what the knob means and what
          // it costs; this is the three lines that spend it.
          //
          // -V.y is the SINE of the angle below the horizontal, V being a unit
          // vector, so this is "am I looking down at least clarityAngle
          // degrees". Read off the view ray, NOT the wave normal: a per-facet
          // test opens and shuts the window with every ripple. Not Fresnel
          // either, which is the wrong shape -- pow(x,5) is still 0.88 at twenty
          // degrees. near is the ripple distance ramp, already computed, so
          // the feature costs a smoothstep, a multiply and a divide.
          //
          // THE DIVIDE keeps the surface's own light intact. Blending gives back
          // src*a + dst*(1-a), so an alpha of 0.6 would dim the reflection 40%
          // as well as letting the bed through -- the lake going dark exactly
          // where it went clear. Pre-dividing leaves the full reflection PLUS
          // (1-a) of what was behind. Alpha cannot approach zero, its floor
          // being 1 - clarity, so there is no blowup to guard.
          //
          // It compensates MOST of it: the divide is in linear and the blend
          // happens after the colorspace conversion, so the hardware mixes
          // sRGB-encoded numbers. True of every transparent material on the web.
          float alpha = 1.0;
          if ( uClarity.x > 0.0 ) {
            float down = smoothstep( uClarity.y, 1.0, -V.y );
            alpha = 1.0 - uClarity.x * down * near;
            color /= alpha;
          }

          gl_FragColor = vec4( color, alpha );

          // tonemapping is a no-op today -- the renderer sets none -- and is
          // here so that turning it on does not leave the water as the one
          // surface in the world that ignored it.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    })

    this.lakes = new THREE.Group()
    this.lakes.name = 'lakes'
    this.group.add(this.lakes)
    this.bodies = 0
    this.triangles = 0
  }

  /** Once per frame. `elapsed` is seconds of real time; the waves are the one
   *  thing here that runs on the wall clock rather than on the world clock. */
  update(elapsed, hemi) {
    this.uniforms.uTime.value = elapsed
    // Pulled rather than pushed: the probe owns the schedule and has no business
    // knowing a water material exists. One frame stale, because this runs before
    // the probe does -- which against a one-second fade is 1.4% of it.
    this.uniforms.uWorldFade.value = this.world.blend
    this.syncShading(hemi)
  }

  /**
   * Which side of the surface her head is on. Two things change in the shader:
   * back faces stop being ignored and start being drawn as the underside, and
   * the distance fade stops aiming at the horizon sky and starts aiming at the
   * murk.
   *
   * Deliberately NOT worked out here. Whether she is under is a question about
   * where the water bodies are, which is WaterSurfaces' job and not the
   * material's, and this class has no access to and no business knowing about
   * either the player or the layer document. So the host decides and tells it.
   */
  setSubmerged(on) {
    this.uniforms.uSubmerged.value = on ? 1 : 0
  }

  /**
   * Whether the surface reflects the two cube captures or only the sky
   * function. See the `defines` block for what each half of that is.
   *
   * COSTS A SHADER COMPILE on the frame it changes, which is why it is a call
   * and not a per-frame write: `needsUpdate` throws away the cached program and
   * three builds a new one on the next draw. Fine for a button, wrong for
   * anything that could be asked every frame -- so it no-ops when the state is
   * already right rather than trusting every caller to check.
   *
   * The captures themselves are somebody else's schedule. Turning this on does
   * not start SkyProbe or WorldProbe updating; a host that stops running them
   * and leaves this on gets a lake reflecting a frozen world, which is the
   * pairing quest mode's `reflections` row keeps together.
   */
  setCubeReflections(on) {
    const want = !!on
    if (want === ('WATER_CUBES' in this.material.defines)) return
    if (want) this.material.defines.WATER_CUBES = ''
    else delete this.material.defines.WATER_CUBES
    this.material.needsUpdate = true
  }

  /**
   * The two colours the water carries that are not reflections, both of them a
   * function of the hour: the body tint, and how dark a mountain's silhouette
   * should be. The silhouette's target is exactly as dark as the darkest
   * terrain the world can currently draw.
   *
   * WHY THIS IS NOT A CONSTANT. The silhouette sits against real terrain -- the
   * far shore is usually visible directly above its own reflection -- and
   * terrain brightness moves through two orders of magnitude between noon and a
   * moonless midnight, so a fixed dark blue is either a hole in a daylit lake or
   * a glowing patch in a night one. A fraction of the sky's horizon luminance
   * does not fix it either: the horizon is the BRIGHTEST part of the sky, and a
   * shadowed hillside is not a scaled copy of it.
   *
   * SO IT IS COMPUTED RATHER THAN TUNED, from three's own Lambert maths, for one
   * reference fragment: the darkest terrain albedo, on a vertical face, in the
   * far field, directional light fully blocked. Every one of those is the dark
   * end of its range, making the result a floor rather than an average -- the
   * right side to be wrong on, since too bright is the failure being fixed.
   *
   * THE MATHS, checked against the three chunks in check-water-shader.mjs rather
   * than remembered:
   *
   *   irradiance = mix( groundColor, skyColor, w )   getHemisphereLightIrradiance
   *   indirect   = irradiance * albedo / PI          RE_IndirectDiffuse_Lambert
   *   indirect   = indirect * skyF + lift * skyF     the APPLY block in lighting.js
   *
   * skyColor and groundColor already carry the light's intensity (WebGLLights
   * multiplies it in on the JS side) and there is no AmbientLight in this scene,
   * so the hemisphere is the whole ambient term. skyF collapses to uFarLight.y:
   * an open face has occlusion 1, taking uSkyFloor out of it, and in the far
   * field the near-field envelope is 0.
   *
   * Twenty multiplies on three colours once a frame -- nothing worth throttling,
   * since a stale silhouette through a sunrise costs more in visible lag.
   */
  syncShading(hemi) {
    if (!hemi?.isHemisphereLight) throw new Error('Water.update needs the HemisphereLight')

    // THE BODY COLOUR, which is why this method is not only about silhouettes.
    // uTint is not a reflection but the light that got into the water and came
    // back out, and it reaches the eye through the (1 - mirror) side of the
    // Fresnel mix at EVERY angle. Left constant it is a floor nothing can get
    // under -- at full dark the silhouette term is exactly zero and the floor is
    // then 100% of what is left, which made a moonless lake read almost as
    // bright as a midday one. Scaling by how much sky there is makes the floor a
    // function of the hour, which is what a lake does.
    //
    // No night lift and no uFarLight, unlike the silhouette: lift is airglow on
    // a Lambert surface and this is not one, and uFarLight is a near-field
    // envelope, so as a global night factor it would make the water at your feet
    // a different colour from the water ten metres out.
    const amb = luminance(skyTmp.copy(hemi.color).multiplyScalar(hemi.intensity))
    this.uniforms.uTint.value.copy(this.tintDay).multiplyScalar(amb / this.ambNoon)

    shadeTmp.copy(hemi.groundColor).lerp(hemi.color, REF_HEMI_WEIGHT)
    shadeTmp.multiplyScalar(hemi.intensity)
    shadeTmp.multiply(TERRAIN_DARKEST).multiplyScalar(1 / Math.PI)

    const skyF = this.night.far.value.y
    const lift = this.night.lift.value
    shadeTmp.setRGB(
      shadeTmp.r * skyF + lift.r * skyF,
      shadeTmp.g * skyF + lift.g * skyF,
      shadeTmp.b * skyF + lift.b * skyF
    )

    // Only the DARKNESS is taken across. The hue stays the mountain's deep
    // blue: matching the terrain's colour as well would give a green-grey
    // silhouette in a blue lake, which is a reflection of a hillside rather
    // than the silhouette of one.
    this.uniforms.uSilTint.value.copy(this.silHue).multiplyScalar(luminance(shadeTmp))
  }

  /**
   * `lake` is Phase A's 0/1 mask, `filled` the flooded surface (so `filled[c]`
   * is that cell's water level -- every cell of one body carries the same
   * value, which is what lets runs be merged without re-labelling bodies).
   *
   * `ground` is THE SURFACE ACTUALLY BEING RENDERED, and it is a separate
   * argument for a reason. Phase A detects lakes on the CARVED surface, which
   * has breach channels cut into it, and priority-flood duly finds puddles at
   * the bottom of those trenches. Measured at 512^2: 392 of 18867 lake cells
   * had the rendered ground standing up to 43 m ABOVE their own water level,
   * because the trench that made them a depression does not exist on the mesh.
   * Water inside solid rock is invisible, so this fails silently -- which is
   * why it is a check rather than a comment.
   *
   * Today the mesher builds from raw heightAt, so callers pass `base`. When the
   * carve delta reaches the chunk workers they should pass `elev` instead and
   * this filter becomes a no-op, which is the correct end state rather than
   * something to remove.
   */
  setFromPhaseA({ lake, filled, ground, n, cell }) {
    this.clear()
    this.n = n
    this.cell = cell

    // Dilate by one cell, carrying the neighbour's level in. Done into a
    // separate level array rather than in place, or the dilation would feed on
    // itself and creep a lake across a whole valley one pass at a time.
    const size = n * n
    const level = new Float32Array(size)
    const wet = new Uint8Array(size)
    const real = new Uint8Array(size)
    this.mask = real
    this.maskLevel = level
    for (let c = 0; c < size; c++) {
      if (!lake[c]) continue
      if (ground[c] >= filled[c]) continue // a puddle in a breach trench; see above
      real[c] = 1
      wet[c] = 1
      level[c] = filled[c]
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i
        if (real[c]) continue
        let best = -Infinity
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di
            const nj = j + dj
            if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
            const d = nj * n + ni
            if (real[d] && filled[d] > best) best = filled[d]
          }
        }
        if (best > -Infinity) {
          wet[c] = 1
          level[c] = best
        }
      }
    }

    // Greedy horizontal runs: consecutive cells at the same level become one
    // quad. Lakes are blobs, so runs are long and this is worth roughly an
    // order of magnitude in triangles over a quad per cell.
    const tiles = new Map()
    for (let j = 0; j < n; j++) {
      let i = 0
      while (i < n) {
        const c = j * n + i
        if (!wet[c]) {
          i++
          continue
        }
        const y = level[c]
        let e = i + 1
        // A run also stops at a tile boundary, so every quad belongs to exactly
        // one tile and tiles stay independently cullable.
        const tileEnd = (Math.floor(i / TILE) + 1) * TILE
        while (e < n && e < tileEnd && wet[j * n + e] && level[j * n + e] === y) e++
        const key = `${Math.floor(i / TILE)},${Math.floor(j / TILE)}`
        let t = tiles.get(key)
        if (!t) {
          t = []
          tiles.set(key, t)
        }
        t.push(i, e, j, y)
        i = e
      }
    }

    const seen = new Set()
    for (const [key, runs] of tiles) {
      const quads = runs.length / 4
      const pos = new Float32Array(quads * 4 * 3)
      const idx = new Uint32Array(quads * 6)
      for (let q = 0; q < quads; q++) {
        const i0 = runs[q * 4]
        const i1 = runs[q * 4 + 1]
        const j = runs[q * 4 + 2]
        const y = runs[q * 4 + 3]
        // Cell CENTRES are the sim grid's convention, so a run covering cells
        // i0..i1-1 spans from half a cell before i0 to half a cell before i1.
        const x0 = -WORLD_HALF + i0 * cell
        const x1 = -WORLD_HALF + i1 * cell
        const z0 = -WORLD_HALF + j * cell
        const z1 = z0 + cell
        const v = q * 12
        pos[v] = x0; pos[v + 1] = y; pos[v + 2] = z0
        pos[v + 3] = x1; pos[v + 4] = y; pos[v + 5] = z0
        pos[v + 6] = x1; pos[v + 7] = y; pos[v + 8] = z1
        pos[v + 9] = x0; pos[v + 10] = y; pos[v + 11] = z1
        const a = q * 4
        const o = q * 6
        idx[o] = a; idx[o + 1] = a + 2; idx[o + 2] = a + 1
        idx[o + 3] = a; idx[o + 4] = a + 3; idx[o + 5] = a + 2
        seen.add(y)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setIndex(new THREE.BufferAttribute(idx, 1))
      // Every surface is horizontal and upward, so the normals are known and
      // computeVertexNormals would only rediscover them slowly.
      const nrm = new Float32Array(quads * 4 * 3)
      for (let k = 1; k < nrm.length; k += 3) nrm[k] = 1
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, this.material)
      mesh.name = `water-${key}`
      this.lakes.add(mesh)
      this.triangles += quads * 2
    }
    this.bodies = seen.size
    return { tiles: tiles.size, triangles: this.triangles, levels: this.bodies }
  }

  clear() {
    for (const m of this.lakes.children) m.geometry.dispose()
    this.lakes.clear()
    this.bodies = 0
    this.triangles = 0
  }

  /**
   * The water surface above a point, or null on dry land. One array lookup, so
   * it is cheap enough for the scatter to ask about every candidate prop.
   *
   * Uses the UNDILATED mask. The dilation exists to bury the polygon edge under
   * the terrain, and treating that ring as wet would strip a 16 m band of trees
   * off every shoreline.
   */
  levelAt(x, z) {
    if (!this.mask) return null
    const i = Math.floor((x + WORLD_HALF) / this.cell)
    const j = Math.floor((z + WORLD_HALF) / this.cell)
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return null
    const c = j * this.n + i
    return this.mask[c] ? this.maskLevel[c] : null
  }
}
