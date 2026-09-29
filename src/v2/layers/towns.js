// The overworld's human towns (DESIGN.md §32): where they stand and how each is laid out. Three-free, and a pure function of the heightmap, the authored layers and the seed, so every netplay client builds the same towns and the node gate can hold them to their rules.
//
// Everything on the ground is a generated road (doc.js isGenerated): the clearing is concentric rings, each door has a winding path, and 1-2 main roads run out from the clearing. The road machinery then flattens, paints and keeps the scatters off all of it with no town-specific code. Buildings stand on the unflattened ground: the plan's floor goes at the highest corner and its plinth down past the lowest.
import { planBuilding, KINDS } from '../../buildings/plan.js'
import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { WORLD_HALF } from '../config.js'

export const TOWN = {
  // About one town per `tile`, the best-scoring site in each, then the best remaining below the snow up to `target`. A site above the snow is kept with chance `snowKeep`. Score: water within `water` metres (times `waterWeight`: flat sites by water are rare on this map), a cliff (ground ramping through the `cliff.slope` range) within `cliff.r`, a sunk valley, less unevenness.
  site: { grid: 40, slope: 0.2, flatR: 50, flatMax: 12, valleyR: 400, disc: 45, spacing: 512, tile: 1000, target: 64, snowKeep: 0.35, edge: 300, keepClear: 150, water: [30, 60, 100, 150, 220], waterWeight: 1.5, cliff: { r: [60, 120, 180], slope: [1.2, 2.4] } },
  // The import mirror-extends the source past |z| = 3492 (config.js), so towns keep to the real map.
  realZ: 3492,
  count: [8, 25],
  clearing: { r: 5, rings: [1.5, 4], width: 3 },
  // `waves`: the meander's sines as [shortest, longest wavelength, amplitude per wavelength squared, amplitude cap]; the square keeps every bend's radius over about 1 / (4 pi^2 k).
  road: { width: 2, step: 6, reach: 170, grade: 0.22, past: 12, apart: 60, waves: [[40, 80, 0.0008, 5], [90, 180, 0.0008, 8]] },
  // A building's rank is its radius plus `cost` per metre of door path, so a door near an existing path beats one nearer the centre with a long walk to it.
  path: { width: 0.8, max: 24, step: 2, cost: 1.5, waves: [[8, 16, 0.002, 0.5], [18, 36, 0.002, 1.8]] },
  // Metres between building footprints: base plus per-metre growth past the clearing edge, so the centre packs and the outskirts spread.
  gap: [1.2, 0.08],
  // Metres of fall across a footprint: the plinth takes up to this plus the ground's detail.
  footRange: 2,
  // The most treads a door's steps may take down to the ground, each TREAD deep and RISER high (parts.js steps); the plan's box reserves room for them.
  stepsMax: 4,
  tries: 90,
  // Hitching rails, `count` a town: along a house front beside its door, `out` m past its box, the first tether `first` m to one side of the door and the rest `spacing` apart. A strider's origin stands `stand` m past the rail facing it, its rump `rump` m further and its flank `half` m to each side. The ground under one may fall `rise` m.
  posts: { count: 3, tethers: 3, out: 1.2, first: 3.0, spacing: 3.1, stand: 1.5, rump: 1.8, half: 1.2, rise: 0.8, apart: 12 },
}

// A lateral offset along a way, s metres from its start: a sine per wave, wavelength and phase rolled.
function meander(rand, waves) {
  const parts = waves.map(([l0, l1, k, cap]) => {
    const l = l0 + rand() * (l1 - l0)
    return { w: (2 * Math.PI) / l, ph: rand() * 2 * Math.PI, a: Math.min(cap, k * l * l) * (0.6 + rand() * 0.4) }
  })
  return (s) => parts.reduce((o, p) => o + p.a * Math.sin(p.w * s + p.ph), 0)
}

const WALLS_BY_PRESTIGE = ['log', 'stave', 'halfTimber', 'stoneBase', 'masonry']
const ROOFS_BY_PRESTIGE = ['thatch', 'shake', 'pantile', 'slate']
// The road swell (paths.js SWELL) can narrow a way to 0.8 of its width.
const SWELL_MIN = 0.8
// paths.js DEFAULT_ROAD_FEATHER, which the clearing's rings take.
const RING_FEATHER = 8
const TREAD = 0.3
const RISER = 0.19

