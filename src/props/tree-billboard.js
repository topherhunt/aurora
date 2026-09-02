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
// THE DISTRIBUTION IS CLUMPED AND SPACED AT THE SAME TIME, which sounds like a
// contradiction and is not: clumping is a property of where the clusters go,
// spacing a property of what happens inside one. Cluster centres ride the twigs
// at `clumpRate` per metre, each throwing `clumpLeaves` darts into a small ball
// around itself, and every dart is rejected if it lands within `minGap` of a
// leaf already placed. So the crown is lumpy at the 20-40 cm scale a real one
// is lumpy at, with genuine holes between the knots, and no two leaves anywhere
// overlap enough to be paying for each other. A uniform scatter at this density
// reads as a hedge; that is what the whole file is trying not to be.
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
  branchSegs: 3,
  trunkSides: 5,           // /gen-tree-v3's tessellation, so the two crowns'
  branchSides: 3,          // triangle counts differ in the FOLIAGE and nowhere else
  branchAngle: 0.10,       // radians above horizontal at the trunk
  branchRise: 0.55,        // extra lift toward the leader
  branchDroop: 0.55,       // total bend from launch to tip
  branchSway: 0.35,        // sideways wander over the same run
  crownPeak: 0.30,         // height fraction the longest branches sit at
  crownFullness: 1.15,     // how fast they shorten toward the leader
  subMin: 1,
  subMax: 2,
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
  leafWidth: 0.26,
  leafJitter: 0.18,        // fraction of a corner's angle and radius it may stray
  leafVary: 0.28,          // +/- this fraction on the whole leaf's size

  // CLUMPING, and the spacing inside it. `clumpRadius` has to be comfortably
  // larger than the gap or the cluster cannot hold the darts it is asked for --
  // a ball of radius r fits about (r / gap)^3 points at a minimum separation of
  // gap, so a tight radius silently turns clumpLeaves into two or three.
  //
  // These three and `leafWidth` are tuned together against the 3k-triangle
  // budget, and the target is /gen-tree-v3's COVERAGE: 1870 leaves and 2.8k
  // triangles carry 56.5 m2 of leaf, against v3's 58.6 m2 at 2.7k. Same cloth,
  // same budget, but none of it is ever seen edge-on -- which is the entire
  // claim this generator exists to test.
  //
  // Wider leaves are how the coverage is bought, and it has to be that way: the
  // gap scales with `leafWidth`, so a crown of a given volume holds leaves in
  // proportion to 1/width^3 while each carries width^2. At a FIXED triangle
  // count, then, coverage goes as width^2 -- more, smaller leaves is strictly
  // the wrong direction, and 0.20 m leaves managed only 34 m2 here.
  clumpRate: 2.6,          // cluster centres per metre of twig
  clumpLeaves: 10,         // darts thrown per cluster
  clumpRadius: 0.52,       // metres the cluster scatters over
  clumpOut: 0.55,          // how much of that scatter is pushed away from the twig
  // THE MINIMUM GAP, as a multiple of the average leaf width. 1 is what the
  // crown ships at: two leaves may touch and may not overlap, which is the
  // densest a billboard crown can be without paying twice for one pixel.
  minGap: 1.0,
  darts: 3,                // tries a rejected dart gets before it is given up on

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

  // --- the tile -------------------------------------------------------------
  leafPatch: 0.62,         // how much of the tile one leaf's triangle covers
}

