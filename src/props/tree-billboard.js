import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// A PINE WHOSE CROWN IS ONE BILLBOARD TRIANGLE PER LEAF. The bench is
// /gen-tree-v5; nothing in the shipped forest imports this.
//
// WHAT IS DIFFERENT FROM props/tree-voxel.js, which is the same idea with
// world-oriented plates: every leaf here faces the camera, fully, on all three
// axes. That is worth up to 2x the silhouette per triangle and the reason is
// geometric rather than clever -- a double-sided plate at a random orientation
// projects A * |n . d|, which averages to A/2 over all view directions, while a
// camera-facing plate projects A from everywhere and is never edge-on. Half the
// triangle budget of an oriented crown is spent on plates the viewer is
// currently looking along the edge of. This one spends none.
//
// The union eats most of that: at three overlapping layers, doubling per-leaf
// area buys far less than double the silhouette. The useful way to spend it is
// the other direction -- the same crown on fewer leaves.
//
// THE BILLBOARD IS FREE, AND SO IS ITS ROLL. Each vertex carries `aOffset`, its
// corner's position in metres in VIEW space, already rotated by that leaf's own
// random roll. The vertex shader adds it to the leaf centre after the modelView
// transform and does nothing else:
//
//     mv = modelViewMatrix * vec4(centre, 1);  mv.xy += aOffset;
//
// So the roll costs nothing at runtime -- it is baked into a number the shader
// was going to read anyway. The same trick pays for the TEXTURE roll: uvProj is
// a triangle cut out of the tile at an independent random angle and a random
// place, so no two leaves show the same needles at the same rotation, and that
// also costs nothing. Neither is worth a uniform, a branch, or a matrix.
//
// WHAT IT COSTS INSTEAD is the thing billboards always cost: BILLBOARD SWIM.
// Turn your head and every plate counter-rotates. Near-equilateral triangles
// are the cheapest defence -- a shape three-fold symmetric to begin with has
// little rotation left to read -- which is why the leaf here is a jittered
// equilateral rather than the scalene dart tree-voxel.js grows. Push
// `leafJitter` up and the swim becomes visible; that is the knob it is on.
//
// THE CROWN IS GROWN, NOT SCATTERED. A leaf is seeded at every branch tip, sub
// tip and the trunk tip; then the tips are cycled round-robin, each in turn
// budding one more leaf off a leaf it already owns. A bud lands between
// `minGap` and `maxGap` of its parent and is rejected inside `minGap` of
// anything, so connectivity is a property of the construction rather than a
// test: every leaf is a chain of touching leaves away from wood, nothing
// floats, and nothing stacks. Cycling is the part that matters -- run one tip
// to exhaustion and it eats the space its neighbours needed. `lateralBias`
// squashes the bud direction toward the horizontal, because foliage runs OUT
// along a bough far more readily than it piles up off one, and an unbiased
// sphere grows balls on sticks.
//
// The rejection grid is a spatial hash at `minGap` cells, so the whole pass is
// O(n) with a small constant, and the SAME grid then answers the neighbour
// count that darkens a buried leaf. Two things off one structure.
//
// THE TINT IS TWO TERMS AND A ROLL. `depthShade` darkens by how far inside the
// crown hull a leaf sits, measured against a radius profile taken off the
// branches this seed actually grew. `aoStrength` darkens by how many leaves are
// within `aoRadius` -- the local density, which is what actually decides how
// much light reaches a spot, and the term that gives a clump a dark heart. Then
// `hueVary` and `valueVary` roll each leaf off the palette so the crown is not
// one flat colour with a gradient on it.
//
// THE NORMAL IS THE CROWN'S, not the plate's, and here it has to be: a
// camera-facing triangle has no meaningful normal of its own -- it is whatever
// direction you happen to be standing. Shading by it would light the whole
// crown flat and repaint it every time you moved. So each leaf is lit by the
// direction the CROWN faces there (radial off the trunk axis, tipped up by
// `normalTilt`), which makes the canopy read as one rounded mass and is stable
// under head motion. This is not a compromise; it is the only normal a
// billboard crown has.
//
// THE TILE IS SOLID and nothing reads its alpha. `discard` anywhere in the
// program turns off low-resolution-Z for the whole draw on a tiled Adreno,
// which is the entire reason opaque foliage is worth building at all.
// ---------------------------------------------------------------------------

