// The dungeon drawn (design/44-castles.md, Dungeon): its cells' floors, walls and ceilings, the spiral down, its props, and the
// water and the locked door as their own meshes. Light is baked into light.js's [fill, torch, window] channels from its sconces and
// the stairwell, shadowed through the grid, so the maze is dark between them. Interior metres, as shell.js.
import { DUNGEON, dungeonCell, dungeonPlan } from './dungeon.js'
import { dungeonProps, propFlames } from './furnish.js'
import { Mesher, interiorWarp, leaves, prop, rgb, spiralSteps } from './shell.js'
import { faceShade } from './light.js'

const ROCK = rgb(0x77716a), FLOOR = rgb(0x5f5a52), SILT = rgb(0x4a4a3c), WATER = rgb(0x24403f), MOSS = rgb(0x4d6338), IRON = rgb(0x3a3836)
const LIGHT = { amb: 0.24, power: 1.25, reach: 2.6, far: 14, step: 0.5, off: 0.3 }
const JITTER = { amp: 0.15, clear: 1.5, ramp: 2 }

/** Whether interior point (x, y, z) is in the dungeon's air; the foot's ceiling is the ground floor's slab. */
function inAir(g, x, y, z) {
  const c = dungeonCell(g, x, z)
  if (c < 0 || Number.isNaN(g.lo[c])) return false
  return y > g.lo[c] - 0.01 && y < (g.roof[c] ? g.hi[c] : 0) + 0.01
}

/** Light at a point with normal n: [ambient, the lights it sees, 0]. */
function lightAt(g, lights, p, n) {
  const q = [p[0] + n[0] * LIGHT.off, p[1] + n[1] * LIGHT.off, p[2] + n[2] * LIGHT.off]
  let sum = 0
  for (const l of lights) {
    const dx = l[0] - q[0], dy = l[1] - q[1], dz = l[2] - q[2], d = Math.hypot(dx, dy, dz)
    if (d > LIGHT.far || dx * n[0] + dy * n[1] + dz * n[2] < -0.05 * d) continue
    let seen = true
    for (let t = LIGHT.step; t < d - 0.2 && seen; t += LIGHT.step) seen = inAir(g, q[0] + dx * t / d, q[1] + dy * t / d, q[2] + dz * t / d)
    if (seen) sum += LIGHT.power / (1 + (d / LIGHT.reach) ** 2)
  }
  return [LIGHT.amb, sum, 0]
}

