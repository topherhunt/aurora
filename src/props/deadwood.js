import * as THREE from 'three'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural dead wood: standing snags, and fallen logs.
//
// These are the forest's LITTER -- the things that hem a path off, break a
// sightline at knee height and tell you a wood has been standing long enough for
// something in it to have died. There are two of them and they are ONE
// generator, because a snag is a log stood on end with a broken top and a log is
// a snag lying down. Everything below builds a tapered tube swept along a
// crooked spine, caps both ends, hangs a couple of broken branch stubs off it,
// and then either leaves it standing or lays it over. `kind` decides that last
// step and nothing else.
//
// Four decisions carry the file.
//
// 1. THE SURFACE IS A PURE FUNCTION OF (t, a).
//
// `radiusAt(t, a)` -- distance along the spine, angle around it -- is
// deterministic and stateless, and every tier evaluates the same function on
// fewer rings and fewer sides. This is rock.js's lesson transplanted, and it
// buys the same thing: a tier change loses FACETS rather than swapping in a
// different log. It is a stronger promise here than it is for a rock, because a
// tube is a much better-behaved surface than a displaced sphere -- an 8-sided
// log and a 3-sided one have the same silhouette width everywhere, so the
// sampling gain rock.js has to correct for does not arise at all.
//
// It also means the shape can be interrogated without building it, which is
// what lets the bench print a triangle count and a bark fraction before a single
// vertex is emitted.
//
// 2. THE CROSS-SECTION IS NOT A CIRCLE, AND THE SPINE IS NOT A LINE.
//
// tree.js builds a living trunk as a perfectly round cone tapering to a point,
// with one quadratic lean and no surface relief at all -- and it is right to,
// because a live trunk is mostly hidden by its own canopy and the eye is on the
// crown. Dead wood has no crown. It is looked AT, from two metres away, and a
// lathe-turned cone reads as a fence post.
//
// So: `ovality` and `lobes` make the section an irregular polygon that varies
// with height; `swell` puts burls and waists along the length; `checks` cuts the
// long radial splits that open up as a dead trunk dries; `kink` bends the spine
// in two harmonics rather than one, so the thing is CROOKED rather than merely
// leaning. Every one of them is a closed-form function of (t, a) with an integer
// angular period, which is what keeps the seam closing exactly and keeps
// promise 1 true.
//
// 3. BARK COMES OFF, AND WHERE IT HAS GONE THE SURFACE DROPS.
//
// This is the whole of what makes dead wood read as dead. `barkAt(t, a)` is a
// wrapped two-dimensional value-noise field on the cylinder; where it is high
// the face wears the species' bark layer, and where it is low the face wears
// LAYER.TIMBER_BEAM -- the weathered baulk the buildings are made of, checks and
// splits already in it. The layer choice is per FACE, which is the only reason
// this geometry is non-indexed.
//
// And the surface drops by `barkThick` where the bark is missing, so the
// boundary is a real STEP in the silhouette rather than a change of colour. Bark
// on a dead conifer is two to four centimetres thick and it comes away in
// sheets; the step is what your eye reads as a sheet having come away.
//
// NO NEW TEXTURE LAYERS. Bark is the species layer the living trees already
// wear, exposed wood is the beam the buildings already wear, and moss and snow
// are the shared material's own uniforms. A snag and a log cost this file and
// nothing else on disk.
//
// 4. IT SITS ON THE GROUND BY BEING CUT OFF AT IT.
//
// `sink` drops the piece below y = 0 and everything under the plane is clamped
// UP onto it, which is rock.js's `sit` and works here for the same reason: a log
// pressed into forest duff is flat where it presses, and a bowed log that
// touches at two points would otherwise arch over a visible gap in the middle.
// The cost is a ribbon of degenerate faces along the contact line, which take
// the shell normal because they have no usable face normal of their own.
//
// ATTRIBUTES: always { position, normal, uvProj, texLayer }, non-indexed with an
// identity index -- the shared prop material's layout (src/material.js), which
// BatchedMesh validates and refuses the whole batch over.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

// The mesh tiers, finest first. Unlike the rock ladder these are not different
// SOLIDS, they are the same swept surface at different sampling rates, so there
// is nothing to measure and nothing to correct: `sides` is how many facets go
// round, `ringMul` scales the ring count along the spine, and `stubMul` is what
// fraction of the branch stubs survive.
//
// A COARSER TIER LOSES SIDES, NOT RINGS. Both directions are cheap to cut and
// they are not worth the same. Sides buy ROUNDNESS, which at any distance a
// coarse tier is used at is doing almost nothing -- a 5-sided trunk and an
// 8-sided one are the same trunk. Rings buy the SPINE, and the spine is the
// crookedness that is most of what separates dead wood from a fence post; on a
// fallen log it is also most of the silhouette, because an 8.5 m log's bend
// wanders further sideways than the log is thick. Cut the rings and a bowed log
// straightens into dowel: measured on `log-long`, dropping to one ring took its
// plan width from 1.03 m to 0.63 m, which is not the same object at any
// distance. So T1 keeps every ring and T2 keeps half of them.
//
// T2 keeps three sides on purpose. A two-sided tube is a folded card and reads
// as one; three is the smallest section that still has a lit face, a shaded face
// and a silhouette that turns with the camera, which is exactly the argument
// ROCK_TIERS makes for keeping an octahedron rather than a tetrahedron.
//
// Stubs go first, at T1, and that is the one place a tier deliberately loses
// something rather than coarsening it. A 15 cm stub on a 4 m snag is under two
// pixels at the distance T1 starts at, and it costs three triangles each -- a
// sixth of the whole budget for something nobody can resolve.
export const DEADWOOD_TIERS = [
  { name: 'T0', sides: 8, ringMul: 1.0, stubMul: 1.0 },
  { name: 'T1', sides: 5, ringMul: 1.0, stubMul: 0.0 },
  { name: 'T2', sides: 3, ringMul: 0.5, stubMul: 0.0 },
]

