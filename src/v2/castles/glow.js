// The exterior's flames baked into the exterior and court meshes (design/44-castles.md, Light): the court's torch posts, braziers and
// forge as firelight in each vertex's `light` x, shadowed by the castle's solids; render/castles.js scales it by the night. Plain
// data, so it runs in the castle worker. Exterior metres, floor at 0.
import { courtProps, propFlames, roofProps } from './furnish.js'
import { exteriorSpans, SPANS } from './solids.js'

// Per flame: reach (m), gain at the flame, saturation cap, and the share a face lit edge-on keeps. A quad within reach is cut into
// `cell` m cells to carry it. Shadows: rays marched in `step` m over a height grid of `grid` m, from `off` m off the face, stopping
// `near` m short of the flame.
export const GLOW = { reach: 9, gain: 1.6, cap: 1.3, wrap: 0.35, cell: 1.5, grid: 0.25, step: 0.2, off: 0.3, near: 0.3 }

/** `{ at(p, n), split(p, n, corners) }` for shell.js Mesher's `lit`: [glow, 0, 0] at raw exterior point p on a face of unit normal
 * n, and the cell a quad on those corners is cut into (0 where no flame reaches it). `solids` castleSolids(lay). */
export function courtGlow(lay, solids) {
  const G = GLOW, list = propFlames([...courtProps(lay), ...roofProps(lay)]), flames = []
  for (let i = 0; i < list.length; i += 5) flames.push([list[i], list[i + 1] + list[i + 3] * 0.4, list[i + 2]])
  // A flame's own stand would shadow the ground round its foot: what it stands on is left out of the grid.
  const under = (b) => flames.some(([x, y, z]) => {
    const dx = x - b.x, dz = z - b.z
    return b.hi <= y && Math.abs(dx * b.c - dz * b.s) <= b.hu && Math.abs(dx * b.s + dz * b.c) <= b.hv
  })
  const ex = { ...solids.ex, boxes: solids.ex.boxes.filter((b) => !under(b)) }
  const xs = flames.map((f) => f[0]), zs = flames.map((f) => f[2])
  const x0 = Math.min(...xs) - G.reach, z0 = Math.min(...zs) - G.reach
  const nx = Math.ceil((Math.max(...xs) + G.reach - x0) / G.grid), nz = Math.ceil((Math.max(...zs) + G.reach - z0) / G.grid)
  const top = new Float32Array(flames.length ? nx * nz : 0)
  for (let i = 0; i < nx && flames.length; i++) for (let j = 0; j < nz; j++) {
    const n = exteriorSpans(ex, x0 + (i + 0.5) * G.grid, z0 + (j + 0.5) * G.grid)
    let t = -Infinity
    for (let k = 0; k < n; k++) t = Math.max(t, SPANS.HI[k])
    top[i * nz + j] = t
  }
  const blocked = (x, y, z) => {
    const i = Math.floor((x - x0) / G.grid), j = Math.floor((z - z0) / G.grid)
    return i >= 0 && j >= 0 && i < nx && j < nz && y < top[i * nz + j]
  }
  const seen = (q, f) => {
    const dx = f[0] - q[0], dy = f[1] - q[1], dz = f[2] - q[2], d = Math.hypot(dx, dy, dz), n = Math.floor((d - G.near) / G.step)
    for (let s = 1; s <= n; s++) if (blocked(q[0] + dx * s * G.step / d, q[1] + dy * s * G.step / d, q[2] + dz * s * G.step / d)) return false
    return true
  }
  const bake = (p, n) => {
    const q = [p[0] + n[0] * G.off, p[1] + n[1] * G.off, p[2] + n[2] * G.off]
    let sum = 0
    for (const f of flames) {
      const dx = f[0] - p[0], dy = f[1] - p[1], dz = f[2] - p[2], d = Math.max(0.05, Math.hypot(dx, dy, dz))
      if (d >= G.reach) continue
      const ndl = Math.max(0, (n[0] * dx + n[1] * dy + n[2] * dz) / d)
      if (seen(q, f)) sum += G.gain * (1 - d / G.reach) ** 2 * (G.wrap + (1 - G.wrap) * ndl)
    }
    return [G.cap * (1 - Math.exp(-sum / G.cap)), 0, 0]
  }
  // Grid vertices recur in up to six faces: memoized by centimetre and normal.
  const memo = new Map()
  const at = (p, n) => {
    const key = `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)},${Math.round(n[0] * 20)},${Math.round(n[1] * 20)},${Math.round(n[2] * 20)}`
    let v = memo.get(key)
    if (v === undefined) memo.set(key, v = bake(p, n))
    return v
  }
  const split = (p, n, corners) => {
    const lo = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))), hi = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k])))
    const near = flames.some((f) => Math.hypot(...[0, 1, 2].map((k) => Math.max(lo[k] - f[k], 0, f[k] - hi[k]))) < G.reach
      && corners.some((c) => n[0] * (f[0] - c[0]) + n[1] * (f[1] - c[1]) + n[2] * (f[2] - c[2]) > 0))
    return near ? G.cell : 0
  }
  return { at, split }
}
