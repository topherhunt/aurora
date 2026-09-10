import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// TREE OAK -- a broadleaf built from crooked tubes under a litter of scoops.
//
// props/tree-v8.js is the conifer generator: a stack of whorls, each whorl a
// ring of spine-and-cloak boughs. That primitive is a needle mat hung on a
// limb, and no setting of its knobs is an oak -- v8's own ascending form is the
// proof, four special cases threaded through the whorl loop to make rings of
// boughs read as limbs. An oak is a different architecture, so it is a
// different generator, and the two share nothing but the bench, the bark
// material's attribute layout and the LOD discipline.
//
// THE WOOD IS ONE PRIMITIVE, USED TWICE. `addTube` runs a ring of `sides`
// corners along a polyline and closes it to a point, so a tube of S segments
// is (S - 1) x sides x 2 + sides triangles, which is tree.js's cone law with
// the rings on a crooked path instead of a parabola. The trunk is one tube of
// `trunkSegments`, each joint turning by its own draw under `trunkCrook`, which
// is what gives a bole a warp rather than a lean. Every branch is one tube of
// `branchSegments` under `branchCrook`, launched off the trunk's surface and
// turning up a little at every joint. The frame that carries the ring round
// each station is rotation-minimising -- the previous ring's e1 re-projected
// onto the new tangent plane -- so the bark does not twist around a crook.
//
// THE FOLIAGE IS SCOOPS: many small five-triangle boughs, not a few closed
// masses. A scoop is a pentagon fanned from a centre vertex that is pushed
// `boughDepth` of the rim's radius out of the rim's plane, so it is a shallow
// bowl opening along its own normal. Its rim is stretched along one axis of
// its own by `boughSkew` and every rim vertex takes its own radial jitter, so
// no two scoops are the same shape. One rim vertex is the STEM: it sits
// exactly on a branch's surface, and it is `stemReach` rim radii from the
// centre where the others are one, so a scoop hangs off its branch rather
// than being pinned through the middle. Every scoop stems from a branch,
// seated at a fraction of its length drawn between `boughFrom` and the tip
// and crowded toward the tip by `tipBias`.
//
// A SCOOP IS AIMED, NOT DROPPED. Hung from its stem, a scoop is free to turn
// every way -- which way it opens, and which way its body runs off the stem
// -- and it takes the turn that leaves it LEAST PARALLEL TO ITS NEIGHBOURS,
// since two sheets facing the same way shade each other and read as one. The
// opening is tried over `boughAims` directions spread evenly across a
// hemisphere whose pole is DRAWN AT RANDOM for each scoop -- an opening and
// its reverse are the same sheet to the score, so a hemisphere covers every
// plane and the pole only picks which way the dome bulges -- and for each the
// body over `boughSpins` directions round the stem from a drawn start; a
// candidate's cost is the sum, over the scoops already placed within `NEAR`
// rim radii of its centre, of how parallel the two openings are, weighted by
// how close the centres sit. The least costly candidate wins, so a scoop
// turns away from whatever it hangs beside and reaches to where nothing faces
// its way, and one with nothing beside it lands wherever its draws fell;
// scoops may cross one another freely. The only bodies refused are those
// running back into the wood and, within `tipZone` of a branch's tip, those
// running back down the limb, so a limb's end holds scoops reaching past it
// at every angle and no more of them straight out than any other way. A
// scoop is a sheet seen from both sides, so it wears the mat DOUBLE-SIDED, and
// its normal is authored on the SKY side of each face whichever way it opens:
// a Lambert lit along a downward opening would put every scoop in its own
// shadow.
//
// THE LADDER. LOD1 and LOD2 keep a FRACTION of the scoops and take sides off
// the wood; nothing else moves. Every scoop is drawn from the rng at every
// tier and only its emit is skipped, so `boughs` is how many the tree has,
// `boughKeep` is how many reach the buffer, and a coarse tier is a subset in
// LOD0's own seats -- v8's argument, one primitive over. The seats are drawn
// in random order over the branches, so the first N are an even thinning.
//
// THE OCCLUSION IS A RAMP. A crown of overlapping sheets is lit honestly by a
// Lambert, but the low scoops are under the high ones and no rig the game can
// afford knows it, so `innerShade` darkens every vertex by how far down the
// crown it sits, and `boughTint` gives each scoop its own small offset so
// neighbours separate.
//
// BUILT AT `height` AND THEN RESCALED SO THE CROWN'S TOP LANDS THERE. Where
// the top comes out is the sum of the bole, a limb's climb and a scoop's
// reach, none of which is pinned to anything, so the only honest way to be
// `height` tall is to build and measure -- tree.js's arrangement, with the uv
// scaled along so a tile stays the metres `texMetres` says. The extent is
// measured over every scoop DRAWN, kept or not, so all tiers share one scale.
//
// ATTRIBUTES: `{ position, normal, uv, color }` on the foliage, flat-shaded and
// unwelded with an identity index; `{ position, normal, uvProj, texLayer }` on
// the wood, which is createPropMaterial's layout.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

export const OAK_MAT = '/trees/mat_oak.png'

