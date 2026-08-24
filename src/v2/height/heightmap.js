import { WORLD_SIZE, WORLD_HALF } from '../config.js'
import { decodePng, encodePng, loadPng, readPng } from './png.js'

// ---------------------------------------------------------------------------
// The imported coarse field. §18 step 1 of the composed height field.
//
// This is the half of v2 that a human authored: an image, in metres, at a
// resolution that says nothing at all about what the ground does below one
// texel. Everything finer comes from detail.js. The single job here is to turn
// a grid of quantised samples back into a SMOOTH function of (x, z), and the
// interpolant is the whole design.
//
// Bicubic, not bilinear, and §18 is emphatic about why: bilinear is C0 but not
// C1, so the gradient jumps at every texel edge. Over an 8 m/texel image that
// puts a crease every 8 m, running the length of the world in both directions.
// v1 never saw it because its finest cell is 1 m and a 1 m triangle cannot
// resolve a crease. v2's finest cell is 6.25 cm (config.js MAX_DEPTH), and at
// 6.25 cm a slope discontinuity is a visible facet edge under a low sun -- the
// exact artifact the aurora and the low sun angles are there to show off.
// sampleBilinear() is kept so the gate can prove that claim rather than assert
// it; see scripts/check-v2-heightmap.mjs section "C1 continuity".
//
// Three-free and node-runnable, per Constraint 3 in DESIGN.md.
// ---------------------------------------------------------------------------

// GRID REGISTRATION. Texel (0, 0) sits exactly on the -X/-Z world corner and
// texel (width-1, height-1) exactly on the +X/+Z corner, so the spacing is
// WORLD_SIZE / (width - 1) and the image covers the world edge to edge with
// nothing extrapolated. The alternative -- WORLD_SIZE / width, texel i at the
// LOW corner of cell i -- leaves the last texel-width of world off the right
// and far edges, where sampling would silently fall back on the border clamp
// and flatten an 8 m strip along two sides of the map. At 1024 that makes the
// spacing 8.0078 m rather than a round 8; a hundredth of a percent of scale
// is a cheaper price than a flat edge, and make-heightmap.mjs renders on the
// same registration so the round trip is exact at every texel.
const step = (width) => WORLD_SIZE / (width - 1)

// Catmull-Rom through p1..p2 with p0/p3 as the tangent donors. The tangent at
// p1 is (p2 - p0)/2, shared by the segment on either side of p1, which is
// precisely the C1 property this class exists for.
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

// The constructor is private in the only way JS offers. Every path in has to
// go through fromDecoded/fromRaw/load/read, because those are where the meta block is
// validated and a heightmap built from an unvalidated meta is a world with
// silently wrong elevations rather than an error.
const INTERNAL = Symbol('Heightmap.internal')

export class Heightmap {
  constructor(token, field, width, height, meta) {
    if (token !== INTERNAL) throw new Error('Heightmap: use Heightmap.fromDecoded / .fromRaw / .load / .read, not new Heightmap()')
    this.width = width
    this.height = height
    this.meta = meta
    // Metres, row-major, texel (0,0) at -X/-Z. Float32 because the field is
    // read once per vertex per remesh and 4 MB at 1024^2 is already the largest
    // resident buffer in src/v2/height/.
    this.field = field
    this._stepX = step(width)
    this._stepZ = step(height)
    this._invX = 1 / this._stepX
    this._invZ = 1 / this._stepZ
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < field.length; i++) {
      const v = field[i]
      if (!Number.isFinite(v)) throw new Error(`Heightmap: non-finite height at index ${i}`)
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    this._min = lo
    this._max = hi
  }

  /** Metres per texel on X. Square images make this the same on both axes. */
  get texelSize() {
    return this._stepX
  }

