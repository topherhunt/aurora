// The roads between the towns (DESIGN.md §35): an A* over the heightmap's 8 m grid links the towns' road stubs into one web, sharing road where it can, bridging rivers square across, and a signpost at every fork. Three-free and a pure function of the towns, the heightmap, the layers and the seed, like the towns themselves.
import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { WORLD_HALF, WORLD_SIZE } from '../config.js'
import { BANK, drawnHalfWidth } from './paths.js'
import { Heap } from './route.js'
import { TOWN } from './towns.js'
import { LINK, neighbourPairs } from './town-links.js'
import { lakeLevelOf } from './water-bodies.js'

export const ROAD = {
  width: 2,
  cell: 8,
  // A step's cost per metre is its cells' multiplier times 1 + (grade / grade)^2; a step steeper than `steep` is refused.
  grade: 0.07,
  steep: 0.28,
  // A cell's multiplier: 1 + (slope / slope)^2 + valley.k * (height over the mean within valley.r, per valley.depth, clamped to -0.5..1). Ground below its surroundings is cheap, so the roads keep to the valleys.
  slope: 0.3,
  valley: { r: 200, depth: 40, k: 0.7 },
  // Travel along a road already laid costs this fraction, so later roads join earlier ones and fork off them.
  reuse: 0.45,
  // A road leaves or joins another at `angle` or wider, read `cells` cells out, and never within `cells` of a fork. Off the road, a cell within `apart.cells` of one costs `apart.cost` times more, so roads keep apart rather than run side by side.
  fork: { angle: (75 * Math.PI) / 180, cells: 4 },
  apart: { cells: 2, cost: 4 },
  // The laid road stands no more than `cut` m under the ground at its points; the measured road keeps within 2 m between them.
  cut: 1.25,
  // Each town tries a road to its `near.k` nearest within `near.r` m. A pair already joined within `detour` times their distance apart (through towns' streets too) gets none, nor one that saves under `gain` of the way round.
  detour: 1.6,
  gain: 0.25,
  near: LINK.near,
  // A pair's route winding past `over` times their distance apart, or back along the way round, is raced by one that climbs costed at `grade`, feels no valley pull and takes road already laid at `reuse`; the shorter is laid.
  direct: { over: 2, grade: 0.14, reuse: 0.8 },
  // Every `step` cells along the roads, a link of at most `reach` m is tried to web `min` m or more away that is `detour` times further round by road and `save` m further, the biggest saving first. A way still longer than `every` gets waymark posts evenly along it.
  link: { every: 500, step: 12, min: 80, detour: 2, save: 500, reach: 900, budget: 2 },
  // A way whose ends are joined within `prune` times its length without it is taken up.
  prune: 1.3,
  // Metres of dry ground kept between a road's cells and a river's bank band, or any other water.
  riverPad: 6,
  // Crossings are tried every `every` metres of river, where the shipped bridge (design/34-bridges.md §The shipped mesh) spans the drawn water at an x scale no more than scale[1]. The road runs `approach` metres straight out from each of its tips, and the river must turn less than `turn` radians over 20 m either side. A tip must stand `bank` metres over the water. `penalty` is the metres of travel each span of a new bridge costs, so a long lake chain is laid only where going round is far worse; one already built costs only its length.
  cross: { every: 12, scale: [0.7, 1.3], approach: 10, turn: 0.2, bank: 0.4, grade: 0.3, penalty: 150 },
  // A lake is crossed on a straight chain of shipped bridges end to end, at most `max` m of water, tried along `dirs` headings from one shore cell in every `step` cells square.
  lake: { max: 160, dirs: 16, step: 3 },
  // The laid road: control points every `spacing` m after `smooth` passes of neighbour averaging, then meandered like the town roads, the sway fading in over `envelope` m from each end.
  spacing: 12,
  smooth: 8,
  waves: [[48, 104, 0.00225, 6], [120, 256, 0.0011, 14.4]],
  envelope: 30,
  ySigma: 12,
  maxGrade: 0.18,
  // Where the ground climbs steeper than maxGrade, the road may too, up to `climb`, rather than cut past `cut`.
  climb: 0.24,
  // Each fork's signpost names this many of the nearest towns by road, at least one down each way, and stands `offset` m off the fork on a spur of half-width `spur`.
  sign: { boards: [3, 5], offset: 3.4, spur: 1.5 },
}

// The shipped bridge's unscaled size (design/34-bridges.md §The shipped mesh): the water it spans, its half-length and the road height at its ends. check-roads holds these to the baked glb's meta.
export const STONE_BRIDGE = { span: 14, xb: 8.5, bank: 3, inner: 1.6 }

const N = WORLD_SIZE / ROAD.cell
const SQRT2 = Math.SQRT2

// A lateral offset along a road, as towns.js meander: sines of rolled wavelength and phase, amplitude k * wavelength^2 so the bends stay wide.
function meander(rand, waves) {
  const parts = waves.map(([l0, l1, k, cap]) => {
    const l = l0 + rand() * (l1 - l0)
    return { w: (2 * Math.PI) / l, ph: rand() * 2 * Math.PI, a: Math.min(cap, k * l * l) * (0.6 + rand() * 0.4) }
  })
  return (s) => parts.reduce((o, p) => o + p.a * Math.sin(p.w * s + p.ph), 0)
}

const cx = (c) => -WORLD_HALF + ((c % N) + 0.5) * ROAD.cell
const cz = (c) => -WORLD_HALF + (Math.floor(c / N) + 0.5) * ROAD.cell
const cellOf = (x, z) => {
  const i = Math.floor((x + WORLD_HALF) / ROAD.cell)
  const j = Math.floor((z + WORLD_HALF) / ROAD.cell)
  return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i
}
// The grid and its cells for the cave trails (trails.js), which route on the same costs.
export { buildGrid, N as GRID_N, cx as cellX, cz as cellZ, cellOf }

// Heights, blocked cells and cost multipliers over the whole grid.
function buildGrid(ground, surface, layers, towns) {
  const lakeLevel = lakeLevelOf(layers)
  const H = new Float32Array(N * N)
  const blocked = new Uint8Array(N * N)
  const zMax = TOWN.realZ - 60
  for (let c = 0; c < N * N; c++) {
    const x = cx(c)
    const z = cz(c)
    const h = (H[c] = ground(x, z))
    if (Math.abs(z) > zMax || Math.abs(x) > WORLD_HALF - 60) blocked[c] = 1
    // Wet where the drawn water stands: the live surface under the plane. The raw ground only screens out cells far above it.
    const level = lakeLevel(x, z)
    if (level !== null && h < level + 4 && surface(x, z) < level + 0.5) blocked[c] = 2
  }
  // Grow the lakes by two cells, so a road never runs along the waterline.
  const wet = blocked.slice()
  for (let c = 0; c < N * N; c++) {
    if (wet[c] !== 2) continue
    const i = c % N
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const n = c + dj * N + di
      if (n >= 0 && n < N * N && Math.abs((n % N) - i) <= 2) blocked[n] = blocked[n] || 1
    }
  }
  for (const r of layers.paths.toJSON('river')) {
    const s = layers.paths.drawnSamples(r.id)
    for (let k = 0; k < s.length; k += 4) {
      const reach = s[k + 3] * BANK + ROAD.riverPad + ROAD.cell / 2
      const n = Math.ceil(reach / ROAD.cell)
      const c0 = cellOf(s[k], s[k + 2])
      if (c0 < 0) continue
      for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
        const c = c0 + dj * N + di
        if (c < 0 || c >= N * N) continue
        if (Math.hypot(cx(c) - s[k], cz(c) - s[k + 2]) <= reach) blocked[c] = 1
      }
    }
  }
  for (const t of towns) {
    const n = Math.ceil(t.radius / ROAD.cell) + 1
    const c0 = cellOf(t.x, t.z)
    for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
      const c = c0 + dj * N + di
      if (Math.hypot(cx(c) - t.x, cz(c) - t.z) < t.radius) blocked[c] = 1
    }
  }
  // The mean height within valley.r, from a summed-area table.
  const sat = new Float64Array((N + 1) * (N + 1))
  for (let j = 0; j < N; j++) {
    let row = 0
    for (let i = 0; i < N; i++) {
      row += H[j * N + i]
      sat[(j + 1) * (N + 1) + i + 1] = sat[j * (N + 1) + i + 1] + row
    }
  }
  const R = Math.round(ROAD.valley.r / ROAD.cell)
  const mul = new Float32Array(N * N)
  const val = new Float32Array(N * N)
  for (let j = 0; j < N; j++) {
    const j0 = Math.max(0, j - R)
    const j1 = Math.min(N, j + R + 1)
    for (let i = 0; i < N; i++) {
      const c = j * N + i
      const i0 = Math.max(0, i - R)
      const i1 = Math.min(N, i + R + 1)
      const mean = (sat[j1 * (N + 1) + i1] - sat[j0 * (N + 1) + i1] - sat[j1 * (N + 1) + i0] + sat[j0 * (N + 1) + i0]) / ((j1 - j0) * (i1 - i0))
      const gx = (H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)]) / (2 * ROAD.cell)
      const gz = (H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i]) / (2 * ROAD.cell)
      const v = Math.max(-0.5, Math.min(1, (H[c] - mean) / ROAD.valley.depth))
      val[c] = ROAD.valley.k * v
      mul[c] = 1 + (Math.hypot(gx, gz) / ROAD.slope) ** 2 + val[c]
    }
  }
  return { H, blocked, mul, val }
}

