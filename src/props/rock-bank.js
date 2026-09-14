import { buildRock, ROCK_TIERS, ROCK_DEFAULTS } from './rock.js'
import { bakeImpostor, bakeImpostorPlate, BAKE_ROCK_BOUNCE } from './impostor.js'
import { LAYER, ROCK_TILE_MEAN } from '../textures.js'

// ---------------------------------------------------------------------------
// The shipping rock bank: A BOULDER AND A CAP. Two shapes, the tints they wear,
// and the baked geometry for each of their tiers, the last of them the
// five-vertex T6 hull every rock is at range.
//
// TWO ASSETS, AND THE SECOND IS NOT A SECOND ROCK. There is still no variant
// table, no per-environment species and no site-tagged families: a stone
// underfoot, a boulder in the wood, a landmark on a crag and a block let into a
// cliff face are all THE SAME GEOMETRY at different sizes -- see
// v2/render/rocks.js, where every bed asks for a size in metres and divides it
// back through its shape's measured width.
//
// WHAT SEPARATES THE TWO IS WHICH WAY THEY MEET THE GROUND, and it is a
// difference no size or turn of the boulder can express. A BOULDER IS SUNK INTO
// a surface: closed on every side, so any of its faces may be turned downward
// and the burial decides how much of it is left. A CAP IS LAID ON one: open
// underneath, aligned to the surface normal rather than to gravity, and sealed
// by a skirt that plugs into the hill. That buys the two things the boulder
// cannot do -- stone that lies flush on a wall too steep to stand a rock on, and
// half the triangles, because a cap spends none on a floor no camera reaches.
//
// WHERE THE VARIETY COMES FROM, since two shapes is barely more than one. Four
// things, none of them a third mesh:
//
//   QUARTER TURNS, ON THE BOULDER. Every boulder instance is pre-rotated by a
//   whole number of right angles about x and then about z, sixteen combinations,
//   so the face that was the bed face is now a side and some other flat is down.
//   A different silhouette off the same triangles, and stable -- 45 degrees would
//   read as a rock leaning on the air. A CAP TAKES NONE OF IT: turn an
//   open-bottomed shell onto its side and the mouth faces the player. See
//   ROLL_STEPS and the `roll` flag in rocks.js.
//
//   SIZE. Two orders of magnitude of it, half a metre to twenty, weighted small.
//
//   TINT. Eight destination colours rolled per instance from the environment's
//   own palette, then pulled toward the ground the rock is standing on.
//
//   THE GROUND. Yaw, the lean onto the slope, a +/-15 degree jitter on top of it,
//   and a burial depth that runs from two fifths to nine tenths. A cap leans the
//   whole way onto the slope where a boulder leans part of it, which is the
//   difference between stone lying on a hillside and stone standing on one.
//
// Same policy as tree-bank.js and fern-bank.js: NO OFFLINE BAKE STEP. Built at
// construction, handed to whatever copies it into an arena, disposed.
// ---------------------------------------------------------------------------

// --- the environment palette ------------------------------------------------
//
// A TINT IS A DESTINATION, NOT A MULTIPLIER. Every hex below is the sRGB colour
// the tile should AVERAGE OUT TO once tinted; the multiplier that gets there is
// derived (TINT_GAIN) by dividing by the tile's measured mean.
//
// Multipliers only work against a tile graded pale and near-neutral.
// public/rocks/stone.png is a photograph of granite (mean 93/84/76, saturation
// 0.19): multiply THAT by 0x6e747c and the rock is mud, and since a multiply can
// only push a warm tile warmer, half the palette is unreachable. Dividing
// white-balances the photograph out of the way instead, and because
// the per-instance colour is FLOAT (see the fade-slot guards in
// material.js) a gain above 1.0 is storable and BRIGHTENS. Nothing here darkens
// the tile; the smallest gain is 1.39 and check-rocks.mjs asserts it.
//
// The ceiling on tint brightness is highlight clipping, not taste: the tile's
// 99th percentile sits at 2.0-2.3x its own mean per channel, so a gain past
// about 5.7 blows out more than a percent of its pixels. That is why there is no
// white marble and why 'frost grey' stops where it does. check-rocks.mjs holds
// the clipped fraction under 2%.

