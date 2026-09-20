import { Noise } from '../sim/noise.js'
import { smoothstep } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// The island's MACRO SHAPE -- §31 step A.
//
// A cone standing in a sea that keeps falling, and nothing smaller than the coast's own features. Every term reads a WARPED position rather than the texel's own, and the coast radius is a function of angle, so the silhouette has bays and headlands at three sizes and the big lobes carry ridges out from the massif on their own -- height is a function of `r / R(theta)`, so ground that reaches further out reaches further out at height.
//
// Three-free and DOM-free: the gate and the PNG script run this in node.
// ---------------------------------------------------------------------------

export const MACRO = {
  coastRadius: 2500,      // R0, metres: the mean distance from the centre to the shore
  summit: 450,            // H, metres, before the summit rounding: the cone is the pedestal, step B's ridges are the mountains
  profileExp: 1.7,        // (1 - d)^p: above 1 the skirt is gentle and the massif steep
  summitRound: 0.08,      // fraction of H over which the cone's point is rounded into a massif
  apron: 0.12,            // fraction of H under which the profile bends toward lowland
  apronSlope: 0.15,       // share of the cone's own slope the apron keeps at the waterline, so the beach is never a plane the sea can fight
  shelfDepth: 6,          // metres under the sea the coastal shelf sits
  shelfWidth: 120,        // metres of shelf before the sea floor falls
  seaSlope: 1 / 9,        // the fall past the shelf, all the way to the box edge
  // The coast's character around the island: `k` as for the harmonics, `share` the fraction of the shoreline that is cliff rather than beach. A cliff sector carries a ridge along the coast, `height` metres (varied by `vary` at radius `varyK`), that fades in from d 0.75 and drops into the sea across d 0.985..1.015.
  cliffs: { k: 0.6, share: 0.5, height: 70, vary: 0.6, varyK: 3.0 },
  // [wavelength, amplitude] in metres. Three sizes of bay and headland.
  warp: [[1600, 380], [520, 110], [170, 32]],
  // Angular harmonics of the coast radius: `k` is the noise radius on the unit circle (about 2*pi*k features around the coast), `amp` the fraction of R0.
  coastLow: { k: 0.7, amp: 0.32 },
  coastHigh: { k: 2.8, amp: 0.09 },
  // The bipolar term in the mid-elevation ring that leaves closed bowls for lakes: on a slope S a wave of length L closes a bowl once its amplitude passes about S * L / 4, which at the ring's 20% slopes is 45 m.
  basin: { inner: 0.3, outer: 0.75, wavelength: 900, amp: 90, dipShare: 1.0, lumpShare: 0.6, apronAmp: 40 },
}

// ---------------------------------------------------------------------------
// The OCTAVES -- §31 step B. Eight of fbm from `top` down at gain 0.5, the 1/f law, the top `warped` of them reading the macro shape's warped position; ridged noise blended in over the massif so the centre is a cluster of peaks and not the cone's cap; and a variance mask on the MACRO height so the lowlands stay quiet, the mountains do not, and the sea floor keeps enough structure for v2's roughness calibration to fit.
// ---------------------------------------------------------------------------

export const OCTAVES = {
  top: 2048,              // wavelength in metres of the first octave; the eighth is top / 128 = 16 m
  count: 8,
  gain: 0.5,
  amp: 150,               // metres, the first octave's amplitude at full mask
  warped: 3,              // how many of the top octaves read the warped position
  lowland: 0.25,          // the mask at the apron and on the shelf
  seaFloor: 0.5,          // the mask on the deep sea floor
  maskFrom: 0.15,         // fractions of the summit over which the mask rises from `lowland` to 1
  maskTo: 0.7,
  // The massif's ridged term: `wavelength` of the base octave, `amp` metres from valley to crest at full weight, weight rising over `from`..`to` of the summit. `round` as for Noise.ridged, so the crests are wider than the 8 m texel.
  ridge: { wavelength: 1100, octaves: 5, amp: 340, from: 0.3, to: 0.75, round: 0.12 },
}

