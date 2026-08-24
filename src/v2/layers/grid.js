// ---------------------------------------------------------------------------
// UniformGrid: the one spatial index every v2 content layer shares (DESIGN.md §18).
//
// Three-free and node-runnable, like everything under src/v2/layers/.
//
// Every layer bins AABBs -- snow points by their radius box, lakes by their rotated bounding box, path segments by their swept box -- and every layer asks the same two questions: "which ids are under this point" (the per-vertex path) and "does ANYTHING touch this box" (the per-chunk early-out). One implementation, so a bug in the binning arithmetic is one bug and not four.
// ---------------------------------------------------------------------------

// Cell coordinates are packed into ONE integer key rather than a `${cx}|${cz}` string. The per-vertex carve path calls query() for every vertex of every chunk that survives culling, and a string key costs an allocation plus a hash of the characters on each of those calls; an integer key costs neither.
//
// The limit is what keeps the packed key a V8 small integer (Smi, 31-bit signed): (cx + 16384) * 32768 + (cz + 16384) peaks at 2^30 - 1, so keys never leave the Smi range and the Map never boxes one on the heap. At the smallest cell size any layer here uses (32 m) that covers +/- 524 km, which is 64 world boxes -- far beyond anything that can be authored, so exceeding it is a bug and throws rather than silently aliasing two distant cells onto one key.
const CELL_LIMIT = 16384
const CELL_SPAN = CELL_LIMIT * 2

export class UniformGrid {
  constructor(cellSize) {
    if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
      throw new Error(`UniformGrid: cellSize must be a finite number > 0, got ${cellSize}`)
    }
    this.cellSize = cellSize
    this.inv = 1 / cellSize
    this.cells = new Map()
    // Entries, not distinct ids: one AABB spanning nine cells counts nine.
    this.entries = 0

    // Every inserted id's own AABB, kept flat: _boxOf maps id -> ordinal, _boxes holds minX/minZ/maxX/maxZ at ordinal*4. Only overlaps() reads this, and only to turn "some object reaches this cell" into "some object reaches this box" -- see the comment there for why the difference is worth 4 numbers per object.
    this._boxOf = new Map()
    this._boxes = []