// DESIGN.md §5's prop table puts stumps and logs in the `bush` row. The row
// predates this generator, so it is a target and not a law -- but it is the
// number the world was budgeted against, and a tier that runs over has to do it
// on purpose. The bench prints this beside what was actually built.
export const BUDGET_TRIS = [84, 56, 28]

export const DEADWOOD_DEFAULTS = {
  seed: 1,

  // 'snag' stands the piece up on its butt; 'log' lays it down. It is the LAST
  // thing that happens -- everything above the placement is shared -- so the two
  // are the same shape seen from two attitudes, and a slider found on one is
  // worth the same on the other.
  kind: 'snag',
  tier: 0,

  // --- size, in real metres --------------------------------------------------
  // Absolute rather than relative, which is the opposite of rock.js's choice and
  // for the opposite reason. Nobody knows how big a rock is, so a rock is
  // authored in relative units and fitted to the scenery; EVERYBODY knows how
  // big a log is, and a 0.9 m trunk lying across a path is a different object
  // from a 0.3 m one rather than the same object closer up.
  length: 3.2, // along the spine: a snag's height, a log's length
  butt: 0.42, // DIAMETER at the base, in metres
  taper: 0.34, // fraction of the butt diameter lost by the far end. Never 1: dead wood is broken off, not sharpened

  // --- the spine -------------------------------------------------------------
  bend: 0.05, // quadratic lean in one azimuth, as a fraction of length -- tree.js's trunkBend
  kink: 0.035, // two harmonics on top of it, so the thing is crooked rather than merely leaning
  kinkFreq: 3.1, // cycles of the first harmonic over the whole length

  // --- the cross-section -----------------------------------------------------
  // A live trunk can be a circle because its canopy hides it. These are what
  // stop a dead one reading as a fence post; see note 2 in the header.
  ovality: 0.12, // 2-lobe: the section is an ellipse, rolled to a per-seed azimuth
  lobes: 0.07, // 3- and 5-lobe on top of that, so it is an irregular polygon rather than an ellipse
  swell: 0.09, // burls and waists ALONG the length
  swellFreq: 2.2,

  // --- rot -------------------------------------------------------------------
  bark: 0.62, // fraction of the surface still wearing bark. 0 = stripped to the wood, 1 = intact
  barkPatch: 2.6, // how large the sheets are that come away. Higher = smaller patches
  barkThick: 0.022, // metres the surface drops where the bark has gone -- the step that reads in silhouette
  checks: 3, // long radial splits running the length, as a count. 0 = none
  checkDepth: 0.09, // how far they bite, as a fraction of the radius

  // --- the broken ends -------------------------------------------------------
  // `0` is the butt, `1` is the far end. A standing snag wants a flat bedded
  // butt and a savage top; a log broken out of the middle of a trunk wants both
  // ends ragged; a log that fell with its root plate wants a huge flared butt
  // and a clean break at the other end.
  jag0: 0.0, // how far the rim wanders along the spine, as a fraction of length
  jag1: 0.16,
  jagCount: 5, // how many splinters go round
  cup0: 0.0, // how far the end face is pulled INTO the piece, as a fraction of its own radius
  cup1: 0.45, // a rotten heart is dished; a sound break is flat

  // --- the root flare --------------------------------------------------------
  // tree.js has none of this, and can afford not to: the bottom half metre of a
  // living trunk is behind ferns. A snag IS its bottom half metre.
  flare: 0.55, // extra radius at the very base, as a fraction of the butt
  flareRun: 0.22, // over what fraction of the length it dies away

  // --- branch stubs ----------------------------------------------------------
  stubs: 2,
  stubStart: 0.35, // fraction of the length below which no stub grows
  stubLength: 0.9, // as a multiple of the local DIAMETER
  stubRadius: 0.3, // as a fraction of the local trunk radius
  stubRise: 0.35, // radians above horizontal. Dead stubs droop toward horizontal; live branches rise
  stubSides: 3,

  // --- how it meets the ground -----------------------------------------------
  sink: 0.18, // fraction of the butt RADIUS pushed below y = 0 and clamped back up
  roll: 0, // LOG ONLY: spin about the log's own axis, so the flare and the checks land somewhere
  pitch: 0.06, // LOG ONLY: radians off horizontal -- one end resting on something

  // --- surface and skin ------------------------------------------------------
  smooth: 0.8, // 0 = every face flat, 1 = one smooth shell. End faces stay flat at any setting
  texMetres: 0.62, // world metres one tile covers ALONG the piece
  barkLayer: LAYER.BARK,
  woodLayer: LAYER.TIMBER_BEAM,

  rings: 3, // ring count along the spine at T0
}

