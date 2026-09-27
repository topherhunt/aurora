import { WORLD_SIZE, WORLD_HALF, CHUNK_RES } from '../v2/config.js'

// ---------------------------------------------------------------------------
// The elevation pyramid: one resident coarse base, fine detail paged as tiles -- §31.
//
// WHY THIS EXISTS. The 2 m field is 4097^2 Float32, 64 MB, and `terrain-v2.js`
// hands every mesh worker its own copy (`data.slice()`, and the argument for the
// copy there is correct). Three holders -- the main thread for collision plus two
// workers -- made the resident cost 192 MB of field and 48 MB of class grid, 240 MB
// for a height map, which a Quest browser tab cannot spend. Paged, the same three
// hold 6.1 MB each: check-v3 counts it.
//
// The observation that pays for it: at the LOD's own selection rule, 2 m data is
// only ever READ within a few hundred metres of the eye -- 334 m at the desktop
// knob, see pageRadius. `selectNodes` refines a node while
// `size / CHUNK_RES > range * tan(triDeg)`, so everything beyond `BASE_CELL/tan`
// draws cells of BASE_CELL or wider, where the coarse base is not an approximation
// of the fine field but an exact statement of everything the mesh can represent
// there. So the fine texels are worth holding over a disc around the eye and
// nowhere else: at most 16 tiles of the 1024, 1.1 MB of the 64 MB.
//
// THE TWO HALVES ARE THE SAME SURFACE AT TWO RESOLUTIONS, which is the whole
// invariant. `decimate` low-passes and subsamples the CARVED field -- after the
// hydrology, never before -- so a tile and the base agree about where the ground
// is to within what the filter removed, and what it removed lives at 8 m and
// below, which is exactly the band the mesh cannot draw outside the disc. Decimate
// the raw field instead and a river gorge would be 181 m deep inside the disc and
// absent outside it, and the ground would heave as tiles paged in.
//
// WHAT IS NOT HERE. No second bake, no separate detail encoding, no delta against
// a re-derived cone. A tile is a rectangle of the same metres the generator
// produced, cut out of it. That is the property that makes the scheme reasonable
// to hold in the head: there is one field, stored twice, at two pitches.
// ---------------------------------------------------------------------------

// Fine texels to a base texel. 4 takes the 2 m island's 4097^2 to 1025^2 at 8 m:
// 64 MB of resident field becomes 4.0 MB, and 8 m is the pitch `pageRadius`
// below is derived against. It is also exactly TEXELS_PER_NODE (island.js), which
// is not a coincidence worth leaning on -- that one is about which jitter rungs a
// grid can carry and this one about how much of the grid stays resident -- but it
// does mean the base carries the ladder down to 32 m unaliased.
export const DECIMATE = 4

/** Base texels for a fine grid of `n`. `(n - 1)` must divide by DECIMATE so both world edges survive. */
export const baseTexelsFor = (n) => (n - 1) / DECIMATE + 1

// Metres of world to a tile. 256 m at 2 m is a 129-texel square, 69.1 kB with its
// apron -- small enough that the resident set is noise (the disc below wants 16 of
// them at the desktop knob, 1.1 MB) and large enough that walking a straight line
// pages one in every 256 m rather than every 32.
export const TILE_M = 256

// Texels of overlap on each side of a tile. Two, because the widest read into the
// grid is a bicubic's 4x4 stencil (i-1 .. i+2), so a sample anywhere in the tile's
// own 129 texels finds every tap it needs inside the tile. Without the apron every
// tile boundary would fall back to the base mid-stencil and crease at 256 m
// intervals in both directions.
export const APRON = 2

// Fine texels per tile edge, and the stored square with its apron on both sides.
export const tileTexels = (cell) => Math.round(TILE_M / cell)
export const storedTexels = (cell) => tileTexels(cell) + 2 * APRON + 1

