// A town house's inside (design/38-town-interiors.md): its plan (buildings/plan.js) S times larger on the ground, board partitions cutting it into rooms, a slat stair to an upper floor under the main roof where the roof leaves headroom, each room furnished for its use, and the stone and walking grid she and the townsfolk move by. Pure, no three. Room-local metres: building-local times S, unrotated, y 0 the ground floor, the front door in the main mass's +Z wall.
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { roofHeightAt } from '../../buildings/plan.js'

export const S = 1.5
// The outer wall's thickness inside the scaled shell, and a partition's.
const T = 0.15
export const PART = 0.12
export const DOORWAY = { w: 1.1, h: 2.2 }
export const DOOR = { w: 1.25, h: 2.25 }
// The cellar stair: its well the first of `w` out from an outer wall that keeps its screen off the corner wall's windows, `len` along it, `land` of floor before its head, stone steps `rise` by `run`. Where every width meets a window it stands `slide` off the corner, its deep end boarded. She goes into the cave `fade` below the floor.
export const CELLAR = { w: [0.9, 1.05, 0.8, 1.2], len: 2.5, land: 1.0, slide: 0.6, rise: 0.2, run: 0.28, fade: 1.0 }
export const SLAB = 0.2
export const STAIR = { run: 0.26, w: 0.95 }
// Headroom a walker needs: the townsfolk run to 1.85 m, her crown (walk.js WALK.height) to 1.9.
export const HEAD = 2.0
export const RAIL_H = 1.0
// Stone for what she must not step onto -- tables, desks, rails -- stands this high whatever it looks: over her 1.2 m reach (walk.js WALK.reach), which would otherwise walk her up onto the dinner.
export const BLOCK = 1.3
export const CELL = 0.1
// The walking grid keeps this many cells of body clear of anything solid.
const BODY = 3
// A table seat's stand, out from the seat: past BODY plus a straddled cell from the chair's or bench's edge, or its anchor is never walkable and the table rolls back.
const STAND = 0.65
const CEIL_GAP = 0.12
const HEARTH = { w: 1.9, d: 0.75 }
// Raster bits: stone; floor kept clear (doorways, the hearth's front, the stair's foot); before a window (nothing tall); too low to stand; a wall band already hung or stood against.
const SOLID = 1, KEEP = 2, WIN = 4, LOW = 8, HUNG = 16

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1
export const within = (r, x, z) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1
export const grow = (r, d) => ({ x0: r.x0 - d, x1: r.x1 + d, z0: r.z0 - d, z1: r.z1 + d })
export const rect = (xa, xb, za, zb) => ({ x0: Math.min(xa, xb), x1: Math.max(xa, xb), z0: Math.min(za, zb), z1: Math.max(za, zb) })
const box = (r, y0, y1, kind) => ({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0, y1, kind })
/** The world rect of something centred at (x, z) turned by a quarter-turn `yaw`, `hx` along its own X and `hz` along its own Z. */
export const footprint = (x, z, yaw, hx, hz) => (Math.abs(Math.sin(yaw)) > 0.5 ? rect(x - hz, x + hz, z - hx, z + hx) : rect(x - hx, x + hx, z - hz, z + hz))
// A wall line: `axis` is the coordinate it runs along, `at` the other, (ix, iz) into the room. A point `d` in from it at `u` along it, and the rect from u0 to u1 and d0 to d1 in.
export const pt = (L, u, d) => (L.axis === 'x' ? { x: u, z: L.at + L.iz * d } : { x: L.at + L.ix * d, z: u })
export const strip = (L, u0, u1, d0, d1) => { const a = pt(L, u0, d0), b = pt(L, u1, d1); return rect(a.x, b.x, a.z, b.z) }
export const lines = (r) => ({
  front: { name: 'front', axis: 'x', at: r.z1, ix: 0, iz: -1, lo: r.x0, hi: r.x1, yaw: Math.PI },
  back: { name: 'back', axis: 'x', at: r.z0, ix: 0, iz: 1, lo: r.x0, hi: r.x1, yaw: 0 },
  right: { name: 'right', axis: 'z', at: r.x1, ix: -1, iz: 0, lo: r.z0, hi: r.z1, yaw: -Math.PI / 2 },
  left: { name: 'left', axis: 'z', at: r.x0, ix: 1, iz: 0, lo: r.z0, hi: r.z1, yaw: Math.PI / 2 },
})
const onLine = (o, L) => o.axis === L.axis && Math.abs(o.at - L.at) < 0.01
/** `r` less `h`, as up to four rects. */
export function minus(r, h) {
  if (!hit(r, h)) return [r]
  const out = []
  if (h.z0 > r.z0) out.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: h.z0 })
  if (h.z1 < r.z1) out.push({ x0: r.x0, x1: r.x1, z0: h.z1, z1: r.z1 })
  const z0 = Math.max(r.z0, h.z0), z1 = Math.min(r.z1, h.z1)
  if (h.x0 > r.x0) out.push({ x0: r.x0, x1: h.x0, z0, z1 })
  if (h.x1 < r.x1) out.push({ x0: h.x1, x1: r.x1, z0, z1 })
  return out
}
/** The centre nearest `prefer` of a `half`-wide opening within [lo, hi] clear of every [a, b] in `blocks`, or null. */
function freeAlong(lo, hi, half, blocks, prefer) {
  let best = null
  for (let c = lo + half; c <= hi - half + 1e-9; c += 0.05) {
    if (blocks.some(([a, b]) => c + half > a && c - half < b)) continue
    if (best === null || Math.abs(c - prefer) < Math.abs(best - prefer)) best = c
  }
  return best
}

/** The underside of the roof over room-local (x, z), less a gap: the ceiling everywhere there is no upper floor. */
export function townCeilingAt(room, x, z) {
  const plan = room.plan, px = x / S, pz = z / S
  let top = -Infinity
  for (const m of plan.masses) if (Math.abs(px - m.cx) <= m.w / 2 + 1e-6 && Math.abs(pz - m.cz) <= m.d / 2 + 1e-6) top = Math.max(top, roofHeightAt(m.roof, px, pz))
  if (top === -Infinity) throw new Error(`townCeilingAt: (${x.toFixed(2)}, ${z.toFixed(2)}) is under no roof`)
  return S * (top - plan.floorY) - CEIL_GAP
}

/** The ceiling over (x, z) from level `level`'s floor: the slab's underside on the ground floor under it, else the roof. */
export function levelCeilingAt(room, level, x, z) {
  if (level === 0 && room.upper && within(room.M, x, z) && !within(room.stair.hole, x, z)) return room.U - SLAB
  return townCeilingAt(room, x, z)
}

/** The room of level `level` holding (x, z), or null. */
export const townRoomAt = (room, level, x, z) => room.rooms.find((r) => r.level === level && within(r.rect, x, z)) || null

/**
 * The inside of the building planned as `plan`, house `index` of the world seeded `seed`, kept as a `shop` ('potions', or 'inn' for an open taproom with a bar under rows of small bedrooms) or not (null), with a stair down to a `cellar` cave or not. Everything placed is in `items` for the renderer, `solids` (axis-aligned boxes) for the stone, `candles` for the flames and the light, `spots` for the residents, and `nav` for their routes.
 */
