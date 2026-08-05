import { clamp01 } from './sim/mathx.js'
import { STREAM } from './sim/phase-a.js'
import { WORLD_SIZE } from './sim/terrain-height.js'

// ---------------------------------------------------------------------------
// The map view's layers: one RGBA image per field Phase A produced.
//
// DOM-free on purpose, so the browser page (map-main.js) and the headless PNG
// renderer (scripts/phase-a-png.mjs) share ONE implementation. A debug view that
// exists twice is a debug view whose two copies will eventually disagree, and
// §14 has a list of eleven instruments that drifted out from under the thing
// they named.
//
// Everything here is a READER. It recomputes nothing that phase-a.js decided --
// the sole exception is hillshade, which is presentation and exists nowhere
// else.
// ---------------------------------------------------------------------------

const MAX_WALK_SLOPE = (38 * Math.PI) / 180 // §4, mirrored for the slope layer

// --- layers ----------------------------------------------------------------
//
// Each paints one RGBA byte per cell. Signature (px, r) -> void.

export const LAYERS = [
  ['relief', 'relief', paintRelief],
  ['elev', 'elevation', paintElev],
  ['carve', 'breach cuts', paintCarve],
  ['fill', 'depression depth', paintFill],
  ['flow', 'flow accumulation', paintFlow],
  ['moist', 'moisture', paintMoisture],
  ['biome', 'biome', paintBiome],
  ['slope', 'slope / walkable', paintSlope],
  ['reach', 'reachable from spawn', paintReach],
]

// Hypsometric ramp, low to high. Not a rainbow: a rainbow makes every ramp look
// like a feature, and the point of this layer is to see where the ground
// actually rises.
const HYPSO = [
  [0.0, 42, 66, 52],
  [0.25, 78, 102, 62],
  [0.5, 128, 124, 82],
  [0.72, 150, 126, 104],
  [0.88, 176, 172, 172],
  [1.0, 246, 250, 255],
]

export const BIOME_RGB = [
  [186, 180, 170], // bare
  [40, 78, 52], // pine
  [92, 116, 74], // mixed
  [146, 126, 88], // heath
  [116, 158, 78], // lush
]

const WATER_RGB = [64, 118, 176]
const LAKE_RGB = [38, 82, 138]

function ramp(t) {
  const u = clamp01(t)
  for (let k = 1; k < HYPSO.length; k++) {
    if (u <= HYPSO[k][0]) {
      const a = HYPSO[k - 1]
      const b = HYPSO[k]
      const f = (u - a[0]) / (b[0] - a[0])
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]
    }
  }
  const last = HYPSO[HYPSO.length - 1]
  return [last[1], last[2], last[3]]
}

/**
 * Hillshade from the carved surface.
 *
 * Presentation only, and the only field this file computes. Light from the
 * north-west at 42 degrees, which is the cartographic convention -- lit from the
 * other side and the eye reads every valley as a ridge.
 */
export function hillshade(H, n, cell) {
  const sh = new Float32Array(n * n)
  const L = [-0.57, 0.6, -0.57]
  const ln = Math.hypot(L[0], L[1], L[2])
  L[0] /= ln
  L[1] /= ln
  L[2] /= ln
  for (let j = 0; j < n; j++) {
    const jm = j > 0 ? j - 1 : j
    const jp = j < n - 1 ? j + 1 : j
    for (let i = 0; i < n; i++) {
      const im = i > 0 ? i - 1 : i
      const ip = i < n - 1 ? i + 1 : i
      const dx = (H[j * n + ip] - H[j * n + im]) / ((ip - im) * cell)
      const dz = (H[jp * n + i] - H[jm * n + i]) / ((jp - jm) * cell)
      const nl = Math.hypot(dx, 1, dz)
      const d = (-dx * L[0] + L[1] + -dz * L[2]) / nl
      sh[j * n + i] = clamp01(0.32 + 0.78 * d)
    }
  }
  return sh
}