export const BILLBOARD_PINE_DEFAULTS = {
  seed: 7,
  height: 9,

  // --- the skeleton ---------------------------------------------------------
  trunkSegs: 4,
  trunkRadius: 0.013,      // as a fraction of height, at the foot
  trunkTaper: 0.22,        // and what is left of it at the tip
  trunkKink: 0.014,        // how far a trunk node may step off the last one
  firstBranch: 0.22,       // fraction of height the crown starts at
  branchCount: 34,
  branchJitter: 0.8,       // how far off its slot a branch may slide
  branchLength: 0.34,      // longest branch as a fraction of height
  branchMin: 0.30,         // and the shortest, at the leader
  branchWidth: 0.030,      // branch base radius as a fraction of its length
  // SUBS ARE PER METRE OF BRANCH, not per branch. A fixed count spends the same
  // triangles on a 30 cm twig near the leader as on a 3 m limb at the skirt.
  subsPerMetre: 1,
  // A limb shorter than this is not built at all. Below about half a metre a
  // branch is three triangles nobody can see through the foliage sitting on it,
  // and the leaves it would have seeded are better spent on a limb that reads.
  branchMinLength: 0.5,
  trunkSides: 5,           // /gen-tree-v3's tessellation, so the two crowns'
  branchSides: 3,          // triangle counts differ in the FOLIAGE and nowhere else
  branchAngle: 0.10,       // radians above horizontal at the trunk
  branchRise: 0.55,        // extra lift toward the leader
  branchDroop: 0.55,       // total bend from launch to tip
  branchSway: 0.35,        // sideways wander over the same run
  crownPeak: 0.30,         // height fraction the longest branches sit at
  crownFullness: 1.15,     // how fast they shorten toward the leader
  // THE CONE THE WOOD MAY NOT LEAVE. A branch is clipped so its reach off the
  // trunk never exceeds this fraction of the height at the crown base, falling
  // linearly to nothing at the leader. Without it the shape formula still hands
  // a branch at the very top most of `branchMin`, and the tree loses the clean
  // triangular profile a conifer is read by.
  crownCone: 0.20,
  subStart: 0.30,          // how far out the parent before a sub may leave
  subLength: 0.42,
  subAngle: 0.95,
  subDroop: 0.22,

  // --- the leaves -----------------------------------------------------------
  //
  // A LEAF IS ONE TRIANGLE, and `leafWidth` is its side in metres. The corners
  // start on an equilateral (circumradius = side / sqrt(3)) and `leafJitter`
  // pushes each one off in angle and in radius, so no two leaves are the same
  // shape but every leaf is still close enough to three-fold that its roll does
  // not read as spin when you turn your head.
  leafWidth: 0.39,
  leafJitter: 0.18,        // fraction of a corner's angle and radius it may stray
  leafVary: 0.28,          // +/- this fraction on the whole leaf's size
  leafPatch: 1.0,          // leaf circumcircle as a fraction of the tile's width

  // HOW THE CROWN GROWS. `leafTarget` is the leaf count the budding pass aims
  // for; it stops early if the crown genuinely runs out of legal room, which is
  // the honest signal that the gaps are too wide for the hull.
  //
  // `leafWidth` and `leafTarget` are tuned together against two budgets, and
  // the second is the one that actually binds on a Quest 2: 1400 leaves is 2.0k
  // triangles, comfortably inside 3k, but 93.8 m2 of leaf against a ~22 m2
  // silhouette is already four layers of overdraw where /gen-tree-v3 runs 2.6.
  // Pull this down before anything else if the headset is fill-bound.
  //
  // Wider leaves are how the coverage is bought, and it has to be that way: the
  // gap scales with `leafWidth`, so a crown of a given volume holds leaves in
  // proportion to 1/width^3 while each carries width^2. At a FIXED triangle
  // count, then, coverage goes as width^2 -- more, smaller leaves is strictly
  // the wrong direction, and 0.20 m leaves managed only 34 m2 here.
  leafTarget: 1000,
  picks: 1,                // leaves a tip tries per round
  dirs: 8,                 // directions a bud scores before the best one wins
  // STRIKES BEFORE A LEAF IS RETIRED. One failed round is not evidence: the
  // directions are random, so a leaf with a narrow way out fails often and
  // still has room. Retiring on the first miss loses a cluster more buddable
  // leaves per round than budding gains it, and the crown stalls well short of
  // its target -- measured, at a third of it.
  strikes: 3,
  hullSlack: 1.30,         // how far past the wood profile the foliage may sit

  // THE SLEEVE, as a fraction of the limb's own length. Foliage may only sit
  // this far off the limb that seeded it, which is what separates one bough
  // from the next. Constrain the crown by its outer HULL instead and every
  // cluster grows until it meets that one surface: the result is a hollow ball,
  // dense everywhere on the rim, empty in the middle, with no bough structure
  // left to see. This is the single knob that decides whether the tree reads as
  // layered boughs or as a shrub.
  sleeve: 0.50,

  // LIGHT SEEKING. Of the `dirs` candidate directions a bud tries, the one that
  // ends up with the fewest leaves above it wins. `skyRadius` is how far up it
  // looks; `lightWeight` is how much that score is trusted against a coin toss,
  // and it is the clumpiness knob: at 1 the crown grows a hard sunlit crust and
  // nothing underneath, at 0 it is an isotropic blob again.
  skyRadius: 0.9,
  lightWeight: 0.7,

  // GROWTH AND SUBSUMPTION. Every new bud fattens its parent by `growPerChild`
  // AND every ancestor above it, so a leaf's size is a running count of how
  // much foliage is outboard of it. That is the whole trick: a leaf at the
  // growing front has no descendants and stays small, while one back near the
  // branch carries the entire spray beyond it and swells. Buried-ness falls out
  // of the topology instead of being measured against a hull.
  //
  // The accumulation is ADDITIVE. Compounding it -- x1.2 per descendant, up the
  // whole chain -- explodes: measured, it drove nearly every leaf to the cap and
  // stalled the crown at a quarter of its target, because subsumption then eats
  // the lit rim, where budding actually succeeds, rather than the dead middle.
  //
  // At `subsumeAt` a leaf eats its direct children: they leave the mesh, their
  // own children re-parent onto it, the triangles go back to the budget, and
  // the leaf is drawn `subsumeAt` times wider to stand in for what it ate.
  // Their spacing claim STAYS in the grid, so the space is not refilled. The
  // leaf then caps -- it keeps its size and can still bud, but never grows
  // again, which is what stops one seed swallowing its cluster.
  //
  // ONLY A LEAF THAT HAS ACTUALLY EATEN IS DRAWN BIGGER. Scaling every leaf by
  // its running count instead is the obvious reading and it is wrong twice
  // over: a leaf whose children are all still there has covered nothing, and
  // most leaves sit part-way up the count, so the crown's total leaf area --
  // the number that decides the fill rate -- inflated by two thirds for no
  // silhouette at all.
  growPerChild: 0.20,
  subsumeAt: 2.0,

  // THE SPACING BAND, both ends in multiples of the mean leaf width.
  //
  // `minGap` is the rejection radius: no two leaves closer than this. Push it
  // down and leaves stack into a clumpy mat; push it up and the crown sprawls
  // and eventually cannot reach its target.
  //
  // `maxGap` is the bud reach, and it is the one that kills floating voxels: a
  // new leaf is placed no further than this from the leaf it grew off, and the
  // seeds sit on the wood. Every leaf is therefore anchored to a branch by a
  // chain of leaves that each touch.
  //
  // The two ends have to leave a band to live in: at minGap >= maxGap nothing
  // can satisfy both at once. Keep minGap comfortably the smaller of the two.
  minGap: 0.55,
  maxGap: 1.0,

  // --- the tint -------------------------------------------------------------
  needleDark: [0.055, 0.098, 0.052],
  needleMid: [0.128, 0.212, 0.104],
  needleTip: [0.207, 0.316, 0.150],
  depthShade: 0.85,        // darkening by depth inside the crown hull
  aoRadius: 0.42,          // metres a neighbour has to be inside to shade a leaf
  aoStrength: 0.9,         // and how hard the local density darkens
  aoFloor: 0.22,           // how dark that is ever allowed to get
  hueVary: 0.10,
  valueVary: 0.16,
  normalTilt: 1.6,         // how far the crown normal tips up off radial
}

