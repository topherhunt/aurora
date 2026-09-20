// ---------------------------------------------------------------------------
// THE LEAFKIN VILLAGE (DESIGN.md §30): a wooded hollow inside a boulder,
// built in memory at every boot of the room from the shell's own wall, every
// one of them its own: the seed is the entrance's place in the overworld
// (main.js villageSeed), and off it are rolled the shell's turn about its
// axis, the ground's jitter, how many rivers come down and from where, how
// far the path stands off the water, which side the clearing is and how far
// round, and the houses' heights.
//
// The ground is a heightmap in the overworld's format -- 1025 texels at 8 m --
// holding one 320 m tile repeated across it: an inverted cone whose tip is
// DROP under its rim, the rim where the shell's wall stands at that height,
// jittered at every lattice vertex of JITTER's octaves and past the wall
// climbing into the stone. Everything outside the wall is that climb's
// plateau, and nothing outside the shell is ever seen. THE TILE IS REPEATED
// RATHER THAN SET IN A PLAIN because V2Height calibrates its sub-texel detail
// against the map's structure function and ramps its tints over the map's
// height bands: a lone hollow in a flat world measures as flat ground with a
// dent in it, and gets a flat world's detail and a dent's tint.
//
// The lake is the water standing LAKE.over metres over the lowest ground, an
// uncarved plane across the whole hollow, so its shore is wherever the jitter
// put it. A river or two come down off the far wall to it. One path loops the
// lake, short of the rivers; a trunk switchbacks down from the exit mouth to
// it; off it a ring the size of a clearing, the houses round the ring with
// their doors on it, each stood level on a pad hidden under its own floor;
// and the rest of the hollow is wood.
// ---------------------------------------------------------------------------

import { WORLD_SIZE, SEED } from '../config.js'
import { Heightmap } from '../height/heightmap.js'
import { V2Height } from '../height/field.js'
import { RELIEF_SHIPPED } from '../height/relief.js'
import { Layers } from '../layers/layers.js'
import { DOC_VERSION, validate } from '../layers/doc.js'
import { SHAPE_RECT } from '../layers/water-bodies.js'
import { FREEBOARD } from '../layers/paths.js'
import { Spline } from '../layers/spline.js'
import { mulberry32, smoothstep } from '../../sim/mathx.js'

// The shell (render/shell.js): the bank's boulder stood as the hollow bed stands it, at this scale, sunk as the bed sinks it; its yaw is rolled.
export const SHELL = { x: 0, z: 0, floor: 60, scale: 160, sink: 0.4 }
export const FLOOR = SHELL.floor

// The ground. Metres; the floor stays over every scatter's elevation floor (trees 25 m).
export const TEXELS = 1025                       // WORLD_SIZE / (TEXELS - 1) = 8 m a texel, the overworld's pitch
export const TILE_TEXELS = 40                    // the repeated tile, 320 m: the widest wall plus the climb past it fits in it on every yaw
export const DROP = 50                           // the cone: its tip FLOOR at the axis, its rim DROP over that where the shell's wall stands at that height
export const TIP = 0.25                          // the cone's tip rounded off: its profile is a hyperbola whose asymptote is the cone, flat at the axis, this fraction of the rim's radius from it
// The jitter: one lattice per octave, periodic on the tile, each vertex moved by up to `amp` of that octave's spacing either way, bilinear between vertices; the finest lattice is the texel grid itself, so the map holds the jitter exactly. It dies over the last `foot` metres to the wall, so the ground meets the stone at the height the wall was read at: jitter at the wall would stand the ground through the stone where the wall leans in above the rim.
export const JITTER = { spacings: [32, 16, 8], amp: 0.25, foot: 12 }
// The rim stands `in` metres inside where the wall was read, and from it the ground climbs at `grade` into the stone over `fade` metres; the plateau beyond is flat so the tile is periodic. The map's 8 m texels smear the kink at the rim up to 2.5 m, and the wall leans in above the rim by up to 0.6 m a metre: `in` keeps the smeared ground inside the stone all the same. The widest wall plus the fade must stay inside the tile's inscribed radius (buildHeightmap asserts it).
export const PAST = { in: 3, fade: 12, grade: 1.4 }
export const TOP = FLOOR + DROP + PAST.fade * PAST.grade
export const MAX_Y = 300                         // the encoding's range