function paintRelief(px, r) {
  const { elev, n } = r
  const lo = r._lo
  const span = r._hi - r._lo
  for (let c = 0; c < n * n; c++) {
    const [cr, cg, cb] = ramp((elev[c] - lo) / span)
    const s = r._shade[c]
    put(px, c, cr * s, cg * s, cb * s)
  }
}

function paintElev(px, r) {
  const { elev, n } = r
  const lo = r._lo
  const span = r._hi - r._lo
  for (let c = 0; c < n * n; c++) {
    const [cr, cg, cb] = ramp((elev[c] - lo) / span)
    put(px, c, cr, cg, cb)
  }
}

// How much the breach pass cut, and where. This is the single most useful layer
// for judging channel carving by eye: real drainage cuts thread down valleys,
// while a bad setting cuts straight lines across ridges.
function paintCarve(px, r) {
  const { base, elev, n } = r
  const s = r._shade
  for (let c = 0; c < n * n; c++) {
    const d = base[c] - elev[c] // metres removed
    const g = 0.42 * s[c] * 255
    if (d < 0.05) {
      put(px, c, g, g, g)
    } else {
      const t = clamp01(d / 40)
      put(px, c, 90 + 165 * t, 60 + 40 * (1 - t), 50)
    }
  }
}

// filled - elev: what priority-flood had to raise. Almost all of it is
// millimetre-deep fractal roughness, so the ramp is deliberately low-contrast up
// top and saturates at LAKE.minDepth, where a dimple becomes a lake.
function paintFill(px, r) {
  const { filled, elev, n } = r
  const s = r._shade
  for (let c = 0; c < n * n; c++) {
    const d = filled[c] - elev[c]
    const g = 0.42 * s[c] * 255
    if (d < 0.01) {
      put(px, c, g, g, g)
    } else {
      const t = clamp01(Math.log10(1 + d) / Math.log10(1 + 30))
      put(px, c, 30 + 40 * (1 - t), 70 + 90 * t, 110 + 130 * t)
    }
  }
}

function paintFlow(px, r) {
  const { acc, n } = r
  const s = r._shade
  const norm = 1 / Math.log10(1 + n * n * 0.25)
  for (let c = 0; c < n * n; c++) {
    const t = clamp01(Math.log10(1 + acc[c]) * norm)
    const g = 0.35 * s[c] * 255
    put(px, c, g + (230 - g) * t * t, g + (240 - g) * t, g + (255 - g) * Math.sqrt(t))
  }
}

function paintMoisture(px, r) {
  const { moisture, n } = r
  for (let c = 0; c < n * n; c++) {
    const m = moisture[c]
    // Marked at the two biome edges so the layer shows the thresholds the biome
    // pass actually uses, not a smooth gradient that hides them.
    put(px, c, 190 - 150 * m, 150 + 60 * m, 90 + 150 * m)
  }
}

function paintBiome(px, r) {
  const { biome, n } = r
  const s = r._shade
  for (let c = 0; c < n * n; c++) {
    const [cr, cg, cb] = BIOME_RGB[biome[c]]
    const sh = 0.55 + 0.55 * s[c]
    put(px, c, cr * sh, cg * sh, cb * sh)
  }
}

function paintSlope(px, r) {
  const { elev, n, cell } = r
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const sl = slopeAt(elev, i, j, n, cell)
      if (sl > MAX_WALK_SLOPE) {
        const t = clamp01((sl - MAX_WALK_SLOPE) / 0.6)
        put(px, c, 120 + 130 * t, 40, 40)
      } else {
        const t = sl / MAX_WALK_SLOPE
        put(px, c, 60 + 120 * t, 130 + 60 * t, 70 + 60 * t)
      }
    }
  }
}

function paintReach(px, r) {
  const { reachable, n } = r
  const s = r._shade
  for (let c = 0; c < n * n; c++) {
    const g = s[c] * 255
    if (reachable[c]) put(px, c, g * 0.55, g * 0.95, g * 0.65)
    else put(px, c, g * 0.95, g * 0.4, g * 0.4)
  }
}

