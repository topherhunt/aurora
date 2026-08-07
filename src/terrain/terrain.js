import * as THREE from 'three'
import { selectNodes, nodeKey, inCone, MAX_DEPTH, EYE_HALF_ANGLE } from './quadtree.js'
import { TUNING, SNOW, WORLD_SIZE, WORLD_HALF } from '../sim/terrain-height.js'
import { CHUNK_RES } from '../sim/chunk-mesh.js'
import { createTerrainMaterial } from './terrain-material.js'

// ---------------------------------------------------------------------------
// Terrain chunk manager: quadtree LOD, worker-fed geometry, hole-free swaps,
// and -- the reason this file looks the way it does -- ONE draw call.
//
// The obvious implementation is a THREE.Mesh per chunk. That was the first
// version, and measuring it killed it: the quadtree selects ~300-500 leaves,
// which is 300-500 draw calls for an empty world against the 60 that §0's
// on-device numbers allow. So every chunk instead lives in a fixed-size slot
// inside a single BatchedMesh, and streaming a chunk in is setGeometryAt() on
// a recycled slot rather than an add/remove from the scene graph.
//
// This works cleanly only because every chunk has IDENTICAL topology -- same
// res, therefore same vertex and index count -- so a freed slot always fits
// whatever arrives next. That is a property worth protecting: if chunk
// resolution ever varies by LOD level, the slot pool has to become size-classed
// and this gets much less pleasant.
// ---------------------------------------------------------------------------

export { CHUNK_RES }

// Derived from CHUNK_RES; every chunk is exactly this size (see chunk-mesh.js).
export const CHUNK_VERTS = (CHUNK_RES + 1) * (CHUNK_RES + 1) + 4 * (CHUNK_RES + 1)
export const CHUNK_INDICES = (CHUNK_RES * CHUNK_RES * 2 + 4 * CHUNK_RES * 2) * 3

// Slots are allocated up front and never freed, so this is a hard ceiling on
// simultaneously-resident chunks and a fixed ~16 MB of GPU buffers. It has to
// cover the worst selection at the finest triDeg the [ ] keys reach, plus the
// 21 pinned base-layer chunks, plus headroom for LRU retention -- and retention
// is not a nicety now that selection is view-dependent, it is what makes turning
// around free. Overflow throws in _onWorkerMessage rather than degrading.
//
// Re-measure with check-sim.mjs section 5 before moving MIN_TRI_DEG.
export const SLOT_COUNT = 768
const MAX_CACHED = 720

// Reselect the quadtree at ~12 Hz when nothing is streaming. At walking pace
// that is 12 cm of movement between selections, well under a leaf cell.
const SELECT_EVERY_FRAMES = 6

// Requests allowed in flight per worker.
//
// This was 6, on the theory that main-thread upload was the bound. Measured, it
// is not close: setGeometryAt costs 0.005 ms and buildChunk costs 0.393 ms, so
// the workers are the only thing doing real work here and the cap was leaving
// them idle. A reply cannot be processed until the frame after it was posted,
// so an in-flight cap of 12 means at most 12 chunks per frame no matter how
// fast the workers are -- about 17% utilisation -- while the player is looking
// at coarse stand-ins waiting for those same chunks.
//
// 32 per worker saturates them instead. The ceiling is worker throughput:
// two workers at 0.393 ms/chunk can produce ~70 chunks per 13.9 ms frame, so
// this cap no longer binds before the hardware does. That matters most on the
// Quest, where buildChunk is several times slower and the old cap would have
// throttled an already-slower generator.
//
// Raising it does not risk a hitch on the main thread, because arrivals are
// cheap; what it costs is worker CPU, which is exactly the budget that should
// be spent while the world is visibly incomplete.
const WORKER_QUEUE_DEPTH = 32

