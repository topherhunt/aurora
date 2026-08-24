import * as THREE from 'three'
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

// ---------------------------------------------------------------------------
// v2 terrain chunk manager: quadtree LOD over a MAX_DEPTH 13 tree, worker-fed
// geometry, hole-free swaps, partial invalidation on an edit, and ONE draw call.
//
// This is src/terrain/terrain.js's sibling and it deliberately keeps everything
// that file learned the hard way. The three things worth restating, because each
// one shipped as a visible bug in v1 before it was written down:
//
//   ONE BatchedMesh, SLOT_COUNT geometry slots bound 1:1 to instances up front,
//   and never added or deleted afterwards. The obvious implementation is a
//   THREE.Mesh per chunk; measuring it killed it, because the quadtree selects
//   hundreds of leaves and that is hundreds of draw calls for an empty world.
//   Streaming a chunk in is setGeometryAt() on a recycled slot. This works only
//   because every chunk has identical topology -- CHUNK_RES is fixed for every
//   depth -- so a freed slot always fits whatever arrives next.
//
//   FOUR separate mechanisms keep the world hole-free, and they are not
//   alternatives to each other: the pinned depth 0-2 base layer on its own queue,
//   the loaded-ancestor walk for refining, the loaded-descendant walk for
//   coarsening, and eviction counted in READY entries. Removing any one of them
//   reintroduces a specific reported artifact. See stream-policy.js, which now
//   owns the decisions, for what each one is for.
//
//   Invariant violations THROW. A slot pool that has run dry and a worker whose
//   vertex count disagrees with CHUNK_RES both take the whole frame down with a
//   legible message rather than degrading into a world with pieces missing.
//
// WHAT IS NEW IN v2, beyond depth and packed integer keys:
//
//   setLayers(doc, dirtyRect) replaces v1's retune(). v1 rebuilds the entire
//   world on every tuning change because a tuning constant moves the entire
//   world. An authored edit does not, and the editor's feel depends on that
//   distinction: dragging one river control point must re-mesh a few hundred
//   metres of ground, not the whole 8 km box. See setLayers.
//
//   The staleness gate is per-key rather than global, which is the direct
//   consequence of partial invalidation. The reasoning is long enough to live
//   next to the code that implements it, in stream-policy.js.
// ---------------------------------------------------------------------------

// Reselect the quadtree at ~12 Hz when nothing is streaming. At walking pace that
// is 12 cm of movement between selections, and at depth 13 the leaf CELL is
// 6.25 cm -- so unlike v1 this is no longer comfortably under a cell. It is still
// the right number: selection also reruns immediately whenever a chunk lands or
// an edit invalidates something (`_dirty`), which is what actually drives the
// settling of a new view, and the timer only covers the case where nothing is in
// flight and she is walking through already-resident ground. Halving it would
// double a measured 0.023 ms p50 / 0.044 ms p99 selection (check-v2-quadtree.mjs)
// to buy sub-cell reselection of terrain that is already correct.
const SELECT_EVERY_FRAMES = 6

// Requests allowed in flight per worker, and in v2 this number is bounded from
// ABOVE by the slot pool rather than only from below by worker throughput.
//
// v1 ships 32 and its comment explains why: an in-flight cap is a cap on chunks
// per frame, buildChunk is 0.393 ms against setGeometryAt's 0.005 ms, so the
// workers are the only thing doing real work and a low cap leaves them idle while
// the player looks at coarse stand-ins. All of that still holds.
//
// What does not carry over is the headroom, because the eviction target is
// SLOT_COUNT - workers * queueDepth and the current render set is EXEMPT from
// eviction. So the worst set the knob can pin down at once has to fit under that
// target, not merely under SLOT_COUNT. Measured in check-v2-terrain.mjs section
// "slot budget" over 1200 selections at MIN_TRI_DEG 1.2, which is the finest the
// [ ] keys reach:
//
//     worst selection 856 leaves + 21 pinned = 877 resident, against SLOT_COUNT 1024
//
//     queueDepth   in flight   maxReady   stand-in budget at the worst selection
//         32           64         960                83
//         24           48         976                99
//         16           32         992               115
//
// Every row fits, which is the useful finding: the world box moved twice during
// this build (16 km, then 4 km, then 8 km) and at the settled 8192 / depth 13 the
// pool is not the binding constraint on this knob. So the choice is made on margin
// rather than on arithmetic, and 24 is the conservative read of a number that is
// not yet trustworthy: the 856 comes from a synthetic ground function, not from
// `reference/skyrim-height-map.jpg`. Range is computed against the mesher's
// measured minY/maxY, so a field with more vertical relief than the fixture selects
// MORE leaves, and 83 spare chunks is a 9% margin against a field nobody has flown
// yet. Re-run this section against the real heightmap once the import lands; if 856
// holds, 32 is free.
//
// The cost of choosing 24 is 48 requests in flight rather than 64 -- at v1's
// measured 0.393 ms per chunk that is a 6 ms shallower pipeline, which is nothing.
// A full re-stream of the worst case is 877 chunks: about 18 frames at 48 per
// frame if the workers keep up.
//
// Whether they keep up is NOT yet measurable: chunk-mesh-v2.js does a bicubic tap
// plus the carve layers where v1 did fbm. This is the number to raise if the
// workers ever measure idle, and raising it means taking those slots back out of
// maxReady and re-running the ladder above.
const WORKER_QUEUE_DEPTH = 24