  /**
   * How much taller than life this import is, as a ratio. 1 means the metres are
   * the terrain's own; 3 means the bake stretched them 3x for drama.
   *
   * Absent from the meta reads as 1, on the same footing as an absent `encoding`
   * reading as 'gray': a bare image that never claimed to be stretched is not
   * stretched, and that is the only reading available. scripts/make-heightmap.mjs
   * always writes it -- see NATURAL_MAX_Y there for what the number means.
   *
   * The one consumer is calibrateRough in detail.js, which divides the
   * procedural detail's amplitude by it so that exaggerating the mountains does
   * not exaggerate the gravel. Nothing here scales by it: the field really is in
   * these metres and the player really does climb them.
   */
  get exaggeration() {
    const e = this.meta?.exaggeration
    if (e === undefined) return 1
    if (!Number.isFinite(e) || !(e > 0)) throw new Error(`Heightmap: meta.exaggeration must be a finite ratio > 0, got ${e}`)
    return e
  }

  /** Actual decoded extremes in metres -- not meta.minY/maxY, which are the encoding's range. */
  get min() {
    return this._min
  }

  get max() {
    return this._max
  }

  /**
   * The pure entry point: decoded PNG plus its meta block, no I/O.
   *
   * meta = { world, minY, maxY, encoding } where encoding is
   *   'gray'  -- channel 0 over its full range (255 or 65535) is 0..1
   *   'rg16'  -- R is the high byte and G the low byte of a 16-bit value, which
   *              is how an 8-bit RGB PNG carries 16 bits of height exactly.
   *
   * There is no guessing. An absent encoding means 'gray' on channel 0, which
   * is the only reading a bare image supports; 'rg16' is used when and only
   * when the meta says so, and then the image had better have two channels.
   */
  static fromDecoded(png, meta) {
    if (!meta) throw new Error('Heightmap: no meta -- height.json carries minY/maxY/encoding and the metres are unrecoverable without it')
    if (!Number.isFinite(meta.minY) || !Number.isFinite(meta.maxY)) throw new Error(`Heightmap: meta.minY/maxY must be finite metres, got ${meta.minY}/${meta.maxY}`)
    if (meta.maxY <= meta.minY) throw new Error(`Heightmap: meta range is empty or inverted (${meta.minY}..${meta.maxY})`)
    if (Number.isFinite(meta.world) && meta.world !== WORLD_SIZE) {
      throw new Error(`Heightmap: meta.world ${meta.world} m does not match config WORLD_SIZE ${WORLD_SIZE} m`)
    }

    const encoding = meta.encoding === undefined ? 'gray' : meta.encoding
    if (encoding !== 'gray' && encoding !== 'rg16') throw new Error(`Heightmap: unknown encoding '${encoding}' (expected 'gray' or 'rg16')`)
    if (encoding === 'rg16' && png.channels < 2) throw new Error(`Heightmap: encoding rg16 needs 2 channels, image has ${png.channels}`)

    const { width, height, channels, depth, data } = png
    const span = meta.maxY - meta.minY
    const field = new Float32Array(width * height)
    if (encoding === 'rg16') {
      // 65535 and not 65536: a full-white pixel has to land exactly on maxY, or
      // the top of every mountain is one quantum low and the gate's round-trip
      // error is biased instead of centred.
      const k = span / 65535
      for (let i = 0, o = 0; i < field.length; i++, o += channels) {
        field[i] = meta.minY + (data[o] * 256 + data[o + 1]) * k
      }
    } else {
      const k = span / (depth === 16 ? 65535 : 255)
      for (let i = 0, o = 0; i < field.length; i++, o += channels) {
        field[i] = meta.minY + data[o] * k
      }
    }
    return new Heightmap(INTERNAL, field, width, height, meta)
  }

  /** Browser. */
  static async load({ url, metaUrl }) {
    const metaRes = await fetch(metaUrl)
    if (!metaRes.ok) throw new Error(`Heightmap: ${metaRes.status} fetching ${metaUrl}`)
    const meta = await metaRes.json()
    return Heightmap.fromDecoded(await loadPng(url), meta)
  }

  /** Node -- the gate's path, and make-heightmap.mjs's own verification path. */
  static async read({ path, metaPath }) {
    const { readFile } = await import(/* @vite-ignore */ 'node:fs/promises')
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    return Heightmap.fromDecoded(await readPng(path), meta)
  }

  /**
   * The decoded field, ready to hand to postMessage as a transfer.
   *
   * `data` is THIS heightmap's own Float32Array, not a copy -- transferring it
   * neuters this instance's buffer, which is correct on the main thread (the
   * renderer never samples the coarse field; the worker does) and is why the
   * pair is toRaw/fromRaw rather than a clone. The main thread decodes the PNG
   * once and the worker receives metres.
   */
  toRaw() {
    return { width: this.width, height: this.height, data: this.field, meta: this.meta }
  }