export const TREE_OAK_DEFAULTS = {
  seed: 86384,

  // --- size ---
  height: 9,           // metres, root to the top of the crown

  // --- trunk ---
  trunkSides: 12,
  trunkSegments: 3,    // crooked segments up the bole, min 1. One is a straight
                       // cone; the warp needs joints to happen at
  trunkCrook: 0.1,     // radians a joint may turn, about an azimuth of its own
  trunkTop: 0.5,      // the bole's length as a fraction of height
  trunkRadius: 0.016,  // base radius as a FRACTION of height
  trunkTaper: 0.5,     // the last ring's radius as a fraction of the base's. A
                       // bole does not run to a point the way a conifer's does;
                       // the point is only the closing cap, lost among the scoops
  trunkLobe: 0.15,     // out-of-round, as a fraction of the radius, tree.js's
                       // three harmonics. Needs sides to spend: under 6 ignored
  barkRepeat: 5,       // bark tiles UP the bole this many times; the tiling
                       // around is derived so a tile stays roughly square

  // --- branches ---
  branches: 5,
  branchSegments: 3,   // crooked segments per branch, min 1
  branchCrook: 0.8,    // radians a joint may turn, pitch and yaw drawn per joint
  branchRise: 0.28,    // and how far every joint turns UP on top of that, so a
                       // limb leaves reaching out and finishes reaching up
  branchBottom: 0.45,  // fraction of the BOLE the lowest branch leaves at
  branchTopEnd: 0.79,  // and the highest
  branchLength: 0.14,  // a branch's length as a fraction of height
  branchVary: 0.25,    // per-branch shortening, as a fraction of that
  branchPitch: 0.75,    // radians above horizontal at the launch, the mean
  branchPitchVary: 0.3, // and the half-range of the per-branch draw around it
  branchSpread: 0.35,  // how far a branch slides around off its even azimuth,
                       // as a fraction of the angular step
  branchSides: 6,
  branchRadius: 0.4,   // butt radius as a fraction of the trunk's where it leaves
  branchTaper: 0.35,   // the last ring's radius as a fraction of the butt's

  // --- the boughs ---
  boughs: 70,          // scoops littered over the branches, five triangles each
  boughRadius: 0.055,  // a scoop's rim radius as a fraction of height
  boughVary: 0.35,     // per-scoop half-range around that, as a fraction
  boughDepth: 0.5,     // how far the centre is pushed out of the rim's plane,
                       // in rim radii. 0 is a flat pentagon
  boughJitter: 0.2,    // per-vertex radial jitter, half-range as a fraction of
                       // the rim radius. The stem takes it on top of its reach
  stemReach: 1.6,      // the stem vertex's distance from the centre, in rim
                       // radii, where every other rim vertex is at one
  boughAims: 24,       // openings tried per scoop, spread over a hemisphere
                       // about a pole drawn at random, see the header
  boughSpins: 4,       // body directions tried round the stem for each
  boughSkew: 0.3,      // the rim stretched by this along an axis of its own and
                       // squeezed by it across, as a fraction
  boughFrom: 0.15,     // the fraction of a branch nothing seats below
  tipBias: 1.6,        // the seat's draw along the branch is raised to 1/this,
                       // so past 1 the scoops crowd toward the tips
  tipZone: 0.2,        // scoops seated within this fraction of the tip may
                       // not run back down the branch. 0 turns it off
  boughKeep: 1,        // fraction of the scoops a tier builds -- a FRACTION
                       // KEPT, not a count, see the header

  // --- shading ---
  innerShade: 0.55,    // how dark the crown's lowest vertex is baked, as a
                       // multiple of the highest. 1 turns the ramp off
  boughTint: 0.08,     // per-scoop brightness jitter, half-range

  // --- material ---
  texMetres: 1.1,      // one leaf tile, in metres, laid flat in each scoop's
                       // own plane
  barkLayer: LAYER.BARK,
}

// ---------------------------------------------------------------------------
// The species bank, in the shape tree-v8.js keeps its own, so the bench can
// hold both. The defaults ARE the oak; the other two broadleaves are the same
// architecture with the limbs and the litter re-proportioned.
// ---------------------------------------------------------------------------
export const TREE_OAK_SPECIES = {
  oak: { label: 'oak', mat: OAK_MAT, params: {} },

  // ASPEN. A narrow column on a pole: more than half the tree is bare trunk,
  // and the limbs are short and pitched steeply up, so the scoops pile into a
  // spire rather than a spread. Small leaves, so the mat tiles at half the
  // oak's metres. No aspen bark in the atlas and none is wanted: aspen and
  // birch are both pale and lenticelled.
  aspen: {
    label: 'aspen',
    mat: '/trees/mat_aspen.png',
    params: {
      seed: 30917,
      height: 6,
      trunkSides: 9, trunkCrook: 0.05, trunkTop: 0.55, trunkRadius: 0.013, trunkTaper: 0.55, trunkLobe: 0.06,
      barkRepeat: 7,
      branchCrook: 0.45, branchRise: 0.2, branchBottom: 0.35, branchTopEnd: 0.95,
      branchLength: 0.12, branchPitch: 1.0, branchPitchVary: 0.2, branchRadius: 0.35, branchTaper: 0.3,
      boughs: 70, boughRadius: 0.05, boughDepth: 0.4,
      innerShade: 0.5, texMetres: 0.6,
      barkLayer: LAYER.BARK_BIRCH,
    },
  },

  // BIRCH. The pendulous one: the limbs leave reaching up and every joint
  // turns DOWN (`branchRise` below 0), so a limb arches over and hangs, and
  // the scoops hang off it at a longer stem. A slender white trunk under a
  // fine, open litter of small leaves.
  birch: {
    label: 'birch',
    mat: '/trees/mat_birch.png',
    params: {
      seed: 62755,
      height: 6,
      trunkSides: 9, trunkCrook: 0.08, trunkTop: 0.5, trunkRadius: 0.012, trunkTaper: 0.5, trunkLobe: 0.05,
      barkRepeat: 6,
      branches: 6, branchCrook: 0.5, branchRise: -0.25, branchBottom: 0.4, branchTopEnd: 0.9,
      branchLength: 0.16, branchPitch: 0.5, branchPitchVary: 0.25, branchRadius: 0.35, branchTaper: 0.3,
      boughs: 60, boughRadius: 0.05, boughDepth: 0.35, stemReach: 1.8,
      innerShade: 0.5, texMetres: 0.65,
      barkLayer: LAYER.BARK_BIRCH,
    },
  },
}

