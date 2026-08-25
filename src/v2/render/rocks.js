import * as THREE from 'three'

import { buildRockBank, ENVIRONMENTS, ROCK_BAND_COUNT, TINTS } from '../../props/rock-bank.js'
import { createPropMaterial, setSnowLine, setMossLine, setPropFadeAt } from '../../material.js'

// ---------------------------------------------------------------------------
// The stone on the /v2 route: pebbles underfoot, boulders through the wood and
// across the cliffsides, and giants on the crags and the summits.
//
// THE SCATTER IS render/trees.js's, and deliberately so -- a tiled, camera
// following, graded-thinning scatter whose density falls off as FULL_RADIUS / d
// so the instance count grows linearly in the draw radius rather than
// quadratically. Everything that file's header argues about tiles, ranks,
// quantised keep-fractions, incremental regrow, standing props on the DRAWN
// ground rather than on the field, and dissolving at each instance's own cull
// distance is true here and is not repeated. What follows is only what is
// different about rock.
//
// ONE THING IS DIFFERENT, AND IT IS THE WHOLE FILE: A ROCK'S SIZE SPANS TWO
// ORDERS OF MAGNITUDE. A pebble is 11 cm and a summit fang is 7.5 m, and no
// single density-and-radius pair can carry both. A pebble wants one per few
// square metres out to fifty; a fang wants one per two thousand square metres
// out to a kilometre and a half. Run the pebble's numbers to the fang's horizon
// and it is millions of instances; run the fang's numbers underfoot and there
// are no pebbles.
//
// So there are THREE BEDS, each a complete independent scatter with its own
// tile grid, its own density, its own radius, its own LOD bands and its own
// instance pool:
//
//   UNDERFOOT   0.11 - 0.6 m   dense, 55 m      pebbles, grit, cobbles, scree
//   BOULDERS    0.3 - 3.4 m    medium, 460 m    the forest and cliffside rocks
//   GIANTS      3.6 - 7.5 m    sparse, 1250 m   shelves, buttresses, spires
//
// Three beds are three BatchedMeshes and therefore three draw calls, and that
// is not a violation of DESIGN.md §5's one-material rule: the rule is that a
// BATCH cannot be split by material, and these are three batches. They share
// ONE material object -- unlike trees, ferns and grass, which cannot, because
// which layers billboard is compiled into the shader and their lists differ.
// Nothing in this file billboards, so one program serves all three.
//
// WHERE A ROCK GOES IS DECIDED BY WHERE IT IS, not by a roll. Each candidate is
// classified into one of four ENVIRONMENTS from the field sample the placement
// test already pays for, and then picks its shape from the variants tagged for
// that environment (see props/rock-bank.js):
//
//   river   inside a lake or river footprint, or standing barely out of it.
//           Riverbed and shore: flat, worn, sunk, wet-shaded.
//   peak    within PEAK_BELOW_SNOW metres of the snow line or above it.
//           Spires, fangs, scree.
//   cliff   steeper than CLIFF_SLOPE_DEG and below the peak band. Shelves,
//           buttresses, blocks -- things that stick out of a face.
//   forest  everything else. Boulders, erratics, mossy humps.
//
// The classification is a pure function of position, exactly as existence is,
// so a rock does not change species as the player walks toward it.
//
// ROCKS SIT IN THE GROUND AND LEAN WITH IT, and both halves matter. A rock is
// bedded by a fraction of its own height that GROWS WITH THE SLOPE -- on a
// cliff a giant is a third buried, which is what makes it read as protruding
// from the face instead of balanced on it -- and it is tilted toward the ground
// normal, which trees deliberately are not. A tree on a slope grows up; a rock
// on a slope lies the way it fell. The tilt costs four extra field samples per
// PLACED rock and is switched off for the underfoot bed, where the rocks are
// four centimetres tall and nothing could tell.
//
// SNOW AND MOSS ARE NOT THIS FILE'S, and that is the point of them being in the
// material. Both are derived in the vertex shader from the instance's own root
// height against a line -- snow filling in above its line, moss thinning out
// above its own -- so a boulder in a damp wood is green, the same boulder on a
// ridge is bare stone, and one on a summit is white, with no per-instance data
// and no per-frame CPU. See material.js's header, and syncBands below for where
// the two lines come from.
//
// NO CARD TIER, and it is a deliberate omission rather than an unfinished one.
// A rock's impostor would be photographed from the side and its normals are
// horizontal by construction, so the lean that makes a tree card read has
// nothing to bite on; a flat picture of a boulder is a flat picture of a
// boulder. The coarsest tier is real geometry -- an eight-triangle octahedron
// displaced by the same field as its bigger siblings, which keeps the rock's
// proportions and its lean. See props/rock.js's ROCK_TIERS.
// ---------------------------------------------------------------------------

