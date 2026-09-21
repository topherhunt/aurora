// ---------------------------------------------------------------------------
// Vertex generation for the v2 surface layers: the path ribbon (a lake's outline is shoreline.js's).
//
// THREE-FREE ON PURPOSE, even though it lives under src/v2/render/ where §18 says three.js starts. Same exemption chunk-mesh-v2.js gets and for the same reason: only the renderer calls it, but the thing that can actually be WRONG here is arithmetic -- a ribbon that folds through itself on a hairpin -- and arithmetic is checkable in node. scripts/check-v2-surfaces.mjs holds it in node, so the gate costs no GL context and no stub renderer.
//
// It emits WORLD-space positions. The meshes that wrap them sit at identity under a group at the origin, which is not an accident: src/water.js's fragment shader recovers world position as `modelMatrix * position` and feeds it straight into the wave field, so a river ribbon carrying a local origin would sample the waves from the wrong place and drift against the lake beside it.
// ---------------------------------------------------------------------------

// Over how far, past the run a river spends inside the body it starts or ends in, its own flow frame fades in from the shared world frame: this many of its local half-widths, and never less than the metres. See flowFrame.
export const FLOW_FADE_HALF_WIDTHS = 4
export const FLOW_FADE_MIN = 8

// The river's distance ladder, in metres from the eye in plan. Inside LOD_FINE a chunk draws every sample; beyond it, its coarse samples, spaced LOD_SPACING apart on a straight and wherever the heading has turned LOD_TURN since the last one. A chunk is about LOD_CHUNK metres of arc, cut on coarse samples so neighbours share a vertex whatever their states. See ribbonLod. Clearing the terrain's own low LODs is not a rung of this ladder: it is a lift the vertex shader reads off the terrain cell drawn under each sample (river-raise.js).
export const LOD_FINE = 100
export const LOD_SPACING = 10
export const LOD_TURN = (20 * Math.PI) / 180
export const LOD_CHUNK = 100
// The eye moves this far before the ladder is re-read. The ladder therefore lags by at most this, which is the whole of its hysteresis.
export const LOD_STEP = 10

// How much of the way to a neighbour's cross-line the inside edge may reach before the miter limit bites. At 1.0 the inner vertices of a uniform bend all land on its centre of curvature and every quad through it has zero area; short of it by this much they sit on a tiny arc around that centre instead. Only the fallback case (a hairpin whose arms overlap) is drawn with this; a bend with a trimmed inner bank collapses onto it exactly.
const MITER_SAFETY = 0.98

// The narrowest a clamped ribbon may get, in metres. A hairpin degenerates toward a point; this stops it degenerating to an exactly-zero-area triangle, which is a NaN normal and a hole rather than a pinch.
const MIN_HALF = 0.02

// Signed area x2 of a triangle projected to XZ. Sign convention: this is the NEGATIVE of the y component of the 3D cross product, so an upward-facing (+Y normal) triangle comes out NEGATIVE here. Every triangle both generators emit must be negative; the gate checks exactly that.
const cross2 = (ax, az, bx, bz) => ax * bz - az * bx

