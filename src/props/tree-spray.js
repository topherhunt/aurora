import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// A PINE WHOSE CROWN IS GROWN AS SPRAY, one billboard triangle per leaf. The
// bench is /gen-tree-v7. Nothing in the shipped forest imports this.
//
// SELF-CONTAINED ON PURPOSE. props/tree-billboard.js (/gen-tree-v5) is the same
// primitive with a different growth rule, and this file deliberately shares no
// code with it so either one can be deleted without touching the other.
//
// WHAT THE CROWN IS. Not a scatter, not a budding pass, not a Poisson packing:
// a two-stage construction that mirrors how a conifer actually builds spray.
//
//   1. SPINE. Each limb is beaded with leaves at regular-ish intervals along
//      its own centre line, innermost to outermost.
//   2. OFFSHOOTS. Each spine leaf then throws a short chain of leaves down and
//      out to its left, then to its right -- the fan a real shoot carries.
//
// The order is the whole point. Growing innermost-first means the inner spray
// claims its space before the outer spray asks for any, so a limb thins toward
// its tip the way a limb does. And because an offshoot is a CHAIN that stops at
// the first blocked link, density is self-limiting: a crowded neighbourhood
// terminates its chains early and an open one runs them out to full length.
// Nothing has to be tuned to a leaf target, because there is no target -- the
// leaf count is an OUTPUT of the skeleton, which is what makes the knobs here
// mean something structural instead of meaning "how hard to push".
//
// PRIOR OFFSHOOTS STEER THE NEXT ONE. Each candidate direction is scored
// against the angles the previous offshoot on that same side took, and the
// furthest-away one wins. Roll each fan independently and consecutive sprays
// pile into the same cone; this spreads them without making them regular.
//
// DEPTH IS A SIZE, NOT JUST A SHADE. A leaf deep inside the hull is drawn
// larger, spaced further from its neighbours, and darker; a leaf at the hull is
// standard size. This is the triangle economy of the whole crown -- the
// interior is where triangles are invisible, so it is where they should be
// fewest and biggest. Spacing follows size directly rather than being a second
// knob, because a leaf twice as wide that keeps its old spacing simply overlaps.
//
// THE BILLBOARD IS FREE, AND SO IS ITS ROLL. Each vertex carries `aOffset`, its
// corner's position in metres in VIEW space, already rotated by that leaf's own
// random roll. The vertex shader adds it to the leaf centre after the modelView
// transform and does nothing else:
//
//     mv = modelViewMatrix * vec4(centre, 1);  mv.xy += aOffset;
//
// So a camera-facing leaf costs no runtime work, and the same trick pays for
// the TEXTURE roll: uvProj is a triangle cut out of the tile at an independent
// random angle and place, so no two leaves show the same needles the same way
// up. What it costs instead is BILLBOARD SWIM -- turn your head and every plate
// counter-rotates. Near-equilateral triangles are the cheapest defence, which
// is why `leafJitter` is small and is the knob the swim is on.
//
// THE NORMAL IS THE CROWN'S, not the plate's, and here it has to be: a
// camera-facing triangle has no normal of its own -- it is whatever direction
// you happen to be standing. Shading by it would repaint the crown every time
// you moved. Each leaf is lit by the direction the CROWN faces there (radial
// off the trunk axis, tipped up by `normalTilt`).
//
// THE TILE IS SOLID and nothing reads its alpha. `discard` anywhere in the
// program turns off low-resolution-Z for the whole draw on a tiled Adreno,
// which is the entire reason opaque foliage is worth building at all.
// ---------------------------------------------------------------------------

