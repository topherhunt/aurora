import THREE from '../../three-instance.js'
import { footprint, SHAPE_RECT } from '../layers/water-bodies.js'
import { RIVER_WIDEN, RIVER_WIDEN_FRAC, drawnHalfWidth } from '../layers/paths.js'
import { ribbonVertices, discVertices, flowFrame, ribbonLod, lodIndices, LOD_FINE, LOD_STEP, LOD_STATE_FINE, LOD_STATE_COARSE, FLOW_FADE_HALF_WIDTHS, FLOW_FADE_MIN } from './ribbon.js'
import { riverRaise, RAISE_RUNGS, RUNG_AT_DEPTH } from './river-raise.js'
import { unpackKey } from '../terrain/quadtree-v2.js'

/**
 * The visible water of a v2 world: one disc per authored lake, one ribbon per authored river.
 *
 * IT REUSES src/water.js's MATERIAL, AND THAT IS THE WHOLE POINT. Everything that makes a lake read as a mirror rather than as a blue plane -- the analytic sky reflection along the reflected ray, the four drifting layers of gradient noise, the horizon-map silhouette, the thresholded glitter, the exemption from the night fog rule -- lives in that one ShaderMaterial (§11). Authoring a second water shader here would give v2 a lake that disagrees with a v1 lake about what the sky looks like, and it would disagree SLOWLY, one tuning pass at a time, which is the failure mode that never gets noticed until it is a rewrite.
 *
 * WHICH UNIFORMS ARE SHARED, since that decides whether this works at all: ALL of them. Water holds a single `this.uniforms` object, hands that same object to a single `this.material`, and `Water.update` writes `uTime` and calls `syncShading`, which writes `uTint` and `uSilTint` -- on that shared object. There is not one per-mesh uniform in the file; the meshes carry position, plus a river's `aFlow` frame, and the shader recovers everything else from world XZ. So a mesh built here is per-frame-correct the moment it uses that material, wherever it sits in the graph. Parenting under `water.group` is therefore tidiness rather than plumbing -- it keeps every water surface in the world under one node the editor can hide -- and the group must stay at the origin, because the shader reads `modelMatrix * position` as world position.
 *
 * WHAT THIS DOES NOT INHERIT FROM v1: the rivers. §11 records rivers as built, measured and removed, and the measurement is not about ribbons -- 47.4% of v1's river segments run uphill on the rendered surface because Phase A routes flow over a carved field the mesher never sees. v2 has no such split: a river here is an XZ spline whose water level PathSet solves from the ground it runs through, never rising in the flow direction; the carve cuts the channel down from that level and the ribbon is drawn at it. The surface cannot climb because the solver does not let it.
 */

// Bucket edge for the river lookup index, in metres. Query cost is a 3x3 block of buckets, so this is also the largest half-width levelAt can answer for -- a river wider than this would have samples outside the block and go silently missing. Asserted, not assumed.
const BUCKET = 64

// Slope floor for shoreDistAt's waterline term: at 1:100 a point 0.3 m over a lake plane is 30 m from its shore.
const MIN_TAN = 0.01

// Bucket key. A 32-bit hash of the cell pair rather than a template string: levelAt is on the prop scatter's inner loop and a string key per query allocates one string per bucket per candidate.
const bucketKey = (i, j) => i * 100003 + j

// levelAt's per-river scratch: the nearest segment's squared distance, level, index and foot for each river reaching the point, indexed by slot. Module-level for the same reason the key is a hash -- the scatter calls levelAt per candidate -- and the slot count is a throw rather than a growth path, because more rivers than this through one point is not a world anyone has authored.
const LEVEL_RUNS = 8
const runId = new Int32Array(LEVEL_RUNS)
const runD2 = new Float64Array(LEVEL_RUNS)
const runY = new Float64Array(LEVEL_RUNS)
const runSeg = new Int32Array(LEVEL_RUNS)
const runT = new Float64Array(LEVEL_RUNS)

