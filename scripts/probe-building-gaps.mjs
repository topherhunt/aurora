// Can you see daylight from inside a building?
//
//   node scripts/probe-building-gaps.mjs            corpus sweep, 40 seeds x 4 kinds
//   node scripts/probe-building-gaps.mjs 54494      one seed, all 4 kinds, per-mass detail
//
// The airtightness gate in scripts/check-buildings-v2.mjs cannot answer this and
// never could. It asks whether every directed edge is paired, and a wall's own
// back face pairs the wall's edges whatever else is or is not next to it: two
// masses that meet with a 20 cm band of nothing between them are two separately
// closed shells, and the union of two closed shells is closed. The defect is
// therefore invisible from edge topology and perfectly visible from inside the
// room, which is where this probe stands.
//
// So the measurement is a visibility one rather than a topological one. Put a
// point where a person's head would be, fire a fixed set of directions, and see
// which of them reach the outside world without meeting a triangle. Everything
// else here is about making that honest and making it fast.
//
// DOUBLE-SIDED INTERSECTION, deliberately. The interior of a building is behind
// the back faces of its walls, so culling backfaces would report every ray as
// escaping and the probe would be a very slow constant function.
//
// AND THE OPENINGS ARE NOT DEFECTS. A window and a door are holes in a wall on
// purpose; both are filled with geometry in this kit (glass, a leaf) but the
// filling is thin, occasionally clipped, and not the thing being asked about. So
// an escaping ray that passes within 0.75 m of an opening's centre is discarded,
// and both counts are printed so the filter's effect is on the page rather than
// hidden inside the answer.

// The corpus sweep below is also a gate section: scripts/check-buildings-v2.mjs
// imports probeBuilding and selfCheck from here and asserts on the result, so
// the numbers this file prints and the numbers that gate the build come from one
// implementation rather than two that drift.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { planBuilding, KINDS } from '../src/buildings/plan.js'
import { buildBuilding2 } from '../src/buildings/v2/building.js'

// Run from the command line, or imported by the gate? Everything below the
// function definitions is the command-line report and must not fire on import.
const IS_MAIN = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)

// 40 seeds, fixed, 1..40. The sweep has to compare against itself run to run, so
// nothing here may reach for Math.random -- not the seeds, not the sample points
// and not the directions.
export const CORPUS_SEEDS = Array.from({ length: 40 }, (_, i) => i + 1)
export const KIND_NAMES = Object.keys(KINDS)
// The warp strengths, reported separately. Strength 0 is the straight building,
// where any gap is an arithmetic mistake in the plan or the parts; strength 1 is
// what ships, where a gap may instead be the displacement field pulling two
// surfaces apart faster than the 8 cm joint overlap in plan.js can absorb.
const STRENGTHS = [0, 1]

// The direction count is a pure multiplier on runtime and what it buys is
// angular resolution: 512 Fibonacci points on the sphere sit about 9 degrees
// apart, which at 3 m -- roughly how far a sample point stands from the far wall
// of a room -- is a 0.5 m spacing on that wall, and a defect narrower than that
// gets found by however many of its neighbours happen to land on it rather than
// reliably. The self-check below prints what a known 20 cm slot actually scores
// at this count, so the sensitivity is measured rather than argued. 512 was
// chosen because the grid made the sweep cheap enough that there was no reason
// to settle for the 400 originally planned.
const DIRS = 512
// How far a ray has to get to count as out. In practice the grid below ends long
// before this, since nothing in the scene is more than about 15 m from anything
// else, so this is a backstop rather than a working limit.
const MAX_T = 40
// Hits closer than this are the sample point's own numerical neighbourhood
// rather than a surface in front of it.
const T_MIN = 1e-4
// How far a sample point is held off its mass's own wall planes. 0.35 m is about
// a shoulder's width in from the plaster, which is far enough that a point never
// lands inside the thickness of a log course or behind a corner post.
const INSET = 0.35
// How near an escaping ray has to pass an opening's centre before it is written
// off as light coming through that opening rather than through a hole. A window
// is 0.72 m wide and a door 1.05 m, so 0.75 m from the centre covers the opening
// itself plus its reveal and a little of the wall around it.
const OPENING_R = 0.75