// The three beds. Each is an independent scatter; `names` are the variants from
// props/rock-bank.js it may place, and the environment tags on those variants
// then decide which of them can stand at any given point.
//
// DENSITIES ARE AT FULL RADIUS and decay past it. Inside the full radius a bed
// puts down `density * envDensity[env]` rocks per square metre, which is the
// number to read when you want to know what the ground LOOKS like: 0.0025 with a
// forest multiplier of 0.5 is one boulder per 800 m2, so about one every 28 m.
//
// `envDensity` is the second half of the environment gate and the more important
// half. WITHOUT IT A BED IS EQUALLY DENSE EVERYWHERE and only its shapes change,
// which puts a house-sized block every forty metres through a wood -- the four
// environments differ in how much stone is lying about at least as much as they
// differ in what kind. A cliff is 1.0 by definition: "littered" was the word.
//
// The roll it costs is drawn UNCONDITIONALLY alongside the others, before the
// environment is even known, for the same reason every other draw is -- see
// _growTile.
const BEDS = [
  {
    name: 'underfoot',
    names: ['pebble', 'grit', 'cobble', 'shingle', 'scree'],
    density: 0.35,
    // Leaf litter and turf swallow small stones; bare rock and gravel do not.
    envDensity: { river: 1, forest: 0.5, cliff: 1, peak: 0.9 },
    fullRadius: 18,
    radius: 55,
    tile: 11,
    // Two triangles' worth of difference between the tiers here, so the bands
    // sit close in and the far one carries almost everything.
    bands: [9, 24],
    minElev: 0,
    maxSlopeDeg: 42,
    // A pebble in a stream bed is a pebble. The underfoot bed is the only one
    // that may stand under water on purpose.
    allowSubmerged: true,
    tilt: 0,
    scale: [0.7, 1.6],
  },
  {
    name: 'boulders',
    names: ['cobble', 'scree', 'slab', 'stepping', 'mosshump', 'boulder', 'erratic', 'cleft'],
    density: 0.0025,
    envDensity: { river: 0.7, forest: 0.5, cliff: 1, peak: 0.8 },
    fullRadius: 95,
    radius: 460,
    tile: 28,
    bands: [38, 130],
    minElev: 0,
    maxSlopeDeg: 48,
    allowSubmerged: true,
    tilt: 0.7,
    scale: [0.7, 1.7],
  },
  {
    name: 'giants',
    names: ['blockhouse', 'shelf', 'buttress', 'spire', 'fang'],
    density: 0.0006,
    // A house-sized rock in a wood is a landmark and has to stay one: 0.10 of
    // 0.0006 is one per 17,000 m2, about one every 145 m. On a cliff face the
    // same bed runs at full rate and the face is covered in them.
    envDensity: { river: 0.15, forest: 0.1, cliff: 1, peak: 0.8 },
    fullRadius: 270,
    radius: 1250,
    tile: 70,
    // The expensive band is the middle one -- a crag's LOD1 is 80-240 triangles
    // over an annulus twenty times the inner band's area -- so its outer edge is
    // the first knob to turn if this has to come down.
    bands: [110, 300],
    minElev: 0,
    maxSlopeDeg: 62,
    // A ten-metre buttress standing in a lake would be a landmark nobody asked
    // for, and the lake bed is not where a cliff face is.
    allowSubmerged: false,
    tilt: 0.55,
    scale: [0.75, 1.5],
  },
]

