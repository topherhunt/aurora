import { Detail, calibrateRough, KNEE_TEXELS } from './detail.js'

// ---------------------------------------------------------------------------
// V2Height -- the composed height field (§18). The one function the mesher, the
// player, the prop scatter and the editor's raycast all read.
//
// Three-free and node-runnable.
//
// EVALUATION ORDER, and it is an order and not a set:
//
//   1. coarse   Heightmap.sample -- bicubic over the imported image
//   2. detail   + Detail.at -- band-limited fractal, modulated by the coarse slope
//   3. rivers   carve. Channels cut through whatever is there.
//   4. lakes    basin carve, for lakes with `carve` set
//   5. roads    smooth. LAST, and that is the whole point of stating an order:
//               a road crossing a river has to read as a CAUSEWAY. Run the road
//               first and the river then cuts its channel straight through the
//               carriageway, which draws a ford where the author drew a bridge.
//               Steps 3 to 5 live in Layers.carve, in that order, so there is
//               exactly one place that can get it wrong.
//
// `cell` band-limits step 2 and NOTHING ELSE. Collision, picking and the editor
// pass cell = 0 and get the exact field; the mesher passes its own cell size and
// gets a version of that field with the octaves its triangles cannot resolve
// faded out. This is why the player never falls through a coarse chunk: the
// ground she collides against is the cell = 0 field, which is the LIMIT of every
// band-limited version rather than a different function, so a coarse chunk drawn
// under her feet is a low-pass image of exactly the surface she is standing on
// and the error is bounded by the octaves that were faded, not by a mismatch
// between two independent evaluations.
//
// TWO SLOPE CONVENTIONS LIVE IN THIS REPO AND THEY ARE DIFFERENT NUMBERS. Read
// the one-line note on slopeAt and on slope01At before calling either. Getting
// them crossed does not throw anywhere -- it silently blocks the player on flat
// ground or lets her walk up a cliff -- so the gate asserts the units on a plane
// of known inclination rather than trusting these comments.
// ---------------------------------------------------------------------------

// Percentile anchors for the vertex-colour altitude ramp. The BAND is chosen
// here; the METRES are measured off whatever image is loaded, in _bands below.
//
// p25 to p90 rather than min to max because both tails are outliers by
// construction: the lowest quarter of an eroded landmass is one flat basin
// floor, and the top few percent is a handful of summits. Anchoring on the
// extremes would spend the entire ramp on ground almost nobody stands on and
// leave the inhabited middle a single flat colour.
const ALT_LO_P = 0.25
const ALT_HI_P = 0.90

// Histogram bins for the percentile pass. Over a ~300 m relief this resolves the
// ramp anchors to ~4 cm, which is far finer than a vertex colour can show, and
// it is one linear pass over the texel array instead of sorting a million floats.
const HIST_BINS = 8192

// THE DETAIL SEED, and it lives here because there is nowhere else it can.
//
// The worker's init message carries { heightmap, doc, epoch } and no seed -- the
// protocol is fixed by the renderer side. But the worker and the main thread each
// construct their own V2Height, and if those two disagree about the seed then the
// terrain she is DRAWN standing on and the terrain she COLLIDES with are two
// different fields that differ by metres at every point. Nothing would throw; she
// would simply hover, or sink, depending on the octave phase.
//
// So the seed is a shared module constant rather than a message field, and the
// default is the point: neither side has to remember to pass it. The gate passes
// an explicit one to check that two instances built from the same seed agree and
// that the seed is actually wired to the octave offsets.
export const WORLD_SEED = 20260824