export class Terrain {
  constructor(scene, { seed = 1337, workers = 2, queueDepth = WORKER_QUEUE_DEPTH } = {}) {
    this.scene = scene
    this.queueDepth = queueDepth
    this.maxCached = MAX_CACHED

    this.material = createTerrainMaterial()

    this.batch = new THREE.BatchedMesh(
      SLOT_COUNT,
      SLOT_COUNT * CHUNK_VERTS,
      SLOT_COUNT * CHUNK_INDICES,
      this.material
    )
    this.batch.name = 'terrain'
    // The batch spans the whole 16 km world, so culling it as one object is
    // meaningless. Per-instance culling is what actually does the work, and it
    // is on by default.
    this.batch.frustumCulled = false
    this.batch.sortObjects = true // front-to-back opaque ordering (§5)
    scene.add(this.batch)

    // Scratch geometry reused for every incoming chunk. setGeometryAt copies
    // out of it immediately, so one instance serves all of them and streaming
    // produces no per-chunk garbage.
    this._scratch = new THREE.BufferGeometry()
    this._scratch.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CHUNK_VERTS * 3), 3))
    this._scratch.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(CHUNK_VERTS * 3), 3))
    this._scratch.setAttribute('color', new THREE.BufferAttribute(new Float32Array(CHUNK_VERTS * 3), 3))
    this._scratch.setIndex(new THREE.BufferAttribute(new Uint16Array(CHUNK_INDICES), 1))
    this._scratch.boundingSphere = new THREE.Sphere()

    // Bind one geometry slot to one instance permanently, 1:1. Nothing is ever
    // added or deleted after this, which sidesteps BatchedMesh's id-shuffling
    // on deleteGeometry entirely -- recycling is just setGeometryAt + setMatrixAt.
    this._free = []
    for (let i = 0; i < SLOT_COUNT; i++) {
      const geometryId = this.batch.addGeometry(this._scratch, CHUNK_VERTS, CHUNK_INDICES)
      const instanceId = this.batch.addInstance(geometryId)
      this.batch.setVisibleAt(instanceId, false)
      this._free.push({ geometryId, instanceId })
    }

    this._mat = new THREE.Matrix4()

    this.cache = new Map() // key -> {node, slot, state, lastUsed, tris, visible, pinned}
    this.queue = [] // nearest-first requests, rebuilt from scratch each selection
    this.inFlight = 0
    this.frame = 0
    this.ready = false
    this._render = new Set() // entries that should be visible right now
    this._lastSelect = -SELECT_EVERY_FRAMES
    this._dirty = true

    // `tris` is what is RESIDENT and flagged visible; `drawnTris` is the subset
    // inside the eye cone, which is what the GPU actually rasterises. The gap is
    // the streaming margin and it is large -- about 40% of the render set -- so
    // the budget question has to be asked of drawnTris.
    this.stats = { desired: 0, rendered: 0, pending: 0, cached: 0, tris: 0, drawnTris: 0, slots: 0, lastGenMs: 0, bounds: 0 }

    // What the mesher has taught us about the world, `key -> {err, minY, maxY}`.
    // This is the input to the split rule (quadtree.js) and it is LEARNED rather
    // than precomputed -- the previous design paid ~22 ms of heightAt at load,
    // and again on every tuning change, to build an elevation pyramid that the
    // rule then largely ignored.
    //
    // Learning it costs nothing extra: the worker already samples the field to
    // build the chunk, so err and the vertical extent come back on a reply that
    // was being sent anyway. The bootstrapping question -- how do you decide to
    // split a node before you have built it -- answers itself, because a node is
    // built BEFORE the decision to split it is ever made. The pinned depth 0-2
    // base layer seeds the top of the tree and detail flows down one level per
    // selection from there.
    //
    // It is deliberately NOT the chunk cache and is never evicted with it. Two
    // floats per node is nothing, and keeping it means walking back into a
    // valley you left ten minutes ago has the right vertical extent immediately.
    // retune() clears it, because then it describes a world that no longer
    // exists.
    this.seed = seed
    this.info = new Map()

    this.workers = []
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('../sim/terrain-worker.js', import.meta.url), {
        type: 'module',
      })
      w.onmessage = (e) => this._onWorkerMessage(e.data)
      w.onerror = (e) => {
        // Fail loudly. A silently dead terrain worker looks like an empty world.
        throw new Error(`terrain worker error: ${e.message}`)
      }
      w.postMessage({ type: 'init', seed })
      this.workers.push(w)
    }
    this._nextWorker = 0
    this._readyCount = 0
    // Bumped by retune(); stamped on every chunk request so replies built from
    // superseded tuning can be recognised and dropped.
    this.epoch = 0

    this._seedBaseLayer()
  }

  /**
   * Rebuild the whole world against new TUNING values, for the live tuning panel.
   *
   * The values are applied to the shared TUNING and SNOW objects rather than
   * replacing them, so main.js's own TerrainHeight -- the one the player collides
   * against -- moves with the mesh, and terrain-height.js's module-level `const T
   * = TUNING` keeps pointing at the live table. If mesh and collision ever
   * disagree she walks through hillsides.
   *
   * Everything cached is now wrong, so this frees every slot rather than waiting
   * for eviction to notice. The pinned depth 0-2 base layer is re-seeded straight
   * away, so the coarse fallback in _loadedAncestor still has something to find
   * and the world dissolves to low-poly for a moment instead of to sky.
   *
   * The per-node bounds table goes with it: the new terrain has different
   * summits, and a stale maxY makes a node look nearer than it is, which
   * over-refines. It costs nothing to discard -- unlike the elevation pyramid it
   * replaced, it is refilled by the re-streaming this method already triggers.
   */
  retune({ tuning = {}, snow = {} } = {}) {
    Object.assign(TUNING, tuning)
    Object.assign(SNOW, snow)
    this.epoch++
    for (const w of this.workers) {
      w.postMessage({ type: 'tuning', tuning, snow, epoch: this.epoch })
    }

    // These bounds describe the previous terrain.
    this.info.clear()

    for (const entry of this.cache.values()) {
      if (entry.slot) {
        this.batch.setVisibleAt(entry.slot.instanceId, false)
        this._free.push(entry.slot)
      }
    }
    this.cache.clear()
    this._render.clear()
    this.queue.length = 0
    // In-flight replies are dropped by the epoch guard, but the counter has to
    // come back or _pump stays throttled against requests that will never land.
    this.inFlight = 0
    this._seedBaseLayer()
    this._dirty = true
  }

  // Pin depths 0-2 (1 + 4 + 16 = 21 chunks) permanently.
  //
  // Without this the fallback in _loadedAncestor has nothing to find: coarse
  // nodes are never in the desired set once they have been subdivided, so they
  // would never be requested, and every not-yet-loaded chunk would render as a
  // hole straight through to the sky. A depth-2 chunk is 4 km across at 256 m
  // per cell -- far too coarse to look at, but it is the right shape, and
  // roughly-correct ground beats a hole every time.
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
          // Pushed straight onto the queue: _select never asks for these once
          // they have been subdivided away, and it rebuilds the queue from the
          // desired set, so a base-layer request would otherwise be dropped
          // before it was ever pumped.
          this.queue.push(node)
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

    if (msg.type === 'tuned') return // ack; retune() does not wait on it

    if (msg.type !== 'chunk') throw new Error(`unknown worker message: ${msg.type}`)

    this.inFlight--
    this.stats.lastGenMs = msg.ms

    // Chunks built from superseded tuning. Without this they land in the cache
    // under the same key as a re-requested node and the world keeps patches of
    // the previous terrain -- which looks like a meshing bug rather than a stale
    // read, and would be very hard to recognise while turning a slider.
    if (msg.epoch !== this.epoch) return

    // Record bounds BEFORE the eviction check. The range test wants this node's
    // vertical extent whether or not its geometry survived the trip -- the two
    // are cached on completely different terms, and discarding a measurement
    // because a GPU slot got recycled would make LOD depend on streaming luck.
    this.info.set(msg.key, { minY: msg.minY, maxY: msg.maxY })

    const entry = this.cache.get(msg.key)
    if (!entry) return // evicted while in flight; drop it

    if (msg.positions.length !== CHUNK_VERTS * 3 || msg.indices.length !== CHUNK_INDICES) {
      throw new Error(
        `chunk ${msg.key} has ${msg.positions.length / 3} verts / ${msg.indices.length} indices, ` +
          `slots are sized for ${CHUNK_VERTS} / ${CHUNK_INDICES} -- CHUNK_RES and the worker disagree`
      )
    }

    // Eviction runs every update and keeps cache.size under MAX_CACHED, and
    // slots are only held by ready entries, so this can only fire if that
    // invariant has broken.
    const slot = this._free.pop()
    if (!slot) throw new Error(`terrain slot pool exhausted (${SLOT_COUNT} slots, ${this.cache.size} cached)`)

    const g = this._scratch
    g.attributes.position.array.set(msg.positions)
    g.attributes.normal.array.set(msg.normals)
    g.attributes.color.array.set(msg.colors)
    g.index.array.set(msg.indices)

    // Set the bounding sphere by hand rather than calling computeBoundingSphere,
    // which would walk every vertex on the main thread for every chunk load.
    // setGeometryAt clones this into the slot, so per-instance culling picks it
    // up and the previous occupant's bounds are discarded.
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

    // Reselect on the next frame rather than waiting out the timer, so this
    // chunk replaces the coarse ancestor standing in for it immediately.
    this._dirty = true
  }

  _request(node) {
    let entry = this.cache.get(node.key)
    if (!entry) {
      entry = {
        node,
        slot: null,
        state: 'queued',
        lastUsed: this.frame,
        tris: 0,
        visible: false,
        pinned: false,
      }
      this.cache.set(node.key, entry)
    }
    entry.lastUsed = this.frame
    return entry
  }

  _pump() {
    const cap = this.workers.length * this.queueDepth
    while (this.inFlight < cap && this.queue.length > 0) {
      const node = this.queue.shift()
      const entry = this.cache.get(node.key)
      if (!entry || entry.state !== 'queued') continue
      entry.state = 'pending'
      const w = this.workers[this._nextWorker]
      this._nextWorker = (this._nextWorker + 1) % this.workers.length
      w.postMessage({
        type: 'chunk',
        key: node.key,
        epoch: this.epoch,
        ox: node.x,
        oz: node.z,
        size: node.size,
        res: CHUNK_RES,
      })
      this.inFlight++
    }
  }

  // Walk up the tree for a coarser chunk that already covers this area. This is
  // what makes LOD transitions hole-free without any explicit "wait for all
  // children" bookkeeping: an unloaded node just keeps showing its nearest
  // loaded ancestor, and depth 0 covers the entire world as the last resort.
  _loadedAncestor(node) {
    let d = node.depth
    let ix = node.ix
    let iz = node.iz
    while (d > 0) {
      d--
      ix >>= 1
      iz >>= 1
      const entry = this.cache.get(`${d}|${ix}|${iz}`)
      if (entry && entry.state === 'ready') return entry
    }
    return null
  }

  // Call every frame with the camera as {x, y, z, yaw}. Reselecting the quadtree
  // is cheap but not free, so it only reruns on a timer -- or immediately when a
  // chunk has landed, because that is the moment a coarse ancestor should stop
  // standing in for it.
  //
  // y and yaw are what make the rule 3D and view-dependent; both degrade to the
  // conservative answer if absent (quadtree.js), so a caller with only a ground
  // position still gets correct, merely more expensive, terrain.
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

    this.stats.pending = this.inFlight + this.queue.length
    this.stats.cached = this.cache.size
    this.stats.slots = SLOT_COUNT - this._free.length
  }

  // Force a quadtree reselection on the next update instead of waiting out
  // SELECT_EVERY_FRAMES. LOD.triDeg is read inside _select, so a tuning
  // slider that only mutated it would look dead for up to six frames.
  invalidate() {
    this._dirty = true
  }

  _select(cam) {
    const desired = selectNodes(cam, { maxDepth: MAX_DEPTH, info: this.info })
    this._cam = cam
    const render = new Set()
    const queue = []

    for (const node of desired) {
      const entry = this.cache.get(node.key)
      if (entry && entry.state === 'ready') {
        entry.lastUsed = this.frame
        render.add(entry)
        continue
      }

      const e = this._request(node)
      if (e.state === 'queued') queue.push(node)

      const anc = this._loadedAncestor(node)
      if (anc) {
        anc.lastUsed = this.frame
        render.add(anc)
      }
    }

    // Nearest-first. Without this, a fresh load order is effectively random and
    // she stands inside a hole while the horizon fills in.
    queue.sort((a, b) => {
      const da = (a.x + a.size / 2 - cam.x) ** 2 + (a.z + a.size / 2 - cam.z) ** 2
      const db = (b.x + b.size / 2 - cam.x) ** 2 + (b.z + b.size / 2 - cam.z) ** 2
      return da - db
    })

    // The queue is REBUILT, not appended to. An append-only queue grows without
    // bound while walking -- requests for chunks she left behind stay in it and
    // keep their cache entries alive, so the cache outruns maxCached (measured:
    // 1002 entries against a 720 cap over an 18 km walk) and the workers spend
    // their time generating terrain nobody is looking at any more.
    this.queue = queue
    this._render = render
    this.stats.desired = desired.length
    this.stats.rendered = render.size
    this.stats.bounds = this.info.size
  }

  _syncVisibility() {
    const render = this._render
    const cam = this._cam
    let tris = 0
    let drawn = 0
    for (const entry of this.cache.values()) {
      if (!entry.slot) continue
      const want = render.has(entry)
      if (entry.visible !== want) {
        entry.visible = want
        this.batch.setVisibleAt(entry.slot.instanceId, want)
      }
      if (!want) continue
      tris += entry.tris
      // Mirrors what BatchedMesh's per-instance culling will do on the GPU. It
      // is recomputed here rather than read back because there is nothing to
      // read back -- the cull happens during render, after this runs.
      const n = entry.node
      if (!cam || cam.yaw === undefined || inCone(cam, n.x, n.z, n.size, EYE_HALF_ANGLE)) drawn += entry.tris
    }
    this.stats.tris = tris
    this.stats.drawnTris = drawn
  }

  _evict() {
    // Requests that fell out of the selection are dead weight regardless of how
    // full the cache is: nothing will ever render them.
    if (this.cache.size > this.stats.desired) {
      for (const [key, entry] of this.cache) {
        if (entry.state === 'queued' && !entry.pinned && entry.lastUsed < this._lastSelect) {
          this.cache.delete(key)
        }
      }
    }

    if (this.cache.size <= this.maxCached) return

    const render = this._render
    const evictable = []
    for (const [key, entry] of this.cache) {
      if (entry.state !== 'ready' || entry.pinned || render.has(entry)) continue
      evictable.push([key, entry])
    }
    evictable.sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    let n = this.cache.size - this.maxCached
    for (const [key, entry] of evictable) {
      if (n-- <= 0) break
      // The slot's contents are left alone; the next occupant overwrites them.
      // Only visibility has to be cleared, or a freed instance keeps drawing.
      this.batch.setVisibleAt(entry.slot.instanceId, false)
      this._free.push(entry.slot)
      this.cache.delete(key)
    }
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
