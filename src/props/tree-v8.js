import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'
import { buildTree, crownProfile, TREE_DEFAULTS } from './tree.js'

// ---------------------------------------------------------------------------
// TREE v8 -- v6's stack of whorls, with each whorl broken into separate boughs.
//
// Read props/tree-v6.js's header first. The trunk, the stack, the spacing law,
// the pinned tip, the per-meridian bow and the baked occlusion are all v6's and
// are argued there. What follows is only what v8 does differently.
//
// A SKIRT BECOMES `boughs` BOUGHS. v6's whorl is one closed cone, so its only
// silhouette is the fray cut into its rim -- a scalloped circle, and from any
// distance a circle. v8 spends the same triangles on separate boughs radiating
// from the same point on the axis, at the same angle the cone's meridians ran
// at, with air between them. That air IS the difference: it is what lets you
// see the next whorl down through this one, and it is the reason v8 wears the
// SOLID mat at every tier where v6 needs a cut-out at LOD0. The silhouette here
// is modelled, not painted, so there is nothing for an alpha test to buy and
// nothing for it to alias at range.
//
// ONE BOUGH IS SEVEN VERTICES AND SIX TRIANGLES. Three run down the spine --
// butt on the axis, middle, tip -- and two hang off each side, drooping. That
// is the smallest thing that can be a bough rather than a leaf: the spine's
// three points let it bow and rise the way a v6 meridian does, and the two
// stations per side let the cloak sag deeper near the butt than at the tip
// instead of being one flat fin. The panels are what carry the mat.
//
// THE BOUGHS ARE NOT A DECOMPOSITION OF THE CONE. Every one draws its own
// azimuth off the even spacing (`boughSpread`), its own length (`boughVary`),
// its own bow, its own tilt, its own sideways kink at the middle joint
// (`boughCrook`) and a different half-width on each side. Nothing is shared
// around the whorl, so neighbouring cloaks CROSS -- which is wanted. A whorl of
// boughs that tiled its circle exactly would read as a cut cone again, and
// crossing cloaks are most of what makes the crown look grown.
//
// THE OCCLUSION IS v6's, ONE STATION OVER. `innerShade` darkens the butt of
// every bough, `shadeToTip` lets the top whorl off, and the middle joint takes
// a share set by how far it sits under the reach of the whorl above -- measured
// per bough, so a short bough under a wide whorl goes darker than a long one
// beside it. The tip is never shaded.
//
// ATTRIBUTES: `{ position, normal, uv, color }` on the foliage and buildTree's
// `{ position, normal, uvProj, texLayer }` on the trunk, as v6.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

// The one needle mat, and it is the OPAQUE one at every tier. See the header:
// a bough's outline is geometry, so the cut-out mat would only be paying an
// alpha test to erase pixels the silhouette already does not have.
export const V8_TILE = '/tmp/leaves/pine-mat-solid.png'

