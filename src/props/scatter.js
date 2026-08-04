import * as THREE from 'three'
import { mulberry32, clamp01, smoothstep } from '../sim/mathx.js'
import { buildConifer, buildBoulder, buildGrass, buildCabin } from './shapes.js'

// ---------------------------------------------------------------------------
// Scattered props -- a SCALE REFERENCE, not the placement system.
//
// The real thing is DESIGN.md §6 (density fields from the Phase A biome pass,
// path-aware clearing, village exclusion) plus §5's LOD tiering, and it lands at
// build step 5. None of that exists yet and building it now would mean building
// it blind.
//
// What this is for: an empty heightfield gives you no way to judge how big a
// mountain is or how fast you are moving across it. Trees give you one number,
// but only one. A cabin, a boulder you could sit on and a tuft of grass at your
// feet give you four scales an order of magnitude apart, and it is having
// several at once that makes a valley read as a valley rather than as a shape.
//
// It does share the architecture it needs to share (§5): ONE BatchedMesh, ONE
// material, per-instance geometry selection. If that is wrong, better to find
// out on 1,200 props than on 40,000.
//
// Two rules earn their complexity here:
//
//   Density tapers with distance rather than stopping at a cull radius. A hard
//   edge is visible as a moving wall of trees; a taper reads as depth. The far
//   ring also carries a scale fade so the outermost instances dissolve rather
//   than pop, because at 800 m the fog is only 3% and hides nothing.
//
//   At most one kind rebuilds per frame. Grass re-places itself every 14 m of
//   travel, which at fly speed is three times a second, and stacking it in the
//   same frame as a tree pass is a visible hitch for no reason.
// ---------------------------------------------------------------------------

const KINDS = [
  {
    name: 'tree',
    salt: 0x9e3779b9,
    spacing: 42, // metres between candidate cells
    radius: 820,
    density: 0.62, // fraction of cells that hold a candidate at all
    tailDensity: 0.3, // ...falling to this at the cull radius
    falloffFrom: 200,
    max: 480,
    minElev: 45,
    maxElev: 470, // treeline. One of the strongest scale cues a mountain has:
    elevFade: 90, // it tells you how high you are without a number.
    maxSlopeDeg: 32,
    scale: [0.75, 1.3],
    sink: 0.15,
  },
  {
    name: 'rock',
    salt: 0x85ebca6b,
    spacing: 26,
    radius: 430,
    density: 0.5,
    tailDensity: 0.3,
    falloffFrom: 120,
    max: 480,
    minElev: 32,
    maxElev: 2000, // boulders go all the way up; nothing to fade against
    elevFade: 0,
    maxSlopeDeg: 41, // they sit on ground steeper than she can walk
    scale: [0.55, 2.1],
    sink: 0.05,
  },
  {
    name: 'grass',
    salt: 0xc2b2ae35,
    // Grass trades reach for density, which is the opposite of the other kinds.
    // A tuft is ~0.4 m: past 30 m it is a sub-pixel speck and costs a draw for
    // nothing, but within 30 m it is the only thing giving the ground texture at
    // walking pace. So: small disc, tufts ~2.5 m apart rather than ~8 m. ~500
    // instances of 10 tris is 5k -- nothing against the 800k budget.
    //
    // The cost that matters is not the triangles, it is the rebuild: every
    // candidate cell in the disc pays a heightAt and most survivors pay a
    // slopeAt too. At spacing 1.6 / radius 32 that measured 3.0 ms, a fifth of
    // a 72 Hz frame. Widening the grid and pushing density up keeps the tufts
    // roughly where they were for about two thirds of the cells.
    spacing: 1.9,
    rebuildEvery: 10, // decoupled from spacing; see update()
    radius: 30,
    density: 0.95,
    tailDensity: 0.5,
    falloffFrom: 12,
    max: 800,
    minElev: 34,
    maxElev: 430,
    elevFade: 70,
    maxSlopeDeg: 27,
    scale: [0.8, 1.4],
    sink: 0.03,
  },
  {
    name: 'cabin',
    salt: 0x27d4eb2f,
    spacing: 260,
    radius: 1050,
    density: 0.4,
    tailDensity: 0.75,
    falloffFrom: 500,
    max: 28,
    minElev: 45,
    maxElev: 340,
    elevFade: 50,
    maxSlopeDeg: 9, // people build on flat ground, and a box on a slope floats
    scale: [0.95, 1.12],
    sink: 0.35,
  },
]

