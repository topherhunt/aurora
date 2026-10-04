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

import { defaultDoc, validate, serialize, IdAllocator, isGenerated, GENERATED_ID } from './doc.js'
import { SnowField, TEXEL } from './snowline.js'
import { LakeSet, sandPatchAt } from './water-bodies.js'
import { PathSet } from './paths.js'
import { CleftSet } from './clefts.js'
import { clamp01 } from '../../sim/mathx.js'
import { WORLD_HALF } from '../config.js'

// The rect that means EVERYTHING: a document swap, a change to the global snow base, anything whose effect is not bounded by a box smaller than the world.
//
// Stated as a real rect and never as null, because null is read in opposite directions at the two ends of this channel. TerrainV2.setLayers takes null as "the whole document was replaced, rebuild every chunk"; Editor._flushDirty does `if (rect) this.onDirty(rect)` and drops it as "nothing to do". A full-world rect is unambiguous to both: the streamer intersects it with every chunk box and gets every chunk, and the editor sees a truthy rect and forwards it. So on this side of the boundary null has exactly one meaning -- nothing changed -- and _commit throws rather than let the other one through.
//
// A fresh object rather than a frozen singleton, because the value is handed to code that may keep it, and two callers sharing one rect is a bug waiting for the first one that clips it in place.
function wholeWorld() {
  return { minX: -WORLD_HALF, minZ: -WORLD_HALF, maxX: WORLD_HALF, maxZ: WORLD_HALF }
}

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
    this.paths = new PathSet(
      [...doc.rivers.map((r) => ({ ...r, kind: 'river' })), ...doc.roads.map((d) => ({ ...d, kind: 'road' }))],
      { lakes: this.lakes }
    )
    this.clefts = new CleftSet(doc.clefts === undefined ? [] : doc.clefts)
    this.ids = new IdAllocator(doc)
    this.epoch = 0
    this._dirty = null
  }

  static deserialize(json) {
    return new Layers(json)
  }

  serialize(opts) {
    return serialize(this, opts)
  }

  // --- the query surface ----------------------------------------------------

  snowLineAt(x, z) {
    return this.snow.snowLineAt(x, z)
  }

  // §18's evaluation order, steps 3 to 5, then the cave mouths' clefts, last so nothing refills them. The coarse field and the fractal detail are the caller's business; this is everything placed on top of it. `cell` is the caller's sampling spacing, for the river bed's band-limited relief.
  carve(x, z, h, cell = 0) {
    let out = this.paths.carveRivers(x, z, h, cell)
    out = this.lakes.carve(x, z, out)
    out = this.paths.smoothRoads(x, z, out)
    return this.clefts.count > 0 ? this.clefts.carve(x, z, out) : out
  }

  // 0..1: how hard the detail layer should suppress its fractal octaves here. Lakes and paths both contribute and the strongest wins -- a road along a lake shore should not get half-flattened just because two masks are competing for it.
  flattenAt(x, z) {
    const a = this.lakes.flattenAt(x, z)
    const b = this.paths.flattenAt(x, z)
    return clamp01(a > b ? a : b)
  }

  // 0..1: how far toward packed earth the ground is painted here (chunk-mesh-v2's `shade`, and everything tinted off it). flattenAt but for a road's reach, which stops a metre past the kerb where the flatten runs the whole feather; the two answer the same on a lake bed and in a river channel.
  dirtAt(x, z) {
    const a = this.lakes.flattenAt(x, z)
    const b = this.paths.dirtAt(x, z)
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
      this.snow.overlaps(minX, minZ, maxX, maxZ) ||
      this.clefts.overlaps(minX, minZ, maxX, maxZ)
    )
  }

  // Water surface elevation at (x, z), or null for dry land. The player, the prop scatter and the water renderer read this; the terrain reads shoreAt instead.
  //
  // Rivers count. This used to be lakes-only, which meant "is this point underwater" answered null in every riverbed in the world -- so the scatter that keeps trees out of lakes would have planted them mid-channel. Where a river runs into a lake the HIGHER surface wins: the two are contiguous water, and taking the lower would sink the river's last few metres into the lake it is joining.
  waterLevelAt(x, z) {
    const lake = this.lakes.levelAt(x, z)
    const river = this.paths.riverLevelAt(x, z)
    if (river === null) return lake
    if (lake === null) return river
    return river > lake ? river : lake
  }

  // 0..1: how much the ground at height `h` over (x, z) is a SANDY WATER'S EDGE -- within a fraction of a metre of a lake plane or a river's level, on either side of the line (water-bodies.js shoreBand), on a stretch of bank the sand noise makes beach rather than grass (sandPatchAt). The mesher paints it sand and the grass keeps off it. Lakes and rivers each answer and the stronger wins, so a river's mouth is one continuous shore with the lake it enters. The noise is only asked once a band is found, so the dry world never pays for it.
  shoreAt(x, z, h) {
    const lake = this.lakes.shoreAt(x, z, h)
    const river = this.paths.riverShoreAt(x, z, h)
    const band = lake > river ? lake : river
    return band > 0 ? band * sandPatchAt(x, z) : 0
  }

  // --- dirty tracking -------------------------------------------------------

  // The union of every region edited since the last call, and consumes it.
  //
  // null means NOTHING CHANGED. It never means "everything" -- that is wholeWorld(), see the comment on it. A caller that forwards this straight to a streamer should skip the call entirely on null rather than treat it as a full reset.
  takeDirtyRect() {
    const d = this._dirty
    this._dirty = null
    return d
  }

  // Whole-document invalidation: what a caller that has swapped the document out from under a live streamer should call, and what setSnowBase uses.
  markAllDirty() {
    return this._commit(wholeWorld())
  }

  _commit(rect) {
    // An edit that reports no region is an invariant violation and not a shrug: whichever way the consumer at the far end reads a null, one of the two readings silently corrupts something -- either the streamer rebuilds the world for nothing, or it rebuilds nothing when the world changed.
    if (rect === null) throw new Error('Layers._commit: a mutation must report a dirty rect; null is reserved for "nothing changed since the last takeDirtyRect"')
    this.epoch++
    this._dirty = unionRect(this._dirty, rect)
    return rect
  }

  // Snow edits additionally REBAKE, because snowLineAt reads the baked grid and would otherwise keep answering with the pre-edit line until something else triggered a full bake.
  //
  // The rect handed on to the streamer is grown by two texels on every side: deltaAt is a bicubic tap over a 4x4 neighbourhood, so a vertex up to two texels outside the edited region still reads a texel inside it, and a chunk out there has genuinely changed.
  _commitSnow() {
    const rect = this.snow.takeDirty()
    // An edit the sub-layer decided changed nothing. Do not bump the epoch and do not record a rect: an epoch bump makes every resident chunk stale, and the whole point of tracking rects is to not do that for an edit with no effect.
    if (rect === null) return null
    this.snow.bakeRect(rect.minX, rect.minZ, rect.maxX, rect.maxZ)
    const pad = 2 * TEXEL
    return this._commit({ minX: rect.minX - pad, minZ: rect.minZ - pad, maxX: rect.maxX + pad, maxZ: rect.maxZ + pad })
  }

  // The terrain under `rect` was sculpted. Rivers route over the terrain and solve their level from it, so any river that can see the rect re-bakes; the union of where it was and where it now is comes back as the region to remesh, or null when no river reaches the rect. Called by the sculptor after every flush and by the worker after every height patch, each against its own copy of the field.
  terrainChanged(rect) {
    const d = this.paths.terrainChanged(rect)
    if (d === null) return null
    return this._commit(d)
  }

  // A lake edit re-pins any river that starts or ends in the lake's old or new footprint.
  _commitLake() {
    const rect = this.lakes.takeDirty()
    const rivers = this.paths.waterChanged(rect)
    return this._commit(rivers === null ? rect : unionRect(rect, rivers))
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
    // Setting the base to the base it already has is a no-op, and a no-op must not invalidate the world. This is the case the drag handlers actually produce: a slider that fires on every pointer move sends the same value dozens of times between real changes.
    if (base === this.snow.base) return null
    this.snow.base = base
    // No rebake: base is added on top of the baked delta grid, so moving it changes every query without touching a texel. Every chunk in the world is stale, though, which is exactly what wholeWorld() is for.
    return this.markAllDirty()
  }

  // record may omit id; one is allocated and written back onto the returned lake.
  addLake(record) {
    const rec = record.id === undefined ? { ...record, id: this.ids.alloc('lake') } : record
    const lake = this.lakes.add(rec)
    this.ids.observe(lake.id)
    this._commitLake()
    return lake
  }

  updateLake(id, patch) {
    this.lakes.update(id, patch)
    return this._commitLake()
  }

  removeLake(id) {
    this.lakes.remove(id)
    return this._commitLake()
  }

  addPath(record) {
    if (record.kind !== 'river' && record.kind !== 'road') throw new Error(`Layers.addPath: kind must be 'river' or 'road', got ${JSON.stringify(record.kind)}`)
    const rec = record.id === undefined ? { ...record, id: this.ids.alloc(record.kind) } : record
    const path = this.paths.addPath(rec)
    this.ids.observe(path.id)
    this._commit(this.paths.takeDirty())
    return path
  }

  // The generated roads (doc.js isGenerated) in one commit: a town is dozens of short roads, and a commit apiece rebuilds the segment index once per road.
  addGenerated(records) {
    if (records.length === 0) return null
    for (const r of records) {
      if (!isGenerated(r.id)) throw new Error(`Layers.addGenerated: ${JSON.stringify(r.id)} is not a generated id (${GENERATED_ID})`)
      this.paths.addPath({ ...r, kind: 'road' })
    }
    return this._commit(this.paths.takeDirty())
  }

  // The cave mouths' clefts (clefts.js), generated at boot: [x, z, nx, nz, y] each. Replaces any already held.
  setClefts(list) {
    const was = this.clefts.count > 0 ? this.clefts.rectOf(this.clefts.toJSON()) : null
    this.clefts = new CleftSet(list)
    if (list.length === 0 && was === null) return null
    const now = list.length > 0 ? this.clefts.rectOf(list) : null
    return this._commit(unionRect(was, now))
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
