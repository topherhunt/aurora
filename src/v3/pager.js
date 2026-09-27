import { LOD } from '../v2/terrain/quadtree-v2.js'
import { readTile } from './store.js'
import { TileStore, pageRadius, tileBox, tilesWithin } from './tiles.js'

// ---------------------------------------------------------------------------
// Which fine tiles are resident, and who is told -- §31, the elevation pyramid.
//
// The policy half of the pyramid. `tiles.js` says what a tile is and how far fine
// texels can be read; this walks that disc as the eye moves, reads what is newly
// inside it out of IndexedDB, and hands it to the THREE holders of the field at
// once: this page's collision heightmap and the two mesh workers (TerrainV2.putTile).
// One owner for the set, three copies of it, because those three do not share memory
// and a surface that reaches one and not the others is the failure relief.js exists
// to prevent.
//
// THE DISC IS A SUPERSET OF WHAT SELECTION CAN ASK FOR, which is what buys the
// scheme its simplicity. Because `pageRadius` is derived from the LOD's own refine
// test, every chunk that will ever be meshed at a cell finer than the base lies
// inside the disc -- so nothing here has to clamp, negotiate with or even look at the
// quadtree. It is a distance from the eye and nothing else.
//
// IT IS ALSO A PREFETCH, and deliberately wider than the strict reach: the disc
// admits a tile 181 m before the first chunk over it can refine past the base, so in
// steady walking a tile is resident before anything wants it and no chunk meshes
// coarse and then re-meshes. The cost of the margin is counted in tiles -- 14 of them
// at the desktop knob, 69.1 kB each, under 1 MB in hand.
// ---------------------------------------------------------------------------

export class TilePager {
  /**
   * @param key       the island's cache key (store.js cacheKey), which the tile records are filed under.
   * @param store     the TileStore already attached to the page's heightmap. The PAGE owns it, because it has to be attached before the V2Height is built (a reconstruction takes a view of the heightmap and carries the tiles forward) and this object is built after the mesh workers exist.
   * @param baseTexel the resident base pitch, in metres. The radius is derived from it and it is the normal stencil's width.
   * @param terrain   the TerrainV2 whose workers hold the other two copies.
   * @param log       one line when something is wrong; nothing per tile.
   */
  constructor({ key, store, baseTexel, terrain, log = () => {} }) {
    if (typeof key !== 'string' || key.length === 0) throw new Error(`TilePager: key must be the island's cache key, got ${key}`)
    if (!(store instanceof TileStore)) throw new Error('TilePager: store must be the TileStore attached to the page heightmap')
    if (!(baseTexel > 0)) throw new Error(`TilePager: baseTexel must be positive metres, got ${baseTexel}`)
    // Null would page tiles into this page's collision field and not into the
    // mesher's, which is ground she is drawn a metre off. A headless reader passes a
    // stub with putTile/dropTile, not nothing.
    if (!terrain) throw new Error('TilePager: terrain is required -- a pager that feeds only the collision field makes two surfaces')
    this.key = key
    this.baseTexel = baseTexel
    this.terrain = terrain
    this.log = log
    this.store = store
    this._loading = new Set()
    // Tiles the store says are there and IndexedDB does not. Zero unless storage was
    // evicted under a live tab -- load() verifies the count before standing a cached
    // island up -- and surfaced rather than swallowed, because the symptom is ground
    // that is quietly 8 m in one 256 m square.
    this.missing = 0
    this.radius = 0
    this.wanted = 0
    this._dead = false
    // Far enough outside the world that the first update always runs.
    this._atX = Infinity
    this._atZ = Infinity
    this._atRadius = 0
  }

  /**
   * Bring the resident set in line with an eye at (x, z). Cheap enough for every
   * frame: at most a couple of dozen box distances, and it short-circuits entirely
   * while the eye stays within a metre of where it last paged and `LOD.triDeg` has
   * not moved.
   *
   * LOD.triDeg IS READ HERE AND NOT CACHED. It is a live panel slider, and it is the
   * knob the radius is derived from, so a reader who dragged it finer would otherwise
   * get chunks refining past the base outside the disc -- 8 m ground inside a 2 m
   * world, with nothing thrown.
   */
  update(x, z) {
    if (this._dead) return
    const radius = pageRadius(LOD.triDeg, this.baseTexel)
    if (radius === this._atRadius && Math.abs(x - this._atX) < 1 && Math.abs(z - this._atZ) < 1) return
    this._atX = x
    this._atZ = z
    this._atRadius = radius
    this.radius = radius

    const wanted = new Set(tilesWithin(x, z, radius))
    this.wanted = wanted.size

    // Evictions first, so the peak resident set is the wanted set and not the union
    // of it with the one before.
    for (const key of [...this.store.tiles.keys()]) {
      if (wanted.has(key)) continue
      this.store.drop(key)
      this.terrain.dropTile(key)
    }

    for (const key of wanted) {
      if (this.store.has(key) || this._loading.has(key)) continue
      this._loading.add(key)
      this._fetch(key)
    }
  }

  // Not awaited and not capped. IndexedDB serialises the reads itself, and the
  // handful outstanding at a teleport are 69.1 kB each; a queue here would be
  // bookkeeping in front of a queue that already exists.
  async _fetch(key) {
    let data = null
    try {
      data = await readTile(this.key, key)
    } finally {
      this._loading.delete(key)
    }
    if (this._dead) return
    if (data === null) {
      this.missing++
      this.log(`tile ${key} is not in the cache -- that square draws the 8 m base`)
      console.error(`[terrain-v3] tile ${key} missing from IndexedDB for island ${this.key}`)
      return
    }
    // Wanted when the read was issued, maybe not now: a teleport can move the disc
    // off a tile mid-read. Dropping it is right -- the next update asks again.
    if (!tilesWithin(this._atX, this._atZ, this._atRadius).includes(key)) return
    this.store.put(key, data)
    // The rect is the tile's own box grown by the base pitch, because a chunk's
    // normals step a base texel either side of each vertex.
    this.terrain.putTile(key, data, tileBox(key, this.baseTexel))
  }

  /** Resident bytes of fine detail. What the panel's readout adds to the base field. */
  get bytes() {
    return this.store.bytes
  }

  get stats() {
    return {
      radius: this.radius,
      resident: this.store.size,
      wanted: this.wanted,
      loading: this._loading.size,
      missing: this.missing,
      bytes: this.store.bytes,
    }
  }

  /**
   * Stop paging and let the tiles go. The store is cleared rather than left to the
   * collector because a rebuild holds the old field until the new one is standing,
   * and `_dead` is what keeps an in-flight read from posting a tile to a TerrainV2
   * that has already been disposed.
   */
  dispose() {
    this._dead = true
    this.terrain = null
    this.store.tiles.clear()
  }
}
