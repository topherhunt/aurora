// ---------------------------------------------------------------------------
// Marching squares over the ley-line potential: contours -> polylines.
//
// ===========================================================================
// WHAT THIS BUYS, AND WHY IT IS THE WHOLE POINT
// ===========================================================================
//
// design/13-aurora-and-sky.md says of the shipped polygon aurora:
//
//   "The ceiling is TOPOLOGICAL, not a matter of tuning. A curtain can fold and
//    it can meander, but it cannot BRANCH, it cannot merge with the curtain
//    beside it, and it cannot be anywhere the mesh is not."
//
// That is true of any aurora built by deforming a fixed mesh, because a mesh
// has its connectivity decided at build time and deformation cannot change it.
// It is NOT true of a contour, because a contour's connectivity is decided by
// the field: the level set of a smooth scalar field pinches into two branches
// at a saddle, merges back at the next one, crowds where the gradient steepens
// and disappears entirely where the field never reaches that level.
//
// So the branching comes from finding the curves rather than from authoring
// them. There is no branch parameter and there is nothing in this file that
// decides how many channels there are -- that falls out of how much ground the
// potential covers between its minimum and its maximum.
//
// ===========================================================================
// WHY MARCHING SQUARES AND NOT A WALKER
// ===========================================================================
//
// The obvious alternative is to seed a point on a contour and integrate along
// the perpendicular of the gradient. That gives smooth curves cheaply and it
// gets the topology WRONG in exactly the interesting places: a walker passing
// through a saddle has to pick a branch, so it silently discards the other one,
// and the pinch -- the thing worth having -- is the case it cannot represent.
//
// Marching squares has no such choice to make. It visits every cell, emits the
// crossings it finds, and the branches appear because they are there. The cost
// is a staircase at grid resolution, which one smoothing pass removes.
//
// ===========================================================================
// THE SADDLE CASES ARE NOT A DETAIL
// ===========================================================================
//
// Cells 5 and 10 (opposite corners on the same side of the level) are ambiguous
// -- two curves pass through the cell and there are two ways to connect them.
// Resolving by the cell-centre average is the standard fix and it is the one
// place in this file where getting it wrong is invisible in a still frame and
// obvious in motion: a mis-resolved saddle swaps which branch joins which, so
// two channels that should have merged instead trade halves, and the join
// flickers between the two readings as the field morphs past the ambiguity.
// ---------------------------------------------------------------------------

import { phi } from './field.js'

// Edge keys. Every crossing lies on exactly one grid edge, so the edge is the
// crossing's identity -- which is what lets segments from neighbouring cells
// find each other without any floating-point position comparison. Position
// matching would be the natural thing to reach for and it is a trap: the two
// cells compute the same crossing with the same inputs but not necessarily the
// same rounding, so an epsilon has to be picked, and the right epsilon depends
// on the field's gradient, which varies across the sky.
const hKey = (i, j, N) => 2 * (j * N + i)       // between (i,j) and (i+1,j)
const vKey = (i, j, N) => 2 * (j * N + i) + 1   // between (i,j) and (i,j+1)

// Which pair(s) of cell edges the contour connects, per marching-squares case.
// Edge slots: 0 = bottom, 1 = right, 2 = top, 3 = left.
// null entries are the two saddles, resolved at run time against the centre.
const CASES = [
  null,        // 0  -- no crossing
  [3, 0],      // 1
  [0, 1],      // 2
  [3, 1],      // 3
  [1, 2],      // 4
  null,        // 5  -- saddle
  [0, 2],      // 6
  [3, 2],      // 7
  [2, 3],      // 8
  [0, 2],      // 9
  null,        // 10 -- saddle
  [1, 2],      // 11
  [1, 3],      // 12
  [0, 1],      // 13
  [0, 3],      // 14
  null,        // 15 -- no crossing
]

/**
 * Trace every integer contour of the ley-line potential across a plan region.
 *
 * All lengths are in kilometres, eye at the origin, -z north -- the same plan
 * convention the lab's frame uses, so a `fieldScale` tuned there transfers.
 *
 * Returns { lines, stats } where each line is
 *   { level, closed, pts: Float32Array[x,z,...], arc: Float32Array,
 *     grad: Float32Array, lengthKm }
 * `grad` is |d(phi)/d(km)|, which is what sets a channel's width on the ground:
 * a channel occupies a fixed interval in phi, so where the gradient steepens
 * the same interval covers less ground and the channel narrows. That is the
 * "crowd and thin" of the field, recovered exactly rather than imitated.
 */
