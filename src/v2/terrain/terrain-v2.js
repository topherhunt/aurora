import THREE from '../../three-instance.js'
import {
  WORLD_SIZE,
  WORLD_HALF,
  CHUNK_RES,
  CHUNK_VERTS,
  CHUNK_INDICES,
  MAX_DEPTH,
  SLOT_COUNT,
  PINNED_CHUNKS,
} from '../config.js'
import { selectNodes, nodeKey, unpackKey, inCone, EYE_HALF_ANGLE, LOD } from './quadtree-v2.js'
import {
  acceptsReply,
  cellSize,
  invalidateAll,
  invalidateKeys,
  invalidatedKeys,
  invalidationAction,
  loadedAncestorKey,
  loadedDescendantKeys,
  makeFloors,
  pruneFloors,
  selectEvictions,
  slotBudget,
  staleQueuedKeys,
  validRect,
} from './stream-policy.js'
import { createTerrainMaterial } from '../../terrain/terrain-material.js'
import { RELIEF_DEFAULTS, normalizeRelief, sameRelief } from '../height/relief.js'

// ---------------------------------------------------------------------------
// v2 terrain chunk manager: quadtree LOD over a MAX_DEPTH 10 tree, worker-fed
// geometry, hole-free swaps, partial invalidation on an edit, and ONE draw call.
//
// The rendering argument is DESIGN.md §5; the streaming policy lives in
// stream-policy.js, which owns the decisions. Three things restated here because
// each shipped as a visible bug in src/terrain/terrain.js first:
//
//   ONE BatchedMesh, SLOT_COUNT slots bound 1:1 to instances up front and never
//   added or deleted. Streaming in is setGeometryAt() on a recycled slot, legal
//   only because CHUNK_RES is fixed at every depth so a freed slot always fits.
//   A THREE.Mesh per chunk is hundreds of draw calls for an empty world.
//
//   FIVE mechanisms keep the world hole-free and none replaces another: the
//   pinned depth 0-2 base layer on its own queue, the loaded-ancestor walk for
//   refining, the loaded-descendant walk for coarsening, eviction counted in HELD
//   SLOTS, and an invalidated chunk keeping stale geometry until its replacement
//   lands. Remove any one and a specific reported artifact returns.
//
//   Invariant violations THROW -- a dry slot pool, a worker vertex count that
//   disagrees with CHUNK_RES -- rather than degrading into a world with pieces
//   missing.
//
// NEW IN v2, beyond depth and packed integer keys: setLayers(doc, dirtyRect)
// replaces v1's retune(). A tuning constant moves the whole world; an authored
// edit does not, and the editor's feel is that distinction -- dragging one river
// control point re-meshes a few hundred metres, not the whole 8 km box. The
// staleness gate is per-key rather than global for the same reason; see
// stream-policy.js.
// ---------------------------------------------------------------------------

// Reselect the quadtree at ~12 Hz when nothing is streaming: 12 cm of walking
// between selections against a 50 cm leaf cell at depth 10. Selection also reruns
// immediately when a chunk lands or an edit invalidates (`_dirty`), which is what
// actually settles a new view; the timer only covers walking through resident
// ground. Halving it would double a measured 0.023 ms p50 / 0.044 ms p99
// selection (check-v2-quadtree.mjs) to reselect terrain that is already correct.
const SELECT_EVERY_FRAMES = 6

// The floor on how often `_dirty` may force a reselect, in frames.
//
// Every landed chunk sets _dirty and chunks land on most frames while the pipe is
// full, so without a floor selection runs at FULL frame rate through the settling
// of a new view -- exactly when the frame budget is tightest -- rather than at the
// 12 Hz above. Two frames is 28 ms of extra stand-in-swap latency at 72 Hz, which
// nobody can see, and caps the burst at half rate.
const MIN_SELECT_FRAMES = 2

// The near field the yaw cull is never allowed to touch, in metres, and the
// multiple of her height above a node that counts as near when she is above it.
// See _inSight for what these defend against.
//
// DOWN_K is geometry, not taste: looking straight down she sees a disc of radius
// `height above it * tan(half the horizontal FOV)`, and the Quest 2's ~96 degrees
// makes that tangent 1.11. 1.5 is that with a third again of margin, and it
// scales -- 2.5 m standing, 450 m at 300 m up.
//
// NEAR_KEEP_M covers the one case DOWN_K cannot: a node whose maxY is at or above
// the eye, where `above` goes to zero and the scaled radius collapses. 12 m is one
// and a half chunks at the 8 m floor; 24 cost 11k triangles both eyes for radius
// nothing asked for, and 24 -> 8 is a flat 113k -> 102k worst case walking with
// the knee at 12.
const NEAR_KEEP_M = 12
const DOWN_K = 1.5

// Requests allowed in flight per worker, bounded from ABOVE by the slot pool in
// v2 rather than only from below by worker throughput.
//
// v1 ships 32 because an in-flight cap is a cap on chunks per frame and buildChunk
// is 0.393 ms against setGeometryAt's 0.005 ms -- the workers do all the real work
// and a low cap leaves them idle while the player looks at coarse stand-ins. That
// still holds. What does not carry over is the headroom: the eviction target is
// SLOT_COUNT - workers * queueDepth and the current render set is EXEMPT from
// eviction, so the worst set this knob can pin down at once must fit under that
// target. Measured in check-v2-terrain.mjs "slot budget" over 1200 selections at
// MIN_TRI_DEG 1.2, the finest the [ ] keys reach: worst selection 856 leaves + 21
// pinned = 877 resident against SLOT_COUNT 1024, leaving a stand-in budget of 83
// chunks at queueDepth 32, 99 at 24, 115 at 16.
//
// Every row fits, which is the finding -- at an 8 km box the pool is not the
// binding constraint, and the depth cap coming down from 13 to 10 removed exactly
// the levels that packed leaves under the camera, widening every margin. So 24 is
// chosen on margin: the 856 comes from a synthetic ground function, not from
// `reference/skyrim-height-map.jpg`, and range is computed against the mesher's
// measured minY/maxY, so a field with more vertical relief selects MORE leaves and
// 83 spare chunks is a 9% margin against a field nobody has flown. Re-run that
// section against the real heightmap; if 856 holds, 32 is free.
//
// Choosing 24 costs 48 requests in flight rather than 64 -- a 6 ms shallower
// pipeline at v1's 0.393 ms per chunk, which is nothing. A full re-stream of the
// worst case is 877 chunks, about 18 frames at 48 per frame if the workers keep
// up. Whether they keep up is not yet measurable: chunk-mesh-v2.js does a bicubic
// tap plus the carve layers where v1 did fbm. Raise this if the workers ever
// measure idle, and take those slots back out of maxReady when you do.
const WORKER_QUEUE_DEPTH = 24

