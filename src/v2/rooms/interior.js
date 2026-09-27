// A leafkin house's inside (design/30-leafkin.md, Interiors): the room rolled from the village's seed and the house's index, and the stone she walks it by. Pure, no three. Local metres: the floor's centre at the origin, y up, the door on bearing pi, so she comes in facing +X. Leafkin-sized: a 1 m body sits at villagers.js SEAT_M.
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'

const TAU = 2 * Math.PI
// Outline samples round the room.
export const RING = 288
// The floor's cove into the wall: the wall is stone from its foot in.
export const FILLET = 0.15
export const SEAT = 0.19
export const TABLE_TOP = 0.42
// Stone this high stands for furniture she cannot climb (backs, pots, tools leant up): over her reach (0.6 m at HER_SCALE). Low furniture is stone to its own top, a step she climbs onto where her head clears.
export const BLOCK = 0.8
export const STOOL_H = 0.24, HAMPER_H = 0.36
// The armchair's cushion top (render/interior.js `armchair`).
const ARMCHAIR_SEAT = 0.25
// A house this tall outside has a loft inside.
const LOFT_HOUSE_M = 6
// Three rises must stay within her glade reach (0.6 m): player.js looks a stride (0.75 m, ~2.7 treads) ahead on a steep step, and a tread past her reach reads as the floor below, so the stairs refuse her.
const RISE = 0.17, TREAD = 0.28, STAIR_W = 0.55
// Floor kept clear inside the door, and round the table for the chairs and the walk about it.
const DOOR_CLEAR = 1.1
const RING_M = 0.66
// Half the width kept clear along a resident's straight walks: the door and each place to the table's ring.
const LANE = 0.24
// A loft's rail is stone this high whatever it looks, so she never takes it for a step.
const RAIL_STONE = 0.7
// Stuff is set along the walls until it stands on this share of the floor.
const FULL = 0.5

export const wrap = (a) => ((a % TAU) + TAU) % TAU
export const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t) }

/** The wall's radius on bearing `a` off the room's `rs`. */
export function rAt(rs, a) {
  const u = (wrap(a) / TAU) * RING, i = Math.floor(u) % RING, f = u - Math.floor(u)
  return rs[i] * (1 - f) + rs[(i + 1) % RING] * f
}

/** The ceiling over (rho, bearing) in a room whose wall stands `hW` and apex `H`: an ellipse from the wall's top, level at the apex. */
export function ceilingAt(room, rho, r) {
  const t = Math.min(1, rho / r)
  return room.hW + (room.H - room.hW) * Math.sqrt(1 - t * t)
}

/** How far a loft reaches in from the wall on bearing `a`, tapering into the wall at its far end; 0 off it. */
export function loftDepthAt(loft, a) {
  const t = wrap(a - loft.a0)
  if (t > loft.a1 - loft.a0) return 0
  const far = loft.dir > 0 ? t : loft.a1 - loft.a0 - t
  return loft.depth * smooth(0, loft.taper, far)
}

// The tops of what render/interior.js builds, for their stone: a crate stack (each crate on the first 0.88 the size), a woodpile's rows of 0.06 m logs 1.72 radii apart (as many as its depth holds), and the free-standing heaps by their radius.
const crateTop = (c) => c.s * (1 + 0.88 * (c.stack - 1))
const woodpileTop = (rows, depth) => 0.06 * (2.1 + 1.72 * (Math.min(rows, Math.max(1, Math.floor((depth - 0.03) / 0.12))) - 1))
const FREE_TOP = { stools: () => STOOL_H, hamper: () => HAMPER_H + 0.055, sacks: () => 0.47, gourds: (r) => r * 0.9 }

/** The distance from (x, z) to the segment `l`. */
const segDist = (l, x, z) => {
  const dx = l.x1 - l.x0, dz = l.z1 - l.z0, len2 = dx * dx + dz * dz
  const t = len2 > 0 ? clamp(((x - l.x0) * dx + (z - l.z0) * dz) / len2, 0, 1) : 0
  return Math.hypot(x - l.x0 - dx * t, z - l.z0 - dz * t)
}

/**
 * The room for house `index` of the village seeded `seed`, whose house stands `height` metres outside. Everything placed is in `items` for the renderer, `solids` for the stone, `candles` for the flames and the light, and `spots` for the residents.
 */