// The lake: its level `over` metres above the lowest ground `margin` metres inside the wall, drawn as an uncarved plane across the hollow (water-bodies.js: water shows wherever the ground is under it). The largest pool under that level, found on a `grid` metre grid, is the lake the village stands about; one under `least` square metres re-rolls the jitter.
export const LAKE = { over: 5, margin: 12, least: 200, depth: 4, grid: 1 }
// The rivers (DESIGN.md §30): `count` of them from a source `from` of the way to the wall within `sector` degrees of straight away from the exit, `apart` degrees apart, each walked toward the lake's deepest point (`step`, `follow`, `stall`), its mouth the last point within `mouthSteps` of the water whose ground stands over the lake by more than the freeboard plus `mouthOver` and less than the channel's depth less it (paths.js pins a mouth to a lake only within a channel depth over that ground, and never raises a level); a bearing whose river the solve does not carry to the lake is stepped `retry` degrees either side. No road comes within `clear` metres of a river: a road's feather (paths.js DEFAULT_ROAD_FEATHER, laid over the carve) would lift the bed out of the water.
export const RIVER = { count: [1, 2], sector: 50, apart: 30, from: 0.8, step: 0.5, node: 12, follow: 1.5, width: 1.5, depth: 1, mouthOver: 0.1, mouthSteps: 6, retry: 5, stall: 12, clear: 11 }
// The path round the lake: `over` metres past the water on every bearing (the wet radius dilated and averaged over `smooth` degrees), ending where it comes within RIVER.clear of a river, held at the ring's height for `level` degrees either side of the clearing's bearing, where the spur leaves it, so every road about the houses stands at one level.
export const LOOP = { over: [3, 7], smooth: 30, level: 25 }
// The clearing: a disc of radius `r` the wood keeps off (main.js villageBiome, RoomProps.occupiesAt), ringed by a path the houses' doors open on, its ring's inner point `spur` metres out from the loop on a bearing from the lake `bearing` degrees off the exit's on a rolled side, a spur straight in from the loop to it: it is the houses that cluster round the ring, and a loop run onto it would pass under them. The ring is level at the ground's mean round it, `dry` over the lake at the least; the ring's and the pads' smooth (paths.js smoothRoads) terrace the clearing and the houses to it.
export const CLEARING = { r: 5, spur: 6, bearing: [60, 110], dry: 1 }
// The houses (DESIGN.md §30): `count` round the ring, the great house at its head and the rest packed either side, `gap` metres apart and from the spur and the loop, `height` by their count (a house is half as wide as it is tall: six round this ring, with the spur's wedge, fit only small). Each stands on a pad of two road rings hidden under its floor at the ring's height, `pads` of its radius out and `padHalf` of it wide, so the flatten (paths.js smoothRoads, the nearest road alone) levels the whole footprint and the cobble (SWELL) never shows past the walls.
export const HUTS = { count: [5, 6], height: { 5: [5, 8], 6: [5, 5.5] }, gap: 1, pads: [0.25, 0.7], padHalf: 0.25 }
export const GREAT_HUT = { height: [10, 12] }
export const ROAD_WIDTH = 1
// The steepest a drawn road gets: a footpath's pitch. Its chords are held to CHORD_GRADE by cut and fill alike, since the spline between chords steepens by a few degrees over them.
export const ROAD_GRADE = Math.tan((25 * Math.PI) / 180)
const CHORD_GRADE = Math.tan((20 * Math.PI) / 180)
// A road's profile is the ground along it averaged over PROFILE_M before the grade is held, so it rides the jitter rather than trenching every lump.
const PROFILE_M = 24
// No STRAIGHT_M metres of any road within STRAIGHT_DEG of one bearing. A road
// wanders across its line by a sine of WANDER, its amplitude rolled a little
// per half wave, sampled an eighth of a wave apart with the wave stretched to
// fit the road's length: a random jitter fails the rule at every inflection it
// leaves shallow; a wave this short turns through 6 degrees within 4 m of its
// own; a wave sampled on its quarters alone runs straight from peak to peak
// through the crossing, and one sampled off them drifts onto the crossings and
// goes flat.
export const STRAIGHT_M = 8
export const STRAIGHT_DEG = 6
export const WANDER = { wavelength: 12, amp: 1.2 }
// The trunk: legs from the exit down to the loop, each sweeping up to `sweep` degrees round the lake and back, as many as hold the drop at CHORD_GRADE with `slack` to spare and no more than `legs`, its hairpins turned on `hairpin` metres, the last `approach` metres straight in on the exit's bearing so it meets the loop square.
export const TRUNK = { legs: 4, sweep: 110, slack: 1.1, hairpin: 4, approach: 8 }
// The exit mouth: on the bearing where the shell's wall stands most nearly plumb across the arch's height (entrances.js MOUTH_HEIGHT_M), its face point on the wall at the arch's mid height so the arch's back half stands in the stone, its normal into the room.
export const EXIT = { band: 1.5, plumb: 0.5 }
export const ARRIVE_M = 2
const ROLL_TRIES = 128

const deg = (d) => (d * Math.PI) / 180
const TAU = Math.PI * 2
const TILE_M = WORLD_SIZE / (TEXELS - 1) * TILE_TEXELS

// --- the rolls ---------------------------------------------------------------

/**
 * What one village is built from, off its seed:
 * `{ seed, attempt, shell, jitter, rivers: [bearing], loop: { over }, clearing: { side, bearing }, huts: [height], great }`,
 * bearings in degrees off the one from the lake to the exit, `great` the
 * index of the great house among the heights. `attempt` above 0 rolls another
 * village under the same shell, for a build the ground refused (buildVillage).
 * `house` is taken for the caller's convenience and not read.
 */
export function rollVillage(seed, house, attempt = 0) {
  const rng = mulberry32(seed)
  const between = ([lo, hi]) => lo + (hi - lo) * rng()
  const shell = { ...SHELL, yaw: rng() * TAU }
  for (let i = 0; i < attempt; i++) rng()
  const jitter = Math.floor(rng() * 2 ** 31)
  const rivers = [180 + RIVER.sector * (2 * rng() - 1)]
  if (Math.round(between(RIVER.count)) > 1) {
    const side = rivers[0] >= 180 ? -1 : 1
    rivers.push(rivers[0] + side * (RIVER.apart + rng() * (RIVER.sector * 2 - RIVER.apart)))
  }
  const loop = { over: between(LOOP.over) }
  const clearing = { side: rng() < 0.5 ? -1 : 1, bearing: between(CLEARING.bearing) }
  const n = Math.round(between(HUTS.count))
  const huts = []
  for (let i = 0; i < n; i++) huts.push(between(HUTS.height[n]))
  const great = Math.floor(rng() * n)
  huts[great] = between(GREAT_HUT.height)
  return { seed, attempt, shell, jitter, rivers, loop, clearing, huts, great }
}

// --- the ground --------------------------------------------------------------

/**
 * The hollow's ground off the shell's wall: `{ at(x, z), coneAt(x, z), rimAt(bearing) }`.
 * The wall is read once a degree at the rim's height.
 */
