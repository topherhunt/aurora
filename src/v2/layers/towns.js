// The overworld's human towns (DESIGN.md §32): where they stand and how each is laid out. Three-free, and a pure function of the heightmap, the authored layers and the seed, so every netplay client builds the same towns and the node gate can hold them to their rules.
//
// Everything on the ground is a generated road (doc.js isGenerated): the clearing is concentric rings, each building stands on an unpainted pad, each door has a path, and 1-2 main roads run out from the clearing. The road machinery then flattens, paints and keeps the scatters off all of it with no town-specific code.
import { planBuilding, KINDS } from '../../buildings/plan.js'
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { WORLD_HALF } from '../config.js'

export const TOWN = {
  site: { grid: 40, slope: 0.2, flatR: 60, flatMax: 16, valleyR: 400, valleyMin: 15, disc: 90, spacing: 900, edge: 300, snowMargin: 60, keepClear: 150 },
  // The import mirror-extends the source past |z| = 3492 (config.js), so towns keep to the real map.
  realZ: 3492,
  count: [8, 25],
  clearing: { r: 5, rings: [1.5, 4], width: 3 },
  road: { width: 2, step: 12, reach: 170, wobble: 1.5, grade: 0.22, past: 12, apart: 60 },
  // A building's rank is its radius plus `cost` per metre of door path, so a door near an existing path beats one nearer the centre with a long walk to it.
  path: { width: 0.8, max: 24, step: 8, cost: 1.5 },
  // Metres between building footprints: base plus per-metre growth past the clearing edge, so the centre packs and the outskirts spread.
  gap: [1.2, 0.08],
  footRange: 3,
  tries: 90,
}

const WALLS_BY_PRESTIGE = ['log', 'stave', 'halfTimber', 'stoneBase', 'masonry']
const ROOFS_BY_PRESTIGE = ['thatch', 'shake', 'pantile', 'slate']
// Buildings' pads are road rings, and the road swell (paths.js SWELL) can narrow a pad to 0.8 of its width.
const SWELL_MIN = 0.8

// Siting candidates, best first: dry, below the snow, on ground flat across flatR and sunk below the valleyR ring around it.
function candidates(ground, layers, keepClear) {
  const S = TOWN.site
  const snow = layers.snow.base - S.snowMargin
  const dry = (x, z, h) => {
    const level = layers.waterLevelAt(x, z)
    return level === null || h > level + 3
  }
  const out = []
  const zMax = TOWN.realZ - S.edge
  const xMax = WORLD_HALF - S.edge
  for (let z = -zMax; z <= zMax; z += S.grid) {
    for (let x = -xMax; x <= xMax; x += S.grid) {
      const h0 = ground(x, z)
      if (h0 > snow || !dry(x, z, h0)) continue
      if (Math.hypot(ground(x + 8, z) - ground(x - 8, z), ground(x, z + 8) - ground(x, z - 8)) / 16 > S.slope) continue
      if (keepClear.some((k) => Math.hypot(x - k.x, z - k.z) < k.r + S.keepClear)) continue
      let lo = h0
      let hi = h0
      for (let dz = -S.flatR; dz <= S.flatR; dz += 20) {
        for (let dx = -S.flatR; dx <= S.flatR; dx += 20) {
          if (dx * dx + dz * dz > S.flatR * S.flatR) continue
          const h = ground(x + dx, z + dz)
          if (h < lo) lo = h
          if (h > hi) hi = h
        }
      }
      if (hi - lo > S.flatMax) continue
      // The grid barely touches the rim, where a valley's walls start.
      for (let k = 0; k < 24; k++) {
        const h = ground(x + Math.cos((k / 24) * Math.PI * 2) * S.flatR, z + Math.sin((k / 24) * Math.PI * 2) * S.flatR)
        if (h < lo) lo = h
        if (h > hi) hi = h
      }
      const range = hi - lo
      if (range > S.flatMax) continue
      let ring = 0
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        ring += ground(x + Math.cos(a) * S.valleyR, z + Math.sin(a) * S.valleyR)
      }
      const valley = ring / 16 - h0
      if (valley < S.valleyMin) continue
      let clear = true
      for (let k = 0; k < 12 && clear; k++) {
        const a = (k / 12) * Math.PI * 2
        for (const r of [0, S.disc / 2, S.disc]) {
          const px = x + Math.cos(a) * r
          const pz = z + Math.sin(a) * r
          const h = ground(px, pz)
          const river = layers.paths.nearest(px, pz, 'river')
          const road = layers.paths.nearest(px, pz, 'road')
          if (!dry(px, pz, h) || (river !== null && river.dist < river.halfWidth * 3 + 10) || (road !== null && road.dist < road.halfWidth + 10)) {
            clear = false
            break
          }
        }
      }
      if (!clear) continue
      out.push({ x, z, score: Math.min(valley, 60) / 40 - range / 4 })
    }
  }
  return out.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z)
}

