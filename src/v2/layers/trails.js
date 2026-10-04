// The trail from each cave mouth to the road network (design/39-caves.md §2): one Dijkstra over the roads' 8 m grid outward from every road cell at once, then each mouth follows it back to the nearest road or to a trail already laid. Half a road wide, and no signpost where it joins. Three-free and a pure function of its inputs, like the roads.
import { smoothstep } from '../../sim/mathx.js'
import { MOUTH } from '../caves/sites.js'
import { Heap } from './route.js'
import { ROAD, buildGrid, GRID_N as N, cellX as cx, cellZ as cz, cellOf } from './roads.js'

export const TRAIL = {
  width: ROAD.width / 2,
  feather: 3,
  // Metres out from the foot it runs straight, square to the arch, before it turns: past the notch's floor and the approach clefts.js keeps clear.
  straight: 10,
  // Costs as the roads' (roads.js search), but a footpath takes a steeper pitch at the same price, and one up to `steep` at all.
  grade: 0.12,
  steep: 0.5,
  spacing: 6,
  ySigma: 6,
  smooth: 8,
  // A trail joins no road this near a signpost, so no sign seems to point down it.
  signClear: 24,
}

const SQRT2 = Math.SQRT2

/**
 * The cost field from the road network over the whole grid, as `{ start(m), lay(mouths) }`: `start` is the cell a trail from mouth `m` sets out from, or -1 where no road reaches it; `lay` returns `{ records, trails, failed }`, a road record per mouth (`trail<k>`), each mouth's `{ mouth, record, length, onto }` where `onto` is 'road' or the record it joins, and the mouths `start` refused.
 * `roadPlan` is planRoads' result, already added to `layers`.
 */