export function makeGround(shell, { jitter }) {
  const rim = new Float32Array(360)
  for (let d = 0; d < 360; d++) rim[d] = shell.wallAt(FLOOR + DROP, deg(d)) - PAST.in
  const rimAt = (bearing) => {
    const t = (((bearing / TAU) * 360) % 360 + 360) % 360
    const i = Math.floor(t), f = t - i
    return rim[i] * (1 - f) + rim[(i + 1) % 360] * f
  }
  const rng = mulberry32(jitter)
  const lattices = JITTER.spacings.map((s) => {
    const n = Math.round(TILE_M / s)
    if (n * s !== TILE_M) throw new Error(`village: a jitter spacing of ${s} m does not divide the ${TILE_M} m tile`)
    const a = new Float32Array(n * n)
    for (let i = 0; i < a.length; i++) a[i] = (rng() * 2 - 1) * JITTER.amp * s
    return { s, n, a }
  })
  const jitterAt = (x, z) => {
    let j = 0
    for (const { s, n, a } of lattices) {
      const u = x / s, v = z / s, i = Math.floor(u), k = Math.floor(v), fu = u - i, fv = v - k
      const w = (ii, kk) => a[(((kk % n) + n) % n) * n + (((ii % n) + n) % n)]
      j += (w(i, k) * (1 - fu) + w(i + 1, k) * fu) * (1 - fv) + (w(i, k + 1) * (1 - fu) + w(i + 1, k + 1) * fu) * fv
    }
    return j
  }
  const coneAt = (x, z) => {
    const r = Math.hypot(x, z), R = rimAt(Math.atan2(z, x))
    const t = Math.min(1, r / R)
    const profile = (Math.hypot(t, TIP) - TIP) / (Math.hypot(1, TIP) - TIP)
    return FLOOR + DROP * profile + Math.min(PAST.fade, Math.max(0, r - R)) * PAST.grade
  }
  const ground = {
    rimAt,
    coneAt,
    at(x, z) {
      const past = Math.hypot(x, z) - rimAt(Math.atan2(z, x))
      return coneAt(x, z) + jitterAt(x, z) * (1 - smoothstep(-JITTER.foot, 0, past))
    },
  }
  return ground
}

/** The heightmap: the tile centred on the origin, evaluated once and repeated. */
export function buildHeightmap(ground) {
  const step = WORLD_SIZE / (TEXELS - 1)
  const n = TILE_TEXELS
  for (let d = 0; d < 360; d += 1) {
    if (ground.rimAt(deg(d)) + PAST.in + PAST.fade > (n * step) / 2) throw new Error(`village: the wall at ${d} degrees stands too wide for the tile`)
  }
  const tile = new Float32Array(n * n)
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) tile[v * n + u] = ground.at((u - n / 2) * step, (v - n / 2) * step)
  }
  // Texel (TEXELS - 1) / 2 is the origin, so the tile's own middle lands on it.
  const origin = (TEXELS - 1) / 2 - n / 2
  const wrap = (i) => (((i - origin) % n) + n) % n
  const data = new Float32Array(TEXELS * TEXELS)
  for (let j = 0; j < TEXELS; j++) {
    const row = wrap(j) * n
    for (let i = 0; i < TEXELS; i++) data[j * TEXELS + i] = tile[row + wrap(i)]
  }
  const meta = { world: WORLD_SIZE, size: TEXELS, minY: 0, maxY: MAX_Y, encoding: 'rg16', room: 'leafkin' }
  return Heightmap.fromRaw({ width: TEXELS, height: TEXELS, data, meta })
}

// --- the water ---------------------------------------------------------------

/**
 * The lake on `ground`: `{ x, z, y, area, deep, inLake(x, z), wetRadius(bearing) }`
 * -- its level; the largest pool's centroid, area in square metres and
 * deepest point; whether a point is in that pool; and how far the water
 * reaches from the centroid on a bearing (degrees from +X).
 */
export function findLake(ground) {
  const step = LAKE.grid, half = Math.ceil(TILE_M / 2 / step)
  const w = 2 * half + 1
  const h = new Float32Array(w * w).fill(NaN)
  let lo = Infinity
  for (let v = -half; v <= half; v++) {
    for (let u = -half; u <= half; u++) {
      const x = u * step, z = v * step
      if (Math.hypot(x, z) >= ground.rimAt(Math.atan2(z, x)) - LAKE.margin) continue
      const y = ground.at(x, z)
      h[(v + half) * w + u + half] = y
      lo = Math.min(lo, y)
    }
  }
  const y = lo + LAKE.over
  const pool = new Int32Array(w * w)
  let best = null, pools = 0
  for (let i = 0; i < h.length; i++) {
    if (!(h[i] < y) || pool[i] !== 0) continue
    const id = ++pools
    const stack = [i]
    pool[i] = id
    let count = 0, sx = 0, sz = 0, deep = i
    while (stack.length) {
      const k = stack.pop()
      const u = (k % w) - half, v = Math.floor(k / w) - half
      count++; sx += u; sz += v
      if (h[k] < h[deep]) deep = k
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const uu = u + du, vv = v + dv
        if (uu < -half || uu > half || vv < -half || vv > half) continue
        const kk = (vv + half) * w + uu + half
        if (h[kk] < y && pool[kk] === 0) { pool[kk] = id; stack.push(kk) }
      }
    }
    if (best === null || count > best.count) best = { id, count, x: (sx / count) * step, z: (sz / count) * step, deep: { x: ((deep % w) - half) * step, z: (Math.floor(deep / w) - half) * step } }
  }
  if (best === null) throw new Error('village: no ground under the lake\'s level')
  const { x, z, deep } = best
  const area = best.count * step * step
  const inLake = (px, pz) => {
    const u = Math.round(px / step), v = Math.round(pz / step)
    return Math.abs(u) <= half && Math.abs(v) <= half && pool[(v + half) * w + u + half] === best.id
  }
  // Out from the centroid, the last wet half metre before six dry ones.
  const wetRadius = (bearing) => {
    const c = Math.cos(deg(bearing)), s = Math.sin(deg(bearing))
    let last = 0, dry = 0
    for (let r = 0; r < 80 && dry < 6; r += 0.5) {
      if (ground.at(x + c * r, z + s * r) < y) { last = r; dry = 0 } else dry += 0.5
    }
    return last
  }
  return { x, z, y, area, deep, inLake, wetRadius }
}