// --- the bank ---------------------------------------------------------------
//
// What the world actually ships, and the reason it lives here rather than in the
// bench: a preset table only the previewer could see would let the shape signed
// off and the shape placed drift apart, which is the one failure a bench exists
// to prevent. rock-bank.js makes the same argument at greater length.
//
// Eight entries, and they are chosen to span the two things that decide how a
// piece READS rather than to span the parameter space: how much of it is left
// (a whole trunk, a broken section, a stump) and how far gone it is (bark on,
// bark off, heart dished out).
export const DEADWOOD_VARIANTS = {
  'snag-tall': {
    envs: ['pine forest', 'burn'],
    p: { kind: 'snag', length: 5.4, butt: 0.38, taper: 0.42, bark: 0.5, jag1: 0.2, cup1: 0.3, flare: 0.4, stubs: 3, checks: 4, barkLayer: LAYER.BARK_PINE },
  },
  'snag-stout': {
    envs: ['old growth', 'wood'],
    p: { kind: 'snag', length: 2.4, butt: 0.68, taper: 0.22, bark: 0.4, jag1: 0.22, cup1: 0.6, flare: 0.7, swell: 0.14, stubs: 2 },
  },
  'snag-spike': {
    envs: ['burn', 'ridge'],
    p: { kind: 'snag', length: 3.8, butt: 0.3, taper: 0.55, bark: 0.12, jag1: 0.3, jagCount: 7, cup1: 0.2, flare: 0.35, checks: 5, checkDepth: 0.14, stubs: 1 },
  },
  stump: {
    envs: ['wood', 'clearing', 'path side'],
    // The one entry that is NOT broken off high. A stump is what is left when
    // something took the tree away, so it is wide, short, heavily flared, and the
    // moss reaches all of it -- the height cue in material.js never bites.
    p: { kind: 'snag', length: 0.7, butt: 0.72, taper: 0.1, bark: 0.55, jag1: 0.1, cup1: 0.5, flare: 0.85, flareRun: 0.5, stubs: 0, sink: 0.3 },
  },
  'log-long': {
    envs: ['wood', 'path side'],
    p: { kind: 'log', length: 8.5, butt: 0.5, taper: 0.4, bark: 0.6, jag0: 0.05, jag1: 0.09, cup0: 0.2, cup1: 0.25, flare: 0.3, bend: 0.03, kink: 0.045, stubs: 3, pitch: 0.04 },
  },
  'log-mossy': {
    envs: ['old growth', 'stream bank'],
    p: { kind: 'log', length: 4.6, butt: 0.62, taper: 0.18, bark: 0.18, barkPatch: 1.9, jag0: 0.08, jag1: 0.12, cup0: 0.35, cup1: 0.4, flare: 0.25, swell: 0.15, sink: 0.34, stubs: 1 },
  },
  'log-broken': {
    envs: ['wood', 'burn'],
    // A section out of the middle of a trunk: both ends are breaks, neither is a
    // root and neither is a top, so jag and cup are symmetric.
    p: { kind: 'log', length: 3.0, butt: 0.44, taper: 0.08, bark: 0.45, jag0: 0.2, jag1: 0.2, cup0: 0.45, cup1: 0.45, flare: 0, flareRun: 0.1, checks: 4, stubs: 1, pitch: 0.1 },
  },
  'log-root': {
    envs: ['blowdown', 'stream bank'],
    // Blown over rather than broken: the root plate came up with it, so the butt
    // is enormous and ragged and the far end is a clean snap.
    p: { kind: 'log', length: 6.2, butt: 0.52, taper: 0.46, bark: 0.66, jag0: 0.26, jagCount: 7, cup0: 0.1, jag1: 0.06, cup1: 0.3, flare: 1.1, flareRun: 0.16, stubs: 2, roll: 0.7 },
  },
}

/**
 * A full parameter set for a named variant, on a given seed.
 *
 * Everything the variant does not name goes back to DEADWOOD_DEFAULTS rather
 * than surviving from whatever was on screen before -- a preset that inherited
 * half of the last one is not a shape anybody can sign off. Same contract as
 * rockParams.
 */
export function deadwoodParams(name, seed = 1) {
  const v = DEADWOOD_VARIANTS[name]
  if (!v) throw new Error(`deadwoodParams: no variant named ${name}`)
  return { ...DEADWOOD_DEFAULTS, ...v.p, seed }
}

// --- noise on a cylinder -----------------------------------------------------
//
// Value noise on an (angle, height) lattice that WRAPS in angle and clamps in
// height. The wrap is the whole trick and it is not optional here the way it is
// on the bench ground: without it every bark patch is cut in half by a seam
// running the length of the log, at the one angle the UV seam is also at, and
// the two together read as a stripe painted down the trunk.
//
// Same shape as preview-stage.js's `lattice`, one dimension wrapped instead of
// two, kept here rather than shared because that one takes a square tile and
// this one takes a cylinder.
function cylLattice(rand, na, nt) {
  const v = new Float32Array(na * (nt + 1))
  for (let i = 0; i < v.length; i++) v[i] = rand()
  const smooth = (x) => x * x * (3 - 2 * x)
  return (t, a) => {
    const fa = (a / TAU) * na
    const ft = Math.min(1, Math.max(0, t)) * nt
    const ia = Math.floor(fa)
    const it = Math.min(nt - 1, Math.floor(ft))
    const a0 = ((ia % na) + na) % na
    const a1 = (a0 + 1) % na
    const ta = smooth(fa - ia)
    const tt = smooth(ft - it)
    const p = v[it * na + a0]
    const q = v[it * na + a1]
    const r = v[(it + 1) * na + a0]
    const s = v[(it + 1) * na + a1]
    return (p + (q - p) * ta) * (1 - tt) + (r + (s - r) * ta) * tt
  }
}