export const SPRAY_PINE_DEFAULTS = {
  seed: 7,
  height: 9,

  // --- the skeleton ---------------------------------------------------------
  trunkSegs: 4,
  trunkRadius: 0.013,      // as a fraction of height, at the foot
  trunkTaper: 0.22,        // and what is left of it at the tip
  trunkKink: 0.014,        // how far a trunk node may step off the last one
  firstBranch: 0.22,       // fraction of height the crown starts at
  branchCount: 105,
  branchJitter: 0.8,       // how far off its slot a branch may slide
  branchLength: 0.34,      // longest branch as a fraction of height
  branchMin: 0.30,         // and the shortest, at the leader
  branchWidth: 0.030,      // branch base radius as a fraction of its length
  branchSway: 0.35,        // sideways wander off the radial
  // A limb shorter than this is not built at all. Below half a metre a branch
  // is three triangles nobody can see through the foliage sitting on it, and
  // the spine it would carry is two leaves.
  branchMinLength: 0.5,
  subsPerMetre: 2,         // sub-branches PER METRE, so a twig gets none
  trunkSides: 5,
  branchSides: 3,
  crownPeak: 0.30,         // height fraction the longest branches sit at
  crownFullness: 1.15,     // how fast they shorten toward the leader
  crownCone: 0.20,         // the cone the wood may not leave, fraction of height
  subStart: 0.30,
  subLength: 0.42,
  subAngle: 0.95,
  subDroop: 0.22,

  // EVERY BRANCH HANGS AT ITS OWN ANGLE, in degrees below horizontal, and no
  // branch picks it alone: after the raw rolls, each angle is blended toward
  // the mean of the branch above and the branch below it. Independent rolls
  // give a bottle brush of randomly-tilted spokes; blending makes the droop
  // drift smoothly up the trunk, which is what a real crown does as the load on
  // a limb falls off toward the leader. `droopBlend` is how much neighbour and
  // how much roll -- 0 is pure noise, 1 irons the whole tree to one angle.
  branchDroopMin: 10,
  branchDroopMax: 40,
  droopBlend: 0.55,

  // --- the leaves -----------------------------------------------------------
  //
  // A LEAF IS ONE TRIANGLE and `leafWidth` is its side in metres, before the
  // interior swell. The corners start on an equilateral (circumradius =
  // side / sqrt 3) and `leafJitter` pushes each one off in angle and radius.
  leafWidth: 0.20,
  leafJitter: 0.18,
  leafVary: 0,             // +/- this fraction on the whole leaf's size
  leafPatch: 1.0,          // leaf circumcircle as a fraction of the tile's width

  // THE SPINE. Leaves beaded along a limb's own centre line at `spineGap` leaf
  // widths, jittered by `spineJitter` of a step so the beads do not read as a
  // ruler. Placed innermost first: the inner spray claims its room before the
  // outer spray asks for any, so a limb thins toward its tip.
  //
  // MEASURED IN LEAF WIDTHS, and it has to be well under 1 for the same reason
  // minGap does: a limb is only 1 to 1.5 m long, so a step of a whole leaf width
  // beads it two or three times, and the tip rule below then eats both of them.
  spineGap: 0.75,
  spineJitter: 0.3,

  // THE REJECTION RADIUS, in leaf widths, at the hull. A candidate closer than
  // this to an existing leaf is refused and the offshoot chain carrying it
  // stops there. This is the ONLY density control in the crown -- there is no
  // leaf target -- so it is the first knob to reach for if the tree is too
  // dense or too leggy. Scaled up in the interior along with the leaf size.
  //
  // A FULL LEAF WIDTH IS TOO FAR TO BE A CROWN. Two triangles of side w have
  // touching circumcircles at 1.15 w apart, so a rejection radius of 1 w is
  // essentially "never overlap" -- measured, it gives a limb 2.5 spine beads and
  // 0.4 offshoots per bead, and the whole tree comes to 5 m2 of leaf against a
  // 24 m2 silhouette. Foliage needs its leaves to overlap in depth, so the
  // default sits at roughly half that; 1.0 is still reachable on the slider.
  minGap: 0.50,

  // THE OFFSHOOTS. Each spine leaf throws a chain of `offshootMin`..
  // `offshootMax` leaves to its left, then another to its right, each link one
  // `chainStep` further along a direction `out` degrees off the limb (swept
  // toward that side) and `down` degrees below horizontal. `chainWander` lets a
  // link turn off the last one so a chain droops rather than ruling a line.
  //
  // The chain STOPS at the first blocked link rather than skipping it, which is
  // what makes density self-limiting: a crowded neighbourhood terminates early,
  // an open one runs to full length, and no pass has to count anything.
  offshootMin: 1,
  offshootMax: 4,
  outMin: 30,
  outMax: 45,
  downMin: 30,
  downMax: 45,
  // ONE LEAF WIDTH: a chain is a run of touching leaves, not a dotted line.
  // Measured at the size of the leaf being stepped away from, so a chain that
  // shrinks as it leaves the core closes up as it goes. It cannot go below
  // minGap (a link inside the parent's own exclusion sphere is refused, and the
  // chain dies at link 1), which is the floor `stepBy` applies.
  chainStep: 1.0,          // leaf widths between links of one chain
  chainWander: 14,         // degrees a link may turn off the one before it
  // Candidate directions scored per offshoot. The winner is the one furthest in
  // angle from what the PREVIOUS offshoot on this side of this limb took, which
  // is what stops consecutive fans stacking into one cone.
  angleTries: 4,

  // THE TAPER. A bead's fan budget IS its distance from the tip in beads -- the
  // tip gets none, the bead before it one, the one before that two -- capped at
  // this fraction of the limb's own bead count so a long bough does not grow a
  // solid collar of fans round the trunk where nothing can see them.
  offshootCap: 0.4,

  // THE TOP OF THE TREE IS TREATED AS ONE MORE LIMB: the leader above
  // `topFraction` of the height is beaded with spine leaves the same way, and
  // each throws `topOffshoots` single leaves OUTWARD AND UPWARD at haphazard
  // azimuths. Up, not down, because a spire is lit from above and the branches
  // have run out by then -- droop it like a bough and the tip reads as a
  // drooping tassel instead of a point.
  topFraction: 0.25,
  topOffshoots: 4,
  topUpMin: 10,
  topUpMax: 55,

  // THE INTERIOR SWELL. A leaf's size is multiplied by 1 + `interiorGrow` x its
  // depth, so a leaf at the hull is standard size and one at the core is up to
  // that much larger. Its spacing scales with it, so a bigger leaf also claims
  // more room -- which is the point: fewer, larger, darker triangles where
  // nothing can be seen through the shell anyway.
  //
  // DEPTH IS METRES IN FROM THE HULL, over `interiorDepth`, and NOT the
  // fraction r / R. The fraction is wrong for a narrow conifer: the hull radius
  // at a given height is set by the LONGEST branch there, so every shorter
  // branch at that height reads as interior over its whole length, the swell
  // lands on the outer spray as well as the core, and the fat inner beads eat
  // the spine they were supposed to sit on. An absolute shell says what was
  // meant -- the outer `interiorDepth` metres of crown is the part you can see
  // into, and everything behind it is the column nobody resolves.
  interiorGrow: 2.0,
  interiorDepth: 3.0,

  // --- the tint -------------------------------------------------------------
  needleDark: [0.055, 0.098, 0.052],
  needleMid: [0.128, 0.212, 0.104],
  needleTip: [0.207, 0.316, 0.150],
  depthShade: 2.0,         // darkening by depth inside the crown hull
  aoRadius: 0.42,          // metres a neighbour has to be inside to shade a leaf
  aoStrength: 0.9,         // and how hard the local density darkens
  aoFloor: 0.22,           // how dark that is ever allowed to get
  hueVary: 0.10,
  valueVary: 0.16,
  normalTilt: 1.6,         // how far the crown normal tips up off radial
}

export const SPRAY_SPECIES = {
  pine: {
    label: 'pine',
    barkLayer: LAYER.BARK_PINE,
    // Served straight off the project root by the dev server. tmp/ is
    // gitignored, so this tile is a bench input, not a shipped asset.
    tile: '/tmp/leaves/pine-mat-solid.png',
    params: {},
  },
}

