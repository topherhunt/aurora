import { brushRect, rectToWorld, readRect, stamp, unionRect, SCULPT_MODES } from '../height/sculpt.js'
import { saveHeightServer } from './persist.js'

// ---------------------------------------------------------------------------
// The terrain brush, on the side of the wall that has three, a pointer, workers
// and a dev server on it. The kernel -- falloff, rects, one stamp -- is in
// src/v2/height/sculpt.js, three-free and gated by scripts/check-v2-sculpt.mjs.
// This file is everything that cannot be: stroke timing, the throttle to the
// workers, undo, and the POST.
//
// ONE HEIGHTMAP, THREE READERS, AND WHY THAT IS NOT A FOURTH COPY OF THE WORLD.
// The main thread holds the decoded field once. The player samples it for
// collision through V2Height, the editor's ground picks walk it, and this stamps
// into it -- all the same Float32Array, so a stroke is under her feet in the
// same frame it is drawn. The terrain WORKERS hold their own copies (they must:
// a worker cannot see main-thread memory without a SharedArrayBuffer, which
// needs COOP/COEP headers this dev server does not set), and `patchHeight`
// exists to keep them in step by sending only the texels that moved.
//
// THE THROTTLE IS THE WHOLE DESIGN. A drag stamps once per frame -- 60 a second
// -- and each stamp invalidates every chunk over the brush. Posting a patch per
// stamp would re-mesh the same ground sixty times a second and the queue would
// never catch up; the world would stop redrawing exactly while it is being
// sculpted. So stamps accumulate into one dirty rect and go out at FLUSH_MS,
// with a final flush on pointer-up so the last few milliseconds of a stroke are
// never left unsent. The field the player collides against is always current;
// what lags by up to FLUSH_MS is only what the GPU is showing.
// ---------------------------------------------------------------------------

// Two clocks fight here: the mesher wants patches rare, the eye wants the ground
// to follow the cursor. 90 ms is about six frames -- fast enough that the terrain
// reads as dragging behind the brush rather than as arriving in blocks, and slow
// enough that a two-worker pool keeps up with a wide brush.
const FLUSH_MS = 90

// Metres, and the range is the world's rather than a texel's: at 8 m/texel a
// 16 m brush moves a couple of texels and is the smallest thing that is not a
// single spike, while 2 km is a quarter of the world -- enough to lift a whole
// massif in one press, which is the thing the coarse import is bad at.
const RADIUS = { min: 16, max: 2048, step: 8, def: 160 }

// Metres per SECOND, not per stamp, so a 120 Hz machine and a 60 Hz one dig at
// the same rate. 12 m/s means a second of holding still moves the brush centre
// by 12 m against a 900 m world -- slow enough to shape a ridge, fast enough to
// dig a valley in the few seconds nobody minds waiting.
const STRENGTH = { min: 0.5, max: 120, step: 0.5, def: 12 }

// Also per second, and unitless: the fraction of the way to the local mean the
// ground travels in one second of smoothing. Not shared with STRENGTH, because
// metres per second means nothing to a blur and a slider that silently changes
// units with the mode is worse than two sliders.
const SMOOTH = { min: 0.25, max: 8, step: 0.25, def: 3 }

// Strokes, not bytes. Each entry holds the pre-stroke heights of that stroke's
// bounding box -- kilobytes for a normal stroke, and bounded by the field itself
// (4 MB) for a stroke dragged across the whole world. 32 of those is a worst
// case nobody will reach and a typical case of a few hundred kB.
const UNDO_DEPTH = 32

