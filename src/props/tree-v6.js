import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'
import { buildTree, crownProfile, TREE_DEFAULTS } from './tree.js'

// ---------------------------------------------------------------------------
// TREE v6 -- the v1 trunk, and a crown of stacked frayed skirts.
//
// Two primitives, and no branches at all:
//
//   TRUNK    props/tree.js's own trunk, built by calling buildTree with the
//            crown switched off. Not a copy of it: v6 owns no bark code, so
//            trunkLobe, the root spurs and the bark tiling law cannot drift
//            away from what /gen-tree ships.
//   SKIRTS   `skirts` cones stacked up the trunk, each hung from a point ON
//            THE TRUNK AXIS and flaring down and out. A skirt is TWO sections
//            -- apex, mid ring, rim -- so its slope can bow either way, and
//            every rim spoke is frayed in and lifted on its own.
//
// WHY A SKIRT AND NOT A CARD. v1 hangs one cutout per spray off a limb, which
// buys a silhouette that is right from every angle and costs a limb cone to
// hang it on. A skirt spends the same triangles on a SURFACE: it is already
// closed around the trunk, so it needs no wood under it, it never turns
// edge-on, and it tiles a needle mat at its true world size instead of
// stretching one cut across a card. What it gives up is the deep interior of a
// broadleaf crown, which is why this is a conifer scheme.
//
// THE UPPER SECTION IS A FAN, NOT A BAND. Every spoke of the top section runs
// to one point on the trunk's axis, so that section costs `sides` triangles
// where a ring-to-ring band costs `sides x 2` -- a quarter off the whole crown.
// The ring it would have had was a collar at the bark, and the only thing that
// collar bought was a hole around the trunk that is never visible: a skirt
// above always covers it, and the lowest one is looked at from below, where the
// trunk is in front of the hole rather than through it.
//
// TWO SECTIONS IS THE MINIMUM THAT CAN CURVE. One band is a straight cone and
// reads as a paper party hat whatever you do to its rim. Moving the mid ring
// off the halfway depth is the whole of `skirtBow`: shallower and the skirt
// runs out flat and drops at the tips, deeper and it drops away from the trunk
// and flattens at the hem. The draw is PER SPOKE, not per skirt -- one sign for
// a whole cone gives a surface of revolution, which is exactly the shape the
// eye reads as turned on a lathe, and `bowOutward` sets how the signs split.
//
// THE FRAY IS THE SILHOUETTE, and it is five draws per spoke because a rim
// built from fewer looks computed. `frayDepth` pulls the spoke in, `frayJag`
// cuts a LOBE across a run of neighbouring spokes that tapers to nothing at its
// own ends, `frayLift` raises the spoke IN PROPORTION TO HOW FAR IT CAME IN --
// a notch cut into a cone travels up the cone as it travels in, and a spoke
// pulled in on the level ends up inside the shell where nothing can see it --
// and `hemWobble` and `hemRise` slide it around and up off the exact angle and
// height its index would give it. All of them are weighted to zero at the apex
// and to `midFray` at the mid ring, so a notch is a gore running up into the
// skirt rather than a bite taken out of its edge.
//
// THE OCCLUSION IS BAKED INTO THE VERTICES. A crown is a stack of overlapping
// shells, and no light rig the game can afford knows that a skirt is under
// another one: lit honestly, every layer takes the same sun and the stack reads
// as one green mass. `innerShade` darkens every fan to its apex, `shadeToTip`
// lets the top skirt alone off because it is the one fan under open sky, and
// the mid ring takes a share of the same darkening set by how far it sits under
// the rim of the skirt above -- so the buried low skirts go dark most of the way
// out and the tip ones, overhung by nothing, stay lit. It is a vertex colour
// rather than a texture because the quantity varies per vertex and the mat is
// shared by every skirt on the tree.
//
// ATTRIBUTES: `{ position, normal, uv, color }` on the foliage, which is a
// plain mapped material with vertexColors on, and the shared prop material's
// `{ position, normal, uvProj, texLayer }` on the trunk, which is buildTree's.
// TWO GEOMETRIES AND TWO MATERIALS, deliberately: the needle mat is a tiled
// 2-sided surface and the bark is a layer of the atlas, and there is no one
// material that is both.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