// updateLod reads the terrain rung at every coarse sample of a river chunk within this many metres of the eye, and at every LOD_RUNG_STRIDE-th one beyond. Past 400 m the terrain is drawn from 16 m cells up, nodes 256 m wide and wider, so the 40 m stride can pass a node only where the ribbon clips its corner, and there the fill (the neighbours' higher rung) is at most one octave off over under 40 m of river at over 400 m.
const LOD_RUNG_NEAR = 400
const LOD_RUNG_STRIDE = 4

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
    // The widest authored river half-width in the index, which bounds how far out shoreDistAt can answer honestly -- see the throw there.
    this.maxHalfWidth = 0

    // The editor's per-object hide, as a predicate. Default: everything is
    // drawn, so nothing outside the editor has to know this exists.
    this.isVisible = () => true

    this.triangles = 0
    this.epoch = -1

    // Where the eye was, and which terrain render set was up, when the river ladders were last read; NaN forces the next updateLod to read them.
    this.lodX = NaN
    this.lodZ = NaN
    this.lodVersion = NaN
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
    this.applyVisibility()
    this.epoch = this.layers.epoch
    return { bodies: this.meshes.size, triangles: this.triangles }
  }

  /**
   * `fn(kind, id, null)` in the editor's vocabulary -- kind 'lake' or 'river' here -- returning false for a body that should not be drawn.
   *
   * HIDING IS `mesh.visible`, NOT A SKIPPED BUILD, and the difference is the whole reason this is three lines instead of one condition inside rebuild(). This class is not only a renderer: `levelAt` answers what is wet, and the prop scatter, the spawn search and the player all ask it. Hiding a lake by not building it would take it out of `lakeBoxes` too, and the author would get a lake they cannot see that the player also cannot swim in -- which is not hiding, it is deleting with the record left behind. The terrain carve is likewise untouched: hide a lake and its basin stays, which is correct, because the ground under a lake is a baked fact of the document and this button is about the overlay.
   */
  setVisibility(fn) {
    if (typeof fn !== 'function') throw new Error('WaterSurfaces.setVisibility needs a (kind, id, index) => boolean')
    this.isVisible = fn
    this.applyVisibility()
  }

  applyVisibility() {
    for (const [id, mesh] of this.meshes) mesh.visible = this.isVisible(mesh.userData.kind, id, null) !== false
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
      this.applyVisibility()
      return
    }
    const path = this.layers.paths.paths.get(id)
    if (!path) throw new Error(`WaterSurfaces.rebuildOne: no lake or path with id ${id}`)
    if (path.kind !== 'river') throw new Error(`WaterSurfaces.rebuildOne: path ${id} is a ${path.kind}, which draws no surface of its own`)
    this.buildRiver(path)
    this.reindex()
    this.applyVisibility()
  }

  buildLake(lake) {
    const { positions, indices, triangles } = discVertices(lake)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    // No normal attribute, and no aFlow. The water shader's vertex stage reads `position` and `aFlow`, and a lake wants the latter's default: a normal buffer nothing samples is upload bandwidth spent on a lie -- v1 emits normals only because its geometry predates the shader.
    geo.computeBoundingSphere()

    const mesh = new THREE.Mesh(geo, this.water.material)
    mesh.name = `v2-lake-${lake.id}`
    mesh.userData.kind = 'lake'
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
    // Unconditionally: a river whose level was re-solved keeps its samples array and rewrites the y in place, so a null check would miss it.
    void this.layers.paths.segmentCount
    if (path.samples === null) throw new Error(`WaterSurfaces: PathSet left ${path.id} unbaked; samples is still null after forcing the index`)
    return path.samples
  }

  /**
   * One mesh, one draw call, whatever the distance. The vertex buffer is static: the fine strip over the DRAWN samples (PathSet.drawnSamples: the baked samples, cut where a tributary's sheet meets its trunk's), its flow frame, and per vertex the lift that clears the drawn terrain at each of its rungs (riverRaise). The wet index keeps the full samples: past the cut the water is still there, under the trunk's. Two things move after build, both from updateLod and neither per frame: the INDEX buffer, which picks fine or coarse quads chunk by chunk, and `aRung`, one byte per vertex naming the terrain rung drawn under it, which selects the lift in the vertex shader. The index is allocated at the all-fine count and drawn to `drawRange`; a mix of states never needs more.
   */
  buildRiver(river) {
    const samples = this.samplesOf(river)
    const r = ribbonVertices(this.layers.paths.drawnSamples(river.id), { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })
    const lod = ribbonLod(r)
    // The frame the shader drifts the waves in, downstream. Lakes carry neither this nor the lift and get the material's zero defaults: the shared world frame, on the ground.
    const flow = flowFrame(r, this.layers.paths.flowsForward(river.id), this.layers.paths.flowReach(river.id))
    const { ground, peaks } = this.layers.paths.drawnGround()
    const raise = new THREE.InterleavedBuffer(riverRaise(r, lod, ground, this.layers, peaks), RAISE_RUNGS.length)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3))
    geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 4))
    geo.setAttribute('aRaise', new THREE.InterleavedBufferAttribute(raise, 4, 0))
    geo.setAttribute('aRaiseFar', new THREE.InterleavedBufferAttribute(raise, 3, 4))
    const rung = new THREE.BufferAttribute(new Uint8Array(r.count * 2), 1)
    rung.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aRung', rung)
    const index = new THREE.BufferAttribute(new Uint32Array(lod.capacity), 1)
    index.setUsage(THREE.DynamicDrawUsage)
    geo.setIndex(index)
    geo.setDrawRange(0, lodIndices(lod, index.array))
    geo.computeBoundingSphere()

    const mesh = new THREE.Mesh(geo, this.water.material)
    mesh.name = `v2-river-${river.id}`
    mesh.userData.kind = 'river'
    mesh.userData.triangles = r.triangles
    mesh.userData.lod = lod
    this.group.add(mesh)
    this.meshes.set(river.id, mesh)
    this.riverSamples.set(river.id, samples)
    this.triangles += r.triangles
    // Built all-fine and on the ground; the next updateLod reads the ladder and the rungs for it.
    this.lodX = NaN
  }

  /**
   * Read every river against the eye at (x, z) and the terrain as `ground` (TerrainV2) is drawing it: each chunk's place on the distance ladder, and under each coarse sample the rung of the resident terrain chunk. Rewrite a river's index buffer when its chunk states changed and its `aRung` when any rung did. Call it every frame: it returns at once unless the eye has moved LOD_STEP from the last read or the terrain's render set has changed since (`groundVersion`, which ticks at most at the selection rate and only on a real change), so the work -- an AABB distance per chunk, a groundKeyAt per coarse sample, an upload per changed river -- lands per ten metres walked or per re-split, never per frame. Returns the number of rivers rewritten.
   *
   * The rung is read at the coarse samples, ten metres apart, within LOD_RUNG_NEAR and at every LOD_RUNG_STRIDE-th of them beyond, plus each chunk's last so no chunk ends unread. A fine or unread coarse sample between two read ones takes the higher of their rungs: the rung is read at the ribbon's centre line, and a vertex over the seam between two terrain chunks is lifted for the coarser.
   */
  updateLod(x, z, ground) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`WaterSurfaces.updateLod: needs a finite eye position, got (${x}, ${z})`)
    if (!ground || typeof ground.groundKeyAt !== 'function' || typeof ground.groundVersion !== 'number') throw new Error('WaterSurfaces.updateLod: needs the TerrainV2, for groundKeyAt and groundVersion')
    const dx = x - this.lodX
    const dz = z - this.lodZ
    if (dx * dx + dz * dz < LOD_STEP * LOD_STEP && ground.groundVersion === this.lodVersion) return 0
    this.lodX = x
    this.lodZ = z
    this.lodVersion = ground.groundVersion

    const fine2 = LOD_FINE * LOD_FINE
    const near2 = LOD_RUNG_NEAR * LOD_RUNG_NEAR
    let rewritten = 0
    for (const mesh of this.meshes.values()) {
      const lod = mesh.userData.lod
      if (!lod) continue
      const { chunks, states, coarse } = lod
      const positions = mesh.geometry.attributes.position.array
      const rungs = mesh.geometry.attributes.aRung.array
      let changed = false
      let moved = false
      for (let c = 0; c < chunks.length; c++) {
        const b = chunks[c]
        const ex = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0
        const ez = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0
        const d2 = ex * ex + ez * ez
        const state = d2 < fine2 ? LOD_STATE_FINE : LOD_STATE_COARSE
        if (state !== states[c]) {
          states[c] = state
          changed = true
        }
        // Rungs at the read coarse samples, then filled: an unread coarse sample and every fine sample take the higher of the read samples either side.
        const stride = d2 < near2 ? 1 : LOD_RUNG_STRIDE
        let prev = -1
        let prevRung = 0
        for (let k = b.c0; k <= b.c1; k++) {
          if (k !== b.c1 && (k - b.c0) % stride !== 0) continue
          const i = coarse[k]
          const o = i * 6
          const key = ground.groundKeyAt((positions[o] + positions[o + 3]) * 0.5, (positions[o + 2] + positions[o + 5]) * 0.5)
          const rung = key === null ? 0 : RUNG_AT_DEPTH[unpackKey(key).depth]
          const from = prev < 0 ? i : prev
          const top = rung > prevRung ? rung : prevRung
          for (let j = from; j <= i; j++) {
            const v = j === i ? rung : j === prev ? prevRung : top
            if (rungs[j * 2] !== v) {
              rungs[j * 2] = v
              rungs[j * 2 + 1] = v
              moved = true
            }
          }
          prev = i
          prevRung = rung
        }
      }
      if (changed) {
        const index = mesh.geometry.index
        mesh.geometry.setDrawRange(0, lodIndices(lod, index.array))
        index.needsUpdate = true
      }
      if (moved) mesh.geometry.attributes.aRung.needsUpdate = true
      if (changed || moved) rewritten++
    }
    return rewritten
  }

  /**
   * Rebuild the river lookup index: every flattened segment binned by the buckets its endpoints fall in.
   *
   * Binning the segment's own cells rather than its cells dilated by the half-width is enough because the query reads a 3x3 block: any segment within BUCKET metres of the query point lands somewhere in that block whatever cell it was binned into. That is also exactly why a half-width past BUCKET is a throw rather than a slow path -- it would not be slower, it would be wrong, and wrong by omission, which looks like a river that simply is not wet.
   */
  reindex() {
    this.buckets.clear()
    this.maxHalfWidth = 0

    let total = 0
    for (const s of this.riverSamples.values()) total += s.length / 4
    this.idxPts = new Float32Array(total * 4)
    this.idxTail = new Uint8Array(total)
    // Which river a sample belongs to, so levelAt can keep one nearest segment per river, and its metres of arc from the run's first sample, for flowAt's fade.
    this.idxRun = new Int32Array(total)
    this.idxArc = new Float32Array(total)
    // Per run, what flowFrame gives the shader: the flow's sign along the stored order, the run's arc length and how far into other water its two ends reach.
    const runs = this.riverSamples.size
    this.runSign = new Int8Array(runs)
    this.runLength = new Float32Array(runs)
    this.runSource = new Float32Array(runs)
    this.runMouth = new Float32Array(runs)

    let g = 0
    let run = 0
    for (const [id, s] of this.riverSamples) {
      const n = s.length / 4
      let arc = 0
      for (let i = 0; i < n; i++) {
        const o = i * 4
        const d = (g + i) * 4
        if (i > 0) arc += Math.hypot(s[o] - s[o - 4], s[o + 2] - s[o - 2])
        this.idxRun[g + i] = run
        this.idxArc[g + i] = arc
        this.idxPts[d] = s[o]
        this.idxPts[d + 1] = s[o + 1]
        this.idxPts[d + 2] = s[o + 2]
        this.idxPts[d + 3] = s[o + 3]
        if (s[o + 3] > BUCKET) throw new Error(`WaterSurfaces: a river sample is ${s[o + 3].toFixed(1)} m half-width, past the ${BUCKET} m lookup bucket; levelAt would miss it`)
        if (s[o + 3] > this.maxHalfWidth) this.maxHalfWidth = s[o + 3]
      }
      // The last sample of a run starts no segment, or the index would join the end of one river to the start of the next with a segment straight across the map.
      this.idxTail[g + n - 1] = 1
      const reach = this.layers.paths.flowReach(id)
      this.runSign[run] = this.layers.paths.flowsForward(id) ? 1 : -1
      this.runLength[run] = arc
      this.runSource[run] = reach.source
      this.runMouth[run] = reach.mouth
      g += n
      run++
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
   * Each river answers with its NEAREST segment's level, which is the quad its ribbon draws over the point, and never with the highest segment reaching it: a segment's reach runs a half-width past its own ends, so the highest is up to that far upstream, and on a grade that is water over her head while she stands on the bank -- a metre and more on the shipped rapids. Across bodies, lakes and rivers alike, the HIGHEST surface wins. A river running into a lake is under the lake's still level, not beside it, and a tributary joining a trunk is under the trunk. Taking the max is also the only answer that does not depend on the order the document happens to list bodies in.
   *
   * TWO ANSWERS, AND THEY ARE DELIBERATELY DIFFERENT. By default this is the AUTHORED footprint: `footprint` feathers to zero at rx/rz, and the metre and a half the disc reaches past that exists to bury a polygon edge, not to make ground wet. That is the right answer for the prop scatter, which is the caller that made this fast, and treating the overhang as wet there would strip a band of props off both sides of every stream.
   *
   * `drawn = true` asks the other question -- where is the water you can SEE -- by widening each river sample the way the ribbon is widened, paths.js drawnHalfWidth, so the query and the geometry cannot drift. That is what the submersion test wants: the eye is under the water when it is under the polygon, not when it is under a footprint the polygon disagrees with by a metre. Cost is identical -- same 3x3 block, same scan, one add per sample -- and it is one call a frame rather than one per scatter candidate.
   *
   * It is an UPPER BOUND on tight turns, not an exact silhouette: `ribbonVertices` also narrows the ribbon through a corner by its circumradius and drops folded quads outright, and reproducing that here would mean rebuilding the geometry to ask a question about it. The residue is a few centimetres on the inside of a hairpin, which is the one place a river is least likely to be over her head.
   */
  levelAt(x, z, drawn = false) {
    let best = this.lakeLevelAt(x, z)
    const runs = this._nearestRuns(x, z, drawn)
    for (let k = 0; k < runs; k++) if (best === null || runY[k] > best) best = runY[k]
    return best
  }

  /**
   * The river current at (x, z): the unit downstream direction of the river whose surface the point floats on, into `out.x, out.z`, and the weight to apply it at -- 1 in the run of the river, fading to 0 over the same reach flowFrame fades the shader's drift at either end (a mouth in a lake, a source on a trunk), and 0 where no river reaches the point or a lake's still level stands over the river's. The direction is the nearest segment's, so a boat on a bend drifts along the bank rather than into it. One bucket scan, the same as levelAt's.
   */
  flowAt(x, z, out) {
    const runs = this._nearestRuns(x, z, false)
    if (runs === 0) return 0
    let k = 0
    for (let i = 1; i < runs; i++) if (runY[i] > runY[k]) k = i
    const lake = this.lakeLevelAt(x, z)
    if (lake !== null && lake > runY[k] + 1e-3) return 0
    const seg = runSeg[k]
    const o = seg * 4
    const ex = this.idxPts[o + 4] - this.idxPts[o]
    const ez = this.idxPts[o + 6] - this.idxPts[o + 2]
    const len = Math.hypot(ex, ez)
    const run = this.idxRun[seg]
    const sign = this.runSign[run]
    out.x = (sign * ex) / len
    out.z = (sign * ez) / len
    const t = runT[k]
    const along = this.idxArc[seg] + t * (this.idxArc[seg + 1] - this.idxArc[seg])
    const length = this.runLength[run]
    const u = sign > 0 ? along : length - along
    const hw = this.idxPts[o + 3] + t * (this.idxPts[o + 7] - this.idxPts[o + 3])
    const fade = Math.max(FLOW_FADE_HALF_WIDTHS * hw, FLOW_FADE_MIN)
    const fromSource = Math.min(1, Math.max(0, (u - this.runSource[run]) / fade))
    const fromMouth = Math.min(1, Math.max(0, (length - u - this.runMouth[run]) / fade))
    return Math.min(fromSource, fromMouth)
  }

  /** The bucket scan under levelAt and flowAt: for each river reaching (x, z), its nearest segment into the run scratch (runY the level there, runSeg the segment's first sample, runT the foot along it). Returns the count. */
  _nearestRuns(x, z, drawn) {
    let runs = 0
    const bi = Math.floor(x / BUCKET)
    const bj = Math.floor(z / BUCKET)
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const b = this.buckets.get(bucketKey(bi + di, bj + dj))
        if (!b) continue
        for (const i of b) {
          const o = i * 4
          const run = this.idxRun[i]
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
          let hw = h0 + t * (h1 - h0)
          if (drawn) hw = drawnHalfWidth(hw)
          if (d2 > hw * hw) continue
          const y = y0 + t * (y1 - y0)
          // One answer per river: its nearest segment, which is the quad the ribbon draws over the point.
          let k = 0
          while (k < runs && runId[k] !== run) k++
          if (k === runs) {
            if (runs === LEVEL_RUNS) throw new Error(`WaterSurfaces.levelAt: more than ${LEVEL_RUNS} rivers reach (${x.toFixed(1)}, ${z.toFixed(1)})`)
            runId[k] = run
            runD2[k] = Infinity
            runs++
          }
          if (d2 < runD2[k]) {
            runD2[k] = d2
            runY[k] = y
            runSeg[k] = i
            runT[k] = t
          }
        }
      }
    }
    return runs
  }

  /**
   * The lake half of levelAt: the highest LAKE surface over (x, z), or null where no lake's footprint covers it. Rivers are not consulted, which is what a caller that lives in lakes and not streams (the crabs) wants. Remember the ocean is one of these lakes and its footprint runs under the whole landscape, so this is non-null on most dry ground -- compare against the ground before reading it as water.
   */
  lakeLevelAt(x, z) {
    let best = null
    for (const b of this.lakeBoxes) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue
      if (footprint(b.lake, x, z) <= 0) continue
      if (best === null || b.lake.y > best) best = b.lake.y
    }
    return best
  }

  /** True where levelAt reports water standing above `groundY`. The predicate the scatter's exclusion actually wants, spelled once here rather than three times at three call sites. */
  isSubmerged(x, z, groundY) {
    const level = this.levelAt(x, z)
    return level !== null && groundY < level
  }

  /**
   * Signed metres from (x, z) to the nearest SHORE, clamped to [-reach, reach]: positive on dry ground, negative in the water, `reach` when nothing is within reach. The shoreline fringe the scatters read -- ferns and grass run lusher and the boulders thicker within a few metres of it on either side. `reach` itself is the "nothing near" answer, so a dry caller tests `d < reach` (strict) and a caller that may stand in the water takes |d|.
   *
   * A RIVER'S SHORE IS ITS AUTHORED HALF-WIDTH, the footprint levelAt answers wet for, because the carve cuts the channel to exactly that. A LAKE'S IS NOT ITS RIM. Every lake in the shipped world is an uncarved plane, and one of them is the ocean: a 20 km rectangle whose surface runs UNDER the whole landscape and only breaks it at the coast. Its footprint edge is nowhere near any shore, so a lake's distance is the larger of two: the footprint edge, and the waterline -- how far the ground has to run, down its own slope, to meet the surface: `(groundY - lake.y) / tan`. That is first-order, so it over-reads on a bank that steepens toward the water and under-reads on one that flattens, by a fraction of the fringe. Flat ground a hand above the plane reads as far away, which is what a plateau over a buried plane is. A carved lake gets the same rule, and it is a better answer there too: on the feather bank inside the rim the ground is above the water, and this says how far it is to the edge of it.
   *
   * The ellipse rim distance is measured along the ray from the centre, which is exact for a circle and over-reads by the eccentricity on a stretched lake -- a fringe a metre wider on the long sides of a 2:1 lake, against a fringe five to ten metres deep. The rectangle is exact.
   *
   * Same 3x3 bucket block as levelAt, which is why `reach` is bounded: a segment is binned by its own cells, so a query can only be sure of seeing every segment within BUCKET metres of the point, and a river answers to `hw + reach` from its centreline.
   *
   * @param groundY  the terrain height at (x, z), which the scatter has already looked up.
   * @param tan      the terrain slope there, as a tangent.
   */
  shoreDistAt(x, z, reach, groundY, tan) {
    const lake = this.lakeShoreDistAt(x, z, reach, groundY, tan)
    const river = this.riverShoreDistAt(x, z, reach)
    return lake < river ? lake : river
  }

  /** The river half of shoreDistAt, on the same terms and with the same clamp, lakes left out. The brook's shore: a lake's is not one. */
  riverShoreDistAt(x, z, reach) {
    if (!(reach > 0)) throw new Error(`WaterSurfaces.riverShoreDistAt: reach must be positive, got ${reach}`)
    if (reach + this.maxHalfWidth > BUCKET) {
      throw new Error(`WaterSurfaces.riverShoreDistAt: a ${reach} m reach past a ${this.maxHalfWidth.toFixed(1)} m half-width river overruns the ${BUCKET} m lookup bucket; the fringe would have holes`)
    }
    let best = reach

    const bi = Math.floor(x / BUCKET)
    const bj = Math.floor(z / BUCKET)
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const b = this.buckets.get(bucketKey(bi + di, bj + dj))
        if (!b) continue
        for (const i of b) {
          const o = i * 4
          const x0 = this.idxPts[o]
          const z0 = this.idxPts[o + 2]
          const h0 = this.idxPts[o + 3]
          const x1 = this.idxPts[o + 4]
          const z1 = this.idxPts[o + 6]
          const h1 = this.idxPts[o + 7]
          const ex = x1 - x0
          const ez = z1 - z0
          const len2 = ex * ex + ez * ez
          let t = ((x - x0) * ex + (z - z0) * ez) / len2
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const cx = x0 + t * ex
          const cz = z0 + t * ez
          const d = Math.hypot(x - cx, z - cz) - (h0 + t * (h1 - h0))
          if (d < best) best = d
        }
      }
    }

    return best < -reach ? -reach : best
  }

  /** The lake half of shoreDistAt, on the same terms and with the same clamp, rivers left out. The crabs' shore: a stream bank is not one. */
  lakeShoreDistAt(x, z, reach, groundY, tan) {
    if (!(reach > 0)) throw new Error(`WaterSurfaces.lakeShoreDistAt: reach must be positive, got ${reach}`)
    if (!Number.isFinite(groundY) || !(tan >= 0)) throw new Error(`WaterSurfaces.lakeShoreDistAt: needs the ground height and slope at the point, got ${groundY}, ${tan}`)
    let best = reach

    for (const b of this.lakeBoxes) {
      if (x < b.minX - reach || x > b.maxX + reach || z < b.minZ - reach || z > b.maxZ + reach) continue
      const lake = b.lake
      const dx = x - lake.x
      const dz = z - lake.z
      const c = Math.cos(lake.rot)
      const s = Math.sin(lake.rot)
      const lx = c * dx + s * dz
      const lz = -s * dx + c * dz
      let d
      if (lake.shape === SHAPE_RECT) {
        const ex = Math.abs(lx) - lake.rx
        const ez = Math.abs(lz) - lake.rz
        d = Math.hypot(Math.max(ex, 0), Math.max(ez, 0)) + Math.min(Math.max(ex, ez), 0)
      } else {
        const ux = lx / lake.rx
        const uz = lz / lake.rz
        const q = Math.sqrt(ux * ux + uz * uz)
        d = q < 1e-6 ? -reach : Math.hypot(lx, lz) * (1 - 1 / q)
      }
      // The waterline term. MIN_TAN keeps level ground from dividing to NaN at the surface, and puts a hand's height over a flat plane a few tens of metres from its shore.
      const line = (groundY - lake.y) / Math.max(tan, MIN_TAN)
      if (line > d) d = line
      if (d < best) best = d
    }

    return best < -reach ? -reach : best
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
