import { clamp01 } from '../sim/mathx.js'
import { priorityFlood } from '../sim/hydrology.js'
import { BIOMES } from './biomes.js'

// ---------------------------------------------------------------------------
// The map instrument's painters -- §31. DOM-free, so /terrain-v3-map and scripts/island-png.mjs draw from one implementation.
//
// Everything here is a READER of the generator's result. Hillshade and slope are presentation and live nowhere else; the bowls layer re-runs the flood the generator's own instrument ran, on the same field.
// ---------------------------------------------------------------------------

export const LAYERS = [
  ['relief', 'relief (hillshade)'],
  ['elev', 'elevation'],
  ['slope', 'slope'],
  ['bowls', 'closed bowls'],
  ['biomes', 'biomes'],
  ['water', 'lakes and rivers'],
]

/** Lit from the north-west at 42 degrees, the cartographic convention; lit from anywhere else the eye reads every valley as a ridge. */
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
      sh[j * n + i] = clamp01(0.32 + 0.78 * ((-dx * L[0] + L[1] + -dz * L[2]) / nl))
    }
  }
  return sh
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

/** Hillshade and slope, computed once per result and hung on it. */
export function derive(r) {
  const { height: H, n, cell } = r
  r._shade = hillshade(H, n, cell)
  r._slope = new Float32Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) r._slope[j * n + i] = slopeAt(H, i, j, n, cell)
  return r
}

const SEA = [22, 46, 78]
const SEA_DEEP = [8, 18, 38]
const LAND = [122, 128, 96]
const SNOW = [232, 236, 240]