function put(px, c, r8, g8, b8) {
  const o = c * 4
  px[o] = r8
  px[o + 1] = g8
  px[o + 2] = b8
  px[o + 3] = 255
}

export function slopeAt(H, i, j, n, cell) {
  const im = i > 0 ? i - 1 : i
  const ip = i < n - 1 ? i + 1 : i
  const jm = j > 0 ? j - 1 : j
  const jp = j < n - 1 ? j + 1 : j
  const dx = (H[j * n + ip] - H[j * n + im]) / ((ip - im) * cell)
  const dz = (H[jp * n + i] - H[jm * n + i]) / ((jp - jm) * cell)
  return Math.atan(Math.hypot(dx, dz))
}

// --- overlays, drawn into the same buffer after the layer -------------------

export function drawOverlays(px, r, overlay) {
  const { n } = r
  if (overlay.contour) {
    const iv = 25 // metres
    const { elev } = r
    for (let j = 1; j < n; j++) {
      for (let i = 1; i < n; i++) {
        const c = j * n + i
        const b = Math.floor(elev[c] / iv)
        if (b !== Math.floor(elev[c - 1] / iv) || b !== Math.floor(elev[c - n] / iv)) {
          const o = c * 4
          // Every fifth contour is an index contour, as on a real map.
          const k = b % 5 === 0 ? 0.45 : 0.75
          px[o] *= k
          px[o + 1] *= k
          px[o + 2] *= k
        }
      }
    }
  }

  if (overlay.unreach) {
    const { reachable } = r
    for (let c = 0; c < n * n; c++) {
      if (reachable[c]) continue
      const o = c * 4
      px[o] = px[o] * 0.45 + 140
      px[o + 1] *= 0.35
      px[o + 2] *= 0.35
    }
  }

  if (overlay.water) {
    const { stream, lake, acc, n: nn } = r
    for (let c = 0; c < nn * nn; c++) {
      if (lake[c]) {
        put(px, c, LAKE_RGB[0], LAKE_RGB[1], LAKE_RGB[2])
      } else if (stream[c]) {
        // Brighter with discharge, so trunk rivers read differently from the
        // headwater threads that STREAM.minAcc is really tuning.
        const t = clamp01(Math.log10(1 + acc[c] / r._minAcc) / 2)
        put(px, c, WATER_RGB[0] * (0.7 + 0.5 * t), WATER_RGB[1] * (0.7 + 0.5 * t), WATER_RGB[2] * (0.75 + 0.4 * t))
      }
    }
  }
}

/**
 * Derived fields every layer wants: elevation range, hillshade, and the
 * resolution-scaled stream threshold.
 *
 * Computed once per Phase A result rather than per repaint -- at 2048^2,
 * re-shading on every layer toggle made the page feel broken.
 *
 * STREAM.minAcc is an area in CELLS, so it scales with resolution exactly as
 * runPhaseA rescales it internally. Restating it here rather than exporting it
 * from the pass is the one thing in this file that could drift, so it is
 * asserted against the pass's own stream mask by check-phase-a.
 */
export function derive(r) {
  let lo = Infinity
  let hi = -Infinity
  for (let c = 0; c < r.n * r.n; c++) {
    if (r.elev[c] < lo) lo = r.elev[c]
    if (r.elev[c] > hi) hi = r.elev[c]
  }
  r._lo = lo
  r._hi = hi
  r._shade = hillshade(r.elev, r.n, r.cell)
  r._minAcc = STREAM.minAcc * (WORLD_SIZE / 2048) ** 2 / r.cell ** 2
  return r
}

/** Paint one layer plus its overlays into an RGBA buffer of n*n*4 bytes. */
export function paintInto(px, r, layerId, overlay) {
  const entry = LAYERS.find((l) => l[0] === layerId)
  if (!entry) throw new Error(`no such map layer: ${layerId}`)
  entry[2](px, r)
  drawOverlays(px, r, overlay)
  return px
}