// --- the roads ---------------------------------------------------------------

/** Bearing in degrees of each 1 m sample along a road's plan, for the no-straight-run rule. */
export function bearings(pts) {
  const s = new Spline(pts).flatten(1)
  const out = []
  for (let i = 4; i < s.length; i += 4) {
    out.push((Math.atan2(s[i] - s[i - 4], s[i + 2] - s[i - 2]) * 180) / Math.PI)
  }
  return out
}

/** The longest run in metres over which the bearing stays within STRAIGHT_DEG of its start. */
export function longestStraight(pts) {
  const b = bearings(pts)
  let worst = 0
  for (let i = 0; i < b.length; i++) {
    let j = i
    while (j + 1 < b.length && Math.abs((((b[j + 1] - b[i]) % 360) + 540) % 360 - 180) <= STRAIGHT_DEG) j++
    worst = Math.max(worst, j - i)
  }
  return worst
}

/** A polyline of `[x, z]` by arc length: `{ length, at(s) }`, `at` the point and its left normal. */
function alongPolyline(pts) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const length = cum[cum.length - 1]
  const at = (s) => {
    let i = 1
    while (i < cum.length - 1 && cum[i] < s) i++
    const a = pts[i - 1], b = pts[i]
    const d = cum[i] - cum[i - 1]
    const t = d > 0 ? Math.min(1, Math.max(0, (s - cum[i - 1]) / d)) : 0
    const ux = d > 0 ? (b[0] - a[0]) / d : 1, uz = d > 0 ? (b[1] - a[1]) / d : 0
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, nx: -uz, nz: ux }
  }
  return { length, at }
}

/** `plan` (`[x, z]` waypoints) resampled an eighth of a wave apart and pushed across its line by WANDER; the ends stay put. */
function wandering(plan, rng) {
  const { length, at } = alongPolyline(plan)
  const n = Math.ceil(length / (WANDER.wavelength / 8))
  const swing = []
  for (let j = 0; j * 4 <= n; j++) swing.push(WANDER.amp * (0.7 + 0.6 * rng()))
  const out = []
  for (let i = 0; i <= n; i++) {
    const { x, z, nx, nz } = at((i / n) * length)
    const k = i === 0 || i === n ? 0 : swing[Math.floor(i / 4)] * Math.sin((Math.PI * i) / 4)
    out.push([x + nx * k, z + nz * k])
  }
  return out
}

/**
 * Road points through `plan` on the ground: each point's height is the ground's,
 * never under `floor`, averaged over PROFILE_M along the road, any index in
 * `pins` held at its value, then every chord held under CHORD_GRADE; null
 * where the pins are further apart in height than the road between them
 * can hold.
 */
function roadThrough(plan, heightAt, { floor = -Infinity, pins = new Map() } = {}) {
  const n = plan.length
  const raw = plan.map(([x, z]) => Math.max(floor, heightAt(x, z)))
  const cum = [0]
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(plan[i][0] - plan[i - 1][0], plan[i][1] - plan[i - 1][1]))
  const y = raw.map((_, i) => {
    let sum = 0, count = 0
    for (let j = 0; j < n; j++) if (Math.abs(cum[j] - cum[i]) <= PROFILE_M / 2) { sum += raw[j]; count++ }
    return sum / count
  })
  // A pin lifts or drops the profile to its value on a tent PROFILE_M wide, not at one point: a spike between chords is what the spline through them overshoots. Each point takes its nearest pin's lift, so a run of pins reads as one.
  const lifts = new Map([...pins].map(([i, v]) => [i, v - y[i]]))
  const lifted = y.map((h, j) => {
    let near = null, at = Infinity
    for (const i of pins.keys()) { const d = Math.abs(cum[j] - cum[i]); if (d < at) { near = i; at = d } }
    return near === null ? h : pins.has(j) ? pins.get(j) : h + lifts.get(near) * Math.max(0, 1 - at / PROFILE_M)
  })
  for (let j = 0; j < n; j++) y[j] = lifted[j]
  // Each chord held to the grade by moving its far point onto the near one's reach, forward then back, the pins never moved: the last pass leaves every chord held but one reaching a pin from the wrong side, which is a drop the road's length cannot hold.
  for (const [from, to, step] of [[1, n, 1], [n - 2, -1, -1]]) {
    for (let i = from; i !== to; i += step) {
      if (pins.has(i)) continue
      const limit = CHORD_GRADE * Math.abs(cum[i] - cum[i - step])
      y[i] = Math.min(y[i - step] + limit, Math.max(y[i - step] - limit, y[i]))
    }
  }
  for (let i = 1; i < n; i++) if (Math.abs(y[i] - y[i - 1]) > CHORD_GRADE * (cum[i] - cum[i - 1]) + 1e-6) return null
  return plan.map(([x, z], i) => [x, y[i], z, ROAD_WIDTH])
}

/** The grade the spline through `pts` holds, checked against ROAD_GRADE. */
function checkRoad(id, pts) {
  const run = longestStraight(pts)
  if (run >= STRAIGHT_M) throw new Error(`village: ${run} m of ${id} holds one bearing`)
  const s = new Spline(pts).flatten(1)
  let worst = 0, at = 0, along = 0
  for (let i = 4; i < s.length; i += 4) {
    const d = Math.hypot(s[i] - s[i - 4], s[i + 2] - s[i - 2])
    along += d
    const g = d > 0 ? Math.abs(s[i + 1] - s[i - 3]) / d : 0
    if (g > worst) { worst = g; at = along }
  }
  if (worst > ROAD_GRADE) throw new Error(`village: ${id} steepens to ${((Math.atan(worst) * 180) / Math.PI).toFixed(1)} degrees ${at.toFixed(0)} m along`)
  return pts
}

