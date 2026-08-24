import * as THREE from 'three'
import { footprint } from '../layers/water-bodies.js'
import { ribbonVertices, discVertices, RIVER_WIDEN, RIVER_WIDEN_FRAC } from './ribbon.js'

/**
 * The visible water of a v2 world: one disc per authored lake, one ribbon per authored river.
 *
 * IT REUSES src/water.js's MATERIAL, AND THAT IS THE WHOLE POINT. Everything that makes a lake read as a mirror rather than as a blue plane -- the analytic sky reflection along the reflected ray, the four drifting layers of gradient noise, the horizon-map silhouette, the thresholded glitter, the exemption from the night fog rule -- lives in that one ShaderMaterial (§11). Authoring a second water shader here would give v2 a lake that disagrees with a v1 lake about what the sky looks like, and it would disagree SLOWLY, one tuning pass at a time, which is the failure mode that never gets noticed until it is a rewrite.
 *
 * WHICH UNIFORMS ARE SHARED, since that decides whether this works at all: ALL of them. Water holds a single `this.uniforms` object, hands that same object to a single `this.material`, and `Water.update` writes `uTime` and calls `syncShading`, which writes `uTint` and `uSilTint` -- on that shared object. There is not one per-mesh uniform in the file; the meshes carry nothing but position and the shader recovers everything else from world XZ. So a mesh built here is per-frame-correct the moment it uses that material, wherever it sits in the graph. Parenting under `water.group` is therefore tidiness rather than plumbing -- it keeps every water surface in the world under one node the editor can hide -- and the group must stay at the origin, because the shader reads `modelMatrix * position` as world position.
 *
 * WHAT THIS DOES NOT INHERIT FROM v1: the rivers. §11 records rivers as built, measured and removed, and the measurement is not about ribbons -- 47.4% of v1's river segments run uphill on the rendered surface because Phase A routes flow over a carved field the mesher never sees. v2 has no such split: a river here is a hand-drawn spline carrying its own `y`, the carve cuts the channel to that same `y`, and the ribbon is drawn at it. The surface cannot climb unless someone drew it climbing.
 */

// Bucket edge for the river lookup index, in metres. Query cost is a 3x3 block of buckets, so this is also the largest half-width levelAt can answer for -- a river wider than this would have samples outside the block and go silently missing. Asserted, not assumed.
const BUCKET = 64

// Bucket key. A 32-bit hash of the cell pair rather than a template string: levelAt is on the prop scatter's inner loop and a string key per query allocates one string per bucket per candidate.
const bucketKey = (i, j) => i * 100003 + j

export class WaterSurfaces {
  constructor({ water, layers }) {
    if (!water || !water.material || !water.group) throw new Error('WaterSurfaces needs the shared Water, for its material and its group')
    if (!layers || !layers.lakes || !layers.paths) throw new Error('WaterSurfaces needs Layers, for the lake and path sets')

    this.water = water
    this.layers = layers

    this.group = new THREE.Group()
    this.group.name = 'v2-water-surfaces'
    water.group.add(this.group)

    // id -> Mesh, so rebuildOne can find and replace exactly one body. Dragging a lake gizmo at 60 Hz must not touch the rivers.
    this.meshes = new Map()
    // id -> the flattened spline it was built from, kept for levelAt. The AUTHORED half-widths, not the widened ones: the widening exists to bury a polygon edge under a bank, and treating that overhang as wet would strip a band of props off both sides of every stream, which is the mistake Water.levelAt's undilated-mask comment already records once.
    this.riverSamples = new Map()

    this.buckets = new Map()
    this.lakeBoxes = []

    this.triangles = 0
    this.epoch = -1
  }

  /** Every lake and every river, from scratch. Called when the epoch moves and nothing narrower is known. */
  rebuild() {
    for (const mesh of this.meshes.values()) mesh.geometry.dispose()
    this.meshes.clear()
    this.riverSamples.clear()
    this.group.clear()
    this.triangles = 0

    for (const lake of this.layers.lakes.lakes.values()) this.buildLake(lake)
    for (const path of this.pathRecords()) {
      if (path.kind === 'river') this.buildRiver(path)
    }

    this.reindex()
    this.epoch = this.layers.epoch
    return { bodies: this.meshes.size, triangles: this.triangles }
  }