function put(px, c, rgb, k = 1) {
  px[c * 4] = rgb[0] * k
  px[c * 4 + 1] = rgb[1] * k
  px[c * 4 + 2] = rgb[2] * k
  px[c * 4 + 3] = 255
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

function paintRelief(px, r) {
  const { height: H, n } = r
  const snow = r.doc.snow.base
  for (let c = 0; c < n * n; c++) {
    const h = H[c]
    const sh = r._shade[c]
    if (h <= 0) put(px, c, mix(SEA, SEA_DEEP, clamp01(-h / 300)), 0.55 + 0.45 * sh)
    else put(px, c, mix(LAND, SNOW, clamp01((h - snow) / 60 + 0.5)), 0.35 + 0.75 * sh)
  }
}

// Sea in blues by depth, land in a green-brown-white ramp by elevation, contour bands every 100 m.
function paintElev(px, r) {
  const { height: H, n } = r
  const top = r.stats.max
  for (let c = 0; c < n * n; c++) {
    const h = H[c]
    if (h <= 0) {
      put(px, c, mix(SEA, SEA_DEEP, clamp01(-h / 300)))
      continue
    }
    const t = clamp01(h / top)
    const rgb = t < 0.5 ? mix([70, 120, 60], [170, 140, 80], t * 2) : mix([170, 140, 80], SNOW, (t - 0.5) * 2)
    const band = Math.floor(h / 100) % 2 === 0 ? 1 : 0.88
    put(px, c, rgb, band)
  }
}

function paintSlope(px, r) {
  const { height: H, n } = r
  for (let c = 0; c < n * n; c++) {
    if (H[c] <= 0) {
      put(px, c, SEA)
      continue
    }
    const deg = (r._slope[c] * 180) / Math.PI
    // Green under 10 degrees, amber to 25, red past 38 (the walkability limit).
    const rgb = deg < 10 ? mix([60, 110, 60], [200, 190, 60], deg / 10) : deg < 25 ? mix([200, 190, 60], [210, 110, 40], (deg - 10) / 15) : mix([210, 110, 40], [200, 40, 40], clamp01((deg - 25) / 13))
    put(px, c, rgb)
  }
}

// Relief with every texel the flood would pond more than a metre deep painted as water, so the basin term can be judged by what it leaves for step D. The flood is re-run here from the field rather than shipped in the result: a label grid is four megabytes the cache and the worker message do not need.
function paintBowls(px, r) {
  paintRelief(px, r)
  const { height: H, n } = r
  if (!r._filled) r._filled = priorityFlood(H, n).filled
  for (let c = 0; c < n * n; c++) {
    if (H[c] <= 0) continue
    const depth = r._filled[c] - H[c]
    if (depth > 1) put(px, c, mix([90, 150, 220], [30, 70, 150], clamp01(depth / 40)))
  }
}

// Each class in its map colour over the hillshade, the sea as on the relief layer.
function paintBiomes(px, r) {
  const { height: H, n } = r
  for (let c = 0; c < n * n; c++) {
    const sh = r._shade[c]
    if (H[c] <= 0) put(px, c, mix(SEA, SEA_DEEP, clamp01(-H[c] / 300)), 0.55 + 0.45 * sh)
    else put(px, c, BIOMES[r.ground[c]].map, 0.45 + 0.65 * sh)
  }
}

const WATER = [40, 110, 210]
const WATER_DEEP = [20, 50, 140]

// Relief with the doc's water on it, read the way v2 reads it: each island lake is the ground inside its ellipse that lies under its level, the sea excepted; each river its polyline, one texel wide plus its width, brightening with the width.
function paintWater(px, r) {
  paintRelief(px, r)
  const { height: H, n, cell } = r
  const half = ((n - 1) * cell) / 2
  for (const lake of r.doc.lakes) {
    if (lake.y <= 0) continue
    const c = Math.cos(lake.rot)
    const s = Math.sin(lake.rot)
    const reach = Math.max(lake.rx, lake.rz)
    const i0 = Math.max(0, Math.floor((lake.x - reach + half) / cell))
    const i1 = Math.min(n - 1, Math.ceil((lake.x + reach + half) / cell))
    const j0 = Math.max(0, Math.floor((lake.z - reach + half) / cell))
    const j1 = Math.min(n - 1, Math.ceil((lake.z + reach + half) / cell))
    for (let j = j0; j <= j1; j++) {
      const dz = j * cell - half - lake.z
      for (let i = i0; i <= i1; i++) {
        const dx = i * cell - half - lake.x
        const lx = c * dx + s * dz
        const lz = -s * dx + c * dz
        if ((lx * lx) / (lake.rx * lake.rx) + (lz * lz) / (lake.rz * lake.rz) > 1) continue
        const k = j * n + i
        const depth = lake.y - H[k]
        if (depth > 0) put(px, k, mix(WATER, WATER_DEEP, clamp01(depth / 40)))
      }
    }
  }
  for (const river of r.doc.rivers) {
    for (let p = 1; p < river.pts.length; p++) {
      const [ax, az, aw = 1] = river.pts[p - 1]
      const [bx, bz, bw = aw] = river.pts[p]
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (cell * 0.5)))
      for (let t = 0; t <= steps; t++) {
        const u = t / steps
        const w = aw + (bw - aw) * u
        const rad = 0.5 + w / cell
        const ci = (ax + (bx - ax) * u + half) / cell
        const cj = (az + (bz - az) * u + half) / cell
        const rgb = mix(WATER, [120, 190, 255], clamp01(w / 10))
        for (let j = Math.max(0, Math.floor(cj - rad)); j <= Math.min(n - 1, Math.ceil(cj + rad)); j++) {
          for (let i = Math.max(0, Math.floor(ci - rad)); i <= Math.min(n - 1, Math.ceil(ci + rad)); i++) {
            if (Math.hypot(i - ci, j - cj) <= rad) put(px, j * n + i, rgb)
          }
        }
      }
    }
  }
}

export function paintInto(px, r, layerId) {
  switch (layerId) {
    case 'relief': return paintRelief(px, r)
    case 'elev': return paintElev(px, r)
    case 'slope': return paintSlope(px, r)
    case 'bowls': return paintBowls(px, r)
    case 'biomes': return paintBiomes(px, r)
    case 'water': return paintWater(px, r)
    default: throw new Error(`paint: unknown layer ${layerId}`)
  }
}
