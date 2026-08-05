import * as THREE from 'three'
import { selectNodes, nodeKey, buildElevationLod, MAX_DEPTH, DEFAULT_SPLIT_K } from './quadtree.js'
import { TerrainHeight, WORLD_SIZE, WORLD_HALF } from '../sim/terrain-height.js'
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
// cover the worst selection at splitK 2.1 -- the top of the [ ] debug range --
// plus the 21 pinned base-layer chunks plus headroom for LRU retention.
//
// The elevation bias raised that worst case: swept over 600 random camera
// positions it is 721 leaves, against 577 for the unbiased rule. 721 + 21 = 742
// leaves 26 slots spare, which is thin, and it is the number to re-measure
// before touching ELEV_LOD.swing -- overflow here throws at _acquire.
export const SLOT_COUNT = 768
const MAX_CACHED = 720

// Reselect the quadtree at ~12 Hz when nothing is streaming. At walking pace
// that is 12 cm of movement between selections, well under a leaf cell.
const SELECT_EVERY_FRAMES = 6

// Requests allowed in flight per worker. The bound that matters is not worker
// time (a chunk generates in ~0.5 ms) but main-thread upload: each arrival
// costs a setGeometryAt, so this caps how much buffer traffic one frame can
// take. update() runs every frame, so the queue refills continuously rather
// than in 10 Hz bursts.
const WORKER_QUEUE_DEPTH = 6

export class Terrain {
  constructor(scene, { seed = 1337, workers = 2, splitK = DEFAULT_SPLIT_K } = {}) {
    this.scene = scene
    this.splitK = splitK
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

    this.stats = { desired: 0, rendered: 0, pending: 0, cached: 0, tris: 0, slots: 0, lastGenMs: 0 }

    // Elevation pyramid for the LOD bias (see quadtree.js). ~22 ms of heightAt,
    // once, here rather than in a worker: the selection runs on the main thread
    // at 12 Hz and cannot wait on a message round trip to know whether to split.
    //
    // Built from `seed` rather than taken as an argument even though main.js
    // already holds a TerrainHeight. Terrain cannot select nodes without the
    // height field, so it should own that dependency instead of asking every
    // caller to remember -- and a TerrainHeight is a pure function of its seed,
    // so the second instance is the same field, not a second source of truth.
    this.elev = buildElevationLod(new TerrainHeight(seed))

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

    this._seedBaseLayer()
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

    if (msg.type !== 'chunk') throw new Error(`unknown worker message: ${msg.type}`)

    this.inFlight--
    this.stats.lastGenMs = msg.ms

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
    const cap = this.workers.length * WORKER_QUEUE_DEPTH
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

  // Call every frame. Reselecting the quadtree is cheap but not free, so it
  // only reruns on a timer -- or immediately when a chunk has landed, because
  // that is the moment a coarse ancestor should stop standing in for it.
  update(camX, camZ) {
    this.frame++

    if (this._dirty || this.frame - this._lastSelect >= SELECT_EVERY_FRAMES) {
      this._select(camX, camZ)
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

  _select(camX, camZ) {
    const desired = selectNodes(camX, camZ, MAX_DEPTH, this.splitK, this.elev)
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
      const da = (a.x + a.size / 2 - camX) ** 2 + (a.z + a.size / 2 - camZ) ** 2
      const db = (b.x + b.size / 2 - camX) ** 2 + (b.z + b.size / 2 - camZ) ** 2
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
  }

  _syncVisibility() {
    const render = this._render
    let tris = 0
    for (const entry of this.cache.values()) {
      if (!entry.slot) continue
      const want = render.has(entry)
      if (entry.visible !== want) {
        entry.visible = want
        this.batch.setVisibleAt(entry.slot.instanceId, want)
      }
      if (want) tris += entry.tris
    }
    this.stats.tris = tris
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