export function rollInterior({ seed, index, height }) {
  if (!Number.isInteger(seed) || !Number.isInteger(index) || !(height > 0)) throw new Error('rollInterior: needs an integer seed and index and a positive height')
  const rng = mulberry32(hash32(seed, index, 0x1d0))
  const range = (lo, hi) => lo + (hi - lo) * rng()
  const pick = (list) => list[Math.floor(rng() * list.length)]

  const R = clamp(1.55 + 0.17 * height, 2.15, 2.9) + range(-0.1, 0.1)
  // The outline: slow lobes, wooden ribs up the wall with a bay bellied out between each two, and rounded nooks pushed out of it; all calmed a door's width about the door.
  const lobes = [[2, 0.04, 0.09], [3, 0.02, 0.06], [5, 0.01, 0.03]].map(([n, lo, hi]) => ({ n, a: range(lo, hi), p: range(0, TAU) }))
  const ribN = 4 + Math.floor(rng() * 2) + (R > 2.7 ? 1 : 0), rib0 = range(0, TAU)
  let ribs = []
  for (let k = 0; k < ribN; k++) {
    const a = wrap(rib0 + ((k + range(-0.2, 0.2)) * TAU) / ribN)
    if (Math.abs(angDiff(a, Math.PI)) < 0.75) continue
    ribs.push({ a, w: range(0.16, 0.24), d: range(0.17, 0.26), bay: range(0.12, 0.25), lean: range(-0.06, 0.06) })
  }
  ribs.sort((p, q) => p.a - q.a)
  const bayAt = (a) => {
    const i = ribs.findIndex((r) => r.a > a)
    const next = ribs[i < 0 ? 0 : i], prev = ribs[i < 0 ? ribs.length - 1 : (i - 1 + ribs.length) % ribs.length]
    const t = wrap(a - prev.a) / (wrap(next.a - prev.a) || TAU)
    return (prev.bay + (next.bay - prev.bay) * t) * Math.sin(Math.PI * t) ** 0.6
  }
  const nooks = []
  const nookCount = 2 + Math.floor(rng() * 3)
  for (let tries = 0; nooks.length < nookCount && tries < 60; tries++) {
    const a = range(-Math.PI, Math.PI)
    if (Math.abs(angDiff(a, Math.PI)) < 0.9 || nooks.some((n) => Math.abs(angDiff(a, n.a)) < 1.0)) continue
    nooks.push({ a, d: range(0.35, 0.6), w: range(0.2, 0.3) })
  }
  const rs = new Float32Array(RING)
  for (let i = 0; i < RING; i++) {
    const a = (i / RING) * TAU, calm = smooth(0.35, 0.8, Math.abs(angDiff(a, Math.PI)))
    let lobe = 0
    for (const l of lobes) lobe += l.a * Math.cos(l.n * a + l.p)
    let r = R * (1 + lobe * calm) + bayAt(a) * calm
    for (const n of nooks) r += n.d * Math.exp(-((angDiff(a, n.a) / n.w) ** 2))
    rs[i] = r
  }
  const rOf = (a) => rAt(rs, a)
  const polar = (a, inset, y = 0) => ({ x: Math.cos(a) * (rOf(a) - inset), y, z: Math.sin(a) * (rOf(a) - inset) })
  // Yaws are three's rotation.y: a thing's front (+Z) looks along (sin yaw, cos yaw). Against the wall at bearing `a`, into the room.
  const inward = (a) => Math.atan2(-Math.cos(a), -Math.sin(a))

  const lofty = height >= LOFT_HOUSE_M
  const yL = lofty ? range(1.75, 1.95) : 0
  const hW = lofty ? yL + 1.25 : range(1.5, 1.8)
  const H = hW + (lofty ? range(0.9, 1.2) : range(0.8, 1.1))
  const room = { seed, index, R, rs, hW, H, nooks }

  // Wall arcs taken, low (floor-standing things) and high (openings, shelves, hangings), each { a, half } in radians; the loft keeps its own pair, so its bed may lie under its window.
  const low = [], high = [], up = [], upHigh = []
  const free = (list, a, half) => list.every((c) => Math.abs(angDiff(a, c.a)) > half + c.half)
  const claim = (lists, a, halfM) => {
    const half = halfM / rOf(a)
    if (!lists.every((l) => free(l, a, half))) return false
    for (const l of lists) l.push({ a, half })
    return true
  }

  const door = { a: Math.PI, r: range(0.5, 0.58), depth: 0.3 }
  door.y = door.r + 0.06
  claim([low, high], door.a, door.r + 0.35)

  const solids = []
  const items = []
  const candles = []
  const spots = []
  // Floor discs taken: { x, z, r, level } -- level 0 the floor, 1 the loft.
  const discs = []
  const doorIn = polar(Math.PI, DOOR_CLEAR)
  const mouth = polar(Math.PI, 0.4)
  discs.push({ x: doorIn.x, z: doorIn.z, r: 0.5, level: 0 }, { x: mouth.x, z: mouth.z, r: 0.45, level: 0 })

  let loft = null
  const stairs = []
  const climb = []
  if (lofty) {
    const dir = rng() < 0.5 ? 1 : -1
    const n = Math.round(yL / RISE), rise = yL / n
    const run = ((n - 1) * TREAD) / (R - STAIR_W / 2)
    const cL = range(-0.3, 0.3)
    const room4door = Math.PI - 0.6 - run - dir * cL
    const half = Math.min(range(1.0, 1.3), room4door)
    if (half < 0.7) throw new Error(`rollInterior: no room for a loft in house ${index}`)
    loft = { a0: cL - half, a1: cL + half, dir, depth: range(0.42, 0.48) * R, y: yL, thick: 0.14, taper: 0.45 }
    room.loft = loft
    const e = dir > 0 ? loft.a1 : loft.a0
    solids.push({ kind: 'band', a0: loft.a0, a1: loft.a1, loft, from: -0.5, y0: yL - loft.thick, y1: yL })
    // The rail: a band at the loft's lip, all but the stair end's last half metre.
    solids.push({ kind: 'band', a0: loft.a0, a1: loft.a1, loft, rail: 0.08, y0: yL, y1: yL + RAIL_STONE, open: { a: e, half: 0.55 / R } })
    // The treads run down along the wall from the loft's stair end, each stone from the floor.
    let a = e
    for (let j = 0; j < n - 1; j++) {
      const da = TREAD / (rOf(a) - STAIR_W / 2)
      const lo = dir > 0 ? a : a - da, hi = dir > 0 ? a + da : a
      const top = yL - (j + 1) * rise
      stairs.push({ a0: lo, a1: hi, top, w: STAIR_W })
      solids.push({ kind: 'band', a0: lo, a1: hi, from: -0.5, to: STAIR_W, y0: 0, y1: top })
      a += dir * da
    }
    const s0 = Math.min(e, a), s1 = Math.max(e, a)
    low.push({ a: (s0 + s1) / 2, half: (s1 - s0) / 2 + 0.1 })
    high.push({ a: (s0 + s1) / 2, half: (s1 - s0) / 2 + 0.05 })
    // The loft wall where the stairs come up stays clear for the step off them.
    up.push({ a: e - (dir * 0.4) / R, half: 0.6 / R })
    // No rib stands where the stairs run up the wall; its cusp stays behind them.
    ribs = ribs.filter((r) => Math.abs(angDiff(r.a, (s0 + s1) / 2)) > (s1 - s0) / 2 + 0.12)
    // The way up for a walker: the stairs' foot, each tread's middle, and a step onto the loft.
    const foot = polar(a + dir * 0.25, STAIR_W / 2)
    climb.push({ x: foot.x, z: foot.z })
    for (let j = stairs.length - 1; j >= 0; j--) { const s = stairs[j], p = polar((s.a0 + s.a1) / 2, STAIR_W / 2); climb.push({ x: p.x, z: p.z }) }
    const land = polar(e - dir * 0.35, 0.6)
    climb.push({ x: land.x, z: land.z })
    discs.push({ x: foot.x, z: foot.z, r: 0.4, level: 0 }, { x: land.x, z: land.z, r: 0.4, level: 1 })
  }
  for (const r of ribs) {
    claim([low, high, up, upHigh], r.a, r.w / 2 + 0.06)
    solids.push({ kind: 'band', a0: r.a - r.w / 2 / rOf(r.a), a1: r.a + r.w / 2 / rOf(r.a), from: -0.5, to: r.d, y0: 0, y1: hW })
  }
  room.ribs = ribs
  const underLoft = (a, inset) => loft !== null && loftDepthAt(loft, a) > inset
  const inLoft = (a) => loft !== null && wrap(a - loft.a0) <= loft.a1 - loft.a0

  // --- the openings -------------------------------------------------------
  const windows = []
  const wantWin = 1 + Math.floor(rng() * 3)
  for (let tries = 0; windows.length < wantWin && tries < 80; tries++) {
    const onLoft = loft !== null && windows.length > 0 && rng() < 0.5
    const r = onLoft ? range(0.2, 0.25) : range(0.22, 0.35)
    const a = onLoft ? range(loft.a0 + 0.4, loft.a1 - 0.4) : tries < 20 && nooks.length > 0 ? pick(nooks).a + range(-0.1, 0.1) : range(-Math.PI, Math.PI)
    let y = onLoft ? yL + range(0.5, 0.65) : range(1.05, 1.3)
    // Under a loft a window sits low enough to clear its underside.
    if (!onLoft && underLoft(a, 0)) y = Math.min(y, yL - loft.thick - 0.14 - r)
    if (y - r < 0.55 || y + r > hW - 0.12) continue
    if (!claim(onLoft ? [upHigh] : [high], a, r + 0.3)) continue
    windows.push({ a, y, r, depth: 0.25, level: onLoft ? 1 : 0 })
  }
  if (!windows.some((w) => w.level === 0)) throw new Error(`rollInterior: house ${index} has no window on its floor`)

  // --- floor placement ----------------------------------------------------
  const lanes = []
  // Whether a floor disc is clear of the stairs (far enough that she can't drop off their side onto it) and (unless it stands against the wall) of the wall.
  const walkable = (x, z, r, onWall = false) => {
    const a = Math.atan2(z, x), rho = Math.hypot(x, z)
    if (!onWall && rho + r > rOf(a) - FILLET - 0.02) return false
    for (const s of stairs) {
      const mid = (s.a0 + s.a1) / 2, halfA = (s.a1 - s.a0) / 2 + r / rOf(mid)
      if (Math.abs(angDiff(a, mid)) < halfA && rho + r > rOf(a) - s.w - 0.4) return false
    }
    return true
  }
  // Whether a disc is free of the placed discs, the lanes, the stairs and (unless it stands against the wall) the wall.
  const open = (x, z, r, level = 0, onWall = false) => {
    const a = Math.atan2(z, x), rho = Math.hypot(x, z)
    if (level === 0 && (!walkable(x, z, r, onWall) || lanes.some((l) => segDist(l, x, z) < LANE + r))) return false
    if (level === 1 && !onWall && rho + r > rOf(a) - FILLET - 0.02) return false
    if (level === 1 && rho - r < rOf(a) - loftDepthAt(loft, a) + 0.1) return false
    return discs.every((d) => d.level !== level || Math.hypot(d.x - x, d.z - z) > d.r + r)
  }
  const take = (x, z, r, level = 0) => discs.push({ x, z, r, level })
  // The floor's area, and how much of it stands under stuff.
  let floorArea = 0
  for (let i = 0; i < RING; i++) floorArea += 0.5 * (rs[i] - FILLET) ** 2 * (TAU / RING)
  let cover = 0
  for (const s of stairs) cover += (s.a1 - s.a0) * (rOf((s.a0 + s.a1) / 2) - s.w / 2) * s.w
  const hue = (h, s, l) => ({ h, s, l })

  // Weathered wood like the house's bark outside, and cloths faded to moss, rust, ochre and slate.
  const tints = {
    wall: pick([hue(0.09, 0.3, 0.52), hue(0.08, 0.26, 0.46), hue(0.1, 0.22, 0.5), hue(0.11, 0.2, 0.44)]),
    wood: pick([hue(0.08, 0.3, 0.42), hue(0.09, 0.26, 0.48), hue(0.07, 0.32, 0.38)]),
    table: pick([hue(0.08, 0.24, 0.5), hue(0.07, 0.28, 0.42), hue(0.1, 0.2, 0.46)]),
    cloth: pick([hue(0.2, 0.28, 0.32), hue(0.04, 0.4, 0.34), hue(0.11, 0.42, 0.38), hue(0.58, 0.14, 0.34), hue(0.95, 0.2, 0.32)]),
    cloth2: pick([hue(0.1, 0.22, 0.5), hue(0.22, 0.2, 0.42), hue(0.03, 0.26, 0.42)]),
  }
  room.tints = tints

  // The table, with the walk about it clear of the wall, the stairs and the door, and at most 0.3 m under the loft.
  const tr = R * range(0.2, 0.24)
  const ringR = tr + RING_M
  let table = null
  for (let tries = 0; tries < 300 && table === null; tries++) {
    // Near the middle first, so the walls keep a band all round for the rest.
    const d = range(0, R * (tries < 150 ? 0.25 : 0.5)), b = range(-Math.PI, Math.PI)
    const x = Math.cos(b) * d, z = Math.sin(b) * d
    // The ring is a walk, so it may cross the door's and the stairs' clear floor.
    let ok = open(x, z, tr + 0.5) && walkable(x, z, ringR)
    for (let k = 0; k < 16 && ok; k++) {
      const q = (k / 16) * TAU, px = x + Math.cos(q) * ringR, pz = z + Math.sin(q) * ringR, pa = Math.atan2(pz, px)
      if (underLoft(pa, rOf(pa) - Math.hypot(px, pz) + 0.3)) ok = false
    }
    if (ok) table = { x, z }
  }
  if (table === null) throw new Error(`rollInterior: no floor for the table in house ${index}`)
  // The residents on the ring have bodies: keep things their width off it.
  take(table.x, table.z, ringR + 0.18)
  room.ring = { x: table.x, z: table.z, r: ringR }
  const legs = rng() < 0.5 ? 3 : 4
  items.push({ kind: 'table', x: table.x, z: table.z, r: tr, top: TABLE_TOP, legs, spin: range(0, TAU) })
  solids.push({ kind: 'cyl', x: table.x, z: table.z, r: tr, y0: 0, y1: TABLE_TOP })
  cover += Math.PI * tr * tr

  const chairs = 2 + Math.floor(rng() * 3)
  const c0 = range(0, TAU)
  for (let k = 0; k < chairs; k++) {
    const q = c0 + (k / chairs) * TAU + range(-0.2, 0.2)
    const sr = range(0.19, 0.23), cd = tr + sr + 0.02
    const x = table.x + Math.cos(q) * cd, z = table.z + Math.sin(q) * cd
    const yaw = Math.atan2(-Math.cos(q), -Math.sin(q))
    const back = rng() < 0.75 ? range(0.5, 0.66) : 0
    items.push({ kind: 'chair', x, z, yaw, r: sr, top: SEAT, back, style: Math.floor(rng() * 3), cushion: rng() < 0.6 })
    // The seat is a step; the back (render/interior.js leans it out behind the seat's rim) is a wall.
    solids.push({ kind: 'cyl', x, z, r: sr, y0: 0, y1: SEAT })
    if (back) solids.push({ kind: 'box', x: x - Math.sin(yaw) * (sr + 0.01), z: z - Math.cos(yaw) * (sr + 0.01), yaw, hx: sr * 0.85, hz: 0.05, y0: 0, y1: BLOCK })
    cover += Math.PI * sr * sr
    spots.push({ kind: 'seat', x, z, top: SEAT, r: sr, lookX: -Math.cos(q), lookZ: -Math.sin(q), level: 0 })
    // A place set before it: a plate, and sometimes a cup.
    const pd = tr - 0.15
    items.push({ kind: 'plate', x: table.x + Math.cos(q) * pd, z: table.z + Math.sin(q) * pd, y: TABLE_TOP, food: rng() < 0.5 ? pick(['berries', 'bread', 'acorns']) : null })
    if (rng() < 0.7) items.push({ kind: 'cup', x: table.x + Math.cos(q + 0.35) * pd, z: table.z + Math.sin(q + 0.35) * pd, y: TABLE_TOP })
  }
  // The table's middle: flowers or a bowl, and one to three candles.
  const midA = range(0, TAU)
  items.push(rng() < 0.65 ? { kind: 'vase', x: table.x, z: table.z, y: TABLE_TOP, flowers: 3 + Math.floor(rng() * 4), hue: range(0, 1) } : { kind: 'bowl', x: table.x, z: table.z, y: TABLE_TOP, food: pick(['berries', 'acorns', 'apples']) })
  const tableCandles = 1 + Math.floor(rng() * 3)
  for (let k = 0; k < tableCandles; k++) {
    const q = midA + (k / tableCandles) * TAU, d = tr * 0.45
    const x = table.x + Math.cos(q) * d, z = table.z + Math.sin(q) * d, h = range(0.07, 0.14)
    items.push({ kind: 'candle', x, z, y: TABLE_TOP, h })
    candles.push({ x, y: TABLE_TOP + h + 0.035, z, i: 0.8 })
  }

  // Something against the wall at bearing `a`, `halfM` either side, `depthM` deep: its middle, and its claim, or null.
  const wallSpot = (a, halfM, depthM, lists = [low]) => {
    const inset = depthM / 2 + 0.03
    const p = polar(a, FILLET + inset), level = lists.includes(up) ? 1 : 0
    const r = Math.min(halfM, depthM / 2 + 0.02), steps = Math.ceil(halfM / r)
    const foot = []
    for (let k = -steps; k <= steps; k++) {
      const q = polar(a + ((k / steps) * (halfM - r)) / rOf(a), FILLET + inset)
      if (!open(q.x, q.z, r, level, true)) return null
      foot.push(q)
    }
    if (!claim(lists, a, halfM)) return null
    for (const q of foot) take(q.x, q.z, r, level)
    return { a, x: p.x, z: p.z, yaw: inward(a), level, y: level ? yL : 0 }
  }
  const tryWall = (halfM, depthM, lists, pref = () => range(-Math.PI, Math.PI), tries = 60) => {
    for (let t = 0; t < tries; t++) {
      const s = wallSpot(pref(t), halfM, depthM, lists)
      if (s) return s
    }
    return null
  }
  // Stone over a wall arc, from the wall out to `depthM` in.
  const wallStone = (a, halfM, depthM, y0 = 0, y1 = BLOCK) => {
    const half = halfM / rOf(a)
    solids.push({ kind: 'band', a0: a - half, a1: a + half, from: -0.5, to: FILLET + depthM, y0, y1 })
    if (y0 === 0) cover += 2 * halfM * depthM
  }

  // --- the kitchen: under the loft where there is one, else in a nook ------
  const kDepth = 0.5
  let kHalf = range(0.7, 0.95), kitchen = null
  // Shorter until it fits between the ribs.
  for (let t = 0; t < 120 && kitchen === null; t++) {
    if (t % 30 === 29) kHalf = Math.max(0.5, kHalf - 0.12)
    const a = loft && t < 30 ? range(loft.a0 + 0.5, loft.a1 - 0.5) : t < 40 && nooks.length > 0 ? pick(nooks).a + range(-0.15, 0.15) : range(-Math.PI, Math.PI)
    kitchen = wallSpot(a, kHalf, kDepth, [low, high])
  }
  if (kitchen === null) throw new Error(`rollInterior: no wall for the kitchen in house ${index}`)
  {
    const r = rOf(kitchen.a), half = kHalf / r
    const top = 0.5
    items.push({ kind: 'counter', a0: kitchen.a - half, a1: kitchen.a + half, depth: kDepth, top })
    wallStone(kitchen.a, kHalf, kDepth)
    // Along its top, from one end: the basin, then jars, a loaf, a cheese.
    const along = (t) => polar(kitchen.a + (t - 0.5) * 2 * half * 0.85, FILLET + kDepth / 2, top)
    const b = along(0.12)
    items.push({ kind: 'basin', x: b.x, z: b.z, y: top, r: 0.17 })
    const goods = ['jar', 'jar', 'loaf', 'cheese', 'jar', 'crock', 'crock'].sort(() => rng() - 0.5).slice(0, 4 + Math.floor(rng() * 2))
    goods.forEach((g, k) => {
      const p = along(0.32 + (k / goods.length) * 0.66)
      items.push({ kind: g, x: p.x, z: p.z, y: top, h: range(0.12, 0.2), hue: range(0, 1), yaw: range(0, TAU) })
    })
    // Herbs on a pole above it, or from the loft's underside.
    const hy = loft && underLoft(kitchen.a, 0.3) ? yL - loft.thick - 0.06 : Math.min(1.45, hW - 0.25)
    items.push({ kind: 'herbs', a0: kitchen.a - half * 0.8, a1: kitchen.a + half * 0.8, y: hy, inset: FILLET + 0.18, n: 4 + Math.floor(rng() * 3) })
    const stand = polar(kitchen.a, FILLET + kDepth + 0.3)
    spots.push({ kind: 'cook', x: stand.x, z: stand.z, lookX: Math.cos(kitchen.a), lookZ: Math.sin(kitchen.a), level: 0 })
    take(stand.x, stand.z, 0.25)
  }

  // --- the bed: in the loft, else the deepest free nook, off the floor window the reading corner wants ---
  const readWin = windows.find((w) => w.level === 0)
  const bedLen = range(1.2, 1.4), bedWid = range(0.65, 0.8)
  const onLoft = loft !== null
  let bedUp = onLoft
  let bed = onLoft
    ? tryWall(bedLen / 2 + 0.05, bedWid, [up], () => {
      // Clear of the loft's tapered end, so the bed's corners stay on the boards.
      const far = loft.taper + bedLen / 2 / R, span = loft.a1 - loft.a0
      const t = range(Math.min(far, span / 2), Math.max(span / 2, span - bedLen / 2 / R - 0.2))
      return loft.dir > 0 ? loft.a0 + t : loft.a1 - t
    })
    : null
  if (bed === null) {
    bedUp = false
    const byWin = (a) => Math.abs(angDiff(a, readWin.a)) < (readWin.r + 1.1 + bedLen / 2) / rOf(readWin.a)
    bed = tryWall(bedLen / 2 + 0.05, bedWid, [low], (t) => {
      if (t < 30 && nooks.length > 0) return [...nooks].sort((p, q) => q.d - p.d)[t % nooks.length].a + range(-0.1, 0.1)
      let a = range(-Math.PI, Math.PI)
      for (let k = 0; k < 10 && t < 100 && byWin(a); k++) a = range(-Math.PI, Math.PI)
      return a
    }, 150)
  }
  if (bed === null) throw new Error(`rollInterior: no wall for the bed in house ${index}`)
  {
    const y = bedUp ? yL : 0
    const p = polar(bed.a, FILLET + bedWid / 2 + 0.03)
    // Long along the wall; its head, pillow and plushies at its +Z end.
    const along = bed.yaw + Math.PI / 2, c = Math.cos(along), s = Math.sin(along)
    const top = y + 0.2
    items.push({ kind: 'bed', x: p.x, z: p.z, y, yaw: along, len: bedLen, wid: bedWid, top: 0.2 })
    solids.push({ kind: 'box', x: p.x, z: p.z, yaw: along, hx: bedWid / 2, hz: bedLen / 2, y0: y, y1: y + 0.24 })
    discs.push({ x: p.x, z: p.z, r: bedLen / 2, level: bedUp ? 1 : 0 })
    if (!bedUp) cover += bedLen * bedWid
    const plush = 1 + Math.floor(rng() * 3)
    for (let k = 0; k < plush; k++) {
      const u = range(-0.05, 0.22) * bedLen, v = range(-0.3, 0.3) * bedWid
      items.push({ kind: 'plush', x: p.x + u * s + v * c, z: p.z + u * c - v * s, y: top + 0.04, yaw: range(0, TAU), size: range(0.1, 0.15), hue: range(0, 1), shape: Math.floor(rng() * 3) })
    }
    spots.push({ kind: 'bed', x: p.x, z: p.z, top, yaw: along, len: bedLen, wid: bedWid, lookX: s, lookZ: c, level: bedUp ? 1 : 0 })
    // Where its sleeper gets up: past its foot.
    if (!bedUp) take(p.x - s * (bedLen / 2 + 0.25), p.z - c * (bedLen / 2 + 0.25), 0.22)
  }

  // --- the reading corner, by a window on the floor ---------------------
  {
    let chair = null
    for (let t = 0; t < 12 && chair === null; t++) {
      const side = t % 2 ? -1 : 1
      const a = readWin.a + (side * (readWin.r + 0.3 + (t >> 1) * 0.1)) / rOf(readWin.a)
      chair = wallSpot(a, 0.38, 0.66, [low])
      if (chair) chair.side = side
    }
    if (chair) {
      // Turned half toward the window, so the page takes its light.
      const yaw = chair.yaw - chair.side * 0.5
      items.push({ kind: 'armchair', x: chair.x, z: chair.z, yaw, top: 0.2, r: 0.34 })
      solids.push({ kind: 'cyl', x: chair.x, z: chair.z, r: 0.32, y0: 0, y1: ARMCHAIR_SEAT })
      solids.push({ kind: 'box', x: chair.x - Math.sin(yaw) * 0.2, z: chair.z - Math.cos(yaw) * 0.2, yaw, hx: 0.3, hz: 0.1, y0: 0, y1: BLOCK })
      cover += Math.PI * 0.32 * 0.32
      take(chair.x, chair.z, 0.38)
      spots.push({ kind: 'read', x: chair.x, z: chair.z, top: 0.2, r: 0.28, lookX: Math.sin(yaw), lookZ: Math.cos(yaw), level: 0 })
      // Its reader stands up in front of it.
      take(chair.x + Math.sin(yaw) * 0.6, chair.z + Math.cos(yaw) * 0.6, 0.22)
      const st = polar(chair.a - (chair.side * 0.58) / rOf(chair.a), FILLET + 0.22)
      if (open(st.x, st.z, 0.17)) {
        take(st.x, st.z, 0.17)
        items.push({ kind: 'sidetable', x: st.x, z: st.z, r: 0.17, top: 0.34 })
        items.push({ kind: 'books', x: st.x, z: st.z, y: 0.34, n: 2 + Math.floor(rng() * 3), yaw: range(0, TAU) })
        solids.push({ kind: 'cyl', x: st.x, z: st.z, r: 0.17, y0: 0, y1: 0.34 })
        cover += Math.PI * 0.17 * 0.17
        if (rng() < 0.6) {
          const cx = st.x + 0.06, cz = st.z - 0.05, h = range(0.06, 0.1)
          items.push({ kind: 'candle', x: cx, z: cz, y: 0.34, h })
          candles.push({ x: cx, y: 0.34 + h + 0.035, z: cz, i: 0.6 })
        }
      }
      const rugAt = { x: chair.x - Math.cos(chair.a) * 0.6, z: chair.z - Math.sin(chair.a) * 0.6 }
      items.push({ kind: 'rug', x: rugAt.x, z: rugAt.z, r: range(0.55, 0.7), hue: range(0, 1) })
    }
    const g = polar(readWin.a, FILLET + 0.55)
    if (open(g.x, g.z, 0.2)) {
      spots.push({ kind: 'gaze', x: g.x, z: g.z, lookX: Math.cos(readWin.a), lookZ: Math.sin(readWin.a), level: 0 })
      take(g.x, g.z, 0.22)
    }
  }

  // --- the residents' ways: from the door and each place on the floor straight to its nearest point on the table's ring ---
  const ringPts = Array.from({ length: 12 }, (_, k) => {
    const q = (k / 12) * TAU
    return { x: table.x + Math.cos(q) * ringR, z: table.z + Math.sin(q) * ringR }
  })
  room.ringPts = ringPts
  const toRing = (x, z) => {
    let best = ringPts[0]
    for (const p of ringPts) if (Math.hypot(p.x - x, p.z - z) < Math.hypot(best.x - x, best.z - z)) best = p
    lanes.push({ x0: x, z0: z, x1: best.x, z1: best.z })
  }
  toRing(doorIn.x, doorIn.z)
  if (climb.length) toRing(climb[0].x, climb[0].z)
  for (const s of spots) {
    if (s.level !== 0 || s.kind === 'seat') continue
    const len = Math.hypot(s.lookX, s.lookZ)
    if (s.kind === 'read') toRing(s.x + (s.lookX / len) * 0.6, s.z + (s.lookZ / len) * 0.6)
    else if (s.kind === 'bed') toRing(s.x - (s.lookX / len) * (s.len / 2 + 0.25), s.z - (s.lookZ / len) * (s.len / 2 + 0.25))
    else toRing(s.x, s.z)
  }
  room.lanes = lanes

  // --- the bookcase: beside the bed in the loft, else on a free wall ---------
  {
    const w = range(0.36, 0.5), h = onLoft ? range(0.8, 0.95) : range(1.1, 1.35)
    const bc = onLoft
      ? tryWall(w, 0.3, [up, upHigh], () => range(loft.a0 + 0.2, loft.a1 - 0.2))
      : tryWall(w, 0.3, [low, high])
    if (bc) {
      items.push({ kind: 'bookcase', x: bc.x, z: bc.z, y: bc.y, yaw: bc.yaw, w: w * 2, h, d: 0.3, shelves: onLoft ? 2 : 3, seed: Math.floor(rng() * 1e6) })
      solids.push({ kind: 'box', x: bc.x, z: bc.z, yaw: bc.yaw, hx: w, hz: 0.15, y0: bc.y, y1: bc.y + Math.max(h, BLOCK) })
      if (!onLoft) { take(bc.x, bc.z, w); cover += 2 * w * 0.3 }
    }
  }

  // --- a divider: across a bed nook, or out from a free wall ----------------
  if (rng() < (loft ? 0.35 : 0.7)) {
    const kind = pick(['lattice', 'sticks', 'curtain'])
    const len = range(0.8, 1.1)
    for (let t = 0; t < 40; t++) {
      const a = !bedUp && t < 20 ? bed.a + ((t % 2 ? 1 : -1) * (bedLen / 2 + 0.2 + 0.03 * t)) / rOf(bed.a) : range(-Math.PI, Math.PI)
      if (Math.abs(angDiff(a, Math.PI)) < 0.8 || underLoft(a, 0) || !free(low, a, 0.12 / rOf(a))) continue
      const p0 = polar(a, FILLET - 0.02), p1 = polar(a, FILLET + len)
      let ok = true
      for (let s = 0.15; s <= 1 && ok; s += 0.15) ok = open(p0.x + (p1.x - p0.x) * s, p0.z + (p1.z - p0.z) * s, 0.08)
      if (!ok) continue
      low.push({ a, half: 0.12 / rOf(a) })
      const mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2, yaw = Math.atan2(-(p1.z - p0.z), p1.x - p0.x)
      for (let s = 0.2; s <= 1; s += 0.2) take(p0.x + (p1.x - p0.x) * s, p0.z + (p1.z - p0.z) * s, 0.1)
      items.push({ kind: 'divider', style: kind, x0: p0.x, z0: p0.z, x1: p1.x, z1: p1.z, h: range(1.15, 1.35), hue: range(0, 1) })
      solids.push({ kind: 'box', x: mx, z: mz, yaw, hx: len / 2 + 0.02, hz: 0.05, y0: 0, y1: 1.3 })
      break
    }
  }

  // --- the stuff of living, against the walls until the floor is about half under it ---
  const shrooms = (n, spread, y) => {
    const v = rng()
    return Array.from({ length: n }, () => ({ v, dx: range(-spread, spread), dz: range(-spread, spread), y, s: range(0.9, 1.6), yaw: range(0, TAU), tilt: range(0, 0.35), tiltA: range(0, TAU) }))
  }
  const tops = () => Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(['jar', 'crock', 'books', 'candle', 'mushpot', 'basket']))
  // Each fills a wall arc `half` either side, `depth` deep: its items and its stone.
  const FILL = {
    tools(s, half, depth) {
      // Garden tools leant on the wall, and the can and basket at their feet.
      const n = 3 + Math.floor(rng() * 3)
      for (let k = 0; k < n; k++) {
        const a = s.a + ((((k + 0.5) / n) * 2 - 1) * (half - 0.08)) / rOf(s.a)
        const foot = polar(a, FILLET + range(0.24, 0.34)), top = polar(a + range(-0.08, 0.08), FILLET * 0.4, range(0.95, 1.25))
        items.push({ kind: 'tool', tool: pick(['rake', 'spade', 'hoe', 'fork']), x0: foot.x, z0: foot.z, x1: top.x, y1: top.y, z1: top.z, twist: range(-0.4, 0.4) })
      }
      const can = polar(s.a + (range(-0.5, 0.5) * half) / rOf(s.a), FILLET + depth - 0.14)
      items.push({ kind: 'wcan', x: can.x, z: can.z, y: 0, yaw: range(0, TAU), r: 0.12, h: 0.22 })
      wallStone(s.a, half, depth)
    },
    storage(s, half, depth) {
      // Stores in two rows: barrels and crates at the back, sacks before them.
      const n = Math.max(2, Math.round((2 * half) / 0.42))
      let top = 0
      for (let k = 0; k < n; k++) {
        const a = s.a + ((((k + 0.5) / n) * 2 - 1) * (half - 0.2)) / rOf(s.a), back = polar(a, FILLET + 0.24)
        if (rng() < 0.55) {
          const h = range(0.48, 0.6)
          items.push({ kind: 'barrel', x: back.x, z: back.z, y: 0, r: 0.21, h, yaw: range(0, TAU) })
          top = Math.max(top, h)
        } else {
          const c = { kind: 'crate', x: back.x, z: back.z, y: 0, yaw: inward(a) + range(-0.25, 0.25), s: range(0.36, 0.42), stack: rng() < 0.5 ? 2 : 1 }
          items.push(c)
          top = Math.max(top, crateTop(c))
        }
        if (k % 2 === 0 || rng() < 0.4) {
          const fore = polar(a + range(-0.1, 0.1), FILLET + depth - 0.2)
          items.push({ kind: 'sack', x: fore.x, z: fore.z, y: 0, r: range(0.15, 0.19), h: range(0.28, 0.38), hue: range(0, 1), yaw: range(0, TAU) })
        }
      }
      wallStone(s.a, half, depth, 0, top)
    },
    dresser(s, half, depth) {
      const h = range(0.72, 0.9)
      items.push({ kind: 'dresser', x: s.x, z: s.z, y: s.y, yaw: s.yaw, w: half * 2 - 0.04, d: depth - 0.04, h, rows: 2 + Math.floor(rng() * 2) })
      tops().forEach((kind, k, all) => topThing(kind, s, half, depth, s.y + h, (k + 0.5) / all.length))
      wallStone(s.a, half, depth, s.y, s.y + Math.max(h, BLOCK))
    },
    chest(s, half, depth) {
      const h = range(0.34, 0.42)
      items.push({ kind: 'chest', x: s.x, z: s.z, y: s.y, yaw: s.yaw, w: half * 2 - 0.06, d: depth - 0.06, h })
      // Its lid tops out at 0.88 of `h` (render/interior.js chest).
      wallStone(s.a, half, depth, s.y, s.y + h * 0.88)
    },
    crates(s, half, depth) {
      const n = half > 0.4 ? 2 : 1
      let top = 0
      for (let k = 0; k < n; k++) {
        const a = s.a + ((((k + 0.5) / n) * 2 - 1) * (half - depth / 2)) / rOf(s.a), p = polar(a, FILLET + depth / 2)
        const c = { kind: 'crate', x: p.x, z: p.z, y: 0, yaw: inward(a) + range(-0.3, 0.3), s: depth - 0.06, stack: 1 + Math.floor(rng() * 2) }
        items.push(c)
        top = Math.max(top, crateTop(c))
      }
      wallStone(s.a, half, depth, 0, top)
    },
    woodpile(s, half, depth) {
      const rows = 3 + Math.floor(rng() * 2)
      items.push({ kind: 'woodpile', a: s.a, half, depth, rows, seed: Math.floor(rng() * 1e6) })
      wallStone(s.a, half, depth, 0, woodpileTop(rows, depth))
    },
    planter(s, half, depth) {
      const r = Math.min(half, depth / 2) - 0.02
      items.push({ kind: 'mushpot', x: s.x, z: s.z, y: s.y, r, h: r * 1.3, yaw: range(0, TAU), shrooms: shrooms(4 + Math.floor(rng() * 4), r * 0.55, r * 1.3 - 0.03) })
      wallStone(s.a, half, depth, s.y, s.y + BLOCK)
    },
    chores(s, half, depth) {
      // A broom, a bucket and a basket together.
      const broom = polar(s.a - (half - 0.1) / rOf(s.a), FILLET + 0.1)
      items.push({ kind: 'broom', x: broom.x, z: broom.z, yaw: s.yaw + range(-0.4, 0.4), r: 0.1, h: 1.0 })
      const b = polar(s.a + 0.05 / rOf(s.a), FILLET + depth / 2)
      items.push({ kind: 'bucket', x: b.x, z: b.z, yaw: range(0, TAU), r: 0.15, h: 0.24 })
      const k = polar(s.a + (half - 0.17) / rOf(s.a), FILLET + depth / 2)
      items.push({ kind: 'basket', x: k.x, z: k.z, yaw: range(0, TAU), r: 0.17, h: 0.18, hue: range(0, 1) })
      wallStone(s.a, half, depth)
    },
  }
  // A small thing on a surface `h` up, `t` of the way along it.
  const topThing = (kind, s, half, depth, h, t) => {
    const a = s.a + ((t * 2 - 1) * (half - 0.1)) / rOf(s.a), p = polar(a, FILLET + depth / 2)
    if (kind === 'candle') {
      const ch = range(0.07, 0.12)
      items.push({ kind, x: p.x, z: p.z, y: h, h: ch })
      candles.push({ x: p.x, y: h + ch + 0.035, z: p.z, i: 0.55 })
    } else if (kind === 'books') items.push({ kind, x: p.x, z: p.z, y: h, n: 2 + Math.floor(rng() * 3), yaw: range(0, TAU) })
    else if (kind === 'mushpot') items.push({ kind, x: p.x, z: p.z, y: h, r: 0.09, h: 0.1, yaw: range(0, TAU), shrooms: shrooms(2 + Math.floor(rng() * 3), 0.04, 0.08) })
    else if (kind === 'basket') items.push({ kind, x: p.x, z: p.z, y: h, yaw: range(0, TAU), r: 0.12, h: 0.12, hue: range(0, 1) })
    else items.push({ kind, x: p.x, z: p.z, y: h, h: range(0.12, 0.2), hue: range(0, 1), yaw: range(0, TAU) })
  }
  const SIZES = {
    tools: [0.32, 0.5, 0.5], storage: [0.55, 0.85, 0.8], dresser: [0.38, 0.52, 0.55], chest: [0.32, 0.45, 0.55],
    crates: [0.26, 0.52, 0.55], woodpile: [0.42, 0.62, 0.55], planter: [0.22, 0.28, 0.5], chores: [0.4, 0.48, 0.5],
  }
  // `kind` set against the wall from bearing `from` on (or anywhere, narrowing as it fails, without it): the arc it took, or 0.
  const place = (kind, lists = [low], from = null) => {
    const [lo, hi, depth] = SIZES[kind]
    for (let t = 0; t < (from === null ? 150 : 3); t++) {
      const half = range(lo, hi) * (from === null ? 1 - t / 300 : 1)
      const s = wallSpot(from === null ? range(-Math.PI, Math.PI) : from + (half + 0.03) / rOf(from), half, depth, lists)
      if (!s) continue
      FILL[kind](s, half, depth)
      return (2 * half + 0.06) / rOf(s.a)
    }
    return 0
  }
  // A corner of stores where it fits (the smallest houses' floors have no room for it) and one of garden tools in every house, then round the walls packing the rest side by side.
  place('storage')
  place('tools')
  const bag = ['dresser', 'chest', 'crates', 'woodpile', 'planter', 'chores', 'dresser', 'planter', 'crates']
  const start = range(0, TAU)
  for (let a = start; a < start + TAU && cover < FULL * floorArea;) {
    let took = 0
    for (const kind of [...bag].sort(() => rng() - 0.5)) if ((took = place(kind, [low], a))) break
    a += took || 0.06
  }
  // Then free-standing things in the floor left, heaped against the rest: the door, the ring and the lanes stay clear.
  const AROUND = 0.03
  for (let t = 0; t < 600 && cover < FULL * floorArea; t++) {
    const b = range(-Math.PI, Math.PI), d = range(0.3, rOf(b)), x = Math.cos(b) * d, z = Math.sin(b) * d
    const kind = pick(t < 300 ? ['workbench', 'workbench', 'gourds', 'sacks', 'stools', 'hamper'] : ['gourds', 'sacks', 'stools', 'hamper'])
    if (kind === 'workbench') {
      const hx = range(0.38, 0.5), hz = range(0.22, 0.27), yaw = range(0, TAU), ax = Math.cos(yaw) * (hx - hz), az = -Math.sin(yaw) * (hx - hz), r = hz * 1.42
      if (!open(x + ax, z + az, r + AROUND) || !open(x - ax, z - az, r + AROUND)) continue
      take(x + ax, z + az, r); take(x - ax, z - az, r)
      const top = range(0.44, 0.5)
      items.push({ kind: 'workbench', x, z, y: 0, yaw, hx, hz, top })
      solids.push({ kind: 'box', x, z, yaw, hx, hz, y0: 0, y1: top })
      cover += 4 * hx * hz
      const n = 2 + Math.floor(rng() * 2)
      for (let k = 0; k < n; k++) {
        const u = (((k + 0.5) / n) * 2 - 1) * (hx - 0.1), p = { x: x + Math.cos(yaw) * u, z: z - Math.sin(yaw) * u }
        const kindTop = pick(['jar', 'crock', 'mushpot', 'basket', 'books', 'candle'])
        const s = { a: Math.atan2(p.z, p.x), x: p.x, z: p.z }
        if (kindTop === 'candle') { const ch = range(0.07, 0.12); items.push({ kind: 'candle', x: p.x, z: p.z, y: top, h: ch }); candles.push({ x: p.x, y: top + ch + 0.035, z: p.z, i: 0.55 }) }
        else if (kindTop === 'mushpot') items.push({ kind: 'mushpot', x: s.x, z: s.z, y: top, r: 0.09, h: 0.1, yaw: range(0, TAU), shrooms: shrooms(2 + Math.floor(rng() * 3), 0.04, 0.08) })
        else if (kindTop === 'basket') items.push({ kind: 'basket', x: s.x, z: s.z, y: top, yaw: range(0, TAU), r: 0.12, h: 0.12, hue: range(0, 1) })
        else if (kindTop === 'books') items.push({ kind: 'books', x: s.x, z: s.z, y: top, n: 2 + Math.floor(rng() * 3), yaw: range(0, TAU) })
        else items.push({ kind: kindTop, x: s.x, z: s.z, y: top, h: range(0.12, 0.2), hue: range(0, 1), yaw: range(0, TAU) })
      }
      continue
    }
    const r = kind === 'gourds' || kind === 'sacks' ? range(0.26, 0.4) : kind === 'stools' ? 0.15 : range(0.19, 0.24)
    if (!open(x, z, r + AROUND)) continue
    take(x, z, r)
    items.push({ kind, x, z, y: 0, r, yaw: range(0, TAU), hue: range(0, 1), n: 3 + Math.floor(rng() * 4) })
    solids.push({ kind: 'cyl', x, z, r, y0: 0, y1: FREE_TOP[kind](r) })
    cover += Math.PI * r * r
  }
  // The loft's own: a chest and a planter where they fit.
  if (loft) for (const kind of ['chest', 'planter']) place(kind, [up])

  // --- above the floor: hangings and lights ------------------------------------
  if (rng() < 0.6) items.push({ kind: 'mobile', y: H - 0.35, x: table.x * 0.3, z: table.z * 0.3, n: 5 + Math.floor(rng() * 4), hue: range(0, 1) })
  if (rng() < 0.7) {
    const span = range(0.35, 0.6)
    for (let t = 0; t < 30; t++) {
      const a = range(-Math.PI, Math.PI)
      const y = (loft && inLoft(a) ? hW : Math.min(hW, loft ? yL - loft.thick : hW)) - 0.18
      if (!free(high, a, span) || (loft && inLoft(a))) continue
      high.push({ a, half: span })
      items.push({ kind: 'garland', a0: a - span, a1: a + span, y, sag: range(0.12, 0.22), n: 7 + Math.floor(rng() * 5) })
      break
    }
  }
  // Mushrooms growing from pots hung off the wall, over her head.
  const hangs = 1 + Math.floor(rng() * 2)
  for (let t = 0, got = 0; t < 40 && got < hangs; t++) {
    const a = range(-Math.PI, Math.PI)
    if (underLoft(a, 0) || !claim([high], a, 0.3)) continue
    const p = polar(a, FILLET + 0.32), y = range(1.12, Math.min(1.3, hW - 0.3))
    const hook = polar(a, 0, y + 0.42)
    items.push({ kind: 'mushhang', x: p.x, y, z: p.z, hx: hook.x, hy: hook.y, hz: hook.z, r: 0.12, h: 0.13, shrooms: shrooms(3 + Math.floor(rng() * 3), 0.06, 0.1) })
    got++
  }

  // --- sconces --------------------------------------------------------------
  const wantSconce = 2 + Math.floor(rng() * 3)
  let sconces = 0
  for (let t = 0; t < 200 && sconces < wantSconce; t++) {
    const lofted = loft !== null && sconces === 0
    const a = lofted ? range(loft.a0 + 0.3, loft.a1 - 0.3) : range(-Math.PI, Math.PI)
    const y = lofted ? yL + range(0.75, 0.9) : range(1.1, 1.3)
    if (!lofted && underLoft(a, 0)) continue
    if (!claim(lofted ? [upHigh] : [high], a, 0.25)) continue
    const p = polar(a, FILLET * 0.3 + 0.1, y)
    items.push({ kind: 'sconce', a, y, x: p.x, z: p.z })
    candles.push({ x: p.x, y: y + 0.13, z: p.z, i: 0.9 })
    sconces++
  }

  // --- the talkers: a pair on the walk round the table ------------------------
  const tq = range(0, TAU)
  const t0 = { x: table.x + Math.cos(tq) * ringR, z: table.z + Math.sin(tq) * ringR }
  const tq1 = tq + 0.9 / ringR
  const t1 = { x: table.x + Math.cos(tq1) * ringR, z: table.z + Math.sin(tq1) * ringR }
  spots.push({ kind: 'talk', x: t0.x, z: t0.z, lookX: t1.x - t0.x, lookZ: t1.z - t0.z, level: 0, pair: spots.length + 1 })
  spots.push({ kind: 'talk', x: t1.x, z: t1.z, lookX: t0.x - t1.x, lookZ: t0.z - t1.z, level: 0, pair: spots.length - 1 })

  Object.assign(room, { door, windows, stairs, climb, doorIn, items, solids, candles, spots, cover: cover / floorArea })
  return room
}