// The same thing in one dimension, for the splinters around a broken end. Wraps,
// for the same reason.
function ringLattice(rand, n) {
  const v = new Float32Array(n)
  for (let i = 0; i < n; i++) v[i] = rand()
  const smooth = (x) => x * x * (3 - 2 * x)
  return (a) => {
    const f = (a / TAU) * n
    const i = Math.floor(f)
    const i0 = ((i % n) + n) % n
    const i1 = (i0 + 1) % n
    const t = smooth(f - i)
    return v[i0] + (v[i1] - v[i0]) * t
  }
}

// ---------------------------------------------------------------------------
// The shape, as pure functions.
//
// `shapeOf` closes over the parameters and the seeded fields and returns the
// three functions every tier evaluates. Nothing in here touches a buffer, knows
// how many sides it will be sampled on, or draws from a random stream -- which
// is what makes the tiers the same piece of wood and what lets the bench predict
// a triangle count without building anything.
// ---------------------------------------------------------------------------
function shapeOf(p) {
  // Four independent streams, tree.js's lesson: a shared stream means adding any
  // new cosmetic knob shifts every draw downstream of it, so tuning `stubs`
  // silently reshuffles the bark. `shape` draws the per-seed phases, `bark` the
  // sheet field, `jag` the splinters, `stub` the branch placement.
  const rand = mulberry32(p.seed >>> 0)
  const barkRand = mulberry32((p.seed ^ 0x9e3779b9) >>> 0)
  const jagRand = mulberry32((p.seed ^ 0x85ebca6b) >>> 0)

  const L = Math.max(0.05, p.length)
  const r0 = Math.max(0.01, p.butt) * 0.5

  const bendAz = rand() * TAU
  const kinkAz = rand() * TAU
  const kp0 = rand() * TAU
  const kp1 = rand() * TAU
  const ovalPhase = rand() * TAU
  const lp0 = rand() * TAU
  const lp1 = rand() * TAU
  const sp0 = rand() * TAU
  const sp1 = rand() * TAU
  const checkPhase = rand() * TAU

  // Bark sheets. The lattice is sized so the patches are roughly square on the
  // surface: `barkPatch` cells per metre of circumference, and the same density
  // along the length. Rounded up to at least 3 around, because a two-cell wrap
  // has only one independent value and gives a barber pole.
  const na = Math.max(3, Math.round(TAU * r0 * p.barkPatch * 2.2))
  const nt = Math.max(2, Math.round(L * p.barkPatch))
  const barkField = cylLattice(barkRand, na, nt)

  const jagField0 = ringLattice(jagRand, Math.max(3, Math.round(p.jagCount)))
  const jagField1 = ringLattice(jagRand, Math.max(3, Math.round(p.jagCount)))

  // The spine, in the LOCAL frame: +Y along the piece, t running 0 -> 1. The
  // kink harmonics are anchored at t = 0 by subtracting their own value there,
  // so the butt stays where the placement put it however hard the slider is
  // pulled -- otherwise `kink` also translates the whole piece sideways and
  // reads as a broken dial.
  const kinkAt = (t) =>
    p.kink *
    (0.62 * (Math.sin(t * p.kinkFreq + kp0) - Math.sin(kp0)) +
      0.38 * (Math.sin(t * p.kinkFreq * 2.16 + kp1) - Math.sin(kp1)))

  const spineAt = (t, out) => {
    const b = p.bend * t * t
    const k = kinkAt(t)
    out.set(
      (b * Math.cos(bendAz) + k * Math.cos(kinkAz)) * L,
      t * L,
      (b * Math.sin(bendAz) + k * Math.sin(kinkAz)) * L
    )
    return out
  }

  // The radius, and the whole of note 2 in the header. Every angular term has an
  // INTEGER period in `a`, which is what closes the seam exactly at a = TAU and
  // is what makes the field safe to sample at any number of sides.
  const radiusAt = (t, a) => {
    let r = r0 * (1 - p.taper * t)

    // Root buttress. Quadratic in how far below the flare's reach we are, so it
    // arrives fast at the very bottom rather than swelling the whole butt.
    if (p.flare > 0 && p.flareRun > 1e-4) {
      const f = Math.max(0, 1 - t / p.flareRun)
      r += r0 * p.flare * f * f
    }

    // Not a circle: a rolled ellipse, plus 3- and 5-lobe on top of it. The
    // odd harmonics matter more than the even one -- an ellipse is still a
    // shape a machine could turn, and 3 and 5 are what make it a tree.
    let lobe =
      1 +
      p.ovality * Math.cos(2 * (a + ovalPhase)) +
      p.lobes * (0.6 * Math.cos(3 * a + lp0) + 0.4 * Math.cos(5 * a + lp1))

    // ...and not a cone: burls and waists along the length.
    lobe *=
      1 +
      p.swell *
        (0.6 * Math.sin(t * p.swellFreq * TAU + sp0) + 0.4 * Math.sin(t * p.swellFreq * 1.87 * TAU + sp1))
    r *= lobe

    // Drying checks. A narrow spike rather than a sine, because a check is a
    // SPLIT: it is nearly all flat surface with a few deep grooves in it, and a
    // sine gives you a fluted column instead.
    const n = Math.round(p.checks)
    if (n > 0 && p.checkDepth > 0) {
      const c = Math.cos(n * (a + checkPhase))
      if (c > 0) r *= 1 - p.checkDepth * Math.pow(c, 10)
    }

    // Where the bark has gone, the surface is a bark's thickness further in.
    // This is the step that reads in silhouette; see note 3.
    r -= p.barkThick * (1 - barkAt(t, a))

    return Math.max(r, r0 * 0.06)
  }

  // 1 = bark, 0 = bare wood, with a soft boundary so the radius step is a slope
  // a couple of centimetres wide rather than a cliff the shading cannot survive.
  //
  // The slider is a FRACTION COVERED and only approximately: value noise spends
  // most of its range near its mean, so 0.5 really is about half the surface but
  // 0.2 is rather less than a fifth. It is judged by eye on the bench, which is
  // the only way a number like this is ever judged.
  const barkAt = (t, a) => {
    if (p.bark >= 1) return 1
    if (p.bark <= 0) return 0
    const f = barkField(t, a)
    const s = 0.09
    const lo = p.bark - s
    const hi = p.bark + s
    if (f <= lo) return 1
    if (f >= hi) return 0
    const x = (f - lo) / (hi - lo)
    return 1 - x * x * (3 - 2 * x)
  }

  // Where the tube actually ends, per angle. The rim of a break is ragged, so
  // the LAST RING itself wanders along the spine rather than the cap being stuck
  // on to a clean edge -- which is the only construction that leaves no gap and
  // no doubled rim. Cubed, because a break has a few long splinters and a lot of
  // low rim, and a raw lattice value gives an evenly scalloped edge that reads
  // as decorative.
  const endT = (a, which) => {
    const jag = which ? p.jag1 : p.jag0
    if (jag <= 0) return which ? 1 : 0
    const f = which ? jagField1(a) : jagField0(a)
    const d = jag * Math.pow(f, 3)
    return which ? 1 - d : d
  }

  return { L, r0, spineAt, radiusAt, barkAt, endT, rand: mulberry32((p.seed ^ 0xc2b2ae35) >>> 0) }
}