const t0 = Date.now()

// ---------------------------------------------------------------------------
// The triangle soup, and a grid to shoot it through.
// ---------------------------------------------------------------------------

/**
 * Every drawn triangle as nine flat float64s.
 *
 * From the INDEX BUFFER, which is the only place the triangle list exists: the
 * position attribute is a vertex pool that the index visits in an order of its
 * own, and reading it three at a time answers about triangles nobody draws.
 * Float64 because the arithmetic downstream wants the headroom, even though what
 * goes in is float32 and is only good to about 1e-7 of its magnitude.
 */
function triangleSoup(geometry) {
  const pos = geometry.getAttribute('position').array
  const index = geometry.getIndex()
  if (!index) throw new Error('probe-building-gaps: geometry is not indexed, there is no triangle list to walk')
  const ix = index.array
  if (ix.length % 3 !== 0) throw new Error(`probe-building-gaps: index length ${ix.length} is not a multiple of 3`)
  const tri = new Float64Array(ix.length * 3)
  for (let i = 0; i < ix.length; i++) {
    const v = ix[i] * 3
    tri[i * 3] = pos[v]
    tri[i * 3 + 1] = pos[v + 1]
    tri[i * 3 + 2] = pos[v + 2]
  }
  return tri
}

/**
 * A uniform grid over the soup, in compressed-row form.
 *
 * Brute force is 2,500 triangles per ray and the sweep is millions of rays, so
 * the grid is not an optimisation, it is the difference between a minute and an
 * afternoon. Cells are about 0.5 m, which is the scale of the features being
 * looked for, and a triangle is filed under every cell its AABB touches -- an
 * overestimate, and the cheapest one that cannot lose a triangle.
 *
 * The other thing the grid buys is the escape test itself. Nothing exists
 * outside its bounds, so a ray that walks out of the grid has escaped and no
 * further distance needs simulating.
 */
function buildGrid(tri) {
  const n = tri.length / 9
  let minx = Infinity
  let miny = Infinity
  let minz = Infinity
  let maxx = -Infinity
  let maxy = -Infinity
  let maxz = -Infinity
  for (let i = 0; i < tri.length; i += 3) {
    if (tri[i] < minx) minx = tri[i]
    if (tri[i] > maxx) maxx = tri[i]
    if (tri[i + 1] < miny) miny = tri[i + 1]
    if (tri[i + 1] > maxy) maxy = tri[i + 1]
    if (tri[i + 2] < minz) minz = tri[i + 2]
    if (tri[i + 2] > maxz) maxz = tri[i + 2]
  }
  const pad = 0.05
  minx -= pad
  miny -= pad
  minz -= pad
  maxx += pad
  maxy += pad
  maxz += pad
  const nx = Math.max(1, Math.min(80, Math.ceil((maxx - minx) / 0.5)))
  const ny = Math.max(1, Math.min(80, Math.ceil((maxy - miny) / 0.5)))
  const nz = Math.max(1, Math.min(80, Math.ceil((maxz - minz) / 0.5)))
  const sx = (maxx - minx) / nx
  const sy = (maxy - miny) / ny
  const sz = (maxz - minz) / nz
  const cells = nx * ny * nz

  const cellOf = (v, lo, s, count) => {
    const c = Math.floor((v - lo) / s)
    return c < 0 ? 0 : c >= count ? count - 1 : c
  }
  const spanOf = (t) => {
    const b = t * 9
    let ax = tri[b]
    let bx = tri[b]
    let ay = tri[b + 1]
    let by = tri[b + 1]
    let az = tri[b + 2]
    let bz = tri[b + 2]
    for (const o of [3, 6]) {
      if (tri[b + o] < ax) ax = tri[b + o]
      if (tri[b + o] > bx) bx = tri[b + o]
      if (tri[b + o + 1] < ay) ay = tri[b + o + 1]
      if (tri[b + o + 1] > by) by = tri[b + o + 1]
      if (tri[b + o + 2] < az) az = tri[b + o + 2]
      if (tri[b + o + 2] > bz) bz = tri[b + o + 2]
    }
    return [
      cellOf(ax, minx, sx, nx), cellOf(bx, minx, sx, nx),
      cellOf(ay, miny, sy, ny), cellOf(by, miny, sy, ny),
      cellOf(az, minz, sz, nz), cellOf(bz, minz, sz, nz),
    ]
  }

  const start = new Int32Array(cells + 1)
  for (let t = 0; t < n; t++) {
    const [i0, i1, j0, j1, k0, k1] = spanOf(t)
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) start[(k * ny + j) * nx + i + 1]++
      }
    }
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c]
  const fill = start.slice(0, cells)
  const items = new Int32Array(start[cells])
  for (let t = 0; t < n; t++) {
    const [i0, i1, j0, j1, k0, k1] = spanOf(t)
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) items[fill[(k * ny + j) * nx + i]++] = t
      }
    }
  }
  return {
    tri, n, minx, miny, minz, maxx, maxy, maxz, nx, ny, nz, sx, sy, sz, start, items,
    mailbox: new Int32Array(n).fill(-1),
  }
}