/**
 * The room as stone to the walker (walk.js addStone's contract), set down with its floor's centre at (ox, oy, oz): the wall from its foot out, the ceiling over every point, and every solid. `blockTopAt` is the top of the stone stacked up from the floor, so a teleport lands under a loft, not on it. A deck everywhere inside, so a landing by the wall is not read as a slope.
 */
export class InteriorStone {
  constructor(room, ox, oy, oz) {
    this.room = room
    this.ox = ox
    this.oy = oy
    this.oz = oz
    this.spans = new Float64Array(64)
  }

  /** Local (lx, lz)'s spans into this.spans as local [bottom, top] pairs, sorted and merged; -1 inside the wall. */
  _local(lx, lz) {
    const room = this.room, sp = this.spans
    const rho = Math.hypot(lx, lz), a = Math.atan2(lz, lx), r = rAt(room.rs, a)
    if (rho >= r - FILLET) return -1
    let n = 0
    sp[n++] = ceilingAt(room, rho, r); sp[n++] = 1e3
    for (const s of room.solids) {
      if (n >= sp.length) break
      if (!inside(s, lx, lz, rho, a, room)) continue
      sp[n++] = s.y0; sp[n++] = s.y1
    }
    // Insertion sort by bottom, then merge the overlaps.
    const k = n / 2
    for (let i = 1; i < k; i++) {
      const b = sp[i * 2], t = sp[i * 2 + 1]
      let j = i - 1
      while (j >= 0 && sp[j * 2] > b) { sp[(j + 1) * 2] = sp[j * 2]; sp[(j + 1) * 2 + 1] = sp[j * 2 + 1]; j-- }
      sp[(j + 1) * 2] = b; sp[(j + 1) * 2 + 1] = t
    }
    let m = 0
    for (let i = 0; i < k; i++) {
      const b = sp[i * 2], t = sp[i * 2 + 1]
      if (m > 0 && b <= sp[m * 2 - 1]) sp[m * 2 - 1] = Math.max(sp[m * 2 - 1], t)
      else { sp[m * 2] = b; sp[m * 2 + 1] = t; m++ }
    }
    return m
  }