export class Sculptor {
  constructor({ heightmap, field, terrain, onRiversMoved = null }) {
    if (!heightmap?.field) throw new Error('Sculptor: heightmap is required -- the brush writes the decoded coarse field in place')
    if (typeof field?.coarsePatched !== 'function') throw new Error('Sculptor: field must be a V2Height (no coarsePatched)')
    if (typeof terrain?.patchHeight !== 'function') throw new Error('Sculptor: terrain must be a TerrainV2 (no patchHeight)')
    this.heightmap = heightmap
    // THE IMPORT AND THE FIELD ARE NOT THE SAME OBJECT once the erode relief knob
    // is on. The brush writes `heightmap`, which is the image the human authored
    // and the one Save writes back to the PNG; V2Height then derives the surface
    // the world is actually built on from it. With erosion off the two are
    // literally the same array and this call is a no-op branch. With erosion on,
    // skipping it gives a brush that appears to do nothing and, worse, a player
    // colliding with terrain that is no longer being drawn.
    this.field = field
    this.terrain = terrain
    // Called with the world rect of every river a flush re-routed, so the water
    // surfaces can be rebuilt; the terrain itself is told through patchHeight.
    this.onRiversMoved = onRiversMoved

    this.mode = 'raise'
    this.radius = RADIUS.def
    this.strength = STRENGTH.def
    this.smoothRate = SMOOTH.def

    // Has anything been sculpted since the last successful save? What the panel
    // shows and what makes Save write the PNG at all.
    this.dirty = false
    // Texels the last stroke pushed against the encoding's ceiling or floor. A
    // brush that is silently doing nothing at the top of a mountain is the one
    // failure of this tool that looks exactly like a slow brush.
    this.clamped = 0

    this._stroke = null // {snap: {rect, data}, moved} while the pointer is down
    this._pending = null // texel rect stamped but not yet sent to the workers
    this._flushedAt = 0
    this._undo = []
  }

  get canUndo() {
    return this._undo.length > 0
  }

  get sculpting() {
    return this._stroke !== null
  }

  setMode(mode) {
    if (!SCULPT_MODES.includes(mode)) throw new Error(`Sculptor.setMode: unknown mode ${mode}`)
    this.mode = mode
  }

  /** Pointer down. A stroke is one undo entry, however long the drag. */
  begin() {
    if (this._stroke) this.end()
    this._stroke = { snap: null, moved: 0 }
    this.clamped = 0
  }

  /**
   * One frame of a held brush at world (x, z). `dt` is seconds since the last
   * frame and is what makes the rate frame-independent.
   *
   * Called from Editor.update at most once per frame -- never per pointermove,
   * which arrives far more often and would make a slow mouse dig slower than a
   * fast one.
   */
  stroke(x, z, dt) {
    if (!this._stroke) return
    if (!(dt > 0)) return

    const rect = brushRect(this.heightmap, x, z, this.radius)
    if (!rect) return // the brush is entirely off the grid, which happens at the corners

    // BEFORE the stamp, or the "before" it records is an "after".
    this._extendSnapshot(rect)

    const amount = this.mode === 'smooth' ? Math.min(1, this.smoothRate * dt) : this.strength * dt
    const res = stamp(this.heightmap, { x, z, radius: this.radius, mode: this.mode, amount })
    if (!res || res.moved === 0) return

    this._stroke.moved = Math.max(this._stroke.moved, res.moved)
    this.clamped += res.clamped
    this.dirty = true
    // SYNCHRONOUSLY, and not folded into the throttled _flush below. The flush
    // is throttled because the MESH can lag the brush by a frame or two without
    // anyone noticing; the field the player stands on cannot, because she is
    // colliding against it this frame. `stamp` writes heightmap.field directly
    // rather than going through Heightmap.patch, so this is the only hook the
    // main-thread brush has.
    this.field.coarsePatched(res.rect)
    this._pending = unionRect(this._pending, res.rect)
    this._flush(false)
  }

  /** Pointer up. Flushes whatever is left and closes the undo entry. */
  end() {
    if (!this._stroke) return
    const { snap, moved } = this._stroke
    this._stroke = null
    this._flush(true)
    // A press that moved nothing -- a click with the brush off the grid, or on a
    // summit already at the ceiling -- must not push an undo entry, or Ctrl-Z
    // starts doing nothing visible several times in a row.
    if (!snap || moved === 0) return
    this._undo.push(snap)
    if (this._undo.length > UNDO_DEPTH) this._undo.shift()
  }

  /** Put the last stroke back. Returns false when there is nothing to undo, matching Editor.undo. */
  undo() {
    if (this._stroke) this.end()
    const entry = this._undo.pop()
    if (!entry) return false
    this.heightmap.patch(entry.rect, entry.data)
    this.field.coarsePatched(entry.rect)
    this._patch(entry.rect, entry.data)
    // Still dirty: the file on disk does not match this field either way, and an
    // undo back to the imported shape is exactly when Save matters most.
    this.dirty = true
    return true
  }