// ROCK_TILE_MEAN is the tile's own linear-space channel means, imported from
// textures.js because the cliff terrain divides by the same three numbers. Every
// gain is a ratio against them, so a new tile with stale means silently drifts
// the whole palette; check-rocks.mjs re-measures the shipped PNG and fails.

// sRGB, because that is how a colour picker thinks. What a rock of this tint
// averages out to on screen before lighting.
export const TINTS = [
  ['granite', 0x9c9a96, 'the neutral one. Mid grey, a hair warm, what most stone is'],
  ['pale granite', 0xb3b0a9, 'the same rock bleached by a few thousand years of sun'],
  ['basalt', 0x7a8089, 'cold grey-blue and the darkest in the list. Peaks, scree, ice-scoured rock'],
  ['slate', 0x8d959d, 'blue-grey, lighter and flatter than basalt. Bedding planes and cliff shelves'],
  ['sandstone', 0xb59873, 'warm buff. River bluffs, dry ground, the shelf on a south face'],
  ['ironstone', 0x96755c, 'rust-brown. The one that reads as iron in the rock rather than as dirt'],
  ['lichen', 0x8e9678, 'green-grey. A forest boulder that has not moved in a century'],
  ['frost grey', 0xa9aeb4, 'pale and cold, for above the snow line'],
]

/**
 * Linear-space per-channel multipliers, derived. This is what actually goes into
 * BatchedMesh.setColorAt -- the shader's `diffuseColor.rgb *= vColor` happens in
 * linear, so the conversion has to happen here rather than at the call site.
 */
export const TINT_GAIN = TINTS.map(([, hex]) => {
  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return [
    srgbToLinear(((hex >> 16) & 255) / 255) / ROCK_TILE_MEAN[0],
    srgbToLinear(((hex >> 8) & 255) / 255) / ROCK_TILE_MEAN[1],
    srgbToLinear((hex & 255) / 255) / ROCK_TILE_MEAN[2],
  ]
})

/**
 * The four places a rock can stand. Not a property of the shape any more -- one
 * boulder stands everywhere -- but still the axis the scatter varies DENSITY,
 * SIZE and COLOUR along, so the list lives here beside the palette that keys off
 * it. See `_envAt` and `envDensity` in v2/render/rocks.js.
 */
export const ENVIRONMENTS = ['river', 'forest', 'cliff', 'peak']

// WHICH TINTS AN ENVIRONMENT CYCLES THROUGH, and with one shape in the bank this
// is the bank's whole contribution to variety. The roll is uniform and the
// weighting is done by repeating a colour in the list -- easier to read and
// retune than a table of probabilities.
export const ENV_TINTS = {
  river: [0, 3, 1, 4, 0, 6, 3],
  forest: [0, 6, 5, 1, 0, 4, 6, 2],
  cliff: [0, 4, 3, 5, 1, 2, 0, 6],
  peak: [2, 3, 7, 0, 2, 1, 7],
}

