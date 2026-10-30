// Castle rooms' baked light (design/44-castles.md, Light): each vertex carries [fill, torch, window] for render/castles.js's shader,
// which scales the window channel by the hour. Plain data, so it runs in the castle worker. Interior metres, unwarped.
import { mulberry32 } from '../../sim/mathx.js'
import { CASTLE } from './layout.js'
import { propFlames, roomPlan, roomProps } from './furnish.js'

const C = CASTLE.cell, S = CASTLE.scale, SH = CASTLE.storey * CASTLE.tall, INSET = 0.4
// Fill: its level, and each wall, floor or ceiling darkening what is within about `aoReach` of it by up to `ao`.
// Torches: power per flame by its height, fall-off reach, saturation cap, and the share a face lit edge-on keeps (the wall a sconce
// hangs on). Windows: spill per square metre and its reach, and the
// even share a room gets of its windows' area over the square root of its floor's. Doorways pass on `bleed` of what reaches them.
export const BAKE = {
  cell: 2, fill: 0.42, ao: 0.38, aoReach: 0.75,
  torch: { power: 3, reach: 1.0, cap: 1.8, wrap: 0.5 },
  win: { spill: 0.45, reach: 3.5, share: 0.35 },
  bleed: 0.5,
}
// A window pane's window channel; the shader draws any vertex past GLASS as glass lit by the sky alone.
export const PANE = 1.5, GLASS = 1.2
// Window sizes [w, h, sill] on the ground storey, above it, and in the grand rooms.
const PANES = { ground: [0.5, 1.4, 1.8], upper: [1.0, 2.0, 1.4], grand: [1.4, 2.6, 1.2] }
const GRAND = new Set(['throne', 'bedchamber', 'chapel', 'mess'])
// Kinds low enough for a window over them.
const LOW = new Set(['rug', 'carpet', 'dais', 'bench', 'stool', 'chest', 'bucket', 'basket', 'jug', 'bowl', 'loaf', 'cup', 'candle', 'book', 'sacks', 'crate', 'grain', 'veg', 'coal', 'stones', 'cot', 'chair', 'kegs', 'jars'])

/** The unshaded fraction of light a face facing n keeps, by which way it faces. */
export const faceShade = (n) => 0.85 * (n[1] > 0.7 ? 1 : n[1] < -0.7 ? 0.55 : Math.abs(n[0]) > Math.abs(n[2]) ? 0.8 : 0.7)

const plans = new WeakMap()
/** The windows of a layout's chambers: { x, y, z, nx, nz (outward), w, h, ci } with (x, y, z) the pane's foot on the wall's inner
 * face; one per cell side that looks out, where no doorway, stair, ladder or tall prop stands against it. */
export function castleWindows(lay) {
  if (plans.has(lay)) return plans.get(lay)
  const { chambers } = roomPlan(lay), props = roomProps(lay), rng = mulberry32(lay.seed * 8111 + 5), out = []
  const outdoors = (gx, gz, k) => { const by = lay.occAt(gx, gz); return by === null || by.floors <= k }
  chambers.forEach((c, ci) => {
    if (c.role === 'passage') return
    const n = c.node, [w, h, sill] = GRAND.has(c.role) ? PANES.grand : c.k === 0 ? PANES.ground : PANES.upper
    const y = c.k * SH + sill, odds = c.k === 0 ? 0.5 : 0.7
    const clear = (x, z, nx, nz) => c.portals.every((p) => Math.hypot(p[0] - x, p[1] - z) > w / 2 + 1)
      && props.every((o) => o.k !== c.k || LOW.has(o.kind) || Math.abs((o.x - x) * nx + (o.z - z) * nz) > 1.2 || Math.abs((o.x - x) * nz - (o.z - z) * nx) > (Math.max(o.w, o.d) + w) / 2 + 0.2)
    const add = (x, z, nx, nz) => { if (rng() < odds && clear(x, z, nx, nz)) out.push({ x, y, z, nx, nz, w, h, ci }) }
    const [x0, z0, x1, z1] = c.rect
    if (c.round) {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = (x1 - x0) / 2, ecx = cx / S, ecz = cz / S, er = n.w * C / 2 + 1
      for (let i = 0; i < 12; i++) {
        const b = (i + 1) * Math.PI / 6, nx = Math.cos(b), nz = Math.sin(b)
        if (outdoors(Math.floor((ecx + nx * er - lay.X(0)) / C), Math.floor((ecz + nz * er - lay.Z(0)) / C), c.k)) add(cx + nx * r, cz + nz * r, nx, nz)
      }
      return
    }
    // A chamber side on its node's own wall (not a partition) looks out through each cell beyond it that is open air at this storey.
    const air = [(lay.X(n.x0) + INSET) * S + 0.3, (lay.Z(n.z0) + INSET) * S + 0.3, (lay.X(n.x0 + n.w) - INSET) * S - 0.3, (lay.Z(n.z0 + n.d) - INSET) * S - 0.3]
    for (let gx = n.x0; gx < n.x0 + n.w; gx++) {
      const x = lay.X(gx + 0.5) * S
      if (x < x0 || x > x1) continue
      if (Math.abs(z0 - air[1]) < 1e-6 && outdoors(gx, n.z0 - 1, c.k)) add(x, z0, 0, -1)
      if (Math.abs(z1 - air[3]) < 1e-6 && outdoors(gx, n.z0 + n.d, c.k)) add(x, z1, 0, 1)
    }
    for (let gz = n.z0; gz < n.z0 + n.d; gz++) {
      const z = lay.Z(gz + 0.5) * S
      if (z < z0 || z > z1) continue
      if (Math.abs(x0 - air[0]) < 1e-6 && outdoors(n.x0 - 1, gz, c.k)) add(x0, z, -1, 0)
      if (Math.abs(x1 - air[2]) < 1e-6 && outdoors(n.x0 + n.w, gz, c.k)) add(x1, z, 1, 0)
    }
  })
  plans.set(lay, out)
  return out
}