// Geometry variants per kind. Index into this by kind name.
function buildVariants(seed) {
  return {
    tree: [
      buildConifer({ height: 13.5, radius: 2.5, tiers: 4, segments: 7, lean: 0.02 }),
      buildConifer({ height: 9.0, radius: 2.1, tiers: 3, segments: 6, lean: -0.035 }),
      buildConifer({ height: 17.0, radius: 2.8, tiers: 5, segments: 7, lean: 0.045 }),
    ],
    // "One metre tall" is the brief, and it is a good one: a boulder is the
    // only prop here whose real-world size a person can check by eye.
    rock: [
      buildBoulder({ height: 1.0, squash: 0.72, jitter: 0.18, seed: seed + 1 }),
      buildBoulder({ height: 1.15, squash: 0.5, jitter: 0.26, seed: seed + 2 }),
      buildBoulder({ height: 0.8, squash: 0.9, jitter: 0.12, seed: seed + 3 }),
    ],
    grass: [
      buildGrass({ blades: 6, height: 0.42, width: 0.06, spread: 0.3, seed: seed + 11 }),
      buildGrass({ blades: 4, height: 0.3, width: 0.05, spread: 0.22, seed: seed + 12 }),
    ],
    cabin: [
      buildCabin({ width: 6.2, depth: 4.6, wallH: 2.6, roofPitch: 1.1, seed: seed + 21 }),
      buildCabin({ width: 4.8, depth: 4.0, wallH: 2.3, roofPitch: 1.25, seed: seed + 22 }),
    ],
  }
}

export class Scatter {
  constructor(scene, terrainHeight, { seed = 1337 } = {}) {
    this.th = terrainHeight
    this.seed = seed
    this.scene = scene

    const variants = buildVariants(seed)
    const all = KINDS.flatMap((k) => variants[k.name])
    const totalVerts = all.reduce((n, g) => n + g.attributes.position.count, 0)
    const totalIndices = all.reduce((n, g) => n + g.index.count, 0)
    const totalInstances = KINDS.reduce((n, k) => n + k.max, 0)

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.batch = new THREE.BatchedMesh(totalInstances, totalVerts, totalIndices, this.material)
    this.batch.name = 'props'
    this.batch.frustumCulled = false // per-instance culling does the work
    this.batch.sortObjects = true // front-to-back opaque ordering (§5)
    scene.add(this.batch)

    // Per-kind state. Instances are allocated up front and never move between
    // kinds; placement only rewrites geometry id, matrix, colour and visibility.
    this.kinds = KINDS.map((k) => {
      const geos = variants[k.name]
      const state = {
        cfg: k,
        geometryIds: geos.map((g) => this.batch.addGeometry(g)),
        trisPer: geos.map((g) => g.index.count / 3),
        instances: [],
        cellX: null,
        cellZ: null,
        dirty: true,
        dirtySince: 0,
        count: 0,
        tris: 0,
        capped: false,
      }
      for (let i = 0; i < k.max; i++) {
        const id = this.batch.addInstance(state.geometryIds[0])
        this.batch.setVisibleAt(id, false)
        state.instances.push(id)
      }
      for (const g of geos) g.dispose()
      return state
    })
    this.byName = Object.fromEntries(this.kinds.map((s) => [s.cfg.name, s]))

    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._up = new THREE.Vector3(0, 1, 0)
    this._p = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()

    this.frame = 0
    this.stats = { count: 0, tris: 0, lastBuildMs: 0, lastBuildKind: '', byKind: {}, capped: false }
  }

  // Cheap to call every frame: it only does work when she has crossed into a new
  // cell for some kind, and never rebuilds more than one kind per call.
  update(camX, camZ) {
    this.frame++

    let due = null
    for (const s of this.kinds) {
      const grid = s.cfg.rebuildEvery ?? s.cfg.spacing
      const cx = Math.round(camX / grid)
      const cz = Math.round(camZ / grid)
      if (cx !== s.cellX || cz !== s.cellZ) {
        s.cellX = cx
        s.cellZ = cz
        if (!s.dirty) {
          s.dirty = true
          s.dirtySince = this.frame
        }
      }
      // Oldest outstanding rebuild first, so a kind that keeps going dirty
      // cannot starve one that went dirty earlier.
      if (s.dirty && (due === null || s.dirtySince < due.dirtySince)) due = s
    }

    if (due) {
      const grid = due.cfg.rebuildEvery ?? due.cfg.spacing
      const t0 = performance.now()
      this._rebuild(due, due.cellX * grid, due.cellZ * grid)
      due.dirty = false
      this.stats.lastBuildMs = performance.now() - t0
      this.stats.lastBuildKind = due.cfg.name
      this._roll()
    }
  }