// --- the boulder ------------------------------------------------------------
//
// THE ONE SHAPE, AND IT IS A SEED RATHER THAN A PARAMETER SET. Every dial is at
// ROCK_DEFAULTS -- which is what /gen-rock opens on -- and the whole authored
// content of the world's rock is the number below, picked off the bench's reroll
// button. The generator's defaults are the shape; the seed chose which draw of it.
//
// THE SEED IS NOT THE WORLD SEED. rocks.js builds the bank without one on
// purpose: placement is world-seeded and must move from world to world, but the
// asset is art direction and must not. A rock signed off on the bench has to be
// the rock that ships in every world, and a bank keyed off SEED means nobody has
// ever seen the rock they are looking at before.
//
// WHAT THE SHAPE STILL HAS TO EARN, since one rock is every rock:
//
//   NO TAPER AND NO SHARDS, both off in the defaults. A taper is a spire, and a
//   spire scattered by the thousand is a field of fangs; a second mass is a
//   signature, and a signature repeated across a hillside is the one thing the
//   eye picks up instantly.
//
//   NEAR-EQUIDIMENSIONAL is what makes the QUARTER TURNS work -- a slab turned on
//   its side is a wall and a column turned on its side is a log, and either gives
//   the trick away. This draw measures 2.00 x 1.44 x 1.16 m, so it is a blunt
//   block rather than a cube: two of its three axes stand about as tall as the
//   rock is wide and only the long one, stood up, reads as a tipped slab -- which
//   rocks.js beds three times as deep for exactly that reason (SINK_TALL). It is
//   also what keeps `rockLodSize` (the longest axis) close to the width every bed
//   sizes through, so "three metres" means three metres whichever way the
//   instance landed.
//
//   CLOSED, whatever `sit` is. The shape is a displaced icosphere and its
//   underside is a real surface, which is what lets an instance be turned onto
//   any of its faces without opening a hole in itself, and why there is no
//   `openBottom` in the generator any more.
//
// `size` IS THE SIZE IT IS BUILT AT, NOT THE SIZE IT SHIPS AT. Every bed in
// rocks.js names a range in METRES and divides it back through `measured.width`,
// so ROCK_DEFAULTS' 2 m cancels out of every placement and only sets the units
// the geometry is measured in. `texRepeat` is likewise a count ACROSS the rock
// rather than per metre (rock.js, point 3), so the stone grain holds at every size.
export const BOULDER = {
  seed: 44555,
}

/**
 * THE SECOND SHAPE, and it is a shape rather than a rock: an open-bottomed shell
 * meant to be LAID ON a surface, where the boulder is meant to be SUNK IN one.
 *
 * `sit` 0.6 keeps the top two fifths of the lump and rock.js drops the disc the
 * cut leaves behind, so a cap is 158 triangles against the boulder's 320 at the
 * same tier -- it spends nothing on a floor no camera can reach. `foot` 0 because
 * the flare exists to stop a tapered rock looking balanced on a point and a cap
 * has no point to balance on.
 *
 * `squash` 0.48 WITH `lumps` 0.28 AT `lumpFreq` 3.7 IS THE FACADE PLATE, and the
 * three move together. Squash alone flattens the dome to 0.16 of its own width
 * -- what a plate of a wall is -- but a flat dome off the default 0.2 lumps at
 * 1.6 is an EGG: one smooth swell with a silhouette that repeats visibly the
 * moment two of them lie side by side, which is what a face carpeted in them
 * looked like. More than double the lump frequency puts three or four swells
 * across the plate instead of one, and the extra amplitude is what keeps them
 * legible after the squash has divided their vertical component down. Chosen on
 * /gen-rock at this seed; every other dial is ROCK_DEFAULTS.
 *
 * `skirt` 1 IS WHAT MAKES IT PLACEABLE. The rim descends a full rock-height
 * below the bed plane, so the hole cannot clear the dirt on any slope a cap
 * would be laid on. Free -- the curtain faces are the ones that were already
 * holding the disc's edge. THE SQUASH SPENDS THAT BUDGET: a rock-height is now
 * 0.31 of the width where it was 0.44, so the curtain a given plate hangs is
 * three tenths shorter, and it is the fit probe in v2/render/rocks.js that has
 * to know it -- see `_fitFactor`, which sizes a plate against exactly this
 * depth.
 *
 * WHO PLACES IT: the `cliff slabs` and `bed caps` beds in
 * v2/render/rocks.js, which panel steep faces and carpet the floors of lakes and
 * rivers with it. Both align it to the surface normal and neither rolls it --
 * see the `roll` flag there for why an open shell may not be turned onto its
 * side.
 *
 * Pinned here rather than in gen-rock-main.js for BOULDER's reason: the bench
 * and the world have to photograph the same shape.
 */