/**
 * Moller-Trumbore, double-sided, returning the hit distance or -1.
 *
 * The determinant's SIGN is never looked at, only its magnitude against zero:
 * inside a building every wall between you and the sky is presenting its back
 * face, so the usual `det < 0 -> reject` line would turn this into a function
 * that always says the room is open.
 */
function hitTriangle(tri, b, ox, oy, oz, dx, dy, dz) {
  const ax = tri[b]
  const ay = tri[b + 1]
  const az = tri[b + 2]
  const e1x = tri[b + 3] - ax
  const e1y = tri[b + 4] - ay
  const e1z = tri[b + 5] - az
  const e2x = tri[b + 6] - ax
  const e2y = tri[b + 7] - ay
  const e2z = tri[b + 8] - az
  const hx = dy * e2z - dz * e2y
  const hy = dz * e2x - dx * e2z
  const hz = dx * e2y - dy * e2x
  const det = e1x * hx + e1y * hy + e1z * hz
  if (det > -1e-12 && det < 1e-12) return -1
  const inv = 1 / det
  const sx = ox - ax
  const sy = oy - ay
  const sz = oz - az
  const u = (sx * hx + sy * hy + sz * hz) * inv
  if (u < 0 || u > 1) return -1
  const qx = sy * e1z - sz * e1y
  const qy = sz * e1x - sx * e1z
  const qz = sx * e1y - sy * e1x
  const v = (dx * qx + dy * qy + dz * qz) * inv
  if (v < 0 || u + v > 1) return -1
  return (e2x * qx + e2y * qy + e2z * qz) * inv
}

/**
 * Does the ray meet anything before it leaves the grid?
 *
 * Amanatides-Woo, walking cells in order. Because the answer wanted is a boolean
 * rather than the nearest surface, the first hit found in any cell ends it, even
 * if that hit lies beyond the cell being walked -- a triangle filed here and
 * struck two cells further on is still a triangle struck. The mailbox stops a
 * triangle spanning several cells being tested several times for one ray.
 */
