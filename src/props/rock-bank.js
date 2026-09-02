import { buildRock, ROCK_TIERS, ROCK_DEFAULTS } from './rock.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'
import { LAYER, ROCK_TILE_MEAN } from '../textures.js'

// ---------------------------------------------------------------------------
// The shipping rock bank: ONE BOULDER. One closed shape, the tints it wears, the
// baked geometry for each of its mesh tiers, and the billboard card that stands
// in for it past the last mesh band.
//
// THE WORLD HAS EXACTLY ONE ROCK ASSET AND THIS FILE IS IT. There is no variant
// table, no shape roster, no per-environment species, no site-tagged families and
// no open-bottomed cap. A stone underfoot, a boulder in the wood, a landmark on a
// crag and a block let into a cliff face are all THE SAME GEOMETRY at different
// sizes -- see v2/render/rocks.js, where every bed asks for a size in metres and
// divides it back through this shape's measured width.
//
// WHERE THE VARIETY COMES FROM, since that is the fair question about a world
// built from one rock. Four things, none of them a second mesh:
//
//   QUARTER TURNS. Every instance is pre-rotated by a whole number of right
//   angles about x and then about z, sixteen combinations, so the face that was
//   the bed face is now a side and some other flat is down. A different
//   silhouette off the same triangles, and stable -- 45 degrees would read as a
//   rock leaning on the air. See ROLL_STEPS in rocks.js.
//
//   SIZE. Two orders of magnitude of it, 0.25 m to 20 m, weighted small.
//
//   TINT. Eight destination colours rolled per instance from the environment's
//   own palette, then pulled toward the ground the rock is standing on.
//
//   THE GROUND. Yaw, the lean onto the slope, a +/-15 degree jitter on top of it,
//   and a burial depth that runs from a few percent to nine tenths.
//
// Same policy as tree-bank.js and fern-bank.js: NO OFFLINE BAKE STEP. Built at
// construction, handed to BatchedMesh.addGeometry(), disposed. The CARD tier is
// the one thing that arrives in two pieces -- quads at construction, pixels once
// the renderer exists. See THE CARD below.
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
// BatchedMesh's colour texture is FLOAT (see the fade-slot guards in
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

/** The buildRock options for the boulder -- at its own seed unless given another. */
export function rockParams(seed = BOULDER.seed) {
  return { ...ROCK_DEFAULTS, ...BOULDER, seed }
}

function geometryBytes(geo) {
  let n = geo.index ? geo.index.array.byteLength : 0
  for (const name of Object.keys(geo.attributes)) n += geo.attributes[name].array.byteLength
  return n
}

// ---------------------------------------------------------------------------
// THE CARD: what a rock is past the last mesh band.
//
// A FOURTH TIER, past the coarsest mesh. A card looks worse than a coarse solid
// -- a rock's whole read is the way its facets catch a moving light, and a
// photograph has no facets -- and that is not what decides. A coarse solid costs
// an instance, a matrix, a draw range and a scan slot exactly as a T320 does,
// and the outermost band of a scree slope holds tens of thousands of them. Two
// triangles that keep a grey lump on the hillside beat twenty that do, and both
// beat the hole culling leaves in a talus field.
//
// IT IS A BILLBOARD: ONE QUAD, SPUN IN EVERY DIRECTION. The pinned call is
// `buildImpostorCard(w, h, ROCK_IMPOSTOR_LAYER, 1, { upNormal: true, spherical:
// true })` and every argument is load-bearing. A rock is looked DOWN on as often
// as across, so rocks.js is the only bed whose material is built with
// `sphericalBillboard`; `spherical` here tells the card which spin it will meet,
// and the difference is the bounding sphere -- centred on the foot rather than
// around the vertices. Getting that wrong does not misdraw the card, it culls a
// card that is still on screen. One plane is normally the ILLEGAL row of
// buildImpostorCard's table, since a fixed single quad seen along its own plane
// covers no pixels; `upNormal` makes it legal, because a vertical normal is the
// mark material.js's billboardVertex tests before yawing a quad toward the eye.
// Spun, one plane never goes edge-on, and two triangles is the floor -- which a
// rock needs, its far band being the largest population in the world.
//
// `tri` IS DELIBERATELY NOT PASSED. A conifer can spend two corners of its
// photograph because a conifer IS a triangle and the dropped corners hold no
// needles. A rock silhouette is convex and nearly fills its own box in every
// direction, so every corner a triangle throws away is stone: `tri: 'down'` eats
// the foot, which is the one part a distant rock needs in order to read as
// sitting on the ground rather than floating, and `tri: 'up'` eats the crown.
//
// ONE PHOTOGRAPH, ONE ATLAS LAYER, and the objection that used to be raised
// against sharing one -- that a shared picture only lands undistorted on a shape
// with the subject's aspect -- died with the variant table. There is one subject
// and it is the thing being photographed, so the aspect matches by construction.
// LAYER.IMPOSTOR_ROCK is that layer.
//
// WHAT CANCELS. The card GEOMETRY is built when the bank is and the PIXELS
// cannot exist until there is a renderer, so the two halves can never check each
// other. Both go through `impostorCardExtents` and neither does the margin
// arithmetic itself (`bakeImpostor` applies it internally, which is why the bake
// is handed a frame and the quad the extents), so the transparent border cancels
// exactly.
//
// THE TWO FRAMES ARE DIFFERENT NUMBERS, deliberately. The PHOTOGRAPH is framed
// to the subject at its WIDEST (`rockBakeFrame`, at `widestAzimuth`), because a
// photograph that clips has thrown away silhouette it can never recover. The
// QUAD is sized to the MEAN silhouette (`rockCardFrame`), because a quad that
// spins is seen from every bearing -- sizing it to the widest view swelled a
// rock by up to 1.7x at the swap. Not a contradiction: the bake normalises the
// subject to its own frame, so the picture spans the quad's frame whatever that
// is, leaving a horizontal squeeze of `planMean / max(w, d)`. That squeeze is
// the only difference left between the card and the mesh it takes over from.
// ---------------------------------------------------------------------------