/** One species' full parameter set. Throws on a name that is not in the bank. */
export function treeOakSpecies(name) {
  const s = TREE_OAK_SPECIES[name]
  if (!s) {
    throw new Error(
      `treeOakSpecies: no species "${name}" -- the bank holds ${Object.keys(TREE_OAK_SPECIES).join(', ')}`
    )
  }
  return { ...TREE_OAK_DEFAULTS, ...s.params }
}

/**
 * The mesh ladder. Three tiers, and a fourth rung that is a baked card.
 *
 * LOD1 keeps three scoops in five and LOD2 one in four, each in LOD0's own
 * seat, and both take sides off the wood, whose rings stay on the same path.
 * Neither touches `boughs`, `branches` or any other count the rng walks --
 * see the header.
 */
export function treeOakLod(options, tier) {
  const p = { ...TREE_OAK_DEFAULTS, ...options }
  if (tier === 0) return p
  if (tier === 1) {
    return { ...p, boughKeep: Math.min(p.boughKeep, 0.6), trunkSides: Math.min(6, p.trunkSides), branchSides: Math.min(4, p.branchSides) }
  }
  if (tier === 2) return { ...p, boughKeep: Math.min(p.boughKeep, 0.25), trunkSides: Math.min(4, p.trunkSides), branchSides: 3 }
  throw new Error(
    `treeOakLod: no MESH tier ${tier}; the oak has LOD0, LOD1 and LOD2. The tier past ` +
      'them is one spun quad carrying a baked photograph, not a parameter set'
  )
}

const tubeTris = (segments, sides) => (segments - 1) * sides * 2 + sides
const BOUGH_TRIS = 5
const keptBoughs = (total, keep) => Math.round(total * Math.min(1, Math.max(0, keep)))

/**
 * Every triangle a parameter set implies, before any geometry exists.
 *
 *   trunk    = (trunkSegments - 1) x trunkSides x 2 + trunkSides
 *   branches = branches x ((branchSegments - 1) x branchSides x 2 + branchSides)
 *   boughs   = kept x 5, and none at all with no branch to stem from
 *
 * `boughs` is the KEPT count: a coarse tier draws every scoop and skips the
 * emit, so this is what reaches the buffer and not what the rng walked.
 */
export function resolveTreeOak(options = {}) {
  const p = { ...TREE_OAK_DEFAULTS, ...options }
  const trunkSides = Math.max(3, Math.round(p.trunkSides))
  const trunkSegments = Math.max(1, Math.round(p.trunkSegments))
  const branchSides = Math.max(3, Math.round(p.branchSides))
  const branchSegments = Math.max(1, Math.round(p.branchSegments))
  const branches = Math.max(0, Math.round(p.branches))
  const boughs = branches > 0 ? keptBoughs(Math.max(0, Math.round(p.boughs)), p.boughKeep) : 0
  const trunkTris = tubeTris(trunkSegments, trunkSides)
  const branchTris = branches * tubeTris(branchSegments, branchSides)
  const boughTris = boughs * BOUGH_TRIS
  return {
    trunkSides,
    trunkSegments,
    branchSides,
    branchSegments,
    branches,
    boughs,
    trunkTris,
    branchTris,
    boughTris,
    woodTris: trunkTris + branchTris,
    foliageTris: boughTris,
    triangles: trunkTris + branchTris + boughTris,
  }
}

// --- the wood ---------------------------------------------------------------