/** `[x, z]` points `spacing` apart along the arc from `a` to `b` degrees round (cx, cz) at `radiusAt(deg)`, the last exactly at `b`. */
function arcPoints(cx, cz, radiusAt, a, b, spacing) {
  const r = radiusAt((a + b) / 2)
  const n = Math.max(2, Math.ceil((deg(Math.abs(b - a)) * r) / spacing))
  const out = []
  for (let i = 0; i <= n; i++) {
    const d = a + ((b - a) * i) / n, rr = radiusAt(d)
    out.push([cx + Math.cos(deg(d)) * rr, cz + Math.sin(deg(d)) * rr])
  }
  return out
}

/** Degrees round `lake` from +X of a point. */
const bearingDeg = (lake, x, z) => (Math.atan2(z - lake.z, x - lake.x) * 180) / Math.PI
/** `d` degrees folded into [0, 360). */
const wrapDeg = (d) => ((d % 360) + 360) % 360
/** How far `a` is from `b` round the circle, in degrees, 0..180. */
const offDeg = (a, b) => Math.abs(wrapDeg(a - b + 180) - 180)
/** The nearest a polyline of `[x, z]` comes to (x, z), by its vertices. */
const nearestOf = (pts, x, z) => pts.reduce((best, p) => Math.min(best, Math.hypot(p[0] - x, p[1] - z)), Infinity)

/**
 * The trunk's plan from `from` to `to` (`[x, z]`): legs round `lake` from the
 * exit's bearing out to `sweep` degrees on `side` and back, hairpins filleted
 * on TRUNK.hairpin, enough of them that the plan runs `drop` metres at
 * CHORD_GRADE with TRUNK.slack to spare, or null when TRUNK.legs cannot.
 */
function trunkPlan(lake, from, to, side, drop) {
  const need = (drop / CHORD_GRADE) * TRUNK.slack
  const r0 = Math.hypot(from[0] - lake.x, from[1] - lake.z), r1 = Math.hypot(to[0] - lake.x, to[1] - lake.z)
  const b0 = bearingDeg(lake, from[0], from[1])
  for (let legs = 1; legs <= TRUNK.legs; legs++) {
    for (let sweep = 10; sweep <= TRUNK.sweep; sweep += 2) {
      const corners = [from]
      for (let k = 1; k < legs; k++) {
        const r = r0 + ((r1 - r0) * k) / legs
        const b = deg(b0 + (k % 2 === 1 ? side * sweep : 0))
        corners.push([lake.x + Math.cos(b) * r, lake.z + Math.sin(b) * r])
      }
      // An even count of legs ends at the exit's bearing, an odd one out on the sweep; the last leg runs to the approach, and that straight in.
      corners.push([lake.x + Math.cos(deg(b0)) * (r1 + TRUNK.approach), lake.z + Math.sin(deg(b0)) * (r1 + TRUNK.approach)], to)
      let length = 0
      for (let i = 1; i < corners.length; i++) length += Math.hypot(corners[i][0] - corners[i - 1][0], corners[i][1] - corners[i - 1][1])
      if (length < need) continue
      const plan = filleted(corners, TRUNK.hairpin)
      if (plan !== null) return plan
    }
  }
  return null
}

/** `corners` with every inner corner turned on an arc of `radius`, sampled 1.5 m apart; null where a leg is too short for its fillets. */
function filleted(corners, radius) {
  const out = [corners[0]]
  let cursor = corners[0]
  const line = (a, b) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(d / 1.5))
    for (let i = 1; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])
  }
  for (let i = 1; i < corners.length - 1; i++) {
    const a = corners[i - 1], c = corners[i], b = corners[i + 1]
    const l1 = Math.hypot(c[0] - a[0], c[1] - a[1]), l2 = Math.hypot(b[0] - c[0], b[1] - c[1])
    const u1 = [(c[0] - a[0]) / l1, (c[1] - a[1]) / l1], u2 = [(b[0] - c[0]) / l2, (b[1] - c[1]) / l2]
    const turn = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])))
    const t = radius * Math.tan(turn / 2)
    if (t > l1 - 1 || t > l2 - 1) return null
    const p1 = [c[0] - u1[0] * t, c[1] - u1[1] * t], p2 = [c[0] + u2[0] * t, c[1] + u2[1] * t]
    line(cursor, p1)
    const cross = u1[0] * u2[1] - u1[1] * u2[0]
    const s = cross >= 0 ? 1 : -1
    const o = [p1[0] - u1[1] * radius * s, p1[1] + u1[0] * radius * s]
    const a0 = Math.atan2(p1[1] - o[1], p1[0] - o[0])
    const n = Math.max(2, Math.ceil((turn * radius) / 1.5))
    for (let k = 1; k <= n; k++) {
      const ang = a0 + (s * turn * k) / n
      out.push([o[0] + Math.cos(ang) * radius, o[1] + Math.sin(ang) * radius])
    }
    cursor = p2
  }
  line(cursor, corners[corners.length - 1])
  return out
}

// --- the houses --------------------------------------------------------------

/**
 * The houses round the ring at (cx, cz): `[{ x, z, yaw, height, r }]` for `heights`,
 * each facing the ring's centre with its door on the ring, the house `great` on
 * `headBearing` (degrees) and the rest packed out from it to either side in
 * turn, HUTS.gap between neighbours, each standing where `clearOf(x, z, r)`
 * allows; null where they do not all fit round.
 */