export function spraySpecies(name) {
  const sp = SPRAY_SPECIES[name]
  if (!sp) throw new Error(`tree-spray: no species "${name}"`)
  return { ...SPRAY_PINE_DEFAULTS, ...sp.params }
}

const lerp = (a, b, t) => a + (b - a) * t
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const rad = (deg) => deg * Math.PI / 180
function norm(a) {
  const l = len(a)
  if (!(l > 1e-9)) throw new Error('tree-spray: cannot normalise a zero vector')
  return [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * A spatial hash at one cell per `cell` metres, storing each point WITH the
 * radius it claims.
 *
 * The stored radius is what makes a variable leaf size honest: a big interior
 * leaf claims a big exclusion sphere, and a small rim leaf tested only against
 * its own small radius would happily land inside it. Every test therefore uses
 * max(mine, theirs), so the claim is symmetric however the two sizes differ.
 *
 * The key is a mixed integer hash rather than a string: collisions only put
 * extra points in a bucket, and every candidate is distance-checked anyway, so
 * a collision costs a comparison and can never produce a wrong answer.
 */
function hashGrid(cell) {
  const buckets = new Map()
  const key = (i, j, k) => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) | 0
  const at = (p) => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)]
  let maxR = cell
  return {
    add(p, r) {
      if (r > maxR) maxR = r
      const [i, j, k] = at(p)
      const h = key(i, j, k)
      const b = buckets.get(h)
      const e = { p, r }
      if (b) b.push(e); else buckets.set(h, [e])
    },
    /**
     * True if any stored point excludes p at radius r. The search span has to
     * cover the LARGEST radius anything has ever claimed, not r -- a fat
     * interior leaf two cells away still excludes a thin one.
     */
    near(p, r) {
      const [i, j, k] = at(p)
      const span = Math.ceil(Math.max(r, maxR) / cell)
      for (let a = -span; a <= span; a++) {
        for (let b = -span; b <= span; b++) {
          for (let c = -span; c <= span; c++) {
            const bucket = buckets.get(key(i + a, j + b, k + c))
            if (!bucket) continue
            for (const e of bucket) {
              const rr = Math.max(r, e.r)
              const dx = e.p[0] - p[0], dy = e.p[1] - p[1], dz = e.p[2] - p[2]
              if (dx * dx + dy * dy + dz * dz < rr * rr) return true
            }
          }
        }
      }
      return false
    },
    /** How many stored points are within `r` of p, itself included. */
    count(p, r) {
      const [i, j, k] = at(p)
      const rr = r * r
      const span = Math.ceil(r / cell)
      let n = 0
      for (let a = -span; a <= span; a++) {
        for (let b = -span; b <= span; b++) {
          for (let c = -span; c <= span; c++) {
            const bucket = buckets.get(key(i + a, j + b, k + c))
            if (!bucket) continue
            for (const e of bucket) {
              const dx = e.p[0] - p[0], dy = e.p[1] - p[1], dz = e.p[2] - p[2]
              if (dx * dx + dy * dy + dz * dz < rr) n++
            }
          }
        }
      }
      return n
    },
  }
}

/**
 * Grow one tree. Returns { geometry, stats }.
 *
 * The geometry carries the wood FIRST in the index buffer and the foliage
 * after it, so a two-group split draws the bark with one material and the
 * crown with another.
 *
 * Foliage attributes: `position` is the leaf's CENTRE, repeated for all three
 * corners, and `aOffset` is what makes it a triangle. Nothing downstream should
 * expect `position` alone to describe the leaf's extent -- the bounding sphere
 * set here is padded for exactly that reason.
 */
