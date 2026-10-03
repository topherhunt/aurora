import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { taken, TOLERANCE_M } from '../taken.js'
import { TILE as TREE_TILE } from './trees.js'

// ---------------------------------------------------------------------------
// STICKS: dead twigs lying under the trees, each one pickable, stowable and --
// held, with its tip lit -- a torch (fire.js's Wildfire). A near scatter: cells
// of CELL_M each roll their sticks from a hash of the seed and the cell, and a
// stick stands only within NEAR_TRUNK_M of a trunk as Trees.pureTrunksInto
// gives them, so a stick is a pure function of where it lies and `taken` (the
// registry every bed asks) stops a picked one growing back. Cells come and go
// with her, a few a frame; one InstancedMesh draws them all.
//
// THE STICK runs along Z, TIP at -Z, so a held one points where the hand does
// and a torch's flame sits at the -Z end. It is LENGTH_M long at unit scale:
// nine sides, three slightly crooked segments, ragged ends, textured with the
// interiors' plank grain (grain along the stick). A sibling of the rock and
// litter beds that shares none of their tile machinery: a stick is a few
// hundred triangles in a pool of CAP, and the whole layer is one draw.
// ---------------------------------------------------------------------------

export const KIND = 'stick'
export const LENGTH_M = 0.5
export const SIDES = 9
export const SEGMENTS = 3
// The tip, in a stick's own frame at unit scale: where a torch's flame stands.
export const TIP = new THREE.Vector3(0, 0, -LENGTH_M / 2)
// Metres of the grain texture per repeat, as the interiors' carved wood.
const WOOD_M = 0.6
const RADIUS_M = 0.014