// Whether the live ground carries on from an approach's end at no more than cross.grade for 4 cells: the route grid reads the raw heightmap, which misses the relief's cliffs, and a bank node holds its height.
function gentleOn(surface, [x, z], nx, nz, y) {
  for (let d = ROAD.cell; d <= 4 * ROAD.cell; d += ROAD.cell) if (Math.abs(surface(x + nx * d, z + nz * d) - y) / d > ROAD.cross.grade) return false
  return true
}

// Where each river can be bridged: square across a straight reach, both tips dry and over the water, the approaches gentle, nothing but this river under the deck.
function findCrossings(layers, surface, blocked) {
  const X = ROAD.cross
  const lakeLevel = lakeLevelOf(layers)
  const out = []
  for (const r of layers.paths.toJSON('river')) {
    const s = layers.paths.drawnSamples(r.id)
    const n = s.length / 4
    const at = (k) => [s[k * 4], s[k * 4 + 2]]
    const step = Math.max(1, Math.round(X.every / 2))
    const dir = (a, b) => Math.atan2(s[b * 4 + 2] - s[a * 4 + 2], s[b * 4] - s[a * 4])
    for (let k = 10; k < n - 10; k += step) {
      const turn = Math.abs(((dir(k - 10, k) - dir(k, k + 10) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
      if (turn > X.turn) continue
      const [x, z] = at(k)
      const t = dir(k - 5, k + 5)
      const nx = -Math.sin(t)
      const nz = Math.cos(t)
      const level = s[k * 4 + 1]
      const hw = s[k * 4 + 3]
      const dhw = drawnHalfWidth(hw)
      // A stream narrower than the least x scale spans takes that scale, its ends landing on dry bank.
      const sx = Math.max(X.scale[0], (2 * dhw) / STONE_BRIDGE.span)
      if (sx > X.scale[1]) continue
      const tipD = STONE_BRIDGE.xb * sx
      const endD = Math.max(tipD + X.approach, hw * BANK + ROAD.riverPad + 4)
      let ok = true
      const side = []
      for (const sg of [-1, 1]) {
        const tip = [x + sg * nx * tipD, z + sg * nz * tipD]
        const end = [x + sg * nx * endD, z + sg * nz * endD]
        const yTip = surface(tip[0], tip[1])
        const yOut = surface(end[0], end[1])
        if (yTip - level < X.bank || Math.abs(yOut - yTip) / (endD - tipD) > X.grade || !gentleOn(surface, end, sg * nx, sg * nz, yOut)) { ok = false; break }
        // Only this river under the deck and nothing wet out to the approach's end.
        for (let d = 0; d <= endD && ok; d += 2) {
          const px = x + sg * nx * d
          const pz = z + sg * nz * d
          const lake = lakeLevel(px, pz)
          if (lake !== null && surface(px, pz) < lake + 0.5) ok = false
          const near = layers.paths.nearest(px, pz, 'river')
          if (near !== null && near.id !== r.id && near.dist < near.halfWidth * BANK + 2) ok = false
          if (d >= tipD && layers.paths.riverLevelAt(px, pz) !== null) ok = false
        }
        if (!ok) break
        // The approach's end on the first open cell out along the normal.
        let cell = -1
        for (let e = endD; e < endD + 4 * ROAD.cell && cell < 0; e += ROAD.cell / 2) {
          const c = cellOf(x + sg * nx * e, z + sg * nz * e)
          if (c >= 0 && !blocked[c]) cell = c
        }
        if (cell < 0) { ok = false; break }
        side.push({ tip, yTip, yOut, end, cell })
      }
      if (!ok) continue
      // Both ends take one height, the banks' mean within the y scales the mesh allows; each approach must still reach it gently.
      const sy = Math.min(X.scale[1], Math.max(X.scale[0], (0.5 * (side[0].yTip + side[1].yTip) - level) / STONE_BRIDGE.bank))
      const yEnd = level + sy * STONE_BRIDGE.bank
      if (side.some((sd) => Math.abs(sd.yOut - yEnd) / (endD - tipD) > X.grade)) continue
      out.push({ river: r.id, x, z, nx, nz, level, hw, sx, sy, yEnd, tipD, endD, spans: 1, side, cells: [side[0].cell, side[1].cell], way: -1 })
    }
  }
  return out
}

// Where a lake can be bridged: a straight line from a shore cell across the drawn water to dry bank, both tips over the level, nothing but water under the deck, the approaches gentle.
function findLakeCrossings(layers, surface, blocked) {
  const X = ROAD.cross
  const { max, dirs, step } = ROAD.lake
  const { xb } = STONE_BRIDGE
  const lakeLevel = lakeLevelOf(layers)
  const wet = (x, z) => blocked[cellOf(x, z)] === 2
  const out = []
  const seen = new Set()
  const taken = new Set()
  for (let c = 0; c < N * N; c++) {
    if (blocked[c] !== 2) continue
    const i = c % N
    const j = (c - i) / N
    if (i === 0 || j === 0 || i === N - 1 || j === N - 1 || [1, -1, N, -N].every((o) => blocked[c + o] === 2)) continue
    const bucket = Math.floor(j / step) * N + Math.floor(i / step)
    if (taken.has(bucket)) continue
    taken.add(bucket)
    const x0 = cx(c)
    const z0 = cz(c)
    const level = lakeLevel(x0, z0)
    for (let k = 0; k < dirs; k++) {
      const nx = Math.cos((2 * Math.PI * k) / dirs)
      const nz = Math.sin((2 * Math.PI * k) / dirs)
      // The line must start on the shore behind this cell and cross water ahead of it.
      if (wet(x0 - nx * ROAD.cell, z0 - nz * ROAD.cell)) continue
      let t = 0
      while (t <= max && wet(x0 + nx * t, z0 + nz * t)) t += ROAD.cell / 2
      if (t > max || t < 2 * ROAD.cell) continue
      // Tips where the live bank first stands `bank` over the level, walked out from the water's middle.
      const mid = t / 2
      const tipAt = (sg) => {
        let d = 0
        while (d < max && surface(x0 + nx * (mid + sg * d), z0 + nz * (mid + sg * d)) < level + X.bank) d += 1
        return mid + sg * d
      }
      const a = tipAt(-1)
      const b = tipAt(1)
      const S = b - a
      if (S > max) continue
      const x = x0 + nx * (a + b) / 2
      const z = z0 + nz * (a + b) / 2
      const key = `${Math.round(x / 16)},${Math.round(z / 16)},${k % (dirs / 2)}`
      if (seen.has(key)) continue
      seen.add(key)
      const spans = Math.max(1, Math.ceil(S / (2 * xb * X.scale[1])))
      const sx = Math.max(X.scale[0], S / (2 * xb * spans))
      const tipD = spans * xb * sx
      const endD = tipD + X.approach
      let ok = true
      const side = []
      for (const sg of [-1, 1]) {
        const tip = [x + sg * nx * tipD, z + sg * nz * tipD]
        const end = [x + sg * nx * endD, z + sg * nz * endD]
        const yTip = surface(tip[0], tip[1])
        const yOut = surface(end[0], end[1])
        if (yTip - level < X.bank || Math.abs(yOut - yTip) / (endD - tipD) > X.grade || !gentleOn(surface, end, sg * nx, sg * nz, yOut)) { ok = false; break }
        for (let d = tipD; d <= endD && ok; d += 2) {
          const px = x + sg * nx * d
          const pz = z + sg * nz * d
          const lake = lakeLevel(px, pz)
          if ((lake !== null && surface(px, pz) < lake + 0.5) || layers.paths.riverLevelAt(px, pz) !== null) ok = false
        }
        if (!ok) break
        let cell = -1
        for (let e = endD; e < endD + 4 * ROAD.cell && cell < 0; e += ROAD.cell / 2) {
          const cc = cellOf(x + sg * nx * e, z + sg * nz * e)
          if (cc >= 0 && !blocked[cc]) cell = cc
        }
        if (cell < 0) { ok = false; break }
        side.push({ tip, yTip, yOut, end, cell })
      }
      if (!ok) continue
      const sy = Math.min(X.scale[1], Math.max(X.scale[0], (0.5 * (side[0].yTip + side[1].yTip) - level) / STONE_BRIDGE.bank))
      const yEnd = level + sy * STONE_BRIDGE.bank
      if (side.some((sd) => Math.abs(sd.yOut - yEnd) / (endD - tipD) > X.grade)) continue
      // Nothing between the waterline tips stands within a metre of the deck ends' height, and no river runs there.
      for (let d = 1 - S / 2; d < S / 2 - 1 && ok; d += 2) {
        const px = x + nx * d
        const pz = z + nz * d
        if (surface(px, pz) > yEnd - 1 || layers.paths.riverLevelAt(px, pz) !== null) ok = false
      }
      if (!ok) continue
      out.push({ river: null, x, z, nx, nz, level, sx, sy, yEnd, tipD, endD, spans, side, cells: [side[0].cell, side[1].cell], way: -1 })
    }
  }
  return out
}

/**
 * The road network. `ground` is the raw heightmap (the route's grid), `surface` the live field with the towns' roads in it (the laid roads' heights). Returns { records, ways, nodes, bridges, signs } -- the records ready for Layers.addGenerated.
 */
export function planRoads({ towns, ground, surface, layers, seed }) {
  const { H, blocked, mul, val } = buildGrid(ground, surface, layers, towns)
  const crossings = [...findCrossings(layers, surface, blocked), ...findLakeCrossings(layers, surface, blocked)]
  const crossAt = new Map()
  const crossCell = new Uint8Array(N * N)
  crossings.forEach((X, i) => {
    for (const c of X.cells) {
      if (!crossAt.has(c)) crossAt.set(c, [])
      crossAt.get(c).push(i)
      crossCell[c] = 1
    }
  })

  // --- the network's topology, on cells --------------------------------------
  const nodes = []
  const ways = []
  const nodeAt = new Map()
  const owner = new Int32Array(N * N).fill(-1)
  const ownerIdx = new Int32Array(N * N)
  const net = new Uint8Array(N * N)
  const onNet = (c) => net[c] === 1
  // Road cells binned BIN cells square, so a search for nearby road walks a few bins rather than every cell; `near` is each cell's distance in cells to the nearest road, up to ROAD.apart.cells.
  const BIN = 16
  const NB = Math.ceil(N / BIN)
  const bins = Array.from({ length: NB * NB }, () => [])
  const near = new Uint8Array(N * N).fill(255)
  const markNet = (c) => {
    if (net[c] === 1) return
    net[c] = 1
    const i = c % N
    const j = (c - i) / N
    bins[Math.floor(j / BIN) * NB + Math.floor(i / BIN)].push(c)
    const R = ROAD.apart.cells
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      if (i + di < 0 || i + di >= N || j + dj < 0 || j + dj >= N) continue
      const n = c + dj * N + di
      near[n] = Math.min(near[n], Math.max(Math.abs(di), Math.abs(dj)))
    }
  }
  const newNode = (c, props) => {
    const node = { id: nodes.length, cell: c, x: cx(c), z: cz(c), ways: [], town: -1, port: null, bank: null, ...props }
    nodes.push(node)
    nodeAt.set(c, node.id)
    owner[c] = -1
    markNet(c)
    return node.id
  }
  const addWay = (cells, a, b, crossing = -1) => {
    const w = { id: ways.length, cells, a, b, crossing }
    ways.push(w)
    nodes[a].ways.push(w.id)
    nodes[b].ways.push(w.id)
    if (crossing < 0) for (let k = 1; k < cells.length - 1; k++) { owner[cells[k]] = w.id; ownerIdx[cells[k]] = k; markNet(cells[k]) }
    return w.id
  }
  // The node at cell c, splitting the way through it when there is none.
  const nodeAtOrSplit = (c) => {
    if (nodeAt.has(c)) return nodeAt.get(c)
    const w = ways[owner[c]]
    const i = ownerIdx[c]
    const id = newNode(c, {})
    const tail = w.cells.slice(i)
    w.cells = w.cells.slice(0, i + 1)
    const w2 = { id: ways.length, cells: tail, a: id, b: w.b, crossing: -1 }
    ways.push(w2)
    const far = nodes[w.b].ways
    far[far.indexOf(w.id)] = w2.id
    w.b = id
    nodes[id].ways.push(w.id, w2.id)
    for (let k = 1; k < tail.length - 1; k++) { owner[tail[k]] = w2.id; ownerIdx[tail[k]] = k }
    return id
  }
  const waysOf = (c) => (nodeAt.has(c) ? nodes[nodeAt.get(c)].ways : owner[c] >= 0 ? [owner[c]] : [])
  const indexIn = (w, c) => {
    if (!nodeAt.has(c)) return owner[c] === w.id ? ownerIdx[c] : -1
    const id = nodeAt.get(c)
    return w.a === id ? 0 : w.b === id ? w.cells.length - 1 : -1
  }
  // Whether a step from a to b runs along a way already laid.
  const alongWay = (a, b) => {
    const wb = waysOf(b)
    for (const id of waysOf(a)) {
      if (!wb.includes(id) || ways[id].crossing >= 0) continue
      const ia = indexIn(ways[id], a)
      const ib = indexIn(ways[id], b)
      if (ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1) return true
    }
    return false
  }
  // Whether a road may leave road cell m heading (vx, vz) as read r cells out: at least fork.angle off every road already leaving m, read as far along it, and m not so near a way's end that the fork would crowd another.
  const cosFork = Math.cos(ROAD.fork.angle)
  const K = ROAD.fork.cells
  const openAt = (m, vx, vz, r = K) => {
    const out = []
    const along = (w, k, step) => { const o = w.cells[Math.max(0, Math.min(w.cells.length - 1, k + step))]; out.push([cx(o) - cx(m), cz(o) - cz(m)]) }
    if (nodeAt.has(m)) {
      const node = nodes[nodeAt.get(m)]
      for (const id of node.ways) {
        const w = ways[id]
        if (w.crossing >= 0) { const o = nodes[w.a === node.id ? w.b : w.a]; out.push([o.x - node.x, o.z - node.z]) } else along(w, w.a === node.id ? 0 : w.cells.length - 1, w.a === node.id ? r : -r)
      }
      if (node.port) { const stub = towns[node.town].roads[node.port.stub]; const p = stub.at(-3) ?? stub[0]; out.push([p[0] - node.x, p[2] - node.z]) }
    } else {
      const w = ways[owner[m]]
      const k = ownerIdx[m]
      if (Math.min(k, w.cells.length - 1 - k) < K) return false
      along(w, k, r)
      along(w, k, -r)
    }
    const l = Math.hypot(vx, vz)
    return out.every(([ox, oz]) => (ox * vx + oz * vz) / (Math.hypot(ox, oz) * l) <= cosFork)
  }
  const bankNode = (X, s) => {
    const c = X.cells[s]
    const id = nodeAt.has(c) ? nodeAt.get(c) : onNet(c) ? nodeAtOrSplit(c) : newNode(c, {})
    const node = nodes[id]
    node.bank = { crossing: crossings.indexOf(X), side: s }
    node.x = X.side[s].end[0]
    node.z = X.side[s].end[1]
    return id
  }

  // Ports: each town stub's end, and the first open cell within 5 cells on along it. A stub ending within fork.cells of another of its town's ports gets none: their roads would leave side by side. A town left with no port at all (its stubs end deep in its disc, facing water) searches on until each stub clears the disc.
  const ports = []
  for (const wide of [false, true]) towns.forEach((t, ti) => {
    if (wide && ports.some((o) => nodes[o].town === ti)) return
    t.roads.forEach((pts, pi) => {
      const e = pts.at(-1)
      const p = pts.at(-2)
      const len = Math.hypot(e[0] - p[0], e[2] - p[2]) || 1
      const hx = (e[0] - p[0]) / len
      const hz = (e[2] - p[2]) / len
      const reach = wide ? t.radius - Math.hypot(e[0] - t.x, e[2] - t.z) + 3 * ROAD.cell : 5 * ROAD.cell
      let cell = -1
      for (let d = ROAD.cell; d <= reach && cell < 0; d += ROAD.cell / 2) {
        const c = cellOf(e[0] + hx * d, e[2] + hz * d)
        if (c >= 0 && !blocked[c] && !nodeAt.has(c)) cell = c
      }
      if (cell < 0 || ports.some((o) => nodes[o].town === ti && Math.hypot(nodes[o].x - e[0], nodes[o].z - e[2]) < ROAD.fork.cells * ROAD.cell)) return
      const id = newNode(cell, { town: ti, port: { stub: pi, end: [e[0], e[1], e[2]] }, x: e[0] + hx * ROAD.cell, z: e[2] + hz * ROAD.cell })
      ports.push(id)
    })
  })

  // --- A* ------------------------------------------------------------------
  const g = new Float64Array(N * N)
  const came = new Int32Array(N * N)
  const jump = new Int32Array(N * N)
  const stamp = new Int32Array(N * N)
  const done = new Int32Array(N * N)
  // Along the path to each cell: how many cells it has run off the network (fork.cells after a bridge), and the road cell it left.
  const off = new Int32Array(N * N)
  const left = new Int32Array(N * N)
  let sid = 0
  // Cheapest way from any source cell to a cell isGoal accepts, inside box; the goal points steer the search. `offNet` reaches network cells but walks on from none but the sources. `direct` costs steps as ROAD.direct. Nothing costing past `budget` is reached. The path runs along ways, leaves and joins them by openAt, and never steps between two diagonal road cells. Returns trace(goal), or null; with no goal found, every cell reached stays traceable until the next search.
  const search = (sources, isGoal, goalPts, box, offNet = false, direct = false, budget = Infinity) => {
    const gradeK = direct ? ROAD.direct.grade : ROAD.grade
    const reuse = direct ? ROAD.direct.reuse : ROAD.reuse
    sid++
    const heap = new Heap(4096)
    const hk = goalPts.length === 0 ? 0 : direct ? reuse : 0.6
    const heur = (c) => {
      if (hk === 0) return 0
      const x = cx(c)
      const z = cz(c)
      let best = Infinity
      for (const p of goalPts) best = Math.min(best, (x - p[0]) ** 2 + (z - p[1]) ** 2)
      return Math.sqrt(best) * hk
    }
    for (const s of sources) {
      g[s] = 0
      came[s] = -1
      jump[s] = -1
      off[s] = 0
      left[s] = -1
      stamp[s] = sid
      heap.push(heur(s), s)
    }
    const relax = (c, n, cost, j, o, l) => {
      const gn = g[c] + cost
      if (gn > budget || (stamp[n] === sid && gn >= g[n])) return
      stamp[n] = sid
      g[n] = gn
      came[n] = c
      jump[n] = j
      off[n] = o
      left[n] = l
      heap.push(gn + heur(n), n)
    }
    let goal = -1
    while (heap.n > 0) {
      const c = heap.pop()
      if (done[c] === sid) continue
      done[c] = sid
      if (isGoal(c)) { goal = c; break }
      if (offNet && came[c] !== -1 && onNet(c)) continue
      const i = c % N
      const j = (c - i) / N
      for (let dj = -1; dj <= 1; dj++) {
        const nj = j + dj
        if (nj < box.j0 || nj > box.j1) continue
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue
          const ni = i + di
          if (ni < box.i0 || ni > box.i1) continue
          const n = nj * N + ni
          if (blocked[n] || done[n] === sid) continue
          const d = di !== 0 && dj !== 0 ? ROAD.cell * SQRT2 : ROAD.cell
          const grade = Math.abs(H[n] - H[c]) / d
          if (grade > ROAD.steep) continue
          const cOn = net[c] === 1
          const nOn = net[n] === 1
          if (di !== 0 && dj !== 0 && !(cOn && nOn) && net[c + di] === 1 && net[c + dj * N] === 1) continue
          const m = direct ? mul[c] + mul[n] - val[c] - val[n] : mul[c] + mul[n]
          let cost = d * 0.5 * m * (1 + (grade / gradeK) ** 2)
          let o = 0
          let l = -1
          if (cOn && nOn) {
            if (!alongWay(c, n)) continue
            cost *= reuse
          } else if (!nOn) {
            o = cOn ? 1 : off[c] + 1
            l = cOn ? c : left[c]
            if ((o === K || o === 2 * K) && l >= 0 && !openAt(l, cx(n) - cx(l), cz(n) - cz(l), o)) continue
            if (near[n] <= ROAD.apart.cells) cost *= ROAD.apart.cost
          } else {
            if (off[c] < K) continue
            let back = c
            let t = 1
            for (; t < K; t++) back = came[back]
            if (!openAt(n, cx(back) - cx(n), cz(back) - cz(n))) continue
            if (off[c] >= 2 * K - 1) {
              for (; t < 2 * K; t++) back = came[back]
              if (!openAt(n, cx(back) - cx(n), cz(back) - cz(n), 2 * K)) continue
            }
          }
          relax(c, n, cost, -1, o, l)
        }
      }
      if (crossCell[c] === 1) {
        for (const xi of crossAt.get(c)) {
          const X = crossings[xi]
          const n = X.cells[0] === c ? X.cells[1] : X.cells[0]
          if (done[n] === sid) continue
          relax(c, n, 2 * X.endD + (X.way >= 0 ? 0 : ROAD.cross.penalty * X.spans), xi, K, -1)
        }
      }
    }
    return goal < 0 ? null : trace(goal)
  }
  const trace = (goal) => {
    const path = []
    const jumps = []
    for (let c = goal; c !== -1; c = came[c]) { path.push(c); jumps.push(jump[c]) }
    path.reverse()
    jumps.reverse()
    return { path, jumps }
  }
  const reached = (c) => stamp[c] === sid
  const walkOf = (path) => {
    let m = 0
    for (let k = 1; k < path.length; k++) m += Math.hypot(cx(path[k]) - cx(path[k - 1]), cz(path[k]) - cz(path[k - 1]))
    return m
  }
  const boxAround = (pts, pad) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z) }
    const toI = (v) => Math.max(0, Math.min(N - 1, Math.floor((v + WORLD_HALF) / ROAD.cell)))
    return { i0: toI(x0 - pad), i1: toI(x1 + pad), j0: toI(z0 - pad), j1: toI(z1 + pad) }
  }

  // Lays a found path into the network: the stretches off the network become ways, joined by nodes where they leave and meet it, and a crossing becomes a bridge way between its bank nodes.
  const commit = ({ path, jumps }) => {
    let run = [path[0]]
    const close = (cells, endId) => {
      const a = nodeAtOrSplit(cells[0])
      if (a === endId && cells.length < 3) return
      addWay(cells, a, endId)
    }
    for (let k = 1; k < path.length; k++) {
      const c = path[k]
      if (jumps[k] >= 0) {
        const X = crossings[jumps[k]]
        const s = X.cells[0] === path[k - 1] ? 0 : 1
        const from = bankNode(X, s)
        if (run.length > 1) close(run, from)
        const to = bankNode(X, 1 - s)
        if (X.way < 0) X.way = addWay([X.cells[s], c], from, to, jumps[k])
        run = [c]
        continue
      }
      if (onNet(c)) {
        if (run.length > 1 || !alongWay(run[0], c)) {
          run.push(c)
          const end = nodeAtOrSplit(c)
          close(run, end)
        }
        run = [c]
      } else {
        run.push(c)
      }
    }
  }

  const portsOf = (ti) => ports.filter((id) => nodes[id].town === ti)
  const wayLen = (w) => (w.crossing >= 0 ? 2 * crossings[w.crossing].endD : (w.cells.length - 1) * ROAD.cell * 1.1)
  // A node's neighbours over the network as [node, metres, way]: along each way, and from a port through its town's centre to the town's other ports (way -1).
  const toCentre = (n) => Math.hypot(n.x - towns[n.town].x, n.z - towns[n.town].z)
  const steps = (u) => {
    const out = nodes[u].ways.map((wid) => { const w = ways[wid]; return [w.a === u ? w.b : w.a, wayLen(w), wid] })
    if (nodes[u].port) for (const v of portsOf(nodes[u].town)) if (v !== u) out.push([v, toCentre(nodes[u]) + toCentre(nodes[v]), -1])
    return out
  }
  // Road distance between two sets of nodes over the network laid so far.
  const netDist = (from, to) => {
    const dist = new Map(from.map((id) => [id, 0]))
    const heap = new Heap(64)
    from.forEach((id) => heap.push(0, id))
    const goal = new Set(to)
    const seen = new Set()
    while (heap.n > 0) {
      const f = heap.f[0]
      const u = heap.pop()
      if (seen.has(u)) continue
      if (goal.has(u)) return f
      seen.add(u)
      for (const [v, l] of steps(u)) {
        const d = f + l
        if (d < (dist.get(v) ?? Infinity)) { dist.set(v, d); heap.push(d, v) }
      }
    }
    return Infinity
  }
  const failed = []
  for (const { a, b, len } of neighbourPairs(towns)) {
    const pa = portsOf(a)
    const pb = portsOf(b)
    if (pa.length === 0 || pb.length === 0) continue
    const known = netDist(pa, pb)
    if (known < ROAD.detour * len) continue
    const goals = new Set(pb.map((id) => nodes[id].cell))
    const goalPts = pb.map((id) => [cx(nodes[id].cell), cz(nodes[id].cell)])
    const ends = [...pa, ...pb].map((id) => [cx(nodes[id].cell), cz(nodes[id].cell)])
    const find = (direct) => {
      for (const pad of [Math.max(300, len * 0.5), Math.max(900, len * 1.2)]) {
        const found = search(pa.map((id) => nodes[id].cell), (c) => goals.has(c), goalPts, boxAround(ends, pad), false, direct)
        if (found !== null) return found
      }
      return null
    }
    let found = find(false)
    if (found === null) {
      if (known === Infinity) failed.push(`${towns[a].id}-${towns[b].id}`)
      continue
    }
    // A route that winds far round, or back along the long way already laid, races a direct one.
    if (walkOf(found.path) > ROAD.direct.over * len || walkOf(found.path) >= (1 - ROAD.gain) * known) {
      const direct = find(true)
      if (direct !== null && walkOf(direct.path) < walkOf(found.path)) found = direct
    }
    if (walkOf(found.path) < (1 - ROAD.gain) * known) commit(found)
  }
  // A stub nothing used yet runs to the nearest road more than 200 m past its own town, or to another town.
  for (const id of ports) {
    const port = nodes[id]
    if (port.ways.length > 0) continue
    const t = towns[port.town]
    const others = new Set(ports.filter((o) => nodes[o].town !== port.town).map((o) => nodes[o].cell))
    const far = (c) => Math.hypot(cx(c) - t.x, cz(c) - t.z) > t.radius + 200
    const found = search([port.cell], (c) => others.has(c) || (onNet(c) && far(c)), [], boxAround([[t.x, t.z]], 1500))
    if (found === null) failed.push(`${t.id} stub ${port.port.stub}`)
    else commit(found)
  }
  const cellM = ROAD.cell * 1.1
  const distFrom = (seeds, skip = null) => {
    const D = new Float64Array(nodes.length).fill(Infinity)
    const heap = new Heap(64)
    for (const [id, d] of seeds) if (d < D[id]) { D[id] = d; heap.push(d, id) }
    while (heap.n > 0) {
      const f = heap.f[0]
      const u = heap.pop()
      if (f > D[u]) continue
      for (const [v, l, wid] of steps(u)) if (wid !== skip && f + l < D[v]) { D[v] = f + l; heap.push(D[v], v) }
    }
    return D
  }
  // Links: from a road cell, a road of at most link.reach m to web link.detour times further round by road than it walks and link.save m further. With `lay` false, the most any link from it could save (the straight distance standing in for the walk); with it, whether one was laid.
  const linkFrom = (src, lay) => {
    const sx = cx(src)
    const sz = cz(src)
    const w = nodeAt.has(src) ? null : ways[owner[src]]
    const i = ownerIdx[src]
    const D = w === null ? distFrom([[nodeAt.get(src), 0]]) : distFrom([[w.a, i * cellM], [w.b, (w.cells.length - 1 - i) * cellM]])
    const netTo = (c) => {
      if (nodeAt.has(c)) return D[nodeAt.get(c)]
      const o = ways[owner[c]]
      const k = ownerIdx[c]
      if (o === w) return Math.abs(k - i) * cellM
      return Math.min(D[o.a] + k * cellM, D[o.b] + (o.cells.length - 1 - k) * cellM)
    }
    const box = boxAround([[sx, sz]], ROAD.link.reach)
    if (lay) search([src], () => false, [], box, true, true, ROAD.link.budget * ROAD.link.reach)
    let most = 0
    const cands = []
    for (let bj = Math.floor(box.j0 / BIN); bj <= Math.floor(box.j1 / BIN); bj++) {
      for (let bi = Math.floor(box.i0 / BIN); bi <= Math.floor(box.i1 / BIN); bi++) for (const c of bins[bj * NB + bi]) {
        if (c === src || (lay && !reached(c))) continue
        // A split this near a way's end leaves a stub too short to ease between its ends' heights.
        if (!nodeAt.has(c) && Math.min(ownerIdx[c], ways[owner[c]].cells.length - 1 - ownerIdx[c]) < 4) continue
        const d = Math.hypot(cx(c) - sx, cz(c) - sz)
        if (d < ROAD.link.min || d > ROAD.link.reach) continue
        const round = netTo(c)
        if (round < Infinity && round > ROAD.link.detour * d && round - d > ROAD.link.save) { most = Math.max(most, round - d); cands.push(c) }
      }
    }
    if (!lay) return most
    // Cheapest first; the first whose walked link is short enough and saves enough is laid.
    cands.sort((p, q) => g[p] - g[q])
    for (const c of cands) {
      const found = trace(c)
      const walked = walkOf(found.path)
      if (walked > ROAD.link.reach || netTo(c) < ROAD.link.detour * walked || netTo(c) - walked < ROAD.link.save) continue
      commit(found)
      return true
    }
    return false
  }
  // Every link.step cells along each way, the biggest possible saving tried first. Laying roads only shortens the way round, so a stale bound is an overestimate: one no longer the biggest when refreshed goes back in the queue.
  const queue = new Heap(1024)
  for (const w of ways) {
    if (w.crossing >= 0) continue
    for (let k = ROAD.link.step >> 1; k < w.cells.length - 4; k += ROAD.link.step) {
      const most = linkFrom(w.cells[k], false)
      if (most > 0) queue.push(-most, w.cells[k])
    }
  }
  while (queue.n > 0) {
    const c = queue.pop()
    const most = linkFrom(c, false)
    if (most === 0) continue
    if (queue.n > 0 && most < -queue.f[0]) queue.push(-most, c)
    else linkFrom(c, true)
  }
  // Pruning: a way whose ends are joined within `prune` times its length without it goes, the most redundant first, so no road runs beside another. A way a port or a bridge hangs by stays.
  const alt = (w) => distFrom([[w.a, 0]], w.id)[w.b] / wayLen(w)
  const keeps = (w) => w.crossing >= 0 || [w.a, w.b].some((id) => nodes[id].bank !== null || (nodes[id].port && nodes[id].ways.length === 1))
  const drop = (w) => {
    w.dead = true
    for (const id of [w.a, w.b]) nodes[id].ways = nodes[id].ways.filter((x) => x !== w.id)
  }
  for (const w of ways.filter((w) => !keeps(w)).map((w) => [w, alt(w)]).sort((p, q) => p[1] - q[1]).map(([w]) => w)) {
    if (!w.dead && !keeps(w) && alt(w) < ROAD.prune) drop(w)
  }
  // A fork left with one way is a dead end, and goes; one left with two joins them into one way.
  for (let changed = true; changed;) {
    changed = false
    for (const n of nodes) {
      if (n.port || n.bank !== null) continue
      if (n.ways.length === 1) { drop(ways[n.ways[0]]); changed = true; continue }
      if (n.ways.length !== 2) continue
      const [w1, w2] = n.ways.map((id) => ways[id])
      const o1 = w1.a === n.id ? w1.b : w1.a
      const o2 = w2.a === n.id ? w2.b : w2.a
      if (w1.crossing >= 0 || w2.crossing >= 0 || o1 === o2) continue
      w1.cells = [...(w1.b === n.id ? w1.cells : w1.cells.reverse()), ...(w2.a === n.id ? w2.cells : w2.cells.reverse()).slice(1)]
      w1.a = o1
      w1.b = o2
      w2.dead = true
      nodes[o2].ways = nodes[o2].ways.map((x) => (x === w2.id ? w1.id : x))
      n.ways = []
      changed = true
    }
  }
  const live = ways.filter((w) => !w.dead)

  // --- geometry ---------------------------------------------------------------
  const cellBlocked = (x, z) => {
    const c = cellOf(x, z)
    return c < 0 || blocked[c] !== 0
  }
  // A fork takes the ground's height, then gives way until no road from it averages steeper than 0.8 maxGrade over its cells (the smoothed road runs shorter), which the relax below could not flatten between pinned ends. Ports and banks hold.
  const nodeYs = nodes.map((n) => (n.port ? n.port.end[1] : surface(n.x, n.z)))
  const free = (n) => (n.port || n.bank !== null ? 0 : 1)
  for (let it = 0; it < 500; it++) {
    let moved = false
    for (const w of live) {
      const fa = free(nodes[w.a])
      const fb = free(nodes[w.b])
      if (w.crossing >= 0 || fa + fb === 0) continue
      const lim = 0.8 * ROAD.maxGrade * walkOf(w.cells)
      const d = nodeYs[w.b] - nodeYs[w.a]
      if (Math.abs(d) <= lim + 1e-3) continue
      const fix = (Math.abs(d) - lim) * Math.sign(d)
      nodeYs[w.a] += (fix * fa) / (fa + fb)
      nodeYs[w.b] -= (fix * fb) / (fa + fb)
      moved = true
    }
    if (!moved) break
  }
  const nodeY = (node) => nodeYs[node.id]
  // A bank node's outward normal, away from its river.
  const outward = (node) => {
    const X = crossings[node.bank.crossing]
    const sg = node.bank.side === 0 ? -1 : 1
    return [sg * X.nx, sg * X.nz]
  }
  const records = []
  const roadId = () => `road${records.length}`
  for (const w of live) {
    if (w.crossing >= 0) continue
    const A = nodes[w.a]
    const B = nodes[w.b]
    // Plan points and which of them are pinned: the ends, a port's stub end, and a point out along a bank's normal so the road meets its bridge square on.
    let pts = w.cells.map((c) => [cx(c), cz(c), false])
    pts[0] = [A.x, A.z, true]
    pts[pts.length - 1] = [B.x, B.z, true]
    // The cell fork.cells out from each end is where openAt read the fork's angle, so the road runs straight to it, unswayed; a way under twice that keeps its cells from ib to ia, unswayed.
    const last = pts.length - 1
    const ia = Math.min(K, last)
    const ib = Math.max(0, last - K)
    if (!A.bank && ia < last) pts[ia] = [pts[ia][0], pts[ia][1], true, 'a']
    if (!B.bank && ib > 0) pts[ib] = [pts[ib][0], pts[ib][1], true, 'b']
    if (ia >= ib) for (let k = ib + 1; k < ia; k++) pts[k][2] = true
    pts = pts.filter((_, k) => k === 0 || k === last || (ia >= ib ? k >= ib && k <= ia : (A.bank || k >= ia) && (B.bank || k <= ib)))
    for (const [node, atStart] of [[A, true], [B, false]]) {
      if (!node.bank) continue
      const [ox, oz] = outward(node)
      const q = [node.x + ox * ROAD.cell, node.z + oz * ROAD.cell, true]
      pts = pts.filter((p) => p[2] || Math.hypot(p[0] - node.x, p[1] - node.z) > ROAD.cell * 1.5)
      if (atStart) pts.splice(1, 0, q)
      else pts.splice(pts.length - 1, 0, q)
    }
    if (A.port) pts.unshift([A.port.end[0], A.port.end[2], true])
    if (B.port) pts.push([B.port.end[0], B.port.end[2], true])
    // Densify to half a cell, then relax toward the neighbours' mean with the pins held.
    const dense = [pts[0]]
    for (let k = 1; k < pts.length; k++) {
      const [ax, az] = pts[k - 1]
      const [bx, bz, pin] = pts[k]
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (ROAD.cell / 2)))
      for (let i = 1; i <= n; i++) dense.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n, i === n && pin, i === n ? pts[k][3] : undefined])
    }
    for (let it = 0; it < ROAD.smooth; it++) {
      for (let k = 1; k < dense.length - 1; k++) {
        if (dense[k][2]) continue
        dense[k][0] = 0.5 * dense[k][0] + 0.25 * (dense[k - 1][0] + dense[k + 1][0])
        dense[k][1] = 0.5 * dense[k][1] + 0.25 * (dense[k - 1][1] + dense[k + 1][1])
      }
    }
    // Resample to ROAD.spacing, keeping the pins; a free point closer than half a spacing to the pin after it goes.
    const out = [dense[0]]
    let acc = 0
    for (let k = 1; k < dense.length; k++) {
      acc += Math.hypot(dense[k][0] - dense[k - 1][0], dense[k][1] - dense[k - 1][1])
      const pin = dense[k][2] || k === dense.length - 1
      if (pin || acc >= ROAD.spacing) {
        if (pin && acc < ROAD.spacing / 2 && out.length > 1 && !out.at(-1)[2]) out.pop()
        out.push(dense[k])
        acc = 0
      }
    }
    out[out.length - 1][2] = true
    // Meander: sway off the line, faded in from both ends and from each pin, and pulled back where it would climb out of the valley or into water.
    const wave = meander(mulberry32(hash32(seed, 6217, w.cells[0], w.cells.at(-1))), ROAD.waves)
    const arc = [0]
    for (let k = 1; k < out.length; k++) arc.push(arc[k - 1] + Math.hypot(out[k][0] - out[k - 1][0], out[k][1] - out[k - 1][1]))
    const pinArcs = arc.filter((_, k) => out[k][2])
    const legA = ia >= ib ? Infinity : arc.find((_, k) => out[k][3] === 'a') ?? -1
    const legB = arc.find((_, k) => out[k][3] === 'b') ?? Infinity
    const laid = out.map((p, k) => {
      const s = arc[k]
      if (p[2] || s < legA || s > legB) return [p[0], p[1]]
      const env = smoothstep(0, 1, Math.min(...pinArcs.map((a) => Math.abs(s - a))) / ROAD.envelope)
      const tx = out[k + 1][0] - out[k - 1][0]
      const tz = out[k + 1][1] - out[k - 1][1]
      const tl = Math.hypot(tx, tz) || 1
      const h0 = ground(p[0], p[1])
      for (const f of [1, 0.5, 0.25]) {
        const off = wave(s) * env * f
        const x = p[0] - (tz / tl) * off
        const z = p[1] + (tx / tl) * off
        if (!cellBlocked(x, z) && Math.abs(ground(x, z) - h0) < 0.12 * Math.abs(off) + 0.5) return [x, z]
      }
      return [p[0], p[1]]
    }).filter((p, k, all) => out[k][2] || Math.hypot(p[0] - all[k - 1][0], p[1] - all[k - 1][1]) > ROAD.spacing / 3)
    // The highest ground along the road out to halfway to either neighbour.
    w.laid = laid
    w.top = laid.map(([x, z], k) => {
      let t = surface(x, z)
      for (const o of [laid[k - 1], laid[k + 1]]) if (o) for (const f of [0.125, 0.25, 0.375, 0.5]) t = Math.max(t, surface(x + (o[0] - x) * f, z + (o[1] - z) * f))
      return t
    })
  }
  // Then a fork rises to no more than ROAD.cut under the ground at it, nor under the top of its laid roads less ROAD.climb a metre out to the near end of each top's span, so the lift below meets it without steepening.
  nodes.forEach((n, i) => { if (free(n)) nodeYs[i] = Math.max(surface(n.x, n.z) - ROAD.cut, nodeYs[i]) })
  for (const w of live) {
    if (w.crossing >= 0) continue
    for (const [id, dir] of [[w.a, 1], [w.b, -1]]) {
      if (!free(nodes[id])) continue
      let d = 0
      for (let i = 1; i < w.laid.length; i++) {
        const k = dir > 0 ? i : w.laid.length - 1 - i
        nodeYs[id] = Math.max(nodeYs[id], w.top[k] - ROAD.cut - ROAD.climb * d)
        d += Math.hypot(w.laid[k][0] - w.laid[k - dir][0], w.laid[k][1] - w.laid[k - dir][1])
      }
    }
  }
  // Each fork was lifted alone, so the lower of two joined forks then rises to within ROAD.climb of the higher: a way of only its two pinned ends has no point between to ease the step.
  for (let it = 0, moved = true; moved && it < 500; it++) {
    moved = false
    for (const w of live) {
      if (w.crossing >= 0 || !free(nodes[w.a]) || !free(nodes[w.b])) continue
      let len = 0
      for (let k = 1; k < w.laid.length; k++) len += Math.hypot(w.laid[k][0] - w.laid[k - 1][0], w.laid[k][1] - w.laid[k - 1][1])
      const [lo, hi] = nodeYs[w.a] < nodeYs[w.b] ? [w.a, w.b] : [w.b, w.a]
      if (nodeYs[hi] - nodeYs[lo] <= ROAD.climb * len + 1e-3) continue
      nodeYs[lo] = nodeYs[hi] - ROAD.climb * len
      moved = true
    }
  }
  for (const w of live) {
    if (w.crossing >= 0) continue
    const A = nodes[w.a]
    const B = nodes[w.b]
    const { laid, top } = w
    delete w.laid
    delete w.top
    // Heights off the live surface, Gaussian-averaged along the road (sigma ROAD.ySigma m), easing into the pinned ends.
    const s = [0]
    for (let k = 1; k < laid.length; k++) s.push(s[k - 1] + Math.hypot(laid[k][0] - laid[k - 1][0], laid[k][1] - laid[k - 1][1]))
    const raw = laid.map(([x, z]) => surface(x, z))
    raw[0] = A.port ? A.port.end[1] : nodeY(A)
    raw[raw.length - 1] = B.port ? B.port.end[1] : nodeY(B)
    const ys = raw.map((y, k) => {
      if (k === 0 || k === raw.length - 1) return y
      let sum = 0
      let wsum = 0
      for (let i = 0; i < raw.length; i++) {
        const d = (s[i] - s[k]) / ROAD.ySigma
        if (Math.abs(d) > 3) continue
        const wt = Math.exp(-0.5 * d * d)
        sum += raw[i] * wt
        wsum += wt
      }
      const avg = sum / wsum
      const ease = (end, d) => (d < 2 * ROAD.ySigma ? end + (avg - end) * smoothstep(0, 2 * ROAD.ySigma, d) : null)
      return ease(raw[0], s[k]) ?? ease(raw.at(-1), s.at(-1) - s[k]) ?? avg
    })
    // Relax any pitch steeper than ROAD.maxGrade by moving its two points toward each other, the ends held.
    for (let it = 0; it < 200; it++) {
      let moved = false
      for (let k = 1; k < ys.length; k++) {
        const lim = ROAD.maxGrade * (s[k] - s[k - 1])
        const d = ys[k] - ys[k - 1]
        if (Math.abs(d) <= lim + 1e-3) continue
        const fix = (Math.abs(d) - lim) * Math.sign(d)
        const a = k - 1 > 0 ? 1 : 0
        const b = k < ys.length - 1 ? 1 : 0
        if (a + b === 0) continue
        ys[k - 1] += (fix * a) / (a + b)
        ys[k] -= (fix * b) / (a + b)
        moved = true
      }
      if (!moved) break
    }
    // Then lift the road to no more than ROAD.cut under its top, raised further where it must climb to that at ROAD.climb: it banks over a crest rather than cutting through, and no pitch passes ROAD.climb. Only below a port or bank end it cannot rise to does the road cut deeper.
    const env = top.map((t, k) => (k === 0 || k === top.length - 1 ? -Infinity : t - ROAD.cut))
    for (let k = 1; k < env.length; k++) env[k] = Math.max(env[k], env[k - 1] - ROAD.climb * (s[k] - s[k - 1]))
    for (let k = env.length - 2; k >= 0; k--) env[k] = Math.max(env[k], env[k + 1] - ROAD.climb * (s[k + 1] - s[k]))
    // The relax may stop short, so the road first comes down to the highest line under it that pitches no steeper than ROAD.climb; every bound below pitches no steeper either.
    for (let k = 1; k < ys.length - 1; k++) ys[k] = Math.min(ys[k], ys[k - 1] + ROAD.climb * (s[k] - s[k - 1]))
    for (let k = ys.length - 2; k > 0; k--) ys[k] = Math.min(ys[k], ys[k + 1] + ROAD.climb * (s[k + 1] - s[k]))
    const y0 = ys[0]
    const y1 = ys.at(-1)
    for (let k = 1; k < ys.length - 1; k++) {
      const a = ROAD.climb * s[k]
      const b = ROAD.climb * (s.at(-1) - s[k])
      ys[k] = Math.min(y0 + a, y1 + b, Math.max(env[k], y0 - a, y1 - b, ys[k]))
    }
    w.pts = laid.map(([x, z], k) => [x, ys[k], z])
    w.length = s.at(-1)
    w.record = roadId()
    records.push({ id: w.record, pts: w.pts.map(([x, y, z]) => [x, y, z, ROAD.width]) })
  }

  // Bridges, and the straight approach from each bank node to the bridge's end, feathered tight so it shapes nothing past the bank; it cuts or fills the bank to the bridge's end height.
  const bridges = []
  for (const X of crossings) {
    if (X.way < 0) continue
    const w = ways[X.way]
    w.length = 2 * X.endD
    const { sy, yEnd } = X
    for (const s of [0, 1]) {
      const node = nodes[s === 0 ? (X.cells[0] === w.cells[0] ? w.a : w.b) : X.cells[0] === w.cells[0] ? w.b : w.a]
      const { tip } = X.side[s]
      records.push({ id: roadId(), feather: 1, pts: [[node.x, nodeY(node), node.z, ROAD.width], [tip[0], yEnd, tip[1], ROAD.width + 1]] })
    }
    // Each span's frame: origin on the centre line at the water, local +x from side 0's end to side 1's, rotation.y = yaw. A lake's spans run end to end from side 0's tip.
    const half = STONE_BRIDGE.xb * X.sx
    for (let i = 0; i < X.spans; i++) {
      const o = (2 * i + 1) * half - X.tipD
      const x = X.x + X.nx * o
      const z = X.z + X.nz * o
      bridges.push({ river: X.river, x, y: X.level, z, yaw: Math.atan2(-X.nz, X.nx), scale: [X.sx, sy, (2 * ROAD.width) / (2 * STONE_BRIDGE.inner)], ends: [-1, 1].map((sg) => [x + sg * X.nx * half, yEnd, z + sg * X.nz * half]) })
    }
  }

  // --- signposts ----------------------------------------------------------------
  // The direction a way leaves a node in, read about 15 m along it.
  const leave = (node, w) => {
    if (w.crossing >= 0) {
      const other = nodes[w.a === node.id ? w.b : w.a]
      return Math.atan2(other.z - node.z, other.x - node.x)
    }
    const pts = w.a === node.id ? w.pts : [...w.pts].reverse()
    let k = 1
    while (k < pts.length - 1 && Math.hypot(pts[k][0] - node.x, pts[k][2] - node.z) < 15) k++
    return Math.atan2(pts[k][2] - node.z, pts[k][0] - node.x)
  }
  // Shortest road distance from a node to every town but its own (unless `own`), and the way it first takes.
  const reach = (from, own = false) => {
    const dist = new Float64Array(nodes.length).fill(Infinity)
    const first = new Int32Array(nodes.length).fill(-1)
    const heap = new Heap(64)
    dist[from.id] = 0
    heap.push(0, from.id)
    const seen = new Uint8Array(nodes.length)
    while (heap.n > 0) {
      const u = heap.pop()
      if (seen[u]) continue
      seen[u] = 1
      for (const wid of nodes[u].ways) {
        const w = ways[wid]
        const v = w.a === u ? w.b : w.a
        const d = dist[u] + w.length
        if (d < dist[v]) {
          dist[v] = d
          first[v] = u === from.id ? wid : first[u]
          heap.push(d, v)
        }
      }
    }
    const best = new Map()
    nodes.forEach((n) => {
      if (n.town < 0 || (n.town === from.town && !own) || dist[n.id] === Infinity) return
      const b = best.get(n.town)
      if (b === undefined || dist[n.id] < b.dist) best.set(n.town, { town: n.town, dist: dist[n.id], way: first[n.id] })
    })
    return [...best.values()].sort((p, q) => p.dist - q.dist)
  }
  const signs = []
  for (const node of nodes) {
    const dirs = node.ways.map((wid) => ({ way: wid, a: leave(node, ways[wid]) }))
    if (node.port) {
      const stub = towns[node.town].roads[node.port.stub]
      const p = stub.at(-3) ?? stub[0]
      dirs.push({ way: -1, a: Math.atan2(p[2] - node.z, p[0] - node.x) })
    }
    if (dirs.length < 3) continue
    const r = mulberry32(hash32(seed, 3571, node.cell))
    const want = ROAD.sign.boards[0] + Math.floor(r() * (ROAD.sign.boards[1] - ROAD.sign.boards[0] + 1))
    const dests = reach(node)
    const picked = []
    for (const d of dirs) {
      const near = dests.find((t) => t.way === d.way)
      if (near !== undefined && picked.length < ROAD.sign.boards[1]) picked.push(near)
    }
    for (const t of dests) {
      if (picked.length >= want) break
      if (!picked.includes(t)) picked.push(t)
    }
    picked.sort((p, q) => p.dist - q.dist)
    // The post stands in the widest gap between the ways, off the fork, at the end of a trodden spur: a road record to a metre past the cairn, which is what keeps the verge's crowded trees (trees.js ROAD) off it.
    const angles = dirs.map((d) => d.a).sort((p, q) => p - q)
    let gap = -1
    let mid = 0
    angles.forEach((a, k) => {
      const next = k + 1 < angles.length ? angles[k + 1] : angles[0] + 2 * Math.PI
      if (next - a > gap) { gap = next - a; mid = a + gap / 2 }
    })
    const x = node.x + Math.cos(mid) * ROAD.sign.offset
    const z = node.z + Math.sin(mid) * ROAD.sign.offset
    const tx = node.x + Math.cos(mid) * (ROAD.sign.offset + 1)
    const tz = node.z + Math.sin(mid) * (ROAD.sign.offset + 1)
    records.push({ id: roadId(), feather: 1, pts: [[node.x, nodeY(node), node.z, ROAD.width], [tx, surface(tx, tz), tz, ROAD.sign.spur]] })
    signs.push({
      node: node.id,
      x,
      z,
      seed: hash32(seed, 3581, node.cell),
      boards: picked.map((t) => ({ town: t.town, dist: t.dist, angle: dirs.find((d) => d.way === t.way).a })),
    })
  }
  // Waymarks: a way longer than link.every gets posts evenly along it, on alternating verges, naming the nearest town each way and then the nearest overall.
  for (const w of live) {
    if (!w.pts || w.length <= ROAD.link.every) continue
    const count = Math.ceil(w.length / ROAD.link.every) - 1
    const ra = reach(nodes[w.a], true)
    const rb = reach(nodes[w.b], true)
    const arc = [0]
    for (let k = 1; k < w.pts.length; k++) arc.push(arc[k - 1] + Math.hypot(w.pts[k][0] - w.pts[k - 1][0], w.pts[k][2] - w.pts[k - 1][2]))
    const r = mulberry32(hash32(seed, 3583, w.cells[0], w.cells.at(-1)))
    for (let m = 1; m <= count; m++) {
      const s = (arc.at(-1) * m) / (count + 1)
      let k = 1
      while (k < w.pts.length - 1 && arc[k] < s) k++
      const [ax, ay, az] = w.pts[k - 1]
      const [bx, by, bz] = w.pts[k]
      const f = (s - arc[k - 1]) / (arc[k] - arc[k - 1])
      const px = ax + (bx - ax) * f
      const py = ay + (by - ay) * f
      const pz = az + (bz - az) * f
      const fwd = Math.atan2(bz - az, bx - ax)
      const dests = new Map()
      for (const [R, extra, angle] of [[ra, s, fwd + Math.PI], [rb, arc.at(-1) - s, fwd]]) {
        for (const t of R) {
          const b = dests.get(t.town)
          if (b === undefined || t.dist + extra < b.dist) dests.set(t.town, { town: t.town, dist: t.dist + extra, angle })
        }
      }
      const sorted = [...dests.values()].sort((p, q) => p.dist - q.dist)
      const want = ROAD.sign.boards[0] + Math.floor(r() * (ROAD.sign.boards[1] - ROAD.sign.boards[0] + 1))
      const picked = [fwd + Math.PI, fwd].map((a) => sorted.find((t) => t.angle === a)).filter((t) => t !== undefined)
      for (const t of sorted) {
        if (picked.length >= want) break
        if (!picked.includes(t)) picked.push(t)
      }
      picked.sort((p, q) => p.dist - q.dist)
      const side = fwd + (m % 2 === 0 ? 0.5 : -0.5) * Math.PI
      const tx = px + Math.cos(side) * (ROAD.sign.offset + 1)
      const tz = pz + Math.sin(side) * (ROAD.sign.offset + 1)
      records.push({ id: roadId(), feather: 1, pts: [[px, py, pz, ROAD.width], [tx, surface(tx, tz), tz, ROAD.sign.spur]] })
      signs.push({
        node: -1,
        way: w.id,
        x: px + Math.cos(side) * ROAD.sign.offset,
        z: pz + Math.sin(side) * ROAD.sign.offset,
        seed: hash32(seed, 3589, w.cells[0], m),
        boards: picked.map((t) => ({ town: t.town, dist: t.dist, angle: t.angle })),
      })
    }
  }
  return { records, ways: live, nodes, bridges, signs, crossings, failed }
}