export const TREE_V8_DEFAULTS = {
  seed: 1,

  // --- size ---
  height: 9,           // metres, root to tip

  // --- trunk: v1's, passed straight through to buildTree ---
  trunkSides: 12,
  trunkLobe: 0.15,     // out-of-round, as a fraction of the radius
  trunkRings: 1,       // rings below the apex; more than 1 lets trunkBend curve
  trunkRadius: 0.026,  // base radius as a FRACTION of height
  trunkBend: 0.04,     // sideways offset of the top, as a fraction of height
  barkRepeat: 8,       // bark tiles UP the trunk this many times

  // --- roots: the flare at the foot, LOD0 only ---
  roots: 5,
  rootRise: 0.09,
  rootLength: 0.16,
  rootAngle: 0.7,
  rootDroop: 0.5,
  rootWidth: 1.1,

  // --- the stack ---
  skirts: 11,          // whorls up the trunk, `boughs` x 6 triangles each
  skirtBottom: 0.34,   // fraction of height the LOWEST whorl sits at. Higher
                       // than v6's, because a cloak hangs BELOW its own spine:
                       // at v6's 0.3 the lowest boughs reach into the soil on
                       // roughly a third of the seeds
  skirtTop: 1,         // and the highest. At 1 that whorl's butt IS the trunk
                       // tip, so the tree ends in needles and not in a spike
  skirtStagger: 0.25,  // how far a whorl may wander inside its own gap
  spacingByLength: 0.6, // how much of the gap above a whorl is set by how long
                       // that whorl's boughs are. 0 spaces them evenly
  crownRadius: 0.35,   // the WIDEST whorl's reach, as a fraction of height
  crownPeak: 0.05,     // where up the stack that widest whorl sits. 0 = cone
  crownFullness: 1.15, // falloff from the peak. <1 fuller, >1 pointier
  skirtMin: 0.10,      // smallest whorl as a fraction of the widest
  topGrow: 0.3,        // how much bigger the TOP whorl is than the profile asks
                       // for: it is pinned to the tip and cannot wander down to
                       // close the gap, and the profile makes it the shortest

  // --- one whorl's shape ---
  boughs: 8,           // boughs around a whorl, 6 triangles each. THE budget
                       // knob, with `skirts`
  skirtDrop: 0.8,      // how far a bough hangs, as a multiple of its own reach
  dropByHeight: 1.0,   // and how much further, in proportion, the whorls near
                       // the tip hang -- their boughs are short up there, so on
                       // skirtDrop alone the trunk shows between them
  skirtBow: 0.17,      // the middle joint's depth, off halfway by this much.
                       // Drawn PER BOUGH, which is what makes a whorl read as a
                       // handful of limbs rather than as one turned surface
  bowOutward: 0.35,    // what share of those draws come back NEGATIVE
  skirtLean: 0.09,     // radians a whorl's axis may tip off the trunk's
  skirtShift: 0,       // and how far its butt may slide off the axis

  // --- one bough ---
  boughVary: 0.29,     // per-bough shortening, as a fraction of the whorl's
                       // reach. The whole reason a whorl has an outline
  boughLift: 0.28,     // how far a SHORT bough rides back up, as a fraction of
                       // how much it came in -- one draw drives both, because a
                       // limb that stops short stops higher on the cone too
  boughSpread: 0.5,    // how far a bough slides AROUND off the even angle, as a
                       // fraction of the angular step. Evenly spaced limbs are
                       // most of what reads as machined
  boughTilt: 0.2,      // and how far it pitches up or down on top of the lift.
                       // Signed, unlike the lift
  midBend: 0.61,       // how much of the shortening the MIDDLE joint inherits.
                       // 0 pulls only the tip in and leaves the bough straight
  boughWidth: 0.45,    // half a cloak's width at its widest, as a fraction of
                       // the bough's own length. Past ~0.4 at 8 boughs the
                       // cloaks CROSS, which is the point -- see the header
  boughTaper: 0.55,    // and the outer station's width as a fraction of that,
                       // so a bough narrows to its tip instead of ending square
  boughDroop: 0.6,     // how far the cloak sags below the spine, as a fraction
                       // of its own half-width. A wider cloak sags further,
                       // which is why this is not a length
  boughCrook: 0.12,    // sideways kink at the middle joint, as a fraction of
                       // the bough's length. The spine is otherwise straight in
                       // plan and a whorl of straight spokes reads as a wheel

  // --- shading ---
  innerShade: 0,       // how dark every bough's BUTT is baked, as a multiple of
                       // the tip's brightness
  shadeToTip: 1.0,     // how much of that the TOP whorl is let off -- only the
                       // top one, its boughs being the only ones under open sky
  midShade: 0.8,       // how much of the butt's darkening a fully covered
                       // MIDDLE JOINT takes, measured per bough against the
                       // reach of the whorl above

  // --- material ---
  texMetres: 1.0,      // one needle tile, in metres, on both axes of a cloak
  leafSkyward: 0.6,    // how far a bough normal turns toward the sky. The
                       // black-underside knob

  barkLayer: LAYER.BARK_PINE,
}