export const BILLBOARD_SPECIES = {
  pine: {
    label: 'pine',
    barkLayer: LAYER.BARK_PINE,
    // Served straight off the project root by the dev server -- see the
    // propOriginals note in vite.config.js. tmp/ is gitignored, so this tile is
    // a bench input, not a shipped asset.
    tile: '/tmp/leaves/pine-mat-solid.png',
    params: {},
  },
}

export function billboardSpecies(name) {
  const sp = BILLBOARD_SPECIES[name]
  if (!sp) throw new Error(`tree-billboard: no species "${name}"`)
  return { ...BILLBOARD_PINE_DEFAULTS, ...sp.params }
}

const lerp = (a, b, t) => a + (b - a) * t
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
function norm(a) {
  const l = len(a)
  if (!(l > 1e-9)) throw new Error('tree-billboard: cannot normalise a zero vector')
  return [a[0] / l, a[1] / l, a[2] / l]
}
/** Distance from q to the segment ab -- the sleeve test, once per candidate. */
function distToSeg(q, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
  const qax = q[0] - a[0], qay = q[1] - a[1], qaz = q[2] - a[2]
  const L2 = abx * abx + aby * aby + abz * abz
  let t = L2 > 1e-9 ? (qax * abx + qay * aby + qaz * abz) / L2 : 0
  t = Math.min(1, Math.max(0, t))
  return Math.hypot(qax - abx * t, qay - aby * t, qaz - abz * t)
}
function alongPolyline(pts, u) {
  const f = Math.min(pts.length - 1.001, Math.max(0, u * (pts.length - 1)))
  const i = Math.floor(f), k = f - i
  const a = pts[i], b = pts[i + 1]
  return { p: [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)], tan: norm(sub(b, a)) }
}