export function routeTrails({ towns, roadPlan, surface, layers }) {
  // On the live surface, not the raw heightmap the roads route on: that misses the relief's cliffs, and a trail has no cut to take them.
  const { H, blocked, mul } = buildGrid(surface, surface, layers, towns)
  // Every laid way's centreline as segments [ax, ay, az, bx, by, bz], and its cells as the search's sources.
  const segs = []
  for (const w of roadPlan.ways) {
    if (w.crossing >= 0) continue
    for (let k = 1; k < w.pts.length; k++) segs.push([...w.pts[k - 1], ...w.pts[k]])
  }
  const g = new Float64Array(N * N).fill(Infinity)
  const came = new Int32Array(N * N).fill(-1)
  const heap = new Heap(1 << 16)
  const nearSign = (x, z) => roadPlan.signs.some((s) => Math.hypot(s.x - x, s.z - z) < TRAIL.signClear)
  for (const [ax, , az, bx, , bz] of segs) {
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / (ROAD.cell / 4))
    for (let i = 0; i <= n; i++) {
      const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n
      const c = cellOf(x, z)
      if (c < 0 || g[c] === 0 || nearSign(x, z)) continue
      g[c] = 0
      heap.push(0, c)
    }
  }
  const done = new Uint8Array(N * N)
  while (heap.n > 0) {
    const c = heap.pop()
    if (done[c]) continue
    done[c] = 1
    const i = c % N
    const j = (c - i) / N
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if ((di === 0 && dj === 0) || i + di < 0 || i + di >= N || j + dj < 0 || j + dj >= N) continue
      const n = c + dj * N + di
      if (blocked[n] || done[n]) continue
      const d = di !== 0 && dj !== 0 ? ROAD.cell * SQRT2 : ROAD.cell
      const grade = Math.abs(H[n] - H[c]) / d
      if (grade > TRAIL.steep) continue
      const gn = g[c] + d * 0.5 * (mul[c] + mul[n]) * (1 + (grade / TRAIL.grade) ** 2)
      if (gn >= g[n]) continue
      g[n] = gn
      came[n] = c
      heap.push(gn, n)
    }
  }

  // The nearest point to (x, z) on a list of segments, with its height.
  const nearestOn = (list, x, z) => {
    let best = null, bd = Infinity
    for (const [ax, ay, az, bx, by, bz] of list) {
      const vx = bx - ax, vz = bz - az
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)))
      const px = ax + vx * t, pz = az + vz * t
      const dd = (px - x) ** 2 + (pz - z) ** 2
      if (dd < bd) { bd = dd; best = [px, ay + (by - ay) * t, pz] }
    }
    return best
  }
  const approach = (m) => [m.x + m.nx * TRAIL.straight, m.z + m.nz * TRAIL.straight]
  // The approach's cell, or the cheapest reached one round it where that is blocked or cut off, and no steeper than TRAIL.steep from the floor.
  const start = (m) => {
    const [ax, az] = approach(m)
    const a0 = cellOf(ax, az)
    let c0 = -1
    for (let r = 0; r <= 3 && c0 < 0 && a0 >= 0; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const c = a0 + dj * N + di
      if (c < 0 || c >= N * N || g[c] === Infinity || Math.abs(H[c] - m.y) > TRAIL.steep * Math.hypot(cx(c) - m.x, cz(c) - m.z)) continue
      if (c0 < 0 || g[c] < g[c0]) c0 = c
    }
    return c0
  }
  const lay = (mouths) => {
    const trailAt = new Int32Array(N * N).fill(-1)
    const records = [], trails = [], failed = [], trailSegs = []
    for (const m of mouths) {
      const out = (s) => [m.x + m.nx * s, m.z + m.nz * s]
      const [ax, az] = approach(m)
      const c0 = start(m)
      if (c0 < 0) { failed.push(m.id); continue }
      const cells = []
      let c = c0
      while (g[c] > 0 && trailAt[c] < 0) { cells.push(c); c = came[c] }
      const onto = trailAt[c] >= 0 ? trails[trailAt[c]].record : 'road'
      const end = trailAt[c] >= 0 ? nearestOn(trailSegs[trailAt[c]], cx(c), cz(c)) : nearestOn(segs, cx(c), cz(c))
      // Pinned from half a metre short of the wall, so the dirt runs up to the arch, straight out across the floor to the approach.
      const pts = [[...out(0.5 - MOUTH.wall), true], [...out(MOUTH.floorOut - MOUTH.wall), true], [ax, az, true], ...cells.slice(1).map((q) => [cx(q), cz(q), false]), [end[0], end[2], true]]
      // Densify to half a cell, then relax toward the neighbours' mean with the pins held, and resample to TRAIL.spacing.
      const dense = [pts[0]]
      for (let k = 1; k < pts.length; k++) {
        const [px, pz] = pts[k - 1]
        const [qx, qz, pin] = pts[k]
        const n = Math.max(1, Math.ceil(Math.hypot(qx - px, qz - pz) / (ROAD.cell / 2)))
        for (let i = 1; i <= n; i++) dense.push([px + ((qx - px) * i) / n, pz + ((qz - pz) * i) / n, i === n && pin])
      }
      for (let it = 0; it < TRAIL.smooth; it++) {
        for (let k = 1; k < dense.length - 1; k++) {
          if (dense[k][2]) continue
          dense[k][0] = 0.5 * dense[k][0] + 0.25 * (dense[k - 1][0] + dense[k + 1][0])
          dense[k][1] = 0.5 * dense[k][1] + 0.25 * (dense[k - 1][1] + dense[k + 1][1])
        }
      }
      const laid = [dense[0]]
      let acc = 0
      for (let k = 1; k < dense.length; k++) {
        acc += Math.hypot(dense[k][0] - dense[k - 1][0], dense[k][1] - dense[k - 1][1])
        const pin = dense[k][2] || k === dense.length - 1
        if (pin || acc >= TRAIL.spacing) {
          if (pin && acc < TRAIL.spacing / 2 && laid.length > 1 && !laid.at(-1)[2]) laid.pop()
          laid.push(dense[k])
          acc = 0
        }
      }
      // Heights off the ground, Gaussian-averaged along the trail, level on the floor and easing into the junction.
      const s = [0]
      for (let k = 1; k < laid.length; k++) s.push(s[k - 1] + Math.hypot(laid[k][0] - laid[k - 1][0], laid[k][1] - laid[k - 1][1]))
      const floorEnd = MOUTH.floorOut - 0.5 + 1e-6
      const raw = laid.map(([x, z], k) => (s[k] <= floorEnd ? m.y : surface(x, z)))
      raw[raw.length - 1] = end[1]
      const ys = raw.map((y, k) => {
        if (s[k] <= floorEnd || k === raw.length - 1) return y
        let sum = 0, wsum = 0
        for (let i = 0; i < raw.length; i++) {
          const d = (s[i] - s[k]) / TRAIL.ySigma
          if (Math.abs(d) > 3) continue
          const wt = Math.exp(-0.5 * d * d)
          sum += raw[i] * wt
          wsum += wt
        }
        const toEnd = s.at(-1) - s[k]
        return toEnd < 2 * TRAIL.ySigma ? end[1] + (sum / wsum - end[1]) * smoothstep(0, 2 * TRAIL.ySigma, toEnd) : sum / wsum
      })
      const id = `trail${records.length}`
      const k = trails.length
      records.push({ id, feather: TRAIL.feather, pts: laid.map(([x, z], i) => [x, ys[i], z, TRAIL.width]) })
      trails.push({ mouth: m.id, record: id, length: s.at(-1), onto })
      const mine = []
      for (let i = 1; i < laid.length; i++) mine.push([laid[i - 1][0], ys[i - 1], laid[i - 1][1], laid[i][0], ys[i], laid[i][1]])
      trailSegs.push(mine)
      for (const q of cells) trailAt[q] = k
    }
    return { records, trails, failed }
  }
  return { start, lay }
}