// v1's own trunk keys, so buildTrunkV8 hands tree.js exactly what it owns.
const TRUNK_KEYS = [
  'seed', 'height', 'trunkSides', 'trunkLobe', 'trunkRings', 'trunkRadius', 'trunkBend',
  'barkRepeat', 'roots', 'rootRise', 'rootLength', 'rootAngle', 'rootDroop', 'rootWidth',
  'barkLayer',
]

/**
 * The mesh ladder. Three tiers, and a fourth rung that is a baked card.
 *
 * v8 coarsens by dropping BOUGHS, which is a harder simplification than v6's:
 * a whorl of five boughs is visibly a different plant from a whorl of eight,
 * where a cone of fifteen spokes and one of twenty-four are the same cone. The
 * trade is what the scheme buys at LOD0 -- real air between the limbs -- and
 * the tiers are set where the loss lands past the distance it shows at.
 */
export function treeV8Lod(options, tier) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  if (tier === 0) return p
  const coarse = { ...p, trunkSides: 3, trunkRings: 1, roots: 0 }
  if (tier === 1) return { ...coarse, boughs: Math.max(3, Math.round(p.boughs * 0.6)) }
  if (tier === 2) {
    return {
      ...coarse,
      boughs: Math.max(3, Math.round(p.boughs * 0.45)),
      skirts: Math.max(3, Math.round(p.skirts * 0.6)),
    }
  }
  throw new Error(
    `treeV8Lod: no MESH tier ${tier}; v8 has LOD0, LOD1 and LOD2. The tier past ` +
      'them is one spun quad carrying a baked photograph, not a parameter set'
  )
}

/**
 * Every triangle a parameter set implies, before any geometry exists.
 *
 *   trunk   = trunkSides x ((trunkRings - 1) x 2 + 1)   -- tree.js's cone law
 *   roots   = roots x 2                                 -- two-triangle wedges
 *   boughs  = skirts x boughs x 6                       -- three a side
 */
export function resolveTreeV8(options = {}) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  const sides = Math.max(3, Math.round(p.trunkSides))
  const rings = Math.max(1, Math.round(p.trunkRings))
  const trunkTris = p.trunkRadius > 0 ? sides * ((rings - 1) * 2 + 1) : 0
  const roots = p.trunkRadius > 0 && p.rootWidth > 0 ? Math.max(0, Math.round(p.roots)) : 0
  const skirts = Math.max(1, Math.round(p.skirts))
  const boughs = Math.max(1, Math.round(p.boughs))
  const skirtTris = skirts * boughs * 6
  return {
    trunkTris,
    roots,
    rootTris: roots * 2,
    skirts,
    boughs,
    skirtTris,
    triangles: trunkTris + roots * 2 + skirtTris,
  }
}

/**
 * v1's trunk with the crown switched off, plus the axis the whorls hang on.
 * The axis is MEASURED off the built mesh rather than recomputed from
 * `trunkBend` -- tree.js draws its lean from its own rng stream, and a copy of
 * that law here would go quietly wrong the day the stream gains a draw.
 */
export function buildTrunkV8(options = {}) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  const opts = { ...TREE_DEFAULTS }
  for (const k of TRUNK_KEYS) opts[k] = p[k]
  // heightRef at the height and countPower 0 make tree.js's density law the
  // identity: there is no crown below for it to scale, and leaving it live
  // would let `height` move a count that does not exist.
  opts.heightRef = p.height
  opts.countPower = 0
  opts.branches = 0
  opts.sprays = 0
  opts.apexSprays = 0
  opts.forks = 0
  opts.bundleTris = 0

  const geometry = buildTree(opts)

  const pos = geometry.getAttribute('position')
  let apexX = 0
  let apexZ = 0
  let apexY = p.height
  if (pos.count > 0) {
    let best = -Infinity
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      if (y > best) {
        best = y
        apexX = pos.getX(i)
        apexZ = pos.getZ(i)
      }
    }
    apexY = best
  }

  // A TRUNKLESS TREE IS A LEGAL SHAPE -- `trunkRadius` reaches 0. tree.js
  // measures its own bounding box, so with nothing in it the height comes back
  // -Infinity and the width NaN, and a NaN escaping into the gallery's spacing
  // takes the whole scene with it.
  const tree = geometry.userData.tree
  if (pos.count === 0) {
    tree.height = apexY
    tree.crownWidth = 0
    tree.belowGround = 0
  }

  const frame = {
    height: apexY,
    at: (f) => new THREE.Vector3(apexX * f * f, apexY * f, apexZ * f * f),
  }
  return { geometry, frame, tree }
}