function housesRound(cx, cz, heights, bounds, headBearing, great, clearOf) {
  const R = CLEARING.r
  const stood = heights.map((_, i) => {
    const height = heights[(i + great) % heights.length]
    const r = (Math.min(bounds.halfX, bounds.halfZ) * height) / bounds.height
    return { height, r, d: R + r + 0.5 }
  })
  // The angle between two neighbours' centres.
  const between = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a.d * a.d + b.d * b.d - (a.r + b.r + HUTS.gap) ** 2) / (2 * a.d * b.d))))
  const at = (h, a) => { const b = deg(headBearing) + a; return [cx + Math.cos(b) * h.d, cz + Math.sin(b) * h.d] }
  const clear = (h, a) => clearOf(...at(h, a), h.r)
  if (!clear(stood[0], 0)) return null
  const placed = [{ h: stood[0], a: 0 }]
  const last = { 1: placed[0], [-1]: placed[0] }
  let side = 1
  for (let i = 1; i < stood.length; i++) {
    const h = stood[i]
    let put = null
    for (const s of [side, -side]) {
      let a = last[s].a + s * between(last[s].h, h)
      while (Math.abs(a) < Math.PI && !clear(h, a)) a += s * deg(1)
      if (Math.abs(a) >= Math.PI) continue
      const other = last[-s]
      if (TAU - Math.abs(a) - Math.abs(other.a) < between(other.h, h)) continue
      put = { h, a }
      last[s] = put
      break
    }
    if (put === null) return null
    placed.push(put)
    side = -side
  }
  return placed.map(({ h, a }) => {
    const [x, z] = at(h, a), b = deg(headBearing) + a
    // The door is +X in the pick's frame and a rotation of `yaw` about Y sends +X to (cos yaw, -sin yaw); it faces the ring's centre.
    return { x, z, yaw: Math.atan2(Math.sin(b), -Math.cos(b)), height: h.height, r: h.r }
  })
}

// --- the whole ---------------------------------------------------------------

/**
 * The room, from its rolls (rollVillage), the shell standing in it (built on
 * `spec.shell`) and the house's bounds: `{ heightmap, doc, spawn, exit, clearing,
 * lake, props, ground, spec }`. `doc` is the layers document (validated), `exit`
 * a fixed mouth for Entrances, `props` what RoomProps places, `spec` the rolls
 * built: the given ones, or the next village under the same shell where the
 * ground refused theirs.
 */