/**
 * A spatial hash at one cell per `cell` metres. Answers "is anything within r"
 * and "how many are within r" over the same buckets, which is the whole reason
 * the Poisson rejection and the ambient-occlusion term share a structure.
 *
 * The key is a mixed integer hash rather than a string: collisions only put
 * extra points in a bucket, and every candidate is distance-checked anyway, so
 * a collision costs a comparison and can never produce a wrong answer.
 */
function hashGrid(cell) {
  const buckets = new Map()
  const key = (i, j, k) => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) | 0
  const at = (p) => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)]
  return {
    add(p) {
      const [i, j, k] = at(p)
      const h = key(i, j, k)
      const b = buckets.get(h)
      if (b) b.push(p); else buckets.set(h, [p])
    },
    /** True if any stored point is within `r` of p. */
    near(p, r) {
      const [i, j, k] = at(p)
      const rr = r * r
      const span = Math.ceil(r / cell)
      for (let a = -span; a <= span; a++) {
        for (let b = -span; b <= span; b++) {
          for (let c = -span; c <= span; c++) {
            const bucket = buckets.get(key(i + a, j + b, k + c))
            if (!bucket) continue
            for (const q of bucket) {
              const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2]
              if (dx * dx + dy * dy + dz * dz < rr) return true
            }
          }
        }
      }
      return false
    },
    /**
     * How many stored points are within `r` of p AND above it. The crown's
     * light model, and deliberately the cheapest one that is not a lie: a leaf
     * is shaded by what is over it, not by how far it sits from an idealised
     * hull. Shares the buckets with everything else here.
     */
    countAbove(p, r) {
      const [i, j, k] = at(p)
      const rr = r * r
      const span = Math.ceil(r / cell)
      let n = 0
      for (let a = -span; a <= span; a++) {
        for (let b = 0; b <= span; b++) {
          for (let c = -span; c <= span; c++) {
            const bucket = buckets.get(key(i + a, j + b, k + c))
            if (!bucket) continue
            for (const q of bucket) {
              if (q[1] <= p[1]) continue
              const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2]
              if (dx * dx + dy * dy + dz * dz < rr) n++
            }
          }
        }
      }
      return n
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
            for (const q of bucket) {
              const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2]
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
 * crown with another -- the same arrangement /gen-tree-v3 uses.
 *
 * Foliage attributes: `position` is the leaf's CENTRE, repeated for all three
 * corners, and `aOffset` is what makes it a triangle. Nothing downstream should
 * expect `position` alone to describe the leaf's extent -- the bounding sphere
 * set here is padded for exactly that reason.
 */