// The needle mats. LOD0 wears the cut-out one so a rim reads as needles; every
// tier past it wears the solid, because an alpha test at range is an aliasing
// machine -- the coverage of a one-pixel skirt swims frame to frame -- and a
// solid mat of the same needles is stable and costs no fill.
export const V6_TILES = {
  alpha: '/tmp/leaves/pine-mat-alpha.png',
  solid: '/tmp/leaves/pine-mat-solid.png',
}

export const TREE_V6_DEFAULTS = {
  seed: 1,

  // --- size ---
  height: 9,           // metres, root to tip

  // --- trunk: v1's, passed straight through to buildTree ---
  trunkSides: 12,      // 25 is v1's, and v1 hangs cards on the trunk you walk
                       // up to. A skirt crown hides everything above the first
                       // skirt, so the sides only have to hold up over the
                       // bare metre or two under it
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
  skirts: 11,          // cones up the trunk. The whole density knob, and at
                       // `skirtSides` x 3 triangles each the whole crown budget
  skirtBottom: 0.3,    // fraction of height the LOWEST apex sits at
  skirtTop: 1,         // and the highest. At 1 the top skirt's apex IS the
                       // measured trunk tip, so the tree ends in foliage rather
                       // than in a bare spike
  skirtStagger: 0.25,  // how far an apex may wander inside its own slot, as a
                       // fraction of the local spacing. 0 stacks them evenly
  spacingByLength: 0.6, // how much of the gap above a skirt is set by how long
                       // that skirt is. 0 spaces them evenly; at 1 a full-width
                       // whorl gets the whole gap and the short ones at the top
                       // and the foot crowd together, which is how a conifer
                       // actually stacks
  crownRadius: 0.35,   // the WIDEST skirt's rim, as a fraction of height
  crownPeak: 0.05,     // where up the stack that widest skirt sits. 0 = cone
  crownFullness: 1.15, // falloff from the peak. <1 fuller, >1 pointier
  skirtMin: 0.10,      // smallest skirt as a fraction of the widest
  topGrow: 0.3,        // how much bigger the TOP skirt is than the profile asks
                       // for. Its apex is pinned to the trunk tip, so it cannot
                       // drift down to close the gap to the one below it the way
                       // the others can, and the profile makes it the shortest
                       // skirt on the tree. Without this the tip shows bare wood

  // --- one skirt's shape ---
  skirtSides: 24,      // spokes around, costing 3 triangles each: one for the
                       // fan up to the apex, two for the band down to the rim
  skirtDrop: 0.8,      // how far a skirt hangs, as a multiple of its OWN rim
                       // radius. Above ~0.5 the stack overlaps, which is what
                       // makes it a canopy rather than a set of shelves
  dropByHeight: 1.0,   // and how much further, in proportion, the ones near the
                       // tip hang. The skirts up there are short, so at 0 their
                       // drop shrinks with their radius and the trunk shows
                       // through between them; this stretches them back over it
  skirtBow: 0.17,      // the mid ring's depth, off halfway by up to this much.
                       // Drawn PER SPOKE, so one skirt's meridians differ from
                       // each other and the cone reads as round rather than
                       // ruled
  bowOutward: 0.35,    // what share of those draws come out NEGATIVE: the slope
                       // runs out flat and drops at the tips. The rest bow the
                       // other way, dropping away from the trunk and flattening
                       // at the hem
  skirtLean: 0.09,     // radians a skirt's axis may tip off the trunk's
  skirtShift: 0,       // and how far its apex may slide off the axis, as a
                       // fraction of its own rim radius. 0 keeps every apex on
                       // the wood, which is what makes the crown read as one
                       // tree rather than a stack of hats

  // --- the fray ---
  frayDepth: 0.29,     // per-spoke pull-in, as a fraction of the rim radius
  frayJag: 0.22,       // and how deep a LOBE cuts on top of that
  lobeWidth: 3,        // the most spokes one lobe may span. Widths are drawn
                       // inside it and every lobe tapers to nothing at its own
                       // ends, so the rim scallops at irregular intervals
                       // instead of sawing at every second spoke
  frayLift: 0.28,      // how far a pulled-in spoke rises back UP the cone, as a
                       // fraction of its own pull-in. 1 keeps the rim roughly on
                       // the shell; 0 cuts it flat and buries the notches
  hemWobble: 0.5,      // how far a spoke slides AROUND, as a fraction of the
                       // angular step. The spokes are otherwise exactly evenly
                       // spaced, which is most of what reads as machined
  hemRise: 0.2,        // and how far it rides up or down on top of the lift, as
                       // a fraction of its ring's drop
  midFray: 0.61,       // how much of all five the MID ring inherits. 0 makes the
                       // fray a bite out of the edge; up here it is a gore
                       // running most of the way up the skirt

  // --- shading ---
  innerShade: 0,       // how dark every fan apex is baked, as a multiple of the
                       // rim's brightness. The crown is a stack of overlapping
                       // shells and the light rig cannot know that, so the
                       // occlusion is baked into the vertices: without it every
                       // skirt is lit like the one above it and the layers merge
                       // into one green mass
  shadeToTip: 1.0,     // how much of that darkening the TOP skirt is let off.
                       // Only the top one: its fan is the only fan in the tree
                       // with nothing over it, and lifting the shade gradually
                       // up the stack instead just washes the whole upper crown
  midShade: 0.8,       // how much of the apex's darkening a FULLY COVERED mid
                       // ring vertex takes. Coverage is measured per spoke
                       // against the rim of the skirt above, so the low skirts
                       // -- buried to well past their own mid ring -- darken all
                       // the way and the tip ones, which nothing overhangs, stay
                       // at full brightness

  // --- material ---
  texMetres: 1.0,      // one needle tile, in metres. The tiling AROUND a skirt
                       // is rounded to an integer so the seam lands on a tile
                       // boundary; the tiling DOWN it is free, the rim being a
                       // cut edge with nothing to meet
  leafSkyward: 0.6,    // how far a skirt normal turns toward the sky. The
                       // black-underside knob: 0 shades each cone by its own
                       // shell, 1 shades the crown as if lit from above

  barkLayer: LAYER.BARK_PINE,
}