// --- geometry: oriented boxes in the XZ plane --------------------------------
// A box is { x, z, c, s, hx, hz }: centre, cos/sin of yaw, half extents on its local X and Z. Local +Z maps to world (s, c), the three.js rotation.y convention.

const toLocal = (b, x, z) => {
  const dx = x - b.x
  const dz = z - b.z
  return [dx * b.c - dz * b.s, dx * b.s + dz * b.c]
}

const toWorld = (x, z, yaw, lx, lz) => {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [x + lx * c + lz * s, z - lx * s + lz * c]
}

function pointBoxDist(b, x, z) {
  const [lx, lz] = toLocal(b, x, z)
  return Math.hypot(Math.max(Math.abs(lx) - b.hx, 0), Math.max(Math.abs(lz) - b.hz, 0))
}

export function boxesOverlap(a, b, gap) {
  const axes = [[a.c, -a.s], [a.s, a.c], [b.c, -b.s], [b.s, b.c]]
  for (const [ax, az] of axes) {
    const ra = a.hx * Math.abs(a.c * ax - a.s * az) + a.hz * Math.abs(a.s * ax + a.c * az)
    const rb = b.hx * Math.abs(b.c * ax - b.s * az) + b.hz * Math.abs(b.s * ax + b.c * az)
    if (Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) > ra + rb + gap) return false
  }
  return true
}

// Whether segment p-q passes within `pad` of box b (a slab clip against the padded box).
function segmentHitsBox(b, px, pz, qx, qz, pad = 0) {
  const [ax, az] = toLocal(b, px, pz)
  const [bx, bz] = toLocal(b, qx, qz)
  let t0 = 0
  let t1 = 1
  for (const [p, d, h] of [[ax, bx - ax, b.hx + pad], [az, bz - az, b.hz + pad]]) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(p) > h) return false
      continue
    }
    let u0 = (-h - p) / d
    let u1 = (h - p) / d
    if (u0 > u1) [u0, u1] = [u1, u0]
    t0 = Math.max(t0, u0)
    t1 = Math.min(t1, u1)
    if (t0 > t1) return false
  }
  return true
}

// Nearest point on segment a-b to (x, z): [px, pz, t, dist].
function nearestOnSegment(ax, az, bx, bz, x, z) {
  const ex = bx - ax
  const ez = bz - az
  const len2 = ex * ex + ez * ez
  let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const px = ax + ex * t
  const pz = az + ez * t
  return [px, pz, t, Math.hypot(x - px, z - pz)]
}

// --- one town ------------------------------------------------------------------

// The kinds a town of n buildings holds, most prestigious first.
function roster(n) {
  const inns = n >= 22 ? 2 : n >= 10 ? 1 : 0
  const longhouses = Math.round(n * 0.12)
  const cottages = Math.round(n * 0.45)
  const huts = n - inns - longhouses - cottages
  return [...Array(inns).fill('inn'), ...Array(longhouses).fill('longhouse'), ...Array(cottages).fill('cottage'), ...Array(huts).fill('hut')]
}

// The kind's whitelisted option at prestige p (1 = grandest), from a list ordered humblest first.
function byPrestige(allowed, order, p) {
  const opts = order.filter((o) => allowed.includes(o))
  return opts[Math.min(opts.length - 1, Math.max(0, Math.floor(p * opts.length)))]
}

