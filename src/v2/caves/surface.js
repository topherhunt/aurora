// The cave surface as drawn (design/39-caves.md §6): tier 0's triangles, bucketed in 1 m cells, for things that must sit on the mesh the player sees rather than on the field it was cut from -- chalk, veins. The two differ by centimetres, and a mark laid on the field sinks under the mesh wherever the mesh bulges out.

import { CHUNK } from './mesh.js'

const CELL = 1
const PAD = 1
const SIDE = CHUNK + 2 * PAD
const SLIVER = 2e-4

// Closest point of triangle (a, b, c) to p into `out`; Ericson, Real-Time Collision Detection 5.1.5.
function closest(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  let u, v
  if (d1 <= 0 && d2 <= 0) { u = 0; v = 0 } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4
    if (d3 >= 0 && d4 <= d3) { u = 1; v = 0 } else if (vc <= 0 && d1 >= 0 && d3 <= 0) { u = d1 / (d1 - d3); v = 0 } else if (d6 >= 0 && d5 <= d6) { u = 0; v = 1 } else if (vb <= 0 && d2 >= 0 && d6 <= 0) { u = 0; v = d2 / (d2 - d6) } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); u = 1 - w; v = w
    } else { const den = 1 / (va + vb + vc); u = vb * den; v = vc * den }
  }
  out[0] = ax + abx * u + acx * v; out[1] = ay + aby * u + acy * v; out[2] = az + abz * u + acz * v
}

/** One chunk's triangles and a cell grid over them. */
class Bucket {
  constructor(ci, cj, ck, mesh) {
    this.ox = ci * CHUNK - PAD; this.oy = cj * CHUNK - PAD; this.oz = ck * CHUNK - PAD
    this.pos = mesh.pos
    this.index = mesh.index
    this.cells = new Map()
    const n = SIDE / CELL
    const { pos, index } = mesh
    const lo = [0, 0, 0], hi = [0, 0, 0]
    for (let t = 0; t < index.length; t += 3) {
      for (let a = 0; a < 3; a++) {
        const o = [this.ox, this.oy, this.oz][a]
        let mn = Infinity, mx = -Infinity
        for (let c = 0; c < 3; c++) { const x = pos[index[t + c] * 3 + a]; mn = Math.min(mn, x); mx = Math.max(mx, x) }
        lo[a] = Math.max(0, Math.floor((mn - o) / CELL)); hi[a] = Math.min(n - 1, Math.floor((mx - o) / CELL))
      }
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const key = (k * n + j) * n + i
        const list = this.cells.get(key)
        if (list === undefined) this.cells.set(key, [t]); else list.push(t)
      }
    }
  }
}

const _q = [0, 0, 0]

export class Surface {
  /** `source(key)` gives chunk `key` ("i,j,k")'s tier-0 { pos, index } (mesh.js drawnSurface), or null where it draws nothing. */
  constructor(source) {
    this.source = source
    this.buckets = new Map()
  }

  /** Forgets chunk `key`, for when its mesh arrives or changes. */
  drop(key) {
    this.buckets.delete(key)
  }

  _bucket(i, j, k) {
    const key = `${i},${j},${k}`
    let b = this.buckets.get(key)
    if (b === undefined) {
      const m = this.source(key)
      b = m === null ? null : new Bucket(i, j, k, m)
      this.buckets.set(key, b)
    }
    return b
  }

  /**
   * The drawn triangle nearest (x, y, z) within `reach`: into `out` [qx, qy, qz, nx, ny, nz, distance], its closest point and unit face normal (out of the rock). False when none is that near.
   */
  nearest(x, y, z, reach, out) {
    let best = reach * reach, found = false
    // A chunk's triangles overhang its box by up to PAD, so neighbours within PAD of the query are searched too.
    const m = reach + PAD
    const i0 = Math.floor((x - m) / CHUNK), i1 = Math.floor((x + m) / CHUNK)
    const j0 = Math.floor((y - m) / CHUNK), j1 = Math.floor((y + m) / CHUNK)
    const k0 = Math.floor((z - m) / CHUNK), k1 = Math.floor((z + m) / CHUNK)
    const n = SIDE / CELL
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const b = this._bucket(i, j, k)
      if (b === null) continue
      const ci0 = Math.max(0, Math.floor((x - reach - b.ox) / CELL)), ci1 = Math.min(n - 1, Math.floor((x + reach - b.ox) / CELL))
      const cj0 = Math.max(0, Math.floor((y - reach - b.oy) / CELL)), cj1 = Math.min(n - 1, Math.floor((y + reach - b.oy) / CELL))
      const ck0 = Math.max(0, Math.floor((z - reach - b.oz) / CELL)), ck1 = Math.min(n - 1, Math.floor((z + reach - b.oz) / CELL))
      const { pos, index } = b
      for (let c = ck0; c <= ck1; c++) for (let r = cj0; r <= cj1; r++) for (let q = ci0; q <= ci1; q++) {
        const list = b.cells.get((c * n + r) * n + q)
        if (list === undefined) continue
        for (const t of list) {
          const a = index[t] * 3, bb = index[t + 1] * 3, cc = index[t + 2] * 3
          const ux = pos[bb] - pos[a], uy = pos[bb + 1] - pos[a + 1], uz = pos[bb + 2] - pos[a + 2]
          const vx = pos[cc] - pos[a], vy = pos[cc + 1] - pos[a + 1], vz = pos[cc + 2] - pos[a + 2]
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
          const l = Math.hypot(nx, ny, nz)
          // Clustering folds sliver triangles whose winding is arbitrary; they are not a surface to stand off.
          if (l < SLIVER) continue
          closest(x, y, z, pos[a], pos[a + 1], pos[a + 2], pos[bb], pos[bb + 1], pos[bb + 2], pos[cc], pos[cc + 1], pos[cc + 2], _q)
          const d = (_q[0] - x) ** 2 + (_q[1] - y) ** 2 + (_q[2] - z) ** 2
          if (d >= best) continue
          best = d; found = true
          out[0] = _q[0]; out[1] = _q[1]; out[2] = _q[2]; out[3] = nx / l; out[4] = ny / l; out[5] = nz / l; out[6] = Math.sqrt(d)
        }
      }
    }
    return found
  }

  /**
   * A point `off` out from the drawn surface nearest (x, y, z) (within `reach` of it), and the surface normal there, into `out` [x, y, z, nx, ny, nz]; false when the surface is not that near. Where the first guess lands closer than `off` to another face (a crease), it is pushed away from that face.
   */
  lifted(x, y, z, reach, off, out) {
    const s = _s
    if (!this.nearest(x, y, z, reach, s)) return false
    out[3] = s[3]; out[4] = s[4]; out[5] = s[5]
    let px = s[0] + s[3] * off, py = s[1] + s[4] * off, pz = s[2] + s[5] * off
    for (let i = 0; i < 12; i++) {
      if (!this.nearest(px, py, pz, off * 2, s) || s[6] > off - 0.002) break
      const dx = px - s[0], dy = py - s[1], dz = pz - s[2]
      const l = Math.hypot(dx, dy, dz)
      if (l < 1e-9) { px = s[0] + s[3] * off; py = s[1] + s[4] * off; pz = s[2] + s[5] * off; continue }
      px = s[0] + (dx / l) * off; py = s[1] + (dy / l) * off; pz = s[2] + (dz / l) * off
    }
    out[0] = px; out[1] = py; out[2] = pz
    return true
  }
}

const _s = [0, 0, 0, 0, 0, 0, 0]
