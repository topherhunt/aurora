import * as THREE from 'three'
import { WORLD_HALF } from './sim/terrain-height.js'

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
 * THERE ARE NO RIVERS, AND THAT IS A MEASURED DECISION.
 *
 * Ribbons along Phase A's flow network were built, checked and rejected. Flow
 * is routed on the CARVED surface, which has ~12,000 breach channels cut
 * through ridges so the world drains; the mesh is built from raw heightAt,
 * where none of those cuts exist. Measured on seed 20260804 at 1024^2:
 *
 *   - 47.4% of river segments run UPHILL on the rendered surface (0.26% on the
 *     carved one). 409 of 457 chains climb somewhere; the worst gains 925 m.
 *   - The uphill rate is 45-50% in EVERY size band, so there is no subset of
 *     well-behaved trunk rivers to keep. Big ones are as wrong as headwaters.
 *   - Tracing by steepest descent on the rendered surface instead -- downhill
 *     by construction -- gives a median run of 39 m before it pits out. Of
 *     21,014 traces, 8 exceed 300 m and 1.7% reach a lake.
 *
 * The third number is the real one: this terrain does not drain. Rivers are not
 * a rendering problem, and no amount of splining, carving-per-chunk or width
 * tuning fixes a network whose valleys are simulation artifacts. They become
 * possible when the GENERATOR produces a draining surface -- fluvial erosion at
 * generation time -- and not before. Lakes are unaffected: they are chosen and
 * verified against the raw surface, so they sit in basins that really exist.
 *
 * This all works only because Phase A's `base` is sampled from the same heightAt
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
}

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
    this.lakes = new THREE.Group()
    this.lakes.name = 'lakes'
    this.group.add(this.lakes)
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
    this.n = n
    this.cell = cell

    // Dilate by one cell, carrying the neighbour's level in. Done into a
    // separate level array rather than in place, or the dilation would feed on
    // itself and creep a lake across a whole valley one pass at a time.
    const size = n * n
    const level = new Float32Array(size)
    const wet = new Uint8Array(size)
    const real = new Uint8Array(size)
    this.mask = real
    this.maskLevel = level
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

  clear() {
    for (const m of this.lakes.children) m.geometry.dispose()
    this.lakes.clear()
    this.bodies = 0
    this.triangles = 0
  }

  /**
   * The water surface above a point, or null on dry land. One array lookup, so
   * it is cheap enough for the scatter to ask about every candidate prop.
   *
   * Uses the UNDILATED mask. The dilation exists to bury the polygon edge under
   * the terrain, and treating that ring as wet would strip a 16 m band of trees
   * off every shoreline.
   */
  levelAt(x, z) {
    if (!this.mask) return null
    const i = Math.floor((x + WORLD_HALF) / this.cell)
    const j = Math.floor((z + WORLD_HALF) / this.cell)
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return null
    const c = j * this.n + i
    return this.mask[c] ? this.maskLevel[c] : null
  }
}