export function buildVillage({ spec, shell, house, attempt = 0 }) {
  if (!spec || !shell || shell.fit.yaw !== spec.shell.yaw) throw new Error('village: the shell must stand on the spec\'s fit')
  const again = (why) => {
    if (attempt >= ROLL_TRIES) throw new Error(`village: no village of seed ${spec.seed} builds (${why})`)
    return buildVillage({ spec: rollVillage(spec.seed, house, attempt + 1), shell, house, attempt: attempt + 1 })
  }
  const rng = mulberry32(spec.seed)
  const ground = makeGround(shell, spec)
  const lake = findLake(ground)
  if (lake.area < LAKE.least) return again('the lake is a puddle')

  const heightmap = buildHeightmap(ground)
  const lakeRec = { id: 'l1', x: 0, z: 0, y: lake.y, rx: TILE_M / 2, rz: TILE_M / 2, rot: 0, shape: SHAPE_RECT, carve: 0, depth: LAKE.depth }
  const fieldOf = (rivers) => {
    const candidate = { v: DOC_VERSION, snow: { base: 5000, band: 10, points: [] }, lakes: [lakeRec], rivers, roads: [] }
    return new V2Height({ heightmap, layers: Layers.deserialize(validate(candidate)), seed: SEED, relief: RELIEF_SHIPPED })
  }
  // The field with the lake alone: the ground the exit stands on and the rivers are walked on.
  const bare = fieldOf([])
  const bareAt = (x, z) => bare.heightAt(x, z)

  // The exit: the bearing whose wall stands most nearly plumb across the arch, its face point on that wall.
  const exit = placeExit(shell, ground, bareAt)
  const heading = bearingDeg(lake, exit.x, exit.z)

  // The loop's radius on every bearing: the water's reach dilated and averaged over LOOP.smooth degrees, LOOP.over past it.
  const wet = new Float32Array(360)
  for (let d = 0; d < 360; d++) wet[d] = lake.wetRadius(d)
  const half = Math.round(LOOP.smooth / 2)
  const wide = new Float32Array(360)
  for (let d = 0; d < 360; d++) { let m = 0; for (let k = -half; k <= half; k++) m = Math.max(m, wet[wrapDeg(d + k)]); wide[d] = m }
  const loopR = (bearing) => {
    let sum = 0
    for (let k = -half; k <= half; k++) sum += wide[Math.round(wrapDeg(bearing + k)) % 360]
    return sum / (2 * half + 1) + spec.loop.over
  }

  // The clearing off the loop (CLEARING), the spur straight out from the loop to its ring's inner point, the houses round the ring clear of the spur and the loop.
  const cb = heading + spec.clearing.side * spec.clearing.bearing
  const offCb = (b) => offDeg(b, cb)
  const spurEnd = { x: lake.x + Math.cos(deg(cb)) * loopR(cb), z: lake.z + Math.sin(deg(cb)) * loopR(cb) }
  const D = loopR(cb) + CLEARING.spur + CLEARING.r
  const clearing = { x: lake.x + Math.cos(deg(cb)) * D, z: lake.z + Math.sin(deg(cb)) * D, r: CLEARING.r }
  const spurPlan = []
  for (let i = 0, n = Math.ceil(CLEARING.spur / 1.5); i <= n; i++) spurPlan.push([spurEnd.x + Math.cos(deg(cb)) * ((CLEARING.spur * i) / n), spurEnd.z + Math.sin(deg(cb)) * ((CLEARING.spur * i) / n)])
  const clearOf = (x, z, r) => {
    const keep = r + ROAD_WIDTH / 2 + HUTS.gap
    return nearestOf(spurPlan, x, z) >= keep && Math.hypot(x - lake.x, z - lake.z) >= loopR(bearingDeg(lake, x, z)) + keep
  }
  const houses = housesRound(clearing.x, clearing.z, spec.huts, house, cb, spec.great, clearOf)
  if (houses === null) return again('the houses do not fit round the ring')
  const reach = CLEARING.r + 0.5 + 2 * Math.max(...houses.map((h) => h.r))
  if (Math.hypot(clearing.x, clearing.z) + reach + 6 > ground.rimAt(Math.atan2(clearing.z, clearing.x))) return again('the clearing stands against the wall')

  // The rivers, walked on the bare field, each proved on its own field: the solve carries it to the lake's level and its mouth lies on the water.
  const flows = (pts) => {
    const field = fieldOf([{ id: 'r1', depth: RIVER.depth, pts }])
    field.heightAt(lake.x, lake.z)
    const s = field.layers.paths.drawnSamples('r1')
    const level = field.layers.paths.flowsForward('r1') ? s[s.length - 3] : s[1]
    return Math.abs(level - lake.y) < 0.05
  }
  const rivers = []
  for (const rolled of spec.rivers) {
    let found = null
    for (let off = 0; found === null && off <= RIVER.sector; off += RIVER.retry) {
      for (const b of off === 0 ? [rolled] : [rolled + off, rolled - off]) {
        if (rivers.some((r) => Math.abs(r.bearing - b) < RIVER.apart)) continue
        const pts = riverPlan(bareAt, ground, lake, heading + b)
        if (pts === null || nearestOf(pts, clearing.x, clearing.z) < reach + RIVER.clear || pts.some(([x, z]) => nearestOf(spurPlan, x, z) < RIVER.clear)) continue
        if (flows(pts.map(([x, z]) => [x, z, RIVER.width]))) { found = { bearing: b, pts }; break }
      }
    }
    if (found === null) return again('no river reaches the lake')
    rivers.push(found)
  }
  const doc = {
    v: DOC_VERSION,
    snow: { base: 5000, band: 10, points: [] },
    lakes: [lakeRec],
    rivers: rivers.map((r, i) => ({ id: `r${i + 1}`, depth: RIVER.depth, pts: r.pts.map(([x, z]) => [x, z, RIVER.width]) })),
    roads: [],
  }
  const field = new V2Height({ heightmap, layers: Layers.deserialize(validate(doc)), seed: SEED, relief: RELIEF_SHIPPED })
  const heightAt = (x, z) => field.heightAt(x, z)
  const dry = lake.y + FREEBOARD + 0.2

  // The ring's level: the ground's mean round it.
  let ringY = 0
  for (let d = 0; d < 360; d += 10) ringY += heightAt(clearing.x + Math.cos(deg(d)) * CLEARING.r, clearing.z + Math.sin(deg(d)) * CLEARING.r) / 36
  if (ringY < lake.y + CLEARING.dry) return again('the clearing stands in the lake')

  // The loop: round the lake from where it stands RIVER.clear off the rivers on one side of their span to where it does on the other, through the exit's bearing and the spur's, held at the ring's level about the latter.
  let lo = Infinity, hi = -Infinity
  for (const r of rivers) for (const [x, z] of r.pts) { const b = wrapDeg(bearingDeg(lake, x, z) - heading); lo = Math.min(lo, b); hi = Math.max(hi, b) }
  const riverNear = (b) => { const r = loopR(b); return Math.min(...rivers.map((rv) => nearestOf(rv.pts, lake.x + Math.cos(deg(b)) * r, lake.z + Math.sin(deg(b)) * r))) }
  let loopFrom = heading + hi, loopTo = heading + lo + 360
  while (loopFrom < loopTo && riverNear(loopFrom) < RIVER.clear) loopFrom += 1
  while (loopTo > loopFrom && riverNear(loopTo) < RIVER.clear) loopTo -= 1
  const inLoop = (b) => wrapDeg(b - loopFrom) < wrapDeg(loopTo - loopFrom)
  if (!inLoop(heading) || !inLoop(cb - LOOP.level) || !inLoop(cb + LOOP.level) || loopTo - loopFrom < 180) return again('the rivers leave no room for the loop')
  const loopPlan = wandering(arcPoints(lake.x, lake.z, loopR, loopFrom, loopTo, 1.5), rng)
  // The junctions exactly on the plan: the trunk's on the exit's bearing, the spur's on the clearing's.
  const junction = (bearing, at) => {
    const off = (i) => offDeg(bearingDeg(lake, ...loopPlan[i]), bearing)
    let k = 0
    for (let i = 1; i < loopPlan.length; i++) if (off(i) < off(k)) k = i
    loopPlan[k] = [at.x, at.z]
    return k
  }
  const trunkEnd = { x: lake.x + Math.cos(deg(heading)) * loopR(heading), z: lake.z + Math.sin(deg(heading)) * loopR(heading) }
  const trunkAt = junction(heading, trunkEnd), spurAt = junction(cb, spurEnd)
  if (trunkAt === spurAt) return again('the trunk and the spur meet the loop at one point')
  const pins = new Map()
  loopPlan.forEach(([x, z], i) => { if (offCb(bearingDeg(lake, x, z)) <= LOOP.level) pins.set(i, ringY) })

  if (rivers.some((r) => loopPlan.some(([x, z]) => nearestOf(r.pts, x, z) < RIVER.clear))) return again('the loop comes up against a river')
  const loopPts = roadThrough(loopPlan, heightAt, { floor: dry, pins })
  if (loopPts === null) return again('the loop cannot hold its grade')
  const loop = checkRoad('the loop', loopPts)

  // The spur and the ring, closed on its first point, the inner point, both level.
  const spur = spurPlan.map(([x, z]) => [x, ringY, z, ROAD_WIDTH])
  const ring = arcPoints(clearing.x, clearing.z, () => CLEARING.r, cb + 180, cb + 540, 1.5).map(([x, z]) => [x, ringY, z, ROAD_WIDTH])

  // The trunk down from the arrival to the loop, on the side away from the clearing, then the other if that one runs through the wood the rivers own.
  const from = [exit.x + exit.nx * ARRIVE_M, exit.z + exit.nz * ARRIVE_M]
  const drop = heightAt(from[0], from[1]) - loop[trunkAt][1]
  let trunk = null
  for (const side of [-spec.clearing.side, spec.clearing.side]) {
    const plan = trunkPlan(lake, from, [trunkEnd.x, trunkEnd.z], side, drop)
    if (plan === null) continue
    if (nearestOf(plan, clearing.x, clearing.z) < reach + 4) continue
    if (rivers.some((r) => plan.some(([x, z]) => nearestOf(r.pts, x, z) < RIVER.clear))) continue
    if (plan.some(([x, z]) => Math.hypot(x - trunkEnd.x, z - trunkEnd.z) > TRUNK.approach && Math.hypot(x - lake.x, z - lake.z) < loopR(bearingDeg(lake, x, z)) + 3)) continue
    trunk = wandering(plan, rng)
    break
  }
  if (trunk === null) return again('no trunk comes down clear of the rivers and the clearing')
  const trunkRaw = roadThrough(trunk, heightAt, { floor: dry, pins: new Map([[0, heightAt(from[0], from[1])], [trunk.length - 1, loop[trunkAt][1]]]) })
  if (trunkRaw === null) return again('the trunk cannot hold its grade')
  const trunkPts = checkRoad('the trunk', trunkRaw)

  // A pad under each house at the ring's height.
  const pads = houses.flatMap((h, k) => HUTS.pads.map((f, j) => ({ id: `pad-${k}-${j}`, pts: arcPoints(h.x, h.z, () => f * h.r, 0, 360, 1.5).map(([x, z]) => [x, ringY, z, 2 * HUTS.padHalf * h.r]) })))
  doc.roads.push({ id: 'd1', pts: trunkPts }, { id: 'd2', pts: loop }, { id: 'd3', pts: ring }, { id: 'd4', pts: spur }, ...pads)
  validate(doc)

  const props = houses.map((h) => ({ x: h.x, z: h.z, yaw: h.yaw, height: h.height }))
  return { heightmap, doc, spawn: { x: from[0], z: from[1] }, exit, clearing, lake: { x: lake.x, z: lake.z, y: lake.y, area: lake.area }, props, ground, spec }
}

