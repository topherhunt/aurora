import { Detail, calibrateRough, KNEE_TEXELS, EXPOSURE_SWING } from './detail.js'
import { Heightmap } from './heightmap.js'
import { ExposureField } from './exposure.js'
import { RidgeField } from './ridge.js'
import { Crag } from './crag.js'
import { CreaseField } from './crease.js'
import { thermalErode } from './erode.js'
import { RELIEF_DEFAULTS, normalizeRelief, reliefNeeds, sameRelief } from './relief.js'

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
  constructor({ heightmap, layers, seed = WORLD_SEED, rough, relief = RELIEF_DEFAULTS }) {
    if (!heightmap) throw new Error('V2Height: heightmap is required')
    if (!layers) throw new Error('V2Height: layers is required -- pass a default Layers, not null; the carve chain is skipped by the authored flag, not by a null check')
    if (!Number.isFinite(seed)) throw new Error(`V2Height: seed must be a finite number, got ${seed}`)

    // `heightmap` stays THE IMPORT, for the whole life of this object. The
    // sculpt brush writes into it, Heightmap.toPng reads it back out, and the
    // undo stack holds rects of it -- all three are about the field a human
    // authored. `ground` is the field the world is actually built on, which is
    // the same object unless erosion is on. Everything below samples `ground`.
    this.heightmap = heightmap
    this.ground = heightmap
    this.layers = layers
    this.seed = seed
    this._pinnedRough = Number.isFinite(rough) ? rough : null
    this.relief = normalizeRelief(relief)

    // One scratch gradient, reused. gradientAt is called once per field
    // evaluation on a path that runs tens of millions of times per remesh, and
    // an object literal per call is an object literal per vertex.
    this._grad = { dx: 0, dz: 0, slope01: 0 }

    this._rebuild()

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

    // THE ABLATION FLOOR. Non-null replaces the whole composed field with one
    // constant height and zero slope, everywhere. See setFlat.
    this.flatY = null
  }

  /**
   * Replace the world with a level plane at `y` metres, or `null` to restore it.
   *
   * AN ABLATION TOOL, and specifically the one the Quest route needs: every
   * scatter in v2 places itself by asking this object for a height and a slope,
   * so a flat answer here puts the whole prop world onto one plane WITHOUT any
   * of them knowing they are being tested. That is the only way to ask "is the
   * grass expensive, or is standing the grass on a streaming LOD terrain
   * expensive" and get a clean answer -- and it is why this lives here rather
   * than as a flag threaded through eight scatters.
   *
   * IT DOES NOT MOVE ANYTHING ALREADY PLACED. A prop's y is read once, when it
   * is put down; the caller has to re-place every layer after flipping this, the
   * same way onRelief does when the ground moves under it.
   *
   * SLOPE GOES TO ZERO WITH IT, not just height. Half the scatters reject a site
   * on `tan` before they ever look at the height, so a flat field with the
   * import's slopes still in it would grass a plane in exactly the imported
   * mountain's pattern -- which is the confusing half-answer this exists to
   * avoid.
   */
  setFlat(y) {
    if (y !== null && !Number.isFinite(y)) throw new Error(`V2Height.setFlat: y must be a finite number or null, got ${y}`)
    this.flatY = y
  }

  /**
   * Build (or rebuild) everything derived from the import and the relief knobs.
   *
   * ORDER IS FORCED and every step depends on the one above it:
   *
   *   1. erode      relaxes the import toward the repose angle, producing the
   *                 field the world is actually built on
   *   2. exposure   convexity, measured on THAT field -- measure it on the
   *                 import instead and the crag band decorates ground the
   *                 erosion has already moved
   *   3. calibrate  the detail amplitude, measured on that field and THROUGH
   *                 the sharpen curve and the exposure gain
   *   4. detail     the octave table the calibration just sized
   *   5. crag       the crease band, which reads exposure and the fall line
   *   6. ridge      the directed crease, whose axes are the Hessian of THAT
   *                 field -- eroded ground has different spines from the import
   *
   * Called from the constructor and from setRelief, and it is the same code
   * both times on purpose: a relief change has to leave this object in the state
   * it would have been constructed in, or a knob would behave differently
   * depending on whether it was on at boot.
   */
  _rebuild() {
    const seed = this.seed
    const relief = this.relief
    const needs = reliefNeeds(relief)
    this.needs = needs

    // 1. EROSION. A copy, never in place: the import has to survive so the
    // brush, the PNG writer and the undo stack are all still talking about the
    // field the human authored, and so the knob is reversible.
    if (needs.erode) {
      const src = this.heightmap
      const eroded = thermalErode(src.field, src.width, src.height, src.texelSize, {
        passes: relief.erode,
        talusDeg: relief.talus,
      })
      this.ground = Heightmap.fromRaw({ width: src.width, height: src.height, data: eroded, meta: src.meta })
    } else {
      this.ground = this.heightmap
    }

    const ground = this.ground
    this.exposure = needs.exposure ? new ExposureField(ground) : null

    // THE SHIPPED PATH, kept as a literal branch rather than as an emergent
    // property. `sharpen` lives inside Detail's octave loop and `erode` lives in
    // `ground`, so neither needs the composed expression; only the two terms
    // that read convexity do. When both are off, every sampler below runs the
    // exact expression it ran before this file learned the word relief -- so
    // "all knobs off is bit-identical" is something you can read rather than
    // something you have to trust the arithmetic for. Note it is NOT keyed on
    // `this.exposure` existing: crest and snowJag bake the grid without wanting
    // anything from the geometry path.
    this._plain = !(relief.exposure > 0 || relief.crag > 0 || relief.bare > 0 || relief.ridge > 0 || relief.shatter > 0)

    // 2. THE DETAIL TERM IS MEASURED AGAINST THE IMPORT, NOT CONFIGURED.
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
    const knee = ground.texelSize * KNEE_TEXELS
    const exposureGain = needs.exposure && relief.exposure > 0 ? (x, z) => this._exposureGain(x, z) : null
    if (this._pinnedRough !== null) {
      this.calibration = { rough: this._pinnedRough, pinned: true }
    } else {
      this.calibration = calibrateRough({ heightmap: ground, seed, knee, sharpen: relief.sharpen, exposureGain })
      this.calibration.pinned = false
    }
    this.detail = new Detail({ seed, knee, rough: this.calibration.rough, sharpen: relief.sharpen })
    this.crag = needs.crag ? new Crag({ seed }) : null
    // Baked against `ground` for the same reason exposure is: the spines this
    // describes have to be the spines of the mountain the world is sampled from,
    // and with `erode` up that is the relaxed copy and not the import.
    this.ridge = needs.ridge ? new RidgeField(ground, { seed }) : null

    // 3. CREASE, and it goes LAST on purpose.
    //
    // It is not a term in `_micro` -- it replaces the coarse reconstruction
    // itself, inside Heightmap.sample, so it reaches the mesher, the collision,
    // the scatter and the raycast through the one call they all already make.
    // That also means it works in the `_plain` path above without appearing in
    // it: `_plain` is about the micro stack, and this knob does not touch the
    // micro stack.
    //
    // ATTACHED AFTER EVERYTHING BAKED FROM `ground` IS BUILT, which is the whole
    // reason this sits at the bottom of the function. calibrateRough fits the
    // detail amplitude to the ground's own structure function; a creased surface
    // has more energy at texel scale, so calibrating against it would pull
    // `rough` down and change the detail term over the ENTIRE world -- flat
    // valley floors included -- in response to a knob whose whole claim is that
    // it only touches crests. Exposure and ridge bake from `ground` for their
    // own reasons and get the same treatment. Built last, the knob does exactly
    // what it says and nothing at a distance.
    //
    // AND IT IS ATTACHED TO A VIEW, NEVER TO THE IMPORT. With `erode` off
    // `ground === this.heightmap`, and that object is shared by reference with
    // every other V2Height reading the same import -- the gate builds a dozen,
    // and the editor holds one beside the live world. Attaching here directly
    // means the last field constructed decides what all the others are standing
    // on: measured, three fields built in a row all came out creased and a
    // sibling's calibrateRough was fitted to a surface its own knob had switched
    // off. `view()` shares the texels and owns the operator, so a knob can only
    // ever change the field it was set on.
    this._attachCrease()

    // Invalidated rather than kept: erosion moves the texels the percentile
    // histogram is built from, so the altitude ramp a stale `bands` describes is
    // a ramp over a world that no longer exists.
    this._bands = null
  }

  /**
   * Point the crease operator at whatever `this.ground` currently is, or clear
   * it when the knob is off. Idempotent, and safe to call on a ground that
   * already carries one.
   *
   * IT IS A METHOD BECAUSE TWO PATHS REPLACE `this.ground` AND BOTH MUST DO
   * THIS. `_rebuild` makes it from the import or the eroded copy; coarsePatched
   * makes a fresh one on every tick of a brush stroke while `erode` is up. The
   * first draft attached only in `_rebuild`, so with both knobs on the first
   * brush tick handed the world a Heightmap with no operator on it and the
   * terrain quietly un-creased itself mid-stroke, staying that way until
   * something forced a full rebuild. Three lines that two call sites had to keep
   * agreeing on is the shape of bug this whole file is careful about.
   */
  _attachCrease() {
    this.crease = null
    if (this.relief.crease <= 0) return
    // A VIEW, NEVER THE OBJECT ITSELF. With `erode` off `this.ground` is the
    // import, shared by reference with every other V2Height reading it, and
    // attaching to that lets one field's knob decide what the others stand on.
    // See Heightmap.view.
    this.ground = this.ground.view()
    this.crease = new CreaseField(this.ground, this.seed)
    this.crease.lift = this.relief.crease
    this.ground.attachCrease(this.crease)
  }

  /**
   * Swap the relief knobs and rebuild. Returns true if anything changed, so the
   * caller knows whether it owes the world a remesh.
   *
   * THE CALLER'S OBLIGATION, and nothing here can enforce it: this object is one
   * of THREE evaluating the same field -- the main thread's and one per terrain
   * worker -- and they do not share memory. Set the relief on one and the ground
   * she is drawn standing on and the ground she collides with are two different
   * surfaces. TerrainV2.setRelief is the transport that keeps them together; see
   * the banner in relief.js.
   */
  setRelief(relief) {
    const next = normalizeRelief(relief)
    if (sameRelief(next, this.relief)) return false
    this.relief = next
    this._rebuild()
    return true
  }

  /**
   * Tell the field that the IMPORT changed over `rect` (texel indices), because
   * the sculpt brush wrote into it.
   *
   * Only erosion cares, and it cares absolutely: with erosion on, the world is
   * built on a derived copy, and a brush stroke that updated the import and not
   * the copy would be an invisible brush AND a player colliding with ground that
   * is no longer drawn.
   *
   * THE RESULT IS SPLICED INTO THE STANDING COPY, NOT SUBSTITUTED FOR IT, and
   * that is the whole subtlety of this function. `thermalErode` returns a copy of
   * the IMPORT with the region it was given relaxed -- so everything outside that
   * region comes back un-eroded. Handing the return value straight to
   * `this.ground` therefore reverted the entire eroded world to the import on the
   * first tick of the first stroke: measured on the shipped field at 20 passes,
   * one 200 m stamp moved 8.8% of the world's texels by up to 148 m, most of it
   * nowhere near the brush. On screen that is the whole range visibly snapping
   * back the instant the brush is pressed.
   *
   * Material moves one texel per pass, so a texel further than `passes` from a
   * changed import texel cannot hear about the change: `rect` grown by `passes`
   * is exactly the region whose eroded height can differ, and everything outside
   * it is already correct in the standing copy. `thermalErode` grows what it is
   * given by `passes + 1` before relaxing, so handing it the grown rect makes the
   * grown rect itself exact rather than merely close.
   *
   * NEITHER `bands` NOR THE EXPOSURE GRID REFRESHES HERE, and both omissions are
   * decisions rather than oversights.
   *
   * `bands` is the world's own min/max, which the snow ramp and the rock beds are
   * expressed against. Recomputing it mid-drag would repaint the whole world off
   * a ramp its already-meshed chunks are not using, so the chunks under the brush
   * would come back shaded against a different scale from their neighbours -- a
   * seam that follows the brush. The terrain worker's `height` handler carries
   * the same note for the same reason. A stroke moves a brush-sized patch of a
   * 1024^2 field, so the error in the extremes is at worst the depth of one
   * stroke, and the next full rebuild picks it up.
   *
   * The exposure grid is stale for a different reason: see the note in
   * exposure.js on why a stale AMPLITUDE is safe where a stale SURFACE is not.
   */
  coarsePatched(rect) {
    if (!this.needs.erode) return
    const src = this.heightmap
    const passes = this.relief.erode
    const w = src.width
    const i0 = Math.max(0, rect.i0 - passes)
    const j0 = Math.max(0, rect.j0 - passes)
    const i1 = Math.min(w, rect.i1 + passes)
    const j1 = Math.min(src.height, rect.j1 + passes)
    const fresh = thermalErode(src.field, w, src.height, src.texelSize, {
      passes,
      talusDeg: this.relief.talus,
      rect: { i0, j0, i1, j1 },
    })
    const data = Float32Array.from(this.ground.field)
    for (let j = j0; j < j1; j++) {
      const row = j * w
      data.set(fresh.subarray(row + i0, row + i1), row + i0)
    }
    this.ground = Heightmap.fromRaw({ width: w, height: src.height, data, meta: src.meta })
    // The line above hands back a Heightmap with nothing attached to it, so the
    // operator has to be re-pointed at it or the stroke un-creases the world.
    // Unlike `bands` and the exposure grid above, this is not a stale-but-safe
    // omission: those keep describing a slightly older surface, whereas dropping
    // this changes which surface the player is standing on, mid-drag.
    this._attachCrease()
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
    const hm = this.ground
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
    if (this.flatY !== null) return this.flatY
    const hm = this.ground
    if (this._plain) return hm.sample(x, z) + this.detail.at(x, z, cell, hm.slopeAt(x, z), 0)
    return hm.sample(x, z) + this._micro(x, z, cell, 0)
  }

  /** The composed field. `cell` is the sampling spacing in metres; 0 is exact and is the default, because Player and the editor call this with two arguments. */
  heightAt(x, z, cell = 0) {
    if (this.flatY !== null) return this.flatY
    if (this.layers.epoch !== this._epoch) this._syncAuthored()
    const hm = this.ground
    if (!this._authored) {
      // flattenAt would be 0 everywhere and carve() the identity, so both are
      // skipped outright rather than called and thrown away.
      if (this._plain) return hm.sample(x, z) + this.detail.at(x, z, cell, hm.slopeAt(x, z), 0)
      return hm.sample(x, z) + this._micro(x, z, cell, 0)
    }
    const layers = this.layers
    const flatten = layers.flattenAt(x, z)
    const h = this._plain
      ? hm.sample(x, z) + this.detail.at(x, z, cell, hm.slopeAt(x, z), flatten)
      : hm.sample(x, z) + this._micro(x, z, cell, flatten)
    return layers.carve(x, z, h)
  }

  /**
   * THE SUB-TEXEL TERMS, as one expression: detail, exposure-modulated, plus the
   * crag band. Reached only when some relief knob that touches geometry is on --
   * the `_plain` branch above is the shipped path and is untouched by any of
   * this, which is what makes an all-off relief bit-identical rather than merely
   * equivalent.
   *
   * ONE gradient serves all three. Heightmap.slopeAt was already taking four
   * bicubic taps on every evaluation and throwing the DIRECTION away;
   * gradientAt returns the same slope from the same stencil and keeps the fall
   * line, so the anisotropy is free and the crag's steepness gate costs nothing.
   */
  _micro(x, z, cell, flatten01) {
    const g = this.ground.gradientAt(x, z, this._grad)
    const relief = this.relief
    let m = this.detail.at(x, z, cell, g.slope01, flatten01)
    // Ahead of the exposure gain, though both are multiplicative on `m` and so
    // commute: at bare = 1 this is exactly 0 and the modulation below is being
    // applied to nothing, which is the point.
    if (relief.bare > 0) m *= 1 - relief.bare
    if (this.ridge) {
      // Suppressed by the carve weight, crag's argument exactly: a road crosses
      // the fall line on precisely the convex steep ground a ridge term likes
      // best, and the carve chain that runs after this would smooth the road
      // back over a notch it never knew was cut.
      //
      // OUTSIDE the exposure gain, unlike crag, and not merely ahead of it. Its
      // amplitude is already gated by its own ridgeness, which is a sharper and
      // better-aimed statistic than convexity: a dome scores high on exposure
      // and zero here, correctly, because a dome has no axis to be right about.
      // Multiplying the two gates would only narrow the term to where they
      // happen to agree, and convexity is the weaker of the two opinions.
      const keep = 1 - (flatten01 < 0 ? 0 : flatten01 > 1 ? 1 : flatten01)
      if (keep > 0) m += keep * this.ridge.at(x, z, cell, relief.ridge)
      // Additive with `ridge` rather than exclusive with it, and gated the same
      // way. They are different operators over one baked structure, so running
      // both is a blend of ribbing and faceting rather than a conflict -- and
      // either alone is the useful comparison.
      if (keep > 0) m += keep * this.ridge.atShatter(x, z, cell, relief.shatter)
    }
    if (!this.exposure) return m
    const e = this.exposure.at(x, z)
    if (relief.exposure > 0) m *= 1 + relief.exposure * EXPOSURE_SWING * (2 * e - 1)
    if (this.crag) {
      // Suppressed by the same flatten weight the detail term uses, and it has
      // to be: a road is drawn ACROSS the fall line on exactly the convex, steep
      // ground the crag gate likes best, and an unsuppressed crag would cut a
      // gully through the carriageway. The carve chain runs after this and would
      // then smooth the road back over a hole it did not know was there.
      const keep = 1 - (flatten01 < 0 ? 0 : flatten01 > 1 ? 1 : flatten01)
      if (keep > 0) {
        m += keep * this.crag.at(x, z, cell, relief.crag, relief.aniso, e, g.slope01, g.dx, g.dz)
      }
    }
    return m
  }

  /** The exposure gain alone, for calibrateRough to measure the unit stack through. */
  _exposureGain(x, z) {
    return 1 + this.relief.exposure * EXPOSURE_SWING * (2 * this.exposure.at(x, z) - 1)
  }

  /**
   * Convexity at (x, z), 0..1 -- 0 in a hollow, 1 on a rib. Null-free: returns
   * 0.5, i.e. planar, when no knob asked for the grid to be baked, so callers
   * can multiply by it unconditionally.
   */
  exposureAt(x, z) {
    return this.exposure ? this.exposure.at(x, z) : 0.5
  }

  /**
   * Elevation at which snow starts here. The baked grid lives in Layers and this
   * is a pass-through unless the `snowJag` knob is up.
   *
   * WHY THE SERRATION LIVES HERE AND NOT IN SnowField. Exposure is a property of
   * the HEIGHT field and the snow layer is an authored document; putting a
   * convexity term in Layers would make a thing a human draws depend on a thing
   * the terrain computes, and the editor would be showing a snow line it cannot
   * account for. Putting it here instead reaches the mesher's vertex colours and
   * all four prop layers -- trees, ferns, grass, rocks all call this -- through
   * one function, which is the whole reason V2Height carries a pass-through in
   * the first place.
   *
   * AND IT IS THE ONE ITEM ON THIS LIST THAT WORKS AT ANY DISTANCE. Everything
   * else here is geometry, and geometry is band-limited by the mesh: past about
   * a kilometre the cell is 32 m and there is no octave under 128 m left to
   * carry an edge. A snow line is a COLOUR boundary, it is drawn on whatever
   * triangles exist, and a ragged one reads as a ragged mountain from any range
   * at all. Cheap, and it is the only thing in the set that touches a skyline.
   */
  snowLineAt(x, z) {
    const base = this.layers.snowLineAt(x, z)
    if (this.relief.snowJag <= 0) return base
    // Convex ground blows clear, so snow starts HIGHER on a rib; hollows collect
    // drift, so it starts lower. Same rule as the crag gate, opposite sign, and
    // that is what makes the two agree: bare rock and no snow are the same fact.
    return base + this.relief.snowJag * (2 * this.exposureAt(x, z) - 1)
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
    if (this.flatY !== null) { out.x = 0; out.y = 1; out.z = 0; return out }
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
    if (this.flatY !== null) return 0
    return this.ground.slopeAt(x, z)
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
    if (this.flatY !== null) return { h: this.flatY, tan: 0 }
    const e = 0.75
    const h = this.heightAt(x, z)
    const xm = this.heightAt(x - e, z)
    const xp = this.heightAt(x + e, z)
    const zm = this.heightAt(x, z - e)
    const zp = this.heightAt(x, z + e)
    const d = 2 * e
    return { h, tan: Math.hypot((xp - xm) / d, (zp - zm) / d) }
  }

  /**
   * The same `{ h, tan }` shape as heightAndSlopeAt, at ONE FIFTH the cost, for
   * scatter that is deciding WHETHER a prop exists rather than where its trunk
   * meets the ground.
   *
   * Two differences from heightAndSlopeAt, and both are the point:
   *
   *   THE SLOPE IS FREE. heightAt already computes hm.slopeAt(x, z) to modulate
   *   the detail amplitude and throws it away; this returns it. heightAndSlopeAt
   *   instead takes four EXTRA composed samples 75 cm out, so it costs five
   *   field evaluations where this costs one. Measured on the shipped heightmap:
   *   3.84 us against 0.71 us, which over a 41,000-tree boot is 157 ms against
   *   29 ms.
   *
   *   THE COARSE SLOPE IS ALSO THE MORE HONEST ONE, which is why this is not
   *   simply a cheaper approximation. heightAndSlopeAt measures a 75 cm central
   *   difference on a field that still has real energy at 10 cm, so what it
   *   reports is the ROUGHNESS OF THE GROUND, not the pitch of the hillside: it
   *   reads steeper than the coarse gradient at 66% of world sites, median 1.8
   *   deg and p95 10.5 deg. A tree was being refused for standing on a 30 cm
   *   gravel bump. Swapping the basis flips 7.7% of individual placements and
   *   moves the accept rate 72.1% -> 75.6%, i.e. about 5% more trees, which is
   *   the direction render/trees.js already documents as the safe one.
   *
   *   What it gives up: the slope no longer sees the carve chain, so a tree may
   *   stand on a river bank the composed slope would have refused. A tree IN the
   *   river bed is still refused, because `h` below does carry the carve and
   *   WaterSurfaces.isSubmerged reads it. Numbers from tmp/probe-tree-ground.mjs.
   *
   *   `cell` IS MANDATORY, and callers should pass a FIXED one. Prop existence
   *   has to be a pure function of position: if the band limit followed the
   *   terrain's LOD, trees near the elevation floor or the slope limit would
   *   appear and vanish as chunks re-split under them, and the deterministic
   *   tiled scatter -- walk away, walk back, same forest -- would be gone. See
   *   render/trees.js PLACEMENT_CELL.
   *
   * `tan` converts Heightmap.slopeAt's 0..1 convention back to a tangent (see
   * slope01At), because a tangent is what scatter compares against.
   */
  scatterAt(x, z, cell, out = { h: 0, tan: 0 }) {
    if (!(cell > 0)) throw new Error(`V2Height.scatterAt: cell must be a positive fixed band limit, got ${cell}`)
    if (this.flatY !== null) { out.h = this.flatY; out.tan = 0; return out }
    if (this.layers.epoch !== this._epoch) this._syncAuthored()
    const hm = this.ground
    const s = hm.slopeAt(x, z)
    out.tan = s / (1 - s)
    if (!this._authored) {
      out.h = hm.sample(x, z) + (this._plain ? this.detail.at(x, z, cell, s, 0) : this._micro(x, z, cell, 0))
      return out
    }
    const layers = this.layers
    const flatten = layers.flattenAt(x, z)
    const h = hm.sample(x, z) + (this._plain ? this.detail.at(x, z, cell, s, flatten) : this._micro(x, z, cell, flatten))
    out.h = layers.carve(x, z, h)
    return out
  }
}