// v1's own trunk keys, so buildTrunkV6 can hand tree.js exactly what it owns
// and nothing this file invented. Listed rather than derived because a key
// appearing in TREE_V6_DEFAULTS is not evidence that tree.js knows it.
const TRUNK_KEYS = [
  'seed', 'height', 'trunkSides', 'trunkLobe', 'trunkRings', 'trunkRadius', 'trunkBend',
  'barkRepeat', 'roots', 'rootRise', 'rootLength', 'rootAngle', 'rootDroop', 'rootWidth',
  'barkLayer',
]

/**
 * The mesh ladder. Three tiers, and the fourth rung is a baked card, which is
 * a picture rather than a parameter set -- the bench builds it.
 *
 * A skirt simplifies the way a trunk does and unlike a card crown: it is a
 * surface of revolution with a frayed edge, so asking for fewer spokes loses
 * notches and keeps the cone. That is the argument for the whole scheme -- v1's
 * coarse tier has to drop limbs to fins and hope the cards still sit right,
 * where this one just asks the same shape for less of itself.
 */
export function treeV6Lod(options, tier) {
  const p = { ...TREE_V6_DEFAULTS, ...options }
  if (tier === 0) return p
  // The trunk goes to a wedge at every coarse tier and the root flare goes
  // away: both are centimetres of silhouette at the foot of a tree that is by
  // then a few dozen pixels tall, with terrain across half of them.
  const coarse = { ...p, trunkSides: 3, trunkRings: 1, roots: 0 }
  if (tier === 1) return { ...coarse, skirtSides: Math.max(5, Math.round(p.skirtSides * 0.6)) }
  if (tier === 2) {
    return {
      ...coarse,
      skirtSides: Math.max(4, Math.round(p.skirtSides * 0.4)),
      skirts: Math.max(3, Math.round(p.skirts * 0.6)),
    }
  }
  throw new Error(
    `treeV6Lod: no MESH tier ${tier}; v6 has LOD0, LOD1 and LOD2. The tier past ` +
      'them is one spun quad carrying a baked photograph, not a parameter set'
  )
}

/**
 * Every triangle a parameter set implies, before any geometry exists.
 *
 *   trunk   = trunkSides x ((trunkRings - 1) x 2 + 1)   -- a cone, tree.js's law
 *   roots   = roots x 2                                 -- two-triangle wedges
 *   skirts  = skirts x skirtSides x 3                   -- a fan and a band each
 *
 * No height-density law: v6 states its counts as counts, because a skirt is
 * already sized as a fraction of height and a taller tree of the same species
 * carries the same number of whorls further apart, not more of them.
 */