/**
 * A path's surface ribbon: two vertices per sample, offset along the 2D normal of the tangent, triangulated as a strip.
 *
 * `samples` is a flattened spline -- a Float32Array of packed (x, y, z, halfWidth) quads, which is what Spline.flatten returns. The offset is XZ-ONLY: a water surface is horizontal across its width whatever the valley wall is doing.
 *
 * Options:
 *   widen / widenFrac  extra half-width, min(widen, halfWidth * widenFrac). A river passes paths.js RIVER_WIDEN and RIVER_WIDEN_FRAC.
 *   minHalf            the miter clamp's floor.
 *
 * Besides the buffers it returns per-sample `arc` (3D metres from sample 0), `halfRight` / `halfLeft` (each edge's offset after widening and the clamps below; right is +normal, vertex a) and `tangents` (unit XZ, in sample order), which is what the river's flow frame is built from.
 *
 * THE THING THAT WILL BITE, and it is the reason this function is longer than a strip has any right to be. On a turn tighter than the half-width the inner offset edge crosses itself: the ribbon folds, the folded quad's triangles come out with the opposite winding, and what you get is a black wedge that is lit from underneath and z-fights with the half of the ribbon it is folded over. It is not a rare case -- one control point dragged past its neighbour produces it -- so the offset is capped, exactly, by the miter limit below, and the per-triangle orientation test after it is the same predicate the gate asserts, so the generator and the check cannot drift apart.
 *
 * The cap acts on the INSIDE edge of a turn only. The outside edge cannot fold, and the channel the carve cuts is the union of every segment's own footprint, so it runs at full width round the outside of a bend; a cap that narrowed both edges together left a wedge of bare bed between the sheet and the outer bank on every bend it fired on -- two metres of it on the shipped rivers, whose tightest bends have a radius about their half-width. And the cap is the fallback, not the answer: on its own it leaves the inside of such a bend both bare (between the centre of curvature and the inner bank) and double-covered (the two arms' full-width quads cross each other there), so the inside vertices of a capped run are collapsed onto the corner of the trimmed inner bank instead -- see the collapse below -- and the cap stands only where no such corner exists.
 */