function blocked(g, ox, oy, oz, dx, dy, dz, stamp) {
  let tEnter = 0
  let tExit = MAX_T
  // The slab clip, unrolled. Written out three times rather than looped over an
  // array of triples because this runs once per ray, millions of times, and the
  // array literals a loop would need are the single most expensive thing in the
  // probe when they are there.
  if (dx > -1e-15 && dx < 1e-15) {
    if (ox < g.minx || ox > g.maxx) return false
  } else {
    const ta = (g.minx - ox) / dx
    const tb = (g.maxx - ox) / dx
    if (Math.min(ta, tb) > tEnter) tEnter = Math.min(ta, tb)
    if (Math.max(ta, tb) < tExit) tExit = Math.max(ta, tb)
  }
  if (dy > -1e-15 && dy < 1e-15) {
    if (oy < g.miny || oy > g.maxy) return false
  } else {
    const ta = (g.miny - oy) / dy
    const tb = (g.maxy - oy) / dy
    if (Math.min(ta, tb) > tEnter) tEnter = Math.min(ta, tb)
    if (Math.max(ta, tb) < tExit) tExit = Math.max(ta, tb)
  }
  if (dz > -1e-15 && dz < 1e-15) {
    if (oz < g.minz || oz > g.maxz) return false
  } else {
    const ta = (g.minz - oz) / dz
    const tb = (g.maxz - oz) / dz
    if (Math.min(ta, tb) > tEnter) tEnter = Math.min(ta, tb)
    if (Math.max(ta, tb) < tExit) tExit = Math.max(ta, tb)
  }
  if (tEnter > tExit) return false

  const px = ox + dx * tEnter
  const py = oy + dy * tEnter
  const pz = oz + dz * tEnter
  let i = Math.floor((px - g.minx) / g.sx)
  let j = Math.floor((py - g.miny) / g.sy)
  let k = Math.floor((pz - g.minz) / g.sz)
  if (i < 0) i = 0
  else if (i >= g.nx) i = g.nx - 1
  if (j < 0) j = 0
  else if (j >= g.ny) j = g.ny - 1
  if (k < 0) k = 0
  else if (k >= g.nz) k = g.nz - 1

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
  const deltaX = stepX === 0 ? Infinity : Math.abs(g.sx / dx)
  const deltaY = stepY === 0 ? Infinity : Math.abs(g.sy / dy)
  const deltaZ = stepZ === 0 ? Infinity : Math.abs(g.sz / dz)
  let tMaxX = stepX === 0 ? Infinity : (g.minx + (i + (stepX > 0 ? 1 : 0)) * g.sx - ox) / dx
  let tMaxY = stepY === 0 ? Infinity : (g.miny + (j + (stepY > 0 ? 1 : 0)) * g.sy - oy) / dy
  let tMaxZ = stepZ === 0 ? Infinity : (g.minz + (k + (stepZ > 0 ? 1 : 0)) * g.sz - oz) / dz

  const { start, items, tri, mailbox } = g
  for (;;) {
    const c = (k * g.ny + j) * g.nx + i
    for (let e = start[c]; e < start[c + 1]; e++) {
      const t = items[e]
      if (mailbox[t] === stamp) continue
      mailbox[t] = stamp
      const d = hitTriangle(tri, t * 9, ox, oy, oz, dx, dy, dz)
      if (d >= T_MIN && d <= MAX_T) return true
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      i += stepX
      if (i < 0 || i >= g.nx || tMaxX > tExit) return false
      tMaxX += deltaX
    } else if (tMaxY < tMaxZ) {
      j += stepY
      if (j < 0 || j >= g.ny || tMaxY > tExit) return false
      tMaxY += deltaY
    } else {
      k += stepZ
      if (k < 0 || k >= g.nz || tMaxZ > tExit) return false
      tMaxZ += deltaZ
    }
  }
}

// ---------------------------------------------------------------------------
// Where to stand, and where to look.
// ---------------------------------------------------------------------------

/**
 * A Fibonacci sphere: the cheapest set of directions with no pole, no seam and
 * no random number generator behind it, which is what makes two runs of this
 * probe comparable.
 */
function fibonacciSphere(n) {
  const dirs = new Float64Array(n * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * i + 1) / n
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const th = golden * i
    dirs[i * 3] = Math.cos(th) * r
    dirs[i * 3 + 1] = y
    dirs[i * 3 + 2] = Math.sin(th) * r
  }
  return dirs
}
const DIRECTIONS = fibonacciSphere(DIRS)

/**
 * Twelve points inside a mass: the four corners of its footprint held INSET off
 * its own wall planes, at three heights up the wall.
 *
 * The corners rather than a filled grid, because the two things this probe is
 * hunting -- a band of nothing where two masses meet, and a slot under an eave
 * -- both live at the edge of a room and are seen best from beside them. The
 * three heights matter for the same reason: a gap under an eave is invisible
 * from the floor of a tall inn and obvious from head height.
 */
function originsFor(mass) {
  const hw = mass.w / 2 - INSET
  const hd = mass.d / 2 - INSET
  if (hw <= 0.05 || hd <= 0.05) return []
  const yLo = mass.floorY + 0.3
  const yHi = mass.eaveY - 0.2
  if (yHi <= yLo) throw new Error(`probe-building-gaps: mass ${mass.id} has no headroom, ${yLo.toFixed(2)} to ${yHi.toFixed(2)}`)
  const out = []
  for (const f of [0.12, 0.5, 0.88]) {
    const y = yLo + (yHi - yLo) * f
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) out.push([mass.cx + sx * hw, y, mass.cz + sz * hd])
    }
  }
  return out
}