  columnAt(x, z, minSize, out) {
    const m = this._local(x - this.ox, z - this.oz)
    if (m < 0) { out[0] = this.oy - 10; out[1] = this.oy + 1e3; return 1 }
    const n = Math.min(m, out.length / 2)
    for (let i = 0; i < n * 2; i++) out[i] = this.spans[i] + this.oy
    return n
  }

  blockTopAt(x, z) {
    const m = this._local(x - this.ox, z - this.oz)
    if (m < 0) return this.oy + 1e3
    let y = 0
    for (let i = 0; i < m; i++) if (this.spans[i * 2] <= y + 0.02) y = Math.max(y, this.spans[i * 2 + 1])
    return this.oy + y
  }

  deckAt(x, z) {
    const lx = x - this.ox, lz = z - this.oz
    return Math.hypot(lx, lz) < rAt(this.room.rs, Math.atan2(lz, lx)) - FILLET
  }
}

function inside(s, lx, lz, rho, a, room) {
  if (s.kind === 'cyl') return Math.hypot(lx - s.x, lz - s.z) <= s.r
  if (s.kind === 'box') {
    const dx = lx - s.x, dz = lz - s.z, c = Math.cos(s.yaw), sn = Math.sin(s.yaw)
    // The box's own axes: +X along (cos yaw, -sin yaw), +Z along (sin yaw, cos yaw).
    return Math.abs(dx * c - dz * sn) <= s.hx && Math.abs(dx * sn + dz * c) <= s.hz
  }
  // A band: bearings a0..a1, from `from` to `to` in off the wall; a loft's reach is its depth there, a rail its lip.
  const t = wrap(a - s.a0)
  if (t > s.a1 - s.a0) return false
  if (s.open && Math.abs(angDiff(a, s.open.a)) < s.open.half) return false
  const inset = rAt(room.rs, a) - rho
  if (s.loft) {
    const d = loftDepthAt(s.loft, a)
    if (d < 0.05) return false
    return s.rail ? inset <= d && inset >= d - s.rail : inset <= d
  }
  return inset >= s.from && inset <= s.to
}

/** The flat field under a room: the floor's height everywhere. */
export const flatField = (y) => ({ heightAt: () => y })