// --- the vertex ---------------------------------------------------------------
//
// One point on the swept surface, with its analytic normal.
//
// The ring frame is the fixed LOCAL X/Z pair rather than a frame carried along
// the spine, which is tree.js's choice and right for the same reason: the rings
// stay in horizontal planes and the spine's lean slides them, so a bend never
// twists the texture. The bends here are a few percent of the length; a swept
// frame would buy nothing and would need a parallel-transport pass to stay
// stable.
//
// The normal is the real one -- dS/dt x dS/da, with the two radius derivatives
// taken by central difference. Cheap at build time, and it is what makes a check
// and a burl catch light instead of being a silhouette-only feature. Pure radial
// (which is all tree.js computes) lights a flared butt as though it were a
// cylinder.
const _p = new THREE.Vector3()
const _pa = new THREE.Vector3()
const _pb = new THREE.Vector3()
const _dt = new THREE.Vector3()
const _da = new THREE.Vector3()
const _n = new THREE.Vector3()

function surfacePoint(s, t, a, out) {
  const r = s.radiusAt(t, a)
  const c = Math.cos(a)
  const sn = Math.sin(a)
  s.spineAt(t, _p)
  out.pos.set(_p.x + r * c, _p.y, _p.z + r * sn)

  // dS/da = r_a * radial + r * tangential
  const h = 0.01
  const ra = (s.radiusAt(t, a + h) - s.radiusAt(t, a - h)) / (2 * h)
  _da.set(ra * c - r * sn, 0, ra * sn + r * c)

  // dS/dt = spine'(t) + r_t * radial
  const ht = 0.004
  const t0 = Math.max(0, t - ht)
  const t1 = Math.min(1, t + ht)
  const rt = (s.radiusAt(t1, a) - s.radiusAt(t0, a)) / (t1 - t0)
  s.spineAt(t1, _pa)
  s.spineAt(t0, _pb)
  _dt.subVectors(_pa, _pb).divideScalar(t1 - t0)
  _dt.set(_dt.x + rt * c, _dt.y, _dt.z + rt * sn)

  // dS/dt x dS/da points OUTWARD -- check it on a plain cylinder and the cross
  // product comes back as the radial direction, which is the orientation the
  // winding below is built for.
  _n.crossVectors(_dt, _da)
  const len = _n.length()
  if (len > 1e-9) _n.divideScalar(len)
  else _n.set(c, 0, sn)
  out.nor.copy(_n)
  out.r = r
  return out
}

function vert() {
  return { pos: new THREE.Vector3(), nor: new THREE.Vector3(), u: 0, v: 0, r: 0 }
}

