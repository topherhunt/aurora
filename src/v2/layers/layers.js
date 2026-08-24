// ---------------------------------------------------------------------------
// Layers: the one object the height field, the mesher and the editor all hold (DESIGN.md §18).
//
// Three-free.
//
// Everything above this line is a layer that knows one thing well. Everything below it wants a single handle, because the alternative -- a mesher that imports SnowField, LakeSet and PathSet and remembers what order to call them in -- is three places that can get the order wrong instead of one.
//
// The order is not a detail. carve() runs RIVERS, then LAKES, then ROADS, and it is an order and not a set: rivers cut through whatever the coarse field left there; lakes carve their basin into the result, so a river running into a lake ends in the lake bed rather than floating over it; roads flatten LAST, so a road crossing a river reads as a causeway rather than dipping into the channel it crosses.
//
// `epoch` is the bake key. Every mutation bumps it; the chunk streamer drops any chunk stamped with a stale epoch, and takeDirtyRect() tells it WHICH chunks to re-request rather than making it re-request all of them.
// ---------------------------------------------------------------------------

import { defaultDoc, validate, serialize, IdAllocator } from './doc.js'
import { SnowField, TEXEL } from './snowline.js'
import { LakeSet } from './water-bodies.js'
import { PathSet } from './paths.js'
import { clamp01 } from '../../sim/mathx.js'
import { WORLD_HALF } from '../config.js'

function unionRect(a, b) {
  if (a === null) return b
  if (b === null) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  }
}

export class Layers {
  constructor(doc = defaultDoc()) {
    validate(doc)
    this.snow = new SnowField(doc.snow)
    this.lakes = new LakeSet(doc.lakes)
    this.paths = new PathSet([
      ...doc.rivers.map((r) => ({ ...r, kind: 'river' })),
      ...doc.roads.map((d) => ({ ...d, kind: 'road' })),
    ])
    this.ids = new IdAllocator(doc)
    this.epoch = 0
    this._dirty = null
  }

  static deserialize(json) {
    return new Layers(json)
  }

  serialize() {
    return serialize(this)
  }

  // --- the query surface ----------------------------------------------------

  snowLineAt(x, z) {
    return this.snow.snowLineAt(x, z)
  }

  // §18's evaluation order, steps 3 to 5. The coarse field and the fractal detail are the caller's business; this is everything a human placed by hand.
  carve(x, z, h) {
    let out = this.paths.carveRivers(x, z, h)
    out = this.lakes.carve(x, z, out)
    out = this.paths.smoothRoads(x, z, out)
    return out
  }

  // 0..1: how hard the detail layer should suppress its fractal octaves here. Lakes and paths both contribute and the strongest wins -- a road along a lake shore should not get half-flattened just because two masks are competing for it.
  flattenAt(x, z) {
    const a = this.lakes.flattenAt(x, z)
    const b = this.paths.flattenAt(x, z)
    return clamp01(a > b ? a : b)
  }

  // The per-chunk early-out, and the actual performance story of this whole subsystem. An 8 km world at MAX_DEPTH 13 selects thousands of chunks and a dozen authored objects touch a small minority of them; every other chunk answers false here and skips the per-vertex carve entirely. check-v2-layers.mjs measures the fraction and prints it.
  //
  // The one place the rate is genuinely poor is the far field, where a leaf is a kilometre across and three roads crossing the world cross nearly all of them. That is not the early-out failing; those chunks really do contain a road. It is worth knowing because it means the win is concentrated where the chunks are small, which is where they are also numerous.
  //
  // Snow points count as authored elements even though they change no geometry: they change the vertex COLOURS the mesher bakes, so a chunk under a snow point still has to be remade when that point moves.
  overlaps(minX, minZ, maxX, maxZ) {
    return (
      this.paths.overlaps(minX, minZ, maxX, maxZ) ||
      this.lakes.overlaps(minX, minZ, maxX, maxZ) ||
      this.snow.overlaps(minX, minZ, maxX, maxZ)
    )
  }

  // Water surface elevation at (x, z), or null for dry land. The player, the prop scatter and the water renderer read this; the terrain does not.
  //
  // Rivers count. This used to be lakes-only, which meant "is this point underwater" answered null in every riverbed in the world -- so the scatter that keeps trees out of lakes would have planted them mid-channel. Where a river runs into a lake the HIGHER surface wins: the two are contiguous water, and taking the lower would sink the river's last few metres into the lake it is joining.
  waterLevelAt(x, z) {
    const lake = this.lakes.levelAt(x, z)
    const river = this.paths.riverLevelAt(x, z)
    if (river === null) return lake
    if (lake === null) return river
    return river > lake ? river : lake
  }