// A ring of `sides` corners at each of path[0..S-1], radius radii[r], closed to
// a point at path[S]. The seam corner is duplicated so u runs the whole way
// round, and the apex once per face at that face's own u, both as tree.js's
// addCone. `warp` is one multiplier per corner, the same at every ring, so the
// lobes run straight up the tube. `v` is arc length in tiles.
function addTube(out, path, radii, sides, warp, uRepeat, vPerMetre, layer) {
  const S = path.length - 1
  const base = out.positions.length / 3
  const stride = sides + 1
  const tangent = new THREE.Vector3()
  const prevSeg = new THREE.Vector3()
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const n = new THREE.Vector3()
  let v = 0
  for (let r = 0; r < S; r++) {
    // The tangent at a ring is the mean of the segments either side of it, so
    // the ring bisects the joint rather than sitting square on one segment and
    // cutting into the other.
    tangent.subVectors(path[r + 1], path[r]).normalize()
    if (r > 0) {
      prevSeg.subVectors(path[r], path[r - 1]).normalize()
      tangent.add(prevSeg).normalize()
      v += path[r].distanceTo(path[r - 1]) * vPerMetre
      // Rotation-minimising: carry the previous e1 over and take the tangent
      // back out of it, so the bark does not twist around a crook.
      e1.addScaledVector(tangent, -e1.dot(tangent))
      if (e1.lengthSq() < 1e-10) e1.set(-tangent.z, 0, tangent.x)
      e1.normalize()
    } else {
      e1.set(-tangent.z, 0, tangent.x)
      if (e1.lengthSq() < 1e-10) e1.set(1, 0, 0)
      e1.normalize()
    }
    e2.crossVectors(tangent, e1).normalize()
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * TAU
      const radius = radii[r] * (warp === null ? 1 : warp[k % sides])
      n.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a))
      out.positions.push(path[r].x + n.x * radius, path[r].y + n.y * radius, path[r].z + n.z * radius)
      out.normals.push(n.x, n.y, n.z)
      out.uvs.push((k / sides) * uRepeat, v)
      out.layers.push(layer)
    }
  }
  const apexV = v + path[S].distanceTo(path[S - 1]) * vPerMetre
  const apexBase = base + S * stride
  for (let k = 0; k < sides; k++) {
    const a = ((k + 0.5) / sides) * TAU
    n.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a))
    out.positions.push(path[S].x, path[S].y, path[S].z)
    out.normals.push(n.x, n.y, n.z)
    out.uvs.push(((k + 0.5) / sides) * uRepeat, apexV)
    out.layers.push(layer)
  }
  // Wound OUTWARD for the frame above: e2 = tangent x e1 puts the corners
  // counter-clockwise seen from the tube's outside going up.
  let tris = 0
  for (let r = 0; r < S - 1; r++) {
    for (let k = 0; k < sides; k++) {
      const a = base + r * stride + k
      out.indices.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride)
      tris += 2
    }
  }
  const lastBase = base + (S - 1) * stride
  for (let k = 0; k < sides; k++) {
    out.indices.push(lastBase + k, lastBase + k + 1, apexBase + k)
    tris++
  }
  return tris
}

// tree.js's lobe law: three cosine harmonics at random phase, capped at sides/3
// so a ring of `sides` corners can sample them, normalised so `trunkLobe` is
// the peak departure. Its own stream, so the bole's cross-section does not
// reroll its warp.
function lobeWarp(p, sides) {
  const amp = Math.max(0, p.trunkLobe)
  if (amp <= 0 || sides < 6) return null
  const rand = mulberry32((p.seed ^ 0x5bf03635) >>> 0)
  const top = Math.max(2, Math.floor(sides / 3))
  const harm = [
    { n: Math.min(top, 2 + Math.floor(rand() * 2)), a: 1, ph: rand() * TAU },
    { n: Math.min(top, 4 + Math.floor(rand() * 3)), a: 0.55, ph: rand() * TAU },
    { n: Math.min(top, 7 + Math.floor(rand() * 3)), a: 0.28, ph: rand() * TAU },
  ]
  const norm = harm.reduce((s, h) => s + h.a, 0)
  const warp = new Float32Array(sides)
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * TAU
    let v = 0
    for (const h of harm) v += h.a * Math.cos(h.n * a + h.ph)
    warp[k] = 1 + amp * (v / norm)
  }
  return warp
}

// Turn `dir` by `pitch` toward UP and by `yaw` about UP, in place. A joint's
// crook is one of these with both drawn; a branch's rise is one with only the
// pitch. Pitching is done about the horizontal axis perpendicular to `dir`; a
// vertical direction has none, and a yaw about UP would not move it either,
// so it tilts by `pitch` about the level axis at azimuth `az` instead -- how
// a bole leaves its axis at its first joint.
const turn = (() => {
  const axis = new THREE.Vector3()
  return (dir, pitch, yaw, az) => {
    axis.crossVectors(UP, dir)
    if (axis.lengthSq() < 1e-10) axis.set(Math.cos(az), 0, Math.sin(az))
    dir.applyAxisAngle(axis.normalize(), pitch)
    dir.applyAxisAngle(UP, yaw)
    return dir.normalize()
  }
})()

// A polyline of `segments` equal steps from `start` along `dir`, every joint
// after the first turning by its own draw under `crook` and by `rise` upward.
// The yaw's draw doubles as the azimuth a vertical direction tilts toward.
function crookedPath(rand, start, dir, length, segments, crook, rise) {
  const path = [start.clone()]
  const d = dir.clone()
  const step = length / segments
  for (let s = 0; s < segments; s++) {
    if (s > 0) {
      const pitch = (rand() * 2 - 1) * crook + rise
      const spin = rand()
      turn(d, pitch, (spin * 2 - 1) * crook, spin * TAU)
    }
    path.push(path[s].clone().addScaledVector(d, step))
  }
  return path
}