/**
 * How far from the eye fine texels can still be read, in metres.
 *
 * `reach = BASE_CELL / tan(triDeg)` is where the drawn cell reaches the base's own
 * pitch: refine while `size / CHUNK_RES > range * tan`, so a node whose range is
 * `reach` or more never splits below a base texel.
 *
 * THE PARENT'S DIAGONAL IS WHAT IS ADDED, and getting that wrong is what
 * check-v3's disc section caught. A node drawn at a sub-base cell `c` exists
 * because its PARENT refined, and the parent's cell is `2c <= BASE_CELL`, so the
 * test that admitted it read `range(parent) < BASE_CELL / tan = reach`. `range` is
 * measured to the parent's NEAREST corner, so every texel under that parent --
 * the far child's far corner included -- sits within `reach + diag(parent)`, and
 * the widest such parent is `BASE_CELL * CHUNK_RES` on a side. Bounding the child
 * instead understates the disc by half a parent diagonal, which shows up as a
 * chunk 300 m out reading the base on one side of a tile line and the fine texels
 * on the other: a crease, in the one place nobody is looking.
 *
 * Derived rather than written down, because it is a function of a live knob:
 * `LOD.triDeg` is 3.0 on the desktop route and 4.0 or coarser in XR, which is
 * 334 m and 295 m. A hardcoded radius would be correct until somebody moved the
 * knob and would then crack the ground quietly.
 */
export function pageRadius(triDeg, baseTexel) {
  if (!(triDeg > 0)) throw new Error(`pageRadius: triDeg must be positive degrees, got ${triDeg}`)
  if (!(baseTexel > 0)) throw new Error(`pageRadius: baseTexel must be positive metres, got ${baseTexel}`)
  const reach = baseTexel / Math.tan((triDeg * Math.PI) / 180)
  // The widest node that can refine to a sub-base cell: cells of baseTexel, so
  // baseTexel * CHUNK_RES on a side.
  const parent = baseTexel * CHUNK_RES
  return reach + Math.hypot(parent, parent)
}

/**
 * A bound on the resident tiles for a disc of this radius: what the memory claim is
 * made against. It is the enclosing SQUARE of tiles, so it over-counts the disc by
 * its corners -- 16 against the 14 `tilesWithin` actually asks for at the desktop
 * knob. Bounding rather than exact on purpose: the number a memory budget is checked
 * against should not move with where in a tile the eye happens to stand.
 */
export const tilesForRadius = (radius) => (Math.ceil((2 * radius) / TILE_M) + 1) ** 2

export const tileKey = (tx, tz) => `${tx},${tz}`

/** The tile indices a world point falls in. */
export const tileAt = (x, z) => [Math.floor((x + WORLD_HALF) / TILE_M), Math.floor((z + WORLD_HALF) / TILE_M)]

/**
 * The XZ box a tile's texels are read over, grown by `margin` metres.
 *
 * What the margin is for: a chunk's normals come from `gradientAt`, which steps a
 * base texel either side of the vertex, so a vertex just outside the box still
 * reads texels inside it. The caller passes the margin because the caller knows the
 * base pitch. Closed box rather than half-open, which is the right direction to err
 * for an invalidation rect.
 */
export function tileBox(key, margin = 0) {
  const [tx, tz] = key.split(',').map(Number)
  if (!Number.isInteger(tx) || !Number.isInteger(tz)) throw new Error(`tileBox: ${key} is not a tile key`)
  const minX = -WORLD_HALF + tx * TILE_M
  const minZ = -WORLD_HALF + tz * TILE_M
  return { minX: minX - margin, minZ: minZ - margin, maxX: minX + TILE_M + margin, maxZ: minZ + TILE_M + margin }
}

/** Tiles per axis over the world box. A 256 m tile over 8192 m is 32. */
export const tileCount = () => Math.round(WORLD_SIZE / TILE_M)

/**
 * Every tile key whose 256 m box comes within `radius` of (x, z), which is the
 * wanted set. Box distance and not centre distance, so a tile the disc only
 * clips a corner of is still wanted.
 */
export function tilesWithin(x, z, radius) {
  const n = tileCount()
  const lo = (v) => Math.max(0, Math.floor((v + WORLD_HALF - radius) / TILE_M))
  const hi = (v) => Math.min(n - 1, Math.floor((v + WORLD_HALF + radius) / TILE_M))
  const out = []
  for (let tz = lo(z); tz <= hi(z); tz++) {
    for (let tx = lo(x); tx <= hi(x); tx++) {
      // The nearest point of the tile's box to the eye.
      const bx = -WORLD_HALF + tx * TILE_M
      const bz = -WORLD_HALF + tz * TILE_M
      const dx = Math.max(bx - x, 0, x - (bx + TILE_M))
      const dz = Math.max(bz - z, 0, z - (bz + TILE_M))
      if (Math.hypot(dx, dz) <= radius) out.push(tileKey(tx, tz))
    }
  }
  return out
}