// Samples of the spacing weight, per stack. 64 is far past what a stack of a
// dozen can resolve and costs one pass of arithmetic per tree.
const SPACING_SAMPLES = 64

/**
 * Where up the stack each whorl sits, as a fraction in [0, 1]. NOT EVENLY
 * SPACED: the gap above a whorl is part-proportional to how long its boughs
 * are, because a whorl's own needles are what fill the space over it.
 *
 * Solved as an inverse CDF rather than by walking gaps upward, because a walk
 * cannot land its last whorl on a given number -- and the top of the stack is
 * exactly the end that must be pinned.
 */
function skirtStops(n, p) {
  const stops = new Float64Array(n)
  const byLength = Math.min(1, Math.max(0, p.spacingByLength))
  const cum = new Float64Array(SPACING_SAMPLES + 1)
  for (let g = 1; g <= SPACING_SAMPLES; g++) {
    const u = (g - 0.5) / SPACING_SAMPLES
    const size = p.skirtMin + (1 - p.skirtMin) * crownProfile(u, p.crownPeak, p.crownFullness)
    // Floored so a stack whose profile bottoms out at zero still has a spacing
    // rather than piling every short whorl onto one point.
    const gap = Math.max(0.05, 1 - byLength + byLength * size)
    cum[g] = cum[g - 1] + 1 / gap
  }
  const total = cum[SPACING_SAMPLES]

  let g = 1
  for (let i = 0; i < n; i++) {
    const q = ((i + 0.5) / (n - 0.5)) * total
    while (g < SPACING_SAMPLES && cum[g] < q) g++
    const lo = cum[g - 1]
    const step = cum[g] - lo
    const frac = step > 1e-12 ? (q - lo) / step : 0
    stops[i] = Math.min(1, (g - 1 + frac) / SPACING_SAMPLES)
  }
  return stops
}

// Where along the spine each cloak station sits, as a fraction of its own
// section. Both are past the middle of their section, which puts the cloak's
// widest point outboard of the joint: a bough is widest where its own side
// shoots have had the most room, not at the wood it grew off.
const CLOAK_AT = 0.6
// Where the outer station sits between the joint and the tip. Not 1: a cloak
// that reached the tip would end in a blunt three-vertex edge, and this leaves
// the last stretch of spine to close to a point.
const CLOAK_OUT = 0.6

// Where the mid-joint coverage ramp saturates, as a fraction of the covering
// whorl's reach. v6's constant and v6's argument: the crown is self-similar,
// so a ramp reaching full darkness only on the trunk would leave the whole
// stack near half lit.
const COVER_DEEP = 0.35

/**
 * The crown: `skirts` whorls of `boughs` boughs, stacked up `frame`.
 *
 * Built in WORLD METRES against the trunk that was just measured. A bough
 * hangs off a butt that is already on the wood, so unlike v1 there is nothing
 * to discover by building at unit height and rescaling.
 */
