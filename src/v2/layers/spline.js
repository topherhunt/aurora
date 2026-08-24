// ---------------------------------------------------------------------------
// Centripetal Catmull-Rom through control points that each carry a width (DESIGN.md §18).
//
// Three-free. Rivers and roads are the same object, so this is the only curve in v2.
//
// CENTRIPETAL (alpha = 0.5), not uniform, and the difference is not cosmetic. Uniform Catmull-Rom overshoots when the control points are unevenly spaced -- a short segment followed by a long one throws the curve outside the hull of its own points -- and on a tight turn the overshoot is large enough that the curve crosses itself. A river spline that loops through its own bank carves the terrain twice in the same place, which is a hole, not a bend. Centripetal parameterisation is the standard fix and is provably loop- and cusp-free (Yuksel et al. 2011), which is what check-v2-layers.mjs asserts on a deliberately tight S-bend.
//
// The knot spacing is the whole implementation: t_{i+1} = t_i + |p_{i+1} - p_i|^alpha. Setting alpha = 0 gives back uniform Catmull-Rom, so "centripetal" written in a comment above uniform code is indistinguishable from the real thing by reading -- the gate checks the knot spacing itself rather than trusting the label.
// ---------------------------------------------------------------------------

const ALPHA = 0.5

// Coincident control points are legal input from a click-to-place editor (double-click, or a drag that ends where it started) and would put a zero in every knot denominator. Floor the spacing instead: the curve through a doubled point is then a very tight but finite turn, which is what the author sees on screen.
const MIN_KNOT = 1e-6