export class TerrainV2 {
  /**
   * @param scene         THREE.Scene to add the single BatchedMesh to.
   * @param heightmapRaw  {width, height, data: Float32Array, meta} from Heightmap.toRaw().
   * @param doc           the WorldDoc the layers bake from (Layers.serialize()).
   * @param workers       worker count.
   * @param queueDepth    requests in flight per worker; see WORKER_QUEUE_DEPTH.
   */
  constructor(scene, { heightmapRaw, doc, workers = 2, queueDepth = WORKER_QUEUE_DEPTH } = {}) {
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

    const budget = slotBudget(workers, queueDepth)
    this._inFlightCap = budget.inFlightCap
    // The eviction target, counted in READY entries -- the ones actually holding a
    // slot -- rather than in cache.size, which counts queued entries too and is a
    // different quantity by a hundred or more while anything is streaming. See
    // stream-policy.js selectEvictions for what that cost v1.
    this.maxReady = budget.maxReady

    this.material = createTerrainMaterial()

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
      this._free.push({ geometryId, instanceId })
    }

    this._mat = new THREE.Matrix4()

    // key (packed integer) -> {node, slot, state, lastUsed, tris, visible, pinned}
    this.cache = new Map()

    // THREE queues, and none of them may be merged with another.
    //
    // `queue` is the selection's, and it is REBUILT from the desired set every
    // selection rather than appended to. An append-only queue grows without bound
    // while walking: requests for ground she left behind stay in it, keep their
    // cache entries alive, and the workers spend their time generating terrain
    // nobody is looking at (v1 measured 1002 cache entries against a 720 cap over
    // an 18 km walk).
    //
    // `_baseQueue` is the pinned base layer's, and it is separate BECAUSE of that
    // rebuild. _select never asks for a depth 0-2 node once it has been
    // subdivided away, so a base-layer request parked in `queue` is discarded by
    // the first selection before _pump has ever run. That is exactly what used to
    // happen in v1: on a settled camera, depth 0 and 1 measured 0/1 and 0/4
    // resident and depth 2 measured 4/16, so the ancestor fallback was finding
    // nothing at all and returned null for ~2100 lookups over a 2 km back-away.
    // Ground drawn as sky.
    //
    // `_editQueue` is v2's own, and it is separate for the identical reason one
    // level along. The chunks a partial invalidation just freed were on screen a
    // moment ago and are holes right now, but many of them are stand-ins rather
    // than members of the desired set, so the next _select would not re-request
    // them and putting them in `queue` would simply discard them. Merging it into
    // `queue` reproduces the base-layer bug with a different trigger.
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

