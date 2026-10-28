// What stands in a castle: props in the court (baked into the exterior) and in every room (the interior), as records
// { kind, x, y, z, yaw, w, d } -- plan centre, floor height, yaw about +y, footprint. Pure and deterministic per layout.
// Every portal (door, stair, ladder, flight foot) keeps a clear disc, and every pair of a room's portals keeps a clear lane
// between them, so no prop blocks the maze. Interior records are in interior metres (exterior times CASTLE.scale).
import { mulberry32 } from '../../sim/mathx.js'
import { CASTLE } from './layout.js'

const C = CASTLE.cell, H = CASTLE.storey, S = CASTLE.scale
// Footprints [w, d] in metres; the mesher in shell.js draws each kind.
export const PROP = {
  barrel: [0.7, 0.7], crate: [0.8, 0.8], sacks: [0.9, 0.6], bench: [1.8, 0.45], table: [2.4, 1.0], longtable: [4.2, 1.1], stool: [0.45, 0.45],
  bed: [1.0, 2.0], chest: [1.0, 0.6], rack: [1.6, 0.4], shelf: [1.4, 0.4], hay: [1.2, 0.8], cart: [1.6, 2.6], well: [1.6, 1.6],
  dummy: [0.6, 0.6], throne: [1.0, 0.9], brazier: [0.6, 0.6], banner: [1.2, 0.1], woodpile: [1.6, 0.7],
}
// What each room is for, by section kind and storey (k counted from the ground; `top` the highest storey), and what fills it.
const ROLE = {
  keep: (k, top) => (k === 0 ? 'store' : k === 1 ? 'great' : k === top ? 'solar' : 'barracks'),
  hall: (k) => (k === 0 ? 'great' : 'barracks'),
  gate: (k) => (k === 0 ? 'passage' : 'guard'),
  tower: (k, top) => (k === 0 ? 'store' : k === top ? 'armoury' : 'barracks'),
  lookout: () => 'store',
}
const WALL_KINDS = {
  store: ['barrel', 'barrel', 'crate', 'crate', 'sacks', 'woodpile'],
  great: ['bench', 'shelf', 'brazier', 'banner', 'chest'],
  solar: ['chest', 'shelf', 'banner', 'brazier'],
  barracks: ['bed', 'bed', 'bed', 'chest', 'rack'],
  guard: ['rack', 'bench', 'chest', 'barrel'],
  armoury: ['rack', 'rack', 'chest', 'barrel', 'crate'],
  passage: ['brazier'],
}
const COURT_KINDS = ['barrel', 'barrel', 'crate', 'hay', 'cart', 'rack', 'dummy', 'woodpile', 'sacks']
const CLEAR = 1.3, LANE = 0.75, GAP = 0.15

/** Distance from p to segment ab, in plan. */
function segDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz)
}

/** A footprint's plan corners. */
const cornersOf = (x, z, yaw, w, d) => {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => [x + u * c + v * s, z - u * s + v * c])
}

/** Places props along the inside of rect r [x0, z0, x1, z1] (or a disc when `round`), their backs to the walls, then a centre
 * piece; nothing within CLEAR of a portal, LANE of a lane between portals, or overlapping what is placed. */
function fillRect(rng, r, round, portals, kinds, y, centre, out, cap = Infinity) {
  const placed = out.map((o) => ({ x: o.x, z: o.z, fp: [o.w / 2, o.d / 2] })), n0 = out.length
  const lanes = []
  for (let i = 0; i < portals.length; i++) for (let j = i + 1; j < portals.length; j++) lanes.push([portals[i], portals[j]])
  const free = (pts, cx, cz) => pts.every((p) => portals.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > CLEAR) && lanes.every(([a, b]) => segDist(p, a, b) > LANE))
    && [[cx, cz], ...pts].every((p) => portals.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > CLEAR))
    && placed.every((o) => Math.hypot(cx - o.x, cz - o.z) > (Math.max(...o.fp) + Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cz)))) * 0.7 + GAP)
  const put = (kind, x, z, yaw) => {
    const [w, d] = PROP[kind], pts = cornersOf(x, z, yaw, w, d)
    if (out.length - n0 >= cap || !free(pts, x, z)) return false
    placed.push({ x, z, fp: [w / 2, d / 2] })
    out.push({ kind, x, y, z, yaw, w, d })
    return true
  }
  const [x0, z0, x1, z1] = r, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
  const tries = Math.round(((x1 - x0) + (z1 - z0)) * 0.8)
  for (let t = 0; t < tries; t++) {
    const kind = kinds[Math.floor(rng() * kinds.length)], [w, d] = PROP[kind]
    if (round) {
      const R = (x1 - x0) / 2, a = rng() * Math.PI * 2, rr = R - d / 2 - 0.1
      put(kind, cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, Math.atan2(Math.cos(a), Math.sin(a)) + Math.PI)
      continue
    }
    // A wall, then a spot along it; the prop's back (its -d side) to the wall.
    const side = Math.floor(rng() * 4), u = rng()
    const [x, z, yaw] = side === 0 ? [x0 + (x1 - x0) * u, z0 + d / 2 + 0.05, 0] : side === 1 ? [x0 + (x1 - x0) * u, z1 - d / 2 - 0.05, Math.PI]
      : side === 2 ? [x0 + d / 2 + 0.05, z0 + (z1 - z0) * u, Math.PI / 2] : [x1 - d / 2 - 0.05, z0 + (z1 - z0) * u, -Math.PI / 2]
    const along = side < 2 ? x1 - x0 : z1 - z0
    if (w + 0.2 > along) continue
    put(kind, x, z, yaw)
  }
  if (centre && !round) {
    const along = x1 - x0 >= z1 - z0, yaw = along ? 0 : Math.PI / 2
    for (const kind of centre) if (put(kind, cx, cz, yaw)) {
      if (kind === 'longtable' || kind === 'table') {
        const [w, d] = PROP[kind], off = d / 2 + 0.35
        for (const s of [-1, 1]) put('bench', cx + (along ? 0 : s * off), cz + (along ? s * off : 0), yaw)
      }
      break
    }
  }
}