  /**
   * One body, by id. This is the gizmo-drag path, so it is the one that has to be cheap and the one that has to not leak: the old geometry is disposed before the new one is built, because a rebuild per mousemove that leaks a BufferGeometry each time fills a GPU in about a minute of editing.
   *
   * The lookup index is rebuilt whole even for a single river, and deliberately: it is rebuilt from the cached sample arrays rather than from the splines, so it costs one pass over a few thousand floats, which is far below the cost of the geometry upload it accompanies. Incremental bucket surgery would be more code and more ways to leave a stale segment behind.
   */
  rebuildOne(id) {
    const old = this.meshes.get(id)
    if (old) {
      old.geometry.dispose()
      this.group.remove(old)
      this.meshes.delete(id)
      this.triangles -= old.userData.triangles
    }
    this.riverSamples.delete(id)

    const lake = this.layers.lakes.lakes.get(id)
    if (lake) {
      this.buildLake(lake)
      this.reindex()
      return
    }
    const path = this.layers.paths.paths.get(id)
    if (!path) throw new Error(`WaterSurfaces.rebuildOne: no lake or path with id ${id}`)
    if (path.kind !== 'river') throw new Error(`WaterSurfaces.rebuildOne: path ${id} is a ${path.kind}, which belongs to RoadSurfaces`)
    this.buildRiver(path)
    this.reindex()
  }

  buildLake(lake) {
    const { positions, indices, triangles } = discVertices(lake)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    // No normal attribute. The water shader's vertex stage reads `position` and nothing else, and a normal buffer nothing samples is upload bandwidth spent on a lie -- v1 emits normals only because its geometry predates the shader.
    geo.computeBoundingSphere()

    const mesh = new THREE.Mesh(geo, this.water.material)
    mesh.name = `v2-lake-${lake.id}`
    mesh.userData.triangles = triangles
    this.group.add(mesh)
    this.meshes.set(lake.id, mesh)
    this.triangles += triangles
  }

  /**
   * Every path record, with its flatten guaranteed fresh.
   *
   * PathSet bakes lazily -- a record whose control points were just dragged carries `samples === null` until something asks the index a question -- and `segmentCount` is the public getter that asks. One pass for the whole set regardless of how many records were dirtied, which is why it is here rather than per record.
   */
  pathRecords() {
    void this.layers.paths.segmentCount
    return this.layers.paths.paths.values()
  }

  /**
   * The path's own baked polyline, NOT a fresh flatten of its spline.
   *
   * This is the load-bearing choice in the whole file. The river carve reads PathSet's samples; if the ribbon were flattened again here at its own spacing it would land on very slightly different points, and the water surface would sit beside its channel rather than in it by a few centimetres that vary along the river. One bake, two readers.
   */
  samplesOf(path) {
    if (path.samples === null) void this.layers.paths.segmentCount
    if (path.samples === null) throw new Error(`WaterSurfaces: PathSet left ${path.id} unbaked; samples is still null after forcing the index`)
    return path.samples
  }

  buildRiver(river) {
    const samples = this.samplesOf(river)
    const r = ribbonVertices(samples, { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3))
    geo.setIndex(new THREE.BufferAttribute(r.indices, 1))
    geo.computeBoundingSphere()

    const mesh = new THREE.Mesh(geo, this.water.material)
    mesh.name = `v2-river-${river.id}`
    mesh.userData.triangles = r.triangles
    this.group.add(mesh)
    this.meshes.set(river.id, mesh)
    this.riverSamples.set(river.id, samples)
    this.triangles += r.triangles
  }

