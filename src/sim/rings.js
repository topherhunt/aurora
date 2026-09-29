// ---------------------------------------------------------------------------
// Closed XZ rings: area, point-in-ring, simplification and even spacing.
//
// A ring is a flat array [x0, z0, x1, z1, ...] with NO repeated last point -- every routine here closes it by wrapping. Two things build them: src/v3/hydrology.js traces a lake's shore off the flooded cells and bakes it into the world doc, and src/v2/render/shoreline.js contours the height field for a lake v2 authored. Both simplify and space the result the same way, which is why these live here and not in either of them.
//
// Three-free and DOM-free: pure arithmetic over numbers.
// ---------------------------------------------------------------------------

/** Twice the signed area of a flat XZ ring: positive counter-clockwise in (x, z). */
export function ringArea(pts) {
  let a = 0
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]
  }
  return a
}

/** Even-odd point-in-ring on a flat XZ ring. */
export function inRing(pts, x, z) {
  let inside = false
  for (let i = 0, n = pts.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = pts[i], zi = pts[i + 1], xj = pts[j], zj = pts[j + 1]
    if (zi > z !== zj > z && x < xi + ((z - zi) * (xj - xi)) / (zj - zi)) inside = !inside
  }
  return inside
}

/**
 * Douglas-Peucker on a closed ring: anchored at its first point and the point farthest from it, each arc between two anchors simplified as an open line.
 *
 * `pinned` names indices that must survive as vertices, and each one becomes another anchor. Its use is a shore a river leaves by: the tolerance is free to cut a corner off a bank anywhere else, but a vertex cut off there leaves the outlet's own texel a metre or two OUTSIDE the ring, and then the water the river starts in is not water as far as anything reading the ring is concerned.
 */
export function simplifyRing(pts, tolerance, pinned = null) {
  const n = pts.length / 2
  if (n < 3) return []
  let far = 0, farD = -1
  for (let i = 1; i < n; i++) {
    const d = (pts[i * 2] - pts[0]) ** 2 + (pts[i * 2 + 1] - pts[1]) ** 2
    if (d > farD) {
      farD = d
      far = i
    }
  }
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[far] = 1
  if (pinned !== null) for (const i of pinned) if (i > 0 && i < n) keep[i] = 1
  const stack = []
  let prev = 0
  for (let i = 1; i <= n; i++) {
    if (i < n && !keep[i]) continue
    stack.push(prev, i)
    prev = i
  }
  while (stack.length > 0) {
    const j = stack.pop(), i = stack.pop()
    const ax = pts[i * 2], az = pts[i * 2 + 1]
    const bx = pts[(j % n) * 2], bz = pts[(j % n) * 2 + 1]
    const dx = bx - ax, dz = bz - az
    const len2 = dx * dx + dz * dz
    let worst = -1, worstD = tolerance * tolerance
    for (let k = i + 1; k < j; k++) {
      const px = pts[k * 2] - ax, pz = pts[k * 2 + 1] - az
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + pz * dz) / len2))
      const d = (px - dx * t) ** 2 + (pz - dz * t) ** 2
      if (d > worstD) {
        worstD = d
        worst = k
      }
    }
    if (worst < 0) continue
    keep[worst] = 1
    stack.push(i, worst, worst, j)
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1])
  return out
}

/** Split every edge longer than `spacing` evenly. */
export function spaced(pts, spacing) {
  const out = []
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n
    const ax = pts[i], az = pts[i + 1], bx = pts[j], bz = pts[j + 1]
    const parts = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / spacing))
    for (let k = 0; k < parts; k++) out.push(ax + ((bx - ax) * k) / parts, az + ((bz - az) * k) / parts)
  }
  return out
}

/** The AABB of a ring, or of a list of them. */
export function ringBox(rings) {
  const list = typeof rings[0] === 'number' ? [rings] : rings
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const pts of list) {
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i]
      if (pts[i] > maxX) maxX = pts[i]
      if (pts[i + 1] < minZ) minZ = pts[i + 1]
      if (pts[i + 1] > maxZ) maxZ = pts[i + 1]
    }
  }
  return { minX, minZ, maxX, maxZ }
}