export const CAP = {
  seed: 98821,
  sit: 0.6,
  foot: 0,
  squash: 0.48,
  lumps: 0.28,
  lumpFreq: 3.7,
  skirt: 1,
}

/** The buildRock options for the boulder -- at its own seed unless given another. */
export function rockParams(seed = BOULDER.seed) {
  return { ...ROCK_DEFAULTS, ...BOULDER, seed }
}

/** The same, for the cap. */
export function capParams(seed = CAP.seed) {
  return { ...ROCK_DEFAULTS, ...CAP, seed }
}

function geometryBytes(geo) {
  let n = geo.index ? geo.index.array.byteLength : 0
  for (const name of Object.keys(geo.attributes)) n += geo.attributes[name].array.byteLength
  return n
}

// ---------------------------------------------------------------------------
// THE PHOTOGRAPHS. Nothing draws them: the far band is the T6 hull, a mesh like
// the rest. `bakeRockImpostor` and what it leans on survive only because
// v2/main.js still calls it at boot and logs the rows; take the two out
// together, with LAYER.IMPOSTOR_ROCK and LAYER.IMPOSTOR_ROCK_CAP.
// ---------------------------------------------------------------------------

/**
 * The world extents the photograph is framed to: the larger horizontal extent,
 * because the bake camera stands at `widestAzimuth` and a narrower frame would
 * clip the silhouette that search went looking for.
 */
export function rockBakeFrame(measured) {
  if (!(measured.width > 0) || !(measured.height > 0)) {
    throw new Error(`rockBakeFrame: need a measured rock, got ${JSON.stringify(measured)}`)
  }
  return { width: Math.max(measured.width, measured.depth), height: measured.height }
}

/** The seed the photograph is taken at, fixed so the bank's own seed dial cannot move it. */
export const ROCK_CARD_SEED = 1978

/** The atlas layer each shape is photographed into, keyed by its bank name. */
export const ROCK_IMPOSTOR_LAYERS = {
  boulder: LAYER.IMPOSTOR_ROCK,
  cap: LAYER.IMPOSTOR_ROCK_CAP,
}

/**
 * The two shapes the bank builds, in the order they enter it: the buildRock
 * options for each, and for the photograph the atlas layer it lands in and
 * whether it is shot side-on ('spun') or from straight above ('plate').
 */
export const ROCK_SHAPES = [
  { name: 'boulder', params: rockParams, layer: ROCK_IMPOSTOR_LAYERS.boulder, card: 'spun' },
  { name: 'cap', params: capParams, layer: ROCK_IMPOSTOR_LAYERS.cap, card: 'plate' },
]

/**
 * Photograph every shape into its own atlas layer, in place, once
 * `loadImageLayers()` has resolved so the subjects wear LAYER.ROCK. Needs the
 * live renderer. Returns one bake row per shape, for the caller to log.
 */
export function bakeRockImpostor(renderer, texArray) {
  return ROCK_SHAPES.map(({ name, params, layer, card }) => {
    const geo = buildRock({ ...params(ROCK_CARD_SEED), tier: 0 })
    const measured = geo.userData.rock.measured
    // A plate is photographed down its own +Y, so there is no bearing to search
    // for and no widest one to find: a top-down ortho shot frames the whole plan
    // extent whatever way round the plate lies.
    const azimuth = card === 'plate' ? 0 : widestAzimuth(geo)
    const baked = card === 'plate'
      ? bakeImpostorPlate(renderer, geo, texArray, layer, {
        width: measured.width,
        depth: measured.depth,
        height: measured.height,
        bounce: BAKE_ROCK_BOUNCE,
      })
      : bakeImpostor(renderer, geo, texArray, layer, {
        ...rockBakeFrame(measured), azimuth, unlit: true,
      })
    geo.dispose()
    return { name, layer, card, azimuth, ...baked }
  })
}