// Where the four environments cut. All three are read off the same field sample
// the placement test already pays for, plus one water lookup.
//
// A rock standing this far out of the water still belongs to the river: the
// wet-shaded flat variants are for the bed AND the bank, and a hard edge at the
// waterline would put a lichen boulder half in the stream.
const SHORE_RISE = 1.6

// Metres BELOW the local snow line at which a site starts counting as peak
// country. Well below the line itself, because the jagged stuff wants to start
// before the white does -- a summit that is bare rock up to the snow and spires
// only above it reads as two different mountains stacked.
const PEAK_BELOW_SNOW = 55

// Steeper than this and a site is a cliff rather than a wood. 34 degrees is just
// past render/trees.js's 32 degree tree limit, so the ground that has no trees
// on it is the ground that gets cliff furniture.
const CLIFF_SLOPE_DEG = 34
const CLIFF_TAN = Math.tan((CLIFF_SLOPE_DEG * Math.PI) / 180)

// Metres below the snow line at which moss gives out. See Rocks.syncBands.
const MOSS_DROP = 220

// How deep a rock is bedded, as a fraction of its own height: this much at the
// flat, rising to this plus the span at the bed's slope limit. A rock resting
// exactly on the ground reads as placed; a third buried reads as part of the
// hill. rock.js's `sit` already cut a flat bed face at the bottom of every one
// of these, so this is burying the bed face, not standing on a point.
const SINK_MIN = 0.06
const SINK_SLOPE = 0.28

// Everything below is render/trees.js's, unchanged, and its header is the
// explanation for all of it.
const QUANT = 4
const LOD_HYSTERESIS = 0.12
const BUILD_BUDGET_MS = 1.5
const PLACEMENT_CELL = 4.0
const GROUND_SWEEP = 16

/** Deterministic 32-bit PRNG. Same one the rest of the project uses. */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A tile's seed, from its own coordinates, the world seed and the BED. The bed
 * index is mixed in so the three scatters are independent fields rather than
 * the same one at three scales -- without it every giant would have a pebble
 * sitting on its exact centre.
 */