/** The dungeon's mesh arrays, its water's (null when it has none) and its locked door's. */
export function dungeonGeometry(lay) {
  const g = dungeonPlan(lay), { x0, z0, W, D, lo, hi, water, roof } = g, F = DUNGEON.floor
  const m = new Mesher(lay.seed * 53 + 11), wm = new Mesher(lay.seed * 53 + 12)
  const open = (i, j) => i >= 0 && i < W && j >= 0 && j < D && !Number.isNaN(lo[i + j * W])
  const wetNear = (i, j) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => open(i + a, j + b) && !Number.isNaN(water[i + a + (j + b) * W]))
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const c = i + j * W
    if (!open(i, j)) continue
    const xa = x0 + i, xb = xa + 1, za = z0 + j, zb = za + 1, y0 = lo[c], y1 = roof[c] ? hi[c] : -0.3, wet = !Number.isNaN(water[c])
    m.quad([xa, y0, za], [xb, y0, za], [xb, y0, zb], [xa, y0, zb], m.tint(wet ? SILT : FLOOR, 0.12), [0, 1, 0])
    if (wet) { const w = water[c]; wm.quad([xa, w, za], [xb, w, za], [xb, w, zb], [xa, w, zb], WATER, [0, 1, 0], [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]) }
    if (roof[c]) m.quad([xa, y1, za], [xb, y1, za], [xb, y1, zb], [xa, y1, zb], m.tint(ROCK), [0, -1, 0])
    // Each side: rock the full height, or the step up to a higher floor or down to a lower ceiling next door, drawn from this side.
    for (const [di, dj, P, Q] of [[-1, 0, [xa, za], [xa, zb]], [1, 0, [xb, za], [xb, zb]], [0, -1, [xa, za], [xb, za]], [0, 1, [xa, zb], [xb, zb]]]) {
      const n = [-di, 0, -dj], col = m.tint(ROCK)
      const wall = (ya, yb) => yb - ya > 0.005 && m.quad([P[0], ya, P[1]], [Q[0], ya, Q[1]], [Q[0], yb, Q[1]], [P[0], yb, P[1]], col, n)
      if (!open(i + di, j + dj)) { wall(y0, y1); continue }
      const o = i + di + (j + dj) * W
      wall(y0, Math.min(lo[o], y1))
      wall(Math.max(roof[o] ? hi[o] : -0.3, y0), y1)
    }
  }
  spiralSteps(m, g.foot.x, g.foot.z, F, !lay.edges.some((e) => e.stair && e.stair.k === 0 && e.stair.x === g.stair.x && e.stair.z === g.stair.z))

  // Props drawn where they stand, so they bake against the grid; each moves with its own origin after.
  const records = dungeonProps(lay), moved = []
  for (const o of records) {
    const before = m.bufs.map((b) => b.p.length)
    prop(m, o)
    moved.push({ o, spans: m.bufs.map((b, s) => [before[s], b.p.length]) })
  }

  // Bake: sconce flames and a light down the stairwell. A prop takes the light over the floor at its origin.
  const lights = propFlames(records).reduce((a, v, i, all) => (i % 5 ? a : [...a, all.slice(i, i + 3)]), []).concat([[g.foot.x, -1.5, g.foot.z]])
  const propLight = m.bufs.map((b) => new Array(b.p.length / 3).fill(null))
  for (const { o, spans } of moved) {
    const L = lightAt(g, lights, [o.x, o.y, o.z], [0, 1, 0])
    spans.forEach(([a, e], s) => { for (let v = a; v < e; v += 3) propLight[s][v / 3] = L })
  }
  m.bufs.forEach((b, s) => {
    for (let v = 0; v < b.p.length; v += 3) {
      const p = [b.p[v], b.p[v + 1], b.p[v + 2]], n = [b.n[v], b.n[v + 1], b.n[v + 2]], L = propLight[s][v / 3] || lightAt(g, lights, p, n), f = faceShade(n)
      b.l.push(L[0] * f, L[1] * f, 0)
      if (propLight[s][v / 3]) continue
      const ci = Math.floor(p[0] + n[0] * 0.3 - x0), cj = Math.floor(p[2] + n[2] * 0.3 - z0)
      const moss = p[1] < F + 0.5 && wetNear(ci, cj) ? 0.55 * Math.min(1, (F + 0.5 - p[1]) / 0.9) : 0
      for (let k = 0; k < 3; k++) b.c[v + k] = b.c[v + k] * (1 - moss) + MOSS[k] * moss
    }
  })
  for (const b of wm.bufs) for (let v = 0; v < b.p.length; v += 3) b.l.push(...lightAt(g, lights, [b.p[v], b.p[v + 1], b.p[v + 2]], [0, 1, 0]))

  // Warp: walls bent as the castle's and their high parts jittered, but never by the foot or door, whose stone meets other meshes.
  const warp = interiorWarp(lay), [fi0, fj0, fi1, fj1] = g.foot.cells, { door } = g
  const near = [[x0 + fi0, z0 + fj0, x0 + fi1, z0 + fj1], [door.x - 1.5, door.z - 1.5, door.x + 1.5, door.z + 1.5]]
  const jitter = (x, y, z) => {
    const d = Math.min(...near.map(([a, b, c, e]) => Math.hypot(Math.max(a - x, 0, x - c), Math.max(b - z, 0, z - e))))
    const fade = Math.min(1, Math.max(0, (d - JITTER.clear) / JITTER.ramp)) * Math.min(1, Math.max(0, (y - F - 0.6) / 0.8))
    return fade && JITTER.amp * fade * Math.sin(x * 1.7 + z * 0.6 + lay.seed) * Math.cos(z * 1.3 - x * 0.45)
  }
  const isProp = m.bufs.map((b) => new Uint8Array(b.p.length / 3))
  for (const { o, spans } of moved) {
    const [wx, , wz] = warp(o.x, o.y, o.z)
    spans.forEach(([a, e], s) => { for (let v = a; v < e; v += 3) { m.bufs[s].p[v] += wx - o.x; m.bufs[s].p[v + 2] += wz - o.z; isProp[s][v / 3] = 1 } })
  }
  m.bufs.forEach((b, s) => {
    for (let v = 0; v < b.p.length; v += 3) {
      if (isProp[s][v / 3]) continue
      const [x, y, z] = b.p.slice(v, v + 3), [wx, , wz] = warp(x, y, z)
      b.p[v] = wx; b.p[v + 1] = y + jitter(x, y, z); b.p[v + 2] = wz
    }
  })

  for (const b of wm.bufs) for (let v = 0; v < b.p.length; v += 3) { const [wx, , wz] = warp(b.p[v], b.p[v + 1], b.p[v + 2]); b.p[v] = wx; b.p[v + 2] = wz }
  const wet = wm.arrays()
  return { geometry: m.arrays(), water: wet.position.length ? wet : null, door: doorGeometry(lay, g, warp) }
}

/** The locked door: its leaves both ways in the doorway, an iron lock plate on each face, lit as by the sconce beside it. */
function doorGeometry(lay, g, warp) {
  const m = new Mesher(lay.seed * 59 + 3, warp), { door } = g, n = door.axis === 'x' ? [door.side, 0, 0] : [0, 0, door.side]
  m.fixed = [LIGHT.amb, 0.5, 0]
  for (const s of [1, -1]) {
    const nn = n.map((v) => v * s), base = [door.x + nn[0] * 0.04, door.lo, door.z + nn[2] * 0.04]
    leaves(m, base, nn, door.hw, door.hi - door.lo, false, ROCK)
    const r = [nn[2], 0, -nn[0]], at = [base[0] + r[0] * 0.6 + nn[0] * 0.02, base[1] + 1.1, base[2] + r[2] * 0.6 + nn[2] * 0.02]
    m.box(at[0] - 0.09, at[1] - 0.12, at[2] - 0.09, at[0] + 0.09, at[1] + 0.12, at[2] + 0.09, IRON)
  }
  return m.arrays()
}
