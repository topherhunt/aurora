/**
 * Paint a Tripo mount's baked tack out of its colour map, so the body drawn
 * without its tack islands shows feathers where the saddle sat.
 *
 * Tripo bakes the blanket, straps and their shadows into the body texels under
 * them. A body texel is repainted when it lies within NEAR of the tack in 3D, or
 * within REACH and looks unlike the feathers around it. Each connected patch is
 * cloned from the body a step along z, the step chosen per patch so it lands on
 * untouched feathers, then shifted to the clean colour at the texel's own height.
 */

import { execFileSync } from 'node:child_process'

const magick = (args, input) => execFileSync('magick', args, { input, maxBuffer: 1 << 28 })

const NEAR = 0.015
const REACH = 0.04
/** Luminance spread over a 9x9 window below which a texel is flat cloth, not streaky feathers. */
const FLAT_STD = 4
/** Height bands for the colour a filled texel should average to. */
const BAND = 0.01

const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
function faceNormal([a, b, c]) {
  const u = sub(b, a), v = sub(c, a)
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const l = Math.hypot(...n) || 1
  return n.map((x) => x / l)
}

/** Barycentric weights of the point on triangle abc closest to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTri(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0]
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0]
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0] }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1]
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [0, 1 - w, w] }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  return [1 - v - w, v, w]
}

/** Items bucketed by cubic cell, keyed numerically: string keys cost 10x. */
function cellGrid(cell) {
  const map = new Map()
  const key = (a, b, c) => ((a + 500) * 1000 + (b + 500)) * 1000 + (c + 500)
  const at = (p) => p.map((v) => Math.floor(v / cell))
  return {
    add(p, item) { this.addBox(p, p, item) },
    addBox(lo, hi, item) {
      const [a0, b0, c0] = at(lo), [a1, b1, c1] = at(hi)
      for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) for (let c = c0; c <= c1; c++) {
        const k = key(a, b, c)
        if (!map.has(k)) map.set(k, [])
        map.get(k).push(item)
      }
    },
    near(p, r, visit) {
      const [cx, cy, cz] = at(p)
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        for (const item of map.get(key(cx + dx, cy + dy, cz + dz)) ?? []) visit(item)
      }
    },
  }
}

/**
 * @param V      vertex positions, y up, z along the body
 * @param I      triangle indices
 * @param UV     flat TEXCOORD_0
 * @param body   first-index of each body triangle
 * @param tack   islands to paint out, each a list of first-indices
 * @param headZ  no clone source forward of this z: the face is not feathers
 * @param jpeg   the colour map
 * @returns      the painted colour map, JPEG, and how many texels changed
 */