export function ribbonVertices(samples, opts = {}) {
  const { widen = 0, widenFrac = 0, minHalf = MIN_HALF } = opts
  if (!samples || typeof samples.length !== 'number') throw new Error('ribbonVertices: samples must be an array-like of packed (x, y, z, halfWidth) quads')
  if (samples.length % 4 !== 0) throw new Error(`ribbonVertices: sample buffer length ${samples.length} is not a multiple of 4`)
  const n = samples.length / 4
  if (n < 2) throw new Error(`ribbonVertices: a ribbon needs at least 2 samples, got ${n}`)

  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const pz = new Float64Array(n)
  // Per EDGE, right (vertex a, +normal) and left, because the clamps below narrow one side of a bend and not the other.
  const wr = new Float64Array(n)
  const wl = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    px[i] = samples[o]
    py[i] = samples[o + 1]
    pz[i] = samples[o + 2]
    const hw = samples[o + 3]
    if (!Number.isFinite(px[i]) || !Number.isFinite(py[i]) || !Number.isFinite(pz[i])) throw new Error(`ribbonVertices: sample ${i} is not finite`)
    if (!(hw > 0)) throw new Error(`ribbonVertices: sample ${i} has halfWidth ${hw}, expected > 0`)
    wr[i] = wl[i] = hw + (widen > 0 ? Math.min(widen, hw * widenFrac) : 0)
  }

  // Segment directions, XZ only -- everything the offset and the fold test care about is a plan-view question.
  const dx = new Float64Array(n - 1)
  const dz = new Float64Array(n - 1)
  for (let i = 0; i < n - 1; i++) {
    const ex = px[i + 1] - px[i]
    const ez = pz[i + 1] - pz[i]
    const l = Math.hypot(ex, ez)
    if (!(l > 1e-6)) throw new Error(`ribbonVertices: samples ${i} and ${i + 1} are coincident in XZ (${l.toExponential(2)} m apart); a flattened spline must not repeat a point`)
    dx[i] = ex / l
    dz[i] = ez / l
  }

  // Per-sample normal: the angle bisector, NOT scaled by the miter factor 1/cos(half-angle). The miter scale is what blows up to infinity on a sharp turn; a plain bisector holds the width honest through the corner and lets the clamp below decide how much of it survives.
  const nx = new Float64Array(n)
  const nz = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let tx
    let tz
    if (i === 0) {
      tx = dx[0]
      tz = dz[0]
    } else if (i === n - 1) {
      tx = dx[n - 2]
      tz = dz[n - 2]
    } else {
      tx = dx[i - 1] + dx[i]
      tz = dz[i - 1] + dz[i]
      const l = Math.hypot(tx, tz)
      if (!(l > 1e-6)) throw new Error(`ribbonVertices: sample ${i} reverses the path exactly (180 degree cusp); centripetal Catmull-Rom is supposed to make this impossible, so the control points are the bug, not this ribbon`)
      tx /= l
      tz /= l
    }
    nx[i] = -tz
    nz[i] = tx
  }

  // Arc length in 3D, not XZ. `u` is metres along the ribbon as walked, so a river that drops 40 m over 60 m of plan distance gets the 72 m of texture it actually has under it.
  const arc = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1], pz[i] - pz[i - 1])
  }

  // The miter limit. A strip folds when an offset vertex crosses a neighbouring sample's CROSS-LINE (the line through that sample along its own normal): every triangle the strip emits has one edge on a cross-line and its third vertex is an offset vertex of the next or previous sample, so "no vertex crosses its neighbours' cross-lines" is exactly "no triangle inverts", and it is a linear cap on the offset. Per sample and per neighbour j: the offset vertex p + w n must stay on p's side of j's cross-line, `w (n . t_j) < (p_j - p) . t_j` for the next sample and the mirror for the previous, which caps one side -- the side the bend turns toward -- and leaves the other free. Exact, so there is no repair loop after it, and per side, so the outside of a bend keeps its full width. The vertices on the inside of a bend tighter than the ribbon is wide converge on its centre of curvature, which leaves the channel between that centre and the inner bank bare; the collapse below is what covers it, and this cap is what it falls back to.
  const full = Float64Array.from(wr)
  const capR = new Uint8Array(n)
  const capL = new Uint8Array(n)
  let clamped = 0
  for (let i = 0; i < n; i++) {
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= n) continue
      const sign = j > i ? 1 : -1
      const d = sign * ((px[j] - px[i]) * nz[j] - (pz[j] - pz[i]) * nx[j])
      const e = sign * (nx[i] * nz[j] - nz[i] * nx[j])
      if (Math.abs(e) < 1e-9) continue
      if (!(d > 0)) throw new Error(`ribbonVertices: sample ${j} lies behind sample ${i}'s tangent; the polyline reverses`)
      const w = e > 0 ? wr : wl
      const cap = (MITER_SAFETY * d) / Math.abs(e)
      if (w[i] > cap) {
        w[i] = Math.max(cap, minHalf)
        ;(e > 0 ? capR : capL)[i] = 1
        clamped++
      }
    }
  }

  // Offset VECTORS from here on, one per edge per sample, because the collapse below moves a vertex off its own normal.
  const arx = new Float64Array(n)
  const arz = new Float64Array(n)
  const alx = new Float64Array(n)
  const alz = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    arx[i] = wr[i] * nx[i]
    arz[i] = wr[i] * nz[i]
    alx[i] = -wl[i] * nx[i]
    alz[i] = -wl[i] * nz[i]
  }

  // The collapse. The channel the carve cuts is every point within the half-width of the centreline, and on the inside of a bend its bank is not the offset curve -- that curve loops through itself there -- but the offset curve TRIMMED at its self-crossing: the inner bank turns a corner at the point M where the offset lines of the last full-width sample on each side of the bend meet. Every sample whose full-width vertex lies past M has its vertex put AT M, so the strip's quads through the bend fan out from M to the outer edge and cover the channel exactly, the neighbouring quads share their edges with the fan, and the sheet overlaps itself nowhere. The run to collapse starts as a run the cap fired on and grows outward while the bounding sample's own full-width vertex is still past M -- on a corner between two straights the loop reaches a half-width up each straight, where nothing has been capped. A hairpin whose arms run within a width of each other has no M (the two offset lines are parallel or meet behind the arms) and keeps the cap; so does a run the fan would invert on -- the orientation test below is run on the result before it is kept.
  let collapsed = 0
  const tri = (i, ax, az, bx, bz) => {
    const a0x = px[i] + ax[i]
    const a0z = pz[i] + az[i]
    const b0x = px[i] + bx[i]
    const b0z = pz[i] + bz[i]
    const a1x = px[i + 1] + ax[i + 1]
    const a1z = pz[i + 1] + az[i + 1]
    const b1x = px[i + 1] + bx[i + 1]
    const b1z = pz[i + 1] + bz[i + 1]
    // A quad whose two vertices on one edge coincide is a single triangle; the other has exactly zero area and is allowed.
    const t0 = cross2(a1x - a0x, a1z - a0z, b0x - a0x, b0z - a0z)
    const t1 = cross2(a1x - b0x, a1z - b0z, b1x - b0x, b1z - b0z)
    return (t0 < 0 || (t0 === 0 && a0x === a1x && a0z === a1z)) && (t1 < 0 || (t1 === 0 && b0x === b1x && b0z === b1z))
  }
  const quadsOk = (from, to, ax, az, bx, bz) => {
    for (let i = Math.max(0, from); i <= Math.min(n - 2, to); i++) if (!tri(i, ax, az, bx, bz)) return false
    return true
  }
  for (const [sign, cap, ox, oz] of [[1, capR, arx, arz], [-1, capL, alx, alz]]) {
    const done = new Uint8Array(n)
    let i = 0
    while (i < n) {
      if (!cap[i]) { i++; continue }
      let e = i
      while (e + 1 < n && cap[e + 1]) e++
      let k = i - 1
      let l = e + 1
      let mx = 0
      let mz = 0
      let ok = false
      for (;;) {
        if (k < 0 || l >= n || done[k]) break
        // Full-width vertices and tangents of the bounding samples; tangent = normal turned back a quarter turn (see `tangents`).
        const akx = px[k] + sign * full[k] * nx[k]
        const akz = pz[k] + sign * full[k] * nz[k]
        const blx = px[l] + sign * full[l] * nx[l]
        const blz = pz[l] + sign * full[l] * nz[l]
        const tkx = nz[k]
        const tkz = -nx[k]
        const tlx = nz[l]
        const tlz = -nx[l]
        const denom = cross2(tkx, tkz, tlx, tlz)
        if (Math.abs(denom) < 1e-9) break
        const dxk = blx - akx
        const dzk = blz - akz
        const alpha = cross2(dxk, dzk, tlx, tlz) / denom
        const beta = cross2(dxk, dzk, tkx, tkz) / denom
        if (alpha < 0) { k--; continue }
        if (beta > 0) { l++; continue }
        mx = akx + alpha * tkx
        mz = akz + alpha * tkz
        ok = true
        break
      }
      if (ok) {
        const keepX = ox.slice(k, l + 1)
        const keepZ = oz.slice(k, l + 1)
        ox[k] = sign * full[k] * nx[k]
        oz[k] = sign * full[k] * nz[k]
        ox[l] = sign * full[l] * nx[l]
        oz[l] = sign * full[l] * nz[l]
        for (let j = k + 1; j < l; j++) {
          ox[j] = mx - px[j]
          oz[j] = mz - pz[j]
        }
        if (quadsOk(k - 1, l, arx, arz, alx, alz)) {
          for (let j = k; j <= l; j++) done[j] = 1
          collapsed += l - k - 1
        } else {
          ox.set(keepX, k)
          oz.set(keepZ, k)
          ok = false
        }
      }
      i = ok ? l + 1 : e + 1
    }
  }

  // The cap and the collapse's own test are the whole guarantee, so this is an assertion: the only way a triangle still inverts is a cap under the width floor, which is a cusp no miter limit can rescue.
  for (let i = 0; i < n - 1; i++) {
    if (!tri(i, arx, arz, alx, alz)) throw new Error(`ribbonVertices: segment ${i} inverts at the ${minHalf} m width floor; the polyline has a cusp no miter limit can rescue`)
  }
  // Each edge's offset as a distance, which is what the flow frame reads; a collapsed vertex sits past its bank, so it reads past the half-width there.
  for (let i = 0; i < n; i++) {
    wr[i] = Math.hypot(arx[i], arz[i])
    wl[i] = Math.hypot(alx[i], alz[i])
  }

  const positions = new Float32Array(n * 2 * 3)
  const normals = new Float32Array(n * 2 * 3)
  const uvs = new Float32Array(n * 2 * 2)
  const tangents = new Float32Array(n * 2)
  const indices = new Uint32Array((n - 1) * 6)

  for (let i = 0; i < n; i++) {
    // The plan-view direction the offset is perpendicular to, in sample order: the bisector turned back a quarter turn, so vertex a lies on its right (y up, so right of +x is +z).
    tangents[i * 2] = nz[i]
    tangents[i * 2 + 1] = -nx[i]
    // 3D tangent, central difference where there is one, so the surface normal follows the grade rather than the plan.
    const a = i === 0 ? 0 : i - 1
    const b = i === n - 1 ? n - 1 : i + 1
    let tx = px[b] - px[a]
    let ty = py[b] - py[a]
    let tz = pz[b] - pz[a]
    const tl = Math.hypot(tx, ty, tz)
    tx /= tl
    ty /= tl
    tz /= tl
    // The ribbon is a ruled surface between the horizontal offset direction and that tangent, so its normal is their cross product. On flat ground it collapses to (0, 1, 0) exactly.
    let mx = -nz[i] * ty
    let my = nz[i] * tx - nx[i] * tz
    let mz = nx[i] * ty
    const ml = Math.hypot(mx, my, mz)
    mx /= ml
    my /= ml
    mz /= ml

    const o = i * 6
    positions[o] = px[i] + arx[i]
    positions[o + 1] = py[i]
    positions[o + 2] = pz[i] + arz[i]
    positions[o + 3] = px[i] + alx[i]
    positions[o + 4] = py[i]
    positions[o + 5] = pz[i] + alz[i]
    normals[o] = mx
    normals[o + 1] = my
    normals[o + 2] = mz
    normals[o + 3] = mx
    normals[o + 4] = my
    normals[o + 5] = mz
    const q = i * 4
    uvs[q] = arc[i]
    uvs[q + 1] = 0
    uvs[q + 2] = arc[i]
    uvs[q + 3] = 1
  }

  for (let i = 0; i < n - 1; i++) {
    const o = i * 6
    const a0 = i * 2
    const b0 = a0 + 1
    const a1 = a0 + 2
    const b1 = a0 + 3
    indices[o] = a0
    indices[o + 1] = a1
    indices[o + 2] = b0
    indices[o + 3] = b0
    indices[o + 4] = a1
    indices[o + 5] = b1
  }

  return {
    count: n,
    positions,
    normals,
    uvs,
    indices,
    // Handed out as Float32 because nothing downstream needs more and the editor may hold one of these per path.
    arc: Float32Array.from(arc),
    halfRight: Float32Array.from(wr),
    halfLeft: Float32Array.from(wl),
    tangents,
    length: arc[n - 1],
    clamped,
    collapsed,
    triangles: (n - 1) * 2,
    vertices: n * 2,
  }
}