// --- the accumulator ---------------------------------------------------------
//
// Non-indexed triples, because the LAYER is chosen per face -- a face is either
// bark or bare wood and there is no such thing as a vertex that is 40% of each.
// That is the same reason rock.js is non-indexed (per-face projection axis), and
// it carries the same bonus: per-face flat shading is free, so the end cuts can
// stay hard while the barrel stays round.
function emitTri(out, a, b, c, layer, smooth) {
  const tri = [a, b, c]

  // The face normal, and whether there is one. `sink` clamps a ribbon of the
  // underside flat onto y = 0 and those faces come out degenerate; they have no
  // face normal to blend toward, so they keep the shell's, exactly as a rock's
  // bedded belly does.
  const ax = b.pos.x - a.pos.x
  const ay = b.pos.y - a.pos.y
  const az = b.pos.z - a.pos.z
  const bx = c.pos.x - a.pos.x
  const by = c.pos.y - a.pos.y
  const bz = c.pos.z - a.pos.z
  let fx = ay * bz - az * by
  let fy = az * bx - ax * bz
  let fz = ax * by - ay * bx
  const area = Math.hypot(fx, fy, fz)
  const usable = area > 1e-9
  if (usable) {
    fx /= area
    fy /= area
    fz /= area
  }

  for (const p of tri) {
    out.pos.push(p.pos.x, p.pos.y, p.pos.z)
    let nx = p.nor.x
    let ny = p.nor.y
    let nz = p.nor.z
    if (usable) {
      nx = fx + (nx - fx) * smooth
      ny = fy + (ny - fy) * smooth
      nz = fz + (nz - fz) * smooth
    }
    const nl = Math.hypot(nx, ny, nz) || 1
    out.nor.push(nx / nl, ny / nl, nz / nl)
    out.uv.push(p.u, p.v)
    out.lay.push(layer)
  }
  out.tris++
}