export function paintOutTack({ V, I, UV, body, tack, headZ, jpeg }) {
  const [W, H] = magick(['jpeg:-', '-format', '%w %h', 'info:'], jpeg).toString().split(' ').map(Number)
  const src = magick(['jpeg:-', '-depth', '8', 'rgb:-'], jpeg)
  const out = Buffer.from(src)
  const tri = (t) => [V[I[t]], V[I[t + 1]], V[I[t + 2]]]

  // The tack as points every 3mm, each carrying the clone step that clears its island along z.
  const tackPts = cellGrid(REACH)
  for (const island of tack) {
    const zs = island.flatMap((t) => tri(t).map((p) => p[2]))
    const step = Math.max(...zs) - Math.min(...zs) + REACH
    for (const t of island) {
      const [a, b, c] = tri(t)
      const n = Math.max(1, Math.ceil(Math.max(Math.hypot(...sub(a, b)), Math.hypot(...sub(b, c)), Math.hypot(...sub(c, a))) / 0.003))
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, w = j / n
        const p = [0, 1, 2].map((k) => a[k] * (1 - u - w) + b[k] * u + c[k] * w)
        tackPts.add(p, [...p, step])
      }
    }
  }

  // Every body texel's surface point, facing, distance to the tack and that tack's step.
  const dist = new Float32Array(W * H).fill(Infinity)
  const pos = new Float32Array(W * H * 3), nrm = new Float32Array(W * H * 3), stepOf = new Float32Array(W * H)
  for (const t of body) {
    const ids = [I[t], I[t + 1], I[t + 2]], X = tri(t), fn = faceNormal(X)
    const P = ids.map((v) => [UV[v * 2] * W - 0.5, UV[v * 2 + 1] * H - 0.5])
    const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1])
    if (Math.abs(area) < 1e-9) continue
    // A texel and a half past each edge, so the texels a chart border samples are painted too.
    const slack = -1.5 / Math.sqrt(Math.abs(area))
    const x0 = Math.max(0, Math.floor(Math.min(...P.map((p) => p[0])) - 1)), x1 = Math.min(W - 1, Math.ceil(Math.max(...P.map((p) => p[0])) + 1))
    const y0 = Math.max(0, Math.floor(Math.min(...P.map((p) => p[1])) - 1)), y1 = Math.min(H - 1, Math.ceil(Math.max(...P.map((p) => p[1])) + 1))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const w0 = ((P[1][0] - x) * (P[2][1] - y) - (P[2][0] - x) * (P[1][1] - y)) / area
      const w1 = ((P[2][0] - x) * (P[0][1] - y) - (P[0][0] - x) * (P[2][1] - y)) / area
      const w2 = 1 - w0 - w1
      if (w0 < slack || w1 < slack || w2 < slack) continue
      const p = [0, 1, 2].map((k) => X[0][k] * w0 + X[1][k] * w1 + X[2][k] * w2)
      let best = Infinity, step = 0
      tackPts.near(p, 1, (q) => { const d = dot(sub(p, q), sub(p, q)); if (d < best) { best = d; step = q[3] } })
      const i = y * W + x
      if (Math.sqrt(best) >= dist[i]) continue
      dist[i] = Math.sqrt(best); stepOf[i] = step
      pos.set(p, i * 3); nrm.set(fn, i * 3)
    }
  }
  const onBody = (i) => dist[i] < Infinity

  // Feathers are blue-grey to white and streaky; blanket, straps and their shadows are red, brown, near-black or flat.
  const S1 = new Float64Array((W + 1) * (H + 1)), S2 = new Float64Array((W + 1) * (H + 1))
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, a = (y + 1) * (W + 1) + x + 1
    const v = 0.3 * src[i * 3] + 0.59 * src[i * 3 + 1] + 0.11 * src[i * 3 + 2]
    S1[a] = v + S1[a - 1] + S1[a - W - 1] - S1[a - W - 2]
    S2[a] = v * v + S2[a - 1] + S2[a - W - 1] - S2[a - W - 2]
  }
  const box = (S, x0, y0, x1, y1) => S[(y1 + 1) * (W + 1) + x1 + 1] - S[y0 * (W + 1) + x1 + 1] - S[(y1 + 1) * (W + 1) + x0] + S[y0 * (W + 1) + x0]
  const flat = (i) => {
    const x = i % W, y = (i / W) | 0
    const x0 = Math.max(0, x - 4), x1 = Math.min(W - 1, x + 4), y0 = Math.max(0, y - 4), y1 = Math.min(H - 1, y + 4)
    const n = (x1 - x0 + 1) * (y1 - y0 + 1), mean = box(S1, x0, y0, x1, y1) / n
    return box(S2, x0, y0, x1, y1) / n - mean * mean < FLAT_STD * FLAT_STD
  }
  const offColour = (i) => src[i * 3] > src[i * 3 + 2] + 4 || src[i * 3] + src[i * 3 + 1] + src[i * 3 + 2] < 150

  // 1 = to paint, 2 = painted.
  const mask = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (dist[i] < NEAR || (dist[i] < REACH && (offColour(i) || flat(i)))) mask[i] = 1

  const band = new Map()
  for (let i = 0; i < W * H; i++) {
    if (!(dist[i] >= REACH && dist[i] < REACH + 0.05) || offColour(i) || flat(i)) continue
    const k = Math.floor(pos[i * 3 + 1] / BAND), e = band.get(k) ?? [0, 0, 0, 0]
    for (let c = 0; c < 3; c++) e[c] += src[i * 3 + c]
    e[3]++
    band.set(k, e)
  }
  const bandAt = (y) => {
    const k = Math.floor(y / BAND)
    for (let r = 0; r < 30; r++) for (const kk of [k - r, k + r]) { const e = band.get(kk); if (e?.[3] > 50) return e.slice(0, 3).map((v) => v / e[3]) }
    throw new Error(`paint-tack: no clean feathers within 30cm of height ${y.toFixed(3)} to match`)
  }

  const TRI_CELL = 0.03
  const bodyTris = cellGrid(TRI_CELL)
  for (const t of body) {
    const X = tri(t)
    const lo = [0, 1, 2].map((k) => Math.min(...X.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...X.map((p) => p[k])))
    bodyTris.addBox(lo, hi, t)
  }
  // The texel on the body nearest p that faces roughly `facing`: the facing test keeps a flank from cloning the wing lying over it.
  const texelNear = (p, facing) => {
    let best = Infinity, uv = null
    const seen = new Set()
    for (let r = 1; r <= 3 && !uv; r++) {
      bodyTris.near(p, r, (t) => {
        if (seen.has(t)) return
        seen.add(t)
        const X = tri(t)
        if (dot(faceNormal(X), facing) < 0.3) return
        const w = closestOnTri(p, ...X)
        const q = [0, 1, 2].map((k) => X[0][k] * w[0] + X[1][k] * w[1] + X[2][k] * w[2])
        const d = dot(sub(p, q), sub(p, q))
        if (d < best) { best = d; uv = [0, 1].map((k) => w.reduce((s, wj, j) => s + UV[I[t + j] * 2 + k] * wj, 0)) }
      })
    }
    if (!uv || best > 0.08 ** 2) return -1
    const x = Math.min(W - 1, Math.max(0, Math.round(uv[0] * W - 0.5))), y = Math.min(H - 1, Math.max(0, Math.round(uv[1] * H - 0.5)))
    return y * W + x
  }
  // Only a texel on the body counts: the UV gutters between charts hold junk colour.
  const sourceFor = (i, [dy, dz]) => {
    const z = pos[i * 3 + 2] + dz
    if (z < headZ) return -1
    const j = texelNear([pos[i * 3], pos[i * 3 + 1] + dy, z], nrm.subarray(i * 3, i * 3 + 3))
    return j < 0 || mask[j] || !(dist[j] >= NEAR && onBody(j)) ? -1 : j
  }

  const seen = new Uint8Array(W * H)
  const neighbours = (i) => { const x = i % W; return [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W].filter((j) => j >= 0 && j < W * H) }
  let painted = 0, stranded = 0
  for (let i0 = 0; i0 < W * H; i0++) {
    if (mask[i0] !== 1 || seen[i0]) continue
    const members = [i0]
    seen[i0] = 1
    for (let q = 0; q < members.length; q++) for (const j of neighbours(members[q])) if (mask[j] === 1 && !seen[j]) { seen[j] = 1; members.push(j) }
    // One step for the whole patch, so neighbouring texels come from neighbouring sources.
    const step = stepOf[members[members.length >> 1]]
    const tries = [step, 0.2, 0.3, 0.12].flatMap((s) => [[0, s], [0, -s]]).concat([[-0.08, 0], [-0.12, 0], [-0.06, 0.1], [-0.06, -0.1]])
    const probe = members.filter((_, k) => k % Math.max(1, (members.length / 60) | 0) === 0)
    const order = tries
      .map((d, n) => [d, probe.filter((i) => sourceFor(i, d) >= 0).length - n * 0.01])
      .sort((a, b) => b[1] - a[1])
      .map(([d]) => d)
    for (const i of members) {
      let j = -1
      for (const d of order) if ((j = sourceFor(i, d)) >= 0) break
      if (j < 0) { stranded++; continue }
      const want = bandAt(pos[i * 3 + 1]), have = bandAt(pos[j * 3 + 1])
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(src[j * 3 + c] + want[c] - have[c])))
      mask[i] = 2
      painted++
    }
  }
  // What no step reached takes the mean of its settled neighbours, ring by ring inward.
  for (let left = stranded; left > 0;) {
    const settle = []
    for (let i = 0; i < W * H; i++) {
      if (mask[i] !== 1) continue
      const from = neighbours(i).filter((j) => mask[j] !== 1 && onBody(j))
      if (from.length) settle.push([i, [0, 1, 2].map((c) => from.reduce((s, j) => s + out[j * 3 + c], 0) / from.length)])
    }
    if (!settle.length) throw new Error(`paint-tack: ${left} texels have no painted or clean neighbour to grow from`)
    for (const [i, rgb] of settle) { out.set(rgb.map(Math.round), i * 3); mask[i] = 2 }
    left -= settle.length
  }

  return { jpeg: magick(['-size', `${W}x${H}`, '-depth', '8', 'rgb:-', '-quality', '92', 'jpeg:-'], out), texels: painted + stranded }
}