/**
 * The exit mouth: `{ key, x, z, nx, nz, bearing }`. On each bearing the face point
 * is where the wall stands at the arch's mid height over the ground `heightAt` reads there;
 * the bearing taken is the one whose wall moves least across the arch's
 * height, so the arch stands against the stone top to bottom.
 */
export function placeExit(shell, ground, heightAt) {
  let best = null
  for (let d = 0; d < 360; d++) {
    const b = deg(d), c = Math.cos(b), s = Math.sin(b)
    let r = ground.rimAt(b)
    for (let i = 0; i < 6; i++) r = shell.wallAt(heightAt(c * r, s * r) + EXIT.band / 2, b)
    const y = heightAt(c * r, s * r)
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k <= 6; k++) { const w = shell.wallAt(y + (EXIT.band * k) / 6, b); lo = Math.min(lo, w); hi = Math.max(hi, w) }
    const spread = hi - lo
    if (best === null || spread < best.spread) best = { spread, x: c * r, z: s * r, nx: -c, nz: -s, bearing: d }
  }
  if (best.spread > EXIT.plumb) throw new Error(`village: no wall stands within ${EXIT.plumb} m of plumb across the arch`)
  return { key: 'exit', x: best.x, z: best.z, nx: best.nx, nz: best.nz, bearing: best.bearing }
}

/**
 * A river's plan (`[x, z]` nodes) down `bearing` (degrees from +X off the lake)
 * on `heightAt`, the ground the solve reads: from RIVER.from of the way out
 * to the wall, walked toward the lake and downhill to the lake's own water, a
 * node every RIVER.node steps and the mouth last;
 * null where the walk reaches no water of the lake's own, or no point of it
 * within RIVER.mouthSteps of the water is ground a mouth can be pinned on.
 */
export function riverPlan(heightAt, ground, lake, bearing) {
  const c = Math.cos(deg(bearing)), s = Math.sin(deg(bearing))
  let r = 1
  while (Math.hypot(lake.x + c * r, lake.z + s * r) < RIVER.from * ground.rimAt(Math.atan2(lake.z + s * r, lake.x + c * r))) r += 1
  let x = lake.x + c * r, z = lake.z + s * r
  const walk = [[x, z]]
  let mouth = null, least = Infinity, stalled = 0, follow = RIVER.follow, reached = false
  for (let i = 0; i < 800; i++) {
    const over = heightAt(x, z) - lake.y
    if (over < FREEBOARD + RIVER.mouthOver && lake.inLake(x, z)) { reached = true; break }
    if (over > FREEBOARD + RIVER.mouthOver && over < RIVER.depth - RIVER.mouthOver) mouth = walk.length - 1
    // Stalled in a pit over the water: from here straight for the lake's deepest point.
    if (over < least - 0.01) { least = over; stalled = 0 } else if (++stalled > RIVER.stall) follow = 0
    const tl = Math.hypot(lake.deep.x - x, lake.deep.z - z)
    if (tl < 1) break
    const gx = (heightAt(x + 1, z) - heightAt(x - 1, z)) / 2, gz = (heightAt(x, z + 1) - heightAt(x, z - 1)) / 2
    const gl = Math.hypot(gx, gz)
    let dx = (lake.deep.x - x) / tl, dz = (lake.deep.z - z) / tl
    if (gl > 1e-6) { dx -= (follow * gx) / gl; dz -= (follow * gz) / gl }
    const dl = Math.hypot(dx, dz)
    x += (dx / dl) * RIVER.step; z += (dz / dl) * RIVER.step
    walk.push([x, z])
  }
  if (!reached || mouth === null || mouth < RIVER.node || walk.length - 1 - mouth > RIVER.mouthSteps) return null
  const pts = []
  for (let i = 0; i < mouth; i += RIVER.node) pts.push(walk[i])
  pts.push(walk[mouth])
  return pts
}
