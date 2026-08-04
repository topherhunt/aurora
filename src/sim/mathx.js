// Small math helpers shared by the sim layer.
// No three.js imports anywhere under src/sim -- see DESIGN.md §1 (porting escape hatch).

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const lerp = (a, b, t) => a + (b - a) * t

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

// Deterministic 32-bit PRNG. Same seed, same world, on every device and every
// reload -- which is the whole reason the world can be a seed and not a download.
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