/** Softplus with a shoulder of `eps`: max(0, v) without the crease at zero. */
function soft(v, eps) {
  return 0.5 * (v + Math.sqrt(v * v + eps * eps))
}

/**
 * The macro field as a sampler over world metres, (x, z) -> metres. Built once per seed; `at` is what the grid loop and the instruments call.
 */
export class Island {
  constructor(seed, macro = MACRO, octaves = OCTAVES) {
    if (!Number.isFinite(seed)) throw new Error(`Island: seed must be a finite number, got ${seed}`)
    this.macro = macro
    this.octaves = octaves
    this.fbm = new Noise(seed * 7 + 401)
    this.ridge = new Noise(seed * 7 + 409)
    // One noise per role, seeded apart, so a warp octave and the coast harmonic never share a lattice and line up.
    this.warpX = macro.warp.map((_, i) => new Noise(seed * 7 + 11 + i))
    this.warpZ = macro.warp.map((_, i) => new Noise(seed * 7 + 31 + i))
    this.coastLow = new Noise(seed * 7 + 101)
    this.coastHigh = new Noise(seed * 7 + 103)
    this.basin = new Noise(seed * 7 + 211)
    this.cliffWhere = new Noise(seed * 7 + 307)
    this.cliffHow = new Noise(seed * 7 + 311)
  }

  /** The warped position, the coast radius there and the normalised distance `d` (0 centre, 1 shore). Returned as one object so the instruments can ask for the pieces. */
  frame(x, z) {
    const m = this.macro
    let wx = x
    let wz = z
    for (let i = 0; i < m.warp.length; i++) {
      const [lambda, amp] = m.warp[i]
      wx += amp * this.warpX[i].simplex2(x / lambda, z / lambda)
      wz += amp * this.warpZ[i].simplex2(x / lambda + 3.7, z / lambda - 1.9)
    }
    const r = Math.hypot(wx, wz)
    const theta = Math.atan2(wz, wx)
    const cx = Math.cos(theta)
    const sz = Math.sin(theta)
    const low = this.coastLow.simplex2(cx * m.coastLow.k, sz * m.coastLow.k)
    const high = this.coastHigh.simplex2(cx * m.coastHigh.k + 5.1, sz * m.coastHigh.k + 2.3)
    const R = m.coastRadius * (1 + m.coastLow.amp * low + m.coastHigh.amp * high)
    // 0 on a beach coast, 1 on a cliff coast. The threshold on a zero-mean noise is what makes `share` the fraction of the shoreline that is cliff.
    const c = m.cliffs
    const where = this.cliffWhere.simplex2(cx * c.k + 1.7, sz * c.k - 6.2)
    const cliff = smoothstep(0.6 - 1.2 * c.share - 0.15, 0.6 - 1.2 * c.share + 0.15, where)
    return { wx, wz, r, R, d: r / R, cx, sz, cliff }
  }

  /** Step A alone: the macro shape in metres. */
  macroAt(x, z) {
    return this.macroIn(this.frame(x, z))
  }

  /** The field: macro shape plus octaves. */
  at(x, z) {
    const f = this.frame(x, z)
    const macro = this.macroIn(f)
    return macro + this.octavesIn(f, x, z, macro)
  }