export class Spline {
  // points: [[x, y, z, width], ...] -- width in metres, the FULL width; flatten() emits half-widths because every consumer wants the half.
  constructor(points) {
    if (!Array.isArray(points) || points.length === 0) {
      throw new Error(`Spline: needs at least one control point, got ${Array.isArray(points) ? 0 : typeof points}`)
    }
    const n = points.length
    for (let i = 0; i < n; i++) {
      const p = points[i]
      if (!Array.isArray(p) || p.length < 4) {
        throw new Error(`Spline: control point ${i} must be [x, y, z, width], got ${JSON.stringify(p)}`)
      }
      for (let c = 0; c < 4; c++) {
        if (typeof p[c] !== 'number' || !Number.isFinite(p[c])) {
          throw new Error(`Spline: control point ${i} component ${c} is not a finite number (${p[c]})`)
        }
      }
      if (p[3] < 0) throw new Error(`Spline: control point ${i} has negative width ${p[3]}`)
    }

    this.count = n
    this.segments = n - 1

    // Padded control array: one reflected point at each end so the curve STARTS at p[0] and ENDS at p[n-1] rather than at p[1] and p[n-2]. Reflection (2*p0 - p1) rather than duplication, because a duplicated endpoint has zero knot spacing there and the tangent it produces is degenerate.
    //
    // For n == 2 this is exactly a straight line and not merely close to one: the reflected quartet is collinear and evenly spaced, so both Catmull-Rom tangents come out as (p1 - p0) and the Hermite cubic collapses to the lerp. Width goes linear for the same reason. No special case needed, and the gate checks it.
    const m = n + 2
    const p = new Float64Array(m * 4)
    for (let i = 0; i < n; i++) {
      const src = points[i]
      const o = (i + 1) * 4
      p[o] = src[0]
      p[o + 1] = src[1]
      p[o + 2] = src[2]
      p[o + 3] = src[3]
    }
    if (n === 1) {
      // A one-point spline has no segment at all; the pad exists only so the array shape is uniform.
      for (let c = 0; c < 4; c++) {
        p[c] = p[4 + c]
        p[(m - 1) * 4 + c] = p[4 + c]
      }
    } else {
      for (let c = 0; c < 4; c++) {
        p[c] = 2 * p[4 + c] - p[8 + c]
        p[(m - 1) * 4 + c] = 2 * p[(m - 2) * 4 + c] - p[(m - 3) * 4 + c]
      }
    }
    this._p = p

    // Knot SPACINGS, one per padded interval. Knots themselves are translation invariant, so a segment reconstructs its own t0..t3 from three consecutive spacings and nothing has to store an absolute parameter.
    //
    // Distance is 3D. A river that climbs steeply between two points that are close in plan has genuinely more curve to spend there, and using the plan distance alone would hand it a knot spacing that says otherwise.
    const knots = new Float64Array(m - 1)
    for (let i = 0; i < m - 1; i++) {
      const a = i * 4
      const b = a + 4
      const dx = p[b] - p[a]
      const dy = p[b + 1] - p[a + 1]
      const dz = p[b + 2] - p[a + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      knots[i] = Math.max(MIN_KNOT, Math.pow(d, ALPHA))
    }
    this._knots = knots
  }

  // The four knots of segment i, normalised so t0 = 0. Exposed so the gate can prove the parameterisation is not uniform: uniform Catmull-Rom would give spacings of exactly 1 here regardless of how the points are placed.
  segmentKnots(i) {
    if (!(i >= 0 && i < Math.max(1, this.segments))) {
      throw new Error(`Spline.segmentKnots: segment ${i} out of range 0..${this.segments - 1}`)
    }
    const k = this._knots
    const d0 = k[i]
    const d1 = k[i + 1]
    const d2 = k[i + 2]
    return [0, d0, d0 + d1, d0 + d1 + d2]
  }

  // Barry-Goldman pyramid, run on all four components at once so width rides the same parameterisation as position. Writes into `out` (length >= 4) to keep flatten() allocation-free.
  _evalSegment(i, s, out) {
    const k = this._knots
    const d0 = k[i]
    const d1 = k[i + 1]
    const d2 = k[i + 2]
    const t1 = d0
    const t2 = d0 + d1
    const t3 = d0 + d1 + d2
    const t = t1 + s * d1

    const uA1 = t / d0
    const uA2 = s
    const uA3 = (t - t2) / d2
    const uB1 = t / t2
    const uB2 = (t - t1) / (t3 - t1)

    const p = this._p
    const b0 = i * 4
    for (let c = 0; c < 4; c++) {
      const p0 = p[b0 + c]
      const p1 = p[b0 + 4 + c]
      const p2 = p[b0 + 8 + c]
      const p3 = p[b0 + 12 + c]
      const a1 = p0 + (p1 - p0) * uA1
      const a2 = p1 + (p2 - p1) * uA2
      const a3 = p2 + (p3 - p2) * uA3
      const q1 = a1 + (a2 - a1) * uB1
      const q2 = a2 + (a3 - a2) * uB2
      out[c] = q1 + (q2 - q1) * s
    }
    // Catmull-Rom is an interpolating spline, not a hull-bounded one, so a width that dips sharply between two wide points can undershoot past zero. A negative half-width would flip the sign of every distance test downstream; clamp here, where it is one comparison, rather than in four call sites.
    if (out[3] < 0) out[3] = 0
  }

  // u in [0, segments]. Integer u lands exactly on control point u.
  evalAt(u) {
    if (typeof u !== 'number' || !Number.isFinite(u)) {
      throw new Error(`Spline.evalAt: u must be a finite number, got ${u}`)
    }
    const out = [0, 0, 0, 0]
    if (this.segments === 0) {
      const p = this._p
      return { x: p[4], y: p[5], z: p[6], width: p[7] }
    }
    let uu = u
    if (uu < 0) uu = 0
    else if (uu > this.segments) uu = this.segments
    let i = Math.floor(uu)
    if (i >= this.segments) i = this.segments - 1
    this._evalSegment(i, uu - i, out)
    return { x: out[0], y: out[1], z: out[2], width: out[3] }
  }

  // Polyline approximation of arc length. sub is per SEGMENT, not per spline, so a long river and a short one are sampled at the same fidelity per bend.
  length(sub = 32) {
    if (this.segments === 0) return 0
    const a = [0, 0, 0, 0]
    const b = [0, 0, 0, 0]
    let total = 0
    for (let i = 0; i < this.segments; i++) {
      this._evalSegment(i, 0, a)
      for (let k = 1; k <= sub; k++) {
        this._evalSegment(i, k / sub, b)
        total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
        a[0] = b[0]
        a[1] = b[1]
        a[2] = b[2]
      }
    }
    return total
  }

  // Flatten to packed (x, y, z, halfWidth) samples at approximately uniform arc-length spacing.
  //
  // ADAPTIVE per segment, not a fixed subdivision count: the spacing is what the path index bins on, and a segment whose chord exceeds it leaves a gap the nearest() query can fall into. The first estimate comes from the measured segment length; the loop then verifies the actual chords and doubles until every one fits, which is what makes the guarantee hold on a tight bend where arc length is a poor predictor of chord length.
  flatten(spacing) {
    if (!(spacing > 0) || !Number.isFinite(spacing)) {
      throw new Error(`Spline.flatten: spacing must be a finite number > 0, got ${spacing}`)
    }
    const p = this._p
    if (this.segments === 0) {
      return Float32Array.of(p[4], p[5], p[6], p[7] / 2)
    }

    const out = []
    const cur = [0, 0, 0, 0]
    const prev = [0, 0, 0, 0]
    this._evalSegment(0, 0, prev)
    out.push(prev[0], prev[1], prev[2], prev[3] / 2)

    for (let i = 0; i < this.segments; i++) {
      // Two subdivisions to start even on a segment that measures shorter than `spacing`, so a hairpin between two nearby control points still gets a midpoint.
      let steps = Math.max(2, Math.ceil(this._segmentLength(i, 16) / spacing))
      let accepted = null
      for (let attempt = 0; attempt < 7; attempt++) {
        const samples = new Float64Array((steps + 1) * 4)
        let worst = 0
        for (let k = 0; k <= steps; k++) {
          this._evalSegment(i, k / steps, cur)
          const o = k * 4
          samples[o] = cur[0]
          samples[o + 1] = cur[1]
          samples[o + 2] = cur[2]
          samples[o + 3] = cur[3]
          if (k > 0) {
            const q = o - 4
            const d = Math.hypot(samples[o] - samples[q], samples[o + 1] - samples[q + 1], samples[o + 2] - samples[q + 2])
            if (d > worst) worst = d
          }
        }
        if (worst <= spacing) {
          accepted = samples
          break
        }
        steps *= 2
      }
      if (accepted === null) {
        throw new Error(`Spline.flatten: segment ${i} still exceeds ${spacing} m chords after 64x oversampling -- degenerate control points`)
      }
      // k starts at 1: sample 0 of this segment is sample `steps` of the last one, and a duplicated point makes a zero-length segment in the path index.
      for (let k = 1; k <= steps; k++) {
        const o = k * 4
        out.push(accepted[o], accepted[o + 1], accepted[o + 2], accepted[o + 3] / 2)
      }
    }
    return Float32Array.from(out)
  }

  _segmentLength(i, sub) {
    const a = [0, 0, 0, 0]
    const b = [0, 0, 0, 0]
    this._evalSegment(i, 0, a)
    let total = 0
    for (let k = 1; k <= sub; k++) {
      this._evalSegment(i, k / sub, b)
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      a[0] = b[0]
      a[1] = b[1]
      a[2] = b[2]
    }
    return total
  }
}