// The plan's local box: every mass plus the porch and steps out front, grown by the roof overhang. [minX, maxX, minZ, maxZ].
function planBox(plan) {
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (const m of plan.masses) {
    x0 = Math.min(x0, m.cx - m.w / 2)
    x1 = Math.max(x1, m.cx + m.w / 2)
    z0 = Math.min(z0, m.cz - m.d / 2)
    z1 = Math.max(z1, m.cz + m.d / 2)
  }
  const o = plan.overhang
  let front = z1 + o
  if (plan.porch) front = Math.max(front, plan.porch.z + plan.porch.depth)
  if (plan.steps) front = Math.max(front, plan.steps.z + 0.4)
  return [x0 - o, x1 + o, z0 - o, front]
}

function layoutTown(site, index, all, ctx) {
  const { ground, layers, seed } = ctx
  const rand = mulberry32(hash32(seed, 7717, Math.round(site.x), Math.round(site.z)))
  const id = `town${index}`
  const cx = site.x
  const cz = site.z
  const C = TOWN.clearing
  let yC = 0
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2
    yC += ground(cx + Math.cos(a) * C.r * 0.7, cz + Math.sin(a) * C.r * 0.7)
  }
  yC /= 16

  const wet = (x, z, h) => {
    const level = layers.waterLevelAt(x, z)
    if (level !== null && h < level + 1.5) return true
    const river = layers.paths.nearest(x, z, 'river')
    return river !== null && river.dist < river.halfWidth * 3 + 4
  }

  // Main roads: toward the nearest other towns, bearings at least road.apart degrees apart, a random bearing when there is no neighbour to aim at.
  const R = TOWN.road
  const others = all.filter((o) => o !== site).sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))
  const nRoads = rand() < 0.45 ? 2 : 1
  const bearings = []
  for (const o of others) {
    if (bearings.length === nRoads) break
    const a = Math.atan2(o.z - cz, o.x - cx)
    if (bearings.every((b) => angleApart(a, b) >= (R.apart * Math.PI) / 180)) bearings.push(a)
  }
  while (bearings.length < nRoads) bearings.push(bearings.length ? bearings[0] + Math.PI * (0.6 + rand() * 0.8) : rand() * Math.PI * 2)
  // A road runs out until the ground turns wet, steep or meets an authored road; the bearing swings up to 60 degrees either way to find one that gets clear of the town.
  const growRoad = (bearing) => {
    const pts = [[cx + Math.cos(bearing) * C.r * 0.6, yC, cz + Math.sin(bearing) * C.r * 0.6], [cx + Math.cos(bearing) * (C.r + 2), yC, cz + Math.sin(bearing) * (C.r + 2)]]
    let heading = bearing
    let px = pts[1][0]
    let pz = pts[1][2]
    let py = yC
    for (let d = C.r + 2 + R.step; d <= R.reach; d += R.step) {
      heading += (rand() - 0.5) * 0.25
      const nx = px + Math.cos(heading) * R.step
      const nz = pz + Math.sin(heading) * R.step
      const side = (rand() - 0.5) * 2 * R.wobble
      const wx = nx - Math.sin(heading) * side
      const wz = nz + Math.cos(heading) * side
      const wy = ground(wx, wz)
      if (wet(wx, wz, wy) || Math.abs(wy - py) / R.step > R.grade) break
      const authored = layers.paths.nearest(wx, wz, 'road')
      if (authored !== null && authored.dist < authored.halfWidth + R.width + 4) break
      pts.push([wx, wy, wz])
      px = nx
      pz = nz
      py = wy
    }
    return pts
  }
  const roads = []
  for (const bearing of bearings) {
    let best = null
    for (const swing of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) {
      const pts = growRoad(bearing + swing)
      if (best === null || pts.length > best.length) best = pts
      if (pts.length * R.step >= R.reach * 0.6) break
    }
    roads.push(best)
  }

  // The network a door's path may end on: the clearing's edge, the roads, and the paths laid so far (away from their own door end).
  const paths = []
  const nearestNetwork = (x, z) => {
    const dc = Math.hypot(x - cx, z - cz)
    let best = { x: cx + ((x - cx) / dc) * C.r, z: cz + ((z - cz) / dc) * C.r, y: yC, dist: Math.max(0, dc - C.r) }
    for (const pts of roads) {
      for (let i = 1; i < pts.length; i++) {
        const [nx, nz, t, d] = nearestOnSegment(pts[i - 1][0], pts[i - 1][2], pts[i][0], pts[i][2], x, z)
        if (d < best.dist) best = { x: nx, z: nz, y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, dist: d }
      }
    }
    for (const p of paths) {
      const a = p.pts[0]
      const b = p.pts[p.pts.length - 1]
      const [nx, nz, t, d] = nearestOnSegment(a[0], a[2], b[0], b[2], x, z)
      if (t < 0.3 || d >= best.dist) continue
      best = { x: nx, z: nz, y: a[1] + (b[1] - a[1]) * t, dist: d }
    }
    return best
  }
  // Clearance from every road and path to a box: sampled every 2 m along each.
  const clearOfWays = (box) => {
    for (const pts of roads) {
      for (let i = 1; i < pts.length; i++) {
        if (segmentHitsBox(box, pts[i - 1][0], pts[i - 1][2], pts[i][0], pts[i][2], R.width / 2 / SWELL_MIN + 1.5)) return false
      }
    }
    for (const p of paths) {
      const a = p.pts[0]
      const b = p.pts[p.pts.length - 1]
      if (segmentHitsBox(box, a[0], a[2], b[0], b[2], TOWN.path.width / 2 / SWELL_MIN + 0.6)) return false
    }
    return true
  }

  const n = TOWN.count[0] + Math.floor(rand() * (TOWN.count[1] - TOWN.count[0] + 1))
  const kinds = roster(n)
  const buildings = []
  let rMax = C.r
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k]
    const p = 1 - k / Math.max(1, kinds.length - 1) + (rand() - 0.5) * 0.3
    const bseed = hash32(seed, index, k, 31)
    const style = byPrestige(KINDS[kind].styles, WALLS_BY_PRESTIGE, p)
    const roof = byPrestige(KINDS[kind].roofs, ROOFS_BY_PRESTIGE, p)
    const plan = planBuilding({ seed: bseed, kind, style, roof })
    const [x0, x1, z0, z1] = planBox(plan)
    const hx = (x1 - x0) / 2
    const hz = (z1 - z0) / 2
    const ox = (x0 + x1) / 2
    const oz = (z0 + z1) / 2
    const doorZ = z1 + 0.3

    let best = null
    for (let t = 0; t < TOWN.tries; t++) {
      const a = rand() * Math.PI * 2
      const r = C.r + 2 + hz + rand() * (rMax - C.r + 20)
      const x = cx + Math.cos(a) * r
      const z = cz + Math.sin(a) * r
      let rank = r + rand() * 4
      if (best !== null && rank >= best.rank) continue
      const net = nearestNetwork(x, z)
      const yaw = Math.atan2(net.x - x, net.z - z) + (rand() - 0.5) * 0.35
      const [bx, bz] = toWorld(x, z, yaw, ox, oz)
      const box = { x: bx, z: bz, c: Math.cos(yaw), s: Math.sin(yaw), hx, hz }
      const gap = TOWN.gap[0] + TOWN.gap[1] * Math.max(0, r - C.r)
      if (pointBoxDist(box, cx, cz) < C.r + 1.5) continue
      if (buildings.some((o) => boxesOverlap(box, o.box, gap))) continue
      if (!clearOfWays(box)) continue
      const [dx, dz] = toWorld(x, z, yaw, plan.door.x, doorZ)
      const end = nearestNetwork(dx, dz)
      if (end.dist > TOWN.path.max) continue
      rank += TOWN.path.cost * end.dist
      if (best !== null && rank >= best.rank) continue
      if (buildings.some((o) => segmentHitsBox(o.box, dx, dz, end.x, end.z, 0.3))) continue
      if (segmentHitsBox({ ...box, hz: hz - 0.35 }, dx, dz, end.x, end.z, 0)) continue
      const samples = []
      let isWet = false
      for (const [lx, lz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [ox, oz], [plan.door.x, doorZ]]) {
        const [wx, wz] = toWorld(x, z, yaw, lx, lz)
        const h = ground(wx, wz)
        if (wet(wx, wz, h)) isWet = true
        samples.push(h)
      }
      if (isWet || Math.max(...samples) - Math.min(...samples) > TOWN.footRange) continue
      best = { rank, x, z, yaw, box, door: [dx, dz], end, samples, r }
    }
    if (best === null) continue

    const padY = best.samples.reduce((s, h) => s + h, 0) / best.samples.length
    plan.plinthBottom = Math.min(plan.plinthBottom, Math.min(...best.samples) - padY - 0.3)
    const bid = `${id}-b${buildings.length}`
    buildings.push({ id: bid, kind, plan, x: best.x, z: best.z, y: padY, yaw: best.yaw, box: best.box, door: best.door, prestige: k })
    rMax = Math.max(rMax, best.r)

    const [dx, dz] = best.door
    const len = Math.hypot(best.end.x - dx, best.end.z - dz)
    const steps = Math.max(1, Math.ceil(len / TOWN.path.step))
    const gEnd = ground(best.end.x, best.end.z)
    const pts = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = dx + (best.end.x - dx) * t
      const z = dz + (best.end.z - dz) * t
      const pin = (1 - t) * (padY - best.samples[5]) + t * (best.end.y - gEnd)
      pts.push([x, i === 0 ? padY : i === steps ? best.end.y : ground(x, z) + pin, z])
    }
    paths.push({ id: `${id}-path${paths.length}`, pts })
  }

  // Each road stops at the outskirts: past its last point within the town's building radius plus road.past.
  const reach = rMax + R.past
  for (const pts of roads) {
    let keep = 2
    while (keep < pts.length && Math.hypot(pts[keep][0] - cx, pts[keep][2] - cz) <= reach) keep++
    pts.length = Math.min(pts.length, keep + 1)
  }

  const records = []
  C.rings.forEach((rr, j) => {
    const pts = []
    const n = Math.max(6, Math.ceil((2 * Math.PI * rr) / 1.5))
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2
      pts.push([cx + Math.cos(a) * rr, yC, cz + Math.sin(a) * rr, C.width])
    }
    records.push({ id: `${id}-ring${j}`, pts })
  })
  roads.forEach((pts, j) => records.push({ id: `${id}-road${j}`, pts: pts.map(([x, y, z]) => [x, y, z, R.width]) }))
  paths.forEach((p) => records.push({ id: p.id, feather: 3, pts: p.pts.map(([x, y, z]) => [x, y, z, TOWN.path.width]) }))
  for (const b of buildings) {
    // A capsule round the box's long axis, wide enough at the narrowest swell to cover the corners.
    const long = b.box.hx >= b.box.hz ? 'x' : 'z'
    const L = long === 'x' ? b.box.hx : b.box.hz
    const S = long === 'x' ? b.box.hz : b.box.hx
    const half = (S + 0.5) / SWELL_MIN
    const a = Math.max(0.1, L - Math.sqrt((half * SWELL_MIN) ** 2 - S * S) + 0.3)
    const ux = long === 'x' ? b.box.c : b.box.s
    const uz = long === 'x' ? -b.box.s : b.box.c
    records.push({ id: `${b.id}-pad`, feather: 4, dirt: false, pts: [[b.box.x - ux * a, b.y, b.box.z - uz * a, 2 * half], [b.box.x + ux * a, b.y, b.box.z + uz * a, 2 * half]] })
  }

  return { id, x: cx, z: cz, y: yC, clearingR: C.r, radius: rMax + 10, buildings, roads, paths, records }
}

function angleApart(a, b) {
  const d = Math.abs(((a - b) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return Math.min(d, 2 * Math.PI - d)
}

// `ground` is the raw heightmap (Heightmap.sample), not the live field: it is what every client and the gate agree on. `keepClear` is [{x, z, r}] the towns stay TOWN.site.keepClear metres further from (the spawn). Returns { towns, records }, the records ready for Layers.addGenerated.
export function planTowns({ ground, layers, seed, keepClear = [] }) {
  const S = TOWN.site
  const sites = []
  for (const c of candidates(ground, layers, keepClear)) {
    if (sites.every((s) => Math.hypot(s.x - c.x, s.z - c.z) >= S.spacing)) sites.push(c)
  }
  const towns = []
  for (let i = 0; i < sites.length; i++) {
    const t = layoutTown(sites[i], towns.length, sites, { ground, layers, seed })
    if (t.buildings.length >= TOWN.count[0]) towns.push(t)
  }
  return { towns, records: towns.flatMap((t) => t.records) }
}