// --- the scoops -------------------------------------------------------------

const RIM = 5

// Where a fraction of a limb sits: the point, the tube's radius there and the
// segment's direction. The path is `segments` equal steps closing to a point
// at radius 0, so a fraction is an index and a remainder.
function limbAt(limb, f, at, dir) {
  const S = limb.path.length - 1
  const k = Math.min(1, Math.max(0, f)) * S
  const s = Math.min(S - 1, Math.floor(k))
  const t = k - s
  at.copy(limb.path[s]).lerp(limb.path[s + 1], t)
  dir.subVectors(limb.path[s + 1], limb.path[s]).normalize()
  const r1 = s + 1 < S ? limb.radii[s + 1] : 0
  return limb.radii[s] + (r1 - limb.radii[s]) * t
}

// One scoop seated: everything about it that is drawn, and the frame it will
// be aimed and shaped in. The stem is put ON the limb's surface at a drawn
// angle round the tube; a tip scoop's body direction is settled here, an
// ordinary scoop's is left to the aim. Every draw happens for every scoop, so
// the tip zone cannot shift the stream under the scoops after it.
function seatBough(limb, seat, rand, p, boughR) {
  const at = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const rad = limbAt(limb, seat, at, tangent)
  // The seat's own frame round the tube, and a direction on it.
  const e1 = new THREE.Vector3().crossVectors(UP, tangent)
  if (e1.lengthSq() < 1e-10) e1.set(1, 0, 0)
  e1.normalize()
  const e2 = new THREE.Vector3().crossVectors(tangent, e1)
  const a = rand() * TAU
  const q = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a))
  const stem = at.clone().addScaledVector(q, rad)
  // A tip scoop's body may not run back down the limb.
  const tip = seat >= 1 - Math.min(1, Math.max(0, p.tipZone))

  const jitter = Math.max(0, p.boughJitter)
  const r = boughR * (1 + (rand() * 2 - 1) * Math.max(0, p.boughVary))
  const reach = Math.max(0.05, p.stemReach) * (1 + (rand() * 2 - 1) * jitter)
  const skewAz = rand() * TAU
  const rimJitter = []
  for (let k = 1; k < RIM; k++) rimJitter.push(1 + (rand() * 2 - 1) * jitter)
  return {
    stem, q, tangent, e1, tip, r, reach, skewAz, rimJitter,
    u0: rand(),
    v0: rand(),
    tint: 1 + (rand() * 2 - 1) * Math.max(0, p.boughTint),
  }
}

// A seated scoop shaped, opening along `n` with its body running off the stem
// along `body`: its six vertices in world space and the frame they were built
// in. The stem is rim vertex 0; the centre is `reach` rim radii back from it
// along `h` and `depth` radii down along `n`; the other four rim corners go
// round from `h` at even angles, each at its own jittered radius, stretched
// by the skew.
function shapeBough(s, n, body, p) {
  // The reach is the body flattened into the opening's plane. One with
  // nothing left there takes the limb's own direction instead, and failing
  // that any direction square to the opening.
  const h = body.clone().negate()
  h.addScaledVector(n, -h.dot(n))
  if (h.lengthSq() < 0.04) h.copy(s.tangent).addScaledVector(n, -s.tangent.dot(n))
  if (h.lengthSq() < 1e-6) h.crossVectors(n, s.e1)
  h.normalize()
  const f2 = new THREE.Vector3().crossVectors(n, h)

  const { r, stem } = s
  const skew = Math.min(0.9, Math.max(0, p.boughSkew))
  const rimCentre = stem.clone().addScaledVector(h, -r * s.reach)
  const centre = rimCentre.clone().addScaledVector(n, -r * Math.max(0, p.boughDepth))
  const verts = [centre, stem]
  // The skew is a stretch along one axis and a squeeze across it, applied to
  // ALL five rim directions -- the stem's too, or a hard skew could carry a
  // neighbour across it and turn a face over. The stem then has to come out
  // along `h` to land on the wood, so the plane is spun by wherever the skew
  // put the stem's direction.
  const cs = Math.cos(s.skewAz)
  const ss = Math.sin(s.skewAz)
  const skewed = (phi) => {
    const x = Math.cos(phi)
    const y = Math.sin(phi)
    const sx = (x * cs + y * ss) * (1 + skew)
    const sy = (-x * ss + y * cs) * (1 - skew)
    return [sx * cs - sy * ss, sx * ss + sy * cs]
  }
  const [s0x, s0y] = skewed(0)
  const spin = -Math.atan2(s0y, s0x)
  const cr = Math.cos(spin)
  const sr = Math.sin(spin)
  for (let k = 1; k < RIM; k++) {
    const m = s.rimJitter[k - 1]
    const [ux, uy] = skewed((k / RIM) * TAU)
    const x = ux * cr - uy * sr
    const y = ux * sr + uy * cr
    verts.push(rimCentre.clone().addScaledVector(h, r * m * x).addScaledVector(f2, r * m * y))
  }
  return { verts, n, h, f2, rimCentre, u0: s.u0, v0: s.v0, tint: s.tint }
}