export function resolveTreeV6(options = {}) {
  const p = { ...TREE_V6_DEFAULTS, ...options }
  const sides = Math.max(3, Math.round(p.trunkSides))
  const rings = Math.max(1, Math.round(p.trunkRings))
  const trunkTris = p.trunkRadius > 0 ? sides * ((rings - 1) * 2 + 1) : 0
  const roots = p.trunkRadius > 0 && p.rootWidth > 0 ? Math.max(0, Math.round(p.roots)) : 0
  const skirts = Math.max(1, Math.round(p.skirts))
  const skirtSides = Math.max(3, Math.round(p.skirtSides))
  const skirtTris = skirts * skirtSides * 3
  return {
    trunkTris,
    roots,
    rootTris: roots * 2,
    skirts,
    skirtSides,
    skirtTris,
    triangles: trunkTris + roots * 2 + skirtTris,
  }
}

/**
 * v1's trunk, with the crown switched off, plus the axis the skirts hang on.
 *
 * THE AXIS IS MEASURED OFF THE BUILT MESH, not recomputed from `trunkBend`.
 * tree.js draws the lean from its own rng stream, so reproducing it here would
 * be a copy that goes quietly wrong the day that stream gains a draw -- the
 * skirts would slide off the wood and nothing would say why. The trunk apex is
 * the single highest vertex in the geometry, the base is the origin by
 * construction, and tree.js's lean is quadratic in the height fraction, so
 * those two points are the whole curve.
 */