export function traceContours(P) {
  const N = Math.max(32, Math.round(P.gridN))
  const half = P.spanKm

  // Centred on the EYE rather than on the belt, which looks wasteful and is not.
  // The belt term has a floor of 1 - beltAmt (see the note in frame.js), so at
  // any belt strength short of full the sky behind you is dimmed rather than
  // emptied, and a grid centred on the belt would have no contours to give it.
  // Centring here also keeps `beltOffset` a live uniform instead of a re-trace,
  // which is what makes the belt draggable.
  const x0 = -half, x1 = half
  const z0 = -half, z1 = half
  const dx = (x1 - x0) / (N - 1)
  const dz = (z1 - z0) / (N - 1)

  // ---- sample the potential ------------------------------------------------
  const F = new Float64Array(N * N)
  const s = P.fieldScale
  for (let j = 0; j < N; j++) {
    const zw = z0 + j * dz
    for (let i = 0; i < N; i++) {
      F[j * N + i] = phi((x0 + i * dx) * s, zw * s, P.traceTime, P)
    }
  }

  // ---- |grad phi| per km, by central differences ---------------------------
  // Read off the same grid rather than by re-evaluating the field four more
  // times per node: the contour was found from THIS grid, so the width has to
  // come from the same grid or a narrow channel and its own centreline can
  // disagree about where the field is steep.
  const G = new Float32Array(N * N)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const im = Math.max(0, i - 1), ip = Math.min(N - 1, i + 1)
      const jm = Math.max(0, j - 1), jp = Math.min(N - 1, j + 1)
      const gx = (F[j * N + ip] - F[j * N + im]) / ((ip - im) * dx)
      const gz = (F[jp * N + i] - F[jm * N + i]) / ((jp - jm) * dz)
      G[j * N + i] = Math.hypot(gx, gz)
    }
  }

  let lo = Infinity, hi = -Infinity
  for (let k = 0; k < F.length; k++) {
    if (F[k] < lo) lo = F[k]
    if (F[k] > hi) hi = F[k]
  }

  const lines = []
  let cellsVisited = 0

  const px = new Map()   // edge key -> crossing x (km)
  const pz = new Map()   // edge key -> crossing z (km)
  const adjA = new Map() // edge key -> first neighbour key
  const adjB = new Map() // edge key -> second neighbour key

  for (let level = Math.ceil(lo); level <= Math.floor(hi); level++) {
    px.clear(); pz.clear(); adjA.clear(); adjB.clear()

    const link = (a, b) => {
      if (!adjA.has(a)) adjA.set(a, b); else if (!adjB.has(a)) adjB.set(a, b)
      if (!adjA.has(b)) adjA.set(b, a); else if (!adjB.has(b)) adjB.set(b, a)
    }

    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const c00 = F[j * N + i]
        const c10 = F[j * N + i + 1]
        const c11 = F[(j + 1) * N + i + 1]
        const c01 = F[(j + 1) * N + i]

        let code = 0
        if (c00 > level) code |= 1
        if (c10 > level) code |= 2
        if (c11 > level) code |= 4
        if (c01 > level) code |= 8
        if (code === 0 || code === 15) continue
        cellsVisited++

        // Crossing positions. Each is placed on its own edge, so the two cells
        // that share an edge place it identically by construction.
        const bx = x0 + i * dx, bz = z0 + j * dz
        const keys = [
          hKey(i, j, N),
          vKey(i + 1, j, N),
          hKey(i, j + 1, N),
          vKey(i, j, N),
        ]
        const place = (slot) => {
          const k = keys[slot]
          if (px.has(k)) return k
          let ex, ez
          if (slot === 0) { ex = bx + dx * frac(c00, c10, level); ez = bz }
          else if (slot === 1) { ex = bx + dx; ez = bz + dz * frac(c10, c11, level) }
          else if (slot === 2) { ex = bx + dx * frac(c01, c11, level); ez = bz + dz }
          else { ex = bx; ez = bz + dz * frac(c00, c01, level) }
          px.set(k, ex); pz.set(k, ez)
          return k
        }

        const pairs = CASES[code]
        if (pairs) {
          link(place(pairs[0]), place(pairs[1]))
          continue
        }

        // Saddle. The centre average decides which pair of corners the contour
        // wraps around; see the header note on why this matters in motion.
        const centreAbove = (c00 + c10 + c11 + c01) * 0.25 > level
        const wrapPairs = (code === 5) === centreAbove
          ? [[0, 1], [2, 3]]
          : [[3, 0], [1, 2]]
        for (const pr of wrapPairs) link(place(pr[0]), place(pr[1]))
      }
    }

    // ---- walk the crossings into chains ------------------------------------
    // Every crossing has degree 1 (it sat on the grid boundary and the contour
    // ran off the edge of the world) or degree 2. Open chains are walked first
    // so a loop is never mistakenly entered from its middle; whatever is left
    // over afterwards is a closed loop.
    const seen = new Set()
    const emit = (chain, closed) => {
      const line = finishLine(chain, px, pz, level, closed, P, {
        F, G, N, x0, z0, dx, dz,
      })
      if (line) lines.push(line)
    }

    for (const k of px.keys()) {
      if (seen.has(k) || adjB.has(k)) continue
      emit(walk(k, seen, adjA, adjB), false)
    }
    for (const k of px.keys()) {
      if (seen.has(k)) continue
      const chain = walk(k, seen, adjA, adjB)
      // Close the ring back onto its own start so the card ribbon has no seam.
      if (chain.length > 2) chain.push(chain[0])
      emit(chain, true)
    }
  }

  let totalKm = 0
  for (const l of lines) totalKm += l.lengthKm

  return {
    lines,
    stats: {
      gridN: N,
      samples: N * N,
      levels: Math.floor(hi) - Math.ceil(lo) + 1,
      phiRange: [lo, hi],
      cellsVisited,
      components: lines.length,
      totalKm,
      cellKm: dx,
    },
  }
}