export function buildSprayPine(params = {}, barkLayer = 0) {
  const p = { ...SPRAY_PINE_DEFAULTS, ...params }
  const rng = mulberry32((p.seed | 0) * 2654435761 % 2147483647 || 12345)
  const rand = (a, b) => a + (b - a) * rng()
  const h = p.height

  // --- the skeleton ---------------------------------------------------------
  //
  // Built whole before a leaf is placed, because the crown's RADIUS PROFILE has
  // to exist before a leaf can be told how deep inside it it sits, and depth is
  // what decides that leaf's size and therefore its spacing.
  const crownBase = p.firstBranch * h
  const crownTop = h

  const trunkPts = []
  {
    let x = 0, z = 0
    for (let i = 0; i <= p.trunkSegs; i++) {
      const t = i / p.trunkSegs
      trunkPts.push([x, t * h, z])
      const step = p.trunkKink * h * (0.4 + t)
      x += rand(-1, 1) * step
      z += rand(-1, 1) * step
    }
  }
  const trunkAt = (y) => {
    const f = Math.min(p.trunkSegs - 1e-6, Math.max(0, (y / h) * p.trunkSegs))
    const i = Math.min(p.trunkSegs - 1, Math.floor(f)), k = f - i
    return [lerp(trunkPts[i][0], trunkPts[i + 1][0], k), y, lerp(trunkPts[i][2], trunkPts[i + 1][2], k)]
  }
  const trunkRadiusAt = (y) => p.trunkRadius * h * lerp(1, p.trunkTaper, Math.min(1, Math.max(0, y / h)))

  const branches = []
  const slot = (crownTop - crownBase) / p.branchCount
  for (let b = 0; b < p.branchCount; b++) {
    const y = crownBase + (b + 0.5 + rand(-1, 1) * p.branchJitter) * slot
    const t = Math.min(1, Math.max(0, (y - crownBase) / (crownTop - crownBase)))
    const yaw = b * 2.399963 + rand(-0.4, 0.4)
    const d = Math.abs(t - p.crownPeak) / Math.max(1e-3, 1 - p.crownPeak)
    const shape = Math.pow(Math.max(0, 1 - d), p.crownFullness)
    let L = p.branchLength * h * lerp(p.branchMin, 1, shape) * rand(0.84, 1.12)
    // Clipped to the cone. `t` is 0 at the crown base and 1 at the leader, so
    // this is a straight taper to a point and the profile stays a triangle.
    L = Math.min(L, Math.max(0.05, p.crownCone * h * (1 - t)))
    if (L < p.branchMinLength) continue
    branches.push({
      y: Math.min(crownTop - 0.02, Math.max(crownBase, y)), t, yaw, len: L,
      droop: rad(rand(p.branchDroopMin, p.branchDroopMax)),
    })
  }
  if (!branches.length) throw new Error('tree-spray: crownCone leaves no branch over branchMinLength')

  // NEIGHBOUR-BLENDED DROOP. Sorted up the trunk, then each angle is pulled
  // toward the mean of the one below and the one above it. Two passes is enough
  // to make the droop drift instead of scatter; more and the whole tree irons
  // flat. The ends see only the neighbour they have.
  branches.sort((a, b) => a.y - b.y)
  for (let pass = 0; pass < 2; pass++) {
    const was = branches.map((br) => br.droop)
    for (let i = 0; i < branches.length; i++) {
      const lo = was[Math.max(0, i - 1)], hi = was[Math.min(was.length - 1, i + 1)]
      branches[i].droop = lerp(was[i], (lo + hi) / 2, p.droopBlend)
    }
  }

  // A BRANCH IS ONE STRAIGHT STICK, three triangles base to tip, hanging at its
  // own blended droop.
  for (const br of branches) {
    const base = trunkAt(br.y)
    const r0 = trunkRadiusAt(br.y)
    const out = [Math.cos(br.yaw), 0, Math.sin(br.yaw)]
    const side = [-Math.sin(br.yaw), 0, Math.cos(br.yaw)]
    const sway = rand(-1, 1) * p.branchSway
    const flat = norm([out[0] + side[0] * sway, 0, out[2] + side[2] * sway])
    const dir = norm([
      flat[0] * Math.cos(br.droop), -Math.sin(br.droop), flat[2] * Math.cos(br.droop),
    ])
    br.dir = dir
    br.flat = flat               // the horizontal frame the offshoots fan in
    br.side = [-flat[2], 0, flat[0]]
    br.a = [base[0] + dir[0] * r0, base[1] + dir[1] * r0, base[2] + dir[2] * r0]
    br.b = [br.a[0] + dir[0] * br.len, br.a[1] + dir[1] * br.len, br.a[2] + dir[2] * br.len]
  }

  // Sub-branches, also one stick each, and each one is a limb the spray pass
  // treats exactly like a branch.
  const subs = []
  for (const br of branches) {
    const want = br.len * p.subsPerMetre
    const n = Math.floor(want) + (rng() < want - Math.floor(want) ? 1 : 0)
    for (let k = 0; k < n; k++) {
      const u = p.subStart + (1 - p.subStart) * ((k + rand(0.1, 0.9)) / n)
      const from = [
        lerp(br.a[0], br.b[0], u), lerp(br.a[1], br.b[1], u), lerp(br.a[2], br.b[2], u),
      ]
      const tan = br.dir
      const uAx = norm(cross(tan, Math.abs(tan[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
      const phi = (k % 2 ? 1 : -1) * (1 + rand(-0.25, 0.25))
      const ang = p.subAngle * rand(0.7, 1.25)
      const dir = norm([
        tan[0] * Math.cos(ang) + uAx[0] * phi * Math.sin(ang),
        tan[1] * Math.cos(ang) + uAx[1] * phi * Math.sin(ang) - p.subDroop,
        tan[2] * Math.cos(ang) + uAx[2] * phi * Math.sin(ang),
      ])
      const L = br.len * p.subLength * rand(0.7, 1.2) * (1 - u * 0.4)
      if (L < p.branchMinLength) continue
      const r = (br.len * p.branchWidth * (1 - u) + 0.004) * 0.65
      const to = [from[0] + dir[0] * L, from[1] + dir[1] * L, from[2] + dir[2] * L]
      const flat = norm([dir[0], 0, dir[2]])
      subs.push({ from, to, dir, len: L, r, flat, side: [-flat[2], 0, flat[0]] })
    }
  }

  // THE CROWN HULL, measured off the WOOD and nothing else. It is not a
  // constraint here -- the skeleton is -- it exists only so a leaf can be told
  // how deep inside the crown it sits, and the wood is exactly the right
  // reference for that: a spine leaf near the trunk is buried, one at a branch
  // tip is at the rim, and an offshoot hanging outboard of the tip reads as
  // rim too, which is what it is. Pad this and the whole crown swells.
  const PROFILE = 32
  const profile = new Float32Array(PROFILE)
  const bump = (q) => {
    const ax = trunkAt(q[1])
    const r = Math.hypot(q[0] - ax[0], q[2] - ax[2])
    const bin = Math.min(PROFILE - 1, Math.max(0, Math.floor(q[1] / h * PROFILE)))
    if (r > profile[bin]) profile[bin] = r
  }
  for (const br of branches) { bump(br.a); bump(br.b) }
  for (const sb of subs) { bump(sb.from); bump(sb.to) }
  // The design cone is a FLOOR under the measured profile. Above the last
  // branch the measurement is zero -- crownCone deliberately runs the branches
  // out before the leader ends -- and without the floor the whole spire would
  // read as core and swell to interior size.
  for (let i = 0; i < PROFILE; i++) {
    const y = (i + 0.5) / PROFILE * h
    const t = Math.min(1, Math.max(0, (y - crownBase) / Math.max(1e-3, crownTop - crownBase)))
    if (y >= crownBase) profile[i] = Math.max(profile[i], p.crownCone * h * (1 - t), p.leafWidth * 2)
  }
  for (let i = 0; i < PROFILE; i++) {
    const a = profile[Math.max(0, i - 1)], b = profile[i], c = profile[Math.min(PROFILE - 1, i + 1)]
    profile[i] = (a + b * 2 + c) / 4
  }
  const crownRadiusAt = (y) => {
    const f = Math.min(PROFILE - 1.001, Math.max(0, y / h * PROFILE - 0.5))
    const i = Math.floor(f)
    return Math.max(0.05, lerp(profile[i], profile[Math.min(PROFILE - 1, i + 1)], f - i))
  }

  // --- the spray ------------------------------------------------------------
  const cell = p.minGap * p.leafWidth
  const grid = hashGrid(Math.max(1e-3, cell))
  const centres = []            // leaf centres, in build order
  const scales = []             // and each one's interior swell, 1 at the hull
  let blocked = 0

  /** 0 at the crown hull, 1 once `interiorDepth` metres in behind it. */
  const depthAt = (q) => {
    const ax = trunkAt(q[1])
    const r = Math.hypot(q[0] - ax[0], q[2] - ax[2])
    const inside = (crownRadiusAt(q[1]) - r) / Math.max(1e-3, p.interiorDepth)
    return Math.pow(Math.min(1, Math.max(0, inside)), 0.75)
  }
  /**
   * The swell a leaf at `q` would take, NEVER MORE THAN ITS PARENT'S.
   *
   * The ceiling is the rule that keeps the size gradient honest. Depth is read
   * off the crown hull, and an offshoot travels down as well as out -- lower
   * down the hull is wider, so the raw reading can make a leaf hanging off a
   * spine bead come out FATTER than the bead it grew from, which is the size
   * order exactly backwards. A chain may only ever shrink outward.
   */
  const scaleAt = (q, ceil = Infinity) => Math.min(ceil, 1 + p.interiorGrow * depthAt(q))
  const gapAt = (s) => p.minGap * p.leafWidth * s
  /**
   * How far to step for the next leaf, in metres, given a spacing in leaf
   * widths at that leaf's own size. FLOORED just clear of the rejection radius:
   * a step shorter than it puts the new leaf inside the parent's own exclusion
   * sphere, so every offshoot chain would die at its first link.
   */
  const stepBy = (widths, s) => Math.max(widths, p.minGap * 1.08) * p.leafWidth * s

  /**
   * Place a leaf, or refuse it because something already claims the room.
   * Returns its swell, or -1 when refused.
   *
   * `force` places it anyway, and exists for ONE caller: the leaf that caps a
   * limb's tip. That leaf is covering the bare wood the limb ends in, so it has
   * to land whatever else is nearby -- refusing it leaves a twig sticking out of
   * the foliage. It still claims its room, so nothing later grows on top of it.
   */
  const tryPlace = (q, ceil = Infinity, force = false) => {
    if (q[1] < 0.05 || q[1] > h + p.leafWidth) { blocked++; return -1 }
    const s = scaleAt(q, ceil)
    const r = gapAt(s)
    if (!force && grid.near(q, r)) { blocked++; return -1 }
    grid.add(q, r)
    centres.push(q)
    scales.push(s)
    return s
  }

  /**
   * The direction one offshoot leaves in: `out` degrees off the limb's
   * horizontal line, swept toward `side`, then `down` degrees below horizontal.
   */
  const fanDir = (flat, side, sgn, phi, theta) => {
    const cp = Math.cos(phi), sp = Math.sin(phi) * sgn
    const bx = flat[0] * cp + side[0] * sp, bz = flat[2] * cp + side[2] * sp
    const ct = Math.cos(theta)
    return norm([bx * ct, -Math.sin(theta), bz * ct])
  }

  /**
   * Grow one offshoot chain off `from`, on side `sgn` of the limb.
   *
   * `last` is the (phi, theta) the PREVIOUS offshoot on this side took; the
   * candidate furthest from it wins, so the fans off one limb spread instead of
   * stacking. Returns the angles chosen, so the next fan can be steered off
   * them, and how many links actually landed before something blocked one.
   */
  const growOffshoot = (from, flat, side, sgn, n, last, up, ceil) => {
    let dir = null, phi = 0, theta = 0, bestSep = -Infinity
    for (let t = 0; t < p.angleTries; t++) {
      const cPhi = rad(rand(p.outMin, p.outMax))
      const cTheta = up ? -rad(rand(p.topUpMin, p.topUpMax)) : rad(rand(p.downMin, p.downMax))
      const sep = last ? Math.abs(cPhi - last.phi) + Math.abs(cTheta - last.theta) : 1
      if (sep > bestSep) { bestSep = sep; phi = cPhi; theta = cTheta; dir = fanDir(flat, side, sgn, cPhi, cTheta) }
    }
    let q = from
    let s = ceil
    let grown = 0
    for (let k = 0; k < n; k++) {
      // Each link turns a little off the last, so a chain droops away rather
      // than ruling a straight line of evenly spaced dots.
      const w = rad(rand(-p.chainWander, p.chainWander))
      const cw = Math.cos(w), sw = Math.sin(w)
      dir = norm([dir[0] * cw - dir[2] * sw, dir[1], dir[0] * sw + dir[2] * cw])
      // Stepped at the size of the leaf we are stepping AWAY from, so a chain
      // that shrinks outward closes up as it goes instead of holding the gap
      // its fat inner end asked for.
      const step = stepBy(p.chainStep, s)
      const next = [q[0] + dir[0] * step, q[1] + dir[1] * step, q[2] + dir[2] * step]
      // STOP, do not skip: a blocked link ends the chain, which is what makes
      // a crowded neighbourhood self-limiting without counting anything.
      const got = tryPlace(next, s)
      if (got < 0) break
      q = next
      s = got
      grown++
    }
    return { phi, theta, grown }
  }

  /**
   * Bead one limb with spine leaves, then fan each of them out to the left and
   * to the right. Innermost first, throughout: the inner spray takes its room
   * before the outer spray asks for any.
   */
  let spineLeaves = 0
  /**
   * Walk one limb's centre line, innermost to outermost, and return the beads
   * that landed WITH the swell each one took.
   *
   * WALKED, not divided into n even slots: the step has to grow with the
   * interior swell -- a bead near the trunk claims a wider exclusion sphere than
   * one at the tip -- and an evenly divided limb simply loses every inner bead
   * to the one before it.
   *
   * The last bead is the limb's TIP, moved there rather than left wherever the
   * walk happened to stop, and placed whether or not the room is free. A limb
   * that ends a step short of its own tip is a bare twig poking out of the
   * foliage, and at these leaf sizes that is most limbs.
   */
  const beadSpine = (a, b, L) => {
    const spine = []
    const at = (k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]
    let d = p.spineGap * p.leafWidth * rand(0.2, 0.7)
    let s = 1 + p.interiorGrow
    while (d < L) {
      const q = at(d / L)
      const got = tryPlace(q)
      if (got >= 0) { spine.push({ q, s: got }); spineLeaves++; s = got }
      d += stepBy(p.spineGap, s) * (1 + rand(-1, 1) * p.spineJitter)
    }
    // Drop a bead that all but reached the tip, so capping it does not leave two
    // leaves sitting on top of each other.
    const near = stepBy(p.spineGap, s) * 0.6
    if (spine.length) {
      const last = spine[spine.length - 1].q
      if (Math.hypot(last[0] - b[0], last[1] - b[1], last[2] - b[2]) < near) spine.pop()
    }
    const tip = tryPlace(b, Infinity, true)
    spine.push({ q: b, s: tip })
    spineLeaves++
    return spine
  }

  /** Bead one limb, then fan each bead out to the left and to the right. */
  const growLimb = (a, b, flat, side, up) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const spine = beadSpine(a, b, L)
    // HOW MANY FANS A BEAD MAY THROW IS ITS DISTANCE FROM THE TIP: none at the
    // tip, one at the bead before it, two before that. That is what makes a limb
    // taper to a point instead of ending in a pom-pom, and it does it as a ramp
    // over the whole limb rather than as a rule about the last two beads.
    //
    // Capped at a fraction of the limb's own bead count so the ramp cannot run
    // away on a long limb: without it the innermost bead of a twelve-bead bough
    // is allowed eleven fans, and the crown grows a solid collar round the
    // trunk that nothing can see.
    const cap = Math.round(p.offshootCap * spine.length)
    const lastAng = [null, null]
    for (let i = 0; i < spine.length; i++) {
      // A budget for the WHOLE bead, not per side: allowed one each way it is
      // two leaves, and the point the rule exists to make goes blunt again.
      let budget = Math.min(spine.length - 1 - i, cap)
      if (budget <= 0) continue
      for (const sgn of [-1, 1]) {
        const want = Math.min(budget, Math.round(rand(p.offshootMin, p.offshootMax)))
        if (want <= 0) continue
        const s = sgn < 0 ? 0 : 1
        const got = growOffshoot(spine[i].q, flat, side, sgn, want, lastAng[s], up, spine[i].s)
        if (got.grown) lastAng[s] = got
        budget -= got.grown
      }
    }
  }

  for (const br of branches) growLimb(br.a, br.b, br.flat, br.side, false)
  for (const sb of subs) growLimb(sb.from, sb.to, sb.flat, sb.side, false)

  // THE LEADER IS ONE MORE LIMB. Beaded up the trunk over the top `topFraction`
  // of the height, with `topOffshoots` single leaves thrown outward and UPWARD
  // off each bead at haphazard azimuths -- a spire is lit from above and the
  // branches have run out by then, so a drooping fan up here reads as a tassel.
  {
    const y0 = h * (1 - p.topFraction)
    const a = trunkAt(y0), b = trunkAt(h)
    const spine = beadSpine(a, b, h * p.topFraction)
    for (const bead of spine) {
      const q = bead.q
      for (let j = 0; j < p.topOffshoots; j++) {
        const th = rng() * Math.PI * 2
        const flat = [Math.cos(th), 0, Math.sin(th)]
        growOffshoot(q, flat, [-flat[2], 0, flat[0]], 1, 1, null, true, bead.s)
      }
    }
  }

  if (!centres.length) {
    throw new Error('tree-spray: the crown came out empty -- check minGap, leafWidth and branchCount')
  }

  // --- the leaves themselves ------------------------------------------------
  const leaves = []
  for (let li = 0; li < centres.length; li++) {
    const c = centres[li]
    const axis = trunkAt(c[1])
    const rx = c[0] - axis[0], rz = c[2] - axis[2]
    const r = Math.hypot(rx, rz) || 1e-4
    const depth = depthAt(c)
    // The local density, off the grid the rejection already built. This is the
    // honest occlusion term: how much light reaches a leaf is decided by its
    // NEIGHBOURS, not by how far it sits from an idealised hull.
    const crowd = grid.count(c, p.aoRadius)
    leaves.push({
      c,
      out: norm([rx / r, p.normalTilt, rz / r]),
      size: p.leafWidth * scales[li] * rand(1 - p.leafVary, 1 + p.leafVary),
      roll: rng() * Math.PI * 2,
      uvRoll: rng() * Math.PI * 2,
      uvAt: [rng(), rng()],
      depth,
      crowd,
      hue: rand(-1, 1) * p.hueVary,
      value: rand(-1, 1) * p.valueVary,
    })
  }
  // The crowd counts are only meaningful against the crown's own busiest spot;
  // a fixed divisor would make aoStrength mean something different on every
  // tree it is handed.
  let crowdMax = 1
  for (const v of leaves) if (v.crowd > crowdMax) crowdMax = v.crowd

  // --- emit -----------------------------------------------------------------
  const pos = [], nor = [], col = [], uv = [], off = [], layer = [], idx = []

  const shadeAt = (y) => 0.55 + 0.45 * Math.min(1, Math.max(0, (y - crownBase) / Math.max(1e-3, h - crownBase)))

  const ring = (a, b, ra, rb, sides, v0, v1) => {
    const d = norm(sub(b, a))
    const uAx = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
    const vAx = norm(cross(uAx, d))
    const base = pos.length / 3
    for (let s = 0; s <= sides; s++) {
      const th = (s / sides) * Math.PI * 2
      const cs = Math.cos(th), sn = Math.sin(th)
      const nx = uAx[0] * cs + vAx[0] * sn, ny = uAx[1] * cs + vAx[1] * sn, nz = uAx[2] * cs + vAx[2] * sn
      for (const [q, rr, vv] of [[a, ra, v0], [b, rb, v1]]) {
        pos.push(q[0] + nx * rr, q[1] + ny * rr, q[2] + nz * rr)
        nor.push(nx, ny, nz)
        // Wood is shaded down toward the crown's own light so a limb inside the
        // canopy does not read as a bright stick laid over a dark mass.
        const sh = shadeAt(q[1])
        col.push(sh, sh, sh)
        uv.push(s / sides * 2.2, vv)
        off.push(0, 0)
        layer.push(barkLayer)
      }
    }
    for (let s = 0; s < sides; s++) {
      const i = base + s * 2
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2)
    }
  }

  // One ring and an apex. A ring PAIR ending in a flat cut-off top costs a
  // second ring of vertices to draw a lid nobody sees from the ground, so every
  // limb and the leader's last segment are cones instead.
  const cone = (a, b, ra, sides, v0, v1) => {
    const d = norm(sub(b, a))
    const uAx = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
    const vAx = norm(cross(uAx, d))
    const base = pos.length / 3
    for (let s = 0; s <= sides; s++) {
      const th = (s / sides) * Math.PI * 2
      const cs = Math.cos(th), sn = Math.sin(th)
      const nx = uAx[0] * cs + vAx[0] * sn, ny = uAx[1] * cs + vAx[1] * sn, nz = uAx[2] * cs + vAx[2] * sn
      pos.push(a[0] + nx * ra, a[1] + ny * ra, a[2] + nz * ra)
      nor.push(nx, ny, nz)
      const sh = shadeAt(a[1])
      col.push(sh, sh, sh)
      uv.push(s / sides * 2.2, v0)
      off.push(0, 0)
      layer.push(barkLayer)
    }
    const apex = pos.length / 3
    pos.push(b[0], b[1], b[2])
    nor.push(d[0], d[1], d[2])
    const shTip = shadeAt(b[1])
    col.push(shTip, shTip, shTip)
    uv.push(1.1, v1)
    off.push(0, 0)
    layer.push(barkLayer)
    for (let s = 0; s < sides; s++) idx.push(base + s, apex, base + s + 1)
  }

  const trunkSides = Math.max(3, p.trunkSides | 0)
  const branchSides = Math.max(3, p.branchSides | 0)
  for (let i = 0; i < trunkPts.length - 1; i++) {
    const last = i === trunkPts.length - 2
    const v0 = trunkPts[i][1] / 1.2, v1 = trunkPts[i + 1][1] / 1.2
    if (last) cone(trunkPts[i], trunkPts[i + 1], trunkRadiusAt(trunkPts[i][1]), trunkSides, v0, v1)
    else {
      ring(trunkPts[i], trunkPts[i + 1], trunkRadiusAt(trunkPts[i][1]), trunkRadiusAt(trunkPts[i + 1][1]),
        trunkSides, v0, v1)
    }
  }
  for (const br of branches) cone(br.a, br.b, br.len * p.branchWidth + 0.004, branchSides, 0, 3)
  for (const s of subs) cone(s.from, s.to, s.r, branchSides, 0, 2)
  const woodIndices = idx.length

  // The palette, then the three corners. `aOffset` carries the whole triangle:
  // the equilateral, jittered, rotated by this leaf's roll, in metres of VIEW
  // space. Position is the centre, three times over.
  const TAU = Math.PI * 2
  const R_OF_SIDE = 1 / Math.sqrt(3)
  for (const v of leaves) {
    // Value structure: deep in the crown is dark, and a crowded neighbourhood
    // is darker still. Both floor out at aoFloor so nothing goes to black.
    const shade = Math.min(1, v.depth * p.depthShade + (v.crowd / crowdMax) * p.aoStrength)
    const k = Math.max(p.aoFloor, 1 - shade)
    const base = k < 0.5
      ? mix3(p.needleDark, p.needleMid, k * 2)
      : mix3(p.needleMid, p.needleTip, (k - 0.5) * 2)
    const tint = [
      Math.max(0, base[0] * (1 + v.value) * (1 - v.hue * 0.5)),
      Math.max(0, base[1] * (1 + v.value) * (1 + v.hue * 0.3)),
      Math.max(0, base[2] * (1 + v.value) * (1 - v.hue * 0.4)),
    ]
    const R = v.size * R_OF_SIDE
    const first = pos.length / 3
    for (let cIdx = 0; cIdx < 3; cIdx++) {
      // The corner, off an equilateral and then pushed off it. Angle jitter is
      // scaled by the 120 degrees between corners so `leafJitter` reads the
      // same whatever the leaf's size.
      const a = v.roll + cIdx * (TAU / 3) + rand(-1, 1) * p.leafJitter * (TAU / 3) * 0.5
      const rr = R * (1 + rand(-1, 1) * p.leafJitter)
      pos.push(v.c[0], v.c[1], v.c[2])
      nor.push(v.out[0], v.out[1], v.out[2])
      col.push(tint[0], tint[1], tint[2])
      off.push(Math.cos(a) * rr, Math.sin(a) * rr)
      // A RANDOM PATCH OF THE TILE, at its own random angle. `uvAt` is where
      // this leaf cut its patch from and `uvRoll` is how it was turned, so no
      // two leaves show the same needles the same way up. The tile is solid --
      // no alpha anywhere -- so a patch may run off an edge and wrap; nothing
      // is cropped to nothing and the seam is invisible in needle mat.
      //
      // `rr / R` carries the same radius jitter the geometry corner took, so
      // the patch tracks a lopsided leaf instead of sliding under it.
      const ua = v.uvRoll + cIdx * (TAU / 3)
      const ur = 0.5 * (rr / R) * p.leafPatch
      uv.push(v.uvAt[0] + Math.cos(ua) * ur, v.uvAt[1] + Math.sin(ua) * ur)
      layer.push(-1)
    }
    idx.push(first, first + 1, first + 2)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(uv, 2))
  geo.setAttribute('aOffset', new THREE.Float32BufferAttribute(off, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(layer, 1))
  geo.setIndex(idx)

  // The bounding sphere has to be padded by hand: every leaf's `position` is
  // its centre, so three.js's own version would fit a sphere to the centres and
  // cull the crown the moment its rim was all that was on screen.
  geo.computeBoundingSphere()
  let maxLeaf = 0
  for (const v of leaves) if (v.size > maxLeaf) maxLeaf = v.size
  geo.boundingSphere.radius += maxLeaf

  const leafArea = leaves.reduce((s, v) => s + (Math.sqrt(3) / 4) * v.size * v.size, 0)
  let crownRadius = 0
  for (let i = 0; i < PROFILE; i++) if (profile[i] > crownRadius) crownRadius = profile[i]
  let meanSize = 0
  for (const v of leaves) meanSize += v.size
  meanSize /= leaves.length

  return {
    geometry: geo,
    stats: {
      height: h,
      crownRadius,
      leaves: leaves.length,
      spineLeaves,
      offshootLeaves: leaves.length - spineLeaves,
      branches: branches.length,
      subs: subs.length,
      // Every leaf faces the camera, so its projected area IS its area -- no
      // |n . d| to average away. This is the crown's silhouette before overlap,
      // which makes leafArea / silhouette a true layer count.
      coverage: leafArea,
      meanSize,
      blocked,
      minGap: cell,
      woodTris: woodIndices / 3,
      woodIndices,
      tris: idx.length / 3,
    },
  }
}

/**
 * The crown's material. The billboard is the first two lines of main(); the
 * rest is the same position-only lighting model the other billboard bench uses,
 * so the two differ in the growth rule and in nothing else.
 */
export function createSprayFoliageMaterial(opts = {}) {
  const uniforms = {
    uSun: { value: new THREE.Vector3(0.44, 0.74, 0.30).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.955, 0.885) },
    uSkyColor: { value: new THREE.Color(0.42, 0.55, 0.72) },
    uGroundColor: { value: new THREE.Color(0.17, 0.15, 0.11) },
    uSunStrength: { value: 2.05 },
    uAmbient: { value: 0.46 },
    uWrap: { value: 0.24 },
    uGrow: { value: 1 },
    // The tile, and the mean it is divided by, so the image reads as needles
    // over the tuned palette rather than as a repaint. Nothing reads its alpha.
    uMap: { value: null },
    uMapMean: { value: new THREE.Vector3(1, 1, 1) },
    uMapMix: { value: 0.65 },
    uFogColor: { value: new THREE.Color(0x0a1018) },
    uFogNear: { value: 40 },
    uFogFar: { value: 200 },
    ...opts.uniforms,
  }

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec2 aOffset;
      // uvProj, not uv: the whole prop library names its texture coordinate
      // that, and ShaderMaterial's built-in uv is not on this geometry.
      attribute vec2 uvProj;
      uniform float uGrow;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying float vDepth;
      varying vec2 vUv;

      void main() {
        vColor = color;
        vUv = uvProj;
        // WORLD space, not view. normalMatrix is the inverse-transpose of the
        // MODELVIEW matrix, so it hands back a normal that turns with the
        // camera -- dotted against a world-space uSun that sends a third of the
        // crown black from below. mat3(modelMatrix) is the honest one here: the
        // prop is never non-uniformly scaled.
        vNormal = normalize(mat3(modelMatrix) * normal);
        // THE BILLBOARD, whole. The leaf centre goes through modelView like any
        // other point; the corner is then added in VIEW space, where x and y
        // are the screen's axes by construction. That is what makes it face the
        // camera on all three axes rather than spinning about one -- and the
        // leaf's own random roll is already baked into aOffset.
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xy += aOffset * uGrow;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSun, uSunColor, uSkyColor, uGroundColor, uFogColor;
      uniform float uSunStrength, uAmbient, uWrap;
      uniform float uFogNear, uFogFar;
      uniform sampler2D uMap;
      uniform vec3 uMapMean;
      uniform float uMapMix;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying float vDepth;
      varying vec2 vUv;

      void main() {
        vec3 n = normalize(vNormal);
        vec3 albedo = vColor;
        if (uMapMix > 0.0) {
          vec3 t = texture2D(uMap, vUv).rgb / uMapMean;
          albedo *= mix(vec3(1.0), t, uMapMix);
        }
        // The normal is the CROWN's, not the plate's, so it can tip past the
        // horizon and face away from the sun. A wrap term keeps that off black.
        float ndl = dot(n, uSun);
        float diff = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
        vec3 amb = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5) * uAmbient;
        // No transmission lobe. A backlit rim is a function of where you are
        // standing, and every term here has to be a function of where the LEAF
        // is or the crown changes colour as you walk around it.
        vec3 lit = albedo * (amb + uSunColor * uSunStrength * diff);
        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = vec4(mix(lit, uFogColor, fog), 1.0);
      }
    `,
    vertexColors: true,
    // A billboard never presents a back face -- the baked offsets keep one
    // winding -- but a leaf costs nothing to draw both ways and culling it
    // would make a sign slip anywhere upstream show up as half a missing crown.
    side: THREE.DoubleSide,
    transparent: false,
  })
}