  /**
   * Rebuild from what toRaw produced, with NO PNG decode.
   *
   * The worker cannot fetch and decode the image itself without either shipping
   * a second copy over the wire or blocking its own startup on a 2.3 MB parse,
   * so the main thread does it once and transfers the result. Validation is the
   * same as fromDecoded's -- the world-size check especially, because a raw
   * buffer carries no evidence of the box it was baked for and a heightmap built
   * for a different WORLD_SIZE is a world with silently wrong elevations rather
   * than an error.
   */
  static fromRaw({ width, height, data, meta }) {
    if (!meta) throw new Error('Heightmap.fromRaw: no meta -- the metres are unrecoverable without it')
    if (Number.isFinite(meta.world) && meta.world !== WORLD_SIZE) {
      throw new Error(`Heightmap.fromRaw: meta.world ${meta.world} m does not match config WORLD_SIZE ${WORLD_SIZE} m`)
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
      throw new Error(`Heightmap.fromRaw: bad dimensions ${width}x${height}`)
    }
    if (!(data instanceof Float32Array)) throw new Error('Heightmap.fromRaw: data must be a Float32Array of metres, as produced by toRaw')
    if (data.length !== width * height) throw new Error(`Heightmap.fromRaw: data has ${data.length} texels, ${width}x${height} needs ${width * height}`)
    return new Heightmap(INTERNAL, data, width, height, meta)
  }

  /**
   * Write a rect of metres back into the field. The terrain brush's path into a
   * worker, which holds its own copy and never sees the brush.
   *
   * `data` is row-major and tightly packed for the rect, as sculpt.js readRect
   * produces. Bounds are checked rather than trusted: this arrives over
   * postMessage, and a rect one row off writes a diagonal smear across the
   * continent that nothing would report.
   *
   * The extremes are WIDENED, not recomputed -- a full pass over a million
   * texels per patch would be the most expensive thing in a drag, and the only
   * consumer is V2Height.bands, whose percentile histogram is bucketed over
   * min..max. A max left too high after digging a mountain down costs a few
   * empty buckets at the top of that histogram and nothing else; the next load
   * measures it exactly.
   */
  patch(rect, data) {
    const { i0, j0, i1, j1 } = rect
    if (!Number.isInteger(i0) || !Number.isInteger(j0) || !Number.isInteger(i1) || !Number.isInteger(j1)) {
      throw new Error(`Heightmap.patch: rect must be integer texel indices, got ${JSON.stringify(rect)}`)
    }
    if (i0 < 0 || j0 < 0 || i1 > this.width || j1 > this.height || i1 <= i0 || j1 <= j0) {
      throw new Error(`Heightmap.patch: rect ${JSON.stringify(rect)} is outside 0..${this.width}/0..${this.height} or empty`)
    }
    const w = i1 - i0
    if (data.length !== w * (j1 - j0)) {
      throw new Error(`Heightmap.patch: data has ${data.length} texels, rect ${w}x${j1 - j0} needs ${w * (j1 - j0)}`)
    }
    for (let j = j0, o = 0; j < j1; j++, o += w) {
      for (let i = 0; i < w; i++) {
        const v = data[o + i]
        if (!Number.isFinite(v)) throw new Error(`Heightmap.patch: non-finite height at texel ${i0 + i},${j}`)
        this.field[j * this.width + i0 + i] = v
        if (v < this._min) this._min = v
        if (v > this._max) this._max = v
      }
    }
  }