/** The court's props, in exterior metres on the court floor (y 0). */
export function courtProps(lay) {
  const rng = mulberry32(lay.seed * 6271 + 3), out = [], portals = []
  for (const e of lay.edges) {
    for (const d of e.doors) if (d.y === 0) portals.push([d.x + (d.axis === 'x' ? d.side * 1.2 : 0), d.z + (d.axis === 'z' ? d.side * 1.2 : 0)])
    if (e.flight) {
      const f = e.flight, cm = (f.c0 + f.c1) / 2, lo = Math.min(f.a0, f.a1), hi = Math.max(f.a0, f.a1)
      // A flight is solid from foot to landing: keep its whole length clear, and its foot.
      for (let a = lo; a <= hi + 1e-6; a += 0.8) portals.push(f.axis === 'x' ? [a, cm] : [cm, a])
      const foot = f.a0 - Math.sign(f.a1 - f.a0) * 0.8
      portals.push(f.axis === 'x' ? [foot, cm] : [cm, foot])
    }
  }
  const cells = []
  for (let x = 0; x < lay.cw; x++) for (let z = 0; z < lay.cd; z++) if (!lay.occAt(x, z)) cells.push([x, z])
  for (const [gx, gz] of cells) {
    const r = [lay.X(gx), lay.Z(gz), lay.X(gx + 1), lay.Z(gz + 1)]
    // Only the cells on the court's rim hold props against the masonry; the open middle stays a yard.
    const rim = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => lay.occAt(gx + dx, gz + dz))
    if (!rim) continue
    const n0 = out.length
    fillRect(rng, r, false, portals.filter((p) => p[0] > r[0] - 3 && p[0] < r[2] + 3 && p[1] > r[1] - 3 && p[1] < r[3] + 3), COURT_KINDS, 0, null, out)
    // A cell's props hug the masonry it borders: drop any that faces open court.
    for (let i = out.length - 1; i >= n0; i--) {
      const o = out[i], bx = o.x - Math.sin(o.yaw) * (o.d / 2 + 0.3), bz = o.z - Math.cos(o.yaw) * (o.d / 2 + 0.3)
      if (!lay.occAt(Math.floor((bx - lay.X(0)) / C), Math.floor((bz - lay.Z(0)) / C))) out.splice(i, 1)
    }
  }
  // A well in the court's middle cell when the yard is three cells deep and wide.
  if (lay.cw >= 3 && lay.cd >= 3) {
    const gx = Math.floor(lay.cw / 2), gz = Math.floor(lay.cd / 2), x = lay.X(gx + 0.5), z = lay.Z(gz + 0.5)
    if (!lay.occAt(gx, gz) && portals.every((p) => Math.hypot(p[0] - x, p[1] - z) > 2.2) && !out.some((o) => Math.hypot(o.x - x, o.z - z) < 2)) out.push({ kind: 'well', x, y: 0, z, yaw: 0, w: 1.6, d: 1.6 })
  }
  return out
}

/** Every room's props, in interior metres; each record also carries its storey `k`. */
export function roomProps(lay) {
  const out = [], INSET = 0.4
  let throned = false
  lay.nodes.forEach((n, ni) => {
    if (n.kind !== 'room') return
    const rng = mulberry32(lay.seed * 4099 + ni)
    const role = ROLE[n.sec.kind](n.k, n.sec.floors - 1)
    const ex = [lay.X(n.x0), lay.Z(n.z0), lay.X(n.x0 + n.w), lay.Z(n.z0 + n.d)]
    const r = [(ex[0] + INSET) * S + 0.3, (ex[1] + INSET) * S + 0.3, (ex[2] - INSET) * S - 0.3, (ex[3] - INSET) * S - 0.3]
    const portals = []
    for (const e of lay.edges) {
      if (e.a !== n && e.b !== n) continue
      for (const d of e.doors) if (Math.abs(d.y - n.k * H) < 0.1) portals.push([d.x * S, d.z * S])
      // A stair climbs from its foot room and arrives in the one above through its hole; both keep it clear.
      if (e.stair) portals.push([e.stair.x * S, e.stair.z * S], [e.stair.x * S, e.stair.z * S])
      if (e.ladder) portals.push([e.ladder.x * S, e.ladder.z * S])
    }
    const centre = role === 'great' ? ['longtable', 'table'] : role === 'solar' ? ['bed'] : role === 'guard' ? ['table'] : null
    const list = []
    if (role === 'great' && n.sec.kind === 'keep' && !throned) {
      fillRect(rng, r, n.sec.round, portals, ['throne'], n.k * H * S, null, list, 1)
      throned = list.length > 0
    }
    fillRect(rng, r, n.sec.round, portals, WALL_KINDS[role], n.k * H * S, centre, list)
    for (const o of list) out.push({ ...o, k: n.k })
  })
  return out
}