export function buildTrunkV6(options = {}) {
  const p = { ...TREE_V6_DEFAULTS, ...options }
  const opts = { ...TREE_DEFAULTS }
  for (const k of TRUNK_KEYS) opts[k] = p[k]
  // heightRef at the height and countPower 0 make tree.js's density law the
  // identity. There is nothing for it to scale -- the crown below is zero --
  // but leaving it live would let `height` move a count that does not exist.
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

  // A TRUNKLESS TREE IS A LEGAL SHAPE -- `trunkRadius` reaches 0, and a crown
  // hanging in mid-air is a thing worth looking at once. tree.js measures its
  // own bounding box, so with nothing in it the height comes back -Infinity and
  // the width NaN, and a NaN escaping into the gallery's spacing takes the
  // whole scene with it. The frame is defined either way, so restate the three
  // numbers off it.
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

// Samples of the spacing weight, per skirt stack. 64 is far past what a stack
// of a dozen can resolve and costs one pass of arithmetic per tree.
const SPACING_SAMPLES = 64

/**
 * Where up the stack each skirt sits, as a fraction in [0, 1].
 *
 * NOT EVENLY SPACED. The gap above a skirt is part-proportional to how long
 * that skirt is, because a whorl's own needles are what fill the space over it:
 * hold the gap constant and a full-width skirt drowns its neighbours while the
 * short ones at the tip stand in bare air. `spacingByLength` is the mix.
 *
 * Solved as an inverse CDF rather than by walking gaps upward from the bottom,
 * because a walk cannot land its last skirt on a given number -- it arrives
 * where it arrives, and the top of the stack is exactly the end that must be
 * pinned. Integrating 1/gap over the whole span and cutting it into equal
 * pieces puts the ends where they are asked for and the spacing in between.
 */
function skirtStops(n, p) {
  const stops = new Float64Array(n)
  const byLength = Math.min(1, Math.max(0, p.spacingByLength))
  // cum[g] is the integral of 1/gap from 0 to g/SAMPLES, so it rises fast where
  // the skirts are short and want crowding.
  const cum = new Float64Array(SPACING_SAMPLES + 1)
  for (let g = 1; g <= SPACING_SAMPLES; g++) {
    const u = (g - 0.5) / SPACING_SAMPLES
    const size = p.skirtMin + (1 - p.skirtMin) * crownProfile(u, p.crownPeak, p.crownFullness)
    // Floored so a stack whose profile bottoms out at zero still has a spacing
    // rather than piling every short skirt onto one point.
    const gap = Math.max(0.05, 1 - byLength + byLength * size)
    cum[g] = cum[g - 1] + 1 / gap
  }
  const total = cum[SPACING_SAMPLES]

  let g = 1
  for (let i = 0; i < n; i++) {
    // The LAST skirt lands on 1 and the first half a slot up from 0. Pinning
    // the top matters -- at `skirtTop` 1 that apex is the trunk's own tip -- and
    // pinning the bottom does not, a skirt at exactly 0 being a point by
    // crownProfile's construction.
    const q = ((i + 0.5) / (n - 0.5)) * total
    while (g < SPACING_SAMPLES && cum[g] < q) g++
    const lo = cum[g - 1]
    const step = cum[g] - lo
    const frac = step > 1e-12 ? (q - lo) / step : 0
    stops[i] = Math.min(1, (g - 1 + frac) / SPACING_SAMPLES)
  }
  return stops
}

/**
 * The crown: `skirts` frayed two-section cones stacked up `frame`.
 *
 * Built in WORLD METRES against the trunk that was just measured, not at unit
 * height and rescaled. v1 rescales because its foliage stands above its trunk
 * tip and the only honest way to hit a metre target is to build and measure; a
 * skirt hangs DOWN off an apex that is already on the wood, so there is nothing
 * to discover and a rescale would only move the crown off the trunk.
 */
export function buildFoliageV6(options, frame) {
  const p = { ...TREE_V6_DEFAULTS, ...options }
  // Its own stream, so the trunk's draws and the crown's cannot shift each
  // other: dragging `skirts` must not reroll which way the trunk leans.
  const rand = mulberry32((p.seed ^ 0x27d4eb2f) >>> 0)

  const H = frame.height
  const n = Math.max(1, Math.round(p.skirts))
  const sides = Math.max(3, Math.round(p.skirtSides))
  const stride = sides + 1
  const Rmax = Math.max(1e-4, p.crownRadius * H)
  const bottom = p.skirtBottom * H
  const span = Math.max(0, p.skirtTop * H - bottom)
  const tex = Math.max(0.05, p.texMetres)
  const sky = Math.min(1, Math.max(0, p.leafSkyward))

  const positions = []
  const normals = []
  const uvs = []
  const shades = []
  const indices = []

  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const w = new THREE.Vector3()
  const radial = new THREE.Vector3()
  const nrm = new THREE.Vector3()

  let widest = 0

  // Held so the mid rings can be shaded once every skirt's rim is known: a
  // skirt cannot ask how deeply it is buried until the one above it is built.
  const layers = []

  const stops = skirtStops(n, p)
  // Each skirt jitters inside ITS OWN gap, not a uniform slot, since the gaps
  // above and below it are no longer the same size -- a jitter scaled to the
  // average would let a crowded skirt at the tip hop over its neighbour.
  const slotOf = (i) => {
    if (n === 1) return 0
    if (i === 0) return stops[1] - stops[0]
    if (i === n - 1) return stops[n - 1] - stops[n - 2]
    return (stops[i + 1] - stops[i - 1]) / 2
  }

  for (let i = 0; i < n; i++) {
    const top = i === n - 1
    // Drawn even for the top skirt, which discards it: the rng stream has to
    // read the same whichever skirt is being built, or nudging `skirts` would
    // reroll the shape of every skirt below the one that was added.
    const wander = (rand() - 0.5) * p.skirtStagger * slotOf(i)
    // THE TOP SKIRT IS PINNED. Its apex is the tip of the tree, so it takes the
    // stop it was given and no jitter; at `skirtTop` 1 that is the trunk's own
    // measured apex, and the tree ends in needles instead of in a spike.
    const t = top ? stops[i] : Math.min(1, Math.max(0, stops[i] + wander))
    const apexY = bottom + t * span
    const f = Math.min(1, Math.max(0, apexY / Math.max(1e-6, H)))

    const prof = crownProfile(t, p.crownPeak, p.crownFullness)
    const R = Rmax * (p.skirtMin + (1 - p.skirtMin) * prof) * (top ? 1 + Math.max(0, p.topGrow) : 1)
    // The drop is a multiple of the skirt's OWN radius, so on its own it shrinks
    // with the crown profile and the short skirts near the tip stop reaching the
    // one below. `dropByHeight` stretches them back over the gap; it is the only
    // shape term that reads t rather than being a pure fraction of the skirt.
    const D = R * Math.max(0, p.skirtDrop) * (1 + Math.max(0, p.dropByHeight) * t)
    const yaw = rand() * TAU

    // The axis: the trunk's, tipped by its own draw. A skirt that leaned the
    // same way as its neighbour would read as a whole tree bent over rather
    // than as a whorl that grew crooked.
    const leanAz = rand() * TAU
    const lean = rand() * p.skirtLean
    w.set(Math.cos(leanAz) * Math.sin(lean), Math.cos(lean), Math.sin(leanAz) * Math.sin(lean)).normalize()
    // Any two axes perpendicular to it. The yaw above is what turns the spokes,
    // so this frame only has to be orthonormal, not oriented.
    e1.set(-w.z, 0, w.x)
    if (e1.lengthSq() < 1e-10) e1.set(1, 0, 0)
    e1.normalize()
    e2.crossVectors(w, e1).normalize()

    const shiftAz = rand() * TAU
    // Drawn then discarded on the top skirt, for the same reason `wander` is:
    // its apex has to sit ON the axis to be the tip of the tree.
    const drift = rand() * p.skirtShift * R
    const shift = top ? 0 : drift
    const origin = frame.at(f)
      .addScaledVector(e1, Math.cos(shiftAz) * shift)
      .addScaledVector(e2, Math.sin(shiftAz) * shift)

    // THE LOBES, first, because the pull-in is drawn on top of them. A lobe
    // spans a run of neighbouring spokes and tapers to nothing at both of its
    // own ends, which is what makes the rim scallop: a per-spoke draw alone
    // gives noise, and the old every-second-spoke rule gave a saw. Tapering
    // also means the wrap needs no special case -- the last lobe meets the
    // first at zero however the widths happened to divide.
    const maxLobe = Math.max(1, Math.round(p.lobeWidth))
    const lobe = new Float32Array(sides)
    for (let k = 0; k < sides;) {
      const width = 1 + Math.floor(rand() * maxLobe)
      const depth = p.frayJag * rand()
      for (let j = 0; j < width && k < sides; j++, k++) {
        lobe[k] = depth * Math.sin((Math.PI * (j + 0.5)) / width)
      }
    }

    // ONE PASS OF DRAWS PER SPOKE, HELD, because the same numbers have to reach
    // the mid ring and the rim. Drawing them twice would fray the two rings
    // independently and the gore would not line up with the notch it belongs to.
    const pullIn = new Float32Array(sides)
    const liftBy = new Float32Array(sides)
    const midOf = new Float32Array(sides)
    const swing = new Float32Array(sides)
    const rise = new Float32Array(sides)
    const step = TAU / sides
    for (let k = 0; k < sides; k++) {
      pullIn[k] = Math.min(0.88, p.frayDepth * rand() + lobe[k])
      // The lift is the pull-in, scaled -- ONE draw, not two. A notch cut into a
      // cone travels up the cone as it travels in, so a spoke that came in
      // further has to rise further or it ends up inside the shell, where the
      // fray is invisible and the silhouette is a plain circle again.
      liftBy[k] = p.frayLift * pullIn[k]
      // This spoke's own bow. `bowOutward` is the share of the draw that comes
      // back negative, and the two halves are each rescaled to the full swing so
      // moving the split changes how OFTEN a meridian bows out, not how far.
      const b = Math.min(0.999, Math.max(0.001, p.bowOutward))
      const u = rand()
      const bow = (u < b ? -(u / b) : (u - b) / (1 - b)) * p.skirtBow
      midOf[k] = Math.min(0.9, Math.max(0.1, 0.5 + bow))
      swing[k] = (rand() - 0.5) * p.hemWobble * step
      rise[k] = (rand() * 2 - 1) * p.hemRise
    }

    // ring 0 is the apex on the axis, ring 1 the mid, ring 2 the rim. The mid
    // ring's depth is per spoke, so `depth` reads midOf[] rather than the ring.
    const RINGS = [
      { s: 0, fray: 0 },
      { s: 0.5, fray: Math.min(1, Math.max(0, p.midFray)) },
      { s: 1, fray: 1 },
    ]

    // The baked occlusion. Every fan is buried to the same degree -- a skirt
    // near the tip has a skirt over it exactly like one at the foot does -- so
    // `innerShade` is flat up the stack and only the top skirt, the one fan
    // with open sky above it, is let off by `shadeToTip`. The mid ring is
    // written later, once the skirt above it is known; the rim is never shaded.
    const apexShade = top
      ? p.innerShade + (1 - p.innerShade) * Math.min(1, Math.max(0, p.shadeToTip))
      : p.innerShade
    const SHADE = [apexShade, 1, 1]
    // THE MERIDIAN, PER SPOKE, in (radius, depth): the apex at the origin, the
    // mid ring where this spoke's bow put it, the rim where the fray left it.
    // The normals come off THESE, not off the ideal cone, because a cone whose
    // apex and rim share one normal shades perfectly flat along its slope --
    // which turns `skirtBow` into a silhouette knob you cannot see in the light
    // and leaves a stack of skirts reading as one green mass.
    //
    // Each section's outward normal is (|dd|, |dr|) off its own tangent: forced
    // outward and skyward rather than taken with its sign, because a deep gore
    // can pull a rim inside its own mid ring and a shell facing the trunk or the
    // ground goes black under any rig. A needle is one cell thick and lit from
    // every side, so neither direction carries anything worth shading -- the
    // same argument v1 makes for its cards.
    const secA = new Float32Array(sides * 2)
    const secB = new Float32Array(sides * 2)
    const midR = new Float32Array(sides)
    let rimR = 0
    for (let k = 0; k < sides; k++) {
      const sink = Math.min(0.95, Math.max(-0.4, liftBy[k] + rise[k]))
      const r1 = R * 0.5 * (1 - RINGS[1].fray * pullIn[k])
      const d1 = D * midOf[k] * (1 - RINGS[1].fray * sink)
      const r2 = R * (1 - pullIn[k])
      const d2 = D * (1 - sink)
      midR[k] = r1
      rimR += r2 / sides
      let len = Math.hypot(r1, d1) || 1
      secA[k * 2] = Math.abs(d1) / len
      secA[k * 2 + 1] = Math.abs(r1) / len
      len = Math.hypot(r2 - r1, d2 - d1) || 1
      secB[k * 2] = Math.abs(d2 - d1) / len
      secB[k * 2 + 1] = Math.abs(r2 - r1) / len
    }
    // Rounded, because the seam vertex is duplicated at k = sides: a fractional
    // repeat leaves a mismatched stripe straight up the skirt.
    const uRepeat = Math.max(1, Math.round((TAU * R) / tex))

    const apexBase = positions.length / 3
    const midBase = apexBase + sides
    const rimBase = midBase + stride
    layers.push({ apexShade, midBase, midR, rimR })

    // The apex vertices are all the SAME POINT, one per fan triangle. They are
    // split only so each triangle can carry the u of its own wedge: a single
    // shared apex would have to pick one u and would smear the mat around the
    // whole cone.
    for (let r = 0; r < RINGS.length; r++) {
      const ring = RINGS[r]
      const apex = r === 0
      const count = apex ? sides : stride
      const rs = R * ring.s
      const shade = SHADE[r]
      for (let k = 0; k < count; k++) {
        const kk = k % sides
        // The mid ring is the only one whose depth is the skirt's to choose;
        // the apex is at 0 and the rim at the full drop by construction.
        const ds = r === 1 ? D * midOf[kk] : D * ring.s
        // Half a step round on the fan: the apex vertex belongs to a wedge, not
        // to a spoke, and its normal and its u both want the wedge's middle.
        // Everything else takes its spoke's own wobble, weighted like the fray
        // so the fan stays regular where the triangles are thinnest.
        const turn = (k + (apex ? 0.5 : 0)) / sides + (ring.fray * swing[kk]) / TAU
        const a = yaw + turn * TAU
        const radius = rs * (1 - ring.fray * pullIn[kk])
        // Scaled by the ring's own drop rather than by the skirt's, so a lifted
        // spoke can never climb above the ring it belongs to. Clamped because
        // the wobble is signed and unbounded draws would put a rim vertex above
        // the apex, where its triangles fold back on the skirt.
        const sink = Math.min(0.95, Math.max(-0.4, liftBy[kk] + rise[kk]))
        const depth = ds * (1 - ring.fray * sink)
        radial.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a))
        const x = origin.x + radial.x * radius - w.x * depth
        const y = origin.y + radial.y * radius - w.y * depth
        const z = origin.z + radial.z * radius - w.z * depth
        positions.push(x, y, z)
        shades.push(shade, shade, shade)

        // Smooth across the joint: the apex takes the fan section of the two
        // spokes its wedge lies between, the mid ring the mean of the sections
        // that meet there, and the rim the band section alone. That mean is what
        // keeps the two sections from creasing at the ring between them.
        const k2 = (kk + 1) % sides
        const nRad = apex
          ? secA[kk * 2] + secA[k2 * 2]
          : r === 1 ? secA[kk * 2] + secB[kk * 2] : secB[kk * 2]
        const nSky = apex
          ? secA[kk * 2 + 1] + secA[k2 * 2 + 1]
          : r === 1 ? secA[kk * 2 + 1] + secB[kk * 2 + 1] : secB[kk * 2 + 1]
        // Then toward the sky by `leafSkyward`. The other half of this lives in
        // the fragment shader, which undoes three's double-sided flip -- without
        // it the underside of the crown goes black.
        nrm.copy(radial).multiplyScalar(nRad).addScaledVector(w, nSky)
        // Unit BEFORE the lerp, or an averaged normal's extra length would make
        // `leafSkyward` mean something different at the ring joints.
        if (nrm.lengthSq() > 1e-12) nrm.normalize()
        nrm.lerp(UP, sky)
        if (nrm.lengthSq() < 1e-8) nrm.copy(radial).add(UP)
        nrm.normalize()
        normals.push(nrm.x, nrm.y, nrm.z)

        // v is the real distance down the meridian, so a bowed spoke moves the
        // tiling with the surface instead of stretching it over a longer slope.
        // u follows `turn`, not the index, or the wobble would shear the mat --
        // and the seam still meets, k = sides differing from k = 0 by exactly
        // `uRepeat` whole tiles.
        uvs.push(turn * uRepeat, Math.hypot(radius, depth) / tex)
        widest = Math.max(widest, Math.hypot(x, z))
      }
    }

    for (let k = 0; k < sides; k++) {
      indices.push(apexBase + k, midBase + k + 1, midBase + k)
      const m = midBase + k
      const r = rimBase + k
      indices.push(m, m + 1, r + 1, m, r + 1, r)
    }
  }

  // THE MID RINGS, now that every rim is known. How dark a mid vertex goes is
  // how far under the skirt above it sits, measured per spoke against that
  // skirt's mean rim: the yaws are independent, so pairing spoke to spoke would
  // be noise.
  //
  // COVER_DEEP is where that ramp saturates, as a fraction of the covering rim.
  // It is low because the crown is self-similar -- every mid ring sits at
  // roughly two thirds of the rim above it, whatever height it is at -- so a
  // ramp reaching full darkness only on the trunk would leave the whole stack
  // near half lit, which is the flat crown this bake exists to fix. At 0.35 the
  // deep spokes bottom out at the apex value and the shallow ones still vary.
  const COVER_DEEP = 0.35
  const midShade = Math.min(1, Math.max(0, p.midShade))
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i]
    const above = layers[i + 1]
    for (let k = 0; k < stride; k++) {
      const r = L.midR[k % sides]
      // The top skirt has nothing over it and stays at full brightness.
      const cover = above
        ? Math.min(1, Math.max(0, (above.rimR - r) / Math.max(1e-6, above.rimR * COVER_DEEP)))
        : 0
      const s = 1 - cover * (1 - L.apexShade) * midShade
      const v = (L.midBase + k) * 3
      shades[v] = s
      shades[v + 1] = s
      shades[v + 2] = s
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
    sides,
    crownRadius: widest,
    crownBase: geo.boundingBox.min.y,
    crownTop: geo.boundingBox.max.y,
  }
  return geo
}

/** The whole tree: two geometries, and the numbers that describe them. */
export function buildTreeV6(options = {}) {
  const p = { ...TREE_V6_DEFAULTS, ...options }
  const { geometry: trunk, frame, tree } = buildTrunkV6(p)
  const foliage = buildFoliageV6(p, frame)
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
      sides: f.sides,
      crownWidth: f.crownRadius * 2,
      crownBase: f.crownBase,
      crownTop: f.crownTop,
      triangles: tree.triangles + f.triangles,
      vertices: tree.vertices + f.vertices,
    },
  }
}