/** The rooms' light: `at(p, n)` [fill, torch, window] at raw interior point p on a face of unit normal n (null: lit from all round),
 * and `split(p, n)` the cell a face centred there is cut into to carry it: 0 for a face no room sees, or one under a ceiling. */
export function interiorLight(lay) {
  const { chambers } = roomPlan(lay), wins = castleWindows(lay), T = BAKE.torch, Wn = BAKE.win
  const flames = propFlames(roomProps(lay))
  const room = chambers.map((c, i) => ({ c, i, lights: [], wins: wins.filter((w) => w.ci === i), share: 0 }))
  const inRect = (r, x, z, m) => x > r[0] - m && x < r[2] + m && z > r[1] - m && z < r[3] + m
  const find = (x, y, z, m) => room.find((q) => q.c.k === Math.floor(y / SH) && inRect(q.c.rect, x, z, m))
  for (let i = 0; i < flames.length; i += 5) {
    const q = find(flames[i], flames[i + 1], flames[i + 2], 0.5)
    if (q) q.lights.push([flames[i], flames[i + 1], flames[i + 2], T.power * Math.min(2, Math.max(0.25, flames[i + 3] / 0.3))])
  }
  for (const q of room) {
    const [x0, z0, x1, z1] = q.c.rect
    q.share = Wn.share * q.wins.reduce((a, w) => a + w.w * w.h, 0) / Math.sqrt((x1 - x0) * (z1 - z0))
  }

  const ao = (q, p, n) => {
    const [x0, z0, x1, z1] = q.c.rect, yF = q.c.k * SH, yC = yF + SH - 0.3
    const term = (d, sx, sy, sz) => (n && n[0] * sx + n[1] * sy + n[2] * sz < -0.5 ? 1 : 1 - BAKE.ao * Math.exp(-Math.max(0, d) / BAKE.aoReach))
    let f = term(p[1] - yF, 0, -1, 0) * term(yC - p[1], 0, 1, 0)
    if (q.c.round) {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, dx = p[0] - cx, dz = p[2] - cz, r = Math.hypot(dx, dz) || 1
      f *= term((x1 - x0) / 2 - r, dx / r, 0, dz / r)
    } else f *= term(p[0] - x0, -1, 0, 0) * term(x1 - p[0], 1, 0, 0) * term(p[2] - z0, 0, 0, -1) * term(z1 - p[2], 0, 0, 1)
    return f
  }
  const torchSum = (q, p, n) => {
    let sum = 0
    for (const [lx, ly, lz, pw] of q.lights) {
      const dx = lx - p[0], dy = ly - p[1], dz = lz - p[2], d = Math.max(0.05, Math.hypot(dx, dy, dz))
      const ndl = n ? Math.max(0, (n[0] * dx + n[1] * dy + n[2] * dz) / d) : 0.6
      sum += pw * (T.wrap + (1 - T.wrap) * ndl) / (1 + (d / T.reach) ** 2)
    }
    return sum
  }
  const winSum = (q, p, n) => {
    let sum = 0
    for (const w of q.wins) {
      const cx = w.x, cy = w.y + w.h / 2, cz = w.z, dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz, d = Math.max(0.05, Math.hypot(dx, dy, dz))
      const lobe = Math.max(0, -(dx * w.nx + dz * w.nz) / d), lam = n ? Math.max(0, -(n[0] * dx + n[1] * dy + n[2] * dz) / d) : 0.6
      sum += Wn.spill * w.w * w.h * lobe * lam / (1 + (d / Wn.reach) ** 2)
    }
    return sum
  }
  // Each doorway two chambers share passes on what reaches it from either side, a light on the other.
  const bleeds = room.map(() => [])
  room.forEach((a, i) => room.forEach((b, j) => {
    if (i === j || a.c.k !== b.c.k) return
    for (const p of a.c.portals) if (b.c.portals.some((o) => Math.abs(o[0] - p[0]) < 0.01 && Math.abs(o[1] - p[1]) < 0.01)) {
      const at = [p[0], a.c.k * SH + 1.5, p[1]]
      bleeds[i].push([...at, BAKE.bleed * torchSum(b, at, null), BAKE.bleed * (winSum(b, at, null) + b.share)])
    }
  }))
  const bleedSum = (i, p, n) => {
    let t = 0, w = 0
    for (const [lx, ly, lz, bt, bw] of bleeds[i]) {
      const dx = lx - p[0], dy = ly - p[1], dz = lz - p[2], d = Math.max(0.05, Math.hypot(dx, dy, dz))
      const f = (0.3 + 0.7 * (n ? Math.max(0, (n[0] * dx + n[1] * dy + n[2] * dz) / d) : 0.6)) / (1 + (d / T.reach) ** 2)
      t += bt * f; w += bw * f
    }
    return [t, w]
  }

  const near = (p, n) => {
    const x = p[0] + (n ? n[0] * 0.15 : 0), y = p[1] + (n ? n[1] * 0.15 : 0.05), z = p[2] + (n ? n[2] * 0.15 : 0)
    return find(x, y, z, 0.05)
  }
  // Grid vertices recur in up to six faces: memoized by centimetre and normal.
  const memo = new Map()
  const at = (p, n) => {
    const key = ((Math.round(p[0] * 100) + 50000) * 8000 + Math.round(p[1] * 100) + 1000) * 100000 + Math.round(p[2] * 100) + 50000
    const nk = n ? (Math.round(n[0] * 20) + 20) * 1681 + (Math.round(n[1] * 20) + 20) * 41 + Math.round(n[2] * 20) + 20 : -1
    let list = memo.get(key)
    if (!list) memo.set(key, list = [])
    for (let i = 0; i < list.length; i += 2) if (list[i] === nk) return list[i + 1]
    const v = bake(p, n)
    list.push(nk, v)
    return v
  }
  const storeys = new Map()
  for (const q of room) { if (!storeys.has(q.c.k)) storeys.set(q.c.k, []); storeys.get(q.c.k).push(q) }
  const bake = (p, n) => {
    let q = near(p, n)
    if (!q) {
      // Thresholds, jambs and the faces no room sees: the nearest chamber on the storey.
      const k = Math.floor((p[1] + 0.05) / SH), dist = (r) => Math.hypot(Math.max(r[0] - p[0], 0, p[0] - r[2]), Math.max(r[1] - p[2], 0, p[2] - r[3]))
      const list = storeys.get(k)
      if (!list) return [BAKE.fill * 0.5, 0, 0]
      q = list.reduce((a, b) => (dist(b.c.rect) < dist(a.c.rect) ? b : a))
    }
    const occ = ao(q, p, n), [bt, bw] = bleedSum(q.i, p, n), shade = n ? faceShade(n) : 1
    const t = torchSum(q, p, n) + bt
    return [BAKE.fill * occ * shade, T.cap * (1 - Math.exp(-t / T.cap)), Math.min(1, winSum(q, p, n) + bw + q.share * occ)]
  }
  const split = (p, n) => {
    const q = near(p, n)
    if (!q || (n[1] > 0.5 && p[1] > q.c.k * SH + SH - 0.35)) return 0
    return n[1] < -0.5 ? BAKE.cell * 2 : BAKE.cell
  }
  return { at, split }
}