    // `tris` is what is RESIDENT and flagged visible; `drawnTris` is the subset
    // inside the eye cone, which is what the GPU actually rasterises. The gap is
    // the streaming margin and it is large, so the budget question has to be
    // asked of drawnTris.
    //
    // `finestCell` is the panel's headline: the real cell size of the finest
    // RENDERED chunk, in metres. Deliberately NOT of the finest selected node --
    // a selection that wants depth 13 while the streamer is still showing its
    // depth 7 ancestor would print 6 cm for ground that is visibly 2 m, which is
    // the one readout that must not lie about what is on screen.
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
      bounds: 0,
      evictions: 0,
      stale: 0,
      invalidated: 0,
      pendingEdits: 0,
      workerBusy01: 0,
      deepest: 0,
      finestCell: 0,
      triDeg: LOD.triDeg,
    }

    // What the mesher has taught us about the world, key -> {minY, maxY}. It is
    // the input to the range term in the split rule and it is LEARNED rather than
    // precomputed: the worker samples the field to build the chunk anyway, so the
    // vertical extent rides back on a reply that was being sent regardless. The
    // bootstrapping question -- how do you decide to split a node before you have
    // built it -- answers itself, because a node is built BEFORE the decision to
    // split it is ever made, and the pinned base layer seeds the top of the tree.
    //
    // Deliberately NOT the chunk cache and never evicted with it: two floats per
    // node is nothing, and keeping it means walking back into a valley you left
    // ten minutes ago has the right vertical extent immediately. It is dropped
    // only for the keys an edit invalidates, because a carve genuinely moves a
    // node's floor and a stale minY makes a node look nearer than it is.
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
      // DETACHES it, so the first worker would get the field and every other one
      // would get a zero-length husk -- and a worker that meshes from an empty
      // field produces a perfectly flat world with no error anywhere, which is
      // the single worst failure shape available here. The alternatives were
      // posting without a transfer list and letting structured clone copy it, or
      // slicing per worker and transferring the slice.
      //
      // Slicing wins, and not because it is faster -- both end with N copies of
      // 4 MB and both pay one memcpy each, once, at construction. It wins because
      // the copy is VISIBLE. With a bare postMessage there is nothing on the page
      // to tell a future reader that the buffer must not be transferred, and the
      // obvious "optimisation" of adding [data.buffer] to the call reintroduces
      // the flat-world bug silently. Here the thing in the transfer list is a
      // buffer that provably nobody else holds.
      //
      // SharedArrayBuffer would avoid the N copies outright, and it is not
      // available: it needs COOP/COEP cross-origin isolation headers, which
      // vite.config.js does not set and which are not this file's to add.
      const copy = data.slice()
      w.postMessage(
        { type: 'init', heightmap: { width, height, data: copy, meta }, doc, epoch: this.epoch },
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
   * This replaces v1's retune(), and the difference is the whole point of the
   * editor. v1 changes a noise constant, which moves every metre of the whole
   * world, so it frees every slot and starts over. An authored edit moves a river
   * bank or a snow point: `dirtyRect` is the XZ box outside which the field is
   * bit-identical to what is already on the GPU, and everything outside it KEEPS
   * ITS GEOMETRY AND STAYS VISIBLE. Dragging a control point therefore re-meshes
   * a few hundred metres of ground rather than dissolving the world to the pinned
   * base layer for the duration of the drag.
   *
   * `dirtyRect === null` means "everything changed" -- a document load, an
   * import, an undo across a base-elevation change, or a layer that could not
   * bound its own edit. That is v1's behaviour exactly: free every slot, clear the
   * bounds table, re-seed the base layer so the ancestor fallback still has
   * something to find, and let the world go low-poly for a moment instead of
   * going to sky.
   *
   * The doc goes to every worker either way, and the epoch is bumped BEFORE the
   * floors are stamped so that every request already in flight is strictly older
   * than the invalidation it is being tested against.
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

  // The full reset. Everything cached is now wrong, so free it rather than
  // waiting for eviction to notice, and re-seed the base layer straight away so
  // the coarse fallback still resolves.
  _invalidateAll() {
    invalidateAll(this._floors, this.epoch)
    // These bounds describe a world that no longer exists, and a stale maxY makes
    // a node look nearer than it is, which over-refines.
    this.info.clear()

    for (const entry of this.cache.values()) {
      if (entry.slot) {
        this.batch.setVisibleAt(entry.slot.instanceId, false)
        entry.visible = false
        this._free.push(entry.slot)
      }
    }
    this.stats.invalidated = this.cache.size
    this.cache.clear()
    this._render.clear()
    this._standIns.clear()
    this._editPending.clear()
    this.queue.length = 0
    this._baseQueue.length = 0
    this._editQueue.length = 0
    // Every in-flight reply is now below the global floor and will be dropped,
    // but the counter has to come back or _pump stays throttled against requests
    // that will never land.
    this.inFlight = 0
    this._seedBaseLayer()
  }

  // The partial reset, which has no v1 counterpart.
  //
  // Three things happen per invalidated key and the order matters. The floor is
  // stamped first so any reply already in flight for that key is dead on arrival.
  // The bounds entry is dropped, because a carve moves a node's floor by metres
  // and a stale minY would over-refine the ground around it for as long as it
  // survived. The slot is freed, and only then is the chunk re-requested, so the
  // freed slot is available to whatever lands first rather than being held by an
  // entry that is about to be overwritten anyway.
  //
  // Only chunks that were RESIDENT or PINNED are re-requested here. A key that was
  // merely queued or in flight had nothing on screen, so dropping it leaves no
  // hole and the next selection will ask again if it still wants it. A pinned key
  // is re-requested unconditionally, because the base layer is the floor under
  // every other fallback and it must not thin out just because an edit crossed it.
  _invalidateRect(rect) {
    const keys = invalidatedKeys(this.cache.keys(), rect)
    invalidateKeys(this._floors, keys, this.epoch)
    this.stats.invalidated = keys.length

    const requeue = []
    for (const key of keys) {
      const entry = this.cache.get(key)
      const node = entry.node
      const wasResident = entry.state === 'ready'
      const wasPinned = entry.pinned
      this.info.delete(key)
      this._freeEntry(key, entry)
      if (!wasResident && !wasPinned) continue
      const e = this._request(node)
      e.pinned = wasPinned
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

  // Pin depths 0-2 (1 + 4 + 16 = 21 chunks) permanently.
  //
  // Without this the ancestor fallback has nothing to find: coarse nodes leave the
  // desired set as soon as they are subdivided, so they would never be requested,
  // and every not-yet-loaded chunk would render as a hole straight through to the
  // sky. A depth-2 chunk is 1 km across at 64 m per cell -- far too coarse to
  // look at, but it is the right shape, and roughly-correct ground beats a hole
  // every time.
  //
  // Queued on _baseQueue rather than `queue`. See the constructor's note on the
  // three queues for the measured reason.
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

    // Eviction runs every update and keeps ready entries under maxReady, and the
    // margin maxReady leaves under SLOT_COUNT is exactly the in-flight cap, so
    // this can only fire if that invariant has broken.
    const slot = this._free.pop()
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
    this.batch.setVisibleAt(slot.instanceId, false)

    entry.slot = slot
    entry.visible = false
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

  _isReady = (key) => {
    const entry = this.cache.get(key)
    return entry !== undefined && entry.state === 'ready'
  }

  /**
   * Call every frame with the camera as {x, y, z, yaw}.
   *
   * Reselecting the quadtree is cheap but not free, so it only reruns on a timer,
   * or immediately when a chunk has landed or an edit has invalidated something --
   * both are moments a stand-in should stop standing in.
   */
  update(cam) {
    this.frame++

    if (this._dirty || this.frame - this._lastSelect >= SELECT_EVERY_FRAMES) {
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
   * Force a reselection on the next update instead of waiting out
   * SELECT_EVERY_FRAMES. LOD.triDeg is read inside _select, so a panel slider that
   * only mutated it would look dead for up to six frames.
   */
  invalidate() {
    this._dirty = true
  }

  _select(cam) {
    if (!cam) throw new Error('TerrainV2.update: no camera')
    this._cam = cam
    const desired = selectNodes(cam, { maxDepth: MAX_DEPTH, info: this.info })
    const render = new Set()
    const standIns = new Set()
    const queue = []
    const fine = [] // scratch for the descendant walk, reused across nodes

    // How many extra chunks the fine-stand-in path may retain this selection.
    //
    // Retaining a chunk means putting it in `_render`, and eviction prefers to
    // keep anything in `_render` -- that is what stops the swap being yanked out
    // from under itself, and it is also why this cannot be unbounded. A cover is
    // made of chunks that were already resident, so the union of (ready desired
    // chunks + every descendant cover) measured no larger than the desired set
    // itself during a v1 back-away, peaking 39 chunks over. The cap is here for
    // the case that is not true of, and the last-resort reclaim in _evict is what
    // makes exceeding it survivable rather than fatal.
    //
    // Spent nearest-node-first, so what keeps its detail under pressure is the
    // ground in front of her rather than whatever the quadtree emitted first.
    let standInBudget = Math.max(0, this.maxReady - desired.length - PINNED_CHUNKS)

    const misses = []
    for (const node of desired) {
      const entry = this.cache.get(node.key)
      if (entry && entry.state === 'ready') {
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
        if (loadedDescendantKeys(node.depth, node.ix, node.iz, this._isReady, fine) && fine.length <= standInBudget) {
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

      const anc = loadedAncestorKey(node.depth, node.ix, node.iz, this._isReady)
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

  _syncVisibility() {
    const render = this._render
    const cam = this._cam
    let tris = 0
    let drawn = 0
    let deepest = 0
    for (const [key, entry] of this.cache) {
      if (!entry.slot) continue
      const want = render.has(key)
      if (entry.visible !== want) {
        entry.visible = want
        this.batch.setVisibleAt(entry.slot.instanceId, want)
      }
      if (!want) continue
      tris += entry.tris
      const n = entry.node
      if (n.depth > deepest) deepest = n.depth
      // Mirrors what BatchedMesh's per-instance culling will do on the GPU. It is
      // recomputed here rather than read back because there is nothing to read
      // back -- the cull happens during render, after this runs.
      if (cam.yaw === undefined || inCone(cam, n.x, n.z, n.size, EYE_HALF_ANGLE)) drawn += entry.tris
    }
    this.stats.tris = tris
    this.stats.drawnTris = drawn
    this.stats.deepest = deepest
    this.stats.finestCell = cellSize(deepest)
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