// How far, in rim radii, a placed scoop's centre counts as a neighbour, and
// how far a body may run back into the tube it hangs off (the cosine against
// the seat's outward direction) before that spin is skipped.
const NEAR = 3
const INTO_TUBE = -0.2
const GOLDEN = Math.PI * (3 - Math.sqrt(5))

// An orthonormal pair square to `axis`, into `u` and `w`.
function frameAbout(axis, u, w) {
  u.crossVectors(axis, UP)
  if (u.lengthSq() < 1e-10) u.set(1, 0, 0)
  u.normalize()
  w.crossVectors(axis, u)
}

// One scoop placed: seated, then aimed against the scoops before it, per the
// header. The openings tried are a Fibonacci spread over the hemisphere about
// a pole drawn off the whole sphere, turned by a drawn phase, and the spins
// start from a drawn angle, so no two scoops try the same set and a scoop
// with no neighbour to answer lands at random. The four draws here come off
// their own stream so no aim knob reseats a scoop. `placed` is every scoop
// laid out so far, as {centre, n}.
function layoutBough(limb, seat, rand, aimRand, placed, p, boughR) {
  const s = seatBough(limb, seat, rand, p, boughR)
  const poleY = aimRand() * 2 - 1
  const poleAz = aimRand() * TAU
  const phase = aimRand() * TAU
  const spinPhase = aimRand() * TAU
  const aims = Math.max(1, Math.round(p.boughAims))
  const spins = Math.max(1, Math.round(p.boughSpins))
  const near = NEAR * boughR
  const poleR = Math.sqrt(1 - poleY * poleY)
  const pole = new THREE.Vector3(poleR * Math.cos(poleAz), poleY, poleR * Math.sin(poleAz))

  const n = new THREE.Vector3()
  const body = new THREE.Vector3()
  const u = new THREE.Vector3()
  const w = new THREE.Vector3()
  const bu = new THREE.Vector3()
  const bw = new THREE.Vector3()
  let best = null
  let bestCost = Infinity
  const consider = () => {
    const bough = shapeBough(s, n.clone(), body, p)
    let cost = 0
    for (const other of placed) {
      const d = bough.rimCentre.distanceTo(other.centre)
      if (d < near) cost += (1 - d / near) * Math.abs(n.dot(other.n))
    }
    if (cost < bestCost) { best = bough; bestCost = cost }
  }
  frameAbout(pole, u, w)
  // A body back into the tube, or back down the limb at a tip, is skipped;
  // only a few spins can leave nothing, and then the second pass takes the
  // best regardless.
  for (let pass = 0; pass < 2 && best === null; pass++) {
    for (let k = 0; k < aims; k++) {
      const z = (k + 0.5) / aims
      const rr = Math.sqrt(1 - z * z)
      const th = phase + k * GOLDEN
      n.copy(pole).multiplyScalar(z).addScaledVector(u, rr * Math.cos(th)).addScaledVector(w, rr * Math.sin(th))
      frameAbout(n, bu, bw)
      for (let j = 0; j < spins; j++) {
        const sp = spinPhase + (j / spins) * TAU
        body.copy(bu).multiplyScalar(Math.cos(sp)).addScaledVector(bw, Math.sin(sp))
        if (pass === 0 && (body.dot(s.q) < INTO_TUBE || (s.tip && body.dot(s.tangent) < 0))) continue
        consider()
      }
    }
  }
  placed.push({ centre: best.rimCentre, n: best.n })
  return best
}

// One laid-out scoop into the foliage buffers: five triangles fanned from the
// centre, unwelded and flat-shaded off each face's own cross product, the mat
// laid flat in the rim's own plane at the scoop's own offset. The rim goes
// round counter-clockwise seen from the opening, so every face's cross
// product has a positive part along `n`; the STORED normal is that cross
// turned to the sky side, since the material lights both faces off it and a
// dome lit from underneath would shade itself.
function addBough(out, bough, tex) {
  const [c] = bough.verts
  const fn = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const rel = new THREE.Vector3()
  for (let k = 0; k < RIM; k++) {
    const a = bough.verts[1 + k]
    const b = bough.verts[1 + ((k + 1) % RIM)]
    fn.crossVectors(ab.subVectors(a, c), ac.subVectors(b, c)).normalize()
    if (fn.y < 0) fn.negate()
    for (const q of [c, a, b]) {
      out.positions.push(q.x, q.y, q.z)
      out.normals.push(fn.x, fn.y, fn.z)
      rel.subVectors(q, bough.rimCentre)
      out.uvs.push(bough.u0 + rel.dot(bough.h) / tex, bough.v0 + rel.dot(bough.f2) / tex)
      out.tint.push(bough.tint)
    }
  }
  return RIM
}

// --- the tree ---------------------------------------------------------------

/**
 * The whole tree: the wood as one geometry, the crown as another, and the
 * numbers that describe them. Built at `height` and rescaled so the crown's
 * top lands there -- see the header.
 */