// Siting candidates, best first: dry, on ground flat across flatR, clear of rivers and roads across disc, scored as TOWN.site says. `snow` marks one above the snow line.
function candidates(ground, layers, keepClear) {
  const S = TOWN.site
  const snowBase = layers.snow.base
  const wetAt = (x, z, h) => {
    const level = layers.waterLevelAt(x, z)
    return level !== null && h < level
  }
  const dry = (x, z, h) => {
    const level = layers.waterLevelAt(x, z)
    return level === null || h > level + 3
  }
  const slopeAt = (x, z) => Math.hypot(ground(x + 4, z) - ground(x - 4, z), ground(x, z + 4) - ground(x, z - 4)) / 8
  const out = []
  const zMax = TOWN.realZ - S.edge
  const xMax = WORLD_HALF - S.edge
  for (let z = -zMax; z <= zMax; z += S.grid) {
    for (let x = -xMax; x <= xMax; x += S.grid) {
      const h0 = ground(x, z)
      if (!dry(x, z, h0)) continue
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
      let ring = 0
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        ring += ground(x + Math.cos(a) * S.valleyR, z + Math.sin(a) * S.valleyR)
      }
      const valley = Math.min(Math.max(ring / 16 - h0, 0), 60) / 60
      let water = 0
      for (const r of S.water) {
        for (let k = 0; k < 12 && water === 0; k++) {
          const px = x + Math.cos((k / 12) * Math.PI * 2) * r
          const pz = z + Math.sin((k / 12) * Math.PI * 2) * r
          if (wetAt(px, pz, ground(px, pz))) water = 1 - (0.5 * r) / S.water.at(-1)
        }
        if (water > 0) break
      }
      let steep = 0
      for (const r of S.cliff.r) {
        for (let k = 0; k < 12; k++) steep = Math.max(steep, slopeAt(x + Math.cos((k / 12) * Math.PI * 2) * r, z + Math.sin((k / 12) * Math.PI * 2) * r))
      }
      const cliff = Math.min(1, Math.max(0, (steep - S.cliff.slope[0]) / (S.cliff.slope[1] - S.cliff.slope[0])))
      out.push({ x, z, snow: h0 > snowBase, score: water * S.waterWeight + cliff + valley * 0.5 - range / 8 })
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

// A town's hitching rails (TOWN.posts): the house nearest the clearing's, then the farthest out, each rail along a house front beside its door (or, failing those, centred on its back or a side), clear of the clearing, the other houses and every way, on ground dry and level enough. A post is its rail's ends, its box, and per tether where the strider stands and faces, the knot on the rail, where a hand stands beside it (`stand`), and the rump line it is reached along (`reach`; `gate` is the first tether's).
function planPosts({ cx, cz, clearingR, buildings, roads, paths, ground, wet }) {
  const P = TOWN.posts
  const cands = []
  buildings.forEach((b, i) => {
    const [ldx] = toLocal(b.box, b.door[0], b.door[1])
    // Each face as a frame whose +z points out of it: the front, back and two sides, turned a quarter at a time.
    const faces = [[0, b.box.hz, [1, -1].map((side) => [side, (k) => ldx + side * (P.first + k * P.spacing)])]]
    for (const [q, depth] of [[2, b.box.hz], [1, b.box.hx], [3, b.box.hx]]) faces.push([q, depth, [[1, (k) => (k - (P.tethers - 1) / 2) * P.spacing]]])
    for (const [q, depth, sides] of faces) for (const [side, lat] of sides) {
      const yaw = Math.atan2(b.box.s, b.box.c) + (q * Math.PI) / 2
      const box = { x: b.box.x, z: b.box.z, c: Math.cos(yaw), s: Math.sin(yaw) }
      const at = (lx, lz) => [box.x + lx * box.c + lz * box.s, box.z - lx * box.s + lz * box.c]
      const rail = depth + P.out
      const mid = lat((P.tethers - 1) / 2)
      const near = rail - 0.2
      const far = rail + P.stand + P.rump
      const [x, z] = at(mid, (near + far) / 2)
      const foot = { x, z, c: box.c, s: box.s, hx: ((P.tethers - 1) * P.spacing) / 2 + P.half, hz: (far - near) / 2 }
      if (pointBoxDist(foot, cx, cz) < clearingR + 1) continue
      if (buildings.some((o) => boxesOverlap(foot, o.box, 0.3))) continue
      const hits = (pts, pad) => pts.some((p, k) => k > 0 && segmentHitsBox(foot, pts[k - 1][0], pts[k - 1][2], p[0], p[2], pad))
      if (roads.some((pts) => hits(pts, TOWN.road.width / 2 / SWELL_MIN + 0.5)) || paths.some((p) => hits(p.pts, TOWN.path.width / 2 / SWELL_MIN + 0.3))) continue
      const spots = [at(lat(-0.5), rail), at(lat(P.tethers - 0.5), rail), ...Array.from({ length: P.tethers }, (_, k) => at(lat(k), rail + P.stand))]
      const hs = spots.map(([sx, sz]) => ground(sx, sz))
      if (spots.some(([sx, sz], k) => wet(sx, sz, hs[k])) || Math.max(...hs) - Math.min(...hs) > P.rise) continue
      const heading = Math.atan2(box.c, -box.s)
      const tethers = Array.from({ length: P.tethers }, (_, k) => {
        const [tx, tz] = at(lat(k), rail + P.stand)
        const [kx, kz] = at(lat(k), rail)
        const [sx, sz] = at(lat(k) - (side * P.spacing) / 2, rail + P.stand)
        const [rx, rz] = at(lat(k) - (side * P.spacing) / 2, far + 0.6)
        return { x: tx, z: tz, heading, knot: [kx, kz], stand: [sx, sz], reach: [rx, rz] }
      })
      const [ax, az] = at(lat(-0.5), rail)
      const [bx, bz] = at(lat(P.tethers - 0.5), rail)
      cands.push({ building: i, front: q === 0, r: Math.hypot(x - cx, z - cz), box: foot, rail: [[ax, az], [bx, bz]], gate: tethers[0].reach, tethers })
    }
  })
  const posts = []
  const take = (p) => {
    if (posts.length >= P.count || posts.some((o) => o.building === p.building || boxesOverlap(o.box, p.box, P.apart))) return
    posts.push(p)
  }
  const byR = (list) => list.sort((p, q) => p.r - q.r)
  const fronts = byR(cands.filter((p) => p.front))
  const backs = byR(cands.filter((p) => !p.front))
  for (const p of [fronts[0], backs[0]]) if (p && posts.length === 0) take(p)
  for (const list of [fronts, backs]) for (let k = list.length - 1; k >= 0; k--) take(list[k])
  return posts.map(({ front, r, ...post }) => post)
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

// The plan's local box: every mass plus the porch and up to stepsMax treads out front, grown by the roof overhang. [minX, maxX, minZ, maxZ].
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
  if (plan.steps) front = Math.max(front, plan.steps.z + TREAD * TOWN.stepsMax + 0.1)
  return [x0 - o, x1 + o, z0 - o, front]
}

function layoutTown(site, index, all, ctx) {
  // Heights come from the live surface, so a building's plinth and the ways meet the ground as drawn.
  const { surface: ground, layers, seed } = ctx
  const rand = mulberry32(hash32(seed, 7717, Math.round(site.x), Math.round(site.z)))
  const id = `town${index}`
  const cx = site.x
  const cz = site.z
  const C = TOWN.clearing
  const ringEdge = C.rings.at(-1) + C.width / 2 / SWELL_MIN
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
    const wave = meander(rand, R.waves)
    const pts = [[cx + Math.cos(bearing) * C.r * 0.6, yC, cz + Math.sin(bearing) * C.r * 0.6], [cx + Math.cos(bearing) * (C.r + 2), yC, cz + Math.sin(bearing) * (C.r + 2)]]
    let heading = bearing
    let px = pts[1][0]
    let pz = pts[1][2]
    let py = yC
    for (let d = C.r + 2 + R.step; d <= R.reach; d += R.step) {
      heading += (rand() - 0.5) * 0.18
      const nx = px + Math.cos(heading) * R.step
      const nz = pz + Math.sin(heading) * R.step
      const side = wave(d) * Math.min(1, (d - C.r) / 30)
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
      for (let i = Math.ceil(p.pts.length * 0.3); i < p.pts.length; i++) {
        const a = p.pts[i - 1]
        const b = p.pts[i]
        const [nx, nz, t, d] = nearestOnSegment(a[0], a[2], b[0], b[2], x, z)
        if (d < best.dist) best = { x: nx, z: nz, y: a[1] + (b[1] - a[1]) * t, dist: d }
      }
    }
    return best
  }
  // A door path from (ax, az) to (bx, bz), every path.step metres: the chord bent by a meander that fades out at both ends, so it leaves the door and meets the network square on.
  const windingPath = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az)
    const wave = meander(rand, TOWN.path.waves)
    const n = Math.max(1, Math.ceil(len / TOWN.path.step))
    const ux = -(bz - az) / (len || 1)
    const uz = (bx - ax) / (len || 1)
    const out = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const off = wave(t * len) * Math.sin(Math.PI * t) ** 2 * Math.min(1, len / 16)
      out.push([ax + (bx - ax) * t + ux * off, az + (bz - az) * t + uz * off])
    }
    return out
  }
  // Clearance from every road and path to a box: sampled every 2 m along each.
  const clearOfWays = (box) => {
    for (const pts of roads) {
      for (let i = 1; i < pts.length; i++) {
        if (segmentHitsBox(box, pts[i - 1][0], pts[i - 1][2], pts[i][0], pts[i][2], R.width / 2 / SWELL_MIN + 1.5)) return false
      }
    }
    for (const p of paths) {
      for (let i = 1; i < p.pts.length; i++) {
        if (segmentHitsBox(box, p.pts[i - 1][0], p.pts[i - 1][2], p.pts[i][0], p.pts[i][2], TOWN.path.width / 2 / SWELL_MIN + 0.6)) return false
      }
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
      const way = windingPath(dx, dz, end.x, end.z)
      const inner = { ...box, hz: hz - 0.35 }
      let blocked = false
      for (let i = 1; i < way.length && !blocked; i++) {
        const [ax, az] = way[i - 1]
        const [qx, qz] = way[i]
        blocked = segmentHitsBox(inner, ax, az, qx, qz, 0) || buildings.some((o) => segmentHitsBox(o.box, ax, az, qx, qz, 0.3))
      }
      if (blocked) continue
      // The ground under the box, a 3 x 3 grid of it.
      const samples = []
      let isWet = false
      for (const lx of [x0, ox, x1]) {
        for (const lz of [z0, oz, z1]) {
          const [wx, wz] = toWorld(x, z, yaw, lx, lz)
          const h = ground(wx, wz)
          if (wet(wx, wz, h)) isWet = true
          samples.push(h)
        }
      }
      const top = Math.max(...samples)
      const doorH = ground(dx, dz)
      if (isWet || wet(dx, dz, doorH) || top - Math.min(...samples) > TOWN.footRange) continue
      if (top + plan.floorY - doorH > RISER * (TOWN.stepsMax - 1)) continue
      best = { rank, x, z, yaw, box, door: [dx, dz], end, doorH, way, r }
    }
    if (best === null) continue

    // The plan was drawn on flat ground at y = 0, so the building's y is the highest ground under it; its plinth reaches past the lowest and its steps down to the door's ground. The ground's detail moves tens of centimetres between the 3 x 3 the candidates read, so the chosen seat is read every metre.
    let hi = -Infinity
    let lo = Infinity
    for (let lx = x0; lx <= x1 + 0.01; lx += (x1 - x0) / Math.ceil(x1 - x0)) {
      for (let lz = z0; lz <= z1 + 0.01; lz += (z1 - z0) / Math.ceil(z1 - z0)) {
        const [wx, wz] = toWorld(best.x, best.z, best.yaw, lx, lz)
        const h = ground(wx, wz)
        // The clearing's rings will blend the ground toward yC over their feather (paths.js smoothRoads), at the widest swell.
        const s = smoothstep(0, 1, (Math.hypot(wx - cx, wz - cz) - ringEdge) / RING_FEATHER)
        const g = yC + (h - yC) * s
        hi = Math.max(hi, h, g)
        lo = Math.min(lo, h, g)
      }
    }
    plan.plinthBottom = Math.min(plan.plinthBottom, lo - hi - 0.6)
    if (plan.steps) plan.steps.groundY = best.doorH - hi
    const bid = `${id}-b${buildings.length}`
    buildings.push({ id: bid, kind, plan, x: best.x, z: best.z, y: hi, yaw: best.yaw, box: best.box, door: best.door, prestige: k })
    rMax = Math.max(rMax, best.r)

    const n = best.way.length - 1
    const pin = best.end.y - ground(best.end.x, best.end.z)
    const pts = best.way.map(([x, z], i) => [x, i === 0 ? best.doorH : i === n ? best.end.y : ground(x, z) + (i / n) * pin, z])
    paths.push({ id: `${id}-path${paths.length}`, pts })
  }

  // Each road stops at the outskirts: past its last point within the town's building radius plus road.past.
  const reach = rMax + R.past
  for (const pts of roads) {
    let keep = 2
    while (keep < pts.length && Math.hypot(pts[keep][0] - cx, pts[keep][2] - cz) <= reach) keep++
    pts.length = Math.min(pts.length, keep + 1)
  }

  const posts = planPosts({ cx, cz, clearingR: C.r, buildings, roads, paths, ground, wet })

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

  return { id, x: cx, z: cz, y: yC, clearingR: C.r, radius: rMax + 10, buildings, roads, paths, posts, records }
}