  _roll() {
    let count = 0
    let tris = 0
    let capped = false
    for (const s of this.kinds) {
      count += s.count
      tris += s.tris
      capped = capped || s.capped
      this.stats.byKind[s.cfg.name] = s.count
    }
    this.stats.count = count
    this.stats.tris = tris
    this.stats.capped = capped
  }

  // cx/cz are the centre of the disc in WORLD metres, already snapped.
  _rebuild(s, cx, cz) {
    const k = s.cfg
    const reach = Math.ceil(k.radius / k.spacing)
    const maxSlope = (k.maxSlopeDeg * Math.PI) / 180
    const r2 = k.radius * k.radius
    const fadeFrom = k.radius * 0.82 // scale fade band, so the edge dissolves
    const scaleSpan = k.scale[1] - k.scale[0]

    let n = 0
    let tris = 0
    let capped = false

    for (let jz = -reach; jz <= reach && !capped; jz++) {
      for (let jx = -reach; jx <= reach; jx++) {
        // Hash the ABSOLUTE cell index, not the loop index, so a prop does not
        // move when she does. The kind salt keeps trees and rocks from landing
        // on the same cells as each other.
        const gx = Math.round(cx / k.spacing) + jx
        const gz = Math.round(cz / k.spacing) + jz
        const rand = mulberry32((this.seed ^ k.salt ^ (gx * 73856093) ^ (gz * 19349663)) >>> 0)

        if (rand() > k.density) continue

        const x = gx * k.spacing + (rand() - 0.5) * k.spacing * 0.9
        const z = gz * k.spacing + (rand() - 0.5) * k.spacing * 0.9

        const dx = x - cx
        const dz = z - cz
        const d2 = dx * dx + dz * dz
        if (d2 > r2) continue
        const d = Math.sqrt(d2)

        // Density taper. Tested before any heightAt, so the far majority of
        // candidates cost one hash and nothing else.
        const near = 1 - smoothstep(k.falloffFrom, k.radius, d)
        if (rand() > k.tailDensity + (1 - k.tailDensity) * near) continue

        const h = this.th.heightAt(x, z)
        if (h < k.minElev) continue
        if (k.elevFade > 0 && h > k.maxElev - k.elevFade) {
          // Thin out through the band instead of cutting a hard line.
          const above = (h - (k.maxElev - k.elevFade)) / k.elevFade
          if (above >= 1 || rand() < above) continue
        } else if (h > k.maxElev) {
          continue
        }
        if (this.th.slopeAt(x, z, 1.5) > maxSlope) continue

        if (n >= k.max) {
          capped = true
          break
        }

        const id = s.instances[n]
        const variant = (rand() * s.geometryIds.length) | 0
        this.batch.setGeometryIdAt(id, s.geometryIds[variant])

        const fade = 1 - smoothstep(fadeFrom, k.radius, d)
        const scale = (k.scale[0] + rand() * scaleSpan) * fade
        this._p.set(x, h - k.sink * scale, z)
        this._q.setFromAxisAngle(this._up, rand() * Math.PI * 2)
        this._s.set(scale, scale, scale)
        this._m.compose(this._p, this._q, this._s)
        this.batch.setMatrixAt(id, this._m)

        // Slight per-instance tint so a stand does not look cloned.
        const g = 0.86 + rand() * 0.28
        this._c.setRGB(clamp01(g * (0.93 + rand() * 0.14)), clamp01(g), clamp01(g * 0.96))
        this.batch.setColorAt(id, this._c)

        this.batch.setVisibleAt(id, true)
        tris += s.trisPer[variant]
        n++
      }
    }

    for (let i = n; i < k.max; i++) this.batch.setVisibleAt(s.instances[i], false)

    s.count = n
    s.tris = tris
    s.capped = capped
    if (capped) {
      console.warn(`scatter: ${k.name} hit its ${k.max} instance cap -- raise max or lower density`)
    }
  }

  dispose() {
    this.scene.remove(this.batch)
    this.batch.dispose()
    this.material.dispose()
  }
}