/** The stick's geometry, deterministic: SIDES rings of SEGMENTS + 1 crooked, uneven rings along -Z..+Z, jagged at both ends. */
export function buildStickGeometry(seed = 7) {
  const rand = mulberry32(seed)
  const pos = [], uv = [], idx = []
  const rings = SEGMENTS + 1
  const half = LENGTH_M / 2
  const ringBase = []
  for (let r = 0; r < rings; r++) {
    const t = r / SEGMENTS
    const z = -half + LENGTH_M * t
    // Crooked: the middle rings stray off the axis, the ends barely.
    const bend = Math.sin(Math.PI * t)
    const cx = (rand() - 0.5) * 0.02 * bend
    const cy = (rand() - 0.5) * 0.02 * bend
    const radius = RADIUS_M * (0.85 + rand() * 0.3) * (1 - 0.1 * t)
    ringBase.push(pos.length / 3)
    for (let s = 0; s < SIDES; s++) {
      const a = ((s + (rand() - 0.5) * 0.4) / SIDES) * Math.PI * 2
      const rr = radius * (0.88 + rand() * 0.24)
      // The cut ends are ragged: each end vertex sits a little in or out along the stick.
      const jag = r === 0 || r === rings - 1 ? (rand() - 0.5) * 0.03 : 0
      pos.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z + jag)
      uv.push((z + half) / WOOD_M, ((s / SIDES) * Math.PI * 2 * RADIUS_M) / WOOD_M)
    }
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = ringBase[r] + s, b = ringBase[r] + ((s + 1) % SIDES)
      const c = ringBase[r + 1] + s, d = ringBase[r + 1] + ((s + 1) % SIDES)
      idx.push(a, b, c, b, d, c)
    }
  }
  // The ends close on a point drawn out of the ring's plane: a broken stub, not a disc.
  for (const [r, out] of [[0, -1], [rings - 1, 1]]) {
    const at = pos.length / 3
    const i0 = ringBase[r] * 3
    let x = 0, y = 0
    for (let s = 0; s < SIDES; s++) { x += pos[i0 + s * 3]; y += pos[i0 + s * 3 + 1] }
    pos.push(x / SIDES, y / SIDES, (r === 0 ? -half : half) + out * (0.01 + rand() * 0.015))
    uv.push((r === 0 ? 0 : LENGTH_M / WOOD_M), 0)
    for (let s = 0; s < SIDES; s++) {
      const a = ringBase[r] + s, b = ringBase[r] + ((s + 1) % SIDES)
      if (r === 0) idx.push(at, b, a)
      else idx.push(at, a, b)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

// Cells are CELL_M square. A cell's sticks: BASE_PER_M2 candidates a square metre, times a clumping factor that runs 0..CLUMP_MAX over CLUMP_CELLS cells, so sticks lie in drifts with bare ground between. A candidate stands only between half a stick and NEAR_TRUNK_M out from a trunk's bark.
export const CELL_M = 4
const BASE_PER_M2 = 0.06
const CLUMP_CELLS = 3
const CLUMP_MAX = 3
export const NEAR_TRUNK_M = 3
const TRUNK_MAX_M = 2
// Trees' trunk tiles held for the cells; cleared whole past this many.
const TRUNK_TILES_CAP = 32
// The scatter reaches this far; cells are made at most CELLS_PER_FRAME at a time, nearest first.
export const REACH_M = 10
const CELLS_PER_FRAME = 3
export const CAP = 512
// Stick scale per instance, and how far it is sunk into the ground, as a fraction of its radius.
const SCALE = [0.8, 1.2]
const SINK = 0.4

const hash = (seed, a, b) => {
  let h = (seed ^ Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0
  return (h ^ (h >>> 15)) >>> 0
}
const unit = (seed, a, b) => hash(seed, a, b) / 4294967296

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _f = new THREE.Vector3()
const _fwd = new THREE.Vector3(0, 0, -1)
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

export class Sticks {
  /**
   * @param ground  `{ heightAt(x, z) }`, the walkable ground
   * @param water   `{ levelAt(x, z, any) }`, null where dry; no stick lies under a lake
   * @param map     the grain texture (repeating, sRGB)
   * @param trees   Trees: pureTrunksInto, the trunks a stick must lie near
   * @param none    lay none (a village)
   */
  constructor(scene, ground, water, map, { seed = 1, none = false, cap = CAP, radius = REACH_M, trees = null } = {}) {
    if (!none && (trees === null || typeof trees.pureTrunksInto !== 'function')) throw new Error('Sticks: the trees need pureTrunksInto')
    this.ground = ground
    this.water = water
    this.trees = trees
    // Trees tile key -> [x, z, trunk radius, ...].
    this.trunkTiles = new Map()
    this.seed = seed >>> 0
    this.none = none
    this.radius = radius
    this.lies = true
    this.geometry = buildStickGeometry()
    this.material = new THREE.MeshLambertMaterial({ map, color: 0x9a7a55 })
    this.batch = new THREE.InstancedMesh(this.geometry, this.material, cap)
    this.batch.name = 'v2-sticks'
    this.batch.frustumCulled = false
    this.batch.count = 0
    this.batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    scene.add(this.batch)
    this.cap = cap
    // cell key -> { cx, cz, ids: number[] }; per instance: where it lies (centre), its tip direction's yaw, its scale.
    this.cells = new Map()
    this.free = []
    this.high = 0
    this.x = new Float32Array(cap)
    this.y = new Float32Array(cap)
    this.z = new Float32Array(cap)
    this.ax = new Float32Array(cap)
    this.ay = new Float32Array(cap)
    this.az = new Float32Array(cap)
    this.bx = new Float32Array(cap)
    this.by = new Float32Array(cap)
    this.bz = new Float32Array(cap)
    this.k = new Float32Array(cap)
    this.placed = 0
  }

  get materials() { return [this.material] }

  get stats() { return { placed: this.placed, cells: this.cells.size, cap: this.cap } }

  _take() {
    if (this.free.length > 0) return this.free.pop()
    if (this.high >= this.cap) return -1
    return this.high++
  }

  /** One stick into instance `id`: centre (x, z), tip direction angle `a`, scale `k`, lying on the ground along its length. Its tip and butt ends are kept for picking. */
  _lay(id, x, z, a, k) {
    const half = (LENGTH_M / 2) * k
    const dx = Math.cos(a), dz = Math.sin(a)
    const tx = x + dx * half, tz = z + dz * half
    const bx = x - dx * half, bz = z - dz * half
    const ty = this.ground.heightAt(tx, tz) + RADIUS_M * k * (1 - SINK)
    const by = this.ground.heightAt(bx, bz) + RADIUS_M * k * (1 - SINK)
    this.ax[id] = tx; this.ay[id] = ty; this.az[id] = tz
    this.bx[id] = bx; this.by[id] = by; this.bz[id] = bz
    this.x[id] = x; this.y[id] = (ty + by) / 2; this.z[id] = z
    this.k[id] = k
    _f.set(tx - bx, ty - by, tz - bz).normalize()
    _q.setFromUnitVectors(_fwd, _f)
    this.batch.setMatrixAt(id, _m.compose(_p.set(x, this.y[id], z), _q, _s.set(k, k, k)))
  }

  _unlay(id) {
    this.batch.setMatrixAt(id, ZERO)
    this.free.push(id)
    this.placed--
  }

  _grow(cx, cz) {
    const cell = { cx, cz, ids: [] }
    this.cells.set(`${cx},${cz}`, cell)
    if (this.none) return
    // The clump: a smooth value over the cell lattice, squared, so most ground is bare and some is strewn.
    const gx = cx / CLUMP_CELLS, gz = cz / CLUMP_CELLS
    const ix = Math.floor(gx), iz = Math.floor(gz)
    const fx = gx - ix, fz = gz - iz
    const sm = (t) => t * t * (3 - 2 * t)
    const v = (a, b) => unit(this.seed ^ 0x51c4, a, b)
    const n = v(ix, iz) * (1 - sm(fx)) * (1 - sm(fz)) + v(ix + 1, iz) * sm(fx) * (1 - sm(fz)) + v(ix, iz + 1) * (1 - sm(fx)) * sm(fz) + v(ix + 1, iz + 1) * sm(fx) * sm(fz)
    const want = BASE_PER_M2 * CELL_M * CELL_M * CLUMP_MAX * n * n
    const rand = mulberry32(hash(this.seed, cx, cz))
    const count = Math.floor(want + rand())
    const trunks = count > 0 ? this._trunksNear(cx, cz) : []
    for (let i = 0; i < count; i++) {
      // Every candidate draws the same randoms whether or not it survives, so one refusal never reshuffles the rest.
      const x = (cx + rand()) * CELL_M, z = (cz + rand()) * CELL_M
      const a = rand() * Math.PI * 2
      const k = SCALE[0] + rand() * (SCALE[1] - SCALE[0])
      if (!this._underTree(trunks, x, z)) continue
      if (taken.has(KIND, x, z)) continue
      if (this.water.isSubmerged(x, z, this.ground.heightAt(x, z))) continue
      const id = this._take()
      if (id < 0) return
      this._lay(id, x, z, a, k)
      cell.ids.push(id)
      this.placed++
    }
    this.batch.count = this.high
    this.batch.instanceMatrix.needsUpdate = true
  }

  /** The [x, z, r] trunks of every Trees tile within NEAR_TRUNK_M (plus the widest trunk) of cell (cx, cz). */
  _trunksNear(cx, cz) {
    const pad = NEAR_TRUNK_M + TRUNK_MAX_M
    const out = []
    for (let tx = Math.floor((cx * CELL_M - pad) / TREE_TILE); tx <= Math.floor(((cx + 1) * CELL_M + pad) / TREE_TILE); tx++) {
      for (let tz = Math.floor((cz * CELL_M - pad) / TREE_TILE); tz <= Math.floor(((cz + 1) * CELL_M + pad) / TREE_TILE); tz++) {
        const key = `${tx},${tz}`
        let t = this.trunkTiles.get(key)
        if (t === undefined) {
          if (this.trunkTiles.size >= TRUNK_TILES_CAP) this.trunkTiles.clear()
          t = this.trees.pureTrunksInto(tx, tz, [])
          for (let i = 2; i < t.length; i += 3) if (t[i] > TRUNK_MAX_M) throw new Error(`Sticks: a trunk of ${t[i].toFixed(2)} m past TRUNK_MAX_M`)
          this.trunkTiles.set(key, t)
        }
        for (let i = 0; i < t.length; i++) out.push(t[i])
      }
    }
    return out
  }

  /** Whether (x, z) lies clear of a trunk's bark by half a stick and within NEAR_TRUNK_M of it. */
  _underTree(trunks, x, z) {
    let near = false
    for (let i = 0; i < trunks.length; i += 3) {
      const out = Math.hypot(x - trunks[i], z - trunks[i + 1]) - trunks[i + 2]
      if (out < LENGTH_M / 2) return false
      if (out <= NEAR_TRUNK_M) near = true
    }
    return near
  }

  _drop(key) {
    const cell = this.cells.get(key)
    for (const id of cell.ids) this._unlay(id)
    this.cells.delete(key)
    if (cell.ids.length > 0) this.batch.instanceMatrix.needsUpdate = true
  }

  /** Every cell within the radius of (x, z) made now, for a first placing; the rest go through update(). */
  place(x, z) {
    this.update(x, 0, z, Infinity)
  }

  /** One frame: cells out of the radius are dropped, and up to `budget` cells inside it are grown, nearest first. */
  update(x, y, z, budget = CELLS_PER_FRAME) {
    const cx0 = Math.floor(x / CELL_M), cz0 = Math.floor(z / CELL_M)
    const reach = Math.ceil(this.radius / CELL_M)
    const far = (this.radius + CELL_M) ** 2
    for (const [key, cell] of this.cells) {
      const dx = (cell.cx + 0.5) * CELL_M - x, dz = (cell.cz + 0.5) * CELL_M - z
      if (dx * dx + dz * dz > far) this._drop(key)
    }
    const want = []
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const d2 = ((dx) * CELL_M) ** 2 + ((dz) * CELL_M) ** 2
        if (d2 > this.radius * this.radius || this.cells.has(`${cx0 + dx},${cz0 + dz}`)) continue
        want.push([d2, cx0 + dx, cz0 + dz])
      }
    }
    if (want.length === 0) return
    want.sort((a, b) => a[0] - b[0])
    for (let i = 0; i < want.length && i < budget; i++) this._grow(want[i][1], want[i][2])
  }

  /** Lay the ground again under every stick, after the relief moved. */
  reground() {
    for (const cell of this.cells.values()) {
      for (const id of cell.ids) {
        const a = Math.atan2(this.az[id] - this.bz[id], this.ax[id] - this.bx[id])
        this._lay(id, this.x[id], this.z[id], a, this.k[id])
      }
    }
    this.batch.instanceMatrix.needsUpdate = true
  }

  /** Squared distance from (x, y, z) to stick `id`'s axis, less its radius as a distance: metres. */
  _dist(id, x, y, z) {
    const ex = this.ax[id] - this.bx[id], ey = this.ay[id] - this.by[id], ez = this.az[id] - this.bz[id]
    const px = x - this.bx[id], py = y - this.by[id], pz = z - this.bz[id]
    const t = Math.max(0, Math.min(1, (px * ex + py * ey + pz * ez) / (ex * ex + ey * ey + ez * ez)))
    return Math.max(0, Math.hypot(px - ex * t, py - ey * t, pz - ez * t) - RADIUS_M * this.k[id])
  }

  /** The stick nearest (x, y, z) within `reach` metres of its surface: `{ dist, id, cell, size }` for take(), or null. For hands.js. */
  pickAt(x, y, z, reach) {
    let best = null
    let bestD = reach
    for (const cell of this.cells.values()) {
      const cdx = Math.abs((cell.cx + 0.5) * CELL_M - x), cdz = Math.abs((cell.cz + 0.5) * CELL_M - z)
      if (cdx > reach + CELL_M || cdz > reach + CELL_M) continue
      for (const id of cell.ids) {
        const d = this._dist(id, x, y, z)
        if (d < bestD) { bestD = d; best = { dist: d, id, cell, size: LENGTH_M * this.k[id] } }
      }
    }
    return best
  }

  /** The sticks lying within `r` of (x, z), as the flammables wildfire.js asks for. */
  flammablesNear(x, z, r) {
    const out = []
    for (const cell of this.cells.values()) {
      if (Math.abs((cell.cx + 0.5) * CELL_M - x) > r + CELL_M || Math.abs((cell.cz + 0.5) * CELL_M - z) > r + CELL_M) continue
      for (const id of cell.ids) {
        if (Math.hypot(this.x[id] - x, this.z[id] - z) > r + LENGTH_M) continue
        out.push({ key: `stick:${this.x[id].toFixed(2)},${this.z[id].toFixed(2)}`, kind: KIND, x: this.x[id], y: this.y[id], z: this.z[id], radius: LENGTH_M * this.k[id] / 2, height: 0.05, char: null })
      }
    }
    return out
  }

  _remove(cell, id) {
    const at = cell.ids.indexOf(id)
    if (at < 0) throw new Error(`Sticks: instance ${id} is not in its cell`)
    taken.add(KIND, this.x[id], this.z[id])
    cell.ids.splice(at, 1)
    this._unlay(id)
    this.batch.instanceMatrix.needsUpdate = true
  }

  /** The stick of a pickAt() hit up off the ground, its spot recorded so it is never laid again, as a record for hands.js. */
  take(hit) {
    const { cell, id } = hit
    const k = this.k[id]
    this._remove(cell, id)
    return { kind: KIND, name: 'stick', size: LENGTH_M * k, geometry: this.geometry, material: this.material, color: null, scale: [k, k, k], stowable: true, attrs: {}, lit: false }
  }

  /** A peer took the stick at (x, z): gone here too. For hands-net.js. */
  evict(key, x, z) {
    if (key !== KIND) return false
    for (const cell of this.cells.values()) {
      for (const id of cell.ids) {
        if (Math.abs(this.x[id] - x) >= TOLERANCE_M || Math.abs(this.z[id] - z) >= TOLERANCE_M) continue
        this._remove(cell, id)
        return true
      }
    }
    return false
  }

  /** A fresh stick, packed for a backpack slot. */
  slot() {
    return { kind: KIND, name: 'stick', size: LENGTH_M, scale: [1, 1, 1], color: null, stowable: true, attrs: {}, lit: false }
  }

  dress(slot) {
    if (slot.kind !== KIND) throw new Error(`Sticks.dress: not a stick, ${slot.kind}`)
    return { geometry: this.geometry, material: this.material }
  }

  dispose() {
    this.batch.removeFromParent()
    this.batch.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}