/**
 * A river ribbon's flow frame: the per-vertex vec4 src/water.js reads as `aFlow`, so the waves on a river drift DOWNSTREAM instead of on the compass heading every other sheet of water shares.
 *
 * Per vertex: (u, v, weight, angle). `u` is metres along the river from its source and `v` signed metres across it, positive to the right looking downstream -- a plane coordinate the shader samples the same noise in, so a bend carries its waves round the bend. `angle` is the downstream direction at the sample, atan2(z, x) in world XZ, which the shader turns back into the vector it rotates the surface gradient with; an angle rather than the vector so the frame fits one attribute. `weight` is 0 where the river lies on water another body holds (`reach`, from PathSet.flowReach) and fades to 1 over FLOW_FADE_HALF_WIDTHS of the local half-width beyond that, so a tributary's drift turns into its trunk's rather than crossing it, and a river leaving a lake drifts with the lake until it is clear of it.
 *
 * `ribbon` is ribbonVertices' result; `forward` is PathSet.flowsForward, which says whether sample order IS downstream.
 */
export function flowFrame(ribbon, forward, reach) {
  const { count: n, arc, halfRight, halfLeft, tangents, length } = ribbon
  if (typeof forward !== 'boolean') throw new Error(`flowFrame: forward must be a boolean, got ${forward}`)
  if (!reach || !(reach.source >= 0) || !(reach.mouth >= 0)) throw new Error(`flowFrame: reach must be { source >= 0, mouth >= 0 }, got ${JSON.stringify(reach)}`)
  const sign = forward ? 1 : -1
  const flow = new Float32Array(n * 2 * 4)
  for (let i = 0; i < n; i++) {
    // The wider edge: a clamp narrows the inside of a bend, and the fade is about the channel, not the corner.
    const w = Math.max(halfRight[i], halfLeft[i])
    const u = forward ? arc[i] : length - arc[i]
    const fade = Math.max(FLOW_FADE_HALF_WIDTHS * w, FLOW_FADE_MIN)
    const fromSource = Math.min(1, Math.max(0, (u - reach.source) / fade))
    const fromMouth = Math.min(1, Math.max(0, (length - u - reach.mouth) / fade))
    const weight = Math.min(fromSource, fromMouth)
    const angle = Math.atan2(sign * tangents[i * 2 + 1], sign * tangents[i * 2])
    const o = i * 8
    flow[o] = u
    flow[o + 1] = sign * halfRight[i]
    flow[o + 2] = weight
    flow[o + 3] = angle
    flow[o + 4] = u
    flow[o + 5] = -sign * halfLeft[i]
    flow[o + 6] = weight
    flow[o + 7] = angle
  }
  return flow
}