/**
 * The compass bearing that sees the most of a rock, in radians, so the shot
 * fills the `rockBakeFrame` it is framed to. Half a turn is the whole search
 * space: width at bearing `a` equals width at `a + pi`.
 */
function widestAzimuth(geo, steps = 180) {
  const pos = geo.attributes.position.array
  let best = 0
  let bestWidth = -Infinity
  for (let s = 0; s < steps; s++) {
    const a = (s / steps) * Math.PI
    // Screen right for a camera at azimuth `a`, which is the axis the
    // silhouette's width is measured along.
    const rx = Math.cos(a)
    const rz = -Math.sin(a)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      const u = pos[i] * rx + pos[i + 2] * rz
      if (u < lo) lo = u
      if (u > hi) hi = u
    }
    if (hi - lo > bestWidth) {
      bestWidth = hi - lo
      best = a
    }
  }
  return best
}

/**
 * How many tiers a shape reports -- exactly ROCK_TIERS, the T6 hull last. One
 * number for both shapes: a bed indexes its tier table by band, and a cap that
 * reported a shorter ladder would need a second one.
 */
export const ROCK_BAND_COUNT = ROCK_TIERS.length

/**
 * Build the bank: every shape in ROCK_SHAPES at every tier.
 *
 * Returns `{ shapes, geometries, triangles, bytes }`.
 *
 *   `shapes` is keyed by name -- `shapes.boulder`, `shapes.cap` -- each
 *   `{ name, seed, measured, tiers }`, where `tiers` is ALWAYS ROCK_BAND_COUNT
 *   long so a band index is a straight lookup. A bed names the one it wants.
 *
 *   `geometries` is every geometry the bank made, in the order they should enter
 *   an arena. The caller owns them and MUST dispose them once every consumer holds
 *   its own copy -- a bed CLONES its shape's four into its PropArena, and the
 *   shell's BatchedMesh copies the vertices it is handed. A BED TAKES ONLY ITS OWN
 *   SHAPE'S FOUR, which is why the bank being two shapes costs the world one extra
 *   arena's worth of vertices rather than eight.
 *
 * `seed` DEFAULTS TO EACH SHAPE'S OWN and the world does not pass one -- see
 * BOULDER for why the assets are pinned while the scatter around them is not. The
 * argument survives for the bench and the gates, which need to see the generator
 * at more than one draw, and it overrides BOTH shapes' seeds together.
 */
export function buildRockBank({ seed = null } = {}) {
  const geometries = []
  const shapes = {}
  let triangles = 0
  let bytes = 0

  for (const spec of ROCK_SHAPES) {
    const params = seed === null ? spec.params() : spec.params(seed)
    const tiers = ROCK_TIERS.map((_, tier) => {
      const g = buildRock({ ...params, tier })
      geometries.push(g)
      triangles += g.userData.rock.triangles
      bytes += geometryBytes(g)
      return g
    })

    const measured = tiers[0].userData.rock.measured

    // `skirt` IN METRES, at the size the shape was measured at, because the one
    // consumer that needs it is doing arithmetic in metres. rock.js hangs the rim
    // `skirt * measured.height` below the bed plane and that product is the
    // ONLY thing that says how far a plate's ground may fall away before the
    // hole under it clears the dirt -- see `_fitFactor` in v2/render/rocks.js,
    // which sizes every panel against it. Reported rather than assumed there:
    // the dial lives here, and a cap re-authored flatter silently shortens the
    // curtain.
    shapes[spec.name] = {
      name: spec.name,
      seed: params.seed,
      measured,
      skirt: (params.skirt ?? 0) * measured.height,
      tiers,
    }
  }

  return { shapes, geometries, triangles, bytes }
}
