import * as THREE from 'three'
import { WORLD_HALF } from './sim/terrain-height.js'
import { streamWidth } from './sim/phase-a.js'

/**
 * Lake surfaces (§11), built from Phase A's lake mask.
 *
 * WHY A MASK AND NOT A PLANE PER BODY. A lake is not a disc. Filling a basin to
 * its outlet level gives a shape with arms up every tributary, and a bounding
 * box or a radius around the centroid would put water over dry ground in every
 * concave corner. The mask is the shape, so the mask is what gets drawn.
 *
 * WHY THE SHORELINE IS NOT BLOCKY. The sim grid is 8 m and a stair-stepped
 * 8 m shoreline would be obvious from the ground. So the mask is DILATED by a
 * cell before meshing, which pushes the polygon edge under the terrain rather
 * than leaving it hanging in the air. What you see as the shoreline is then the
 * line where the full-resolution terrain mesh crosses the water plane -- free,
 * exact, and as detailed as the LOD happens to be. The grid never appears.
 *
 * This works only because Phase A's `base` is sampled from the same heightAt
 * the chunk mesher uses, so a level computed on the sim grid is the same level
 * on the rendered ground. If the carved surface (breach channels) ever reaches
 * the mesher, the two agree by construction; until then the lakes are right and
 * only their outlet channels are missing.
 */

// One mesh per tile of the sim grid, so the frustum can reject most of the
// world's water instead of drawing every lake every frame.
const TILE = 64

export const WATER = {
  // Deep and desaturated: this is glacial meltwater under an overcast sky, not
  // a swimming pool. Reads almost black at grazing angles, which is what sells
  // a flat plane as a body of water.
  color: 0x2c4a63,
  opacity: 0.86,
  roughness: 0.08,
  metalness: 0.0,
  // Rivers read lighter than lakes: they are shallow, moving, and full of
  // entrained air, and a river painted in still-lake blue looks like a canal.
  streamColor: 0x486d84,
  streamOpacity: 0.75,
}

// Metres the river ribbon is lifted off the ground. Enough to clear the LOD's
// vertical error nearby without floating visibly; distant rivers sink into the
// coarser mesh and fade out, which is a graceful loss rather than an artifact.
const STREAM_LIFT = 0.35

// Metres between centreline vertices. Decoupled from the sim grid on purpose --
// see the resampling note in setStreamsFromPhaseA.
const STREAM_SPACING = 10

export class Water {
  constructor(scene) {
    this.scene = scene
    this.group = new THREE.Group()
    this.group.name = 'water'
    scene.add(this.group)
    this.material = new THREE.MeshStandardMaterial({
      color: WATER.color,
      roughness: WATER.roughness,
      metalness: WATER.metalness,
      transparent: true,
      opacity: WATER.opacity,
      // Water is horizontal and lakes do not overlap, so ordinary depth writing
      // sorts correctly and costs nothing. Turning it off here would let props
      // standing in the shallows draw through the surface.
      depthWrite: true,
      fog: true,
    })
    // Rivers ride ON the terrain rather than in a channel, so they need depth
    // help the lakes do not: a polygon offset to win the z-fight against the
    // ground it is coplanar with, and no depth writing so the ribbon never
    // occludes something standing in it.
    this.streamMaterial = new THREE.MeshStandardMaterial({
      color: WATER.streamColor,
      roughness: WATER.roughness,
      metalness: WATER.metalness,
      transparent: true,
      opacity: WATER.streamOpacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      fog: true,
    })
    // Lakes and rivers are separate subgroups, not siblings in one list. They
    // are rebuilt independently and have different materials, and a flat list
    // meant every consumer had to know which children were meshes.
    this.lakes = new THREE.Group()
    this.lakes.name = 'lakes'
    this.streams = new THREE.Group()
    this.streams.name = 'rivers'
    this.group.add(this.lakes, this.streams)
    this.bodies = 0
    this.triangles = 0
  }

