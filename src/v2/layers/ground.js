// ---------------------------------------------------------------------------
// GroundTint: a class grid over the world and a palette, read by the mesher as the base colour of a vertex -- §31 step C's "flat distinct ground colour per biome". Three-free, and absent from the shipped world: buildChunkV2 with no tint is bit-identical to before it existed.
//
// The grid is `size` x `size` over a `world`-metre box centred on the origin, one byte a texel indexing `palette` (linear RGB, three floats a class). The lookup is bilinear over the palette, so a border between two classes is an 8 m ramp at the coarse grid's own pitch rather than a stair.
// ---------------------------------------------------------------------------

export class GroundTint {
  constructor({ size, world, classes, palette }) {
    if (!Number.isInteger(size) || size < 2) throw new Error(`GroundTint: size must be an integer >= 2, got ${size}`)
    if (!(world > 0)) throw new Error(`GroundTint: world must be positive metres, got ${world}`)
    if (!(classes instanceof Uint8Array) || classes.length !== size * size) throw new Error(`GroundTint: classes must be a Uint8Array of ${size * size}, got ${classes?.length}`)
    if (!(palette instanceof Float32Array) || palette.length < 3 || palette.length % 3) throw new Error(`GroundTint: palette must be a Float32Array of 3 floats a class, got ${palette?.length}`)
    const count = palette.length / 3
    for (let c = 0; c < classes.length; c++) if (classes[c] >= count) throw new Error(`GroundTint: texel ${c} is class ${classes[c]} of ${count}`)
    this.size = size
    this.cell = world / (size - 1)
    this.half = world / 2
    this.classes = classes
    this.palette = palette
  }

  /** Linear RGB into `out[0..2]` at world (x, z). */
  tintAt(x, z, out) {
    const n = this.size
    const u = Math.max(0, Math.min(n - 1.001, (x + this.half) / this.cell))
    const v = Math.max(0, Math.min(n - 1.001, (z + this.half) / this.cell))
    const i = u | 0
    const j = v | 0
    const fu = u - i
    const fv = v - j
    const P = this.palette
    const c00 = this.classes[j * n + i] * 3
    const c10 = this.classes[j * n + i + 1] * 3
    const c01 = this.classes[(j + 1) * n + i] * 3
    const c11 = this.classes[(j + 1) * n + i + 1] * 3
    for (let k = 0; k < 3; k++) {
      const top = P[c00 + k] + (P[c10 + k] - P[c00 + k]) * fu
      const bot = P[c01 + k] + (P[c11 + k] - P[c01 + k]) * fu
      out[k] = top + (bot - top) * fv
    }
    return out
  }
}