/**
 * The base field: `field` low-passed and subsampled by `factor`.
 *
 * REGISTRATION IS EXACT AND THAT IS THE POINT. Heightmap puts texel 0 on the
 * -X/-Z world corner and texel n-1 on the +X/+Z one, so coarse texel c has to land
 * on fine texel c * factor or the two grids describe ground offset from each other
 * by a fraction of a texel -- which reads as the whole island sliding as a tile
 * pages in. A box average over each factor x factor block would do exactly that,
 * shifting by (factor - 1) / 2 texels; a symmetric filter CENTRED on the kept
 * texel does not. Hence the binomial 5-tap [1 4 6 4 1] / 16, separable, run in
 * both axes with the same edge clamp `Heightmap._tap` uses. It is not the sharpest
 * antialias available and does not need to be: what it attenuates is the 8 m and
 * 16 m jitter rungs, whose amplitudes after the halving are 1 m and 2 m.
 *
 * `(n - 1)` must divide by `factor` so the coarse grid keeps both edges: 4097 and
 * 4 give 1025, edge to edge, nothing extrapolated.
 */
export function decimate(field, n, factor) {
  if (!(field instanceof Float32Array)) throw new Error('decimate: field must be a Float32Array of metres')
  if (field.length !== n * n) throw new Error(`decimate: field has ${field.length} texels, ${n}^2 needs ${n * n}`)
  if (!Number.isInteger(factor) || factor < 1) throw new Error(`decimate: factor must be a positive integer, got ${factor}`)
  if ((n - 1) % factor !== 0) throw new Error(`decimate: (${n} - 1) does not divide by ${factor}, so the coarse grid would lose an edge`)
  const m = (n - 1) / factor + 1
  if (factor === 1) return { data: Float32Array.from(field), n: m }

  const W = [1, 4, 6, 4, 1]
  const SUM = 16
  const clamp = (i) => (i < 0 ? 0 : i >= n ? n - 1 : i)

  // Horizontal pass into the coarse columns, full fine rows: m x n.
  const mid = new Float32Array(m * n)
  for (let j = 0; j < n; j++) {
    const row = j * n
    for (let c = 0; c < m; c++) {
      const i = c * factor
      let acc = 0
      for (let k = -2; k <= 2; k++) acc += W[k + 2] * field[row + clamp(i + k)]
      mid[j * m + c] = acc / SUM
    }
  }
  // Vertical pass onto the coarse rows.
  const out = new Float32Array(m * m)
  const clampJ = (j) => (j < 0 ? 0 : j >= n ? n - 1 : j)
  for (let r = 0; r < m; r++) {
    const j = r * factor
    for (let c = 0; c < m; c++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) acc += W[k + 2] * mid[clampJ(j + k) * m + c]
      out[r * m + c] = acc / SUM
    }
  }
  return { data: out, n: m }
}

/**
 * One tile cut out of the fine field: its own texels plus `APRON` on every side,
 * edge-clamped exactly as `Heightmap._tap` clamps, so the stored square is the
 * same size for every tile including the ones on the world edge. Uniform geometry
 * is worth a few duplicated texels at the border: the alternative is a per-tile
 * rect the sampler has to special-case, and the sampler is the hot path.
 */
export function cutTile(field, n, cell, tx, tz) {
  const T = tileTexels(cell)
  const S = storedTexels(cell)
  const i0 = tx * T - APRON
  const j0 = tz * T - APRON
  const out = new Float32Array(S * S)
  const clamp = (i) => (i < 0 ? 0 : i >= n ? n - 1 : i)
  for (let j = 0; j < S; j++) {
    const src = clamp(j0 + j) * n
    for (let i = 0; i < S; i++) out[j * S + i] = field[src + clamp(i0 + i)]
  }
  return out
}

/**
 * Every tile of the fine field, handed to `fn` one at a time.
 *
 * An iterator and not an array on purpose: the 1024 tiles of the 2 m island are
 * 72 MB together, and materialising them beside the 67 MB field they were cut from
 * would put the generate worker's peak at 140 MB to save memory at runtime. The
 * caller writes each one and lets it go.
 */