// ---------------------------------------------------------------------------
// buildDeadwood
// ---------------------------------------------------------------------------
export function buildDeadwood(options = {}) {
  const p = { ...DEADWOOD_DEFAULTS, ...options }
  const tier = DEADWOOD_TIERS[Math.min(DEADWOOD_TIERS.length - 1, Math.max(0, Math.round(p.tier)))]
  const s = shapeOf(p)

  const sides = tier.sides
  const rings = Math.max(1, Math.round(Math.max(1, p.rings) * tier.ringMul))
  const out = { pos: [], nor: [], uv: [], lay: [], tris: 0 }

  // --- the skin ------------------------------------------------------------
  //
  // `uRepeat` is derived rather than dialled: it is how many tiles fit round the
  // butt at the density `texMetres` sets going up, ROUNDED TO AN INTEGER so the
  // seam at a = TAU lands on a tile boundary. tree.js derives its `uRepeat` the
  // same way and for the same reason. `texMetres` is therefore the one texture
  // dial, and it means the same thing in both directions.
  const circumference = TAU * s.r0
  const uRepeat = Math.max(1, Math.round(circumference / p.texMetres))
  const vSpan = s.L / p.texMetres

  const smooth = Math.min(1, Math.max(0, p.smooth))

  // Two rows of vertices at a time, so the strip only ever holds what it needs.
  const rowA = Array.from({ length: sides + 1 }, vert)
  const rowB = Array.from({ length: sides + 1 }, vert)

  const fillRow = (row, ti, ringIndex) => {
    for (let k = 0; k <= sides; k++) {
      // k runs one past `sides` so the seam vertex is DUPLICATED: the same point
      // in space, but at u = uRepeat rather than u = 0. Sharing it would run the
      // whole tile backwards across the last face.
      const a = (k / sides) * TAU
      // The end rings ride `endT`, so the rim of a break wanders along the spine
      // per angle and the cap fans off a genuinely ragged edge.
      const t = ringIndex === 0 ? s.endT(a, 0) : ringIndex === rings ? s.endT(a, 1) : ti
      const v = row[k]
      surfacePoint(s, t, a, v)
      v.u = (k / sides) * uRepeat
      v.v = t * vSpan
      v.t = t
      v.a = a
    }
  }

  // Which layer a face wears: the bark field at the face's own centre. Per face
  // rather than per vertex because `texLayer` is an INDEX -- interpolating
  // between LAYER.BARK and LAYER.TIMBER_BEAM would walk the shader through
  // twenty-four unrelated layers on its way across the triangle.
  const faceLayer = (t, a) => (s.barkAt(t, a) >= 0.5 ? p.barkLayer : p.woodLayer)

  fillRow(rowA, 0, 0)
  for (let r = 1; r <= rings; r++) {
    fillRow(rowB, r / rings, r)
    for (let k = 0; k < sides; k++) {
      const a0 = rowA[k]
      const a1 = rowA[k + 1]
      const b0 = rowB[k]
      const b1 = rowB[k + 1]
      const layer = faceLayer((a0.t + b1.t) * 0.5, ((k + 0.5) / sides) * TAU)
      // Wound so the outward normal computed in surfacePoint agrees with the
      // face winding. Getting this backwards is invisible on a double-sided
      // material until snow lands on the inside of the log.
      emitTri(out, a0, b0, b1, layer, smooth)
      emitTri(out, a0, b1, a1, layer, smooth)
    }
    for (let k = 0; k <= sides; k++) {
      const a = rowA[k]
      const b = rowB[k]
      a.pos.copy(b.pos)
      a.nor.copy(b.nor)
      a.u = b.u
      a.v = b.v
      a.t = b.t
      a.r = b.r
    }
  }

  // --- the two end faces ---------------------------------------------------
  //
  // A fan from the ragged rim to a centre pulled `cup` radii INTO the piece.
  // That dish is what a rotten heart looks like and it costs nothing -- the fan
  // has the same triangle count whether the centre is proud, flat or sunk.
  //
  // ALWAYS FLAT SHADED, whatever `smooth` says. §19 records the same rule for
  // the buildings' log ends and gives the reason in one line: an all-smooth log
  // has ends that look like melted wax. The end grain of a break meets the
  // barrel at a right angle and has to keep that arris.
  //
  // UVs are a planar projection across the axis -- end grain, not bark running
  // round a corner -- and the layer is the WOOD layer at both ends however much
  // bark is left, because a break face is by definition where the bark is not.
  const endRing = Array.from({ length: sides + 1 }, vert)
  const capCentre = vert()

  const buildCap = (which) => {
    const cup = which ? p.cup1 : p.cup0
    let cx = 0
    let cy = 0
    let cz = 0
    let cr = 0
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * TAU
      const t = s.endT(a, which)
      const v = endRing[k]
      surfacePoint(s, t, a, v)
      v.u = (v.pos.x - 0) / p.texMetres
      v.v = (v.pos.z - 0) / p.texMetres
      if (k < sides) {
        cx += v.pos.x
        cy += v.pos.y
        cz += v.pos.z
        cr += v.r
      }
    }
    cx /= sides
    cy /= sides
    cz /= sides
    cr /= sides

    // The centre sits on the SPINE's x/z rather than on the rim's average, so a
    // cup on a heavily lobed section dishes straight down the pith instead of
    // leaning toward whichever side had the fatter lobe.
    s.spineAt(which ? 1 : 0, _p)
    const dir = which ? -1 : 1
    capCentre.pos.set(_p.x, cy + dir * cup * cr, _p.z)
    capCentre.nor.set(0, which ? 1 : -1, 0)
    capCentre.u = capCentre.pos.x / p.texMetres
    capCentre.v = capCentre.pos.z / p.texMetres
    void cx
    void cz

    for (let k = 0; k < sides; k++) {
      const v0 = endRing[k]
      const v1 = endRing[k + 1]
      // Winding flips between the two ends: the far cap faces +Y, the butt -Y.
      if (which) emitTri(out, v0, v1, capCentre, p.woodLayer, 0)
      else emitTri(out, v1, v0, capCentre, p.woodLayer, 0)
    }
  }

  buildCap(1)
  buildCap(0)

  // --- branch stubs ---------------------------------------------------------
  //
  // Not growLimb and not a branch: a stub is a broken-off base, so it is a short
  // cone with a jagged end and no curve at all. Six lines rather than tree.js's
  // limb machinery, and the one thing worth copying from there is where it
  // STARTS -- 0.6 of the local radius INSIDE the drawn surface, so the cone is
  // seated in the wood rather than balanced on its skin. A stub that starts on
  // the surface hovers beside the trunk the moment anything bends.
  const nStubs = Math.round(p.stubs * tier.stubMul)
  const stubSides = Math.max(3, Math.round(p.stubSides))
  const stubRand = s.rand
  const stubAxis = new THREE.Vector3()
  const stubE1 = new THREE.Vector3()
  const stubE2 = new THREE.Vector3()
  const stubRing = Array.from({ length: stubSides + 1 }, vert)
  const stubTip = vert()

  for (let i = 0; i < nStubs; i++) {
    const t = p.stubStart + (1 - p.stubStart) * ((i + 0.5) / Math.max(1, nStubs) + (stubRand() - 0.5) * 0.2)
    const tc = Math.min(0.97, Math.max(0.03, t))
    // Spread round the trunk by the golden angle plus a jitter, so two stubs
    // never stack up the same side however few there are.
    const a = stubRand() * TAU + i * 2.399963
    const r = s.radiusAt(tc, a)
    const c = Math.cos(a)
    const sn = Math.sin(a)
    s.spineAt(tc, _p)
    const base = new THREE.Vector3(_p.x + r * c * 0.6, _p.y, _p.z + r * sn * 0.6)

    // Dead stubs droop. `stubRise` is measured from horizontal and defaults low
    // for that reason -- a stub angled up like a live branch reads as a tree
    // that is still trying.
    const rise = p.stubRise * (0.5 + stubRand())
    stubAxis.set(c * Math.cos(rise), Math.sin(rise), sn * Math.cos(rise)).normalize()
    stubE1.set(-sn, 0, c).normalize()
    stubE2.crossVectors(stubAxis, stubE1).normalize()

    const rad = Math.max(0.012, r * p.stubRadius)
    const len = rad * 2 * p.stubLength * (0.7 + stubRand() * 0.6)
    const layer = s.barkAt(tc, a) >= 0.5 ? p.barkLayer : p.woodLayer

    for (let k = 0; k <= stubSides; k++) {
      const ang = (k / stubSides) * TAU
      const v = stubRing[k]
      const ox = stubE1.x * Math.cos(ang) + stubE2.x * Math.sin(ang)
      const oy = stubE1.y * Math.cos(ang) + stubE2.y * Math.sin(ang)
      const oz = stubE1.z * Math.cos(ang) + stubE2.z * Math.sin(ang)
      v.pos.set(base.x + ox * rad, base.y + oy * rad, base.z + oz * rad)
      v.nor.set(ox, oy, oz)
      v.u = (k / stubSides) * Math.max(1, Math.round((TAU * rad) / p.texMetres))
      v.v = 0
    }
    // The tip is a point rather than a rim: at this size a capped stub spends
    // three more triangles on an end face under a centimetre across.
    stubTip.pos.copy(base).addScaledVector(stubAxis, len)
    stubTip.nor.copy(stubAxis)
    stubTip.v = len / p.texMetres

    for (let k = 0; k < stubSides; k++) {
      stubTip.u = ((k + 0.5) / stubSides) * Math.max(1, Math.round((TAU * rad) / p.texMetres))
      emitTri(out, stubRing[k], stubRing[k + 1], stubTip, layer, smooth * 0.5)
    }
  }

  // --- placement, and the ground -------------------------------------------
  //
  // Everything above is in the local frame with the spine running up +Y. A snag
  // stays there; a log is rolled about its own axis, then tipped over onto +Z
  // with `pitch` left as the angle one end is propped up by.
  //
  // Then the piece is dropped by `sink` and everything below y = 0 is clamped UP
  // onto the plane. See note 4 in the header for why clamping rather than
  // trimming, and what it costs.
  const positions = new Float32Array(out.pos)
  const normals = new Float32Array(out.nor)

  const m = new THREE.Matrix4()
  if (p.kind === 'log') {
    m.makeRotationX(Math.PI / 2 - p.pitch)
    m.multiply(new THREE.Matrix4().makeRotationY(p.roll))
  }
  const nm = new THREE.Matrix3().setFromMatrix4(m)
  const v3 = new THREE.Vector3()
  if (p.kind === 'log') {
    for (let i = 0; i < positions.length; i += 3) {
      v3.fromArray(positions, i).applyMatrix4(m).toArray(positions, i)
      v3.fromArray(normals, i).applyMatrix3(nm).normalize().toArray(normals, i)
    }
  }

  let minY = Infinity
  for (let i = 1; i < positions.length; i += 3) if (positions[i] < minY) minY = positions[i]
  const drop = minY + p.sink * s.r0
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i] - drop
    positions[i] = y < 0 ? 0 : y
  }

  // --- measure what was actually built --------------------------------------
  let minX = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i]
    if (positions[i] > maxX) maxX = positions[i]
    if (positions[i + 1] > maxY) maxY = positions[i + 1]
    if (positions[i + 2] < minZ) minZ = positions[i + 2]
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2]
  }

  // How much of the surface still has bark on it, sampled on a grid that has
  // nothing to do with the tier's own vertices -- the same reasoning as rock.js
  // measuring its box on a reference set no tier uses. It is reported because
  // `bark` is a slider whose number and whose result are only approximately the
  // same thing, and the bench should show the result.
  let covered = 0
  const SAMPLES = 24
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      if (s.barkAt((i + 0.5) / SAMPLES, ((j + 0.5) / SAMPLES) * TAU) >= 0.5) covered++
    }
  }

  const count = out.tris * 3
  const index = new Uint16Array(count)
  for (let i = 0; i < count; i++) index[i] = i

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uv, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.lay, 1))
  // Identity index, exactly as rock.js: the geometry is non-indexed by
  // construction because every face picks its own layer, but BatchedMesh only
  // accepts indexed geometry.
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeBoundingSphere()

  geo.userData.deadwood = {
    kind: p.kind,
    tier: tier.name,
    triangles: out.tris,
    vertices: count,
    sides,
    rings,
    stubs: nStubs,
    // Split out so the bench can say where the budget went. The barrel is the
    // only part that scales with `rings`; the caps are fixed at 2 x sides and
    // the stubs cost their own count x sides.
    barrelTris: sides * rings * 2,
    capTris: sides * 2,
    stubTris: nStubs * stubSides,
    barkFraction: covered / (SAMPLES * SAMPLES),
    uRepeat,
    texMetres: p.texMetres,
    barkLayer: p.barkLayer,
    woodLayer: p.woodLayer,
    measured: {
      width: maxX - minX,
      height: maxY,
      depth: maxZ - minZ,
      // The spine's own length, which is what `length` asked for -- the box
      // above is what the bend, the flare and the lie-down made of it.
      span: s.L,
      buttDiameter: s.r0 * 2,
    },
  }
  return geo
}