export function buildBillboardPine(params = {}, barkLayer = 0) {
  const p = { ...BILLBOARD_PINE_DEFAULTS, ...params }
  const rng = mulberry32((p.seed | 0) * 2654435761 % 2147483647 || 12345)
  const rand = (a, b) => a + (b - a) * rng()
  const h = p.height

  // --- the skeleton ---------------------------------------------------------
  //
  // Built whole before a leaf is placed, because the crown's RADIUS PROFILE has
  // to exist before a leaf can be told how deep inside it it sits, and that
  // profile is measured off the branches this seed grew rather than assumed.
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
    // The cone runs out before the leader does, so the top of the tree has no
    // branch long enough to be worth three triangles. It is clothed by the
    // leader sleeve below instead of by a fan of stubs.
    if (L < p.branchMinLength) continue
    branches.push({
      y: Math.min(crownTop - 0.02, Math.max(crownBase, y)), t, yaw, len: L,
      rise: p.branchAngle + p.branchRise * t * t,
    })
  }
  if (!branches.length) throw new Error('tree-billboard: crownCone leaves no branch over branchMinLength')

  // A BRANCH IS ONE STRAIGHT STICK. Three triangles, base to tip, so droop and
  // sway can only be a launch direction -- there is no polyline left to bend.
  // The tip lands where the old curve's tip landed, which is what the crown
  // profile was ever reading, and the missing sag is under foliage anyway.
  // The spacing band, needed here because the crown profile is floored in leaf
  // widths and the profile has to exist before a leaf can be placed against it.
  const gap = Math.max(1e-3, p.minGap * p.leafWidth)
  const step = Math.max(gap * 1.02, p.maxGap * p.leafWidth)

  const PROFILE = 32
  const profile = new Float32Array(PROFILE)
  for (const br of branches) {
    const base = trunkAt(br.y)
    const r0 = trunkRadiusAt(br.y)
    const launch = [Math.cos(br.yaw) * Math.cos(br.rise), Math.sin(br.rise), Math.sin(br.yaw) * Math.cos(br.rise)]
    const side = [-Math.sin(br.yaw), 0, Math.cos(br.yaw)]
    const sway = rand(-1, 1) * p.branchSway
    const dir = norm([
      launch[0] + side[0] * sway * 0.5,
      launch[1] - p.branchDroop * 0.5,
      launch[2] + side[2] * sway * 0.5,
    ])
    br.dir = dir
    br.a = [base[0] + dir[0] * r0, base[1] + dir[1] * r0, base[2] + dir[2] * r0]
    br.b = [br.a[0] + dir[0] * br.len, br.a[1] + dir[1] * br.len, br.a[2] + dir[2] * br.len]
    for (const q of [br.a, br.b]) {
      const ax = trunkAt(q[1])
      const r = Math.hypot(q[0] - ax[0], q[2] - ax[2])
      const bin = Math.min(PROFILE - 1, Math.max(0, Math.floor(q[1] / h * PROFILE)))
      if (r > profile[bin]) profile[bin] = r
    }
  }
  // The design cone is a FLOOR under the measured profile, not a rival to it.
  // Measured alone, the profile is zero everywhere above the last branch --
  // and crownCone deliberately runs the branches out before the leader does --
  // so the hull test would pinch the leader sleeve down to its 5 cm clamp and
  // leave the top of the tree a bare stick.
  for (let i = 0; i < PROFILE; i++) {
    const y = (i + 0.5) / PROFILE * h
    const t = Math.min(1, Math.max(0, (y - crownBase) / Math.max(1e-3, crownTop - crownBase)))
    // Never below a couple of leaf widths, or the spire pinches to a column one
    // leaf wide and the top metre reads as three leaves stuck on a bare stick.
    if (y >= crownBase) profile[i] = Math.max(profile[i], p.crownCone * h * (1 - t), step)
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

  // Sub-branches, also one stick each. Their tips seed the crown alongside the
  // branch tips, and the same half-metre floor applies.
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
      subs.push({ from, dir, len: L, r, to: [from[0] + dir[0] * L, from[1] + dir[1] * L, from[2] + dir[2] * L] })
    }
  }

  // --- where the leaves go --------------------------------------------------
  //
  // THREE RULES, and each one answers a way the crown used to look wrong.
  //
  // SLEEVES. A cluster belongs to one limb and may not stray more than
  // `sleeve` x that limb's length off it. Constrain the crown by its outer hull
  // instead -- which is what the previous pass did -- and every cluster grows
  // until it reaches that one surface, so the tree comes out a hollow ball:
  // measured, 74% of leaves in the outer fifth of the radius, and a middle with
  // nothing in it. Sleeves give each bough its own tapered tube, and the gaps
  // between boughs are what you actually read a conifer by.
  //
  // LIGHT. A bud tries `dirs` directions and takes the one with the fewest
  // leaves above it. Without this the neighbour histogram is a clean bell
  // around 7 -- the signature of an isotropic Poisson packing, not of anything
  // that grew -- and every cluster is the same round blob. Seeking light makes
  // foliage crust on the sunlit top of a bough and thin underneath, which is
  // where the shape of real needle-spray comes from. `lightWeight` trades that
  // against a coin toss, and it is the clumpiness knob.
  //
  // GROWTH AND SUBSUMPTION. Every bud fattens its parent and every ancestor
  // above it, so a leaf's size counts the foliage outboard of it. A leaf that
  // reaches `subsumeAt` eats its direct children: they leave the mesh, their
  // children re-parent onto it, and their triangles go back to the budget --
  // but their spacing claim STAYS IN THE GRID, so nothing refills the hole.
  // Interior detail nobody sees through the shell buys rim detail they do.
  const grid = hashGrid(gap)

  const centres = []
  const parent = []            // index of the leaf this one budded off, -1 for a seed
  const kids = []              // and back the other way, for subsumption
  const grow = []              // size multiplier, 1 at birth, additive per descendant
  const capped = []            // has subsumed once; keeps its size, grows no further
  const alive = []             // false once subsumed away
  const full = []              // out of room, not worth re-asking
  const clusterOf = [], clusterSlot = []
  const misses = []
  let tries = 0
  let subsumed = 0

  const inHull = (q) => {
    if (q[1] > h || q[1] < crownBase * 0.5) return false
    const ax = trunkAt(q[1])
    return Math.hypot(q[0] - ax[0], q[2] - ax[2]) <= crownRadiusAt(q[1]) * p.hullSlack
  }
  // A cluster's array holds only the leaves still worth asking, and retiring one
  // swap-removes it. Leaving the dead in and skipping them turns the random pick
  // into a lottery the cluster loses more of the fuller it gets.
  const clusters = []
  const place = (q, par, ci) => {
    grid.add(q)
    centres.push(q); parent.push(par); kids.push([]); grow.push(1)
    capped.push(false); alive.push(true); full.push(false); misses.push(0)
    const i = centres.length - 1
    clusterOf.push(ci); clusterSlot.push(clusters[ci].length)
    clusters[ci].push(i)
    if (par >= 0) kids[par].push(i)
    return i
  }
  const retire = (i) => {
    if (full[i]) return
    full[i] = true
    const cl = clusters[clusterOf[i]], sIdx = clusterSlot[i]
    const last = cl.pop()
    if (sIdx < cl.length) { cl[sIdx] = last; clusterSlot[last] = sIdx }
  }

  // Fatten the whole chain above a new bud, one increment each.
  const fatten = (i) => {
    for (let k = i; k >= 0; k = parent[k]) if (!capped[k]) grow[k] += p.growPerChild
  }

  // A leaf at `subsumeAt` eats its direct children. Grandchildren re-parent
  // onto it so the chain stays whole; the grid keeps every removed point, so
  // the space stays claimed and the crown does not simply grow back into it.
  // See the defaults for why it caps rather than retires.
  const subsume = (i) => {
    for (const c of [...kids[i]]) {
      if (!alive[c]) continue
      retire(c)
      alive[c] = false
      subsumed++
      for (const g of kids[c]) { parent[g] = i; kids[i].push(g) }
      kids[c] = []
    }
    kids[i] = kids[i].filter((c) => alive[c])
    capped[i] = true
  }

  // One cluster per limb: a spine to hug and a radius to stay inside. The
  // leader gets its own, because crownCone runs the branches out before the
  // trunk ends and the top would otherwise be a bare stick.
  const spines = []
  for (const br of branches) spines.push({ a: br.a, b: br.b, r: br.len * p.sleeve, seed: br.b })
  for (const sb of subs) spines.push({ a: sb.from, b: sb.to, r: sb.len * p.sleeve, seed: sb.to })
  {
    let topBranch = crownBase
    for (const br of branches) if (br.b[1] > topBranch) topBranch = br.b[1]
    const span = h - topBranch
    const n = Math.max(1, Math.round(span / Math.max(0.3, p.crownCone * h * 0.5)))
    for (let i = 0; i < n; i++) {
      const y0 = topBranch + (i / n) * span
      const y1 = topBranch + ((i + 1) / n) * span
      const a = trunkAt(y0), b = trunkAt(Math.min(h, y1))
      // The cone itself is the sleeve here, so the leader tapers to a spire.
      const t = (y0 - crownBase) / Math.max(1e-3, crownTop - crownBase)
      // A floor of a few leaf widths, or the spire tapers to nothing and the
      // top of the tree is a bare stick with two leaves on it.
      spines.push({ a, b, r: Math.max(step * 2, p.crownCone * h * (1 - t)), seed: b })
    }
  }

  for (let i = 0; i < spines.length; i++) { clusters.push([]); place(spines[i].seed.slice(), -1, i) }

  let live = clusters.length
  while (live < p.leafTarget) {
    let grew = false
    for (let ti = 0; ti < clusters.length && live < p.leafTarget; ti++) {
      const cl = clusters[ti], sp = spines[ti]
      if (!cl.length) continue
      let budded = false
      for (let pick = 0; pick < p.picks && !budded; pick++) {
        if (!cl.length) break
        const pi = cl[(rng() * cl.length) | 0]
        const par = centres[pi]
        let best = null, bestScore = -Infinity
        for (let d = 0; d < p.dirs; d++) {
          tries++
          const z = rand(-1, 1), th = rng() * Math.PI * 2, s2 = Math.sqrt(Math.max(0, 1 - z * z))
          const dir = [Math.cos(th) * s2, z, Math.sin(th) * s2]
          const dd = lerp(gap, step, rng())
          const q = [par[0] + dir[0] * dd, par[1] + dir[1] * dd, par[2] + dir[2] * dd]
          if (distToSeg(q, sp.a, sp.b) > sp.r) continue
          if (!inHull(q)) continue
          if (grid.near(q, gap)) continue
          // Fewest leaves overhead wins. The count is unbounded, so it is
          // squashed into 0..1 before it is mixed with the coin toss.
          const light = 1 / (1 + grid.countAbove(q, p.skyRadius))
          const score = light * p.lightWeight + rng() * (1 - p.lightWeight)
          if (score > bestScore) { bestScore = score; best = q }
        }
        if (best) {
          place(best, pi, ti)
          fatten(pi)
          budded = true
          grew = true
          live++
          for (let k = pi; k >= 0; k = parent[k]) {
            if (alive[k] && !capped[k] && grow[k] >= p.subsumeAt) {
              const before = subsumed
              subsume(k)
              live -= subsumed - before
              break
            }
          }
        } else if (++misses[pi] >= p.strikes) {
          retire(pi)
        }
      }
    }
    if (!grew) break
  }
  if (!centres.some((_, i) => alive[i])) {
    throw new Error('tree-billboard: the crown came out empty -- check sleeve, minGap and leafTarget')
  }

  // --- the leaves themselves ------------------------------------------------
  const leaves = []
  for (let li = 0; li < centres.length; li++) {
    if (!alive[li]) continue
    const c = centres[li]
    const axis = trunkAt(c[1])
    const rx = c[0] - axis[0], rz = c[2] - axis[2]
    const r = Math.hypot(rx, rz) || 1e-4
    const rel = Math.min(1.4, r / crownRadiusAt(c[1]))
    // 0 at the rim, 1 buried in the middle of the crown.
    const depth = Math.pow(Math.min(1, Math.max(0, 1 - rel)), 0.75)
    // The local density, off the grid the rejection already built. This is the
    // term that gives a clump a dark heart, and it is the honest one: how much
    // light reaches a leaf is decided by its NEIGHBOURS, not by how far it
    // happens to sit from an idealised hull.
    const crowd = grid.count(c, p.aoRadius)
    leaves.push({
      c,
      out: norm([rx / r, p.normalTilt, rz / r]),
      // A plate that ate its children is drawn wide enough to cover them. One
      // that has not is drawn at its birth size, whatever its running count.
      size: p.leafWidth * rand(1 - p.leafVary, 1 + p.leafVary) * (capped[li] ? p.subsumeAt : 1),
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
  let woodIndices = 0

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
        const shade = 0.55 + 0.45 * Math.min(1, Math.max(0, (q[1] - crownBase) / Math.max(1e-3, h - crownBase)))
        col.push(shade, shade, shade)
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

  // The leader, closed. A ring of quads ending in a flat cut-off top costs a
  // second ring of vertices to draw a lid nobody ever sees from the ground, so
  // the last trunk segment is a cone instead: one ring, one apex, half the
  // triangles.
  const cone = (a, b, ra, sides, v0, v1) => {
    const d = norm(sub(b, a))
    const uAx = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
    const vAx = norm(cross(uAx, d))
    const base = pos.length / 3
    const shadeAt = (y) => 0.55 + 0.45 * Math.min(1, Math.max(0, (y - crownBase) / Math.max(1e-3, h - crownBase)))
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

  // Trunk, then branches longest-first, then subs. Order matters only in that
  // wood comes before foliage in the index buffer.
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
  // THREE TRIANGLES A LIMB. A cone off a three-sided ring is the whole branch:
  // a ring pair would draw six and spend the extra on a taper nobody sees
  // through the foliage hanging off it.
  for (const br of [...branches].sort((a, b) => b.len - a.len)) {
    cone(br.a, br.b, br.len * p.branchWidth + 0.004, branchSides, 0, 3)
  }
  for (const s of subs) cone(s.from, s.to, s.r, branchSides, 0, 2)
  woodIndices = idx.length

  // The palette, and then the three corners. `aOffset` carries the whole
  // triangle: the equilateral, jittered, rotated by this leaf's roll, in metres
  // of VIEW space. Position is the centre, three times over.
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

  // The bounding sphere has to be computed by hand: every leaf's `position` is
  // its centre, so three.js's own version would fit a sphere to the centres and
  // cull the crown the moment its rim was all that was on screen.
  geo.computeBoundingSphere()
  let maxLeaf = 0
  for (const v of leaves) if (v.size > maxLeaf) maxLeaf = v.size
  geo.boundingSphere.radius += maxLeaf

  const leafArea = leaves.reduce((s, v) => s + (Math.sqrt(3) / 4) * v.size * v.size, 0)
  let crownRadius = 0
  for (let i = 0; i < PROFILE; i++) if (profile[i] > crownRadius) crownRadius = profile[i]

  return {
    geometry: geo,
    stats: {
      height: h,
      crownRadius,
      leaves: leaves.length,
      branches: branches.length,
      // Every leaf faces the camera, so its projected area IS its area -- no
      // |n . d| to average away. This number is the crown's silhouette before
      // overlap, which makes leafArea / silhouette a true layer count and this
      // the one crown whose coverage can be read straight off the build.
      coverage: leafArea,
      tries,
      subsumed,
      accepted: leaves.length / Math.max(1, tries),
      minGap: gap,
      woodTris: woodIndices / 3,
      woodIndices,
      tris: idx.length / 3,
    },
  }
}

/**
 * The crown's material. The billboard is the first two lines of main(); the
 * rest is the same lighting model /gen-tree-v3's crown uses, so the two benches
 * differ in the thing under test and in nothing else.
 */
export function createBillboardFoliageMaterial(opts = {}) {
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
        // camera -- dotted against a world-space uSun that made a third of the
        // crown go black from below. mat3(modelMatrix) is the honest one here:
        // the prop is never non-uniformly scaled.
        vNormal = normalize(mat3(modelMatrix) * normal);
        // THE BILLBOARD, whole. The leaf centre goes through modelView like any
        // other point; the corner is then added in VIEW space, where x and y
        // are the screen's axes by construction. That is what makes it face the
        // camera on all three axes rather than spinning about one -- and the
        // leaf's own random roll is already baked into aOffset, so it is not a
        // rotation this shader has to do.
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