/**
 * A river ribbon's distance ladder: the coarse sample set and the chunks, so one static geometry can be drawn at any mix of detail by choosing indices alone. `lodIndices` writes those.
 *
 * COARSE SAMPLES are the fine samples LOD_SPACING metres of arc apart, plus one wherever the heading has turned LOD_TURN since the last, plus both ends. That alone can fold: a coarse quad spans several fine ones, and on a bend the collapsed inner vertices it skips over were exactly what kept the fine quads oriented. So every coarse quad is tested with the same predicate ribbonVertices asserts and a failing one is bisected at a fine sample until it passes -- an adjacent pair of fine samples always does, because the ribbon was asserted quad by quad.
 *
 * CHUNKS are cut on coarse samples about LOD_CHUNK metres apart, and the cut sample belongs to both chunks. That is what lets neighbours differ: a fine chunk and a coarse chunk meet at a vertex both of them draw.
 *
 * `coarse[k]` is the fine sample coarse vertex pair k is; `capacity` is the index count of the all-fine strip, which no mix exceeds since a coarse quad replaces at least one fine one.
 */
export function ribbonLod(ribbon, opts = {}) {
  const { spacing = LOD_SPACING, turn = LOD_TURN, chunk = LOD_CHUNK } = opts
  const { count: n, positions, arc, tangents } = ribbon
  if (!(n >= 2) || positions.length !== n * 6) throw new Error('ribbonLod: needs ribbonVertices\' result')

  const pick = new Uint8Array(n)
  pick[0] = 1
  pick[n - 1] = 1
  let last = 0
  for (let i = 1; i < n - 1; i++) {
    const turned = Math.abs(Math.atan2(cross2(tangents[last * 2], tangents[last * 2 + 1], tangents[i * 2], tangents[i * 2 + 1]), tangents[last * 2] * tangents[i * 2] + tangents[last * 2 + 1] * tangents[i * 2 + 1]))
    if (arc[i] - arc[last] >= spacing || turned >= turn) {
      pick[i] = 1
      last = i
    }
  }

  // The repair. Same triangles lodIndices will emit for the pair, same sign rule as ribbonVertices' tri.
  const quadOk = (i, j) => {
    const a0x = positions[i * 6], a0z = positions[i * 6 + 2], b0x = positions[i * 6 + 3], b0z = positions[i * 6 + 5]
    const a1x = positions[j * 6], a1z = positions[j * 6 + 2], b1x = positions[j * 6 + 3], b1z = positions[j * 6 + 5]
    const t0 = cross2(a1x - a0x, a1z - a0z, b0x - a0x, b0z - a0z)
    const t1 = cross2(a1x - b0x, a1z - b0z, b1x - b0x, b1z - b0z)
    return (t0 < 0 || (t0 === 0 && a0x === a1x && a0z === a1z)) && (t1 < 0 || (t1 === 0 && b0x === b1x && b0z === b1z))
  }
  const stack = []
  for (let i = 0, j = 1; j < n; j++) {
    if (!pick[j]) continue
    stack.push(i, j)
    while (stack.length) {
      const b = stack.pop()
      const a = stack.pop()
      if (b - a < 2 || quadOk(a, b)) continue
      const mid = (a + b) >> 1
      pick[mid] = 1
      stack.push(a, mid, mid, b)
    }
    i = j
  }

  let m = 0
  for (let i = 0; i < n; i++) m += pick[i]
  const coarse = new Int32Array(m)
  for (let i = 0, k = 0; i < n; i++) if (pick[i]) coarse[k++] = i

  // Chunks, cut at the first coarse sample at least `chunk` metres past the cut before it. The last cut is the last sample, so the final chunk is whatever remains, never empty.
  const cuts = [0]
  for (let k = 1; k < m - 1; k++) if (arc[coarse[k]] - arc[coarse[cuts[cuts.length - 1]]] >= chunk) cuts.push(k)
  cuts.push(m - 1)
  const chunks = []
  for (let c = 0; c + 1 < cuts.length; c++) {
    const c0 = cuts[c]
    const c1 = cuts[c + 1]
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let i = coarse[c0]; i <= coarse[c1]; i++) {
      for (const o of [i * 6, i * 6 + 3]) {
        const x = positions[o], z = positions[o + 2]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
    chunks.push({ c0, c1, minX, maxX, minZ, maxZ })
  }

  return { count: n, coarse, chunks, capacity: (n - 1) * 6, states: new Uint8Array(chunks.length) }
}

// Chunk states, in order of distance.
export const LOD_STATE_FINE = 0
export const LOD_STATE_COARSE = 1

/**
 * The index list for a ladder at its current `states`, one entry per chunk, written into `out` from 0. Returns the count. Winding is ribbonVertices': (right a, right b, left a), (left a, right b, left b).
 */
export function lodIndices(lod, out) {
  const { coarse, chunks, states } = lod
  let o = 0
  const quad = (ra, la, rb, lb) => {
    out[o++] = ra
    out[o++] = rb
    out[o++] = la
    out[o++] = la
    out[o++] = rb
    out[o++] = lb
  }
  for (let c = 0; c < chunks.length; c++) {
    const { c0, c1 } = chunks[c]
    const s = states[c]
    if (s === LOD_STATE_FINE) {
      for (let i = coarse[c0]; i < coarse[c1]; i++) quad(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 3)
      continue
    }
    if (s !== LOD_STATE_COARSE) throw new Error(`lodIndices: chunk ${c} has state ${s}`)
    for (let k = c0; k < c1; k++) {
      const a = coarse[k] * 2
      const b = coarse[k + 1] * 2
      quad(a, a + 1, b, b + 1)
    }
  }
  return o
}