export function rollTownInterior({ seed, index, plan, shop = null, cellar = false }) {
  if (!Number.isInteger(seed) || !Number.isInteger(index) || !plan || !Array.isArray(plan.masses)) throw new Error('rollTownInterior: needs an integer seed and index and a building plan')
  if (shop !== null && shop !== 'potions' && shop !== 'inn') throw new Error(`rollTownInterior: no shop called ${shop}`)
  const rng = mulberry32(hash32(seed, index, plan.seed | 0, 0x7041))
  const range = (lo, hi) => lo + (hi - lo) * rng()
  const pick = (list) => list[Math.floor(rng() * list.length)]
  const chance = (p) => rng() < p
  const shuffle = (list) => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [list[i], list[j]] = [list[j], list[i]] } return list }

  const main = plan.masses.find((m) => m.role === 'main')
  if (!main) throw new Error('rollTownInterior: the plan has no main mass')
  const inset = (m) => ({ x0: S * (m.cx - m.w / 2) + T, x1: S * (m.cx + m.w / 2) - T, z0: S * (m.cz - m.d / 2) + T, z1: S * (m.cz + m.d / 2) - T })
  const M = inset(main)
  const room = { town: true, seed, index, plan, kind: plan.kind, shop, M }
  const roofAt = (x, z) => townCeilingAt(room, x, z)
  const LM = lines(M)
  // The main walls by compass, as the junctions and the hearth name them.
  const MAIN = { front: LM.front, back: LM.back, east: LM.right, west: LM.left }

  // --- the masses as cells, and the board wall where each meets the main --------
  const cells = [{ role: 'main', mass: main, r: M }]
  const junctions = []
  for (const m of plan.masses) {
    if (m === main) continue
    const r = inset(m)
    let j
    if (r.x0 >= M.x1 - 0.5) {
      const P = Math.max(PART, r.x0 - M.x1)
      r.x0 = M.x1 + P
      j = { side: 'east', line: 'east', lo: Math.max(M.z0, r.z0), hi: Math.min(M.z1, r.z1), P }
      j.band = rect(M.x1, M.x1 + P, j.lo, j.hi)
    } else if (r.x1 <= M.x0 + 0.5) {
      const P = Math.max(PART, M.x0 - r.x1)
      r.x1 = M.x0 - P
      j = { side: 'west', line: 'west', lo: Math.max(M.z0, r.z0), hi: Math.min(M.z1, r.z1), P }
      j.band = rect(M.x0 - P, M.x0, j.lo, j.hi)
    } else if (r.z1 <= M.z0 + 0.5) {
      const P = Math.max(PART, M.z0 - r.z1)
      r.z1 = M.z0 - P
      j = { side: 'back', line: 'back', lo: Math.max(M.x0, r.x0), hi: Math.min(M.x1, r.x1), P }
      j.band = rect(j.lo, j.hi, M.z0 - P, M.z0)
    } else throw new Error(`rollTownInterior: a ${m.role} mass meets the main on no side the planner knows`)
    if (j.hi - j.lo < DOORWAY.w + 0.6) throw new Error(`rollTownInterior: the ${m.role} meets the main over only ${(j.hi - j.lo).toFixed(2)} m`)
    cells.push({ role: m.role, mass: m, r })
    j.cell = cells.length - 1
    junctions.push(j)
  }
  const inJunction = (L, u) => junctions.some((j) => {
    const c = cells[j.cell].r
    const along = j.side === 'back' ? (onLine(L, LM.back) || (L.axis === 'x' && Math.abs(L.at - c.z1) < 0.01)) : j.side === 'east' ? (onLine(L, LM.right) || (L.axis === 'z' && Math.abs(L.at - c.x0) < 0.01)) : (onLine(L, LM.left) || (L.axis === 'z' && Math.abs(L.at - c.x1) < 0.01))
    return along && u > j.lo - 0.6 && u < j.hi + 0.6
  })

  // --- the upper floor, if the main roof has the room for one ------------------
  const midX = (M.x0 + M.x1) / 2, midZ = (M.z0 + M.z1) / 2
  const U = clamp(0.5 * S * main.wallH, 2.8, 4.2)
  const N = Math.round(U / 0.2), rise = U / N
  const eave = Math.min(roofAt(midX, M.z1), roofAt(midX, M.z0), roofAt(M.x0, midZ), roofAt(M.x1, midZ))
  let upper = eave - U >= 1.2 && roofAt(midX, midZ) - U >= 2.6 && (M.x1 - M.x0) * (M.z1 - M.z0) >= 30 && (plan.kind !== 'hut' || chance(0.7))

  // --- the door, and the windows where the outside has them --------------------
  const dx = clamp(S * plan.door.x, M.x0 + 0.9, M.x1 - 0.9)
  const door = { x: dx, z: M.z1 + T, nx: 0, nz: 1, w: DOOR.w, h: DOOR.h, reveal: rect(dx - DOOR.w / 2, dx + DOOR.w / 2, M.z1, M.z1 + T) }
  const doorIn = { x: dx, z: M.z1 - 0.9 }
  const doorKeep = rect(dx - 0.95, dx + 0.95, M.z1 - 1.7, M.z1)
  const windows = []
  const addWindow = (r, L, u, level, y0, y1) => {
    const w = 1.1
    if (L.hi - L.lo < w + 0.6 || y1 - y0 < 0.55) return false
    u = clamp(u, L.lo + w / 2 + 0.3, L.hi - w / 2 - 0.3)
    // Upstairs, a window may stand over a junction where the wing's roof is below it.
    if (inJunction(L, u) && (level === 0 || cells.some((c) => { const q = pt(L, u, -0.6); return c.role !== 'main' && within(grow(c.r, 0.3), q.x, q.z) && roofAt(clamp(q.x, c.r.x0, c.r.x1), clamp(q.z, c.r.z0, c.r.z1)) + CEIL_GAP + 0.3 > y0 }))) return false
    if (level === 0 && onLine(L, LM.front) && Math.abs(u - dx) < DOOR.w / 2 + w / 2 + 0.25) return false
    if (windows.some((o) => o.level === level && onLine(o, L) && Math.abs(o.u - u) < w + 0.3)) return false
    const p = pt(L, u, 0)
    windows.push({ x: p.x, z: p.z, nx: -L.ix, nz: -L.iz, w, y0, y1, level, axis: L.axis, at: L.at, u })
    return true
  }
  const ups = []
  for (const w of plan.windows) {
    const c = cells.find((c) => c.mass.id === w.massId)
    if (!c) throw new Error(`rollTownInterior: window on mass ${w.massId}, which the plan does not have`)
    if (c.role === 'outshut') continue
    const L = lines(c.r)[w.side]
    if (!L) throw new Error(`rollTownInterior: window on side ${w.side}`)
    const u = L.axis === 'x' ? S * w.x : S * w.z
    if (upper && c.r === M && S * (w.y0 - plan.floorY) >= U - 0.3) { ups.push({ L, u }); continue }
    const face = pt(L, clamp(u, L.lo, L.hi), 0.05)
    addWindow(c.r, L, u, 0, 0.85, Math.min(2.3, roofAt(face.x, face.z) - 0.3))
  }

  // --- the hearth, on the chimney's gable if it fits there ---------------------
  const chimneyLine = plan.chimney.x > 0 ? MAIN.east : MAIN.west
  let hearth = null
  for (const L of [chimneyLine, chimneyLine === MAIN.east ? MAIN.west : MAIN.east, MAIN.back]) {
    const name = L === MAIN.east ? 'east' : L === MAIN.west ? 'west' : 'back'
    const prefer = L.axis === 'z' ? S * plan.chimney.z : (L.lo + L.hi) / 2
    const js = junctions.filter((j) => j.line === name)
    const cands = []
    for (let u = L.lo + HEARTH.w / 2 + 0.3; u <= L.hi - HEARTH.w / 2 - 0.3; u += 0.1) cands.push(u)
    cands.sort((a, b) => Math.abs(a - prefer) - Math.abs(b - prefer))
    for (const u of cands) {
      const body = strip(L, u - HEARTH.w / 2, u + HEARTH.w / 2, 0, HEARTH.d), keep = strip(L, u - HEARTH.w / 2 - 0.1, u + HEARTH.w / 2 + 0.1, HEARTH.d, HEARTH.d + 1.4)
      if (hit(body, doorKeep) || hit(keep, doorKeep)) continue
      if (windows.some((w) => w.level === 0 && onLine(w, L) && Math.abs(w.u - u) < HEARTH.w / 2 + w.w / 2 + 0.2)) continue
      const block = [[u - HEARTH.w / 2 - 0.3, u + HEARTH.w / 2 + 0.3]]
      if (js.some((j) => freeAlong(j.lo, j.hi, DOORWAY.w / 2 + 0.3, block, u) === null)) continue
      const fire = pt(L, u, 0.42), wall = pt(L, u, 0)
      hearth = { line: name, axis: L.axis, at: L.at, ix: L.ix, iz: L.iz, u, x: wall.x, z: wall.z, w: HEARTH.w, d: HEARTH.d, yaw: L.yaw, fire: { x: fire.x, y: 0.24, z: fire.z }, body, keep, cook: pt(L, u, HEARTH.d + 0.85) }
      break
    }
    if (hearth) break
  }
  if (!hearth) throw new Error(`rollTownInterior: no wall of house ${index} holds a hearth`)

  // --- doorways through the junction walls ---------------------------------------
  const solids = []
  const keeps = [[doorKeep, hearth.keep], []]
  const hung = [[strip(MAIN[hearth.line], hearth.u - 1.1, hearth.u + 1.1, 0, 0.5)], []]
  const anchors = [[doorIn], []]
  for (const j of junctions) {
    const L = MAIN[j.line]
    const block = hearth.line === j.line ? [[hearth.u - HEARTH.w / 2 - 0.3, hearth.u + HEARTH.w / 2 + 0.3]] : []
    const c = freeAlong(j.lo, j.hi, DOORWAY.w / 2 + 0.3, block, (j.lo + j.hi) / 2 + range(-0.8, 0.8))
    if (c === null) throw new Error(`rollTownInterior: no doorway fits the ${j.side} junction`)
    j.u = c
    j.gap = [c - DOORWAY.w / 2, c + DOORWAY.w / 2]
    const b = j.band, alongX = j.side === 'back'
    const piece = (a0, a1) => (alongX ? rect(a0, a1, b.z0, b.z1) : rect(b.x0, b.x1, a0, a1))
    solids.push(box(piece(j.lo, j.gap[0]), 0, 1e3, 'wall'), box(piece(j.gap[1], j.hi), 0, 1e3, 'wall'), box(piece(j.gap[0], j.gap[1]), DOORWAY.h, 1e3, 'wall'))
    keeps[0].push(strip(L, j.gap[0] - 0.15, j.gap[1] + 0.15, 0, 1.0))
    const far = j.side === 'east' ? { x: b.x1 + 0.6, z: c } : j.side === 'west' ? { x: b.x0 - 0.6, z: c } : { x: c, z: b.z0 - 0.6 }
    const farKeep = j.side === 'east' ? rect(b.x1, b.x1 + 1.0, j.gap[0] - 0.15, j.gap[1] + 0.15) : j.side === 'west' ? rect(b.x0 - 1.0, b.x0, j.gap[0] - 0.15, j.gap[1] + 0.15) : rect(j.gap[0] - 0.15, j.gap[1] + 0.15, b.z0 - 1.0, b.z0)
    keeps[0].push(farKeep)
    j.near = pt(L, c, 0.6)
    j.far = far
    anchors[0].push(j.near, far)
  }
  solids.push(box(door.reveal, DOOR.h, 1e3, 'wall'))
  solids.push(box(hearth.body, 0, 1e3, 'hearth'))

  // --- the stair, along the wall that takes it with headroom ---------------------
  let stair = null
  if (upper) {
    const n = N - 1, len = n * STAIR.run
    let th = 1
    while (th < n && th * rise <= U - SLAB - HEAD) th++
    let best = null
    for (const [name, L] of Object.entries(MAIN)) for (const dir of [1, -1]) {
      for (let u0 = L.lo; u0 <= L.hi; u0 += 0.2) {
        const uA = u0 - dir * 1.0, uE = u0 + dir * (len + 1.0)
        if (Math.min(uA, uE) < L.lo || Math.max(uA, uE) > L.hi) continue
        const whole = strip(L, uA, uE, 0, STAIR.w + 0.3)
        // A body's width clear of the hearth, or a landing between the chimney and the wall is shut in.
        if (keeps[0].some((k) => hit(k, whole)) || hit(grow(hearth.body, 0.7), whole)) continue
        if (windows.some((w) => w.level === 0 && onLine(w, L) && Math.abs(w.u - (uA + uE) / 2) < Math.abs(uE - uA) / 2 + w.w / 2)) continue
        let ok = true
        for (let t = th; t <= n && ok; t++) {
          const uc = u0 + dir * (t - 0.5) * STAIR.run
          for (const d of [0.1, STAIR.w - 0.1]) { const p = pt(L, uc, d); if (roofAt(p.x, p.z) < t * rise + HEAD) ok = false }
        }
        // At `top`, where she steps off and the upper floor's reach starts.
        for (const d of [0.1, STAIR.w - 0.1]) { const p = pt(L, u0 + dir * (len + 0.6), d); if (roofAt(p.x, p.z) < U + HEAD) ok = false }
        if (!ok) continue
        const score = { back: 0, east: 1, west: 1, front: 2 }[name] + rng() * 0.8
        if (best === null || score < best.score) best = { name, L, dir, u0, score }
      }
    }
    if (best === null) upper = false
    else {
      const { name, L, dir, u0 } = best
      const treads = []
      for (let t = 1; t <= n; t++) {
        const r = strip(L, u0 + dir * (t - 1) * STAIR.run, u0 + dir * t * STAIR.run, 0, STAIR.w)
        treads.push({ ...r, top: t * rise })
        solids.push(box(r, 0, t * rise, 'tread'))
      }
      // Open from her body's radius short of tread th, or her capsule on it still meets the slab's edge behind her.
      const hA = u0 + dir * Math.max(0, (th - 1) * STAIR.run - 0.4), hE = u0 + dir * len
      const hole = strip(L, hA, hE, 0, STAIR.w + 0.05)
      const rails = [strip(L, hA, hE, STAIR.w + 0.05, STAIR.w + 0.11), strip(L, hA - dir * 0.06, hA, 0, STAIR.w + 0.11)]
      for (const r of rails) solids.push(box(r, U, U + BLOCK, 'rail'))
      const bottom = pt(L, u0 - dir * 0.6, STAIR.w / 2), top = pt(L, u0 + dir * (len + 0.6), STAIR.w / 2)
      const steps = treads.map((t, i) => ({ ...pt(L, u0 + dir * (i + 0.5) * STAIR.run, STAIR.w / 2), y: t.top }))
      stair = { line: name, axis: L.axis, at: L.at, ix: L.ix, iz: L.iz, dir, u0, run: STAIR.run, rise, n, w: STAIR.w, th, treads, hole, rails, bottom, top, steps }
      keeps[0].push(strip(L, u0 - dir * 1.0, u0, 0, STAIR.w + 0.2))
      keeps[1].push(strip(L, hE, hE + dir * 1.0, 0, STAIR.w + 0.2))
      hung[0].push(strip(L, u0, hE, 0, 0.5))
      hung[1].push(grow(hole, 0.12), strip(L, hE, hE + dir * 1.0, 0, 0.5))
      anchors[0].push(bottom)
      anchors[1].push(top)
      for (const r of minus(M, hole)) solids.push(box(r, U - SLAB, U, 'slab'))
    }
  }
  room.upper = upper
  room.U = upper ? U : null
  room.stair = stair
  if (upper) {
    for (const { L, u } of ups) {
      const face = pt(L, clamp(u, L.lo, L.hi), 0.05)
      addWindow(M, L, u, 1, U + 0.65, Math.min(U + 1.75, roofAt(face.x, face.z) - 0.25))
    }
    // The chimney rises through the upper floor.
    hung[1].push(strip(MAIN[hearth.line], hearth.u - 1.1, hearth.u + 1.1, 0, 0.5))
  }

  // --- the rooms, one a cell and floor until the partitions cut them ------------
  const rooms = []
  const addRoom = (level, r, role) => rooms.push({ id: rooms.length, level, floor: level ? U : 0, rect: r, role, kind: null })
  for (const level of upper ? [0, 1] : [0]) addRoom(level, { ...M }, 'main')
  for (const c of cells) if (c.role !== 'main') addRoom(0, c.r, c.role)
  const roomAt = (level, x, z) => {
    const r = townRoomAt({ rooms }, level, x, z)
    if (!r) throw new Error(`rollTownInterior: no room at (${x.toFixed(2)}, ${z.toFixed(2)}) on level ${level}`)
    return r
  }

  // --- the floor as rasters, one per level ---------------------------------------
  const floorRects = [[M, ...cells.slice(1).map((c) => c.r), ...junctions.map((j) => j.band)], upper ? [M] : []]
  const all = floorRects[0]
  const X0 = Math.min(...all.map((r) => r.x0)) - 0.3, X1 = Math.max(...all.map((r) => r.x1)) + 0.3
  const Z0 = Math.min(...all.map((r) => r.z0)) - 0.3, Z1 = Math.max(...all.map((r) => r.z1)) + 0.3
  const nx = Math.ceil((X1 - X0) / CELL), nz = Math.ceil((Z1 - Z0) / CELL)
  const levels = upper ? [0, 1] : [0]
  const floors = levels.map((l) => (l ? U : 0))
  const grids = levels.map(() => new Uint8Array(nx * nz).fill(SOLID))
  const over = (r, fn) => {
    const i0 = Math.max(0, Math.floor((r.x0 - X0) / CELL)), i1 = Math.min(nx - 1, Math.ceil((r.x1 - X0) / CELL) - 1)
    const k0 = Math.max(0, Math.floor((r.z0 - Z0) / CELL)), k1 = Math.min(nz - 1, Math.ceil((r.z1 - Z0) / CELL) - 1)
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (fn(k * nx + i) === false) return false
    return true
  }
  const mark = (level, r, bit) => over(r, (c) => { grids[level][c] |= bit })
  const clear = (level, r, mask) => over(r, (c) => (grids[level][c] & mask) === 0)
  const cellOf = (x, z) => {
    const i = Math.floor((x - X0) / CELL), k = Math.floor((z - Z0) / CELL)
    return i < 0 || k < 0 || i >= nx || k >= nz ? -1 : k * nx + i
  }
  for (const level of levels) {
    const g = grids[level]
    for (const r of floorRects[level]) {
      const i0 = Math.ceil((r.x0 - X0) / CELL - 0.5), i1 = Math.floor((r.x1 - X0) / CELL - 0.5)
      const k0 = Math.ceil((r.z0 - Z0) / CELL - 0.5), k1 = Math.floor((r.z1 - Z0) / CELL - 0.5)
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) g[k * nx + i] = 0
    }
  }
  const rasterSolid = (s) => { for (const level of levels) if (s.y0 < floors[level] + HEAD && s.y1 > floors[level] + 0.05) mark(level, s, SOLID) }
  for (const s of solids) rasterSolid(s)
  if (upper) mark(1, stair.hole, SOLID)
  for (const level of levels) {
    const g = grids[level]
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const c = k * nx + i
      if (g[c] & SOLID) continue
      if (levelCeilingAt(room, level, X0 + (i + 0.5) * CELL, Z0 + (k + 0.5) * CELL) - floors[level] < HEAD) g[c] |= LOW
    }
    for (const r of keeps[level]) mark(level, r, KEEP)
    for (const r of hung[level]) mark(level, r, HUNG)
  }

  /** Level `level`'s walking grid: 1 where a body fits clear of stone under headroom. */
  const walkable = (level) => {
    const g = grids[level], sum = new Int32Array((nx + 1) * (nz + 1)), out = new Uint8Array(nx * nz)
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) sum[(k + 1) * (nx + 1) + i + 1] = (g[k * nx + i] & SOLID ? 1 : 0) + sum[k * (nx + 1) + i + 1] + sum[(k + 1) * (nx + 1) + i] - sum[k * (nx + 1) + i]
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      if (g[k * nx + i] & LOW) continue
      const a = Math.max(0, i - BODY), b = Math.min(nx, i + BODY + 1), c = Math.max(0, k - BODY), d = Math.min(nz, k + BODY + 1)
      if (sum[d * (nx + 1) + b] - sum[c * (nx + 1) + b] - sum[d * (nx + 1) + a] + sum[c * (nx + 1) + a] === 0) out[k * nx + i] = 1
    }
    return out
  }
  const flood = (w, from) => {
    const seen = new Uint8Array(nx * nz), q = new Int32Array(nx * nz)
    const s = cellOf(from.x, from.z)
    if (s < 0 || !w[s]) return seen
    let head = 0, tail = 0
    q[tail++] = s
    seen[s] = 1
    while (head < tail) {
      const c = q[head++], i = c % nx
      for (const [d, ok] of [[1, i + 1 < nx], [-1, i > 0], [nx, c + nx < nx * nz], [-nx, c >= nx]]) {
        if (!ok) continue
        const e = c + d
        if (w[e] && !seen[e]) { seen[e] = 1; q[tail++] = e }
      }
    }
    return seen
  }
  // An anchor with `r` is met by any reached cell within r of it.
  const reaches = (level) => {
    const seen = flood(walkable(level), anchors[level][0])
    return anchors[level].every((a) => {
      if (!a.r) return seen[cellOf(a.x, a.z)] === 1
      const n = Math.ceil(a.r / CELL), i0 = Math.floor((a.x - X0) / CELL), k0 = Math.floor((a.z - Z0) / CELL)
      for (let k = Math.max(0, k0 - n); k <= Math.min(nz - 1, k0 + n); k++) for (let i = Math.max(0, i0 - n); i <= Math.min(nx - 1, i0 + n); i++) {
        if (seen[k * nx + i] && Math.hypot(i - i0, k - k0) * CELL <= a.r) return true
      }
      return false
    })
  }
  for (const level of levels) if (!reaches(level)) throw new Error(`rollTownInterior: house ${index}'s level ${level} is cut in two before it is furnished`)

  // --- partitions: board walls cutting a room in two, each with a doorway ---------
  const partitions = []
  const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0)
  // The walls of rect `R` on `level` that are its mass's outside walls, and whether a window could stand at `u` along one.
  const outside = (level, R) => {
    const c = level === 1 ? cells[0] : cells.find((c) => within(c.r, (R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2))
    const outer = lines(c.r)
    return { c, edges: Object.values(lines(R)).filter((e) => Math.abs(e.at - outer[e.name].at) < 0.01) }
  }
  const glassAt = (level, e, u) => u >= e.lo + 0.85 && u <= e.hi - 0.85 && !inJunction(e, u) && !(level === 0 && onLine(e, LM.front) && Math.abs(u - dx) < DOOR.w / 2 + 0.8) && clear(level, strip(e, u - 0.65, u + 0.65, CELL, 0.5), SOLID | HUNG)
  const glazable = (level, R) => outside(level, R).edges.some((e) => windows.some((w) => w.level === level && onLine(w, e) && w.u > e.lo && w.u < e.hi) || Array.from({ length: Math.floor((e.hi - e.lo) / 0.1) }, (_, i) => e.lo + i * 0.1).some((u) => glassAt(level, e, u)))
  const cut = (rm, axis, q) => {
    const level = rm.level, f = rm.floor, R = rm.rect
    const L = { axis, at: q, ix: +(axis === 'z'), iz: +(axis === 'x') }
    const [lo, hi] = axis === 'x' ? [R.x0, R.x1] : [R.z0, R.z1]
    const wall = (u0, u1, d) => strip(L, u0, u1, -d, d)
    const A = axis === 'x' ? { ...R, z1: q - PART / 2 } : { ...R, x1: q - PART / 2 }
    const B = axis === 'x' ? { ...R, z0: q + PART / 2 } : { ...R, x0: q + PART / 2 }
    // The hall keeps the width for its table.
    if ([A, B].some((h) => within(h, doorIn.x, doorIn.z) && Math.min(h.x1 - h.x0, h.z1 - h.z0) < 3.4)) return false
    if (glazable(level, R) && !(glazable(level, A) && glazable(level, B))) return false
    if (!clear(level, wall(lo + 0.15, hi - 0.15, PART / 2 + 0.15), SOLID | KEEP)) return false
    // A wall meeting the outside wall beside a window.
    if (windows.some((w) => w.level === level && w.axis !== axis && (Math.abs(w.at - lo) < 0.01 || Math.abs(w.at - hi) < 0.01) && Math.abs(w.u - q) < w.w / 2 + 0.25)) return false
    const us = []
    for (let u = lo + 0.9; u <= hi - 0.9; u += 0.1) {
      if (!clear(level, wall(u - 0.7, u + 0.7, 1.0), SOLID)) continue
      const a = pt(L, u - DOORWAY.w / 2, 0), b = pt(L, u + DOORWAY.w / 2, 0)
      if (Math.min(levelCeilingAt(room, level, a.x, a.z), levelCeilingAt(room, level, b.x, b.z)) < f + DOORWAY.h + 0.15) continue
      us.push(u)
    }
    if (!us.length) return false
    const u = pick(us), gap = [u - DOORWAY.w / 2, u + DOORWAY.w / 2]
    const top = level === 0 && upper && rm.role === 'main' ? U - SLAB : 1e3
    const ns = solids.length, na = anchors[level].length, g = grids[level].slice()
    for (const [a, b, y0] of [[lo, gap[0], f], [gap[1], hi, f], [gap[0], gap[1], f + DOORWAY.h]]) { const s = box(wall(a, b, PART / 2), y0, top, 'wall'); solids.push(s); rasterSolid(s) }
    mark(level, wall(gap[0] - 0.15, gap[1] + 0.15, 1.0), KEEP)
    anchors[level].push(pt(L, u, -0.6), pt(L, u, 0.6))
    const seen = reaches(level) && flood(walkable(level), anchors[level][0])
    const count = (r) => { let n = 0; over(r, (c) => { n += seen[c] }); return n }
    if (!seen || count(A) < 200 || count(B) < 200) {
      solids.length = ns; anchors[level].length = na; grids[level].set(g)
      return false
    }
    partitions.push({ level, axis, at: q, lo, hi, gap, y0: f, y1: top })
    rm.rect = A
    rooms.push({ ...rm, id: rooms.length, rect: B })
    return true
  }
  // Rooms of about 15 to 30 m²; upstairs, cut only across the ridge, so each room keeps a stretch of gable or full-height wall. An inn's taproom (its main ground room) stays whole and its upstairs is cut as small as a bed allows.
  const taproom = shop === 'inn' ? rooms.find((r) => r.level === 0 && r.role === 'main') : null
  for (let i = 0; i < rooms.length; i++) {
    const rm = rooms[i]
    for (;;) {
      const R = rm.rect, wx = R.x1 - R.x0, wz = R.z1 - R.z0
      const axes = rm === taproom ? [] : rm.level === 1 ? (wx >= (shop === 'inn' ? 4.8 + PART : 5.6) ? ['z'] : []) : area(R) >= 30 ? (wx >= wz ? ['z', 'x'] : ['x', 'z']) : []
      let done = false
      for (const axis of axes) {
        const [a0, a1] = axis === 'z' ? [R.x0, R.x1] : [R.z0, R.z1], mid = (a0 + a1) / 2
        const qs = []
        for (let q = a0 + 2.4 + PART / 2; q <= a1 - 2.4 - PART / 2; q += 0.1) qs.push({ q, s: Math.abs(q - mid) + range(0, 0.6) })
        qs.sort((a, b) => a.s - b.s)
        // An inn tries every line: the 40 nearest the middle can all meet its stair and chimney.
        if (qs.slice(0, shop === 'inn' ? qs.length : 40).some(({ q }) => cut(rm, axis, q))) { done = true; break }
      }
      if (!done) break
    }
  }

  // --- what each room is for, and the doorways between them ------------------------
  const hall = roomAt(0, doorIn.x, doorIn.z)
  const kitchen = roomAt(0, hearth.cook.x, hearth.cook.z)
  hall.kind = 'hall'
  kitchen.kind = kitchen === hall ? 'hall' : 'kitchen'
  hall.hearth = kitchen === hall
  kitchen.hearth = true
  for (const r of rooms) {
    if (r.kind) continue
    // An inn lets every room off the taproom, downstairs too when it has no upper floor.
    if (r.level === 1 || (shop === 'inn' && !upper && r.role !== 'outshut')) r.kind = shop === 'inn' || chance(0.8) ? 'bedroom' : 'workroom'
    else if (r.role === 'outshut') r.kind = chance(0.6) ? 'store' : 'workroom'
    else if (r.role === 'wing') r.kind = upper ? pick(['parlour', 'workroom', 'parlour', 'bedroom']) : pick(['bedroom', 'bedroom', 'workroom', 'parlour'])
    else r.kind = upper ? pick(['parlour', 'workroom', 'parlour']) : pick(['bedroom', 'parlour', 'workroom'])
  }
  if (!rooms.some((r) => r.kind === 'bedroom')) {
    const spare = rooms.find((r) => r.level === 1) || rooms.find((r) => r.kind !== 'hall' && r.kind !== 'kitchen')
    if (spare) spare.kind = 'bedroom'
  }
  hearth.room = kitchen.id

  const doorways = []
  for (const j of junctions) {
    const b = j.band, alongX = j.side === 'back'
    doorways.push({ level: 0, y0: 0, y1: DOORWAY.h, a: roomAt(0, j.near.x, j.near.z).id, b: roomAt(0, j.far.x, j.far.z).id, ...(alongX ? rect(j.gap[0], j.gap[1], b.z0, b.z1) : rect(b.x0, b.x1, j.gap[0], j.gap[1])) })
  }
  for (const p of partitions) {
    const L = { axis: p.axis, at: p.at, ix: +(p.axis === 'z'), iz: +(p.axis === 'x') }, c = (p.gap[0] + p.gap[1]) / 2
    const a = pt(L, c, -0.4), b = pt(L, c, 0.4)
    doorways.push({ level: p.level, y0: p.y0, y1: p.y0 + DOORWAY.h, a: roomAt(p.level, a.x, a.z).id, b: roomAt(p.level, b.x, b.z).id, ...strip(L, p.gap[0], p.gap[1], -PART / 2, PART / 2) })
  }

  // --- more windows, so few rooms are lit by candles alone; upstairs the gable rooms first ---
  for (const rm of rooms) {
    const { c, edges } = outside(rm.level, rm.rect)
    if (rm.level === 1) edges.sort((a, b) => (a.axis === 'z' ? 0 : 1) - (b.axis === 'z' ? 0 : 1))
    let open = 0
    for (const e of edges) for (let u = e.lo + 0.05; u < e.hi; u += 0.1) if (!inJunction(e, u)) open += 0.1
    const want = Math.max(1, Math.round(open / 5))
    const has = (e) => windows.filter((w) => w.level === rm.level && within(grow(rm.rect, 0.05), w.x, w.z) && (!e || onLine(w, e))).length
    for (const e of edges) {
      const len = e.hi - e.lo, n = Math.max(1, Math.round(len / 4))
      for (let i = 0; i < n; i++) {
        if (has() >= want && !(rm.level === 1 && e.axis === 'z' && has(e) === 0)) break
        const base = e.lo + (len * (i + 0.5)) / n
        for (const o of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
          const u = base + o
          if (!glassAt(rm.level, e, u)) continue
          const face = pt(e, u, 0.05), roof = levelCeilingAt(room, rm.level, face.x, face.z)
          const [y0, y1] = rm.level === 1 ? (() => { const y1 = Math.min(U + 1.75, roof - 0.25); return [Math.max(U + 0.45, y1 - 1.1), y1] })() : [0.85, Math.min(2.3, roof - 0.3)]
          if (addWindow(c.r, e, u, rm.level, y0, y1)) break
        }
      }
    }
  }
  for (const w of windows) {
    w.room = roomAt(w.level, w.x - w.nx * 0.3, w.z - w.nz * 0.3).id
    mark(w.level, strip({ axis: w.axis, at: w.at, ix: -w.nx, iz: -w.nz }, w.u - w.w / 2 - 0.1, w.u + w.w / 2 + 0.1, 0, 0.7), WIN)
  }
  // Each room's reachable cell nearest its middle joins the anchors, met within a table's walkway of it, so no furniture walls a room off from the door or the stair.
  for (const level of levels) {
    const seen = flood(walkable(level), anchors[level][0])
    for (const rm of rooms.filter((r) => r.level === level)) {
      const cx = (rm.rect.x0 + rm.rect.x1) / 2, cz = (rm.rect.z0 + rm.rect.z1) / 2
      let best = null, bd = Infinity
      for (let c = 0; c < nx * nz; c++) {
        if (!seen[c]) continue
        const x = X0 + ((c % nx) + 0.5) * CELL, z = Z0 + (Math.floor(c / nx) + 0.5) * CELL, d = Math.hypot(x - cx, z - cz)
        if (d < bd && within(rm.rect, x, z)) { bd = d; best = { x, z, r: 1.8 } }
      }
      if (!best) throw new Error(`rollTownInterior: room ${rm.id} (${rm.kind}) of house ${index} cannot be walked into`)
      anchors[level].push(best)
    }
  }

  // --- the cellar stair (design/38 Cellar): a well along an outer wall running down into a ground room's corner, as far from the front door as fits, screened from the room by a board wall so it shows only from its head. Its own rng, so a house without one rolls as it always did.
  room.cellar = null
  if (cellar) {
    const crng = mulberry32(hash32(seed, index, 0xce11))
    const { len, land } = CELLAR
    const cands = []
    for (const rm of rooms) {
      if (rm.level !== 0) continue
      for (const e of outside(0, rm.rect).edges) for (const s of [-1, 1]) {
        corner: for (const off of [0, CELLAR.slide]) for (const W of CELLAR.w) {
          if (e.hi - e.lo < len + land + 0.2 + off) break corner
          const [u0, u1] = s < 0 ? [e.lo + off, e.lo + off + len] : [e.hi - off - len, e.hi - off], top = s < 0 ? u1 : u0, deep = s < 0 ? u0 : u1
          const hole = strip(e, u0, u1, 0, W), screen = strip(e, u0, u1, W, W + PART), head = strip(e, top, top - s * land, 0, W)
          const cap = off > 0 ? strip(e, deep, deep + s * PART, 0, W + PART) : null
          if (cap && !clear(0, grow(cap, -CELL), SOLID | KEEP)) continue
          if (!clear(0, grow(hole, -CELL), SOLID | KEEP | LOW) || !clear(0, grow(hole, 0.3), KEEP) || !clear(0, strip(e, u0 + 0.3, u1 - 0.3, W - 0.15, W + PART + 0.15), SOLID | KEEP) || !clear(0, grow(head, -CELL), SOLID | LOW)) continue
          const mid = pt(e, deep, W + PART / 2)
          if (!cap && windows.some((w) => w.level === 0 && w.axis !== e.axis && Math.abs(w.at - deep) < 0.01 && Math.abs(w.u - (e.axis === 'x' ? mid.z : mid.x)) < w.w / 2 + 0.25)) continue
          let open = true
          for (let u = Math.min(u0, top - s * land); u <= Math.max(u1, top - s * land) && open; u += 0.1) open = !inJunction(e, u)
          if (!open) continue
          const c = pt(e, (u0 + u1) / 2, W / 2)
          cands.push({ rm, e, s, W, u0, u1, top, deep, hole, screen, cap, score: -Math.hypot(c.x - doorIn.x, c.z - doorIn.z) + crng() * 0.5 })
          break corner
        }
      }
    }
    cands.sort((p, q) => p.score - q.score)
    for (const { rm, e, s, W, u0, u1, top, deep, hole, screen, cap } of cands) {
      const g = grids[0].slice(), ns = solids.length, inn = pt(e, top - s * 0.6, W / 2)
      const y1 = upper && rm.role === 'main' ? U - SLAB : 1e3
      mark(0, hole, SOLID)
      const wall = box(screen, 0, y1, 'wall')
      solids.push(wall); rasterSolid(wall)
      if (cap) { const b = box(cap, 0, y1, 'wall'); solids.push(b); rasterSolid(b) }
      anchors[0].push(inn)
      if (!reaches(0)) { anchors[0].pop(); solids.length = ns; grids[0].set(g); continue }
      mark(0, strip(e, top - s * (land + 0.3), top, 0, W + 0.3), KEEP)
      mark(0, strip(e, u0, u1, 0, 0.5), HUNG)
      const edge = pt(e, top, W / 2)
      room.cellar = { axis: e.axis, at: e.at, ix: e.ix, iz: e.iz, u0, u1, top, w: W, hole, screen: { axis: e.axis, at: e.axis === 'x' ? (screen.z0 + screen.z1) / 2 : (screen.x0 + screen.x1) / 2, lo: Math.min(u0, cap ? deep + s * PART : u0), hi: Math.max(u1, cap ? deep + s * PART : u1), y1 }, cap: cap && { u: deep }, x: edge.x, z: edge.z, nx: e.axis === 'x' ? s : 0, nz: e.axis === 'x' ? 0 : s, in: inn }
      break
    }
    if (room.cellar === null) throw new Error(`rollTownInterior: no ground-floor corner of house ${index} takes its cellar stair`)
  }

  // --- furnishing ------------------------------------------------------------------
  const items = [], candles = [], spots = []
  let depth = 0
  const tx = (level, fn) => {
    const g = grids[level].slice(), ni = items.length, ns = solids.length, nc = candles.length, np = spots.length, na = anchors[level].length
    depth++
    const ok = fn() !== false && reaches(level)
    depth--
    if (ok) return true
    grids[level].set(g)
    items.length = ni; solids.length = ns; candles.length = nc; spots.length = np; anchors[level].length = na
    return false
  }
  // A place a resident goes stays reachable from then on: inside a tx the tx's own reach test takes it or rolls it back; outside, only one she can reach now is held.
  const hold = (level, p) => {
    if (depth > 0 || flood(walkable(level), anchors[level][0])[cellOf(p.x, p.z)] === 1) anchors[level].push(p)
  }
  // Something standing on the floor: drawn as `item`, stone over `r` to `top` above the floor, floor kept clear over `keep`, its wall band hung if tall.
  const put = (rm, item, r, top, { keep = null, band = null } = {}) => {
    item.y = rm.floor
    item.room = rm.id
    items.push(item)
    const s = box(r, rm.floor, rm.floor + top, item.kind)
    solids.push(s)
    rasterSolid(s)
    mark(rm.level, r, SOLID)
    if (keep) mark(rm.level, keep, KEEP)
    if (band) mark(rm.level, band, HUNG)
  }
  const thing = (rm, kind, x, y, z, extra = {}) => items.push({ kind, x, y, z, room: rm.id, yaw: range(0, 2 * Math.PI), hue: rng(), ...extra })
  const candle = (rm, x, y, z, holder, i = 0.8) => {
    const h = range(0.1, 0.17)
    items.push({ kind: 'candle', x, y, z, h, holder, room: rm.id })
    candles.push({ x, y: y + h + (holder === 'stick' ? 0.2 : 0.04), z, i, room: rm.id, level: rm.level })
  }
  const seat = (rm, x, z, top, look, stand, kind = 'seat') => {
    spots.push({ kind, x, z, top: rm.floor + top, r: 0.22, lookX: look[0], lookZ: look[1], standX: stand.x, standZ: stand.z, level: rm.level, room: rm.id })
    hold(rm.level, stand)
  }
  const edgesOf = (rm) => Object.values(lines(rm.rect))

  /** Places along `rm`'s walls for something `hx` wide and `hz` deep with its back to the wall, kept clear `front` before it. */
  const atWall = (rm, hx, hz, { front = 0.7, tall = false, gap = 0.02 } = {}) => {
    const out = []
    const mask = SOLID | KEEP | (tall ? WIN | HUNG : 0)
    for (const e of edgesOf(rm)) {
      for (let u = e.lo + hx + 0.05; u <= e.hi - hx - 0.05; u += 0.1) {
        const c = pt(e, u, hz + gap), r = footprint(c.x, c.z, e.yaw, hx, hz)
        // Tested from a cell off the wall: a wall falling mid-cell rasters the cell it straddles solid, which would shut the whole wall.
        if (!clear(rm.level, strip(e, u - hx, u + hx, CELL, 2 * hz + gap), mask)) continue
        const fr = front > 0 ? strip(e, u - hx, u + hx, 2 * hz + gap, 2 * hz + gap + front) : null
        if (fr && !clear(rm.level, fr, SOLID)) continue
        out.push({ x: c.x, z: c.z, yaw: e.yaw, r, front: fr, e, u, band: strip(e, u - hx, u + hx, 0, 0.5) })
      }
    }
    return out
  }
  const ceilOver = (rm, r) => Math.min(...[[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]].map(([x, z]) => levelCeilingAt(room, rm.level, clamp(x, rm.rect.x0, rm.rect.x1), clamp(z, rm.rect.z0, rm.rect.z1)))) - rm.floor
  const standing = (rm, kind, hx, hz, top, extra = {}, opts = {}) => {
    const cands = shuffle(atWall(rm, hx, hz, { tall: top > 1, ...opts })).filter((c) => ceilOver(rm, c.r) > top + 0.15)
    for (const c of cands.slice(0, 12)) {
      const item = { kind, x: c.x, z: c.z, yaw: c.yaw, hx, hz, top, hue: rng(), ...extra }
      if (tx(rm.level, () => put(rm, item, c.r, top > 1 ? top : top, { keep: c.front, band: top > 1 ? c.band : null }))) return { item, c }
    }
    return null
  }
  const corner = (rm, kind, half, top, extra = {}) => {
    const R = rm.rect, cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2
    for (const [sx, sz] of shuffle([[-1, -1], [1, -1], [-1, 1], [1, 1]])) {
      const x = sx < 0 ? R.x0 + half + 0.1 : R.x1 - half - 0.1, z = sz < 0 ? R.z0 + half + 0.1 : R.z1 - half - 0.1
      const r = rect(x - half, x + half, z - half, z + half)
      const yaw = Math.atan2(-sx, -sz)
      const front = rect(x - sx * (half + 0.7) - 0.35, x - sx * (half + 0.7) + 0.35, z - sz * (half + 0.7) - 0.35, z - sz * (half + 0.7) + 0.35)
      if (!clear(rm.level, r, SOLID | KEEP) || !clear(rm.level, front, SOLID) || ceilOver(rm, r) < 1.6) continue
      const item = { kind, x, z, yaw, hx: half, hz: half, top, hue: rng(), ...extra }
      if (tx(rm.level, () => put(rm, item, r, top, { keep: front }))) return { item, look: [-sx / Math.SQRT2, -sz / Math.SQRT2] }
    }
    return null
  }
  const loose = (rm, kind, half, top, extra = {}, mask = SOLID | KEEP) => {
    const R = rm.rect
    for (let t = 0; t < 40; t++) {
      const x = range(R.x0 + half + 0.05, R.x1 - half - 0.05), z = range(R.z0 + half + 0.05, R.z1 - half - 0.05)
      const r = rect(x - half, x + half, z - half, z + half)
      if (!clear(rm.level, grow(r, 0.05), mask) || ceilOver(rm, r) < top + 0.3) continue
      const item = { kind, x, z, yaw: range(0, 2 * Math.PI), r: half, top, hue: rng(), ...extra }
      if (tx(rm.level, () => put(rm, item, r, top))) return item
    }
    return null
  }
  // Something heavy tucked into the floor along a wall or in a corner: barrels, crates, sacks.
  const tucked = (rm, kind, half, top, extra = {}) => {
    const cands = shuffle(atWall(rm, half, half, { front: 0.4 }))
    for (const c of cands.slice(0, 10)) {
      const item = { kind, x: c.x, z: c.z, yaw: c.yaw + range(-0.4, 0.4), r: half, top, hue: rng(), ...extra }
      if (tx(rm.level, () => put(rm, item, c.r, top))) return item
    }
    return null
  }
  const SHELF_LOAD = {
    hall: ['plate', 'plate', 'mug', 'jug', 'bowl'],
    kitchen: ['pot', 'jar', 'jar', 'bowl', 'crock'],
    workroom: ['books', 'scroll', 'books', 'inkpot', 'jar'],
    store: ['jar', 'jar', 'crock', 'crock'],
    bedroom: ['books', 'candle', 'box', 'jug'],
    parlour: ['books', 'jug', 'box', 'plate'],
    potions: ['potion', 'potion', 'potion', 'jar', 'potion'],
    inn: ['mug', 'mug', 'jug', 'mug', 'crock'],
  }
  const shelf = (rm, hx = range(0.45, 0.7), stock = rm.kind) => {
    for (const e of shuffle(edgesOf(rm))) {
      for (const u of shuffle(Array.from({ length: Math.max(0, Math.floor((e.hi - e.lo - 2 * hx - 0.6) / 0.2)) }, (_, i) => e.lo + hx + 0.3 + i * 0.2))) {
        const band = strip(e, u - hx, u + hx, 0, 0.4)
        if (!clear(rm.level, band, WIN | HUNG | KEEP)) continue
        const y = rm.floor + range(1.35, 1.6)
        const wallTop = levelCeilingAt(room, rm.level, pt(e, u, 0.1).x, pt(e, u, 0.1).z)
        if (wallTop < y + 0.5) continue
        const at = pt(e, u, 0.13), load = []
        const kinds = SHELF_LOAD[stock] || SHELF_LOAD.parlour
        for (let s = -hx + 0.1; s < hx - 0.08; s += range(0.14, 0.24)) load.push({ kind: pick(kinds), u: s, hue: rng(), yaw: range(-0.4, 0.4) })
        items.push({ kind: 'shelf', x: at.x, y, z: at.z, yaw: e.yaw, hx, hz: 0.13, load, room: rm.id })
        // A load's `u` runs along the shelf's own X, (cos yaw, -sin yaw), which is not always the wall's `u`.
        if (load.some((l) => l.kind === 'candle')) { const l = load.find((l) => l.kind === 'candle'); l.kind = 'gap'; candle(rm, at.x + l.u * Math.cos(e.yaw), y + 0.03, at.z - l.u * Math.sin(e.yaw), 'dish', 0.6) }
        mark(rm.level, band, HUNG)
        return true
      }
    }
    return false
  }
  const sconce = (rm) => {
    for (const e of shuffle(edgesOf(rm))) {
      for (let t = 0; t < 12; t++) {
        const u = range(e.lo + 0.4, e.hi - 0.4), band = strip(e, u - 0.2, u + 0.2, 0, 0.4)
        if (!clear(rm.level, band, WIN | HUNG | KEEP)) continue
        const at = pt(e, u, 0.12), y = Math.min(rm.floor + 1.75, levelCeilingAt(room, rm.level, at.x, at.z) - 0.5)
        if (y < rm.floor + 1.1) continue
        items.push({ kind: 'sconce', x: at.x, y, z: at.z, yaw: e.yaw, room: rm.id })
        candles.push({ x: at.x, y: y + 0.24, z: at.z, i: 0.9, room: rm.id, level: rm.level })
        mark(rm.level, band, HUNG)
        return true
      }
    }
    return false
  }
  const rug = (rm, x, z, hx, hz) => {
    const R = rm.rect
    const r = rect(clamp(x - hx, R.x0 + 0.3, R.x1), clamp(x + hx, R.x0, R.x1 - 0.3), clamp(z - hz, R.z0 + 0.3, R.z1), clamp(z + hz, R.z0, R.z1 - 0.3))
    if (r.x1 - r.x0 < 0.8 || r.z1 - r.z0 < 0.8) return
    // Two rugs on one floor would lie in one plane and z-fight.
    if (items.some((o) => o.kind === 'rug' && o.y === rm.floor && Math.abs(o.x - (r.x0 + r.x1) / 2) < o.hx + (r.x1 - r.x0) / 2 && Math.abs(o.z - (r.z0 + r.z1) / 2) < o.hz + (r.z1 - r.z0) / 2)) return
    items.push({ kind: 'rug', x: (r.x0 + r.x1) / 2, y: rm.floor, z: (r.z0 + r.z1) / 2, hx: (r.x1 - r.x0) / 2, hz: (r.z1 - r.z0) / 2, hue: rng(), stripes: 2 + Math.floor(rng() * 4), room: rm.id })
  }

  /** A long table in the middle of `rm`, with chairs or benches down its sides, a place laid at each seat. */
  const table = (rm, share) => {
    const R = rm.rect, wx = R.x1 - R.x0, wz = R.z1 - R.z0
    const want = clamp(Math.max(wx, wz) * share, 0.75, 1.4), endsWanted = chance(0.6)
    let hw = range(0.42, 0.5), along
    // The biggest table that fits, down the room then across it: shorter, then without its end chairs, then narrow with a tight walkway (a 3.3 m hall), then a chair a side (a hall crossed by doorways).
    let hl, ends, gx, gz, cands = []
    for (const [scale, e, m, w, least] of [[1, endsWanted, 0.6, hw, 0.6], [0.8, endsWanted, 0.6, hw, 0.6], [0.8, false, 0.6, hw, 0.6], [0.6, false, 0.6, hw, 0.6], [0.6, false, 0.4, 0.4, 0.6], [0, false, 0.4, 0.4, 0.42]]) {
      for (along of wx >= wz ? ['x', 'z'] : ['z', 'x']) {
        hl = Math.max(least, want * scale)
        ends = e
        hw = w
        const gl = hl + (ends ? 0.75 : 0.15), gw = hw + 0.8
        ;[gx, gz] = along === 'x' ? [gl, gw] : [gw, gl]
        for (let x = R.x0 + gx + m; x <= R.x1 - gx - m + 1e-6; x += 0.15) for (let z = R.z0 + gz + m; z <= R.z1 - gz - m + 1e-6; z += 0.15) {
          if (!clear(rm.level, rect(x - gx - m, x + gx + m, z - gz - m, z + gz + m), SOLID) || !clear(rm.level, rect(x - gx, x + gx, z - gz, z + gz), KEEP)) continue
          cands.push({ x, z, score: Math.hypot(x - (R.x0 + R.x1) / 2, z - (R.z0 + R.z1) / 2) + rng() * 0.8 })
        }
        if (cands.length) break
      }
      if (cands.length) break
    }
    cands.sort((a, b) => a.score - b.score)
    const yaw = along === 'x' ? 0 : Math.PI / 2
    const ax = along === 'x' ? [1, 0] : [0, 1], side = along === 'x' ? [0, 1] : [1, 0]
    const top = 0.78, y = rm.floor + top
    // The six most central, then six from anywhere: in a big room the central ones can all wall off its middle anchor.
    const far = cands.slice(6)
    for (const at of [...cands.slice(0, 6), ...Array.from({ length: Math.min(6, far.length) }, () => far.splice((rng() * far.length) | 0, 1)[0])]) {
      const ok = tx(rm.level, () => {
        put(rm, { kind: 'table', x: at.x, z: at.z, yaw, hx: hl, hz: hw, top, legs: pick(['trestle', 'post']), hue: rng() }, footprint(at.x, at.z, yaw, hl, hw), BLOCK, { keep: rect(at.x - gx, at.x + gx, at.z - gz, at.z + gz) })
        for (const s of [-1, 1]) {
          const k = Math.max(1, Math.floor((2 * hl - 0.1) / 0.62))
          const bench = chance(0.35)
          const look = [-side[0] * s, -side[1] * s]
          if (bench) {
            const c = { x: at.x + side[0] * s * (hw + 0.3), z: at.z + side[1] * s * (hw + 0.3) }
            put(rm, { kind: 'bench', x: c.x, z: c.z, yaw: Math.atan2(look[0], look[1]), hx: hl - 0.05, hz: 0.17, top: 0.46, hue: rng() }, footprint(c.x, c.z, Math.atan2(look[0], look[1]), hl - 0.05, 0.17), 0.46)
          }
          for (let i = 0; i < k; i++) {
            const u = -hl + (2 * hl * (i + 0.5)) / k
            const c = { x: at.x + ax[0] * u + side[0] * s * (hw + 0.3), z: at.z + ax[1] * u + side[1] * s * (hw + 0.3) }
            if (!bench) put(rm, { kind: 'chair', x: c.x, z: c.z, yaw: Math.atan2(look[0], look[1]), hx: 0.22, hz: 0.22, top: 0.46, cushion: chance(0.5) ? rng() : null, hue: rng() }, rect(c.x - 0.22, c.x + 0.22, c.z - 0.22, c.z + 0.22), 0.46)
            seat(rm, c.x, c.z, 0.46, look, { x: c.x - look[0] * STAND, z: c.z - look[1] * STAND })
            const p = { x: at.x + ax[0] * u + side[0] * s * (hw - 0.2), z: at.z + ax[1] * u + side[1] * s * (hw - 0.2) }
            if (chance(0.8)) thing(rm, 'plate', p.x, y, p.z)
            if (chance(0.5)) thing(rm, pick(['mug', 'bowl', 'mug']), p.x + ax[0] * 0.2, y, p.z + ax[1] * 0.2)
          }
        }
        if (ends) for (const s of [-1, 1]) {
          if (!chance(0.7)) continue
          const look = [-ax[0] * s, -ax[1] * s]
          const c = { x: at.x + ax[0] * s * (hl + 0.32), z: at.z + ax[1] * s * (hl + 0.32) }
          put(rm, { kind: 'chair', x: c.x, z: c.z, yaw: Math.atan2(look[0], look[1]), hx: 0.22, hz: 0.22, top: 0.46, cushion: chance(0.5) ? rng() : null, arms: chance(0.4), hue: rng() }, rect(c.x - 0.22, c.x + 0.22, c.z - 0.22, c.z + 0.22), 0.46)
          seat(rm, c.x, c.z, 0.46, look, { x: c.x - look[0] * STAND, z: c.z - look[1] * STAND })
        }
        if (chance(0.75)) thing(rm, 'fruitbowl', at.x, y, at.z, { n: 4 + Math.floor(rng() * 5) })
        const sticks = hl > 1.05 ? [-0.55, 0.55] : [chance(0.5) ? -0.45 : 0.45]
        for (const u of sticks) candle(rm, at.x + ax[0] * u * hl, y, at.z + ax[1] * u * hl, 'stick', 0.75)
        if (chance(0.5)) thing(rm, 'jug', at.x + ax[0] * hl * -0.25 + side[0] * 0.12, y, at.z + ax[1] * hl * -0.25 + side[1] * 0.12)
        if (chance(0.4)) thing(rm, 'loaf', at.x + ax[0] * hl * 0.25 - side[0] * 0.1, y, at.z + ax[1] * hl * 0.25 - side[1] * 0.1)
      })
      if (!ok) continue
      if (chance(0.45)) rug(rm, at.x, at.z, gx + 0.1, gz + 0.1)
      return at
    }
    return null
  }

  /** A board against a wall with two chairs on its open side, for a room with no floor in the middle to spare. */
  const board = (rm) => tx(rm.level, () => {
    const got = standing(rm, 'table', 0.6, 0.4, 0.78, { legs: 'post' }, { front: 1.3 })
    if (!got) return false
    const { c } = got, look = [-c.e.ix, -c.e.iz], y = rm.floor + 0.78
    for (const s of [-0.3, 0.3]) {
      const ch = pt(c.e, c.u + s, 0.82 + 0.32), p = pt(c.e, c.u + s, 0.6)
      put(rm, { kind: 'chair', x: ch.x, z: ch.z, yaw: Math.atan2(look[0], look[1]), hx: 0.22, hz: 0.22, top: 0.46, cushion: chance(0.5) ? rng() : null, hue: rng() }, rect(ch.x - 0.22, ch.x + 0.22, ch.z - 0.22, ch.z + 0.22), 0.46)
      seat(rm, ch.x, ch.z, 0.46, look, { x: ch.x - look[0] * 0.65, z: ch.z - look[1] * 0.65 })
      thing(rm, 'plate', p.x, y, p.z)
    }
    { const p = pt(c.e, c.u, 0.25); candle(rm, p.x, y, p.z, 'stick', 0.75) }
    if (chance(0.6)) { const p = pt(c.e, c.u - 0.45, 0.3); thing(rm, 'fruitbowl', p.x, y, p.z, { n: 3 + Math.floor(rng() * 4) }) }
  })

  const worktable = (rm) => {
    const got = standing(rm, 'worktable', range(0.7, 0.95), 0.36, 0.86, {}, { front: 1.0 })
    if (!got) return
    const { item, c } = got
    const stand = pt(c.e, c.u, 0.72 + 0.5)
    spots.push({ kind: 'cook', x: c.x, z: c.z, standX: stand.x, standZ: stand.z, lookX: -c.e.ix, lookZ: -c.e.iz, level: rm.level, room: rm.id })
    hold(rm.level, stand)
    solids[solids.length - 1].y1 = rm.floor + BLOCK
    const y = rm.floor + item.top
    for (let s = -item.hx + 0.18; s < item.hx - 0.12; s += range(0.25, 0.4)) {
      const p = pt(c.e, c.u + s, 0.36)
      thing(rm, pick(['bowl', 'loaf', 'crock', 'cabbage', 'board', 'jar']), p.x, y, p.z)
    }
    if (chance(0.6)) { const p = pt(c.e, c.u + item.hx - 0.12, 0.2); candle(rm, p.x, y, p.z, 'dish', 0.7) }
  }

  /** A bed head to a wall of `rm`, kept clear down one side and past its foot (a `cot` is shorter, its foot to the far wall); its spot's `stands` are every side that was clear, then the foot, for the reach test to choose from. */
  const bed = (rm, b, cot = false) => {
    const wid = b === 0 && !cot && chance(0.5) ? 1.45 : 1.0, len = cot ? 1.9 : 2.05, top = 0.55, front = cot ? 0 : 0.5
    const cands = shuffle(atWall(rm, wid / 2, len / 2, { front })).filter((c) => ceilOver(rm, c.r) >= 1.4)
    for (const c of cands.slice(0, 16)) {
      const pillow = [c.e.ix * -1, c.e.iz * -1], acr = [pillow[1], -pillow[0]]
      const sides = shuffle([1, -1]).map((s) => {
        const mid = { x: c.x + acr[0] * s * (wid / 2 + 0.45), z: c.z + acr[1] * s * (wid / 2 + 0.45) }
        return { s, mid, keep: footprint(mid.x, mid.z, c.yaw, 0.35, len / 2 - 0.2) }
      }).filter((sd) => clear(rm.level, sd.keep, SOLID))
      // Under an eave a side can be too low to stand in: some stand must have her headroom, and a side that has it is the one kept clear.
      const tall = (p) => levelCeilingAt(room, rm.level, p.x, p.z) - rm.floor >= HEAD
      const stands = [...sides.map((d) => d.mid), { x: c.x - pillow[0] * (len / 2 + 0.9), z: c.z - pillow[1] * (len / 2 + 0.9) }].filter((p) => within(rm.rect, p.x, p.z) && tall(p))
      if (sides.length === 0 || stands.length === 0) continue
      const sd = sides.find((d) => tall(d.mid)) || sides[0]
      const yaw = c.yaw + Math.PI
      const foot = { x: c.x - pillow[0] * (len / 2 + 0.3), z: c.z - pillow[1] * (len / 2 + 0.3) }
      const item = { kind: 'bed', x: c.x, z: c.z, yaw, len, wid, top, blanket: rng(), pillows: wid > 1.2 ? 2 : 1, posts: chance(0.3), hue: rng() }
      const ok = tx(rm.level, () => {
        put(rm, item, c.r, top, { keep: sd.keep })
        spots.push({ kind: 'bed', x: c.x, z: c.z, top: rm.floor + top, floor: rm.floor, yaw, len, wid, lookX: Math.sin(yaw), lookZ: Math.cos(yaw), standX: sd.mid.x, standZ: sd.mid.z, stands, level: rm.level, room: rm.id })
        hold(rm.level, { ...stands[0], r: 0.3 })
      })
      if (!ok) continue
      const fr = footprint(foot.x, foot.z, c.yaw, Math.min(0.45, wid / 2 - 0.05), 0.24)
      if (clear(rm.level, fr, SOLID | KEEP) && ceilOver(rm, fr) > 0.9) tx(rm.level, () => put(rm, { kind: 'chest', x: foot.x, z: foot.z, yaw: c.yaw + Math.PI, hx: Math.min(0.45, wid / 2 - 0.05), hz: 0.24, top: 0.5, hue: rng() }, fr, 0.5))
      const st = { x: c.x - acr[0] * sd.s * (wid / 2 + 0.28) + pillow[0] * (len / 2 - 0.3), z: c.z - acr[1] * sd.s * (wid / 2 + 0.28) + pillow[1] * (len / 2 - 0.3) }
      const sr = rect(st.x - 0.18, st.x + 0.18, st.z - 0.18, st.z + 0.18)
      if (clear(rm.level, sr, SOLID | KEEP) && ceilOver(rm, sr) > 1.0 && tx(rm.level, () => put(rm, { kind: 'stool', x: st.x, z: st.z, yaw: 0, r: 0.18, top: 0.5, hue: rng() }, sr, 0.5))) candle(rm, st.x, rm.floor + 0.5, st.z, 'dish', 0.7)
      if (chance(0.5)) rug(rm, sd.mid.x, sd.mid.z, Math.abs(acr[0]) > 0.5 ? 0.45 : 0.8, Math.abs(acr[0]) > 0.5 ? 0.8 : 0.45)
      return true
    }
    return false
  }

  /** A chair or armchair either side of the hearth, turned to the fire, and a log pile beside it. */
  const fireside = (rm) => {
    const L = MAIN[hearth.line]
    for (const s of shuffle([1, -1])) {
      const p = pt(L, hearth.u + s * (HEARTH.w / 2 + 0.35), 0.3), r = footprint(p.x, p.z, L.yaw, 0.32, 0.2)
      if (clear(0, grow(r, 0.02), SOLID | KEEP) && tx(0, () => put(rm, { kind: 'logpile', x: p.x, z: p.z, yaw: L.yaw, hx: 0.32, hz: 0.2, top: 0.4, hue: rng() }, r, 0.4))) break
    }
    for (const s of [1, -1]) {
      const arm = chance(0.5), half = arm ? 0.45 : 0.22
      for (let t = 0; t < 10; t++) {
        const u = hearth.u + s * (HEARTH.w / 2 + 0.15 + half + range(0, 0.4)), d = half + 0.4 + range(0.1, 0.6)
        // She stands to sit from the room side: between the chair and the fire is within a body of the hearth.
        const c = pt(L, u, d), stand = pt(L, u, d + half + 0.5)
        const f = hearth.fire, n = Math.hypot(f.x - c.x, f.z - c.z), look = [(f.x - c.x) / n, (f.z - c.z) / n]
        const r = rect(c.x - half, c.x + half, c.z - half, c.z + half)
        if (!clear(0, r, SOLID | KEEP) || !within(rm.rect, c.x, c.z)) continue
        const item = arm ? { kind: 'armchair', x: c.x, z: c.z, yaw: Math.atan2(look[0], look[1]), hx: half, hz: half, top: 0.45, hue: rng() } : { kind: 'chair', x: c.x, z: c.z, yaw: Math.atan2(look[0], look[1]), hx: 0.22, hz: 0.22, top: 0.46, cushion: chance(0.6) ? rng() : null, hue: rng() }
        if (tx(0, () => { put(rm, item, r, item.top); seat(rm, c.x, c.z, item.top, look, stand) })) break
      }
    }
  }
  /** Things on a side table's top: a basin and jug at a washstand, else a candlestick and a jug or books. */
  const dress = (rm, it, wash) => {
    const y = rm.floor + it.top, at = (s) => ({ x: it.x + s * Math.cos(it.yaw), z: it.z - s * Math.sin(it.yaw) })
    if (wash) { thing(rm, 'bowl', it.x, y, it.z); const p = at(0.14); thing(rm, 'jug', p.x, y, p.z); return }
    if (chance(0.5)) { const p = at(-0.1); candle(rm, p.x, y, p.z, 'stick', 0.7) }
    const p = at(0.1)
    thing(rm, pick(['jug', 'books', 'bowl', 'mug']), p.x, y, p.z, { n: 2 + Math.floor(rng() * 2) })
  }
  const sidetable = (rm, wash = false) => {
    const got = standing(rm, 'sidetable', 0.25, 0.25, wash ? 0.8 : 0.62, {}, { front: 0.5 })
    if (got) dress(rm, got.item, wash)
    return !!got
  }
  /** A chair against a wall, facing into the room, sometimes with a side table beside it. */
  const wallChair = (rm) => {
    let got = null
    const ok = tx(rm.level, () => {
      got = standing(rm, 'chair', 0.22, 0.22, 0.46, { cushion: chance(0.5) ? rng() : null }, { front: 0.6 })
      if (!got) return false
      seat(rm, got.c.x, got.c.z, 0.46, [got.c.e.ix, got.c.e.iz], pt(got.c.e, got.c.u, 0.96))
    })
    if (ok && chance(0.4)) {
      const { e, u } = got.c
      for (const s of shuffle([0.55, -0.55])) {
        const p = pt(e, u + s, 0.27), r = footprint(p.x, p.z, e.yaw, 0.25, 0.25), it = { kind: 'sidetable', x: p.x, z: p.z, yaw: e.yaw, hx: 0.25, hz: 0.25, top: 0.62, hue: rng() }
        if (clear(rm.level, strip(e, u + s - 0.25, u + s + 0.25, CELL, 0.52), SOLID | KEEP) && tx(rm.level, () => put(rm, it, r, it.top))) { dress(rm, it, false); break }
      }
    }
    return ok
  }
  /** A chair standing free, turned to the room's middle, for a room whose walls are taken or under the eaves. */
  const looseChair = (rm) => {
    const R = rm.rect, mx = (R.x0 + R.x1) / 2, mz = (R.z0 + R.z1) / 2
    for (let t = 0; t < 30; t++) {
      const x = range(R.x0 + 0.3, R.x1 - 0.3), z = range(R.z0 + 0.3, R.z1 - 0.3), n = Math.hypot(mx - x, mz - z)
      if (n < 0.5) continue
      const look = [(mx - x) / n, (mz - z) / n], r = rect(x - 0.22, x + 0.22, z - 0.22, z + 0.22), stand = { x: x + look[0] * 0.6, z: z + look[1] * 0.6 }
      if (!clear(rm.level, grow(r, 0.05), SOLID | KEEP) || ceilOver(rm, r) < 1.0 || levelCeilingAt(room, rm.level, stand.x, stand.z) - rm.floor < HEAD) continue
      const item = { kind: 'chair', x, z, yaw: Math.atan2(look[0], look[1]), hx: 0.22, hz: 0.22, top: 0.46, cushion: chance(0.5) ? rng() : null, hue: rng() }
      if (tx(rm.level, () => { put(rm, item, r, 0.46); seat(rm, x, z, 0.46, look, stand) })) return true
    }
    return false
  }
  const wallBench = (rm) => tx(rm.level, () => {
    const got = standing(rm, 'bench', range(0.5, 0.7), 0.17, 0.46, {}, { front: 0.6 })
    if (!got) return false
    seat(rm, got.c.x, got.c.z, 0.46, [got.c.e.ix, got.c.e.iz], pt(got.c.e, got.c.u, 0.9))
  })
  /** Pegs on a board along a wall, a cloak or a bag on some. */
  const pegrail = (rm) => {
    const hx = range(0.4, 0.6)
    for (const e of shuffle(edgesOf(rm))) {
      for (let t = 0; t < 10; t++) {
        const u = range(e.lo + hx + 0.2, e.hi - hx - 0.2), band = strip(e, u - hx, u + hx, 0, 0.4), at = pt(e, u, 0)
        const y = rm.floor + 1.55
        if (!(e.hi - e.lo > 2 * hx + 0.4) || !clear(rm.level, band, WIN | HUNG | KEEP) || levelCeilingAt(room, rm.level, at.x, at.z) < y + 0.4) continue
        const hang = Array.from({ length: Math.floor((2 * hx) / 0.25) }, () => (chance(0.3) ? 'cloak' : chance(0.25) ? 'bag' : null))
        items.push({ kind: 'pegrail', x: at.x, y, z: at.z, yaw: e.yaw, hx, hang, hue: rng(), room: rm.id })
        mark(rm.level, band, HUNG)
        return true
      }
    }
    return false
  }
  const SEATS = ['chair', 'armchair', 'rocker', 'bench']
  const seats = (rm) => items.filter((it) => it.room === rm.id && SEATS.includes(it.kind)).length
  const SMALL = ['potion', 'candle', 'plate', 'mug', 'bowl', 'jug', 'loaf', 'fruitbowl', 'parchment', 'scroll', 'inkpot', 'books', 'rug', 'pot', 'jar', 'crock', 'cabbage', 'board']
  const EXTRA = {
    hall: ['sidetable', 'basket', 'pegrail', 'chest', 'bench', 'barrel'],
    kitchen: ['basket', 'sack', 'barrel', 'crate', 'pegrail', 'stool'],
    parlour: ['sidetable', 'basket', 'chest', 'pegrail', 'bookcase'],
    workroom: ['crate', 'chest', 'basket', 'sidetable', 'scrollbin'],
    store: ['barrel', 'crate', 'sack', 'basket'],
    bedroom: ['washstand', 'chest', 'basket', 'pegrail', 'press'],
  }
  const ADD = {
    sidetable: (rm) => sidetable(rm),
    washstand: (rm) => sidetable(rm, true),
    basket: (rm) => tucked(rm, 'basket', 0.2, 0.3, { load: pick(['wool', 'apples', 'linen']) }),
    pegrail,
    chest: (rm) => standing(rm, 'chest', 0.45, 0.26, 0.5, {}, { front: 0.5 }),
    bench: wallBench,
    barrel: (rm) => tucked(rm, 'barrel', 0.3, 0.9),
    sack: (rm) => tucked(rm, 'sack', 0.25, 0.5),
    crate: (rm) => { const s = range(0.42, 0.55); return tucked(rm, 'crate', s / 2, s, { s, stack: 1 }) },
    stool: (rm) => loose(rm, 'stool', 0.18, 0.45),
    bookcase: (rm) => standing(rm, 'bookcase', 0.5, 0.18, 2.0, {}, { front: 0.7 }),
    scrollbin: (rm) => tucked(rm, 'scrollbin', 0.24, 0.6),
    press: (rm) => standing(rm, 'press', 0.6, 0.3, 1.95, {}, { front: 0.7 }),
  }
  /** More of what the room is for, until it holds about a piece to every 4 m². */
  const fill = (rm) => {
    const want = Math.ceil(area(rm.rect) * 0.25)
    for (let t = 0; t < 10 && items.filter((it) => it.room === rm.id && !SMALL.includes(it.kind)).length < want; t++) ADD[pick(EXTRA[rm.kind])](rm)
  }

  /** The shop's counter (the potion master's, or an inn's bar): standing free along a wall, as near the front door as it goes, in the hall, or with `anywhere` failing that another room downstairs or a short counter; the keeper's lane behind it open at one end, its wares (bottles, or mugs and jugs) on its top and shelves of them behind. Only the counter itself must miss the doors' keep-clear lanes, which fill a small hall. */
  const counter = (hall, anywhere) => {
    const hz = 0.28, top = 1.0, lane = 0.85, [long, short] = shop === 'inn' ? [1.2, 0.7] : [0.7, 0.45]
    const cands = []
    for (const hx of anywhere ? [long, short] : [long]) for (const rm of [hall, ...(anywhere ? rooms.filter((r) => r.level === 0 && r !== hall && r.kind !== 'store' && r.kind !== 'bedroom') : [])]) for (const e of edgesOf(rm)) {
      if (rm === hall && e.name === 'front') continue
      for (let u = e.lo + hx + 0.05; u <= e.hi - hx - 0.05; u += 0.1) {
        const c = pt(e, u, lane + hz)
        cands.push({ hx, rm, e, u, c, d: (hx < long ? 1000 : 0) + (rm === hall ? 0 : 100) + Math.hypot(c.x - doorIn.x, c.z - doorIn.z) })
      }
    }
    for (const { hx, rm, e, u, c } of cands.sort((a, b) => a.d - b.d)) {
      const r = footprint(c.x, c.z, e.yaw, hx, hz)
      const back = [strip(e, u - hx - 0.7, u + hx, CELL, lane), strip(e, u - hx, u + hx + 0.7, CELL, lane)].find((b) => clear(rm.level, b, SOLID))
      const front = strip(e, u - hx, u + hx, lane + 2 * hz, lane + 2 * hz + 0.8)
      if (!back || !clear(rm.level, grow(r, 0.02), SOLID | KEEP) || !clear(rm.level, front, SOLID) || ceilOver(rm, back) < HEAD) continue
      const item = { kind: 'counter', x: c.x, z: c.z, yaw: e.yaw, hx, hz, top, hue: rng() }
      const stand = pt(e, u, lane / 2)
      const ok = tx(rm.level, () => {
        put(rm, item, r, top, { keep: front })
        solids[solids.length - 1].y1 = rm.floor + BLOCK
        mark(rm.level, back, KEEP)
        spots.push({ kind: 'shop', x: c.x, z: c.z, standX: stand.x, standZ: stand.z, lookX: e.ix, lookZ: e.iz, level: rm.level, room: rm.id })
        hold(rm.level, stand)
      })
      if (!ok) continue
      const y = rm.floor + top
      const wares = shop === 'inn' ? ['mug', 'mug', 'jug'] : ['potion']
      for (let s = -hx + 0.12; s < hx - 0.1; s += range(0.11, 0.2)) { const p = pt(e, u + s, lane + hz + range(-0.1, 0.1)); thing(rm, pick(wares), p.x, y, p.z) }
      shelf(rm, 0.7, shop)
      shelf(rm, 0.6, shop)
      if (shop === 'inn') for (let i = 0; i < 2; i++) tucked(rm, 'barrel', 0.3, 0.9)
      return true
    }
    if (!anywhere) return false
    throw new Error(`rollTownInterior: house ${index} has no room downstairs for its ${shop} counter`)
  }

  const furnish = {
    hall(rm) {
      const many = plan.kind === 'inn' || shop === 'inn'
      // A hall too narrow for a table eats in the widest other room downstairs, or failing that at a board against its wall.
      const short = (r) => Math.min(r.rect.x1 - r.rect.x0, r.rect.z1 - r.rect.z0)
      const dine = () => !!table(rm, many ? 0.13 : 0.2) || rooms.filter((r) => r.level === 0 && r !== rm && r.kind !== 'store').sort((a, b) => short(b) - short(a)).some((r) => table(r, 0.2)) || board(rm)
      // A bed takes a 2.5 m run off a wall that a table in the middle can leave none of, so a hall that sleeps tries both orders, then a board against the wall.
      const meals = () => {
        if (!rm.sleeps || !(tx(0, () => dine() && bed(rm, 1)) || tx(0, () => bed(rm, 1) && dine()) || tx(0, () => bed(rm, 1) && board(rm)))) dine()
        return items.some((it) => it.kind === 'table')
      }
      // The counter takes the hall first unless that leaves the house no table.
      if (shop === null) meals()
      else if (!tx(0, () => counter(rm, false) && meals())) { meals(); counter(rm, true) }
      // An inn's taproom takes tables until its floor is full: a table tries only a dozen spots, so one miss is not yet full.
      if (shop === 'inn') { for (let n = 0, miss = 0; n < 8 && miss < 4;) if (table(rm, 0.12)) n++; else miss++ }
      else if (many) { table(rm, 0.13); if (chance(0.5)) table(rm, 0.12) }
      standing(rm, 'dresser', range(0.6, 0.8), 0.26, range(1.8, 2.0), { load: 'plates' }, { front: 0.8 })
      shelf(rm)
      if (chance(0.5)) shelf(rm)
      if (chance(0.4)) { const a = corner(rm, 'armchair', 0.45, 0.45); if (a) seat(rm, a.item.x, a.item.z, 0.45, a.look, { x: a.item.x + a.look[0] * 0.75, z: a.item.z + a.look[1] * 0.75 }) }
      if (rm.hearth) furnish.kitchen(rm, true)
    },
    kitchen(rm, shared = false) {
      spots.push({ kind: 'cook', x: hearth.fire.x, z: hearth.fire.z, standX: hearth.cook.x, standZ: hearth.cook.z, lookX: -hearth.ix, lookZ: -hearth.iz, level: 0, room: rm.id })
      hold(0, hearth.cook)
      fireside(rm)
      worktable(rm)
      const barrels = shared ? 1 : 1 + Math.floor(rng() * 3)
      for (let i = 0; i < barrels; i++) tucked(rm, 'barrel', 0.3, 0.9)
      for (let i = 0, n = shared ? 1 : 1 + Math.floor(rng() * 3); i < n; i++) tucked(rm, 'sack', 0.25, 0.5)
      shelf(rm)
      if (!shared) { shelf(rm); if (chance(0.6)) loose(rm, 'stool', 0.18, 0.45) }
      rug(rm, hearth.cook.x, hearth.cook.z, hearth.axis === 'x' ? 0.9 : 0.6, hearth.axis === 'x' ? 0.6 : 0.9)
    },
    parlour(rm) {
      const a = corner(rm, 'armchair', 0.45, 0.45)
      if (a) {
        seat(rm, a.item.x, a.item.z, 0.45, a.look, { x: a.item.x + a.look[0] * 0.75, z: a.item.z + a.look[1] * 0.75 })
        const sx = a.item.x + a.look[1] * 0.75, sz = a.item.z - a.look[0] * 0.75
        const st = rect(sx - 0.18, sx + 0.18, sz - 0.18, sz + 0.18)
        if (clear(rm.level, st, SOLID | KEEP) && tx(rm.level, () => put(rm, { kind: 'stool', x: sx, z: sz, yaw: 0, r: 0.18, top: 0.5, hue: rng() }, st, 0.5))) candle(rm, sx, rm.floor + 0.5, sz, 'dish', 0.8)
      }
      const r = corner(rm, 'rocker', 0.42, 0.45)
      if (r) seat(rm, r.item.x, r.item.z, 0.45, r.look, { x: r.item.x + r.look[0] * 0.75, z: r.item.z + r.look[1] * 0.75 })
      if (chance(0.65)) { const R = rm.rect; rug(rm, (R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2, range(0.9, 1.4), range(0.7, 1.1)) }
      shelf(rm)
      if (chance(0.4)) standing(rm, 'bookcase', 0.5, 0.18, 2.0, {}, { front: 0.7 })
      if (chance(0.4)) standing(rm, 'chest', 0.45, 0.26, 0.5, {}, { front: 0.5 })
    },
    workroom(rm) {
      const got = standing(rm, 'desk', range(0.6, 0.75), 0.36, 0.76, {}, { front: 1.3 })
      if (got) {
        const { item, c } = got
        solids[solids.length - 1].y1 = rm.floor + BLOCK
        const look = [-c.e.ix, -c.e.iz], ch = pt(c.e, c.u, 0.72 + 0.32)
        const r = rect(ch.x - 0.22, ch.x + 0.22, ch.z - 0.22, ch.z + 0.22)
        if (tx(rm.level, () => put(rm, { kind: 'chair', x: ch.x, z: ch.z, yaw: Math.atan2(look[0], look[1]), hx: 0.22, hz: 0.22, top: 0.46, cushion: chance(0.4) ? rng() : null, hue: rng() }, r, 0.46))) {
          seat(rm, ch.x, ch.z, 0.46, look, { x: ch.x - look[0] * 0.65, z: ch.z - look[1] * 0.65 }, 'read')
        }
        const y = rm.floor + item.top
        const desk = (s, d) => pt(c.e, c.u + s, d)
        for (let i = 0, n = 2 + Math.floor(rng() * 3); i < n; i++) { const p = desk(range(-0.35, 0.35) * item.hx, range(0.3, 0.55)); thing(rm, 'parchment', p.x, y + i * 0.002, p.z, { yaw: c.yaw + range(-0.5, 0.5) }) }
        for (let i = 0, n = 1 + Math.floor(rng() * 3); i < n; i++) { const p = desk(range(-0.8, 0.8) * item.hx, range(0.15, 0.3)); thing(rm, 'scroll', p.x, y, p.z, { yaw: c.yaw + Math.PI / 2 + range(-0.3, 0.3), len: range(0.25, 0.4) }) }
        { const p = desk(item.hx * 0.6, 0.18); thing(rm, 'inkpot', p.x, y, p.z) }
        { const p = desk(-item.hx * 0.7, 0.2); thing(rm, 'books', p.x, y, p.z, { n: 2 + Math.floor(rng() * 3), yaw: c.yaw + range(-0.3, 0.3) }) }
        { const p = desk(item.hx * 0.82, 0.3); candle(rm, p.x, y, p.z, 'dish', 0.85) }
      }
      for (let i = 0, n = 1 + Math.floor(rng() * 2); i < n; i++) standing(rm, 'bookcase', 0.5, 0.18, 2.0, {}, { front: 0.7 })
      shelf(rm)
      if (chance(0.5)) standing(rm, 'chest', 0.45, 0.26, 0.5, { scrolls: true }, { front: 0.5 })
      if (chance(0.5)) tucked(rm, 'scrollbin', 0.24, 0.6)
    },
    store(rm) {
      for (let i = 0, n = 2 + Math.floor(rng() * 3); i < n; i++) tucked(rm, 'barrel', 0.3, 0.9)
      for (let i = 0, n = 1 + Math.floor(rng() * 3); i < n; i++) { const s = range(0.42, 0.55), stack = chance(0.4) ? 2 : 1; tucked(rm, 'crate', s / 2, s * stack, { s, stack }) }
      for (let i = 0, n = 2 + Math.floor(rng() * 3); i < n; i++) tucked(rm, 'sack', 0.25, 0.5)
      if (chance(0.7)) shelf(rm)
    },
    bedroom(rm, most = 2) {
      const area = (rm.rect.x1 - rm.rect.x0) * (rm.rect.z1 - rm.rect.z0)
      const n = Math.min(most, area > 16 && chance(0.55) ? 2 : 1)
      for (let b = 0; b < n; b++) if (!bed(rm, b)) break
      if (chance(0.45)) standing(rm, 'press', 0.6, 0.3, 1.95, {}, { front: 0.7 })
      if (chance(0.4)) shelf(rm)
    },
  }
  // Bedrooms first, so their beds have the walls, then the hall so its board has the floor; a house whose bedrooms took no bed sleeps in its hall, or failing that in the biggest room.
  for (const rm of rooms) if (rm.kind === 'bedroom') furnish.bedroom(rm)
  hall.sleeps = !items.some((it) => it.kind === 'bed')
  furnish.hall(hall)
  if (!items.some((it) => it.kind === 'bed')) {
    const area = (r) => (r.rect.x1 - r.rect.x0) * (r.rect.z1 - r.rect.z0)
    if (!rooms.slice().sort((a, b) => area(b) - area(a)).some((r) => bed(r, 1) || bed(r, 1, true))) throw new Error(`rollTownInterior: house ${index} has no wall for a bed`)
  }
  for (const rm of rooms) if (rm.kind !== 'bedroom' && rm !== hall) furnish[rm.kind](rm)
  // A chair or two in every room, against a wall or loose facing its middle, then the room filled out.
  for (const rm of rooms) {
    const want = chance(0.55) ? 2 : 1
    while (seats(rm) < want && (wallChair(rm) || looseChair(rm)));
    fill(rm)
  }
  // A room whose walls are all taken gets a candlestick on whatever stands in it.
  const perch = (rm) => {
    const it = items.find((it) => it.room === rm.id && ['dresser', 'chest', 'press', 'sidetable', 'worktable', 'counter', 'barrel', 'crate'].includes(it.kind))
    if (!it) return false
    candle(rm, it.x, rm.floor + it.top, it.z, 'stick', 0.8)
    return true
  }
  for (const rm of rooms) if (!candles.some((c) => c.room === rm.id) && !sconce(rm) && !perch(rm)) throw new Error(`rollTownInterior: room ${rm.id} (${rm.kind}) of house ${index} has no light, no wall for a sconce and nothing to stand a candle on`)

  // Before each window, a place to stand and look out; a pair to talk in the hall.
  for (const w of windows) {
    const p = { x: w.x - w.nx * 0.8, z: w.z - w.nz * 0.8 }
    spots.push({ kind: 'gaze', x: p.x, z: p.z, standX: p.x, standZ: p.z, lookX: w.nx, lookZ: w.nz, level: w.level, room: w.room })
  }

  // --- the walking grid, and the spots it reaches --------------------------------
  const walk = levels.map(walkable)
  const reach = levels.map((l) => flood(walk[l], anchors[l][0]))
  const fine = (level, x, z) => { const c = cellOf(x, z); return c >= 0 && reach[level][c] === 1 }
  const nav = { X0, Z0, nx, nz, cell: CELL, walk, reach, floors }
  room.nav = nav
  for (const s of spots) {
    if (!s.stands) continue
    const at = s.stands.find((p) => fine(s.level, p.x, p.z))
    if (at) { s.standX = at.x; s.standZ = at.z }
    delete s.stands
  }
  const kept = spots.filter((s) => fine(s.level, s.standX, s.standZ))
  for (let t = 0; t < 60; t++) {
    const x = range(hall.rect.x0 + 0.8, hall.rect.x1 - 0.8), z = range(hall.rect.z0 + 0.8, hall.rect.z1 - 0.8), a = range(0, 2 * Math.PI)
    const x1 = x + Math.cos(a) * 0.95, z1 = z + Math.sin(a) * 0.95
    if (!fine(0, x, z) || !fine(0, x1, z1) || !clear(0, rect(x - 0.4, x + 0.4, z - 0.4, z + 0.4), KEEP)) continue
    kept.push({ kind: 'talk', x, z, standX: x, standZ: z, lookX: x1 - x, lookZ: z1 - z, level: 0, room: hall.id, pair: kept.length + 1 })
    kept.push({ kind: 'talk', x: x1, z: z1, standX: x1, standZ: z1, lookX: x - x1, lookZ: z - z1, level: 0, room: hall.id, pair: kept.length - 1 })
    break
  }

  const bounds = { x0: X0, x1: X1, z0: Z0, z1: Z1 }
  Object.assign(room, {
    rise, cells: cells.map((c) => ({ role: c.role, r: c.r })), junctions: junctions.map(({ side, line, lo, hi, band, gap, cell, P }) => ({ side, line, lo, hi, band, gap, cell, P })),
    door, doorIn, hearth, partitions, doorways, windows, rooms, items, solids, candles, spots: kept,
    floor: { kind: chance(0.55) ? 'plank' : 'flag', hue: rng(), tone: range(0.75, 1.15) },
    wall: { kind: chance(0.6) ? 'boards' : 'panel', hue: rng(), tone: range(0.8, 1.15) },
    bounds, R: Math.hypot(X1 - X0, Z1 - Z0) / 2,
    inside: [...floorRects[0], door.reveal],
  })
  return room
}

/**
 * The house as stone to the walker (walk.js addStone's contract), set down with its room-local origin at (ox, oy, oz): everything off the floor plan is wall, the roof (or the upper floor's slab, a solid like any other) is over every point, and every solid stands where it is. `blockTopAt` is the top of the stone stacked up from the ground floor, so a teleport lands under the upper floor, not on it.
 */
/** The floor's height at room-local (x, z): 0, or down the cellar stair a ramp through its treads' middles, so her feet ride the flight. */
export function townFloorAt(room, x, z) {
  const c = room.cellar
  if (c === null || !within(c.hole, x, z)) return 0
  return -CELLAR.rise / 2 - (CELLAR.rise / CELLAR.run) * Math.max(0, (x - c.x) * c.nx + (z - c.z) * c.nz)
}

export class TownInteriorStone {
  constructor(room, ox, oy, oz) {
    this.room = room
    this.ox = ox
    this.oy = oy
    this.oz = oz
    this.spans = new Float64Array(64)
    const b = room.bounds
    this.bx = Math.floor(b.x0)
    this.bz = Math.floor(b.z0)
    this.bw = Math.ceil(b.x1) - this.bx
    this.bd = Math.ceil(b.z1) - this.bz
    this.buckets = Array.from({ length: this.bw * this.bd }, () => [])
    for (const s of room.solids) {
      for (let k = Math.max(0, Math.floor(s.z0) - this.bz); k <= Math.min(this.bd - 1, Math.floor(s.z1) - this.bz); k++) {
        for (let i = Math.max(0, Math.floor(s.x0) - this.bx); i <= Math.min(this.bw - 1, Math.floor(s.x1) - this.bx); i++) this.buckets[k * this.bw + i].push(s)
      }
    }
  }

  /** Local (lx, lz)'s spans into this.spans as local [bottom, top] pairs, sorted and merged; -1 off the floor plan. */
  _local(lx, lz) {
    const room = this.room, sp = this.spans
    if (!room.inside.some((r) => within(r, lx, lz))) return -1
    let n = 0
    sp[n++] = townCeilingAt(room, lx, lz); sp[n++] = 1e3
    const i = Math.floor(lx) - this.bx, k = Math.floor(lz) - this.bz
    if (i >= 0 && k >= 0 && i < this.bw && k < this.bd) {
      for (const s of this.buckets[k * this.bw + i]) {
        if (n >= sp.length) break
        if (lx < s.x0 || lx > s.x1 || lz < s.z0 || lz > s.z1) continue
        sp[n++] = s.y0; sp[n++] = s.y1
      }
    }
    const m = n / 2
    for (let a = 1; a < m; a++) {
      const b0 = sp[a * 2], t0 = sp[a * 2 + 1]
      let j = a - 1
      while (j >= 0 && sp[j * 2] > b0) { sp[(j + 1) * 2] = sp[j * 2]; sp[(j + 1) * 2 + 1] = sp[j * 2 + 1]; j-- }
      sp[(j + 1) * 2] = b0; sp[(j + 1) * 2 + 1] = t0
    }
    let out = 0
    for (let a = 0; a < m; a++) {
      const b0 = sp[a * 2], t0 = sp[a * 2 + 1]
      if (out > 0 && b0 <= sp[out * 2 - 1]) sp[out * 2 - 1] = Math.max(sp[out * 2 - 1], t0)
      else { sp[out * 2] = b0; sp[out * 2 + 1] = t0; out++ }
    }
    return out
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
    return this.room.inside.some((r) => within(r, x - this.ox, z - this.oz))
  }

  /** WalkSurface.stairAt: the up-stair's treads, each filled to the next one's top. */
  stairAt(x, y, z) {
    const st = this.room.stair, ly = y - this.oy
    if (st === null || ly < 0) return null
    const t = st.treads.find((t) => ly < t.top + st.rise && within(t, x - this.ox, z - this.oz))
    return t ? this.oy + t.top : null
  }
}

// --- routes over the walking grid -------------------------------------------------

/** The walkable cell nearest (x, z) on `level`, within `maxM`, as its centre; null when there is none. */
export function navSnap(room, level, x, z, maxM = 3) {
  const n = room.nav, w = n.reach[level]
  const i0 = Math.floor((x - n.X0) / n.cell), k0 = Math.floor((z - n.Z0) / n.cell)
  const R = Math.ceil(maxM / n.cell)
  let best = null, bd = Infinity
  for (let r = 0; r <= R; r++) {
    if (best !== null && (r - 1) * n.cell > bd) break
    for (let k = k0 - r; k <= k0 + r; k++) for (let i = i0 - r; i <= i0 + r; i++) {
      if (Math.max(Math.abs(i - i0), Math.abs(k - k0)) !== r || i < 0 || k < 0 || i >= n.nx || k >= n.nz || !w[k * n.nx + i]) continue
      const cx = n.X0 + (i + 0.5) * n.cell, cz = n.Z0 + (k + 0.5) * n.cell, d = Math.hypot(cx - x, cz - z)
      if (d < bd) { bd = d; best = { x: cx, z: cz } }
    }
  }
  return best
}

/** Whether the straight line between two points of `level` stays on walkable cells. */
function sight(n, w, ax, az, bx, bz) {
  const len = Math.hypot(bx - ax, bz - az), steps = Math.ceil(len / (n.cell * 0.5))
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0
    const i = Math.floor((ax + (bx - ax) * t - n.X0) / n.cell), k = Math.floor((az + (bz - az) * t - n.Z0) / n.cell)
    if (i < 0 || k < 0 || i >= n.nx || k >= n.nz || !w[k * n.nx + i]) return false
  }
  return true
}

