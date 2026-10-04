// The cave as a signed distance field (design/39-caves.md §4): positive in rock, negative in air, roughly metres. Pure, and deterministic from the graph, so the mesher (in a worker) and the walk surface (on the main thread) build identical copies and agree to the millimetre.
//
// Passages are D-shaped: a half-ellipse vault over a flat floor, swept along each edge's samples. Nodes are ellipsoid domes cut by a floor. The pieces join by a smooth min, so every junction gets a fillet instead of a crease.

import { Noise3 } from './noise3.js'

const BIN = 8
// Smooth-min radius: how wide the fillet where two pieces of air meet. It also sags a shared floor by up to BLEND / 4, which is why a passage's own segments join by a hard min.
const BLEND = 0.8
// Past this distance from the surface, the wall noise cannot change the sign, so it is skipped.
const ROUGH = 1.4
const FAR = 50

export class CaveField {
  constructor(graph, seed) {
    this.graph = graph
    this.noise = new Noise3(seed ^ 0x51ab)
    this.floorNoise = new Noise3(seed ^ 0x7e1d)
    const prims = []
    for (const n of graph.nodes) {
      const r = Math.max(n.rx, n.rz)
      prims.push({
        node: true, rough: 1, group: n.i, region: n.region, x: n.x, y: n.y, z: n.z, c: Math.cos(n.rot), s: Math.sin(n.rot), rx: n.rx, rz: n.rz, h: n.h, dish: n.dish, cavern: n.kind === 'cavern',
        x0: n.x - r, x1: n.x + r, z0: n.z - r, z1: n.z + r, y0: n.y - n.dish - 1, y1: n.y + n.h * 1.05,
      })
    }
    const run = (pts, group, regionAt, rough) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const p = pts[k], q = pts[k + 1]
        const ex = q.x - p.x, ez = q.z - p.z
        const w = Math.max(p.w, q.w), h = Math.max(p.h, q.h)
        prims.push({
          node: false, rough, group, region: regionAt(k), ca: p.cut, cb: q.cut,
          ax: p.x, az: p.z, ex, ez, il2: 1 / (ex * ex + ez * ez), len: Math.hypot(ex, ez), ya: p.y, yb: q.y, wa: p.w, wb: q.w, ha: p.h, hb: q.h,
          x0: Math.min(p.x, q.x) - w, x1: Math.max(p.x, q.x) + w, z0: Math.min(p.z, q.z) - w, z1: Math.max(p.z, q.z) + w,
          y0: Math.min(p.y, q.y) - 1, y1: Math.max(p.y, q.y) + h,
        })
      }
    }
    for (const e of graph.edges) {
      const ra = graph.nodes[e.a].region, rb = graph.nodes[e.b].region
      run(e.pts, graph.nodes.length + e.i, (k) => (k < e.pts.length / 2 ? ra : rb), e.kind === 'sump' ? 0.3 : 1)
    }
    let group = graph.nodes.length + graph.edges.length
    for (const l of graph.lobes) {
      const r = Math.max(l.rx, l.rz)
      prims.push({
        node: true, rough: 1, group: group++, region: l.region, x: l.x, y: l.y, z: l.z, c: Math.cos(l.rot), s: Math.sin(l.rot), rx: l.rx, rz: l.rz, h: l.h, dish: 0, cavern: false,
        x0: l.x - r, x1: l.x + r, z0: l.z - r, z1: l.z + r, y0: l.y - 1, y1: l.y + l.h * 1.05,
      })
    }
    for (const o of graph.nooks) run(o.pts, group++, () => o.region, 1)
    const pad = BLEND + ROUGH
    for (const p of prims) { p.x0 -= pad; p.x1 += pad; p.z0 -= pad; p.z1 += pad; p.y0 -= pad; p.y1 += pad }
    this.prims = prims
    this.box = {
      x0: Math.min(...prims.map((p) => p.x0)), x1: Math.max(...prims.map((p) => p.x1)),
      y0: Math.min(...prims.map((p) => p.y0)), y1: Math.max(...prims.map((p) => p.y1)),
      z0: Math.min(...prims.map((p) => p.z0)), z1: Math.max(...prims.map((p) => p.z1)),
    }
    this.bx = Math.floor(this.box.x0 / BIN)
    this.bz = Math.floor(this.box.z0 / BIN)
    this.nbx = Math.floor(this.box.x1 / BIN) - this.bx + 1
    this.nbz = Math.floor(this.box.z1 / BIN) - this.bz + 1
    this.bins = Array.from({ length: this.nbx * this.nbz }, () => [])
    prims.forEach((p, i) => {
      for (let bz = Math.floor(p.z0 / BIN) - this.bz; bz <= Math.floor(p.z1 / BIN) - this.bz; bz++) {
        for (let bx = Math.floor(p.x0 / BIN) - this.bx; bx <= Math.floor(p.x1 / BIN) - this.bx; bx++) this.bins[bz * this.nbx + bx].push(i)
      }
    })
    // Which prim the last at() call found nearest: the mesher reads it for the region colour.
    this.owner = -1
  }

  /** The prims whose padded boxes overlap a box: the mesher's per-chunk short list. */
  primsIn(x0, y0, z0, x1, y1, z1) {
    const out = []
    this.prims.forEach((p, i) => { if (p.x1 >= x0 && p.x0 <= x1 && p.y1 >= y0 && p.y0 <= y1 && p.z1 >= z0 && p.z0 <= z1) out.push(i) })
    return out
  }

  _bin(x, z) {
    const bx = Math.floor(x / BIN) - this.bx, bz = Math.floor(z / BIN) - this.bz
    if (bx < 0 || bz < 0 || bx >= this.nbx || bz >= this.nbz) return null
    return this.bins[bz * this.nbx + bx]
  }

  /** Signed distance at a point; `list` is an optional short list of prim indices to consider (from primsIn). */
  at(x, y, z, list) {
    const ids = list === undefined ? this._bin(x, z) : list
    this.owner = -1
    if (ids === null) return FAR
    // ids ascend, so a passage's segments arrive together: a hard min within the group, the smooth min between groups.
    // sw, sWall: each prim's wall weight blended by its nearness, so the carve has no seam where the nearest prim changes.
    let d = FAR, best = FAR, g = FAR, group = -1, sw = 0, sWall = 0
    const prims = this.prims
    for (let k = 0; k <= ids.length; k++) {
      const p = k < ids.length ? prims[ids[k]] : null
      if (p !== null && (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1 || y < p.y0 || y > p.y1)) continue
      if (p === null || p.group !== group) {
        const h = Math.max(BLEND - Math.abs(d - g), 0) / BLEND
        d = Math.min(d, g) - h * h * BLEND * 0.25
        if (p === null) break
        g = FAR
        group = p.group
      }
      const di = p.node ? this._node(p, x, y, z) : this._seg(p, x, y, z)
      if (di < g) g = di
      if (di < best) { best = di; this.owner = ids[k] }
      const v = this._v
      const wt = Math.exp(-6 * (di < -3 ? -3 : di))
      sw += wt
      sWall += wt * p.rough * (v < 0.3 ? 0 : v > 1.4 ? 1 : (v - 0.3) / 1.1)
    }
    if (d > ROUGH || d < -ROUGH) return d
    // Roughness only ever carves, so no lump of rock comes lower than the shape a passage's headroom was rolled for. It fades out toward each prim's floor, which bump() roughens instead: carved, a floor would pit past her step.
    const wall = sWall / sw
    const n = this.noise
    const fine = 0.12 * (1 + n.at3(x * 0.9, y * 1.1, z * 0.9)) + 0.04 * (1 + n.at3(x * 2.6, y * 3, z * 2.6))
    if (wall === 0) return d - 0.25 * fine
    // Big lumps warped along the wall, so it bellies and folds rather than ripples.
    const wx = x + 1.5 * n.at3(z * 0.15, y * 0.2, x * 0.15)
    const lump = 0.42 * (1 + n.at3(wx * 0.3, y * 0.36, z * 0.3))
    return d - wall * (lump + fine) - (1 - wall) * 0.25 * fine
  }

  /** The floor bump shared by every floor, so a passage meets its chamber without a step: broad swells and sharp ridged ledges. Never above the nominal floor, for the same reason. */
  bump(x, z) {
    const f = this.floorNoise
    return 0.18 * f.at2(x * 0.45, z * 0.45) + 0.1 * (1 - 2 * Math.abs(f.at2(x * 1.1 + 7, z * 1.1))) + 0.04 * f.at2(x * 3, z * 3) - 0.32
  }

  _node(p, x, y, z) {
    const dx = x - p.x, dz = z - p.z
    const lx = (dx * p.c + dz * p.s) / p.rx, lz = (dz * p.c - dx * p.s) / p.rz
    const ry = 0.8 * p.h
    const ly = (y - p.y - 0.25 * p.h) / ry
    const q = Math.sqrt(lx * lx + lz * lz + ly * ly)
    const shell = (q - 1) * Math.min(p.rx, p.rz, ry)
    const rho2 = lx * lx + lz * lz
    let floor = p.y + this.bump(x, z)
    if (p.dish > 0) floor -= p.dish * Math.max(0, 1 - rho2 / 0.4356)
    // Swells in a cavern's floor, gone by its rim so a passage's ramp starts level with it.
    if (p.cavern) floor += 0.5 * this.floorNoise.at2(x * 0.11, z * 0.11) * Math.min(1, rho2 * 2, Math.max(0, (0.81 - rho2) / 0.3))
    this._v = y - floor
    return Math.max(shell, floor - y)
  }

  _seg(p, x, y, z) {
    const along = ((x - p.ax) * p.ex + (z - p.az) * p.ez) * p.il2
    const u = along < 0 ? 0 : along > 1 ? 1 : along
    const t = Math.hypot(x - p.ax - u * p.ex, z - p.az - u * p.ez)
    const w = p.wa + (p.wb - p.wa) * u, h = p.ha + (p.hb - p.ha) * u
    // The floor climbs a metre a metre into the rounded end caps: otherwise the lower of two segments on a climb shelves a terrace as far into the next as it is wide.
    const over = (along < 0 ? -along : along > 1 ? along - 1 : 0) * p.len
    let floor = p.ya + (p.yb - p.ya) * along + over + this.bump(x, z)
    const cut = p.ca + (p.cb - p.ca) * u
    if (cut > 0) floor -= cut * Math.max(0, 1 - (t / (0.55 * w)) ** 2)
    const v = y - floor
    this._v = v
    const a = t / w, b = v / h
    return Math.max((Math.sqrt(a * a + b * b) - 1) * Math.min(w, h), -v)
  }
}
