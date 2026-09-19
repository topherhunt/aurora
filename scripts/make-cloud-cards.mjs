// Bakes public/world/cloud-cards.png: an atlas of TILES shaded cumulus sprites,
// 256x128 each in a row, that the summit wreaths draw as billboards (§10,
// render/wreaths.js). RGB is the shading, a grey multiplier on the lit cloud
// colour; A is the cloud's coverage, soft at the rim and cut flat under the base.
//
//   node scripts/make-cloud-cards.mjs
//
// A cloud is a smooth union of puffs along a flat base, its edge warped by fBm
// so no silhouette is a row of circles, shaded as a height field lit from above
// and to one side, and darkened toward the base where a real cloud shades
// itself. The shading is written under the transparent pixels too, so a mip or
// a dithered fringe never bleeds black into the cloud.

import { writePng } from '../tools/props/png.mjs'

export const TILE_W = 256
export const TILE_H = 128
export const TILES = 4
const BASE_Y = 104 // px from the top: the flat base; below it the tile is clear
const OUT = 'public/world/cloud-cards.png'

let h = 0x51ed270b
const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0); h = (Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0); return ((h ^ (h >>> 15)) >>> 0) / 4294967296 }

function hash(x, y, seed) {
  let k = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  k = Math.imul(k ^ (k >>> 15), 0x2c1b3c6d)
  k = Math.imul(k ^ (k >>> 12), 0x297a2d39)
  return ((k ^ (k >>> 15)) >>> 0) / 4294967296
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)
function value(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = fade(x - x0), fy = fade(y - y0)
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed), c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed)
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy
}
const fbm = (x, y, seed) => value(x / 24, y / 24, seed) * 0.5 + value(x / 12, y / 12, seed + 1) * 0.3 + value(x / 6, y / 6, seed + 2) * 0.2
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

const atlas = new Uint8Array(TILE_W * TILES * TILE_H * 4)
const stats = []
for (let tile = 0; tile < TILES; tile++) {
  // The puffs: bigger toward the middle, all resting on the base.
  const puffs = []
  const n = 7 + Math.floor(rnd() * 4)
  for (let i = 0; i < n; i++) {
    const x = 34 + (i + rnd() * 0.8) * ((TILE_W - 68) / n)
    const dome = 1 - ((x - TILE_W / 2) / (TILE_W / 2)) ** 2
    const r = (24 + rnd() * 18) * (0.6 + 0.6 * dome)
    puffs.push({ x, y: BASE_Y - r * (0.55 + rnd() * 0.3), r })
  }
  // Height field: a soft union of the puffs, sampled through a warp.
  const height = (px, py) => {
    const wx = px + (fbm(px, py, 7 + tile * 3) - 0.5) * 18
    const wy = py + (fbm(px + 91, py + 37, 8 + tile * 3) - 0.5) * 18
    let s = 0
    for (const p of puffs) {
      const d2 = ((wx - p.x) ** 2 + (wy - p.y) ** 2) / (p.r * p.r)
      if (d2 < 1) s += (1 - d2) ** 1.5
    }
    // Saturating, never clamped: a clamp leaves a flat plateau whose edge shades as a hard line.
    return (s / (0.7 + s)) * smooth(BASE_Y + 4, BASE_Y - 8, py)
  }
  const field = new Float32Array(TILE_W * TILE_H)
  for (let y = 0; y < TILE_H; y++) for (let x = 0; x < TILE_W; x++) field[y * TILE_W + x] = height(x, y)
  const at = (x, y) => field[Math.max(0, Math.min(TILE_H - 1, y)) * TILE_W + Math.max(0, Math.min(TILE_W - 1, x))]

  let covered = 0
  const lx = -0.4, ly = -0.75, lz = 0.53 // toward the upper left, unit length
  for (let y = 0; y < TILE_H; y++) {
    for (let x = 0; x < TILE_W; x++) {
      const hh = at(x, y)
      const dx = (at(x + 1, y) - at(x - 1, y)) * 4, dy = (at(x, y + 1) - at(x, y - 1)) * 4
      const inv = 1 / Math.hypot(dx, dy, 1)
      const diffuse = Math.max(0, (-dx * lx - dy * ly + lz) * inv)
      // Darker toward the base: the underside of a cloud is in its own shadow.
      const depth = smooth(BASE_Y - 70, BASE_Y, y)
      const grain = 0.92 + 0.08 * fbm(x * 2, y * 2, 20 + tile)
      const shade = (0.55 + 0.45 * diffuse) * (1 - 0.32 * depth) * grain
      const rim = fbm(x + 300, y, 30 + tile)
      const alpha = smooth(0.06, 0.32, hh + (rim - 0.5) * 0.16)
      if (alpha > 0.5) covered++
      const o = ((y * TILE_W * TILES) + tile * TILE_W + x) * 4
      const g = Math.round(Math.max(0, Math.min(1, shade)) * 255)
      atlas[o] = g; atlas[o + 1] = g; atlas[o + 2] = g; atlas[o + 3] = Math.round(alpha * 255)
    }
  }
  stats.push(covered / (TILE_W * TILE_H))
}

// Every tile has a clear margin, or a card would show a hard edge at its quad.
for (let tile = 0; tile < TILES; tile++) {
  for (let y = 0; y < TILE_H; y++) for (const x of [0, TILE_W - 1]) {
    if (atlas[((y * TILE_W * TILES) + tile * TILE_W + x) * 4 + 3] > 0) throw new Error(`cloud-cards: tile ${tile} touches its side at row ${y}`)
  }
  for (let x = 0; x < TILE_W; x++) for (const y of [0, TILE_H - 1]) {
    if (atlas[((y * TILE_W * TILES) + tile * TILE_W + x) * 4 + 3] > 0) throw new Error(`cloud-cards: tile ${tile} touches its top or base at column ${x}`)
  }
}

writePng(OUT, TILE_W * TILES, TILE_H, atlas, 4)
console.log(`${OUT}: ${TILES} tiles of ${TILE_W}x${TILE_H}, covered ${stats.map((c) => `${(c * 100).toFixed(0)}%`).join(' ')}`)