export function buildTreeOak(options = {}) {
  const p = { ...TREE_OAK_DEFAULTS, ...options }
  const H = p.height
  const R = resolveTreeOak(p)
  // Four streams, so a slider on one part of the tree cannot reroll another:
  // dragging `branches` must not move the bole's warp, dragging a scoop knob
  // must not move a branch, and dragging an aim knob must not resize one.
  const trunkRand = mulberry32(p.seed)
  const branchRand = mulberry32((p.seed ^ 0x27d4eb2f) >>> 0)
  const boughRand = mulberry32((p.seed ^ 0x85ebca6b) >>> 0)
  const aimRand = mulberry32((p.seed ^ 0xc2b2ae35) >>> 0)

  const wood = { positions: [], normals: [], uvs: [], layers: [], indices: [] }
  const tex = Math.max(0.05, p.texMetres)

  // --- the bole ---
  const trunkR = p.trunkRadius * H
  const boleLen = Math.max(1e-3, p.trunkTop) * H
  // Every joint, including the first, draws from the stream, so `trunkCrook` at
  // 0 walks the same stream as at 0.1 and the branches above keep their own
  // draws; they ride the bole to wherever the crook puts their launch.
  const trunkPath = crookedPath(trunkRand, new THREE.Vector3(), UP.clone(), boleLen, R.trunkSegments, p.trunkCrook, 0)
  const trunkRadii = new Float64Array(R.trunkSegments)
  for (let r = 0; r < R.trunkSegments; r++) {
    const f = R.trunkSegments === 1 ? 0 : r / (R.trunkSegments - 1)
    trunkRadii[r] = trunkR * (1 + (Math.max(0, p.trunkTaper) - 1) * f)
  }
  const trunkURepeat = Math.max(1, Math.round((TAU * trunkR * p.barkRepeat) / H))
  // One tile is boleLen / barkRepeat metres tall.
  const vPerMetre = p.barkRepeat / boleLen
  const warp = lobeWarp(p, R.trunkSides)
  let trunkTris = 0
  if (trunkR > 0) trunkTris = addTube(wood, trunkPath, trunkRadii, R.trunkSides, warp, trunkURepeat, vPerMetre, p.barkLayer)

  // Where along the bole a fraction sits, and the bole's radius there. The
  // path is `trunkSegments` equal steps, so a fraction is an index and a
  // remainder.
  const boleAt = (f, into) => {
    const k = Math.min(1, Math.max(0, f)) * R.trunkSegments
    const s = Math.min(R.trunkSegments - 1, Math.floor(k))
    return into.copy(trunkPath[s]).lerp(trunkPath[s + 1], k - s)
  }
  const boleRadiusAt = (f) => trunkR * (1 + (Math.max(0, p.trunkTaper) - 1) * Math.min(1, Math.max(0, f)))

  // --- the branches ---
  // Each kept as its path and ring radii: the scoops seat anywhere along one.
  const limbs = []
  let branchTris = 0
  const launch = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const outward = new THREE.Vector3()
  const stepAz = R.branches > 0 ? TAU / R.branches : 0
  const yaw0 = branchRand() * TAU
  for (let b = 0; b < R.branches; b++) {
    // Up the bole in order, each in its own slot with a jitter inside it, so
    // five branches are five heights and never a ring.
    const slot = (p.branchTopEnd - p.branchBottom) / R.branches
    const f = p.branchBottom + slot * (b + 0.25 + branchRand() * 0.5)
    const az = yaw0 + b * stepAz + (branchRand() - 0.5) * p.branchSpread * stepAz
    const pitch = p.branchPitch + (branchRand() * 2 - 1) * p.branchPitchVary
    const len = p.branchLength * H * (1 - branchRand() * Math.max(0, p.branchVary))
    outward.set(Math.cos(az), 0, Math.sin(az))
    dir.copy(outward).multiplyScalar(Math.cos(pitch)).addScaledVector(UP, Math.sin(pitch)).normalize()
    // The butt sits INSIDE the bole, most of a radius in, so a lobed or warped
    // surface never shows a gap under it.
    const butt = boleRadiusAt(f)
    boleAt(f, launch).addScaledVector(outward, butt * 0.4)
    const path = crookedPath(branchRand, launch, dir, len, R.branchSegments, p.branchCrook, p.branchRise)
    const r0 = butt * Math.max(0, p.branchRadius)
    const radii = new Float64Array(R.branchSegments)
    for (let r = 0; r < R.branchSegments; r++) {
      const t = R.branchSegments === 1 ? 0 : r / (R.branchSegments - 1)
      radii[r] = r0 * (1 + (Math.max(0, p.branchTaper) - 1) * t)
    }
    const uRepeat = Math.max(1, Math.round((TAU * r0 * p.barkRepeat) / H))
    if (r0 > 0) branchTris += addTube(wood, path, radii, R.branchSides, null, uRepeat, vPerMetre, p.barkLayer)
    limbs.push({ path, radii })
  }

  // --- the scoops: layout first, emit after, because the shade ramp and the
  // rescale need the crown's extent ---
  // Every scoop drawn, kept or not: the extent below has to see the ones a
  // coarse tier skips, or that tier would rescale to a different top, and the
  // neighbours each scoop is aimed against are the ones before it in this
  // order, so a coarse tier's prefix is aimed exactly as LOD0 aimed it.
  const drawn = []
  const placed = []
  const boughR = p.boughRadius * H
  const nBoughs = Math.max(0, Math.round(p.boughs))
  const from = Math.min(1, Math.max(0, p.boughFrom))
  const bias = 1 / Math.max(0.05, p.tipBias)
  if (limbs.length > 0) {
    for (let i = 0; i < nBoughs; i++) {
      const limb = limbs[Math.floor(boughRand() * limbs.length)]
      const seat = from + (1 - from) * Math.pow(boughRand(), bias)
      drawn.push(layoutBough(limb, seat, boughRand, aimRand, placed, p, boughR))
    }
  }
  const boughs = drawn.slice(0, R.boughs)

  // --- extents, then the rescale ---
  // The top is whatever stands highest, a branch tip included: a limb can
  // climb past every scoop on it. The base is the crown's alone, for the ramp.
  let topY = 0
  for (let i = 1; i < wood.positions.length; i += 3) topY = Math.max(topY, wood.positions[i])
  let baseY = Infinity
  for (const b of drawn) {
    for (const v of b.verts) {
      topY = Math.max(topY, v.y)
      baseY = Math.min(baseY, v.y)
    }
  }
  const scale = topY > 1e-6 ? H / topY : 1

  // --- emit the foliage ---
  const leaf = { positions: [], normals: [], uvs: [], tint: [] }
  let boughTris = 0
  for (const b of boughs) boughTris += addBough(leaf, b, tex)

  // The shade ramp, over the crown's layout extent, then the per-scoop tint.
  const inner = Math.min(1, Math.max(0, p.innerShade))
  const nLeaf = leaf.positions.length / 3
  const shades = new Float32Array(nLeaf * 3)
  const crownSpan = Math.max(1e-6, topY - baseY)
  for (let i = 0; i < nLeaf; i++) {
    const t = Math.min(1, Math.max(0, (leaf.positions[i * 3 + 1] - baseY) / crownSpan))
    const s = (inner + (1 - inner) * t) * leaf.tint[i]
    shades[i * 3] = s
    shades[i * 3 + 1] = s
    shades[i * 3 + 2] = s
  }

  // The rescale, positions and the metre-based uvs alike, so a tile stays
  // `texMetres` in the world the tree is drawn into.
  const scaleXYZ = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] *= scale }
  scaleXYZ(wood.positions)
  scaleXYZ(leaf.positions)
  scaleXYZ(leaf.uvs)
  // Bark: u is a count of tiles around and stays; v is tiles along a length
  // that just grew.
  for (let i = 1; i < wood.uvs.length; i += 2) wood.uvs[i] *= scale

  const trunk = new THREE.BufferGeometry()
  trunk.setAttribute('position', new THREE.Float32BufferAttribute(wood.positions, 3))
  trunk.setAttribute('normal', new THREE.Float32BufferAttribute(wood.normals, 3))
  trunk.setAttribute('uvProj', new THREE.Float32BufferAttribute(wood.uvs, 2))
  trunk.setAttribute('texLayer', new THREE.Float32BufferAttribute(wood.layers, 1))
  trunk.setIndex(wood.indices)
  trunk.computeBoundingBox()
  trunk.computeBoundingSphere()

  const foliage = new THREE.BufferGeometry()
  foliage.setAttribute('position', new THREE.Float32BufferAttribute(leaf.positions, 3))
  foliage.setAttribute('normal', new THREE.Float32BufferAttribute(leaf.normals, 3))
  foliage.setAttribute('uv', new THREE.Float32BufferAttribute(leaf.uvs, 2))
  // Grey, so it multiplies the mat without tinting it; the material has to be
  // built with vertexColors on to read it at all.
  foliage.setAttribute('color', new THREE.BufferAttribute(shades, 3))
  // Identity index: unwelded by construction, indexed because BatchedMesh
  // takes nothing else.
  const index = new Uint32Array(nLeaf)
  for (let i = 0; i < nLeaf; i++) index[i] = i
  foliage.setIndex(new THREE.BufferAttribute(index, 1))
  foliage.computeBoundingBox()
  foliage.computeBoundingSphere()

  const fb = foliage.boundingBox
  const tb = trunk.boundingBox
  const crownWidth = nLeaf > 0 ? Math.max(fb.max.x - fb.min.x, fb.max.z - fb.min.z) : 0
  const stats = {
    height: Math.max(nLeaf > 0 ? fb.max.y : 0, wood.positions.length > 0 ? tb.max.y : 0),
    belowGround: -Math.min(0, nLeaf > 0 ? fb.min.y : 0, wood.positions.length > 0 ? tb.min.y : 0),
    trunkDiameter: 2 * trunkR * scale,
    boleHeight: trunkPath[R.trunkSegments].y * scale,
    crownWidth,
    crownBase: nLeaf > 0 ? fb.min.y : 0,
    crownTop: nLeaf > 0 ? fb.max.y : 0,
    trunkTris,
    branchTris,
    boughTris,
    woodTris: trunkTris + branchTris,
    foliageTris: boughTris,
    branches: limbs.length,
    boughs: boughs.length,
    triangles: trunkTris + branchTris + boughTris,
    vertices: wood.positions.length / 3 + nLeaf,
  }
  trunk.userData.tree = stats
  foliage.userData.foliage = stats
  return { trunk, foliage, stats }
}