export class V2Height {
  constructor({ heightmap, layers, seed = WORLD_SEED, rough }) {
    if (!heightmap) throw new Error('V2Height: heightmap is required')
    if (!layers) throw new Error('V2Height: layers is required -- pass a default Layers, not null; the carve chain is skipped by the authored flag, not by a null check')
    if (!Number.isFinite(seed)) throw new Error(`V2Height: seed must be a finite number, got ${seed}`)

    this.heightmap = heightmap
    this.layers = layers
    this.seed = seed

    // THE DETAIL TERM IS MEASURED AGAINST THE IMPORT, NOT CONFIGURED.
    //
    // Both of its scales come from the loaded image: the knee from its texel
    // size, the amplitude from its own structure function. §18 asks for a tuned
    // ROUGH constant; a constant is wrong here, because the import is the thing
    // v2 exists to let a human replace, and it was replaced twice during this
    // build alone -- 16 km at 16 m texels, then 4 km at 4 m, then 8 km at 8 m.
    // A literal fitted to any one of those would still have looked like a
    // plausible number under the next. See calibrateRough for the basis.
    //
    // Measured against the import's UNEXAGGERATED relief: the bake declares how
    // far it stretched the image (height.json `exaggeration`) and calibrateRough
    // divides that back out, so raising MAX_Y makes the mountains taller without
    // making the gravel coarser. That divide is the one deliberate break in the
    // spectral-continuity argument and its reasoning lives at calibrateRough.
    //
    // `rough` may be passed to pin the calibration, which check-v2-field uses to
    // hold the octave table still while it measures something else. Nothing at
    // runtime passes it.
    const knee = heightmap.texelSize * KNEE_TEXELS
    if (Number.isFinite(rough)) {
      this.calibration = { rough, pinned: true }
    } else {
      this.calibration = calibrateRough({ heightmap, seed, knee })
      this.calibration.pinned = false
    }
    this.detail = new Detail({ seed, knee, rough: this.calibration.rough })

    this._bands = null

    // THE EMPTY-DOCUMENT FAST PATH.
    //
    // An unedited v2 world is the common case and it must cost exactly one
    // branch, not a walk through three spatial indexes per vertex. `_authored`
    // is "does any layer change the GEOMETRY here" -- lakes and paths, not snow
    // points, because a snow point moves vertex colours and never a vertex.
    //
    // Recomputed when the epoch moves rather than on every mutation, so nothing
    // has to remember to invalidate it: Layers bumps epoch on every commit, and
    // an integer compare per query is cheaper than the Map lookups it replaces.
    // check-v2-field's "empty-document fast path" section counts layer calls
    // through a spy to prove the branch is real.
    this._epoch = -1
    this._authored = false
    this._syncAuthored()
  }

  _syncAuthored() {
    this._epoch = this.layers.epoch
    this._authored = this.layers.lakes.count > 0 || this.layers.paths.count > 0
  }

  /**
   * Swap in a freshly deserialized document. Use this rather than assigning
   * `.layers`, and the reason is a trap rather than a style preference: the fast
   * path's cache is keyed on `layers.epoch`, but a NEW Layers always starts at
   * epoch 0, so replacing an empty epoch-0 document with an authored epoch-0
   * document leaves the compare equal and the cached `_authored = false` intact.
   * The carve chain then never runs and every river the author just drew is
   * invisible until some later edit happens to bump the epoch past the old value.
   */
  setLayers(layers) {
    if (!layers) throw new Error('V2Height.setLayers: layers is required')
    this.layers = layers
    this._syncAuthored()
  }

  /** True when at least one lake or path exists, i.e. when the carve chain can do anything. */
  get authored() {
    if (this.layers.epoch !== this._epoch) this._syncAuthored()
    return this._authored
  }

  /**
   * The altitude ramp's anchors, in metres, measured off the loaded image.
   *
   * DERIVED, NEVER A LITERAL, and that is the single most load-bearing decision
   * in this file's shading contract. v1's chunk-mesh.js hardcodes (h - 107) / 100
   * and its own comment records that a stale band silently put snow nowhere
   * twice. The failure mode is not a crash: it is a world that renders, and is
   * uniformly the wrong colour, and nobody can say why. The vertical range of a
   * v2 world is whatever make-heightmap.mjs chose for that import, so the ramp
   * has to follow it.
   *
   * Measured on the COARSE texels rather than by sweeping the composed field:
   * the detail term is metres of local roughness against a ramp spanning a
   * hundred-odd metres, so it cannot move a percentile, and a histogram over the
   * texel array already in memory is one pass instead of a quarter of a million
   * bicubic evaluations. Computed lazily and cached -- the mesher wants it, the
   * player never does.
   */
  get bands() {
    if (this._bands) return this._bands
    const hm = this.heightmap
    const field = hm.field
    const min = hm.min
    const max = hm.max
    if (!(max > min)) throw new Error(`V2Height.bands: heightmap has no relief (min ${min}, max ${max}) -- there is nothing to ramp over`)

    const bins = new Int32Array(HIST_BINS)
    const scale = (HIST_BINS - 1) / (max - min)
    for (let i = 0; i < field.length; i++) bins[Math.round((field[i] - min) * scale)]++

    const total = field.length
    const at = (p) => {
      const want = p * (total - 1)
      let seen = 0
      for (let b = 0; b < HIST_BINS; b++) {
        seen += bins[b]
        if (seen > want) return min + b / scale
      }
      return max
    }
    const lo = at(ALT_LO_P)
    const hi = at(ALT_HI_P)
    if (!(hi > lo)) throw new Error(`V2Height.bands: altitude ramp is degenerate (p${ALT_LO_P * 100} ${lo}, p${ALT_HI_P * 100} ${hi}) -- more than 65% of the world sits at one elevation`)

    this._bands = {
      min,
      max,
      p10: at(0.10),
      p25: at(0.25),
      p50: at(0.50),
      p75: at(0.75),
      p90: at(0.90),
      p99: at(0.99),
      altLo: lo,
      altSpan: hi - lo,
    }
    return this._bands
  }