export const BILLBOARD_SPECIES = {
  pine: {
    label: 'pine',
    barkLayer: LAYER.BARK_PINE,
    // Served straight off the project root by the dev server -- see the
    // propOriginals note in vite.config.js. tmp/ is gitignored, so this tile is
    // a bench input, not a shipped asset.
    tile: '/tmp/leaves/pine-mat-voxel.png',
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
    const L = p.branchLength * h * lerp(p.branchMin, 1, shape) * rand(0.84, 1.12)
    branches.push({
      y: Math.min(crownTop - 0.02, Math.max(crownBase, y)), t, yaw, len: L,
      rise: p.branchAngle + p.branchRise * t * t,
    })
  }

  const PROFILE = 32
  const profile = new Float32Array(PROFILE)
  for (const br of branches) {
    const pts = []
    const base = trunkAt(br.y)
    const r0 = trunkRadiusAt(br.y)
    let dir = [Math.cos(br.yaw) * Math.cos(br.rise), Math.sin(br.rise), Math.sin(br.yaw) * Math.cos(br.rise)]
    let cur = [base[0] + dir[0] * r0, base[1] + dir[1] * r0, base[2] + dir[2] * r0]
    pts.push(cur.slice())
    const side = [-Math.sin(br.yaw), 0, Math.cos(br.yaw)]
    const sway = rand(-1, 1) * p.branchSway
    for (let s = 1; s <= p.branchSegs; s++) {
      const step = br.len / p.branchSegs
      cur = [cur[0] + dir[0] * step, cur[1] + dir[1] * step, cur[2] + dir[2] * step]
      pts.push(cur.slice())
      const bend = (p.branchDroop / p.branchSegs) * (s / p.branchSegs) * 1.6
      dir = norm([dir[0] + side[0] * sway / p.branchSegs, dir[1] - bend, dir[2] + side[2] * sway / p.branchSegs])
    }
    br.pts = pts
    for (const q of pts) {
      const ax = trunkAt(q[1])
      const r = Math.hypot(q[0] - ax[0], q[2] - ax[2])
      const bin = Math.min(PROFILE - 1, Math.max(0, Math.floor(q[1] / h * PROFILE)))
      if (r > profile[bin]) profile[bin] = r
    }
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

  // Sub-branches, and the twig list. From a leaf's point of view a limb segment
  // and a sub-branch are the same thing: a line with a radius to hang off.
  const subs = []
  const twigs = []
  const pushTwig = (a, b, r0, r1) => {
    const d = sub(b, a)
    const L = len(d)
    if (L > 1e-4) twigs.push({ a, b, dir: [d[0] / L, d[1] / L, d[2] / L], len: L, r0, r1 })
  }
  for (const br of branches) {
    const rBase = br.len * p.branchWidth
    for (let i = 0; i < br.pts.length - 1; i++) {
      const t0 = i / (br.pts.length - 1), t1 = (i + 1) / (br.pts.length - 1)
      pushTwig(br.pts[i], br.pts[i + 1], rBase * (1 - t0) + 0.004, rBase * (1 - t1) + 0.004)
    }
    const n = p.subMin + Math.floor(rng() * (p.subMax - p.subMin + 1))
    for (let k = 0; k < n; k++) {
      const u = p.subStart + (1 - p.subStart) * ((k + rand(0.1, 0.9)) / n)
      const at = alongPolyline(br.pts, u)
      const tan = at.tan
      const uAx = norm(cross(tan, Math.abs(tan[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
      const phi = (k % 2 ? 1 : -1) * (1 + rand(-0.25, 0.25))
      const ang = p.subAngle * rand(0.7, 1.25)
      const dir = norm([
        tan[0] * Math.cos(ang) + uAx[0] * phi * Math.sin(ang),
        tan[1] * Math.cos(ang) + uAx[1] * phi * Math.sin(ang) - p.subDroop,
        tan[2] * Math.cos(ang) + uAx[2] * phi * Math.sin(ang),
      ])
      const L = br.len * p.subLength * rand(0.7, 1.2) * (1 - u * 0.4)
      const r = (br.len * p.branchWidth * (1 - u) + 0.004) * 0.65
      subs.push({ from: at.p, dir, len: L, r })
      pushTwig(at.p, [at.p[0] + dir[0] * L, at.p[1] + dir[1] * L, at.p[2] + dir[2] * L], r, 0.002)
    }
  }

  // --- where the leaves go --------------------------------------------------
  //
  // Clusters ride the twigs; darts land around the clusters; the grid throws
  // out any dart that lands on top of a leaf already placed. `minGap` is in
  // multiples of the mean leaf width, so the spacing tracks the leaf size and
  // one slider does not silently undo another.
  const meanWidth = p.leafWidth
  const gap = Math.max(1e-3, p.minGap * meanWidth)
  const grid = hashGrid(gap)
  const centres = []
  let thrown = 0

  for (const tw of twigs) {
    const nClumps = Math.max(1, Math.round(tw.len * p.clumpRate))
    const uAx = norm(cross(tw.dir, Math.abs(tw.dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
    const vAx = norm(cross(uAx, tw.dir))
    for (let c = 0; c < nClumps; c++) {
      const u = (c + rand(0.15, 0.85)) / nClumps
      const r = lerp(tw.r0, tw.r1, u)
      // The cluster sits ON the twig's surface, at its own roll around it. The
      // golden angle walks that roll so consecutive clusters never stack.
      const roll = c * 2.399963 + rand(-0.5, 0.5)
      const outAx = [
        uAx[0] * Math.cos(roll) + vAx[0] * Math.sin(roll),
        uAx[1] * Math.cos(roll) + vAx[1] * Math.sin(roll),
        uAx[2] * Math.cos(roll) + vAx[2] * Math.sin(roll),
      ]
      const seat = [
        tw.a[0] + tw.dir[0] * tw.len * u + outAx[0] * r,
        tw.a[1] + tw.dir[1] * tw.len * u + outAx[1] * r,
        tw.a[2] + tw.dir[2] * tw.len * u + outAx[2] * r,
      ]
      for (let k = 0; k < p.clumpLeaves; k++) {
        // Each dart gets a few tries before it is abandoned. Retrying is what
        // keeps a clump dense against the rejection radius instead of thinning
        // out the moment the first few leaves claim the middle of it.
        for (let attempt = 0; attempt < p.darts; attempt++) {
          thrown++
          // A ball around the seat, biased outward off the twig so the crown
          // grows away from the wood rather than through it.
          const q = [
            seat[0] + rand(-1, 1) * p.clumpRadius + outAx[0] * p.clumpRadius * p.clumpOut * rand(0, 1),
            seat[1] + rand(-1, 1) * p.clumpRadius + outAx[1] * p.clumpRadius * p.clumpOut * rand(0, 1),
            seat[2] + rand(-1, 1) * p.clumpRadius + outAx[2] * p.clumpRadius * p.clumpOut * rand(0, 1),
          ]
          if (grid.near(q, gap)) continue
          grid.add(q)
          centres.push(q)
          break
        }
      }
    }
  }
  if (!centres.length) throw new Error('tree-billboard: the crown came out empty -- check clumpRate and minGap')

  // --- the leaves themselves ------------------------------------------------
  const leaves = []
  for (const c of centres) {
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
      size: p.leafWidth * rand(1 - p.leafVary, 1 + p.leafVary),
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

  // Trunk, then branches longest-first, then subs. Order matters only in that
  // wood comes before foliage in the index buffer.
  const trunkSides = Math.max(3, p.trunkSides | 0)
  const branchSides = Math.max(3, p.branchSides | 0)
  for (let i = 0; i < trunkPts.length - 1; i++) {
    ring(trunkPts[i], trunkPts[i + 1], trunkRadiusAt(trunkPts[i][1]), trunkRadiusAt(trunkPts[i + 1][1]),
      trunkSides, trunkPts[i][1] / 1.2, trunkPts[i + 1][1] / 1.2)
  }
  for (const br of [...branches].sort((a, b) => b.len - a.len)) {
    const rBase = br.len * p.branchWidth
    for (let i = 0; i < br.pts.length - 1; i++) {
      const t0 = i / (br.pts.length - 1), t1 = (i + 1) / (br.pts.length - 1)
      ring(br.pts[i], br.pts[i + 1], rBase * (1 - t0) + 0.004, rBase * (1 - t1) + 0.004, branchSides, t0 * 3, t1 * 3)
    }
  }
  for (const s of subs) {
    ring(s.from, [s.from[0] + s.dir[0] * s.len, s.from[1] + s.dir[1] * s.len, s.from[2] + s.dir[2] * s.len],
      s.r, 0.002, branchSides, 0, 2)
  }
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
      // The tile coordinate is a SECOND, independent triangle -- same corner
      // index, its own rotation, its own place in the tile. Two leaves that
      // happen to share a shape still never show the same needles.
      const ua = v.uvRoll + cIdx * (TAU / 3)
      uv.push(
        v.uvAt[0] + Math.cos(ua) * p.leafPatch * R_OF_SIDE,
        v.uvAt[1] + Math.sin(ua) * p.leafPatch * R_OF_SIDE
      )
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
      thrown,
      accepted: leaves.length / Math.max(1, thrown),
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
    uTransmit: { value: 0.85 },
    uTransmitPower: { value: 3.5 },
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
      varying vec3 vView;
      varying float vDepth;
      varying vec2 vUv;

      void main() {
        vColor = color;
        vUv = uvProj;
        vNormal = normalize(normalMatrix * normal);
        // THE BILLBOARD, whole. The leaf centre goes through modelView like any
        // other point; the corner is then added in VIEW space, where x and y
        // are the screen's axes by construction. That is what makes it face the
        // camera on all three axes rather than spinning about one -- and the
        // leaf's own random roll is already baked into aOffset, so it is not a
        // rotation this shader has to do.
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xy += aOffset * uGrow;
        vView = -mv.xyz;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSun, uSunColor, uSkyColor, uGroundColor, uFogColor;
      uniform float uSunStrength, uAmbient, uWrap, uTransmit, uTransmitPower;
      uniform float uFogNear, uFogFar;
      uniform sampler2D uMap;
      uniform vec3 uMapMean;
      uniform float uMapMix;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vView;
      varying float vDepth;
      varying vec2 vUv;

      void main() {
        vec3 n = normalize(vNormal);
        vec3 v = normalize(vView);
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
        float back = pow(clamp(dot(v, -uSun), 0.0, 1.0), uTransmitPower);
        vec3 lit = albedo * (amb + uSunColor * uSunStrength * diff)
                 + albedo * uSunColor * back * uTransmit;
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