  /**
   * The field as PNG bytes, in the encoding it was loaded in. The inverse of
   * fromDecoded, and the reason the terrain brush can write its work back to
   * public/world/height.png rather than living in a browser tab.
   *
   * rg16 only. A 'gray' import carries 8 bits and re-encoding a sculpted field
   * through it would quietly throw away everything below one source level --
   * 3.5 m of cliff at the shipped range -- so it refuses instead.
   */
  async toPng() {
    if (this.meta.encoding !== 'rg16') {
      throw new Error(`Heightmap.toPng: encoding '${this.meta.encoding ?? 'gray'}' cannot round-trip a sculpt without losing the low byte -- only rg16 is written`)
    }
    const span = this.meta.maxY - this.meta.minY
    const k = 65535 / span
    const px = new Uint8Array(this.field.length * 3)
    for (let i = 0; i < this.field.length; i++) {
      let q = Math.round((this.field[i] - this.meta.minY) * k)
      if (q < 0) q = 0
      else if (q > 65535) q = 65535
      const high = q >> 8
      px[i * 3] = high
      px[i * 3 + 1] = q & 0xff
      // B repeats the high byte so R and B carry a legible 8-bit grayscale of
      // the terrain, matching what make-heightmap.mjs writes.
      px[i * 3 + 2] = high
    }
    return encodePng(this.width, this.height, px)
  }

  /** Border clamp -- edge-extend, never wrap. A wrapped tap would fold the far side of the world into the near one. */
  _tap(i, j) {
    const ci = i < 0 ? 0 : i >= this.width ? this.width - 1 : i
    const cj = j < 0 ? 0 : j >= this.height ? this.height - 1 : j
    return this.field[cj * this.width + ci]
  }

  /** Bicubic (Catmull-Rom). World metres in, metres out. This is the coarse term of V2Height. */
  sample(x, z) {
    const u = (x + WORLD_HALF) * this._invX
    const v = (z + WORLD_HALF) * this._invZ
    const i = Math.floor(u)
    const j = Math.floor(v)
    const fx = u - i
    const fz = v - j
    const r0 = catmull(this._tap(i - 1, j - 1), this._tap(i, j - 1), this._tap(i + 1, j - 1), this._tap(i + 2, j - 1), fx)
    const r1 = catmull(this._tap(i - 1, j), this._tap(i, j), this._tap(i + 1, j), this._tap(i + 2, j), fx)
    const r2 = catmull(this._tap(i - 1, j + 1), this._tap(i, j + 1), this._tap(i + 1, j + 1), this._tap(i + 2, j + 1), fx)
    const r3 = catmull(this._tap(i - 1, j + 2), this._tap(i, j + 2), this._tap(i + 1, j + 2), this._tap(i + 2, j + 2), fx)
    return catmull(r0, r1, r2, r3, fz)
  }

  /**
   * NOT the field. This exists so the gate can show that bilinear's first
   * derivative jumps at a texel edge and sample()'s does not -- a C1 assertion
   * that only ever passes proves nothing, so the check needs something it knows
   * should fail. Nothing in the runtime path may call this.
   */
  sampleBilinear(x, z) {
    const u = (x + WORLD_HALF) * this._invX
    const v = (z + WORLD_HALF) * this._invZ
    const i = Math.floor(u)
    const j = Math.floor(v)
    const fx = u - i
    const fz = v - j
    const a = this._tap(i, j)
    const b = this._tap(i + 1, j)
    const c = this._tap(i, j + 1)
    const d = this._tap(i + 1, j + 1)
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz
  }

  /**
   * Steepness of the COARSE field alone, 0..1, for detail.js to modulate
   * amplitude with (§18: steep ground is rockier). Central difference at one
   * texel spacing, which is the finest thing this grid can honestly answer --
   * a tighter stencil would just resample the same cubic and report its
   * curvature as terrain.
   *
   * The mapping is g / (1 + g) on the gradient magnitude g = |dh/dxz|, i.e. the
   * tangent of the steepest slope: flat -> 0, 45 degrees (g = 1) -> 0.5, and it
   * approaches 1 asymptotically instead of clipping, so a cliff and a very
   * steep slope stay distinguishable rather than both saturating.
   */
  slopeAt(x, z) {
    const e = this._stepX
    const gx = (this.sample(x + e, z) - this.sample(x - e, z)) / (2 * e)
    const gz = (this.sample(x, z + e) - this.sample(x, z - e)) / (2 * e)
    const g = Math.hypot(gx, gz)
    return g / (1 + g)
  }
}

// Re-exported so a caller with bytes already in hand (a worker that was handed
// an ArrayBuffer, say) does not have to import png.js separately.
export { decodePng }