// Whether (x, z) is within `pad` (plus a metre) of a building's or a hitching post's box: what keeps the trees and rocks out of them. The clearing and paths are roads, which they keep off already.
export function townsOccupyAt(towns, x, z, pad) {
  for (const t of towns) {
    const dx = x - t.x
    const dz = z - t.z
    if (dx * dx + dz * dz > (t.radius + 20) ** 2) continue
    for (const { box } of [...t.buildings, ...t.posts]) {
      const bx = x - box.x
      const bz = z - box.z
      const lx = bx * box.c - bz * box.s
      const lz = bx * box.s + bz * box.c
      if (Math.abs(lx) < box.hx + pad + 1 && Math.abs(lz) < box.hz + pad + 1) return true
    }
  }
  return false
}

function angleApart(a, b) {
  const d = Math.abs(((a - b) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return Math.min(d, 2 * Math.PI - d)
}

// `ground` is the raw heightmap (Heightmap.sample), which the siting reads; `surface` is the live field before the towns' own roads (V2Height.heightAt with the authored layers), which the layout seats buildings and ways on. Both are the same on every client. `keepClear` is [{x, z, r}] the towns stay TOWN.site.keepClear metres further from (the spawn). Returns { towns, records }, the records ready for Layers.addGenerated.
export function planTowns({ ground, surface, layers, seed, keepClear = [] }) {
  const S = TOWN.site
  const cands = candidates(ground, layers, keepClear)
  const sites = []
  const spaced = (c) => sites.every((s) => Math.hypot(s.x - c.x, s.z - c.z) >= S.spacing)
  // Each tile's best, in score order (the candidates come sorted, so a tile's first is its best).
  const tiles = new Map()
  for (const c of cands) {
    const key = `${Math.floor(c.x / S.tile)},${Math.floor(c.z / S.tile)}`
    if (!tiles.has(key)) tiles.set(key, c)
  }
  for (const c of tiles.values()) {
    if (c.snow && mulberry32(hash32(seed, 9431, c.x, c.z))() >= S.snowKeep) continue
    if (spaced(c)) sites.push(c)
  }
  for (const c of cands) {
    if (sites.length >= S.target) break
    if (!c.snow && spaced(c)) sites.push(c)
  }
  const towns = []
  for (let i = 0; i < sites.length; i++) {
    const t = layoutTown(sites[i], towns.length, sites, { surface, layers, seed })
    if (t.buildings.length >= TOWN.count[0]) towns.push(t)
  }
  return { towns, records: towns.flatMap((t) => t.records) }
}