  // --- dirty tracking -------------------------------------------------------

  takeDirtyRect() {
    const d = this._dirty
    this._dirty = null
    return d
  }

  _commit(rect) {
    this.epoch++
    this._dirty = unionRect(this._dirty, rect)
    return rect
  }

  // Snow edits additionally REBAKE, because snowLineAt reads the baked grid and would otherwise keep answering with the pre-edit line until something else triggered a full bake.
  //
  // The rect handed on to the streamer is grown by two texels on every side: deltaAt is a bicubic tap over a 4x4 neighbourhood, so a vertex up to two texels outside the edited region still reads a texel inside it, and a chunk out there has genuinely changed.
  _commitSnow() {
    const rect = this.snow.takeDirty()
    if (rect === null) return this._commit(null)
    this.snow.bakeRect(rect.minX, rect.minZ, rect.maxX, rect.maxZ)
    const pad = 2 * TEXEL
    return this._commit({ minX: rect.minX - pad, minZ: rect.minZ - pad, maxX: rect.maxX + pad, maxZ: rect.maxZ + pad })
  }

  // --- mutation pass-throughs ----------------------------------------------
  //
  // Thin on purpose. The editor holds ONE object and never has to know which sub-layer owns a given handle, and every edit goes through exactly one place that bumps the epoch and records the rect.

  addSnowPoint(x, z, delta, radius) {
    const i = this.snow.addPoint(x, z, delta, radius)
    this._commitSnow()
    return i
  }

  moveSnowPoint(i, x, z) {
    this.snow.movePoint(i, x, z)
    return this._commitSnow()
  }

  setSnowPoint(i, patch) {
    this.snow.setPoint(i, patch)
    return this._commitSnow()
  }

  removeSnowPoint(i) {
    this.snow.removePoint(i)
    return this._commitSnow()
  }

  setSnowBase(base) {
    if (typeof base !== 'number' || !Number.isFinite(base)) throw new Error(`Layers.setSnowBase: base must be a finite number, got ${base}`)
    this.snow.base = base
    // No rebake: base is added on top of the baked delta grid, so moving it changes every query without touching a texel. The whole world is dirty, though, and the rect is stated in world bounds rather than as an infinity so a consumer can intersect it with a chunk box without producing a NaN.
    return this._commit({ minX: -WORLD_HALF, minZ: -WORLD_HALF, maxX: WORLD_HALF, maxZ: WORLD_HALF })
  }

  // record may omit id; one is allocated and written back onto the returned lake.
  addLake(record) {
    const rec = record.id === undefined ? { ...record, id: this.ids.alloc('lake') } : record
    const lake = this.lakes.add(rec)
    this.ids.observe(lake.id)
    this._commit(this.lakes.takeDirty())
    return lake
  }

  updateLake(id, patch) {
    this.lakes.update(id, patch)
    return this._commit(this.lakes.takeDirty())
  }

  removeLake(id) {
    this.lakes.remove(id)
    return this._commit(this.lakes.takeDirty())
  }

  addPath(record) {
    if (record.kind !== 'river' && record.kind !== 'road') throw new Error(`Layers.addPath: kind must be 'river' or 'road', got ${JSON.stringify(record.kind)}`)
    const rec = record.id === undefined ? { ...record, id: this.ids.alloc(record.kind) } : record
    const path = this.paths.addPath(rec)
    this.ids.observe(path.id)
    this._commit(this.paths.takeDirty())
    return path
  }

  removePath(id) {
    this.paths.removePath(id)
    return this._commit(this.paths.takeDirty())
  }

  movePathPoint(id, i, x, y, z) {
    this.paths.movePoint(id, i, x, y, z)
    return this._commit(this.paths.takeDirty())
  }

  setPathWidth(id, i, w) {
    this.paths.setWidth(id, i, w)
    return this._commit(this.paths.takeDirty())
  }

  insertPathPoint(id, afterIndex, x, y, z, w) {
    const at = this.paths.insertPoint(id, afterIndex, x, y, z, w)
    this._commit(this.paths.takeDirty())
    return at
  }

  removePathPoint(id, i) {
    this.paths.removePoint(id, i)
    return this._commit(this.paths.takeDirty())
  }
}