export function eachTile(field, n, cell, fn) {
  const count = tileCount()
  for (let tz = 0; tz < count; tz++) {
    for (let tx = 0; tx < count; tx++) fn({ key: tileKey(tx, tz), tx, tz, data: cutTile(field, n, cell, tx, tz) })
  }
  return count * count
}

/**
 * The class grid at the base pitch. NEAREST, not filtered: a class is a label and
 * the mean of `arctic` and `desert` is not a biome. Registration is the same
 * argument as `decimate`'s -- coarse texel c takes fine texel c * factor.
 *
 * Coarsening this is not a compromise. `GroundTint` reads the grid bilinearly over
 * the PALETTE, so its border is a ramp one texel wide; at 2 m that ramp is sharper
 * than the design ever asked for (the class itself is a quantile of the whole
 * island), and at 8 m it is the 8 m ramp ground.js describes.
 */
export function subsampleClasses(classes, n, factor) {
  if (!(classes instanceof Uint8Array)) throw new Error('subsampleClasses: classes must be a Uint8Array')
  if (classes.length !== n * n) throw new Error(`subsampleClasses: grid has ${classes.length} texels, ${n}^2 needs ${n * n}`)
  if ((n - 1) % factor !== 0) throw new Error(`subsampleClasses: (${n} - 1) does not divide by ${factor}`)
  const m = (n - 1) / factor + 1
  const out = new Uint8Array(m * m)
  for (let r = 0; r < m; r++) {
    const src = r * factor * n
    for (let c = 0; c < m; c++) out[r * m + c] = classes[src + c * factor]
  }
  return out
}

/**
 * The resident fine tiles, and the sampler over them.
 *
 * Attached to a `Heightmap` through `attachTiles`, which is the one choke point
 * every reader of the coarse field already goes through -- so collision, the
 * mesher, the scatter and the water all see the same surface, which is the
 * property `relief.js` exists to protect. A point no resident tile covers reads
 * NaN and the Heightmap falls back to the base; nothing here decides policy about
 * WHICH tiles are resident, because the main thread owns that (see `tilesWithin`).
 */
export class TileStore {
  constructor({ cell }) {
    if (!(cell > 0)) throw new Error(`TileStore: cell must be positive metres, got ${cell}`)
    this.cell = cell
    this.T = tileTexels(cell)
    this.S = storedTexels(cell)
    this.bytesPerTile = this.S * this.S * 4
    this.tiles = new Map()
  }

  put(key, data) {
    if (!(data instanceof Float32Array) || data.length !== this.S * this.S) {
      throw new Error(`TileStore.put: tile ${key} must be a Float32Array of ${this.S * this.S}, got ${data?.length}`)
    }
    this.tiles.set(key, data)
  }

  drop(key) {
    this.tiles.delete(key)
  }

  has(key) {
    return this.tiles.has(key)
  }

  get size() {
    return this.tiles.size
  }

  /** Resident bytes, for the panel's readout. */
  get bytes() {
    return this.tiles.size * this.bytesPerTile
  }

  /**
   * Bilinear over the fine texels, or NaN where no tile is resident.
   *
   * BILINEAR AND NOT BICUBIC, matching what `_attachReconstruction` puts the v3
   * route's coarse read on: a bicubic over a lattice sampled four texels to a node
   * rounds off the very rungs the 2 m grid was widened to carry. The apron is
   * sized for a bicubic anyway, so this can change without recutting the tiles.
   */
  sample(x, z) {
    const u = (x + WORLD_HALF) / this.cell
    const v = (z + WORLD_HALF) / this.cell
    const i = Math.floor(u)
    const j = Math.floor(v)
    const tile = this.tiles.get(tileKey(Math.floor(i / this.T), Math.floor(j / this.T)))
    if (tile === undefined) return NaN
    const S = this.S
    // Texel (i, j) sits at APRON + (i mod T) inside the stored square.
    const li = APRON + (i - Math.floor(i / this.T) * this.T)
    const lj = APRON + (j - Math.floor(j / this.T) * this.T)
    const o = lj * S + li
    const a = tile[o]
    const b = tile[o + 1]
    const c = tile[o + S]
    const d = tile[o + S + 1]
    const fx = u - i
    const fz = v - j
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz
  }
}