    // Stamp-based de-duplication for queryBox. A Set allocated per call would be the single largest allocator in the editor's picking path; a Map of id -> stamp is allocated once and reused forever.
    this._seen = new Map()
    this._stamp = 0
  }

  clear() {
    this.cells.clear()
    this.entries = 0
    this._boxOf.clear()
    this._boxes.length = 0
  }

  // Not private on purpose: the layers report their own bin sizes in the gate.
  cellIndex(v) {
    const c = Math.floor(v * this.inv)
    if (!(c >= -CELL_LIMIT && c < CELL_LIMIT)) {
      throw new Error(`UniformGrid: coordinate ${v} maps to cell ${c}, outside the +/-${CELL_LIMIT} cell key range`)
    }
    return c
  }

  key(cx, cz) {
    return (cx + CELL_LIMIT) * CELL_SPAN + (cz + CELL_LIMIT)
  }

  insert(id, minX, minZ, maxX, maxZ) {
    // Written as a negated <= so NaN fails here rather than producing an empty cell range that silently drops the object out of the index.
    if (!(minX <= maxX) || !(minZ <= maxZ)) {
      throw new Error(`UniformGrid.insert(${id}): degenerate box [${minX},${minZ}]..[${maxX},${maxZ}]`)
    }
    // An id inserted twice takes the union of the two boxes rather than the second one. No layer here does that today, but the alternative failure -- the second insert silently shrinking an object's recorded extent while its earlier cells stay binned -- is a chunk that early-outs on ground it should have carved, and that is invisible until someone notices a river running over a hillside.
    const prev = this._boxOf.get(id)
    if (prev === undefined) {
      this._boxOf.set(id, this._boxes.length >> 2)
      this._boxes.push(minX, minZ, maxX, maxZ)
    } else {
      const o = prev * 4
      if (minX < this._boxes[o]) this._boxes[o] = minX
      if (minZ < this._boxes[o + 1]) this._boxes[o + 1] = minZ
      if (maxX > this._boxes[o + 2]) this._boxes[o + 2] = maxX
      if (maxZ > this._boxes[o + 3]) this._boxes[o + 3] = maxZ
    }

    const x0 = this.cellIndex(minX)
    const x1 = this.cellIndex(maxX)
    const z0 = this.cellIndex(minZ)
    const z1 = this.cellIndex(maxZ)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz)
        let bucket = this.cells.get(k)
        if (bucket === undefined) {
          bucket = []
          this.cells.set(k, bucket)
        }
        bucket.push(id)
        this.entries++
      }
    }
  }

  // The alloc-free form of query(). Returns the bucket array itself or undefined, so a hot loop can walk it directly instead of paying for a closure per vertex. The array is the index's own storage: READ IT, do not mutate it.
  cellAt(x, z) {
    return this.cells.get(this.key(this.cellIndex(x), this.cellIndex(z)))
  }

  query(x, z, visit) {
    const bucket = this.cellAt(x, z)
    if (bucket === undefined) return
    for (let i = 0; i < bucket.length; i++) visit(bucket[i])
  }

  // Range query with de-duplication: an object binned into nine cells is visited once.
  queryBox(minX, minZ, maxX, maxZ, visit) {
    if (!(minX <= maxX) || !(minZ <= maxZ)) {
      throw new Error(`UniformGrid.queryBox: degenerate box [${minX},${minZ}]..[${maxX},${maxZ}]`)
    }
    const stamp = ++this._stamp
    const seen = this._seen
    const x0 = this.cellIndex(minX)
    const x1 = this.cellIndex(maxX)
    const z0 = this.cellIndex(minZ)
    const z1 = this.cellIndex(maxZ)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.cells.get(this.key(cx, cz))
        if (bucket === undefined) continue
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i]
          if (seen.get(id) === stamp) continue
          seen.set(id, stamp)
          visit(id)
        }
      }
    }
  }

  // The per-chunk early-out. Returns on the first real hit and allocates nothing -- no Set, no closure, no result object -- because this runs once per chunk for every chunk in the selection and the overwhelming majority of them answer false.
  //
  // The cells narrow the search; the stored AABBs decide it. Answering from occupancy alone would be sound (over-reporting costs a wasted per-vertex pass, and only UNDER-reporting could leave a river uncarved) but it rounds every object up to whole cells in both axes, and for the thin objects that dominate this index that rounding is most of the answer: a 26 m road binned at 32 m reports a band about 90 m wide, so two thirds of the chunks it claims are chunks it does not touch. Measured over the gate's twelve-object fixture, testing the boxes lifts the early-out rate from 92.6% to 95.0%.
  //
  // Not de-duplicated: an object binned into nine cells can be tested up to nine times. Adding the stamp map would cost a Map write per candidate to save a box test that is four comparisons, and the loop returns on the first hit anyway.
  overlaps(minX, minZ, maxX, maxZ) {
    if (!(minX <= maxX) || !(minZ <= maxZ)) {
      throw new Error(`UniformGrid.overlaps: degenerate box [${minX},${minZ}]..[${maxX},${maxZ}]`)
    }
    if (this.cells.size === 0) return false
    const boxes = this._boxes
    const x0 = this.cellIndex(minX)
    const x1 = this.cellIndex(maxX)
    const z0 = this.cellIndex(minZ)
    const z1 = this.cellIndex(maxZ)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.cells.get(this.key(cx, cz))
        if (bucket === undefined) continue
        for (let i = 0; i < bucket.length; i++) {
          const o = this._boxOf.get(bucket[i]) * 4
          if (boxes[o] <= maxX && boxes[o + 2] >= minX && boxes[o + 1] <= maxZ && boxes[o + 3] >= minZ) return true
        }
      }
    }
    return false
  }
}