/** Every opening's centre point, which is what an escaping ray is forgiven for passing. */
function openingCentres(plan) {
  const out = []
  for (const w of plan.windows) out.push([w.x, w.y0 + w.height / 2, w.z])
  const d = plan.door
  out.push([d.x, d.y0 + d.height / 2, d.z])
  return out
}

/** The closest a ray from `o` along unit `d` ever comes to the point `p`. */
function rayPointDistance(ox, oy, oz, dx, dy, dz, p) {
  const vx = p[0] - ox
  const vy = p[1] - oy
  const vz = p[2] - oz
  const t = vx * dx + vy * dy + vz * dz
  if (t <= 0) return Math.hypot(vx, vy, vz)
  return Math.hypot(vx - dx * t, vy - dy * t, vz - dz * t)
}

// ---------------------------------------------------------------------------
// One building.
// ---------------------------------------------------------------------------

/**
 * Cast every direction from every sample point and report what got out.
 *
 * Two counts come back. `raw` is every escape, openings included, and is the
 * number that would be alarming if read alone. `filtered` drops the ones that
 * left near an opening and is the defect count. Per-mass detail rides along so
 * a failure can be pointed at in the viewer rather than only counted.
 */
export function probeBuilding(plan, strength) {
  const built = buildBuilding2(plan, { detail: 2, strength })
  const tri = triangleSoup(built.geometry)
  built.geometry.dispose()
  return probeSoup(tri, plan)
}

/** The measurement itself, over a soup that may or may not have come straight from the builder. */
function probeSoup(tri, plan) {
  const grid = buildGrid(tri)
  const openings = openingCentres(plan)

  let raw = 0
  let filtered = 0
  let cast = 0
  const masses = []
  let stamp = 0
  for (const m of plan.masses) {
    const origins = originsFor(m)
    const rec = {
      id: m.id, role: m.role, origins: origins.length,
      raw: 0, filtered: 0, sum: [0, 0, 0], at: [0, 0, 0], sample: null,
    }
    for (const [ox, oy, oz] of origins) {
      for (let i = 0; i < DIRS; i++) {
        const dx = DIRECTIONS[i * 3]
        const dy = DIRECTIONS[i * 3 + 1]
        const dz = DIRECTIONS[i * 3 + 2]
        cast++
        stamp++
        if (blocked(grid, ox, oy, oz, dx, dy, dz, stamp)) continue
        raw++
        rec.raw++
        let nearOpening = false
        for (const p of openings) {
          if (rayPointDistance(ox, oy, oz, dx, dy, dz, p) < OPENING_R) { nearOpening = true; break }
        }
        if (nearOpening) continue
        filtered++
        rec.filtered++
        rec.sum[0] += dx
        rec.sum[1] += dy
        rec.sum[2] += dz
        rec.at[0] += ox
        rec.at[1] += oy
        rec.at[2] += oz
        if (!rec.sample) rec.sample = { o: [ox, oy, oz], d: [dx, dy, dz] }
      }
    }
    masses.push(rec)
  }
  return { raw, filtered, cast, masses, triangles: grid.n }
}