/**
 * The world extents the card QUAD is drawn at, from `userData.rock.measured`.
 *
 * WIDTH IS THE MEAN SILHOUETTE, not the box. A billboard spins to face the eye,
 * so its width is what the rock looks like from every bearing at once, and one
 * width makes the mesh-to-card swap free on average: the mean of the mesh's own
 * silhouette over the compass (`meanPlanWidth` in rock.js). The obvious
 * `max(width, depth)` measures well over the mesh silhouette -- a visible swell
 * at the swap. `rockBakeFrame` below is the OTHER framing and is deliberately
 * wider.
 */
export function rockCardFrame(measured) {
  if (!(measured.planMean > 0) || !(measured.height > 0)) {
    throw new Error(`rockCardFrame: need a measured rock, got ${JSON.stringify(measured)}`)
  }
  return { width: measured.planMean, height: measured.height }
}

/**
 * The world extents the PHOTOGRAPH is framed to, which is the widest the subject
 * can present.
 *
 * WIDTH IS THE LARGER HORIZONTAL EXTENT, not the one on the x axis, and not the
 * mean either. The bake camera is put at `widestAzimuth` precisely so the
 * silhouette it captures is the fullest one the rock has; framing that shot to
 * anything narrower than `max(width, depth)` would clip the very thing the
 * azimuth search went looking for.
 */
export function rockBakeFrame(measured) {
  if (!(measured.width > 0) || !(measured.height > 0)) {
    throw new Error(`rockBakeFrame: need a measured rock, got ${JSON.stringify(measured)}`)
  }
  return { width: Math.max(measured.width, measured.depth), height: measured.height }
}

/**
 * The seed the card photograph is taken at.
 *
 * A FIXED CONSTANT, not the bank's. `buildRockBank`'s seed is a dial someone may
 * turn, and the photograph must not move under the world when they do: the card
 * geometry is sized from the PLACED shape's measurement while the picture in it
 * comes from this seed, so a drifting subject would silently reproportion every
 * distant rock. Fixing it also means the bench and the world photograph the same
 * rock. Which seed is arbitrary.
 */
export const ROCK_CARD_SEED = 1978

/**
 * The atlas layer holding the boulder's photograph. One layer, because there is
 * one shape; the bake writes it and the card geometry reads it.
 */
export const ROCK_IMPOSTOR_LAYER = LAYER.IMPOSTOR_ROCK

/**
 * Photograph the boulder into its atlas layer, in place.
 *
 * Call ONCE, after `loadImageLayers()` has resolved -- the subject wears
 * LAYER.ROCK, and LAYER.ROCK is a PNG that arrives some hundreds of
 * milliseconds into the session. Bake before it lands and the card is a
 * photograph of an untextured lump. Until then the far band draws an empty
 * layer, which is fully transparent and so discarded by alphaTest, exactly as
 * the tree, fern and grass cards do.
 *
 * Photographed at the FINEST tier: the bake resolves to 128 px either way, so a
 * coarse subject would only donate its own faceting to a picture that is meant
 * to stand in for the fine one.
 *
 * Needs the live renderer, so it cannot live in `buildRockBank` -- that runs in
 * a constructor and in node. Returns the one bake row, for the caller to log.
 */
export function bakeRockImpostor(renderer, texArray) {
  const geo = buildRock({ ...rockParams(ROCK_CARD_SEED), tier: 0 })
  const frame = rockBakeFrame(geo.userData.rock.measured)
  const azimuth = widestAzimuth(geo)
  const baked = bakeImpostor(renderer, geo, texArray, ROCK_IMPOSTOR_LAYER, { ...frame, azimuth })
  geo.dispose()
  return { layer: ROCK_IMPOSTOR_LAYER, azimuth, ...baked }
}