// The interior grid of a chunk: (CHUNK_RES + 1)^2 = 289 vertices, the first
// block of every position array chunk-mesh-v2 emits. The skirt vertices follow
// and are deliberately excluded -- they are a flange hanging below the surface,
// not part of it.
const GRID_SIDE = CHUNK_RES + 1
const GRID_VERTS = GRID_SIDE * GRID_SIDE

export class TerrainV2 {
  /**
   * @param scene         THREE.Scene to add the single BatchedMesh to.
   * @param heightmapRaw  {width, height, data: Float32Array, meta} from Heightmap.toRaw().
   * @param doc           the WorldDoc the layers bake from (Layers.serialize()).
   * @param relief        the jaggedness knobs (height/relief.js); defaults to all off.
   * @param workers       worker count.
   * @param queueDepth    requests in flight per worker; see WORKER_QUEUE_DEPTH.
   * @param lean          compile the reduced ground shader; see the LEAN block in terrain-material.js.
   */
  constructor(scene, { heightmapRaw, doc, relief = RELIEF_DEFAULTS, workers = 2, queueDepth = WORKER_QUEUE_DEPTH, atlas = null, lean = false } = {}) {
    if (!heightmapRaw) throw new Error('TerrainV2: no heightmapRaw -- the workers have no coarse field to sample and would mesh a flat world')
    if (!doc) throw new Error('TerrainV2: no doc -- the workers have no content layers to bake')
    const { width, height, data, meta } = heightmapRaw
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
      throw new Error(`TerrainV2: heightmapRaw is ${width}x${height}, which is not an image`)
    }
    if (!meta) throw new Error('TerrainV2: heightmapRaw has no meta -- minY/maxY/encoding are what make the samples metres')
    // A detached buffer reads as length 0 and would mesh a perfectly flat world
    // with no error anywhere. Checking it here is the difference between a
    // legible throw at construction and a silent plane.
    if (!(data instanceof Float32Array) || data.length !== width * height) {
      throw new Error(
        `TerrainV2: heightmapRaw.data is ${data ? data.length : 'missing'} floats for a ${width}x${height} image ` +
          `(${width * height} expected) -- a detached or truncated buffer meshes a flat world silently`
      )
    }

    this.scene = scene
    this.queueDepth = queueDepth

    // Normalized HERE, once, then shipped verbatim to every worker.
    //
    // The composed field is evaluated in THREE places that do not share memory --
    // the main thread for collision, the editor raycast and the prop scatter, and
    // one V2Height per terrain worker -- so the relief must be the same values on
    // all of them. Reach the mesher and not the main thread and the ground she is
    // drawn on and the ground she collides with are different surfaces; she hovers
    // or sinks and nothing throws. Same failure as the WORLD_SEED banner in
    // height/field.js, and why the knobs travel over the wire on the same footing
    // as the document rather than out of a global.
    //
    // Normalizing before the postMessage means a misspelled knob throws once,
    // here, at construction -- not N times inside N workers, or on only some.
    this.relief = normalizeRelief(relief)

    const budget = slotBudget(workers, queueDepth)
    this._inFlightCap = budget.inFlightCap
    // The eviction target, counted in READY entries -- the ones actually holding a
    // slot -- rather than in cache.size, which counts queued entries too and is a
    // different quantity by a hundred or more while anything is streaming. See
    // stream-policy.js selectEvictions for what that cost v1.
    this.maxReady = budget.maxReady

    // The prop texture array, forwarded so the rock surface can wear the same
    // stone tile the boulders do. Optional: without it the terrain compiles
    // exactly as it did before, which is what /gen-* benches still get. `lean`
    // wins over it -- that variant samples no tiles at all -- so the game passes
    // both and the atlas only reaches the shader on the /gen-* path.
    this.material = createTerrainMaterial({ atlas, lean })

    this.batch = new THREE.BatchedMesh(SLOT_COUNT, SLOT_COUNT * CHUNK_VERTS, SLOT_COUNT * CHUNK_INDICES, this.material)
    this.batch.name = 'terrain-v2'
    // The batch spans the whole 8 km world, so culling it as one object is
    // meaningless. Per-instance culling is what does the work and it is on by
    // default.
    this.batch.frustumCulled = false
    this.batch.sortObjects = true
    scene.add(this.batch)