  /**
   * Coarse plus detail, WITHOUT the carve chain.
   *
   * Public because the mesher needs it: a chunk whose AABB no authored element
   * reaches is culled once, up front, and then every one of its 361 samples
   * takes this path instead of asking three spatial indexes the same question
   * 361 times over. That per-chunk cull is §18's headline performance claim and
   * this method is the half of it that lives here.
   */
  baseAt(x, z, cell = 0) {
    const hm = this.heightmap
    return hm.sample(x, z) + this.detail.at(x, z, cell, hm.slopeAt(x, z), 0)
  }

  /** The composed field. `cell` is the sampling spacing in metres; 0 is exact and is the default, because Player and the editor call this with two arguments. */
  heightAt(x, z, cell = 0) {
    if (this.layers.epoch !== this._epoch) this._syncAuthored()
    const hm = this.heightmap
    if (!this._authored) {
      // flattenAt would be 0 everywhere and carve() the identity, so both are
      // skipped outright rather than called and thrown away.
      return hm.sample(x, z) + this.detail.at(x, z, cell, hm.slopeAt(x, z), 0)
    }
    const layers = this.layers
    const h = hm.sample(x, z) + this.detail.at(x, z, cell, hm.slopeAt(x, z), layers.flattenAt(x, z))
    return layers.carve(x, z, h)
  }

  /** Elevation at which snow starts here. Pass-through; the baked grid lives in Layers. */
  snowLineAt(x, z) {
    return this.layers.snowLineAt(x, z)
  }

  /**
   * Surface normal by central difference, signature-compatible with v1's
   * TerrainHeight.normalAt so src/player.js can hold either.
   *
   * eps defaults to 0.75 for the same reason it does in v1 -- half of
   * LOCOMOTION.stride, so what the collision normal reports and what the slope
   * limiter refuses are measured over the same 1.5 m of ground. Note that this
   * reads the EXACT field (cell = 0) on all four taps: a normal taken from the
   * band-limited field would change under her as chunks swapped LOD.
   */
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

  /**
   * SLOPE IN RADIANS, off the COMPOSED field. This is v1 TerrainHeight.slopeAt's
   * convention and it is the one src/player.js consumes -- it compares the result
   * against LOCOMOTION.maxSlopeDeg * PI / 180 at two call sites, so anything else
   * returned here blocks her on flat ground or walks her up a cliff, silently.
   *
   * Composed rather than coarse because she walks on the composed field: a river
   * bank cut by the carve chain is a real wall to her, and a coarse-only slope
   * would not know it was there.
   */
  slopeAt(x, z, eps = 0.75) {
    const n = this.normalAt(x, z, eps)
    return Math.acos(Math.min(1, n.y))
  }

  /**
   * SLOPE AS 0..1, off the COARSE field, via g / (1 + g) with 45 degrees at 0.5.
   * This is Heightmap.slopeAt's convention and the one detail.js's amplitude
   * modulation consumes. Deliberately a different NAME from slopeAt because it is
   * a different number: at 45 degrees this returns 0.5 and slopeAt returns 0.785.
   *
   * Exposed so callers that want the shading-side quantity do not reach past this
   * class into the heightmap and pick up whichever convention they meet first.
   */
  slope01At(x, z) {
    return this.heightmap.slopeAt(x, z)
  }

  /**
   * Height plus the TANGENT of the slope, from the same five samples, for prop
   * scatter -- which asks both questions about the same point tens of thousands
   * of times per rebuild. Shape matches v1's, `{ h, tan }`, so scatter.js does
   * not have to know which world it is placing trees on. A third convention, and
   * it is a tangent because that is what scatter compares against; see slopeAt.
   *
   * Unlike v1's, this one is exact rather than a documented approximation: v1
   * skips its scarp term here and argues the skip is safe on ground a prop can
   * stand on. There is no scarp in v2, so `h` is simply heightAt.
   */
  heightAndSlopeAt(x, z) {
    const e = 0.75
    const h = this.heightAt(x, z)
    const xm = this.heightAt(x - e, z)
    const xp = this.heightAt(x + e, z)
    const zm = this.heightAt(x, z - e)
    const zp = this.heightAt(x, z + e)
    const d = 2 * e
    return { h, tan: Math.hypot((xp - xm) / d, (zp - zm) / d) }
  }
}