function tileSeed(tx, tz, seed, bed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^
    Math.imul(tz | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b1) ^
    Math.imul(bed + 1, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * One size band's scatter: its own tile grid, its own pool, its own BatchedMesh.
 *
 * Not exported. `Rocks` owns three of these and the bank and material they
 * share; nothing outside this file has any reason to hold one.
 */
class RockBed {
  constructor(scene, field, water, material, bank, cfg, index, { seed, ground }) {
    this.field = field
    this.water = water
    this.cfg = cfg
    this.index = index
    this.seed = seed
    this.ground = ground

    const tile = cfg.tile
    this.tile = tile
    this.density = cfg.density
    this.radius = cfg.radius
    this.fullRadius = cfg.fullRadius
    this.fullSq = cfg.fullRadius * cfg.fullRadius

    this.perTile = Math.max(1, Math.round(tile * tile * cfg.density))
    this.tileSpan = Math.ceil(cfg.radius / tile) + 1
    this.radiusSq = cfg.radius * cfg.radius
    this.evictSq = (cfg.radius + tile * 1.5) ** 2
    this.nearSq = (cfg.bands[cfg.bands.length - 1] + tile * 1.5) ** 2
    this.maxSlopeTan = Math.tan((cfg.maxSlopeDeg * Math.PI) / 180)

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / cfg.fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (cfg.fullRadius * Math.pow(2, q / QUANT)) ** 2

    // The bed's own slice of the bank, and the per-environment index into it.
    // Shapes are (variant x seed) pairs, so `shapes` is longer than `names`.
    this.shapes = bank.shapes.filter((s) => cfg.names.includes(s.name))
    if (!this.shapes.length) throw new Error(`RockBed ${cfg.name}: no bank shape matches ${cfg.names.join(', ')}`)
    for (const env of ENVIRONMENTS) {
      if (!(cfg.envDensity[env] >= 0)) {
        throw new Error(`RockBed ${cfg.name}: envDensity has no entry for ${env}`)
      }
    }
    this.byEnv = new Map()
    for (const env of ENVIRONMENTS) {
      this.byEnv.set(
        env,
        this.shapes.map((s, i) => (s.envs.includes(env) ? i : -1)).filter((i) => i >= 0)
      )
    }

    this.maxInstances = this._poolBound()

    // Arena entries are de-duplicated BY GEOMETRY IDENTITY. A pebble's three
    // bands are the same T8 object (rock-bank.js pads short ladders by
    // reference), so it costs one arena entry and three table cells.
    const unique = [...new Set(this.shapes.flatMap((s) => s.tiers))]
    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      unique.reduce((n, g) => n + g.attributes.position.count, 0),
      unique.reduce((n, g) => n + g.index.count, 0),
      material
    )
    this.batch.name = `v2-rocks-${cfg.name}`
    this.batch.frustumCulled = false
    this.batch.sortObjects = false

    const idOf = new Map()
    for (const g of unique) idOf.set(g, this.batch.addGeometry(g))
    this.tierIds = []
    this.tierTris = []
    for (let t = 0; t < ROCK_BAND_COUNT; t++) {
      this.tierIds.push(this.shapes.map((s) => idOf.get(s.tiers[t])))
      this.tierTris.push(this.shapes.map((s) => s.tiers[t].userData.rock.triangles))
    }

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0][0])
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.shapeAt = new Uint16Array(this.maxInstances)
    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    this.instSink = new Float32Array(this.maxInstances)

    this.bandSq = Float32Array.from(cfg.bands, (b) => b * b)
    this.bandSqOut = Float32Array.from(cfg.bands, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)

    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._scatter = { h: 0, tan: 0 }
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._yawQ = new THREE.Quaternion()
    this._tiltQ = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._n = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    this._sweep = 0

    this.tris = 0
    this.placed = 0
    this.samples = 0
    this.regrows = 0
    this.regrounds = 0
    this.rejected = { elev: 0, slope: 0, water: 0, env: 0 }
    this.placeMs = 0
    this.lastBuildMs = 0

    scene.add(this.batch)
  }

  /** See Trees._poolBound: summed over the real tile grid, because the law is not exact. */
  _poolBound() {
    const span = this.tileSpan
    const tile = this.tile
    const cx = tile / 2
    const cz = tile / 2
    let bound = 0
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const dcx = (ix + 0.5) * tile - cx
        const dcz = (iz + 0.5) * tile - cz
        if (dcx * dcx + dcz * dcz > this.evictSq) continue
        const nx = Math.max(ix * tile, Math.min(cx, (ix + 1) * tile))
        const nz = Math.max(iz * tile, Math.min(cz, (iz + 1) * tile))
        bound += this.perTile * this.uAt[this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2)]
      }
    }
    return Math.ceil(bound * 1.35)
  }

  _levelFor(d2) {
    if (d2 <= this.fullSq) return 0
    const q = Math.floor(Math.log2(Math.sqrt(d2) / this.fullRadius) * QUANT)
    return q < 0 ? 0 : q > this.maxQ ? this.maxQ : q
  }

  /**
   * Which of the four environments a site is, from the field sample the
   * placement test already took plus one water lookup.
   *
   * Order is not arbitrary. Water wins outright, because a lake bed is a lake
   * bed however steep the ground under it. Then altitude, then slope: a sheer
   * face above the snow line is peak country, not a cliff with spires missing.
   */
  _envAt(x, z, h, tan) {
    const level = this.water.levelAt(x, z)
    if (level !== null && h < level + SHORE_RISE) return 'river'
    if (h > this.field.snowLineAt(x, z) - PEAK_BELOW_SNOW) return 'peak'
    if (tan > CLIFF_TAN) return 'cliff'
    return 'forest'
  }

  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    while (this.queue.length) this._growTile(this.queue.pop())
    this.placeMs = performance.now() - t0
    return this.placed
  }

  update(camX, camY, camZ, budgetMs) {
    this._reseat(camX, camZ)

    const t0 = performance.now()
    while (this.queue.length && performance.now() - t0 < budgetMs) this._growTile(this.queue.pop())
    this.lastBuildMs = performance.now() - t0

    const tile = this.tile
    const coarse = ROCK_BAND_COUNT - 1
    let tris = 0
    const phase = this._sweep
    this._sweep = (this._sweep + 1) % GROUND_SWEEP
    const ground = this.ground
    let ti = 0
    for (const t of this.tiles.values()) {
      if (ground && ti++ % GROUND_SWEEP === phase) {
        const gkey = ground.groundKeyAt((t.tx + 0.5) * tile, (t.tz + 0.5) * tile)
        if (gkey !== t.gkey) {
          t.gkey = gkey
          this._reground(t)
          this.regrounds++
        }
      }

      const nx = Math.max(t.tx * tile, Math.min(camX, (t.tx + 1) * tile))
      const nz = Math.max(t.tz * tile, Math.min(camZ, (t.tz + 1) * tile))
      const near2 = (nx - camX) ** 2 + (nz - camZ) ** 2

      const q = t.q
      const thicken = near2 < this.loSq[q]
      const thin = q + 2 <= this.maxQ && near2 >= this.loSq[q + 2]
      if (!t.queued && (thicken || thin)) {
        t.queued = true
        this.queue.push({ key: t.tx * 0x10000 + t.tz, tx: t.tx, tz: t.tz, q: this._levelFor(near2), d2: near2 })
      }

      const dx = (t.tx + 0.5) * tile - camX
      const dz = (t.tz + 0.5) * tile - camZ
      const near = dx * dx + dz * dz < this.nearSq
      if (!near) {
        if (t.near) this._demote(t, coarse)
        t.near = false
        for (let k = 0; k < t.n; k++) tris += this.tierTris[coarse][this.shapeAt[t.ids[k]]]
        continue
      }
      t.near = true
      for (let k = 0; k < t.n; k++) {
        const i = t.ids[k]
        const ex = this.instX[i] - camX
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]

        let tier = coarse
        for (let b = 0; b < this.bandSq.length; b++) {
          const sticky = cur >= 0 && cur <= b
          if (d2 < (sticky ? this.bandSqOut[b] : this.bandSq[b])) {
            tier = b
            break
          }
        }

        const shape = this.shapeAt[i]
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this.tierIds[tier][shape])
        }
        tris += this.tierTris[tier][shape]
      }
    }
    this.tris = tris
  }

  _reseat(cx, cz) {
    const tile = this.tile
    const tx = Math.floor(cx / tile)
    const tz = Math.floor(cz / tile)
    if (tx === this.camTileX && tz === this.camTileZ) return
    this.camTileX = tx
    this.camTileZ = tz

    for (const [key, t] of this.tiles) {
      const dx = (t.tx + 0.5) * tile - cx
      const dz = (t.tz + 0.5) * tile - cz
      if (dx * dx + dz * dz > this.evictSq) {
        this._release(t)
        this.tiles.delete(key)
      }
    }

    for (const t of this.tiles.values()) t.queued = false
    const span = this.tileSpan
    this.queue.length = 0
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const gx = tx + ix
        const gz = tz + iz
        const dcx = (gx + 0.5) * tile - cx
        const dcz = (gz + 0.5) * tile - cz
        const d2 = dcx * dcx + dcz * dcz
        if (d2 > this.radiusSq) continue
        const key = gx * 0x10000 + gz
        if (this.tiles.has(key)) continue
        const nx = Math.max(gx * tile, Math.min(cx, (gx + 1) * tile))
        const nz = Math.max(gz * tile, Math.min(cz, (gz + 1) * tile))
        this.queue.push({ key, tx: gx, tz: gz, d2, q: this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2) })
      }
    }
    this.queue.sort((a, b) => b.d2 - a.d2)
  }

  _growTile(job) {
    const { key, tx, tz, q } = job
    const tile = this.tile
    const existing = this.tiles.get(key)
    const uNew = this.uAt[q]

    if (existing) {
      existing.queued = false
      if (existing.q === q) return
      this.regrows++
      if (uNew < existing.u) {
        this._thin(existing, uNew)
        existing.q = q
        existing.u = uNew
        return
      }
    }
    const uOld = existing ? existing.u : 0

    const rand = mulberry32(tileSeed(tx, tz, this.seed, this.index))
    const cfg = this.cfg
    const ids = existing ? existing.ids : new Int32Array(this.perTile)
    const rank = existing ? existing.rank : new Float32Array(this.perTile)
    let n = existing ? existing.n : 0

    for (let k = 0; k < this.perTile; k++) {
      // EVERY candidate draws the same randoms whether or not it survives -- see
      // Trees._growTile. `shapeRoll` is drawn here and RESOLVED against the
      // environment further down, which keeps the stream fixed while still
      // letting the shape depend on where the rock turned out to be.
      const x = (tx + rand()) * tile
      const z = (tz + rand()) * tile
      const shapeRoll = rand()
      const envRoll = rand()
      const yaw = rand() * Math.PI * 2
      const scale = cfg.scale[0] + rand() * (cfg.scale[1] - cfg.scale[0])
      const tone = rand()
      const warm = rand()
      const u = rand()

      if (u >= uNew || u < uOld) continue

      this.samples++
      const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
      if (h < cfg.minElev) {
        this.rejected.elev++
        continue
      }
      if (tan > this.maxSlopeTan) {
        this.rejected.slope++
        continue
      }
      const env = this._envAt(x, z, h, tan)
      // How MUCH stone this environment has lying about, as opposed to which
      // kind. See BEDS: without this a bed is equally dense everywhere.
      if (envRoll >= cfg.envDensity[env]) {
        this.rejected.env++
        continue
      }
      if (!cfg.allowSubmerged && this.water.isSubmerged(x, z, h)) {
        this.rejected.water++
        continue
      }
      const pool = this.byEnv.get(env)
      // Not an error: a bed whose variants are all tagged `peak` simply places
      // nothing in a wood, which is how the giants stay off the flat.
      if (!pool.length) {
        this.rejected.env++
        continue
      }
      const shape = pool[Math.min(pool.length - 1, (shapeRoll * pool.length) | 0)]

      if (this.freeCount === 0) {
        throw new Error(
          `RockBed ${cfg.name}: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
        )
      }

      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = u
      n++

      const s = this.shapes[shape]
      // Bedded by a fraction of its OWN height, which is why `measured` is on
      // the shape at all: a 7 m fang and an 11 cm pebble both want to be a
      // tenth of themselves into the ground, not a tenth of a metre.
      const sink = s.measured.height * scale * (SINK_MIN + SINK_SLOPE * Math.min(1, tan / this.maxSlopeTan))
      this.shapeAt[id] = shape
      this.instX[id] = x
      this.instZ[id] = z
      this.instSink[id] = sink
      this.instY[id] = this._groundFor(x, z) - sink

      this._yawQ.setFromAxisAngle(this._up, yaw)
      // Yaw first in the rock's own frame, then the lean on top of it, so a
      // tilted rock spins about the ground's normal rather than about world Y.
      if (cfg.tilt > 0) this._q.copy(this._groundTilt(x, z, cfg.tilt)).multiply(this._yawQ)
      else this._q.copy(this._yawQ)
      this._p.set(x, this.instY[id], z)
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // The variant's own tint, jittered per instance so a scree slope is not
      // one colour. Same channel and same trick as the forest's, and the whole
      // of the variety argument on top of one 128 px granite tile.
      const hex = TINTS[s.tint][1]
      const v = 0.88 + tone * 0.24
      this._c.setHex(hex, THREE.SRGBColorSpace)
      this._c.setRGB(
        clamp01(this._c.r * v * (0.96 + warm * 0.08)),
        clamp01(this._c.g * v),
        clamp01(this._c.b * v * (1.04 - warm * 0.08))
      )
      this.batch.setColorAt(id, this._c)

      setPropFadeAt(this.batch, id, Math.min(this.fullRadius / u, this.radius))

      // Born at the coarsest tier; `update` promotes the near ones next frame.
      this.tierAt[id] = ROCK_BAND_COUNT - 1
      this.batch.setGeometryIdAt(id, this.tierIds[ROCK_BAND_COUNT - 1][shape])
      this.batch.setVisibleAt(id, true)
    }

    this.placed += n - (existing ? existing.n : 0)
    if (existing) {
      existing.n = n
      existing.q = q
      existing.u = uNew
    } else {
      this.tiles.set(key, {
        tx,
        tz,
        ids,
        rank,
        n,
        q,
        u: uNew,
        near: false,
        queued: false,
        gkey: this.ground ? this.ground.groundKeyAt((tx + 0.5) * tile, (tz + 0.5) * tile) : null,
      })
    }
  }

  /**
   * A rotation that lays the rock's up axis `amount` of the way toward the
   * ground normal.
   *
   * Four extra field samples, paid once per PLACED rock and never again -- which
   * is why it is off for the underfoot bed, where it would be four samples for a
   * four-centimetre pebble nobody can see the lean of. The normal comes off the
   * FIELD rather than the drawn mesh on purpose: the mesh's normal changes every
   * time the chunk under the rock re-splits, and a boulder that rocked back and
   * forth as the terrain LOD moved would be far worse than one leaning a degree
   * off the triangle it stands on.
   */
  _groundTilt(x, z, amount) {
    const e = 1.5
    const hx = this.field.heightAt(x + e, z) - this.field.heightAt(x - e, z)
    const hz = this.field.heightAt(x, z + e) - this.field.heightAt(x, z - e)
    this._n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize()
    this._n.lerp(this._up, 1 - amount).normalize()
    return this._tiltQ.setFromUnitVectors(this._up, this._n)
  }

  /** See Trees._groundFor: the surface that is DRAWN, with the field as a fallback. */
  _groundFor(x, z) {
    if (this.ground) {
      const g = this.ground.groundAt(x, z)
      if (g !== null) return g
    }
    return this.field.heightAt(x, z)
  }

  _reground(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const y = this._groundFor(this.instX[id], this.instZ[id]) - this.instSink[id]
      if (y === this.instY[id]) continue
      this.instY[id] = y
      this.batch.getMatrixAt(id, this._m)
      this._m.elements[13] = y
      this.batch.setMatrixAt(id, this._m)
    }
  }

  _thin(tile, uNew) {
    let w = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (tile.rank[k] < uNew) {
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
        continue
      }
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    tile.n = w
  }

  _demote(tile, coarse) {
    for (let k = 0; k < tile.n; k++) {
      const i = tile.ids[k]
      if (this.tierAt[i] === coarse) continue
      this.tierAt[i] = coarse
      this.batch.setGeometryIdAt(i, this.tierIds[coarse][this.shapeAt[i]])
    }
  }

  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n
  }

  get stats() {
    return {
      name: this.cfg.name,
      placed: this.placed,
      samples: this.samples,
      tris: this.tris,
      tiles: this.tiles.size,
      queued: this.queue.length,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      density: this.density,
      fullRadius: this.fullRadius,
      radius: this.radius,
      shapes: this.shapes.length,
      rejected: this.rejected,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
      regrows: this.regrows,
      regrounds: this.regrounds,
    }
  }

  dispose() {
    this.batch.dispose()
  }
}

/**
 * All the world's stone: one bank, one material, three beds.
 *
 * The public shape matches Trees/Ferns/Grass -- construct, `place` once at
 * spawn, `update` every frame, `syncBands` after the layers are known -- so
 * v2/main.js wires it exactly like the other three.
 */
export class Rocks {
  /**
   * @param scene         THREE.Scene. Gets three BatchedMeshes, one per bed.
   * @param field         V2Height. Needs scatterAt, heightAt and snowLineAt.
   * @param water         WaterSurfaces. Needs levelAt and isSubmerged.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param opts.ground   TerrainV2, or null for headless probes. See Trees.
   * @param opts.seeds    Shapes per variant in the bank. 3 x 16 = 48 rocks.
   */
  constructor(scene, field, water, textureArray, { seed = 1, ground = null, seeds = 3 } = {}) {
    if (!field || typeof field.scatterAt !== 'function') throw new Error('Rocks: needs a V2Height with scatterAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Rocks: needs WaterSurfaces with levelAt')
    if (ground && typeof ground.groundAt !== 'function') {
      throw new Error('Rocks: `ground` was given but has no groundAt -- pass the TerrainV2 or nothing')
    }

    const t0 = performance.now()
    const bank = buildRockBank({ seed, seeds })
    this.bank = bank

    // ONE material for all three beds. Nothing here billboards, so unlike the
    // trees, the ferns and the grass there is no per-bed shader source and no
    // reason for three programs. Three draw calls, one program, one atlas.
    this.material = createPropMaterial(textureArray)

    this.beds = BEDS.map((cfg, i) => new RockBed(scene, field, water, this.material, bank, cfg, i, { seed, ground }))

    // BatchedMesh has copied every vertex into its arena, three times over; the
    // bank's own geometries are now a fourth copy with no reader.
    for (const g of bank.geometries) g.dispose()

    this.buildMs = performance.now() - t0
    this.placeMs = 0
  }

  /** Grow every bed at once, ignoring the frame budget. Boot only. */
  place(cx, cz) {
    const t0 = performance.now()
    let placed = 0
    for (const bed of this.beds) placed += bed.place(cx, cz)
    this.placeMs = performance.now() - t0
    return placed
  }

  /**
   * The whole build budget is split evenly across the beds rather than drained
   * bed by bed. Giving it to the first would starve the giants behind a wall of
   * pebbles on a fast traverse, and a missing landmark at 800 m is far more
   * visible than a missing pebble at 30.
   */
  update(camX, camY, camZ) {
    const slice = BUILD_BUDGET_MS / this.beds.length
    for (const bed of this.beds) bed.update(camX, camY, camZ, slice)
  }

  /**
   * Point the props' snow and moss lines at the terrain's own snow band.
   *
   * Snow takes the band verbatim, so a rock and the ground it sits on go white
   * together -- the same call Trees.syncSnowLine makes, and calling both is
   * harmless because the uniforms are global and the value is identical.
   *
   * Moss gets a line of its own, derived from the snow's: MOSS_DROP metres below
   * it, fading over a band twice as wide. Moss is about damp rather than cold,
   * so it gives out well before the snow starts, and it gives out gradually --
   * a hard moss contour halfway up a mountain would read as a paint line.
   */
  syncBands(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
    setMossLine(layers.snow.base - MOSS_DROP, layers.snow.band * 2)
  }

  get stats() {
    const beds = this.beds.map((b) => b.stats)
    return {
      beds,
      placed: beds.reduce((n, b) => n + b.placed, 0),
      tris: beds.reduce((n, b) => n + b.tris, 0),
      pool: beds.reduce((n, b) => n + b.pool, 0),
      used: beds.reduce((n, b) => n + b.used, 0),
      shapes: this.bank.shapes.length,
      bankKB: Math.round(this.bank.bytes / 1024),
      bankTris: this.bank.triangles,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
    }
  }

  dispose() {
    for (const bed of this.beds) bed.dispose()
    this.material.dispose()
  }
}