/** The worst mass of a building, formatted as somewhere to go and look. */
function whereToLook(masses) {
  const m = masses.reduce((a, b) => (b.filtered > a.filtered ? b : a))
  if (m.filtered === 0) return ''
  const len = Math.hypot(m.sum[0], m.sum[1], m.sum[2])
  // The mean direction, which points at the hole when the escapes are one hole
  // and points at nothing in particular when they are several. `spread` says
  // which: 1 is every ray leaving the same way, near 0 is rays leaving in all
  // directions, which means the room is not enclosed at all.
  const spread = len / m.filtered
  const d = [m.sum[0] / len, m.sum[1] / len, m.sum[2] / len]
  const at = m.at.map((v) => v / m.filtered)
  const f3 = (v) => v.map((n) => n.toFixed(2)).join(', ')
  return `mass ${m.id} ${m.role} from (${f3(at)}) toward (${f3(d)}) spread ${spread.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Does the probe work?
// ---------------------------------------------------------------------------
//
// A visibility probe that answers "sealed" for every building is indistinguishable
// from a visibility probe that is broken, and a broken one is worse than none: it
// would be quoted as evidence the buildings are fine. So nothing is measured
// until the probe has been made to find holes that are known to be there.
//
// THE SYNTHETIC ROOM is where the sensitivity number comes from. A hand-made
// closed box has to read zero, and the same box with one horizontal band of its
// +X wall removed has to read the solid angle that band subtends. The band is
// the shape of the defect this whole file exists for -- a stripe of missing wall
// between two masses -- and a box is the only scene where its exact size is
// known, so this is what says the probe can resolve a 20 cm slot rather than only
// a missing wall.
//
// THE CUT HUT tests the other half, which is the pipeline rather than the maths:
// the index walk, the soup, the grid and the plan's sample points, on real
// builder output. It deletes every triangle reaching into a box on one wall.
// Wall faces are drawn as large quads, so in practice that takes the whole panel
// rather than a stripe of it -- which is why the sensitivity claim is made by the
// synthetic room and not by this.
//
// AND A POINT OUTSIDE, which is the opposite failure. Standing 3 m clear of the
// building, nearly every direction must escape. If it does not, `blocked` is
// reporting hits that are not there and every zero this probe prints is a false
// negative.

/** Two triangles for an axis-aligned quad, appended to `out`. */
function pushQuad(out, a, b, c, d) {
  out.push(...a, ...b, ...c, ...a, ...c, ...d)
}

/** A closed box, optionally missing a horizontal band of its +X wall. */
function roomSoup(x0, y0, z0, x1, y1, z1, slot) {
  const out = []
  pushQuad(out, [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1])
  pushQuad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])
  pushQuad(out, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1])
  pushQuad(out, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0])
  pushQuad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
  if (!slot) {
    pushQuad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])
  } else {
    pushQuad(out, [x1, y0, z0], [x1, slot[0], z0], [x1, slot[0], z1], [x1, y0, z1])
    pushQuad(out, [x1, slot[1], z0], [x1, y1, z0], [x1, y1, z1], [x1, slot[1], z1])
  }
  return new Float64Array(out)
}

export function selfCheck({ log = console.log } = {}) {
  log('self-check')

  // A 4 x 3 x 4 m room, looked at from the middle of it, with a 20 cm band taken
  // out of the +X wall between 1.9 and 2.1 m up.
  const shut = buildGrid(roomSoup(-2, 0, -2, 2, 3, 2, null))
  const open = buildGrid(roomSoup(-2, 0, -2, 2, 3, 2, [1.9, 2.1]))
  let shutOut = 0
  let openOut = 0
  for (let i = 0; i < DIRS; i++) {
    const dx = DIRECTIONS[i * 3]
    const dy = DIRECTIONS[i * 3 + 1]
    const dz = DIRECTIONS[i * 3 + 2]
    if (!blocked(shut, 0, 1.5, 0, dx, dy, dz, i + 1)) shutOut++
    if (!blocked(open, 0, 1.5, 0, dx, dy, dz, i + 1)) openOut++
  }
  log(`  a closed 4x3x4 m room leaks ${shutOut} of ${DIRS} directions`)
  log(`  the same room with a 20 cm band out of one wall leaks ${openOut}`)
  if (shutOut !== 0) throw new Error(`probe-building-gaps: ${shutOut} rays escaped a closed box, the intersection test is wrong`)
  if (openOut === 0) throw new Error('probe-building-gaps: no ray found a 20 cm slot in a wall 2 m away, the probe cannot see the defect it is for')

  // The same question asked of real builder output.
  const plan = planBuilding({ seed: 1, kind: 'hut' })
  const built = buildBuilding2(plan, { detail: 2, strength: 0 })
  const full = triangleSoup(built.geometry)
  built.geometry.dispose()
  const m = plan.masses[0]
  // A wall of the main mass that is actually built and is not the frontage: the
  // frontage carries the door, and a hole cut there would be forgiven by the
  // opening filter and prove nothing. Which walls exist depends on the shape, so
  // it is read off the plan rather than assumed -- hut seed 1 is an outshut, and
  // its back wall is two short returns either side of the shed.
  const wall = plan.walls
    .filter((wl) => wl.massId === 0 && !wl.buried && wl.side !== 'front')
    .sort((a, c) => c.len - a.len)[0]
  if (!wall) throw new Error('probe-building-gaps: the self-check building has no non-frontage wall to cut')
  const mx = (wall.p0[0] + wall.p1[0]) / 2
  const mz = (wall.p0[1] + wall.p1[1]) / 2
  const yLo = m.floorY + m.wallH * 0.4
  const yHi = m.floorY + m.wallH * 0.7
  const kept = []
  let cut = 0
  for (let t = 0; t < full.length; t += 9) {
    let lox = Infinity
    let hix = -Infinity
    let loy = Infinity
    let hiy = -Infinity
    let loz = Infinity
    let hiz = -Infinity
    for (let q = 0; q < 3; q++) {
      const x = full[t + q * 3]
      const y = full[t + q * 3 + 1]
      const z = full[t + q * 3 + 2]
      if (x < lox) lox = x
      if (x > hix) hix = x
      if (y < loy) loy = y
      if (y > hiy) hiy = y
      if (z < loz) loz = z
      if (z > hiz) hiz = z
    }
    const meets = hix > mx - 0.6 && lox < mx + 0.6 && hiz > mz - 0.6 && loz < mz + 0.6 && hiy > yLo && loy < yHi
    if (meets) { cut++; continue }
    for (let i = 0; i < 9; i++) kept.push(full[t + i])
  }
  if (cut === 0) throw new Error('probe-building-gaps: the self-check cut no triangles, so it proves nothing')
  const sealed = probeSoup(full, plan)
  const holed = probeSoup(new Float64Array(kept), plan)

  const grid = buildGrid(full)
  let outside = 0
  const ox = grid.maxx + 3
  const oy = (grid.miny + grid.maxy) / 2
  const oz = grid.maxz + 3
  for (let i = 0; i < DIRS; i++) {
    if (!blocked(grid, ox, oy, oz, DIRECTIONS[i * 3], DIRECTIONS[i * 3 + 1], DIRECTIONS[i * 3 + 2], i + 1)) outside++
  }

  log(`  hut/1 intact: ${sealed.filtered} escaping rays of ${sealed.cast} cast`)
  log(`  hut/1 with ${cut} triangles cut out of its ${wall.side} wall: ${holed.filtered} escaping (${holed.raw} raw)`)
  log(`  a point 3 m outside the intact hut escapes in ${outside} of ${DIRS} directions`)
  if (holed.filtered <= sealed.filtered) throw new Error('probe-building-gaps: cutting a hole in a wall changed nothing, the probe is not measuring what it claims')
  if (outside < DIRS * 0.5) throw new Error(`probe-building-gaps: only ${outside} of ${DIRS} directions escape from outside the building, blocked() is reporting phantom hits`)
  log('')
  // Handed back so a caller that silenced the log can still say what the
  // instrument scored rather than only that it did not throw.
  return { shutOut, openOut, cut, wallSide: wall.side, sealed: sealed.filtered, holed: holed.filtered, outside, dirs: DIRS }
}

// ---------------------------------------------------------------------------
// The command-line report, which does not run when the gate imports this file.
// ---------------------------------------------------------------------------

if (IS_MAIN) {
  selfCheck()

  // ---------------------------------------------------------------------------
  // Single seed: all four kinds, per mass, both strengths.
  // ---------------------------------------------------------------------------

  const ARG = process.argv[2]

  if (ARG !== undefined) {
    const seed = Number(ARG)
    if (!Number.isFinite(seed)) throw new Error(`probe-building-gaps: "${ARG}" is not a seed`)
    console.log(`\n=== seed ${seed}, ${DIRS} directions, detail 2 ===\n`)
    for (const kind of KIND_NAMES) {
      const plan = planBuilding({ seed, kind })
      console.log(`${kind}/${seed}  ${plan.shape} ${plan.style} ${plan.roofKind}, ${plan.masses.length} mass(es), ${plan.windows.length} windows`)
      for (const strength of STRENGTHS) {
        const r = probeBuilding(plan, strength)
        console.log(`  strength ${strength}: ${r.filtered} escaping of ${r.cast} cast, ${r.raw} before the opening filter, ${r.triangles} triangles`)
        for (const m of r.masses) {
          const size = plan.masses.find((mm) => mm.id === m.id)
          const head = `    mass ${m.id} ${m.role.padEnd(8)} ${size.w.toFixed(1)}x${size.d.toFixed(1)} wallH ${size.wallH.toFixed(2)}  ${m.origins} origins`
          if (m.origins === 0) { console.log(`${head}  (too small to stand in)`); continue }
          console.log(`${head}  raw ${m.raw}  filtered ${m.filtered}`)
          if (m.filtered > 0) {
            const len = Math.hypot(m.sum[0], m.sum[1], m.sum[2])
            const f3 = (v) => v.map((n) => n.toFixed(2)).join(', ')
            console.log(`      mean exit direction (${f3(m.sum.map((v) => v / len))}), spread ${(len / m.filtered).toFixed(2)}`)
            console.log(`      mean origin (${f3(m.at.map((v) => v / m.filtered))})`)
            console.log(`      first escape from (${f3(m.sample.o)}) toward (${f3(m.sample.d)})`)
          }
        }
      }
      console.log('')
    }
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s\n`)
    process.exit(0)
  }

  // ---------------------------------------------------------------------------
  // The corpus.
  // ---------------------------------------------------------------------------

  console.log(`\n=== building interior daylight probe: ${CORPUS_SEEDS.length} seeds x ${KIND_NAMES.length} kinds x ${STRENGTHS.length} strengths, ${DIRS} directions ===\n`)

  let totalCast = 0
  for (const strength of STRENGTHS) {
    const rows = []
    for (const kind of KIND_NAMES) {
      for (const seed of CORPUS_SEEDS) {
        const plan = planBuilding({ seed, kind })
        const r = probeBuilding(plan, strength)
        totalCast += r.cast
        rows.push({ kind, seed, plan, ...r })
      }
    }
    const leaky = rows.filter((r) => r.filtered > 0)
    const rawLeaky = rows.filter((r) => r.raw > 0)
    const escaped = rows.reduce((s, r) => s + r.filtered, 0)
    const rawEscaped = rows.reduce((s, r) => s + r.raw, 0)
    const cast = rows.reduce((s, r) => s + r.cast, 0)

    console.log(`strength ${strength}`)
    console.log(`  ${leaky.length} of ${rows.length} buildings leak daylight (${rawLeaky.length} before the opening filter)`)
    console.log(`  ${escaped.toLocaleString()} escaping rays of ${cast.toLocaleString()} cast, ${(100 * escaped / cast).toFixed(3)}% (${rawEscaped.toLocaleString()} raw, ${(100 * rawEscaped / cast).toFixed(3)}%)`)
    console.log(`  the filter discarded ${(rawEscaped - escaped).toLocaleString()} rays as light through a window or a door`)

    const byKind = KIND_NAMES.map((k) => {
      const sub = rows.filter((r) => r.kind === k)
      return `${k} ${sub.filter((r) => r.filtered > 0).length}/${sub.length}`
    })
    console.log(`  by kind: ${byKind.join(', ')}`)

    if (leaky.length === 0) {
      console.log('  no offenders\n')
      continue
    }
    console.log('  worst offenders')
    for (const r of leaky.sort((a, b) => b.filtered - a.filtered).slice(0, 12)) {
      const p = r.plan
      console.log(`    ${`${r.kind}/${r.seed}`.padEnd(14)} ${String(r.filtered).padStart(5)} escaping rays  (${p.shape} ${p.style} ${p.roofKind}, ${p.masses.length} mass${p.masses.length > 1 ? 'es' : ''})`)
      console.log(`      ${whereToLook(r.masses)}`)
    }
    console.log('')
  }

  const secs = (Date.now() - t0) / 1000
  console.log(`${totalCast.toLocaleString()} rays in ${secs.toFixed(1)} s, ${Math.round(totalCast / secs / 1000).toLocaleString()}k rays/s\n`)
}