    // Scratch geometry reused for every incoming chunk. setGeometryAt copies out
    // of it immediately, so one instance serves all of them and streaming
    // produces no per-chunk garbage.
    this._scratch = new THREE.BufferGeometry()
    this._scratch.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CHUNK_VERTS * 3), 3))
    this._scratch.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(CHUNK_VERTS * 3), 3))
    this._scratch.setAttribute('color', new THREE.BufferAttribute(new Float32Array(CHUNK_VERTS * 3), 3))
    this._scratch.setIndex(new THREE.BufferAttribute(new Uint16Array(CHUNK_INDICES), 1))
    this._scratch.boundingSphere = new THREE.Sphere()

    // Bind one geometry slot to one instance permanently, 1:1. Nothing is ever
    // added or deleted after this, which sidesteps BatchedMesh's id-shuffling on
    // deleteGeometry entirely -- recycling is setGeometryAt + setMatrixAt.
    this._free = []
    for (let i = 0; i < SLOT_COUNT; i++) {
      const geometryId = this.batch.addGeometry(this._scratch, CHUNK_VERTS, CHUNK_INDICES)
      const instanceId = this.batch.addInstance(geometryId)
      this.batch.setVisibleAt(instanceId, false)
      // See groundAt: the interior height grid is kept CPU-side so props can
      // stand on the surface that is DRAWN rather than on the one the field
      // would have drawn at infinite resolution. Allocated with the slot and
      // never reallocated -- 289 floats x 1024 slots is 1.18 MB, fixed.
      this._free.push({ geometryId, instanceId, heights: new Float32Array(GRID_VERTS) })
    }

    this._mat = new THREE.Matrix4()

    // key (packed integer) -> {node, slot, state, lastUsed, tris, visible, pinned}
    this.cache = new Map()

    // THREE queues, and none may be merged with another.
    //
    // `queue` is the selection's, REBUILT from the desired set every selection
    // rather than appended to: an append-only queue grows without bound while
    // walking, keeping cache entries for ground she left behind alive and spending
    // the workers on terrain nobody looks at (v1 measured 1002 entries against a
    // 720 cap over an 18 km walk).
    //
    // `_baseQueue` is the pinned base layer's, separate BECAUSE of that rebuild.
    // _select never asks for a depth 0-2 node once it has been subdivided away, so
    // a base-layer request parked in `queue` is discarded before _pump ever runs.
    // That is v1's bug: on a settled camera depth 0/1 measured 0/1 and 0/4 resident
    // and depth 2 measured 4/16, so the ancestor fallback returned null for ~2100
    // lookups over a 2 km back-away. Ground drawn as sky.
    //
    // `_editQueue` is v2's own, separate one level along for the identical reason.
    // The chunks a partial invalidation just freed are holes right now, but many
    // are stand-ins rather than members of the desired set, so the next _select
    // would not re-request them and `queue` would simply discard them.
    this.queue = []
    this._baseQueue = []
    this._editQueue = []

    this.inFlight = 0
    this.frame = 0
    this.ready = false
    this._render = new Set() // keys that should be visible right now
    this._standIns = new Set() // the subset of _render standing in for a miss
    this._lastSelect = -SELECT_EVERY_FRAMES
    this._dirty = true
    // Always a real object so nothing downstream has to guard for its absence.
    // yaw is what enables cone culling; a caller with only a ground position
    // still gets correct, merely more expensive, terrain (quadtree-v2.js).
    this._cam = { x: 0, y: 0, z: 0, yaw: 0 }

    // Half-angle, in RADIANS, of a yaw cone that chunks must touch to be flagged
    // visible at all. null means no cone -- every selected chunk is submitted and
    // the GPU's per-instance frustum cull decides, which is right on desktop and
    // the ONLY answer when yaw is unknown.
    //
    // It exists for XR, where BatchedMesh's per-instance culling is off (its bounds
    // test runs on the main thread once per eye, the thread with nothing to spare
    // at 72 Hz), so the batch submits the full 360-degree selection to both eyes
    // with roughly half of it behind her. Testing yaw here is free: the loop below
    // already computed this predicate for the drawnTris readout and threw it away.
    //
    // Set it WIDER than the eye sees. Selection runs at 12 Hz, so a chunk entering
    // the eye cone between selections must already be flagged visible or it pops in
    // on a head turn. 70 degrees against a ~55-degree eye is 15 degrees of slack,
    // enough for a fast turn at 72 Hz.
    this.cullDeg = null

    // `tris` is what is RESIDENT and flagged visible; `drawnTris` the subset inside
    // the eye cone, which is what the GPU rasterises. The gap is the streaming
    // margin and it is large, so the budget question is asked of drawnTris.
    //
    // `finestCell` is the cell size of the finest RENDERED chunk anywhere, not of
    // the finest selected node -- a selection wanting depth 13 while the streamer
    // still shows its depth 7 ancestor would print 6 cm for ground visibly 2 m.
    //
    // `cellUnderfoot` asks the same of the chunk she is STANDING ON, and is what
    // the panel prints. The split rule refines by range, so whatever the camera is
    // nearest is almost always at the depth cap and `finestCell` reads 6.3 cm
    // essentially forever -- true, useless, and easy to mistake for a claim about
    // the ground in front of you. cellUnderfoot coarsens as she climbs, jumps while
    // a chunk under her streams in, and is null when nothing drawn covers her.
    // Both are kept; the probes read finestCell.
    this.stats = {
      desired: 0,
      rendered: 0,
      pending: 0,
      queued: 0,
      cached: 0,
      tris: 0,
      drawnTris: 0,
      slots: 0,
      lastGenMs: 0,
      lastBakeMs: 0,
      lastReliefMs: 0,
      bounds: 0,
      evictions: 0,
      stale: 0,
      invalidated: 0,
      pendingEdits: 0,
      workerBusy01: 0,
      deepest: 0,
      finestCell: 0,
      cellUnderfoot: null,
      triDeg: LOD.triDeg,
    }

    // What the mesher has taught us about the world, key -> {minY, maxY}. Input to
    // the range term in the split rule, and LEARNED rather than precomputed: the
    // worker samples the field to build the chunk anyway, so the vertical extent
    // rides back on a reply already being sent. The bootstrapping question answers
    // itself -- a node is built BEFORE the decision to split it is made, and the
    // pinned base layer seeds the top of the tree.
    //
    // Deliberately NOT the chunk cache and never evicted with it: two floats per
    // node is nothing, and walking back into a valley you left ten minutes ago has
    // the right vertical extent immediately. Dropped only for the keys an edit
    // invalidates, because a carve genuinely moves a node's floor and a stale minY
    // makes a node look nearer than it is.
    this.info = new Map()

    // The staleness floors. See stream-policy.js for the full argument; the short
    // version is that v2 cannot use v1's global epoch equality test, because a
    // chunk built under an older doc that no edit has touched is still correct.
    this._floors = makeFloors()
    this.epoch = 0

    // Keys whose geometry an edit freed and which have not come back yet. This is
    // what the panel reads to say a remesh is in flight.
    this._editPending = new Set()

    this.workers = []
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
      w.onmessage = (e) => this._onWorkerMessage(e.data)
      w.onerror = (e) => {
        // Fail loudly. A silently dead terrain worker looks like an empty world.
        throw new Error(`v2 terrain worker error: ${e.message}`)
      }
      // THE HEIGHTMAP IS COPIED PER WORKER AND EACH COPY IS TRANSFERRED.
      //
      // `data` is one Float32Array and there are N workers. Transferring it
      // DETACHES it, so the first worker gets the field and every other one a
      // zero-length husk -- and a worker meshing from an empty field produces a
      // perfectly flat world with no error anywhere, the worst failure shape
      // available here.
      //
      // Slicing wins over a bare postMessage not because it is faster (both end
      // with N copies of 4 MB and one memcpy each, at construction) but because
      // the copy is VISIBLE: with a bare postMessage nothing on the page tells a
      // future reader the buffer must not be transferred, and the obvious
      // "optimisation" of adding [data.buffer] reintroduces the flat world
      // silently. Here the thing in the transfer list provably nobody else holds.
      //
      // SharedArrayBuffer would avoid the N copies and is not available: it needs
      // COOP/COEP cross-origin isolation headers, which vite.config.js does not
      // set and which are not this file's to add.
      const copy = data.slice()
      w.postMessage(
        { type: 'init', heightmap: { width, height, data: copy, meta }, doc, relief: this.relief, epoch: this.epoch },
        [copy.buffer]
      )
      this.workers.push(w)
    }
    this._nextWorker = 0
    this._readyCount = 0

    this._seedBaseLayer()
  }

  /** Is a post-edit remesh still in flight? What the panel shows next to the tool row. */
  get pendingEdits() {
    return this._editPending.size
  }

  /**
   * Apply an edited world document and invalidate the chunks it changed.
   *
   * This replaces v1's retune(), and the difference is the point of the editor.
   * v1 changes a noise constant, which moves every metre of the world, so it frees
   * every slot and starts over. An authored edit moves a river bank: `dirtyRect`
   * is the XZ box outside which the field is bit-identical to what is already on
   * the GPU, and everything outside it KEEPS ITS GEOMETRY AND STAYS VISIBLE, so
   * dragging a control point re-meshes a few hundred metres rather than dissolving
   * the world to the base layer for the length of the drag.
   *
   * `dirtyRect === null` means everything changed -- a document load, an import, an
   * undo across a base-elevation change, or a layer that could not bound its own
   * edit. That is v1's behaviour: free every slot, clear the bounds table, re-seed
   * the base layer so the ancestor fallback still finds something, and go low-poly
   * for a moment instead of going to sky.
   *
   * The doc goes to every worker either way, and the epoch is bumped BEFORE the
   * floors are stamped so every request in flight is strictly older than the
   * invalidation it is tested against.
   */
  setLayers(doc, dirtyRect) {
    if (!doc) throw new Error('TerrainV2.setLayers: no doc')
    if (dirtyRect !== null && !validRect(dirtyRect)) {
      throw new Error(
        `TerrainV2.setLayers: dirtyRect ${JSON.stringify(dirtyRect)} is neither null nor a rect with finite minX/minZ/maxX/maxZ and max >= min`
      )
    }

    this.epoch++
    for (const w of this.workers) w.postMessage({ type: 'layers', doc, epoch: this.epoch })

    if (dirtyRect === null) this._invalidateAll()
    else this._invalidateRect(dirtyRect)

    this._dirty = true
  }

  /**
   * Apply a new set of relief knobs (height/relief.js) to every worker and remesh
   * the world. Returns true if anything actually changed, so a HUD scrub that
   * lands back on the value it started from costs nothing.
   *
   * THIS IS setLayers WITH dirtyRect === null AND IT CANNOT BE ANYTHING ELSE. A
   * relief knob is v1's retune() -- a constant that moves every metre of the world
   * -- and no rect bounds it. So every slot is freed, the bounds table cleared, the
   * base layer re-seeded so the ancestor fallback still resolves, and the world
   * goes low-poly for a moment rather than to sky.
   *
   * THE CALLER STILL OWES THE MAIN THREAD'S OWN FIELD THE SAME CALL. This posts the
   * knobs to the workers; it does not touch the V2Height that collision, the editor
   * raycast and the prop scatter read, because this object does not own it. Set one
   * and not the other and the two surfaces drift apart by metres with nothing
   * thrown -- see the constructor's note and height/relief.js. Set the field's
   * first: it is the expensive half (V2Height.setRelief with `erode` up is a
   * whole-field talus relaxation, about 190 ms of a 240 ms rebuild against 55 ms
   * with erosion off) and the workers rebuild concurrently, so the wall-clock is
   * one rebuild rather than three.
   *
   * Epoch bumped before _invalidateAll for setLayers' reason: every request in
   * flight must be strictly older than the invalidation about to test it.
   */
  setRelief(relief) {
    const next = normalizeRelief(relief)
    if (sameRelief(next, this.relief)) return false
    this.relief = next

    this.epoch++
    for (const w of this.workers) w.postMessage({ type: 'relief', relief: this.relief, epoch: this.epoch })

    this._invalidateAll()

    this._dirty = true
    return true
  }

  /**
   * Apply a sculpted patch of the COARSE FIELD ITSELF and remesh what it moved.
   *
   * setLayers replaces the authored document; this replaces texels of the import
   * underneath it, which is the one edit in v2 that is not parametric. See
   * src/v2/height/sculpt.js for why the brush writes the image rather than
   * accumulating a stroke list.
   *
   * `rect` is a half-open texel box {i0, j0, i1, j1}, `data` its contents in
   * metres, row-major and tightly packed, and `worldRect` the XZ box those texels
   * can influence -- WIDER than the texels themselves, because the coarse sample is
   * bicubic and each texel is read by a 4x4 stencil. The caller passes it because
   * the caller owns the heightmap; the widening is `rectToWorld` in sculpt.js.
   *
   * The per-worker slice is not optional: see the transfer-list argument at the
   * constructor. One array transferred to N workers leaves N-1 holding a husk, and
   * a worker with a zero-length patch throws where one with a zero-length FIELD
   * would silently mesh a plain.
   */
  patchHeight(rect, data, worldRect) {
    if (!validRect(worldRect)) {
      throw new Error(`TerrainV2.patchHeight: worldRect ${JSON.stringify(worldRect)} is not a rect with finite minX/minZ/maxX/maxZ and max >= min`)
    }
    const want = (rect.i1 - rect.i0) * (rect.j1 - rect.j0)
    if (!(want > 0) || data.length !== want) {
      throw new Error(`TerrainV2.patchHeight: rect ${JSON.stringify(rect)} wants ${want} samples, got ${data.length}`)
    }

    // Same order as setLayers: bump first, so every request already in flight is
    // strictly older than the invalidation about to be stamped over it.
    this.epoch++
    for (const w of this.workers) {
      const copy = data.slice()
      w.postMessage({ type: 'height', rect, data: copy, epoch: this.epoch }, [copy.buffer])
    }
    this._invalidateRect(worldRect)
    this._dirty = true
  }

  // The full reset. Everything cached is now wrong, so free it rather than wait
  // for eviction, and re-seed the base layer at once so the coarse fallback still
  // resolves.
  //
  // THE PINNED BASE LAYER IS HELD RATHER THAN FREED, and that exception is the
  // difference between this reading as a coarsening and as the world switching
  // off. Freeing all 21 too left the ancestor walk nothing to find for a whole
  // rebuild -- with `erode` up, ~240 ms before the first base chunk is meshed -- so
  // every relief change flashed the view to sky. setRelief is driven off a HUD
  // scrub committing every 4 px, so that was not one blink but an empty view for
  // the length of the drag, which defeats a knob you drag to watch the ridge move.
  //
  // Holding costs no new slots: these entries keep the ones they own and are
  // re-meshed in place, exactly as _invalidateRect's 'hold' does.
  _invalidateAll() {
    invalidateAll(this._floors, this.epoch)
    // These bounds describe a world that no longer exists, and a stale maxY makes
    // a node look nearer than it is, which over-refines.
    this.info.clear()

    this.stats.invalidated = this.cache.size
    for (const [key, entry] of this.cache) {
      // Slot, not state: a pinned entry still waiting for its first reply has
      // nothing to hold, and holding it would leave _seedBaseLayer's re-request
      // looking at a 'pending' entry that _send will not pick up.
      if (entry.pinned && entry.slot) {
        entry.state = 'queued'
        entry.lastUsed = this.frame
        continue
      }
      if (entry.slot) {
        this.batch.setVisibleAt(entry.slot.instanceId, false)
        entry.visible = false
        this._free.push(entry.slot)
        entry.slot = null
      }
      this.cache.delete(key)
    }
    // Both are recomputed from scratch by the next selection pass, and the held
    // entries are found again there by _isDrawable, which asks for a slot rather
    // than for a state.
    this._render.clear()
    this._standIns.clear()
    this._editPending.clear()
    this.queue.length = 0
    this._baseQueue.length = 0
    this._editQueue.length = 0
    // inFlight IS NOT ZEROED HERE, and the version that did was a slow leak. Every
    // outstanding reply still arrives and still runs `this.inFlight--` before the
    // staleness gate drops it, so zeroing left the counter at -K and permanently
    // K below the truth -- one more -K per invalidation. _pump's `inFlight < cap`
    // then never throttles, the queues go to the workers whole, and the in-flight
    // cap that guarantees a landing reply finds a free slot stops holding: the
    // symptom is `v2 terrain slot pool exhausted` thrown out of the render loop
    // after a scrub, which looks nothing like its cause.
    this._seedBaseLayer()
  }

  // The partial reset, which has no v1 counterpart.
  //
  // THE OLD CHUNK STAYS ON SCREEN UNTIL THE NEW ONE LANDS. Freeing the slot here
  // and re-requesting into an empty one made every invalidated chunk a hole for
  // the length of the bake -- and the holes went all the way through, because an
  // edit's rect also catches the PINNED depth 0-2 chunks containing it, so the
  // ancestor fallback had nothing to fall back to. Dragging a snow point or a lake
  // gizmo flashed sky at 60 Hz. Holding costs one slot per invalidated chunk for
  // one bake, affordable only because eviction counts SLOTS rather than ready
  // states (selectEvictions). What is on screen during the drag is one epoch stale,
  // which is exactly what the author is trying to change.
  //
  // The other three things per key, in order. The floor is stamped FIRST so any
  // reply in flight for that key is dead on arrival. The bounds entry is dropped,
  // because a carve moves a node's floor by metres and a stale minY over-refines
  // the ground around it. And the entry goes back to 'queued', which is what lets
  // _send pick it up again -- from 'pending' too, for a key invalidated twice
  // inside one bake, whose first reply the raised floor has already condemned.
  //
  // A key with NO slot -- merely queued, or in flight -- had nothing on screen, so
  // it is dropped outright: no hole, and the next selection asks again if it still
  // wants it. Except when pinned: the base layer is the floor under every other
  // fallback and must not thin out because an edit crossed it.
  _invalidateRect(rect) {
    const keys = invalidatedKeys(this.cache.keys(), rect)
    invalidateKeys(this._floors, keys, this.epoch)
    this.stats.invalidated = keys.length

    const requeue = []
    for (const key of keys) {
      const entry = this.cache.get(key)
      const node = entry.node
      const wasPinned = entry.pinned
      this.info.delete(key)

      const action = invalidationAction(entry)
      if (action === 'hold') {
        entry.state = 'queued'
        entry.lastUsed = this.frame
      } else {
        this._freeEntry(key, entry)
        if (action === 'drop') continue
        this._request(node).pinned = true
      }

      this._editPending.add(key)
      if (wasPinned) this._baseQueue.push(node)
      else requeue.push(node)
    }

    // Nearest-first, and re-sorted across the whole edit queue rather than
    // appended: a drag produces an invalidation every debounce interval, so the
    // queue routinely holds the leftovers of the previous one and the right order
    // is by distance to the camera NOW, not by which edit asked first.
    this._editQueue.push(...requeue)
    const near = this._nearness()
    this._editQueue.sort((a, b) => near(a) - near(b))
  }

  _nearness() {
    const cam = this._cam
    return (n) => (n.x + n.size / 2 - cam.x) ** 2 + (n.z + n.size / 2 - cam.z) ** 2
  }

  // Pin depths 0-2 (1 + 4 + 16 = 21 chunks) permanently. Without them the ancestor
  // fallback has nothing to find -- coarse nodes leave the desired set as soon as
  // they are subdivided, so they would never be requested and every not-yet-loaded
  // chunk would render as a hole through to the sky. A depth-2 chunk is 1 km across
  // at 64 m per cell: too coarse to look at, but the right shape, and roughly
  // correct ground beats a hole every time.
  //
  // Queued on _baseQueue rather than `queue`; see the constructor's three-queue
  // note for the measured reason.
  _seedBaseLayer() {
    for (let depth = 0; depth <= 2; depth++) {
      const n = 1 << depth
      const size = WORLD_SIZE / n
      for (let iz = 0; iz < n; iz++) {
        for (let ix = 0; ix < n; ix++) {
          const node = {
            key: nodeKey(depth, ix, iz),
            depth,
            ix,
            iz,
            size,
            x: -WORLD_HALF + ix * size,
            z: -WORLD_HALF + iz * size,
          }
          this._request(node).pinned = true
          this._baseQueue.push(node)
        }
      }
    }
  }

  _onWorkerMessage(msg) {
    if (msg.type === 'ready') {
      this._readyCount++
      if (this._readyCount === this.workers.length) this.ready = true
      return
    }

    // The bake acknowledgement. setLayers does not wait on it -- the chunk
    // requests behind it are ordered after it on the same port, so the doc is
    // applied before any of them is meshed -- but the bake time is the number the
    // panel needs to explain a slow drag.
    if (msg.type === 'layered') {
      this.stats.lastBakeMs = msg.bakeMs
      return
    }

    // The relief acknowledgement, recorded separately from lastBakeMs because the
    // two are far apart in cost: a layers bake is a snow grid in a few
    // milliseconds, a relief rebuild with `erode` up is a whole-field talus
    // relaxation at about 240 ms. Folding a 240 into the field the panel labels
    // "bake" would read as a bug in the layer bake. Not waited on, like 'layered':
    // the chunk requests behind it are ordered after it on the same port.
    if (msg.type === 'relieved') {
      this.stats.lastReliefMs = msg.ms
      return
    }

    if (msg.type !== 'chunk') throw new Error(`unknown v2 worker message: ${msg.type}`)

    this.inFlight--
    this.stats.lastGenMs = msg.ms

    // THE STALENESS GATE. Per-key rather than v1's global epoch equality, because
    // with partial invalidation a chunk built under an older doc that no edit
    // touched is still bit-exact. stream-policy.js carries the full reasoning and
    // the three cases; the short version is that dropping those replies would
    // stall all far-field streaming for the length of a drag.
    if (!acceptsReply(this._floors, msg.key, msg.epoch)) {
      this.stats.stale++
      // Nothing older than the newest floor can still land once the pipe is
      // empty, so this is the cheapest correct moment to release the map.
      if (this.inFlight === 0) pruneFloors(this._floors)
      return
    }

    // Record bounds BEFORE the eviction check. The range test wants this node's
    // vertical extent whether or not its geometry survived the trip -- the two are
    // cached on completely different terms, and discarding a measurement because a
    // GPU slot got recycled would make LOD depend on streaming luck.
    this.info.set(msg.key, { minY: msg.minY, maxY: msg.maxY })
    this._editPending.delete(msg.key)

    const entry = this.cache.get(msg.key)
    if (!entry) return // evicted or invalidated while in flight; drop it

    // Two accepted replies for one key would mean two slots handed to one owner
    // and one of them leaked. It is not reachable: _send only sends entries in
    // state 'queued', and the only way a key is requested twice is an
    // invalidation, which raises that key's floor above the first request's epoch.
    // Asserting it anyway, because the failure is a slow slot leak rather than
    // anything visible.
    if (entry.state === 'ready') {
      const { depth, ix, iz } = unpackKey(msg.key)
      throw new Error(`v2 chunk ${depth}/${ix}/${iz} accepted twice at epoch ${msg.epoch} -- the staleness gate let a duplicate through`)
    }

    if (msg.positions.length !== CHUNK_VERTS * 3 || msg.indices.length !== CHUNK_INDICES) {
      const { depth, ix, iz } = unpackKey(msg.key)
      throw new Error(
        `v2 chunk ${depth}/${ix}/${iz} has ${msg.positions.length / 3} verts / ${msg.indices.length} indices, ` +
          `slots are sized for ${CHUNK_VERTS} / ${CHUNK_INDICES} -- CHUNK_RES and the worker disagree`
      )
    }

    // An entry that already holds a slot is an invalidated chunk that kept its old
    // geometry on screen (_invalidateRect); it is REPLACED IN PLACE, which is the
    // point -- a fresh slot plus freeing the old one puts a frame of nothing
    // between the two and gives back the flash this exists to prevent. It also
    // needs no slot from the pool, which keeps the budget argument true while stale
    // chunks are held. Otherwise: eviction keeps slot-holding entries under
    // maxReady and that margin under SLOT_COUNT is exactly the in-flight cap, so an
    // empty pool can only mean the invariant has broken.
    const held = entry.slot !== null
    const slot = held ? entry.slot : this._free.pop()
    if (!slot) {
      throw new Error(
        `v2 terrain slot pool exhausted (${SLOT_COUNT} slots, ${this.cache.size} cached, maxReady ${this.maxReady}, ${this.inFlight} in flight)`
      )
    }

    const g = this._scratch
    g.attributes.position.array.set(msg.positions)
    g.attributes.normal.array.set(msg.normals)
    g.attributes.color.array.set(msg.colors)
    g.index.array.set(msg.indices)

    // Keep the interior heights. setGeometryAt copies the positions into the
    // batch's arena and there is no way to read them back, so this is the one
    // moment the drawn surface is legible to the CPU. 289 strided reads per
    // chunk load, against the ~360 the worker already spent building it.
    const heights = slot.heights
    for (let i = 0; i < GRID_VERTS; i++) heights[i] = msg.positions[i * 3 + 1]

    // Set the bounding sphere by hand rather than calling computeBoundingSphere,
    // which would walk every vertex on the main thread for every chunk load.
    // setGeometryAt clones this into the slot, so per-instance culling picks it up
    // and the previous occupant's bounds are discarded.
    const n = entry.node
    const half = n.size / 2
    const midY = (msg.minY + msg.maxY) / 2
    const rY = (msg.maxY - msg.minY) / 2 + msg.skirtDepth
    g.boundingSphere.center.set(half, midY, half)
    g.boundingSphere.radius = Math.hypot(half, rY, half)

    this.batch.setGeometryAt(slot.geometryId, g)
    this._mat.makeTranslation(n.x, 0, n.z)
    this.batch.setMatrixAt(slot.instanceId, this._mat)
    // A held slot keeps the visibility it already had. Hiding it here and letting
    // _syncVisibility turn it back on next frame would work -- replies are handled
    // between frames, never mid-render -- but it makes the no-flash property
    // depend on when the message pump happens to run, and that is not a thing to
    // leave to chance in the one place this file exists to get right.
    if (!held) {
      this.batch.setVisibleAt(slot.instanceId, false)
      entry.visible = false
    }

    entry.slot = slot
    entry.state = 'ready'
    entry.tris = CHUNK_INDICES / 3

    if (this.inFlight === 0) pruneFloors(this._floors)

    // Reselect on the next frame rather than waiting out the timer, so this chunk
    // replaces the coarse ancestor standing in for it immediately.
    this._dirty = true
  }

  _request(node) {
    let entry = this.cache.get(node.key)
    if (!entry) {
      entry = { node, slot: null, state: 'queued', lastUsed: this.frame, tris: 0, visible: false, pinned: false }
      this.cache.set(node.key, entry)
    }
    entry.lastUsed = this.frame
    return entry
  }

  // The single exit from the cache. Everything that drops an entry goes through
  // here so a slot can never be leaked and _editPending can never be left holding
  // a key that nothing is going to deliver.
  _freeEntry(key, entry) {
    if (entry.slot) {
      this.batch.setVisibleAt(entry.slot.instanceId, false)
      entry.visible = false
      this._free.push(entry.slot)
      entry.slot = null
    }
    this._render.delete(key)
    this._standIns.delete(key)
    this._editPending.delete(key)
    this.cache.delete(key)
  }

  _pump() {
    const cap = this._inFlightCap
    // The base layer goes first: 21 chunks, and everything else on screen is
    // standing on top of them being hole-free.
    while (this.inFlight < cap && this._baseQueue.length > 0) this._send(this._baseQueue.shift())
    // Then the ground an edit just freed, which is a hole on screen RIGHT NOW.
    // The selection's own misses are covered by an ancestor or a descendant cover;
    // these are chunks that were being drawn a frame ago and are not any more.
    while (this.inFlight < cap && this._editQueue.length > 0) this._send(this._editQueue.shift())
    while (this.inFlight < cap && this.queue.length > 0) this._send(this.queue.shift())
  }

  // Hand one queued node to a worker. A node whose entry has been dropped, or that
  // another queue already sent, is silently skipped -- all three queues can hold
  // the same key, and `state !== 'queued'` is what makes that harmless.
  _send(node) {
    const entry = this.cache.get(node.key)
    if (!entry || entry.state !== 'queued') return
    entry.state = 'pending'
    const w = this.workers[this._nextWorker]
    this._nextWorker = (this._nextWorker + 1) % this.workers.length
    w.postMessage({ type: 'chunk', key: node.key, epoch: this.epoch, ox: node.x, oz: node.z, size: node.size, res: CHUNK_RES })
    this.inFlight++
  }

  // Has this key GEOMETRY ON THE GPU right now -- which is what the stand-in walks
  // actually want to know, and is not quite the same question as "is it ready".
  // An invalidated chunk holding its old mesh while the new one bakes is
  // drawable, one epoch stale, and is a far better cover for a miss than the
  // depth-2 ancestor that is the alternative.
  _isDrawable = (key) => {
    const entry = this.cache.get(key)
    return entry !== undefined && entry.slot !== null
  }

  /**
   * Call every frame with the camera as {x, y, z, yaw}.
   *
   * Reselecting the quadtree is cheap but not free, so it only reruns on a timer,
   * or immediately when a chunk has landed or an edit has invalidated something --
   * both are moments a stand-in should stop standing in.
   */
  update(cam) {
    if (!cam) throw new Error('TerrainV2.update: no camera')
    this.frame++
    // Every frame, not just on the selection ticks: _syncVisibility's cull cone
    // reads this, and a cone that only moved at 12 Hz would let terrain wink in
    // a sixth of a second after a head turn. SELECTION still runs on the timer
    // below -- what depth a chunk is meshed at can lag a head turn, what is
    // FLAGGED VISIBLE cannot.
    this._cam = cam

    const since = this.frame - this._lastSelect
    if (since >= SELECT_EVERY_FRAMES || (this._dirty && since >= MIN_SELECT_FRAMES)) {
      this._select(cam)
      this._lastSelect = this.frame
      this._dirty = false
    }

    this._syncVisibility()
    this._pump()
    this._evict()

    const queued = this.queue.length + this._baseQueue.length + this._editQueue.length
    this.stats.queued = queued
    this.stats.pending = this.inFlight + queued
    this.stats.cached = this.cache.size
    this.stats.slots = SLOT_COUNT - this._free.length
    this.stats.pendingEdits = this._editPending.size
    // Occupancy of the in-flight window, which is the only worker-side quantity
    // the main thread can see without asking. It saturates at 1 whenever the
    // queues are deeper than the pipe, which is exactly the condition the panel
    // wants to show as "the workers are the bound right now".
    this.stats.workerBusy01 = this.inFlight / this._inFlightCap
    this.stats.triDeg = LOD.triDeg
  }

  /**
   * Force a reselection within MIN_SELECT_FRAMES instead of waiting out
   * SELECT_EVERY_FRAMES. LOD.triDeg is read inside _select, so a panel slider that
   * only mutated it would look dead for up to six frames.
   *
   * The flag is sticky, so an invalidate landing inside the floor is deferred,
   * never dropped.
   */
  invalidate() {
    this._dirty = true
  }

  _select(cam) {
    if (!cam) throw new Error('TerrainV2.update: no camera')
    this._cam = cam
    const desired = selectNodes(cam, { info: this.info })
    const render = new Set()
    const standIns = new Set()
    const queue = []
    const fine = [] // scratch for the descendant walk, reused across nodes

    // How many extra chunks the fine-stand-in path may retain this selection.
    //
    // Retaining means putting a chunk in `_render`, and eviction prefers to keep
    // anything in `_render` -- what stops the swap being yanked out from under
    // itself, and why this cannot be unbounded. A cover is made of already-resident
    // chunks, so the union of (ready desired + every descendant cover) measured no
    // larger than the desired set itself during a v1 back-away, peaking 39 chunks
    // over. The cap covers the case that is not true of; _evict's last-resort
    // reclaim makes exceeding it survivable rather than fatal. Spent
    // nearest-node-first, so what keeps detail under pressure is the ground in
    // front of her rather than whatever the quadtree emitted first.
    let standInBudget = Math.max(0, this.maxReady - desired.length - PINNED_CHUNKS)

    const misses = []
    for (const node of desired) {
      const entry = this.cache.get(node.key)
      // Slot, not state: a chunk holding stale geometry through an edit is drawn
      // as itself rather than counted as a miss, so a drag does not also spend the
      // stand-in budget covering ground that is already covered.
      if (entry && entry.slot) {
        entry.lastUsed = this.frame
        render.add(node.key)
        continue
      }
      const e = this._request(node)
      if (e.state === 'queued') queue.push(node)
      misses.push(node)
    }

    const near = this._nearness()

    // Nearest-first. Without this a fresh load order is effectively random and she
    // stands inside a hole while the horizon fills in.
    queue.sort((a, b) => near(a) - near(b))
    misses.sort((a, b) => near(a) - near(b))

    for (const node of misses) {
      // Finer first, then coarser. Keeping detail that is already on screen until
      // its replacement arrives is what makes coarsening look like a swap instead
      // of a hole -- and an ancestor is always available from the pinned base
      // layer, so asking for one first would mean never noticing that something
      // far better was already loaded.
      if (standInBudget > 0) {
        fine.length = 0
        if (loadedDescendantKeys(node.depth, node.ix, node.iz, this._isDrawable, fine) && fine.length <= standInBudget) {
          // lastUsed is stamped only on the chunks actually retained. Stamping
          // during the walk would refresh hundreds of chunks a failed cover merely
          // looked at, and scramble the LRU order eviction depends on.
          for (const key of fine) {
            this.cache.get(key).lastUsed = this.frame
            render.add(key)
            standIns.add(key)
          }
          standInBudget -= fine.length
          continue
        }
      }

      const anc = loadedAncestorKey(node.depth, node.ix, node.iz, this._isDrawable)
      if (anc !== null) {
        this.cache.get(anc).lastUsed = this.frame
        render.add(anc)
        standIns.add(anc)
      }
    }

    this.queue = queue
    this._render = render
    this._standIns = standIns
    this.stats.desired = desired.length
    this.stats.rendered = render.size
    this.stats.bounds = this.info.size
  }

  /**
   * The key of the chunk actually DRAWN at (x, z), or null if nothing covers it.
   *
   * Finest first: an ancestor standing in for a missing node covers its whole
   * extent, including siblings that are drawing themselves, so the render set is
   * not a clean partition and "the first hit walking down" would find the wrong
   * one. Fourteen integer keys and fourteen Set probes worst case; callers are
   * expected to ask about a few hundred points a frame, not tens of thousands.
   */
  groundKeyAt(x, z) {
    const u = x + WORLD_HALF
    const v = z + WORLD_HALF
    if (u < 0 || v < 0 || u >= WORLD_SIZE || v >= WORLD_SIZE) return null
    for (let d = MAX_DEPTH; d >= 0; d--) {
      const span = 1 << d
      const key = nodeKey(d, ((u / WORLD_SIZE) * span) | 0, ((v / WORLD_SIZE) * span) | 0)
      if (!this._render.has(key)) continue
      const entry = this.cache.get(key)
      if (entry && entry.slot) return key
    }
    return null
  }

  /**
   * The height of the DRAWN terrain surface at (x, z), or null if no chunk is
   * covering it yet.
   *
   * Deliberately NOT V2Height.heightAt. The field is the surface at infinite
   * resolution; what she sees is a triangle chord across a cell running from 6 cm
   * underfoot to 64 m at a kilometre and a half, and that gap is what leaves a
   * distant tree hanging in the air -- measured on the shipped heightmap, 1 cm at
   * 8 m and 4.6 m of MEAN error at 1.5 km, p95 14.7 m, more than a tree's own
   * height. Anything standing on the ground stands on the ground that is DRAWN.
   *
   * Grid spacing and diagonal are chunk-mesh-v2's, not an approximation of them:
   * same band-limited samples, same shorter-diagonal rule, so where a chunk is
   * resident this returns the drawn surface exactly.
   *
   * `key` may be passed by a caller that already resolved it (see groundKeyAt)
   * to skip the depth walk.
   */
  groundAt(x, z, key = this.groundKeyAt(x, z)) {
    if (key === null) return null
    const entry = this.cache.get(key)
    if (!entry || !entry.slot) return null
    const n = entry.node
    const step = n.size / CHUNK_RES
    let fi = (x - n.x) / step
    let fj = (z - n.z) / step
    // Clamped rather than trusted: a caller asking about a point a hair outside
    // the chunk it just resolved would otherwise index into the next row.
    let i = fi | 0
    let j = fj | 0
    if (i < 0) i = 0
    else if (i >= CHUNK_RES) i = CHUNK_RES - 1
    if (j < 0) j = 0
    else if (j >= CHUNK_RES) j = CHUNK_RES - 1
    fi -= i
    fj -= j

    const H = entry.slot.heights
    const o = j * GRID_SIDE + i
    const a = H[o] // (0, 0)
    const b = H[o + 1] // (1, 0)
    const c = H[o + GRID_SIDE] // (0, 1)
    const d = H[o + GRID_SIDE + 1] // (1, 1)

    // The shorter diagonal, exactly as the mesher chose it. Picking the other
    // one here would invent a ridge across every saddle quad and put back a
    // fraction of the error this exists to remove.
    if (Math.abs(a - d) < Math.abs(b - c)) {
      return fi >= fj
        ? a + (b - a) * fi + (d - b) * fj
        : a + (c - a) * fj + (d - c) * fi
    }
    return fi + fj <= 1
      ? a + (b - a) * fi + (c - a) * fj
      : d + (b - d) * (1 - fj) + (c - d) * (1 - fi)
  }

  // Should this node be flagged visible, given a yaw cone of `half` radians?
  //
  // THE CONE ALONE IS NOT ENOUGH: `cam.yaw` has no pitch term, so looking DOWN does
  // not move the cone at all, while in a headset it swings a large disc of ground
  // behind her feet into view. Culling on yaw alone punched a square hole under the
  // player and left the ground behind her missing out of the corner of the eye. A
  // yaw cone approximates what the eye sees near the horizon and is completely
  // wrong near the camera.
  //
  // So the cone governs the far field only and everything NEAR is kept
  // unconditionally, measured against her height above the node rather than as a
  // fixed radius, because the disc she sees looking down IS that height times a
  // constant. DOWN_K is that constant, NEAR_KEEP_M the floor when it degenerates.
  _inSight(cam, n, key, half) {
    const dx = Math.max(n.x - cam.x, 0, cam.x - (n.x + n.size))
    const dz = Math.max(n.z - cam.z, 0, cam.z - (n.z + n.size))
    // Horizontal distance to the node's box, zero when she is standing over it.
    const dxz = Math.hypot(dx, dz)
    if (dxz <= NEAR_KEEP_M) return true
    if (cam.y !== undefined) {
      const b = this.info.get(key)
      // Bounds are absent only until a node has been meshed once. Treating that
      // as "no height above it" keeps the cone in charge, which is the cheap
      // answer, not the safe one -- but an unmeshed node has no geometry to draw
      // and so cannot be the hole this guards against.
      const above = b ? cam.y - b.maxY : 0
      if (above > 0 && dxz <= above * DOWN_K) return true
    }
    return inCone(cam, n.x, n.z, n.size, half)
  }

  _syncVisibility() {
    const render = this._render
    const cam = this._cam
    let tris = 0
    let drawn = 0
    let deepest = 0
    // Deepest DRAWN chunk that actually contains her, which is a different
    // question from `deepest` and the one the panel asks. See the note on
    // cellUnderfoot in the stats block.
    let underfoot = -1
    // Both cones below are meaningless without a heading, so a caller that hands
    // us only a ground position gets the whole selection and correct terrain.
    const haveYaw = cam.yaw !== undefined
    const cullHalf = haveYaw && this.cullDeg !== null ? this.cullDeg : null
    for (const [key, entry] of this.cache) {
      if (!entry.slot) continue
      const n = entry.node
      // Selected AND, if a cull cone is configured, pointing the right way. The
      // cone is applied to VISIBILITY only, never to selection or streaming --
      // the chunk stays resident and keeps its slot, so turning around costs a
      // setVisibleAt and not a round trip through the mesher.
      const want = render.has(key) && (cullHalf === null || this._inSight(cam, n, key, cullHalf))
      if (entry.visible !== want) {
        entry.visible = want
        this.batch.setVisibleAt(entry.slot.instanceId, want)
      }
      if (!want) continue
      tris += entry.tris
      if (n.depth > deepest) deepest = n.depth
      // n.x/n.z are the node's MIN corner (quadtree-v2.js selectNodes), so this
      // is a half-open box test and exactly one drawn chunk per depth can match.
      if (n.depth > underfoot && cam.x >= n.x && cam.x < n.x + n.size && cam.z >= n.z && cam.z < n.z + n.size) {
        underfoot = n.depth
      }
      // Mirrors what BatchedMesh's per-instance culling will do on the GPU. It is
      // recomputed here rather than read back because there is nothing to read
      // back -- the cull happens during render, after this runs.
      if (!haveYaw || inCone(cam, n.x, n.z, n.size, EYE_HALF_ANGLE)) drawn += entry.tris
    }
    this.stats.tris = tris
    this.stats.drawnTris = drawn
    this.stats.deepest = deepest
    this.stats.finestCell = cellSize(deepest)
    // -1 means nothing drawn covers her at all, which is the hole the probe
    // hunts for. null rather than a fabricated number, so the panel prints ??
    // instead of quietly showing the cell of ground on the far side of the map.
    this.stats.cellUnderfoot = underfoot < 0 ? null : cellSize(underfoot)
  }

  _evict() {
    // Requests that fell out of the selection are dead weight regardless of how
    // full the cache is: nothing will ever render them.
    if (this.cache.size > this.stats.desired) {
      for (const key of staleQueuedKeys(this.cache, this._lastSelect)) {
        this._freeEntry(key, this.cache.get(key))
      }
    }

    const { primary, lastResort } = selectEvictions(this.cache, {
      maxReady: this.maxReady,
      render: this._render,
      standIns: this._standIns,
    })
    for (const key of primary) this._freeEntry(key, this.cache.get(key))
    for (const key of lastResort) this._freeEntry(key, this.cache.get(key))
    this.stats.evictions += primary.length + lastResort.length
  }

  dispose() {
    for (const w of this.workers) w.terminate()
    this.cache.clear()
    this._free.length = 0
    this.scene.remove(this.batch)
    this.batch.dispose()
    this._scratch.dispose()
    this.material.dispose()
  }
}
