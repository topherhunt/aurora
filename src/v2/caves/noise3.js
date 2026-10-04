// Seeded value noise in 2D and 3D for the cave field. Pure. Value rather than simplex because the field calls it per voxel sample and a hash plus a smoothstep blend is the cheapest thing that reads as rock.

const fade = (t) => t * t * (3 - 2 * t)

export class Noise3 {
  constructor(seed) {
    this.seed = seed | 0
  }

  // -1..1 at integer lattice point (i, j, k).
  _h(i, j, k) {
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1) ^ this.seed
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
    h ^= h >>> 15
    return (h & 0xffff) / 32767.5 - 1
  }

  /** Roughly -1..1. */
  at3(x, y, z) {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z)
    const fx = fade(x - i), fy = fade(y - j), fz = fade(z - k)
    const a = this._h(i, j, k), b = this._h(i + 1, j, k)
    const c = this._h(i, j + 1, k), d = this._h(i + 1, j + 1, k)
    const e = this._h(i, j, k + 1), f = this._h(i + 1, j, k + 1)
    const g = this._h(i, j + 1, k + 1), l = this._h(i + 1, j + 1, k + 1)
    const x00 = a + (b - a) * fx
    const x10 = c + (d - c) * fx
    const x01 = e + (f - e) * fx
    const x11 = g + (l - g) * fx
    const y0 = x00 + (x10 - x00) * fy
    const y1 = x01 + (x11 - x01) * fy
    return y0 + (y1 - y0) * fz
  }

  /** Roughly -1..1. */
  at2(x, z) {
    const i = Math.floor(x), k = Math.floor(z)
    const fx = fade(x - i), fz = fade(z - k)
    const a = this._h(i, 0, k), b = this._h(i + 1, 0, k), c = this._h(i, 0, k + 1), d = this._h(i + 1, 0, k + 1)
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz
  }
}