const frac = (a, b, level) => {
  const d = b - a
  // The cell was classified by strict comparison against the same values, so a
  // zero denominator here means a corner sits exactly on the level and the two
  // sides disagreed about which way it fell. Midpoint is the only answer that
  // both cells sharing this edge will reach.
  return d === 0 ? 0.5 : (level - a) / d
}

function walk(start, seen, adjA, adjB) {
  const chain = [start]
  seen.add(start)
  let prev = -1, cur = start
  for (;;) {
    const a = adjA.get(cur)
    const b = adjB.get(cur)
    const next = a !== undefined && a !== prev ? a : (b !== prev ? b : undefined)
    if (next === undefined || seen.has(next)) break
    seen.add(next)
    chain.push(next)
    prev = cur
    cur = next
  }
  return chain
}

// ---------------------------------------------------------------------------
// Raw crossing chain -> a smoothed, uniformly resampled polyline with the field
// gradient carried along it.
// ---------------------------------------------------------------------------
function finishLine(chain, px, pz, level, closed, P, grid) {
  if (chain.length < 3) return null

  let raw = new Float64Array(chain.length * 2)
  for (let n = 0; n < chain.length; n++) {
    raw[n * 2] = px.get(chain[n])
    raw[n * 2 + 1] = pz.get(chain[n])
  }

  // Marching squares puts every vertex on a grid edge, so a contour that runs
  // nearly diagonally staircases at cell resolution. A couple of [1,2,1]
  // passes take that out without moving the curve off the level set in any way
  // the eye can find -- the crossings are already sub-cell accurate, the
  // staircase is in the ORDER they are visited, not in their positions.
  for (let pass = 0; pass < P.smoothPasses; pass++) raw = smooth(raw, closed)

  let total = 0
  const nRaw = raw.length / 2
  const cum = new Float64Array(nRaw)
  for (let n = 1; n < nRaw; n++) {
    total += Math.hypot(raw[n * 2] - raw[n * 2 - 2], raw[n * 2 + 1] - raw[n * 2 - 1])
    cum[n] = total
  }
  if (total < P.minLenKm) return null

  // Uniform arc-length resampling. Cards must be evenly spaced along the
  // channel or the additive stack thickens wherever marching squares happened
  // to put its vertices close together, and grid resolution becomes visible as
  // bright patches that do not move when the field does.
  const count = Math.max(2, Math.round(total / P.cardSpacingKm) + 1)
  const step = total / (count - 1)
  const pts = new Float32Array(count * 2)
  const arc = new Float32Array(count)
  const grad = new Float32Array(count)

  let seg = 1
  for (let n = 0; n < count; n++) {
    const target = n * step
    while (seg < nRaw - 1 && cum[seg] < target) seg++
    const a = seg - 1, b = seg
    const span = cum[b] - cum[a]
    const f = span > 0 ? (target - cum[a]) / span : 0
    const x = raw[a * 2] + (raw[b * 2] - raw[a * 2]) * f
    const z = raw[a * 2 + 1] + (raw[b * 2 + 1] - raw[a * 2 + 1]) * f
    pts[n * 2] = x
    pts[n * 2 + 1] = z
    arc[n] = target
    grad[n] = sampleGrid(grid.G, grid, x, z)
  }

  return { level, closed, pts, arc, grad, lengthKm: total }
}

function smooth(src, closed) {
  const n = src.length / 2
  const out = new Float64Array(src.length)
  for (let k = 0; k < n; k++) {
    let a = k - 1, b = k + 1
    if (a < 0) a = closed ? n - 2 : 0
    if (b > n - 1) b = closed ? 1 : n - 1
    out[k * 2] = 0.25 * src[a * 2] + 0.5 * src[k * 2] + 0.25 * src[b * 2]
    out[k * 2 + 1] = 0.25 * src[a * 2 + 1] + 0.5 * src[k * 2 + 1] + 0.25 * src[b * 2 + 1]
  }
  return out
}

function sampleGrid(A, g, x, z) {
  const fx = Math.min(g.N - 1.001, Math.max(0, (x - g.x0) / g.dx))
  const fz = Math.min(g.N - 1.001, Math.max(0, (z - g.z0) / g.dz))
  const i = Math.floor(fx), j = Math.floor(fz)
  const tx = fx - i, tz = fz - j
  const a = A[j * g.N + i], b = A[j * g.N + i + 1]
  const c = A[(j + 1) * g.N + i], d = A[(j + 1) * g.N + i + 1]
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz
}