/** A standing broken-off snag. */
export function buildSnag(options = {}) {
  return buildDeadwood({ ...options, kind: 'snag' })
}

/** A fallen log, lying on and pressed into the ground. */
export function buildLog(options = {}) {
  return buildDeadwood({ ...options, kind: 'log' })
}

/**
 * What a given parameter set will cost, without building it.
 *
 * Pure arithmetic over the tier table, the way resolveTree is for trees. The
 * bench uses it to fill the ladder rows for tiers it is not currently drawing,
 * which is the whole point -- a ladder you have to build three extra meshes to
 * read is a ladder nobody reads.
 */
export function deadwoodCost(options = {}, tierIndex = 0) {
  const p = { ...DEADWOOD_DEFAULTS, ...options }
  const tier = DEADWOOD_TIERS[Math.min(DEADWOOD_TIERS.length - 1, Math.max(0, Math.round(tierIndex)))]
  const sides = tier.sides
  const rings = Math.max(1, Math.round(Math.max(1, p.rings) * tier.ringMul))
  const stubs = Math.round(p.stubs * tier.stubMul)
  const stubSides = Math.max(3, Math.round(p.stubSides))
  const barrel = sides * rings * 2
  const caps = sides * 2
  const stubTris = stubs * stubSides
  return { tier: tier.name, sides, rings, stubs, barrel, caps, stubTris, triangles: barrel + caps + stubTris }
}