/** A* over one level's grid from (ax, az) to (bx, bz), pulled taut: [{ x, z }] after the start, or null when they are not joined. */
function levelRoute(room, level, ax, az, bx, bz) {
  const n = room.nav, w = n.reach[level], NX = n.nx
  const a = navSnap(room, level, ax, az), b = navSnap(room, level, bx, bz)
  if (!a || !b) return null
  const start = Math.floor((a.z - n.Z0) / n.cell) * NX + Math.floor((a.x - n.X0) / n.cell)
  const goal = Math.floor((b.z - n.Z0) / n.cell) * NX + Math.floor((b.x - n.X0) / n.cell)
  const size = NX * n.nz, g = new Float32Array(size).fill(Infinity), from = new Int32Array(size).fill(-1), shut = new Uint8Array(size)
  const gi = goal % NX, gk = Math.floor(goal / NX)
  const h = (c) => { const dx = Math.abs((c % NX) - gi), dz = Math.abs(Math.floor(c / NX) - gk); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz) }
  const heap = [], f = new Float32Array(size)
  const push = (c) => { heap.push(c); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (f[heap[p]] <= f[heap[i]]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p } }
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l; if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m } } return top }
  g[start] = 0
  f[start] = h(start)
  push(start)
  while (heap.length) {
    const c = pop()
    if (c === goal) break
    if (shut[c]) continue
    shut[c] = 1
    const i = c % NX, k = Math.floor(c / NX)
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      if (!di && !dk) continue
      const ii = i + di, kk = k + dk
      if (ii < 0 || kk < 0 || ii >= NX || kk >= n.nz) continue
      const e = kk * NX + ii
      if (!w[e] || shut[e] || (di && dk && (!w[k * NX + ii] || !w[kk * NX + i]))) continue
      const cost = g[c] + (di && dk ? 1.414 : 1)
      if (cost < g[e]) { g[e] = cost; f[e] = cost + h(e); from[e] = c; push(e) }
    }
  }
  if (start !== goal && from[goal] < 0) return null
  const cells = []
  for (let c = goal; c !== -1; c = from[c]) cells.push({ x: n.X0 + ((c % NX) + 0.5) * n.cell, z: n.Z0 + (Math.floor(c / NX) + 0.5) * n.cell })
  cells.reverse()
  cells[cells.length - 1] = b
  const out = []
  let at = a
  let i = 0
  while (i < cells.length - 1) {
    let j = cells.length - 1
    while (j > i + 1 && !sight(n, w, at.x, at.z, cells[j].x, cells[j].z)) j--
    out.push(cells[j])
    at = cells[j]
    i = j
  }
  if (out.length === 0) out.push(b)
  return out
}

/**
 * The way from `from` to `to` (each { x, z, level }) through the house: points { x, y, z, level } after the start, up or down the stair between levels; null when the grid does not join them.
 */
export function navRoute(room, from, to) {
  const f = room.nav.floors
  const lift = (pts, level) => pts.map((p) => ({ x: p.x, y: f[level], z: p.z, level }))
  if (from.level === to.level) {
    const r = levelRoute(room, from.level, from.x, from.z, to.x, to.z)
    return r && lift(r, from.level)
  }
  const st = room.stair
  if (!st) throw new Error('navRoute: a route between levels in a house with no stair')
  const up = to.level > from.level
  const [a, b] = up ? [st.bottom, st.top] : [st.top, st.bottom]
  const first = levelRoute(room, from.level, from.x, from.z, a.x, a.z)
  const last = levelRoute(room, to.level, b.x, b.z, to.x, to.z)
  if (!first || !last) return null
  const steps = (up ? st.steps : [...st.steps].reverse()).map((s) => ({ x: s.x, y: s.y, z: s.z, level: up ? 0 : 1 }))
  return [...lift(first, from.level), ...steps, { x: b.x, y: f[to.level], z: b.z, level: to.level }, ...lift(last, to.level)]
}