  /**
   * Rebuild the river lookup index: every flattened segment binned by the buckets its endpoints fall in.
   *
   * Binning the segment's own cells rather than its cells dilated by the half-width is enough because the query reads a 3x3 block: any segment within BUCKET metres of the query point lands somewhere in that block whatever cell it was binned into. That is also exactly why a half-width past BUCKET is a throw rather than a slow path -- it would not be slower, it would be wrong, and wrong by omission, which looks like a river that simply is not wet.
   */
  reindex() {
    this.buckets.clear()

    let total = 0
    for (const s of this.riverSamples.values()) total += s.length / 4
    this.idxPts = new Float32Array(total * 4)
    this.idxTail = new Uint8Array(total)

    let g = 0
    for (const s of this.riverSamples.values()) {
      const n = s.length / 4
      for (let i = 0; i < n; i++) {
        const o = i * 4
        const d = (g + i) * 4
        this.idxPts[d] = s[o]
        this.idxPts[d + 1] = s[o + 1]
        this.idxPts[d + 2] = s[o + 2]
        this.idxPts[d + 3] = s[o + 3]
        if (s[o + 3] > BUCKET) throw new Error(`WaterSurfaces: a river sample is ${s[o + 3].toFixed(1)} m half-width, past the ${BUCKET} m lookup bucket; levelAt would miss it`)
      }
      // The last sample of a run starts no segment, or the index would join the end of one river to the start of the next with a segment straight across the map.
      this.idxTail[g + n - 1] = 1
      g += n
    }

    for (let i = 0; i < total; i++) {
      if (this.idxTail[i]) continue
      const o = i * 4
      const x0 = this.idxPts[o]
      const z0 = this.idxPts[o + 2]
      const x1 = this.idxPts[o + 4]
      const z1 = this.idxPts[o + 6]
      const i0 = Math.floor(Math.min(x0, x1) / BUCKET)
      const i1 = Math.floor(Math.max(x0, x1) / BUCKET)
      const j0 = Math.floor(Math.min(z0, z1) / BUCKET)
      const j1 = Math.floor(Math.max(z0, z1) / BUCKET)
      for (let j = j0; j <= j1; j++) {
        for (let ii = i0; ii <= i1; ii++) {
          const key = bucketKey(ii, j)
          let b = this.buckets.get(key)
          if (!b) {
            b = []
            this.buckets.set(key, b)
          }
          b.push(i)
        }
      }
    }

    // A dozen lakes is a linear scan with an AABB reject in front of it, which is nanoseconds. If a world ever holds hundreds, these boxes are what goes into the same bucket grid the segments use -- the scan is the thing to replace, not the representation.
    this.lakeBoxes = [...this.layers.lakes.lakes.values()].map((lake) => {
      const reach = Math.hypot(lake.rx, lake.rz)
      return { lake, minX: lake.x - reach, maxX: lake.x + reach, minZ: lake.z - reach, maxZ: lake.z + reach }
    })
  }

  /**
   * The water surface elevation above (x, z), or null on dry land.
   *
   * v2's replacement for Water.levelAt, which reads a Phase A raster v2 does not have and never will. The prop scatter and the player both need this: without it every tree in the world is placed as though the lakes were not there.
   *
   * Lakes are answered before rivers, and where both cover a point the HIGHEST surface wins. A river running into a lake is under the lake's still level, not beside it, and a tributary joining a trunk is under the trunk. Taking the max is also the only answer that does not depend on the order the document happens to list bodies in.
   *
   * The authored footprint, not the drawn overhang: `footprint` feathers to zero at rx/rz, and the metre and a half the disc reaches past that exists to bury a polygon edge, not to make ground wet.
   */
  levelAt(x, z) {
    let best = null

    for (const b of this.lakeBoxes) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue
      if (footprint(b.lake, x, z) <= 0) continue
      if (best === null || b.lake.y > best) best = b.lake.y
    }

    const bi = Math.floor(x / BUCKET)
    const bj = Math.floor(z / BUCKET)
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const b = this.buckets.get(bucketKey(bi + di, bj + dj))
        if (!b) continue
        for (const i of b) {
          const o = i * 4
          const x0 = this.idxPts[o]
          const y0 = this.idxPts[o + 1]
          const z0 = this.idxPts[o + 2]
          const h0 = this.idxPts[o + 3]
          const x1 = this.idxPts[o + 4]
          const y1 = this.idxPts[o + 5]
          const z1 = this.idxPts[o + 6]
          const h1 = this.idxPts[o + 7]
          const ex = x1 - x0
          const ez = z1 - z0
          const len2 = ex * ex + ez * ez
          let t = ((x - x0) * ex + (z - z0) * ez) / len2
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const cx = x0 + t * ex
          const cz = z0 + t * ez
          const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz)
          const hw = h0 + t * (h1 - h0)
          if (d2 > hw * hw) continue
          const y = y0 + t * (y1 - y0)
          if (best === null || y > best) best = y
        }
      }
    }

    return best
  }

  /** True where levelAt reports water standing above `groundY`. The predicate the scatter's exclusion actually wants, spelled once here rather than three times at three call sites. */
  isSubmerged(x, z, groundY) {
    const level = this.levelAt(x, z)
    return level !== null && groundY < level
  }

  dispose() {
    for (const mesh of this.meshes.values()) mesh.geometry.dispose()
    this.meshes.clear()
    this.riverSamples.clear()
    this.buckets.clear()
    this.group.clear()
    // The material belongs to Water, which is shared with v1's lakes and with whatever else reflects the sky. Disposing it here would take the water out of the whole world.
    if (this.group.parent) this.group.parent.remove(this.group)
    this.triangles = 0
  }
}
