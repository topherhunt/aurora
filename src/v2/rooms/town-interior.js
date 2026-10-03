// A town house's inside (design/38-town-interiors.md): its plan (buildings/plan.js) S times larger on the ground, board partitions cutting it into rooms, a slat stair to an upper floor under the main roof where the roof leaves headroom, each room furnished for its use, and the stone and walking grid she and the townsfolk move by. Pure, no three. Room-local metres: building-local times S, unrotated, y 0 the ground floor, the front door in the main mass's +Z wall.
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { roofHeightAt } from '../../buildings/plan.js'

export const S = 2
// The outer wall's thickness inside the scaled shell, and a partition's.
const T = 0.15
export const PART = 0.12
export const DOORWAY = { w: 1.1, h: 2.2 }
export const DOOR = { w: 1.25, h: 2.25 }
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
function minus(r, h) {
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
 * The inside of the building planned as `plan`, house `index` of the world seeded `seed`. Everything placed is in `items` for the renderer, `solids` (axis-aligned boxes) for the stone, `candles` for the flames and the light, `spots` for the residents, and `nav` for their routes.
 */
export function rollTownInterior({ seed, index, plan }) {
  if (!Number.isInteger(seed) || !Number.isInteger(index) || !plan || !Array.isArray(plan.masses)) throw new Error('rollTownInterior: needs an integer seed and index and a building plan')
  const rng = mulberry32(hash32(seed, index, plan.seed | 0, 0x7041))
  const range = (lo, hi) => lo + (hi - lo) * rng()
  const pick = (list) => list[Math.floor(rng() * list.length)]
  const chance = (p) => rng() < p
  const shuffle = (list) => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [list[i], list[j]] = [list[j], list[i]] } return list }

  const main = plan.masses.find((m) => m.role === 'main')
  if (!main) throw new Error('rollTownInterior: the plan has no main mass')
  const inset = (m) => ({ x0: S * (m.cx - m.w / 2) + T, x1: S * (m.cx + m.w / 2) - T, z0: S * (m.cz - m.d / 2) + T, z1: S * (m.cz + m.d / 2) - T })
  const M = inset(main)
  const room = { town: true, seed, index, plan, kind: plan.kind, M }
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
    if (inJunction(L, u)) return false
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
        if (keeps[0].some((k) => hit(k, whole)) || hit(hearth.body, whole)) continue
        if (windows.some((w) => w.level === 0 && onLine(w, L) && Math.abs(w.u - (uA + uE) / 2) < Math.abs(uE - uA) / 2 + w.w / 2)) continue
        let ok = true
        for (let t = th; t <= n && ok; t++) {
          const uc = u0 + dir * (t - 0.5) * STAIR.run
          for (const d of [0.1, STAIR.w - 0.1]) { const p = pt(L, uc, d); if (roofAt(p.x, p.z) < t * rise + HEAD) ok = false }
        }
        for (const d of [0.1, STAIR.w - 0.1]) { const p = pt(L, u0 + dir * (len + 0.5), d); if (roofAt(p.x, p.z) < U + HEAD) ok = false }
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
    // A window high in each open gable: an upstairs room the outside shows no window for is lit by one the gable could have.
    for (const name of ['west', 'east']) {
      const L = MAIN[name]
      if (windows.some((w) => w.level === 1 && onLine(w, L)) || junctions.some((j) => j.line === name)) continue
      for (const off of [0, 1.2, -1.2, 2.2, -2.2]) {
        const u = midZ + off
        if (hearth.line === name && Math.abs(u - hearth.u) < 1.7) continue
        if (stair.line === name && within(grow(stair.hole, 1.0), pt(L, u, 0.3).x, pt(L, u, 0.3).z)) continue
        const face = pt(L, u, 0.05)
        if (addWindow(M, L, u, 1, U + 0.8, Math.min(U + 1.9, roofAt(face.x, face.z) - 0.3))) break
      }
    }
    // The chimney rises through the upper floor.
    hung[1].push(strip(MAIN[hearth.line], hearth.u - 1.1, hearth.u + 1.1, 0, 0.5))
  }

  // --- partitions across the main, ground and upper ---------------------------
  const partitions = []
  const width = M.x1 - M.x0
  const split = (level, want) => {
    const f = level ? U : 0
    const blocks = [...keeps[level], hearth.body]
    if (stair) blocks.push(level ? grow(stair.hole, 0.3) : grow(rect(Math.min(...stair.treads.map((t) => t.x0)), Math.max(...stair.treads.map((t) => t.x1)), Math.min(...stair.treads.map((t) => t.z0)), Math.max(...stair.treads.map((t) => t.z1))), 0.3))
    for (let k = want; k > 0; k--) {
      for (let tries = 0; tries < 80; tries++) {
        const ps = []
        for (let i = 0; i < k; i++) ps.push(M.x0 + (width * (i + 1)) / (k + 1) + range(-1.2, 1.2))
        ps.sort((a, b) => a - b)
        if ([M.x0, ...ps, M.x1].some((p, i, all) => i > 0 && p - all[i - 1] < 3)) continue
        const out = []
        for (const p of ps) {
          const wall = rect(p - PART / 2 - 0.15, p + PART / 2 + 0.15, M.z0, M.z1)
          if (blocks.some((b) => hit(b, wall))) break
          if (windows.some((w) => w.level === level && w.axis === 'x' && Math.abs(w.u - p) < w.w / 2 + 0.25)) break
          const zs = []
          for (let z = M.z0 + DOORWAY.w / 2 + 0.35; z <= M.z1 - DOORWAY.w / 2 - 0.35; z += 0.1) {
            const k2 = rect(p - 1.0, p + 1.0, z - DOORWAY.w / 2 - 0.15, z + DOORWAY.w / 2 + 0.15)
            if (blocks.some((b) => hit(b, k2))) continue
            if (roofAt(p, z - DOORWAY.w / 2) < f + DOORWAY.h + 0.15 || roofAt(p, z + DOORWAY.w / 2) < f + DOORWAY.h + 0.15) continue
            zs.push(z)
          }
          if (zs.length === 0) break
          out.push({ p, z: pick(zs) })
        }
        if (out.length === k) return out
      }
    }
    return []
  }
  for (const level of upper ? [0, 1] : [0]) {
    const f = level ? U : 0
    const want = level === 0 ? (width < 7 ? 0 : width < 8.5 ? (chance(0.5) ? 1 : 0) : Math.min(3, Math.floor(width / 6.5))) : width < 9 ? 0 : Math.min(2, Math.floor(width / 7.5))
    for (const { p, z } of split(level, want)) {
      const gap = [z - DOORWAY.w / 2, z + DOORWAY.w / 2]
      const top = level === 0 && upper ? U - SLAB : 1e3
      const a = rect(p - PART / 2, p + PART / 2, M.z0, gap[0]), b = rect(p - PART / 2, p + PART / 2, gap[1], M.z1), lintel = rect(p - PART / 2, p + PART / 2, gap[0], gap[1])
      solids.push(box(a, f, top, 'wall'), box(b, f, top, 'wall'), box(lintel, f + DOORWAY.h, top, 'wall'))
      partitions.push({ level, x: p, z0: M.z0, z1: M.z1, gap, y0: f, y1: top })
      keeps[level].push(rect(p - 1.0, p + 1.0, gap[0] - 0.15, gap[1] + 0.15))
      anchors[level].push({ x: p - 0.6, z }, { x: p + 0.6, z })
    }
  }

  // --- rooms and what each is for ----------------------------------------------
  const rooms = []
  const addRoom = (level, r, role) => rooms.push({ id: rooms.length, level, floor: level ? U : 0, rect: r, role, kind: null })
  for (const level of upper ? [0, 1] : [0]) {
    const xs = partitions.filter((p) => p.level === level).map((p) => p.x).sort((a, b) => a - b)
    const edges = [M.x0, ...xs, M.x1]
    for (let i = 0; i + 1 < edges.length; i++) addRoom(level, rect(i === 0 ? M.x0 : edges[i] + PART / 2, i + 2 === edges.length ? M.x1 : edges[i + 1] - PART / 2, M.z0, M.z1), 'main')
  }
  for (const c of cells) if (c.role !== 'main') addRoom(0, c.r, c.role)
  const roomAt = (level, x, z) => {
    const r = townRoomAt({ rooms }, level, x, z)
    if (!r) throw new Error(`rollTownInterior: no room at (${x.toFixed(2)}, ${z.toFixed(2)}) on level ${level}`)
    return r
  }
  const hall = roomAt(0, doorIn.x, doorIn.z)
  const kitchen = roomAt(0, hearth.cook.x, hearth.cook.z)
  hall.kind = 'hall'
  kitchen.kind = kitchen === hall ? 'hall' : 'kitchen'
  hall.hearth = kitchen === hall
  kitchen.hearth = true
  for (const r of rooms) {
    if (r.kind) continue
    if (r.level === 1) r.kind = chance(0.8) ? 'bedroom' : 'workroom'
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
    const zc = (p.gap[0] + p.gap[1]) / 2
    doorways.push({ level: p.level, y0: p.y0, y1: p.y0 + DOORWAY.h, a: roomAt(p.level, p.x - 0.4, zc).id, b: roomAt(p.level, p.x + 0.4, zc).id, ...rect(p.x - PART / 2, p.x + PART / 2, p.gap[0], p.gap[1]) })
  }
  for (const w of windows) w.room = roomAt(w.level, w.x - w.nx * 0.3, w.z - w.nz * 0.3).id

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
  for (const w of windows) mark(w.level, strip({ axis: w.axis, at: w.at, ix: -w.nx, iz: -w.nz }, w.u - w.w / 2 - 0.1, w.u + w.w / 2 + 0.1, 0, 0.7), WIN)

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
  const reaches = (level) => {
    const seen = flood(walkable(level), anchors[level][0])
    return anchors[level].every((a) => seen[cellOf(a.x, a.z)] === 1)
  }
  for (const level of levels) if (!reaches(level)) throw new Error(`rollTownInterior: house ${index}'s level ${level} is cut in two before it is furnished`)

  // --- furnishing ------------------------------------------------------------------
  const items = [], candles = [], spots = []
  const tx = (level, fn) => {
    const g = grids[level].slice(), ni = items.length, ns = solids.length, nc = candles.length, np = spots.length
    if (fn() !== false && reaches(level)) return true
    grids[level].set(g)
    items.length = ni; solids.length = ns; candles.length = nc; spots.length = np
    return false
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
  const seat = (rm, x, z, top, look, stand, kind = 'seat') => spots.push({ kind, x, z, top: rm.floor + top, r: 0.22, lookX: look[0], lookZ: look[1], standX: stand.x, standZ: stand.z, level: rm.level, room: rm.id })
  const edgesOf = (rm) => Object.values(lines(rm.rect))

  /** Places along `rm`'s walls for something `hx` wide and `hz` deep with its back to the wall, kept clear `front` before it. */
  const atWall = (rm, hx, hz, { front = 0.7, tall = false, gap = 0.02 } = {}) => {
    const out = []
    const mask = SOLID | KEEP | (tall ? WIN | HUNG : 0)
    for (const e of edgesOf(rm)) {
      for (let u = e.lo + hx + 0.05; u <= e.hi - hx - 0.05; u += 0.1) {
        const c = pt(e, u, hz + gap), r = footprint(c.x, c.z, e.yaw, hx, hz)
        if (!clear(rm.level, r, mask)) continue
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
  }
  const shelf = (rm, hx = range(0.45, 0.7)) => {
    for (const e of shuffle(edgesOf(rm))) {
      for (const u of shuffle(Array.from({ length: Math.max(0, Math.floor((e.hi - e.lo - 2 * hx - 0.6) / 0.2)) }, (_, i) => e.lo + hx + 0.3 + i * 0.2))) {
        const band = strip(e, u - hx, u + hx, 0, 0.4)
        if (!clear(rm.level, band, WIN | HUNG | KEEP)) continue
        const y = rm.floor + range(1.35, 1.6)
        const wallTop = levelCeilingAt(room, rm.level, pt(e, u, 0.1).x, pt(e, u, 0.1).z)
        if (wallTop < y + 0.5) continue
        const at = pt(e, u, 0.13), load = []
        const kinds = SHELF_LOAD[rm.kind] || SHELF_LOAD.parlour
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
        const y = rm.floor + 1.75, at = pt(e, u, 0.12)
        if (levelCeilingAt(room, rm.level, at.x, at.z) < y + 0.5) continue
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
    items.push({ kind: 'rug', x: (r.x0 + r.x1) / 2, y: rm.floor, z: (r.z0 + r.z1) / 2, hx: (r.x1 - r.x0) / 2, hz: (r.z1 - r.z0) / 2, hue: rng(), stripes: 2 + Math.floor(rng() * 4), room: rm.id })
  }

  /** A long table in the middle of `rm`, with chairs or benches down its sides, a place laid at each seat. */
  const table = (rm, share) => {
    const R = rm.rect, wx = R.x1 - R.x0, wz = R.z1 - R.z0, along = wx >= wz ? 'x' : 'z'
    const want = clamp(Math.max(wx, wz) * share, 0.75, 1.4), hw = range(0.42, 0.5), endsWanted = chance(0.6)
    const yaw = along === 'x' ? 0 : Math.PI / 2
    // The biggest table that fits: shorter, then without its end chairs.
    let hl, ends, gx, gz, cands = []
    for (const [scale, e] of [[1, endsWanted], [0.8, endsWanted], [0.8, false], [0.6, false]]) {
      hl = Math.max(0.6, want * scale)
      ends = e
      const gl = hl + (ends ? 0.75 : 0.15), gw = hw + 0.8
      ;[gx, gz] = along === 'x' ? [gl, gw] : [gw, gl]
      for (let x = R.x0 + gx + 0.6; x <= R.x1 - gx - 0.6; x += 0.15) for (let z = R.z0 + gz + 0.6; z <= R.z1 - gz - 0.6; z += 0.15) {
        if (!clear(rm.level, rect(x - gx - 0.6, x + gx + 0.6, z - gz - 0.6, z + gz + 0.6), SOLID) || !clear(rm.level, rect(x - gx, x + gx, z - gz, z + gz), KEEP)) continue
        cands.push({ x, z, score: Math.hypot(x - (R.x0 + R.x1) / 2, z - (R.z0 + R.z1) / 2) + rng() * 0.8 })
      }
      if (cands.length) break
    }
    cands.sort((a, b) => a.score - b.score)
    const ax = along === 'x' ? [1, 0] : [0, 1], side = along === 'x' ? [0, 1] : [1, 0]
    const top = 0.78, y = rm.floor + top
    for (const at of cands.slice(0, 6)) {
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
            seat(rm, c.x, c.z, 0.46, look, { x: c.x - look[0] * 0.65, z: c.z - look[1] * 0.65 })
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
          seat(rm, c.x, c.z, 0.46, look, { x: c.x - look[0] * 0.65, z: c.z - look[1] * 0.65 })
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

  const worktable = (rm) => {
    const got = standing(rm, 'worktable', range(0.7, 0.95), 0.36, 0.86, {}, { front: 1.0 })
    if (!got) return
    const { item, c } = got
    spots.push({ kind: 'cook', x: c.x, z: c.z, standX: pt(c.e, c.u, 0.72 + 0.5).x, standZ: pt(c.e, c.u, 0.72 + 0.5).z, lookX: -c.e.ix, lookZ: -c.e.iz, level: rm.level, room: rm.id })
    solids[solids.length - 1].y1 = rm.floor + BLOCK
    const y = rm.floor + item.top
    for (let s = -item.hx + 0.18; s < item.hx - 0.12; s += range(0.25, 0.4)) {
      const p = pt(c.e, c.u + s, 0.36)
      thing(rm, pick(['bowl', 'loaf', 'crock', 'cabbage', 'board', 'jar']), p.x, y, p.z)
    }
    if (chance(0.6)) { const p = pt(c.e, c.u + item.hx - 0.12, 0.2); candle(rm, p.x, y, p.z, 'dish', 0.7) }
  }

  const furnish = {
    hall(rm) {
      const many = plan.kind === 'inn'
      table(rm, many ? 0.13 : 0.2)
      if (many) { table(rm, 0.13); if (chance(0.5)) table(rm, 0.12) }
      if (rm.sleeps) furnish.bedroom(rm, 1)
      standing(rm, 'dresser', range(0.6, 0.8), 0.26, range(1.8, 2.0), { load: 'plates' }, { front: 0.8 })
      shelf(rm)
      if (chance(0.5)) shelf(rm)
      if (chance(0.4)) { const a = corner(rm, 'armchair', 0.45, 0.45); if (a) seat(rm, a.item.x, a.item.z, 0.45, a.look, { x: a.item.x + a.look[0] * 0.75, z: a.item.z + a.look[1] * 0.75 }) }
      if (rm.hearth) furnish.kitchen(rm, true)
    },
    kitchen(rm, shared = false) {
      spots.push({ kind: 'cook', x: hearth.fire.x, z: hearth.fire.z, standX: hearth.cook.x, standZ: hearth.cook.z, lookX: -hearth.ix, lookZ: -hearth.iz, level: 0, room: rm.id })
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
      for (let b = 0; b < n; b++) {
        const wid = b === 0 && chance(0.5) ? 1.45 : 1.0, len = 2.05, top = 0.55
        const cands = shuffle(atWall(rm, wid / 2, len / 2, { front: 0.5 })).filter((c) => ceilOver(rm, c.r) >= 1.4)
        let placed = false
        for (const c of cands.slice(0, 16)) {
          const pillow = [c.e.ix * -1, c.e.iz * -1], acr = [pillow[1], -pillow[0]]
          const sides = shuffle([1, -1]).map((s) => {
            const mid = { x: c.x + acr[0] * s * (wid / 2 + 0.45), z: c.z + acr[1] * s * (wid / 2 + 0.45) }
            return { s, mid, keep: footprint(mid.x, mid.z, c.yaw, 0.35, len / 2 - 0.2) }
          }).filter((sd) => clear(rm.level, sd.keep, SOLID))
          if (sides.length === 0) continue
          const sd = sides[0]
          const yaw = c.yaw + Math.PI
          const item = { kind: 'bed', x: c.x, z: c.z, yaw, len, wid, top, blanket: rng(), pillows: wid > 1.2 ? 2 : 1, posts: chance(0.3), hue: rng() }
          const ok = tx(rm.level, () => {
            put(rm, item, c.r, top, { keep: sd.keep })
            spots.push({ kind: 'bed', x: c.x, z: c.z, top: rm.floor + top, floor: rm.floor, yaw, len, wid, lookX: Math.sin(yaw), lookZ: Math.cos(yaw), standX: sd.mid.x, standZ: sd.mid.z, level: rm.level, room: rm.id })
          })
          if (!ok) continue
          placed = true
          const foot = { x: c.x - pillow[0] * (len / 2 + 0.3), z: c.z - pillow[1] * (len / 2 + 0.3) }
          const fr = footprint(foot.x, foot.z, c.yaw, Math.min(0.45, wid / 2 - 0.05), 0.24)
          if (clear(rm.level, fr, SOLID | KEEP) && ceilOver(rm, fr) > 0.9) tx(rm.level, () => put(rm, { kind: 'chest', x: foot.x, z: foot.z, yaw: c.yaw + Math.PI, hx: Math.min(0.45, wid / 2 - 0.05), hz: 0.24, top: 0.5, hue: rng() }, fr, 0.5))
          const st = { x: c.x - acr[0] * sd.s * (wid / 2 + 0.28) + pillow[0] * (len / 2 - 0.3), z: c.z - acr[1] * sd.s * (wid / 2 + 0.28) + pillow[1] * (len / 2 - 0.3) }
          const sr = rect(st.x - 0.18, st.x + 0.18, st.z - 0.18, st.z + 0.18)
          if (clear(rm.level, sr, SOLID | KEEP) && ceilOver(rm, sr) > 1.0 && tx(rm.level, () => put(rm, { kind: 'stool', x: st.x, z: st.z, yaw: 0, r: 0.18, top: 0.5, hue: rng() }, sr, 0.5))) candle(rm, st.x, rm.floor + 0.5, st.z, 'dish', 0.7)
          if (chance(0.5)) rug(rm, sd.mid.x, sd.mid.z, Math.abs(acr[0]) > 0.5 ? 0.45 : 0.8, Math.abs(acr[0]) > 0.5 ? 0.8 : 0.45)
          break
        }
        if (!placed) break
      }
      if (chance(0.45)) standing(rm, 'press', 0.6, 0.3, 1.95, {}, { front: 0.7 })
      if (chance(0.4)) shelf(rm)
    },
  }
  // Bedrooms first, so their beds have the walls; a house with none sleeps in its hall, after the table.
  const bedrooms = rooms.filter((rm) => rm.kind === 'bedroom')
  hall.sleeps = bedrooms.length === 0
  for (const rm of [...bedrooms, ...rooms.filter((rm) => rm.kind !== 'bedroom')]) furnish[rm.kind](rm)
  for (const rm of rooms) if (!candles.some((c) => c.room === rm.id) && !sconce(rm)) throw new Error(`rollTownInterior: room ${rm.id} (${rm.kind}) of house ${index} has no light and no wall for a sconce`)

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
