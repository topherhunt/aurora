import { Noise } from './noise.js'
import { clamp01, lerp, smoothstep } from './mathx.js'

// ---------------------------------------------------------------------------
// The terrain height function. DESIGN.md §3.
//
// This module is imported by BOTH the mesh worker (to build geometry) and the
// main thread (for collision and slope limiting). That is deliberate and it is
// load-bearing: if collision sampled a different function than the renderer,
// she would sink through hills or walk on air, and the bug would be maddening
// to find. One function, two callers, no interpolation of a transferred grid.
//
// Everything here is plain math. No three.js -- see DESIGN.md §1.
// ---------------------------------------------------------------------------

export const WORLD_SIZE = 16384 // metres, centred on the origin (§2)
export const WORLD_HALF = WORLD_SIZE / 2

// Tunables. These are the knobs for "what does this world look like", and they
// are the ones to reach for during desktop iteration (§17).
export const TUNING = {
  seaLevel: 30,
  valleyRelief: 95, // rolling amplitude on valley floors
  mountainRelief: 800, // added on top where the mountain mask is high

  warpAmp: 900, // domain warp strength, metres (§3 item 2)
  warpFreq: 0.00035,

  macroFreq: 0.000075, // where mountains are at all
  mountainMaskLo: 0.34,
  mountainMaskHi: 0.86,

  ridgeFreq: 0.00034, // the mountain backbone (§3 item 1)
  ridgeOctaves: 6,

  baseFreq: 0.00042, // valley-floor rolling

  detailFreq: 0.0042, // high-frequency surface break-up
  detailMin: 2.0, // amplitude where the variance mask is 0 (smooth meadow)
  detailMax: 26.0, // amplitude where it is 1 (shattered ground)
  varianceFreq: 0.00013, // §3 item 4

  terraceFreq: 0.00016, // §3 item 3 -- gated so only some regions band
  terraceStep: 26,
  terraceLo: 0.54,
  terraceHi: 0.82,
  terraceStrength: 0.8,

  cliffFreq: 0.00055, // §3 item 5 -- angular Worley breaks
  cliffAmp: 55,
}

// Quantise into bands with a sharp-but-not-vertical transition. Produces mesa
// edges and cliff bands rather than a smooth gradient.
function terrace(h, step) {
  const q = Math.floor(h / step)
  const f = h / step - q
  return (q + smoothstep(0.32, 0.68, f)) * step
}

export class TerrainHeight {
  constructor(seed = 1337) {
    this.seed = seed
    this.nWarp = new Noise(seed + 11)
    this.nWarp2 = new Noise(seed + 12)
    this.nMacro = new Noise(seed + 21)
    this.nRidge = new Noise(seed + 31)
    this.nBase = new Noise(seed + 41)
    this.nDetail = new Noise(seed + 51)
    this.nVariance = new Noise(seed + 61)
    this.nTerrace = new Noise(seed + 71)
    this.nCliff = new Noise(seed + 81)
  }

  // Metres above sea level at world XZ.
  heightAt(x, z) {
    const T = TUNING

    // 1. Domain warp. Cheapest large visual win available -- it is what turns
    //    symmetric noise blobs into twisted, geologically plausible shapes.
    const wu = this.nWarp.fbm(x * T.warpFreq, z * T.warpFreq, 3)
    const wv = this.nWarp2.fbm(x * T.warpFreq, z * T.warpFreq, 3)
    const wx = x + wu * T.warpAmp
    const wz = z + wv * T.warpAmp

    // 2. Macro mask -- where mountains exist at all, so ranges cluster instead
    //    of peppering the map uniformly.
    const macro = this.nMacro.fbm(wx * T.macroFreq, wz * T.macroFreq, 4) * 0.5 + 0.5
    const mountain = smoothstep(T.mountainMaskLo, T.mountainMaskHi, macro)

    // 3. Ridged multifractal backbone.
    const ridge = clamp01(
      this.nRidge.ridged(wx * T.ridgeFreq, wz * T.ridgeFreq, T.ridgeOctaves) * 1.55
    )

    // 4. Valley-floor rolling.
    const base = this.nBase.fbm(wx * T.baseFreq, wz * T.baseFreq, 4) * 0.5 + 0.5

    let h = T.seaLevel + base * T.valleyRelief
    h += mountain * ridge * T.mountainRelief

    // 5. Variance-masked detail. This is what gives "different levels of
    //    variation" rather than uniformly noisy everything (§3 item 4).
    const variance = clamp01(
      this.nVariance.fbm(wx * T.varianceFreq, wz * T.varianceFreq, 2) * 0.5 + 0.5
    )
    const detailAmp = lerp(T.detailMin, T.detailMax, variance) * (0.3 + 0.7 * mountain)
    h += this.nDetail.fbm(wx * T.detailFreq, wz * T.detailFreq, 4) * detailAmp

    // 6. Angular cliff breaks. Worley F1 near 0 means "close to a cell
    //    boundary", so this drops a step exactly along fractured lines.
    const cell = this.nCliff.worley(wx * T.cliffFreq, wz * T.cliffFreq)
    h -= (1 - smoothstep(0.0, 0.22, cell)) * T.cliffAmp * mountain

    // 7. Terracing, gated by its own mask. Uniform terracing looks like a
    //    wedding cake, so most of the world must not terrace at all.
    const tMask = smoothstep(
      T.terraceLo,
      T.terraceHi,
      this.nTerrace.fbm(wx * T.terraceFreq, wz * T.terraceFreq, 2) * 0.5 + 0.5
    )
    if (tMask > 0.001) {
      h = lerp(h, terrace(h, T.terraceStep), tMask * T.terraceStrength)
    }

    return h
  }

  // Surface normal by central difference. `eps` should be around the rendered
  // cell size -- too small and it picks up noise the mesh does not actually
  // have, which makes collision disagree with what she can see.
  normalAt(x, z, eps = 0.75, out = { x: 0, y: 1, z: 0 }) {
    const hL = this.heightAt(x - eps, z)
    const hR = this.heightAt(x + eps, z)
    const hD = this.heightAt(x, z - eps)
    const hU = this.heightAt(x, z + eps)
    const dx = (hR - hL) / (2 * eps)
    const dz = (hU - hD) / (2 * eps)
    const len = Math.hypot(dx, 1, dz)
    out.x = -dx / len
    out.y = 1 / len
    out.z = -dz / len
    return out
  }

  // Steepest slope in radians.
  slopeAt(x, z, eps = 0.75) {
    const n = this.normalAt(x, z, eps)
    return Math.acos(Math.min(1, n.y))
  }
}