  /**
   * `lake` is Phase A's 0/1 mask, `filled` the flooded surface (so `filled[c]`
   * is that cell's water level -- every cell of one body carries the same
   * value, which is what lets runs be merged without re-labelling bodies).
   *
   * `ground` is THE SURFACE ACTUALLY BEING RENDERED, and it is a separate
   * argument for a reason. Phase A detects lakes on the CARVED surface, which
   * has breach channels cut into it, and priority-flood duly finds puddles at
   * the bottom of those trenches. Measured at 512^2: 392 of 18867 lake cells
   * had the rendered ground standing up to 43 m ABOVE their own water level,
   * because the trench that made them a depression does not exist on the mesh.
   * Water inside solid rock is invisible, so this fails silently -- which is
   * why it is a check rather than a comment.
   *
   * Today the mesher builds from raw heightAt, so callers pass `base`. When the
   * carve delta reaches the chunk workers they should pass `elev` instead and
   * this filter becomes a no-op, which is the correct end state rather than
   * something to remove.
   */
  setFromPhaseA({ lake, filled, ground, n, cell }) {
    this.clear()

    // Dilate by one cell, carrying the neighbour's level in. Done into a
    // separate level array rather than in place, or the dilation would feed on
    // itself and creep a lake across a whole valley one pass at a time.
    const size = n * n
    const level = new Float32Array(size)
    const wet = new Uint8Array(size)
    const real = new Uint8Array(size)
    for (let c = 0; c < size; c++) {
      if (!lake[c]) continue
      if (ground[c] >= filled[c]) continue // a puddle in a breach trench; see above
      real[c] = 1
      wet[c] = 1
      level[c] = filled[c]
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i
        if (real[c]) continue
        let best = -Infinity
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di
            const nj = j + dj
            if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
            const d = nj * n + ni
            if (real[d] && filled[d] > best) best = filled[d]
          }
        }
        if (best > -Infinity) {
          wet[c] = 1
          level[c] = best
        }
      }
    }

    // Greedy horizontal runs: consecutive cells at the same level become one
    // quad. Lakes are blobs, so runs are long and this is worth roughly an
    // order of magnitude in triangles over a quad per cell.
    const tiles = new Map()
    for (let j = 0; j < n; j++) {
      let i = 0
      while (i < n) {
        const c = j * n + i
        if (!wet[c]) {
          i++
          continue
        }
        const y = level[c]
        let e = i + 1
        // A run also stops at a tile boundary, so every quad belongs to exactly
        // one tile and tiles stay independently cullable.
        const tileEnd = (Math.floor(i / TILE) + 1) * TILE
        while (e < n && e < tileEnd && wet[j * n + e] && level[j * n + e] === y) e++
        const key = `${Math.floor(i / TILE)},${Math.floor(j / TILE)}`
        let t = tiles.get(key)
        if (!t) {
          t = []
          tiles.set(key, t)
        }
        t.push(i, e, j, y)
        i = e
      }
    }

    const seen = new Set()
    for (const [key, runs] of tiles) {
      const quads = runs.length / 4
      const pos = new Float32Array(quads * 4 * 3)
      const idx = new Uint32Array(quads * 6)
      for (let q = 0; q < quads; q++) {
        const i0 = runs[q * 4]
        const i1 = runs[q * 4 + 1]
        const j = runs[q * 4 + 2]
        const y = runs[q * 4 + 3]
        // Cell CENTRES are the sim grid's convention, so a run covering cells
        // i0..i1-1 spans from half a cell before i0 to half a cell before i1.
        const x0 = -WORLD_HALF + i0 * cell
        const x1 = -WORLD_HALF + i1 * cell
        const z0 = -WORLD_HALF + j * cell
        const z1 = z0 + cell
        const v = q * 12
        pos[v] = x0; pos[v + 1] = y; pos[v + 2] = z0
        pos[v + 3] = x1; pos[v + 4] = y; pos[v + 5] = z0
        pos[v + 6] = x1; pos[v + 7] = y; pos[v + 8] = z1
        pos[v + 9] = x0; pos[v + 10] = y; pos[v + 11] = z1
        const a = q * 4
        const o = q * 6
        idx[o] = a; idx[o + 1] = a + 2; idx[o + 2] = a + 1
        idx[o + 3] = a; idx[o + 4] = a + 3; idx[o + 5] = a + 2
        seen.add(y)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setIndex(new THREE.BufferAttribute(idx, 1))
      // Every surface is horizontal and upward, so the normals are known and
      // computeVertexNormals would only rediscover them slowly.
      const nrm = new Float32Array(quads * 4 * 3)
      for (let k = 1; k < nrm.length; k += 3) nrm[k] = 1
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, this.material)
      mesh.name = `water-${key}`
      mesh.renderOrder = 1
      this.lakes.add(mesh)
      this.triangles += quads * 2
    }
    this.bodies = seen.size
    return { tiles: tiles.size, triangles: this.triangles, levels: this.bodies }
  }

  /**
   * Rivers, as ribbons along the flow network.
   *
   * WHY CHAINS AND NOT THE MASK. Phase A hands out `stream` as a per-cell flag,
   * and drawing a quad per flagged cell would give a 16 m-wide staircase --
   * rivers are 1-14 m across, so the grid IS the river at that resolution. What
   * carries the shape is `recv`, the D8 receiver: following it turns the mask
   * back into the paths that produced it, and a path can be smoothed and given
   * a width where a mask cannot.
   *
   * Each chain runs from a headwater to the first cell already claimed by
   * another chain, and that shared cell is included as its last point. Without
   * that the tributaries would stop one cell short of their trunk and every
   * confluence would have a visible gap.
   *
   * THE RIVERS ARE PAINTED ON, and that is a known limitation rather than an
   * oversight. Phase A carves channels into `elev`, but the chunk mesher still
   * builds from raw heightAt, so there is no groove for the water to sit in.
   * They follow the valley floors they drain, so they read correctly from the
   * ground; what they cannot do is look incised. That arrives with the carve
   * delta, and this code needs no change when it does.
   */
  setStreamsFromPhaseA({ stream, recv, acc, lake, n, cell, th, minAcc }) {
    this.clearStreams()
    const size = n * n

    // A headwater is a stream cell nothing upstream drains into.
    const indeg = new Uint8Array(size)
    for (let c = 0; c < size; c++) {
      if (!stream[c]) continue
      const r = recv[c]
      if (r >= 0 && stream[r] && indeg[r] < 255) indeg[r]++
    }

    const claimed = new Uint8Array(size)
    const chains = []
    for (let s = 0; s < size; s++) {
      if (!stream[s] || indeg[s] !== 0 || claimed[s]) continue
      const path = [s]
      claimed[s] = 1
      let c = recv[s]
      while (c >= 0) {
        // Reaching a lake is a proper ending: the river arrives, and the last
        // point sits on the water so the two meshes meet.
        if (lake[c]) {
          path.push(c)
          break
        }
        if (!stream[c]) break
        path.push(c)
        if (claimed[c]) break // joined a trunk; the shared cell closes the gap
        claimed[c] = 1
        c = recv[c]
      }
      if (path.length >= 3) chains.push(path)
    }

    // Two passes of [1,2,1]/4 on the horizontal positions only. D8 paths move
    // in 45-degree steps, which reads as a zig-zag at river width; the heights
    // are then re-sampled from the terrain so the ribbon still lies on the
    // ground it was smoothed across rather than cutting the corners in 3D.
    let quads = 0
    const perTile = new Map()
    for (const path of chains) {
      const m = path.length
      let xs = new Float32Array(m)
      let zs = new Float32Array(m)
      for (let k = 0; k < m; k++) {
        xs[k] = -WORLD_HALF + ((path[k] % n) + 0.5) * cell
        zs[k] = -WORLD_HALF + (((path[k] / n) | 0) + 0.5) * cell
      }
      for (let pass = 0; pass < 2; pass++) {
        const nx = Float32Array.from(xs)
        const nz = Float32Array.from(zs)
        for (let k = 1; k < m - 1; k++) {
          nx[k] = (xs[k - 1] + 2 * xs[k] + xs[k + 1]) / 4
          nz[k] = (zs[k - 1] + 2 * zs[k] + zs[k + 1]) / 4
        }
        xs = nx
        zs = nz
      }

      // Resample to a fixed spacing before meshing. The ribbon only touches the
      // ground where a vertex is, so between vertices it is a straight chord
      // and any convexity in the terrain pokes through it. That makes burial a
      // function of the SIM GRID, which is the wrong thing for it to depend
      // on: measured at 2 smoothing passes, 32 m cells buried 14.9% of segments
      // and 16 m cells buried 3.1%, worst case 15.9 m against 8.9 m. Smoothing
      // was not the cause -- turning it off made both slightly WORSE -- so
      // sampling density is, and a fixed spacing fixes it at every resolution.
      const rx = []
      const rz = []
      const rw = []
      for (let k = 0; k < m - 1; k++) {
        const w0 = streamWidth(acc[path[k]], minAcc) / 2
        const w1 = streamWidth(acc[path[k + 1]], minAcc) / 2
        const seg = Math.hypot(xs[k + 1] - xs[k], zs[k + 1] - zs[k])
        const steps = Math.max(1, Math.ceil(seg / STREAM_SPACING))
        for (let t2 = 0; t2 < steps; t2++) {
          const f = t2 / steps
          rx.push(xs[k] + (xs[k + 1] - xs[k]) * f)
          rz.push(zs[k] + (zs[k + 1] - zs[k]) * f)
          rw.push(w0 + (w1 - w0) * f)
        }
      }
      rx.push(xs[m - 1])
      rz.push(zs[m - 1])
      rw.push(streamWidth(acc[path[m - 1]], minAcc) / 2)
      const pts = rx.length

      const key = `${Math.floor((path[0] % n) / TILE)},${Math.floor((path[0] / n | 0) / TILE)}`
      let t = perTile.get(key)
      if (!t) {
        t = { pos: [], idx: [], nrm: [], base: 0 }
        perTile.set(key, t)
      }
      // Per-point normal in plan: the average of the two adjacent segment
      // directions, so the ribbon does not pinch or gap at a bend.
      for (let k = 0; k < pts; k++) {
        const kp = Math.max(0, k - 1)
        const kn = Math.min(pts - 1, k + 1)
        let dx = rx[kn] - rx[kp]
        let dz = rz[kn] - rz[kp]
        const len = Math.hypot(dx, dz) || 1
        dx /= len
        dz /= len
        const w = rw[k]
        // Each BANK is sampled on its own, not given the centreline's height.
        // A ribbon held level across its width sits in a V-shaped valley with
        // one bank buried in the hillside and the other hanging in the air --
        // measured at 32 m cells, 15% of segments were more than 2 m into the
        // ground with a worst case of 15.8 m. A real river surface IS level
        // across, but a real river also sits in a channel, and there is no
        // channel until the carve delta reaches the mesher. Between a wet
        // stripe that follows the ground and a level plane that floats, the
        // stripe is the one that reads as water at 1-14 m wide.
        const xl = rx[k] + dz * w
        const zl = rz[k] - dx * w
        const xr = rx[k] - dz * w
        const zr = rz[k] + dx * w
        t.pos.push(xl, th.heightAt(xl, zl) + STREAM_LIFT, zl, xr, th.heightAt(xr, zr) + STREAM_LIFT, zr)
        t.nrm.push(0, 1, 0, 0, 1, 0)
      }
      for (let k = 0; k < pts - 1; k++) {
        const a = t.base + k * 2
        t.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        quads++
      }
      t.base += pts * 2
    }

    for (const [key, t] of perTile) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(t.pos), 3))
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(t.nrm), 3))
      geo.setIndex(t.idx)
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, this.streamMaterial)
      mesh.name = `river-${key}`
      mesh.renderOrder = 2
      this.streams.add(mesh)
    }
    this.triangles += quads * 2
    return { chains: chains.length, tiles: perTile.size, triangles: quads * 2 }
  }

  clearStreams() {
    for (const m of this.streams.children) m.geometry.dispose()
    this.streams.clear()
  }

  clear() {
    for (const m of this.lakes.children) m.geometry.dispose()
    this.lakes.clear()
    this.bodies = 0
    this.triangles = 0
  }

  /** Water level under a point, or null on dry land. For the player and props. */
  levelAt() {
    throw new Error('Water.levelAt is not implemented -- nothing needs it yet')
  }
}