/**
 * The compass bearing that sees the most of a rock, in radians.
 *
 * PHOTOGRAPH THE SUBJECT AT ITS LARGEST, NEVER FLAT-ON. The shot is framed to
 * `rockBakeFrame` = `max(width, depth)`, so a bake along the rock's SHORT axis
 * prints a narrow silhouette into a wide frame and every distant rock is drawn
 * with transparent margins down both sides -- nothing is misplaced, the far band
 * is just quietly smaller than the mesh it replaced.
 *
 * A hardcoded azimuth is luck, not a property: a shape can land several degrees
 * off its widest bearing and measure a quarter narrow at the wrong one, so a new
 * seed could print a card 26% narrow. Searching costs one pass over the
 * subject's vertices, once, at boot.
 *
 * Half a turn is the whole search space: width at bearing `a` equals width at
 * `a + pi`, the projection being onto a line.
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
 * The layers `createPropMaterial({ billboardLayers })` has to be told to spin,
 * exported the way tree-bank, mushroom-bank and grass-bank export theirs so the
 * bank stays the single place that knows which of its geometry is a billboard.
 *
 * A ROCK BATCH THAT DOES NOT PASS THIS IS BROKEN, not merely unspun. The card is
 * ONE plane, and material.js's billboardVertex needs BOTH conditions -- the
 * layer in `uBillboardLayers` and `normal.y` over CARD_UP_MARK -- before it turns
 * a quad. The normal is authored here and always passes; the layer list is the
 * caller's half. Miss it and every distant rock is a fixed single quad with a
 * vertical normal, which is the one row of buildImpostorCard's table where the
 * card VANISHES edge-on rather than just flattening.
 */
export function rockImpostorLayers() {
  return [ROCK_IMPOSTOR_LAYER]
}

/**
 * How many tiers the boulder reports. The last one is ALWAYS the card, so the
 * mesh ladder gets ROCK_BAND_COUNT - 1 of these -- exactly ROCK_TIERS.
 */
export const ROCK_BAND_COUNT = ROCK_TIERS.length + 1

/** How many of those bands are real meshes. The rest -- one -- is the card. */
export const ROCK_MESH_BAND_COUNT = ROCK_BAND_COUNT - 1

/**
 * Build the bank: the boulder at every tier, plus its card.
 *
 * Returns `{ shape, geometries, triangles, bytes }`.
 *
 *   `shape` is the one buildable rock: `{ seed, measured, tiers }`, where
 *   `tiers` is ALWAYS ROCK_BAND_COUNT long so a band index is a straight lookup.
 *
 *   `geometries` is every geometry the bank made, in the order they should enter
 *   the batch. The caller owns them and MUST dispose them once BatchedMesh has
 *   copied them into its arena -- and note that each BED builds its own batch, so
 *   one bank is copied into as many arenas as there are beds.
 *
 * THE CARD IS APPENDED LAST, so `tiers[ROCK_BAND_COUNT - 1]` is the card. Note
 * the two are different kinds of object: a mesh tier carries `userData.rock` and
 * the card carries `userData.impostor`, so anything walking the tier table has to
 * ask which it is holding rather than reaching straight for
 * `userData.rock.triangles`.
 *
 * `seed` DEFAULTS TO THE BOULDER'S OWN and the world does not pass one -- see
 * BOULDER for why the asset is pinned while the scatter around it is not. The
 * argument survives for the bench and the gates, which need to see the generator
 * at more than one draw. The CARD's picture never moves with it; see
 * ROCK_CARD_SEED.
 */
export function buildRockBank({ seed = BOULDER.seed } = {}) {
  const geometries = []
  let triangles = 0
  let bytes = 0

  const tiers = ROCK_TIERS.map((_, tier) => {
    const g = buildRock({ ...rockParams(seed), tier })
    geometries.push(g)
    triangles += g.userData.rock.triangles
    bytes += geometryBytes(g)
    return g
  })

  // ...and only then the card, so the last band is the card. Sized through
  // `rockCardFrame` + `impostorCardExtents` so it agrees with `bakeRockImpostor`
  // about the framing by construction -- see THE CARD.
  const measured = tiers[0].userData.rock.measured
  const ext = impostorCardExtents(rockCardFrame(measured))
  const card = buildImpostorCard(ext.width, ext.height, ROCK_IMPOSTOR_LAYER, 1, {
    upNormal: true,
    spherical: true,
  })
  geometries.push(card)
  triangles += card.userData.impostor.triangles
  bytes += geometryBytes(card)
  tiers.push(card)

  return { shape: { seed, measured, tiers }, geometries, triangles, bytes }
}