  macroIn(f) {
    const m = this.macro
    const { wx, wz, r, R, d, cx, sz, cliff } = f
    let h
    if (d < 1) {
      let v = Math.pow(1 - d, m.profileExp)
      // Rounded cap: above 1 - 2s the line is swapped for the parabola tangent to it there and flat at the top, so the summit is a massif at (1 - s) H and not a point at H.
      const s = m.summitRound
      const knee = 1 - 2 * s
      if (v > knee) {
        const t = v - knee
        v = knee + t - (t * t) / (4 * s)
      }
      h = m.summit * v
      // The apron, on the beach coasts: under `apron * H` the profile is bent down toward a quadratic so the last few hundred metres before the shore are lowland, blended in over the band so there is no kink at the join. A cliff coast keeps the cone's own slope to the water.
      const A = m.apron * m.summit
      if (h < 1.5 * A && cliff < 1) {
        const u = h / A
        const bent = A * (u * u * (1 - m.apronSlope) + u * m.apronSlope)
        const eased = bent + (h - bent) * smoothstep(0.5 * A, 1.5 * A, h)
        h = eased + (h - eased) * cliff
      }
    } else {
      // Sea: a shelf reached by a short steep drop, then a floor that falls to the box edge.
      const s = (d - 1) * R
      const deep = s - m.shelfWidth
      h = -(m.shelfDepth * smoothstep(0, 24, s) + m.seaSlope * soft(deep, 40))
    }
    // The coastal ridge of a cliff sector: a band of higher ground along the shore that ends in a drop into the sea rather than a beach.
    if (cliff > 0) {
      const c = m.cliffs
      const band = smoothstep(0.75, 0.93, d) * smoothstep(1.015, 0.985, d)
      if (band > 0) {
        const how = this.cliffHow.simplex2(cx * c.varyK + 8.3, sz * c.varyK + 0.4)
        h += cliff * band * c.height * (1 + c.vary * how)
      }
    }
    // The basin term, bipolar and stronger downward than upward, in the ring where the flood will look for lakes, and a third as strong on the apron for the low-lying ones.
    const b = m.basin
    const ring = smoothstep(b.inner, b.inner + 0.12, d) * smoothstep(b.outer, b.outer - 0.15, d)
    const apron = smoothstep(0.78, 0.9, d) * smoothstep(1.0, 0.94, d)
    const amp = b.amp * ring + b.apronAmp * apron
    if (amp > 0) {
      const nz = this.basin.simplex2(wx / b.wavelength + 9.2, wz / b.wavelength - 4.4)
      h += amp * (b.lumpShare * soft(nz, 0.15) - b.dipShare * soft(-nz, 0.15))
    }
    return h
  }

  /** Step B: what the octaves add at this texel, given the macro height there. */
  octavesIn(f, x, z, macro) {
    const o = this.octaves
    const H = this.macro.summit
    // The mask reads the macro height, not the sum, so an octave cannot feed its own amplitude. Continuous through the shore: the apron and the shelf share `lowland`, and the floor takes `seaFloor` once it is 60 m under.
    let mask
    if (macro >= 0) mask = o.lowland + (1 - o.lowland) * smoothstep(o.maskFrom * H, o.maskTo * H, macro)
    else mask = o.lowland + (o.seaFloor - o.lowland) * smoothstep(0, -60, macro)

    let sum = 0
    let amp = o.amp
    let lambda = o.top
    for (let i = 0; i < o.count; i++) {
      const px = i < o.warped ? f.wx : x
      const pz = i < o.warped ? f.wz : z
      sum += amp * this.fbm.simplex2(px / lambda + 17.3 * i, pz / lambda - 5.9 * i)
      amp *= o.gain
      lambda *= 0.5
    }
    let h = mask * sum

    const rd = o.ridge
    const w = smoothstep(rd.from * H, rd.to * H, macro)
    if (w > 0) {
      const n = this.ridge.ridged(f.wx / rd.wavelength + 2.2, f.wz / rd.wavelength + 7.7, rd.octaves, 2, 0.5, rd.round)
      // Zero-mean about the ridged field's typical level so the massif's mean height stays the cone's and the crests rise as far as the valleys fall.
      h += w * rd.amp * (n - 0.4)
    }
    return h
  }
}

/** Fill an n x n row-major grid over the WORLD_SIZE box, centred on the origin, `cell` metres a texel. */
export function rasterise(island, n, cell, out = new Float32Array(n * n)) {
  if (out.length !== n * n) throw new Error(`rasterise: out has ${out.length} texels, ${n}x${n} needs ${n * n}`)
  const half = ((n - 1) * cell) / 2
  for (let j = 0; j < n; j++) {
    const z = j * cell - half
    for (let i = 0; i < n; i++) out[j * n + i] = island.at(i * cell - half, z)
  }
  return out
}