export function buildFoliageV8(options, frame) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  // Its own stream, so the trunk's draws and the crown's cannot shift each
  // other: dragging `boughs` must not reroll which way the trunk leans.
  const rand = mulberry32((p.seed ^ 0x27d4eb2f) >>> 0)

  const H = frame.height
  const n = Math.max(1, Math.round(p.skirts))
  const nb = Math.max(1, Math.round(p.boughs))
  const stride = nb * 7
  const Rmax = Math.max(1e-4, p.crownRadius * H)
  const bottom = p.skirtBottom * H
  const span = Math.max(0, p.skirtTop * H - bottom)
  const tex = Math.max(0.05, p.texMetres)
  const sky = Math.min(1, Math.max(0, p.leafSkyward))
  const bend = Math.min(1, Math.max(0, p.midBend))

  const positions = []
  const normals = []
  const uvs = []
  const shades = []
  const indices = []

  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const w = new THREE.Vector3()
  const out = new THREE.Vector3()
  const side = new THREE.Vector3()
  const s0 = new THREE.Vector3()
  const s1 = new THREE.Vector3()
  const s2 = new THREE.Vector3()
  const tan = new THREE.Vector3()
  const arm = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  const hem = new THREE.Vector3()

  let widest = 0

  // Held so the middle joints can be shaded once every whorl's reach is known:
  // a whorl cannot ask how deeply it is buried until the one above it is built.
  const layers = []

  const stops = skirtStops(n, p)
  // Each whorl jitters inside ITS OWN gap, not a uniform slot, the gaps above
  // and below it no longer being the same size.
  const slotOf = (i) => {
    if (n === 1) return 0
    if (i === 0) return stops[1] - stops[0]
    if (i === n - 1) return stops[n - 1] - stops[n - 2]
    return (stops[i + 1] - stops[i - 1]) / 2
  }

  // One vertex: place it, author its normal, and give it a uv and a shade. The
  // normal is forced to the SKYWARD side of its own surface before the
  // `leafSkyward` turn, because a bough is one cell thick and lit from
  // everywhere -- a panel normal taken with its sign would send half of every
  // cloak black under any rig, which is the same argument material.js makes
  // for its cards.
  const push = (at, normal, u, v, shade) => {
    positions.push(at.x, at.y, at.z)
    nrm.copy(normal)
    if (nrm.dot(w) < 0) nrm.negate()
    if (nrm.lengthSq() > 1e-12) nrm.normalize()
    else nrm.copy(w)
    nrm.lerp(UP, sky)
    if (nrm.lengthSq() < 1e-8) nrm.copy(UP)
    nrm.normalize()
    normals.push(nrm.x, nrm.y, nrm.z)
    uvs.push(u, v)
    shades.push(shade, shade, shade)
    widest = Math.max(widest, Math.hypot(at.x, at.z))
  }

  for (let i = 0; i < n; i++) {
    const top = i === n - 1
    // Drawn even for the top whorl, which discards it: the rng stream has to
    // read the same whichever whorl is being built, or nudging `skirts` would
    // reroll the shape of every whorl below the one that was added.
    const wander = (rand() - 0.5) * p.skirtStagger * slotOf(i)
    const t = top ? stops[i] : Math.min(1, Math.max(0, stops[i] + wander))
    const apexY = bottom + t * span
    const f = Math.min(1, Math.max(0, apexY / Math.max(1e-6, H)))

    const prof = crownProfile(t, p.crownPeak, p.crownFullness)
    const R = Rmax * (p.skirtMin + (1 - p.skirtMin) * prof) * (top ? 1 + Math.max(0, p.topGrow) : 1)
    const D = R * Math.max(0, p.skirtDrop) * (1 + Math.max(0, p.dropByHeight) * t)
    const yaw = rand() * TAU

    // The axis: the trunk's, tipped by its own draw. A whorl that leaned the
    // same way as its neighbour would read as a whole tree bent over.
    const leanAz = rand() * TAU
    const lean = rand() * p.skirtLean
    w.set(Math.cos(leanAz) * Math.sin(lean), Math.cos(lean), Math.sin(leanAz) * Math.sin(lean)).normalize()
    e1.set(-w.z, 0, w.x)
    if (e1.lengthSq() < 1e-10) e1.set(1, 0, 0)
    e1.normalize()
    e2.crossVectors(w, e1).normalize()

    const shiftAz = rand() * TAU
    // Drawn then discarded on the top whorl, for the same reason `wander` is:
    // its butt has to sit ON the axis to be the tip of the tree.
    const drift = rand() * p.skirtShift * R
    const shift = top ? 0 : drift
    const origin = frame.at(f)
      .addScaledVector(e1, Math.cos(shiftAz) * shift)
      .addScaledVector(e2, Math.sin(shiftAz) * shift)

    const apexShade = top
      ? p.innerShade + (1 - p.innerShade) * Math.min(1, Math.max(0, p.shadeToTip))
      : p.innerShade

    const step = TAU / nb
    const base = positions.length / 3
    const midR = new Float32Array(nb)
    let reach = 0

    for (let b = 0; b < nb; b++) {
      // EVERY DRAW FOR THIS BOUGH, in one place: nothing here is shared around
      // the whorl, which is the difference between v8 and a cut-up v6 cone.
      const pull = Math.min(0.88, p.boughVary * rand())
      const liftBy = p.boughLift * pull
      const tilt = (rand() * 2 - 1) * p.boughTilt
      const sink = Math.min(0.95, Math.max(-0.4, liftBy + tilt))
      const bo = Math.min(0.999, Math.max(0.001, p.bowOutward))
      const u = rand()
      // `bowOutward` is the share of the draw that comes back negative, and the
      // two halves are each rescaled to the full swing, so moving the split
      // changes how OFTEN a spine bows out, not how far.
      const bow = (u < bo ? -(u / bo) : (u - bo) / (1 - bo)) * p.skirtBow
      const mid = Math.min(0.9, Math.max(0.1, 0.5 + bow))
      const swing = (rand() - 0.5) * p.boughSpread * step
      const crook = (rand() * 2 - 1) * p.boughCrook
      // A different half-width on each side, so a bough is lopsided the way a
      // limb that grew into its neighbour's light is.
      const wideL = p.boughWidth * (0.7 + 0.6 * rand())
      const wideR = p.boughWidth * (0.7 + 0.6 * rand())
      // The mat's own origin per bough. Without it every cloak on the tree
      // shows the same needles in the same place and the crown pulses.
      const uOff = rand()
      const vOff = rand()

      const a = yaw + b * step + swing
      out.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a))
      side.crossVectors(w, out).normalize()

      // The spine, in (reach, drop) exactly as a v6 meridian: butt on the axis,
      // joint where this bough's own bow put it, tip where its shortening left
      // it. `boughCrook` is the one term v6 has no analogue for -- a cone's
      // meridian cannot leave its own radial plane, and a limb does.
      const r1 = R * 0.5 * (1 - bend * pull)
      const d1 = D * mid * (1 - bend * sink)
      const r2 = R * (1 - pull)
      const d2 = D * (1 - sink)
      midR[b] = r1
      reach += r2 / nb

      s0.copy(origin)
      s1.copy(origin).addScaledVector(out, r1).addScaledVector(w, -d1).addScaledVector(side, crook * R)
      s2.copy(origin).addScaledVector(out, r2).addScaledVector(w, -d2)

      const len01 = s0.distanceTo(s1)
      const len12 = s1.distanceTo(s2)
      const L = len01 + len12
      const W0 = p.boughWidth > 0 ? L * wideL : 0
      const W1 = W0 * Math.max(0, p.boughTaper)
      const sag0 = W0 * Math.max(0, p.boughDroop)
      const sag1 = W1 * Math.max(0, p.boughDroop)

      // The ridge normal, per spine point: perpendicular to the spine and to
      // the cloak's lateral run. This is what makes the top of a bough the
      // brightest line on it.
      const ridge = (from, to, at, uu, vv, shade) => {
        tan.copy(to).sub(from)
        nrm.crossVectors(side, tan)
        push(at, nrm, uu, vv, shade)
      }

      // The joint's spine normal is taken across the WHOLE bough rather than
      // off either section, so a hard bow does not put a crease down the ridge.
      ridge(s0, s1, s0, uOff, vOff, apexShade)
      ridge(s0, s2, s1, uOff, vOff + len01 / tex, 1)
      ridge(s1, s2, s2, uOff, vOff + L / tex, 1)

      // The four cloak corners. Each takes the normal of ITS OWN panel -- the
      // plane through the spine run and the arm out to the hem -- so the two
      // sides of a bough shade differently and the thing reads as a roof rather
      // than as a flat fin.
      const corner = (from, to, along, half, sag, sg, vv, shade) => {
        hem.copy(from).lerp(to, along).addScaledVector(side, sg * half).addScaledVector(w, -sag)
        tan.copy(to).sub(from)
        arm.copy(hem).sub(from)
        nrm.crossVectors(tan, arm)
        push(hem, nrm, uOff + (sg * half) / tex, vv, shade)
      }

      const vIn = vOff + (len01 * CLOAK_AT) / tex
      const vOut = vOff + (len01 + len12 * CLOAK_OUT) / tex
      corner(s0, s1, CLOAK_AT, W0, sag0, 1, vIn, 1)
      corner(s1, s2, CLOAK_OUT, W1, sag1, 1, vOut, 1)
      corner(s0, s1, CLOAK_AT, W0, sag0, -1, vIn, 1)
      corner(s1, s2, CLOAK_OUT, W1, sag1, -1, vOut, 1)

      // 0 butt, 1 joint, 2 tip, 3/4 the left cloak, 5/6 the right. Wound so
      // every one of the six faces up; the mat is two-sided, so this is for the
      // geometry's own sake rather than for visibility.
      const v0 = base + b * 7
      indices.push(
        v0, v0 + 1, v0 + 3,
        v0 + 1, v0 + 4, v0 + 3,
        v0 + 1, v0 + 2, v0 + 4,
        v0, v0 + 5, v0 + 1,
        v0 + 1, v0 + 5, v0 + 6,
        v0 + 1, v0 + 6, v0 + 2
      )
    }

    layers.push({ apexShade, base, midR, reach })
  }

  // THE MIDDLE JOINTS, now that every whorl's reach is known. How dark a joint
  // goes is how far under the whorl above it sits, per bough against that
  // whorl's MEAN reach -- the yaws are independent, so pairing bough to bough
  // would be noise. The joint's two cloak stations take the same shade, being
  // the same distance out.
  const midShade = Math.min(1, Math.max(0, p.midShade))
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i]
    const above = layers[i + 1]
    for (let b = 0; b < nb; b++) {
      // The top whorl has nothing over it and stays at full brightness.
      const cover = above
        ? Math.min(1, Math.max(0, (above.reach - L.midR[b]) / Math.max(1e-6, above.reach * COVER_DEEP)))
        : 0
      const s = 1 - cover * (1 - L.apexShade) * midShade
      for (const slot of [1, 3, 5]) {
        const v = (L.base + b * 7 + slot) * 3
        shades[v] = s
        shades[v + 1] = s
        shades[v + 2] = s
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  // Grey, so it multiplies the mat without tinting it. The material has to be
  // built with vertexColors on to read this at all -- silently ignored
  // otherwise, and the crown comes back flat with nothing to say why.
  geo.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3))
  geo.setIndex(indices)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  geo.userData.foliage = {
    triangles: indices.length / 3,
    vertices: positions.length / 3,
    skirts: n,
    boughs: nb,
    stride,
    crownRadius: widest,
    crownBase: geo.boundingBox.min.y,
    crownTop: geo.boundingBox.max.y,
  }
  return geo
}

/** The whole tree: two geometries, and the numbers that describe them. */
export function buildTreeV8(options = {}) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  const { geometry: trunk, frame, tree } = buildTrunkV8(p)
  const foliage = buildFoliageV8(p, frame)
  const f = foliage.userData.foliage
  return {
    trunk,
    foliage,
    frame,
    stats: {
      height: tree.height,
      belowGround: tree.belowGround,
      trunkTris: tree.trunkTris,
      rootTris: tree.rootTris,
      roots: tree.roots,
      trunkDiameter: tree.trunkDiameter,
      skirtTris: f.triangles,
      skirts: f.skirts,
      boughs: f.boughs,
      crownWidth: f.crownRadius * 2,
      crownBase: f.crownBase,
      crownTop: f.crownTop,
      triangles: tree.triangles + f.triangles,
      vertices: tree.vertices + f.vertices,
    },
  }
}