  /**
   * Write the sculpted field to public/world/height.png through the dev server.
   * Resolves to the endpoint's {path, bytes}. `dirty` only clears on success --
   * a failed save must not look like a saved world.
   */
  async save() {
    const r = await saveHeightServer(this.heightmap)
    this.dirty = false
    return r
  }

  /** Panel rows, in the {label, value, set, step, min, max, unit} shape Editor.status() returns. */
  status() {
    const rate =
      this.mode === 'smooth'
        ? { label: 'rate', value: this.smoothRate, unit: '/s', ...SMOOTH, set: (v) => { this.smoothRate = clamp(v, SMOOTH) } }
        : { label: 'strength', value: this.strength, unit: 'm/s', ...STRENGTH, set: (v) => { this.strength = clamp(v, STRENGTH) } }
    return [
      { label: 'radius', value: this.radius, unit: 'm', ...RADIUS, set: (v) => { this.radius = clamp(v, RADIUS) } },
      rate,
      { label: 'clamped', value: this.clamped === 0 ? 'no' : `${this.clamped} texels at the limit` },
      { label: 'saved', value: this.dirty ? 'NO -- press save' : 'yes' },
    ]
  }

  // Grow the pre-stroke snapshot to cover `rect`.
  //
  // Anything outside what the snapshot already covers has not been touched by
  // this stroke, so its CURRENT value is its pre-stroke value -- which is what
  // makes this exact rather than approximate: read the union as it stands now,
  // then paste the stored originals back over the part that was already stamped.
  _extendSnapshot(rect) {
    const snap = this._stroke.snap
    if (!snap) {
      this._stroke.snap = { rect, data: readRect(this.heightmap, rect) }
      return
    }
    const u = unionRect(snap.rect, rect)
    if (u.i0 === snap.rect.i0 && u.j0 === snap.rect.j0 && u.i1 === snap.rect.i1 && u.j1 === snap.rect.j1) return

    const data = readRect(this.heightmap, u)
    const uw = u.i1 - u.i0
    const sw = snap.rect.i1 - snap.rect.i0
    for (let j = snap.rect.j0; j < snap.rect.j1; j++) {
      const from = (j - snap.rect.j0) * sw
      data.set(snap.data.subarray(from, from + sw), (j - u.j0) * uw + (snap.rect.i0 - u.i0))
    }
    this._stroke.snap = { rect: u, data }
  }

  _flush(force) {
    if (!this._pending) return
    const now = performance.now()
    if (!force && now - this._flushedAt < FLUSH_MS) return
    this._flushedAt = now
    const rect = this._pending
    this._pending = null
    this._patch(rect, readRect(this.heightmap, rect))
  }

  // Hand a texel patch to the terrain, and first to the rivers: any river that
  // routes over or reads the patched ground re-bakes here on the main thread
  // (each worker does the same against its own copy when the patch reaches it),
  // and the chunks it moved between are invalidated along with the patch's own.
  _patch(rect, data) {
    const world = rectToWorld(this.heightmap, rect)
    const rivers = this.field.layers.terrainChanged(world)
    if (rivers === null) {
      this.terrain.patchHeight(rect, data, world)
      return
    }
    this.terrain.patchHeight(rect, data, {
      minX: Math.min(world.minX, rivers.minX),
      minZ: Math.min(world.minZ, rivers.minZ),
      maxX: Math.max(world.maxX, rivers.maxX),
      maxZ: Math.max(world.maxZ, rivers.maxZ),
    })
    if (this.onRiversMoved !== null) this.onRiversMoved(rivers)
  }
}

// The panel's number boxes are deliberately unclamped (see _buildFields), so the
// clamp is the setter's job, here, where the range is defined.
function clamp(v, range) {
  if (!Number.isFinite(v)) throw new Error(`Sculptor: expected a finite number, got ${v}`)
  return Math.min(range.max, Math.max(range.min, v))
}
