import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../sim/mathx.js'
import { planVillage, VILLAGE_PLAN } from './plan.js'
import {
  buildLonghouse, buildHut, buildBarn, buildShed, buildWorkshop,
  buildFenceRun, buildGateRun, buildCropRow, buildStall, buildLamppost,
  buildBonfire, buildBench, buildStool, buildWell, buildCart, buildBarrel,
  buildCrate, buildHaybale, buildWoodpile, buildDryingRack, buildTrough,
  buildAnimal, buildFlame, buildPuff, LAMP_FLAME_OFFSET,
} from './shapes.js'

// ---------------------------------------------------------------------------
// Villages, on screen.
//
// plan.js decides what a village is made of and where every piece of it goes,
// in pure data, with no three.js anywhere near it. This file turns one plan
// into meshes. The split is DESIGN.md §1's porting rule, and it is also what
// lets scripts/check-village.mjs run the whole layout headlessly in node.
//
// SITING IS NOT DONE HERE EITHER. `setSites()` takes the village positions
// Phase A already scores against fresh water, and this module has no opinion
// about them. When lakes land and the macro structure moves, the sites move and
// the villages move with them, unchanged.
//
// Three decisions shape everything below:
//
//   ONE VILLAGE IS RESIDENT AT A TIME. VILLAGE.minSeparation in phase-a.js is
//   1400 m, so two villages are never both close enough to matter, and building
//   for one lets the whole thing be static merged geometry.
//
//   THE STATIC PARTS ARE MERGED, NOT BATCHED. props/scatter.js uses a
//   BatchedMesh because trees stream in and out continuously and it needs
//   per-instance culling to do it. A village does none of that: it is ~450
//   pieces that appear once, never move, and are all within 240 m of each
//   other, so per-instance culling would cull nothing and cost a matrix upload
//   per piece per frame. One merged geometry is 33k triangles in ONE draw call
//   against an 800k budget, and there is no bookkeeping at all.
//
//   THE BUILD IS SPREAD OVER FRAMES. Planning is ~6 ms and geometry is ~25 ms,
//   which as one frame is a visible hitch on approach. `_step()` drains a work
//   queue against a millisecond budget instead, so walking up to a village
//   costs a few frames of slightly-shorter frametime and no stutter.
//
// Fire is the exception to all of it: flames and smoke move every frame, so
// they are two InstancedMeshes with per-instance matrices, sized once and
// rewritten in place. There is no light attached to any of them -- §5 allows
// exactly one real-time light and the sun has it -- so a flame is bright
// because its vertex colours are near 1.0 in an unlit material, not because it
// illuminates anything. That is the whole trick, and it is free.
// ---------------------------------------------------------------------------

const TUNING = {
  // Hysteresis, so standing on the boundary does not thrash a 30 ms rebuild.
  loadRadius: 900,
  unloadRadius: 1150,
  buildBudgetMs: 2.5, // geometry work per frame while a village is coming in

  // Paths sit ABOVE the ground, not in it. The terrain is an LOD heightfield,
  // so at distance the rendered surface is a coarse approximation of heightAt
  // and a ribbon laid exactly on the sampled height sinks into it. The lift is
  // per path CLASS, which does double duty: it is also what stops two ribbons
  // that cross from z-fighting, deterministically and without sorting.
  pathLift: { artery: 0.15, ring: 0.17, lane: 0.19, spur: 0.21 },
  pathFeather: 0.9, // metres of colour ramp outside the running surface

  // Fire and smoke.
  flameSize: { lamp: 0.34, bonfire: 1.15 },
  puffsPerLamp: 2,
  puffsPerFire: 6,
  smokeRise: { lamp: 3.4, bonfire: 7.5 },
  smokePeriod: { lamp: 2.9, bonfire: 4.4 },
  puffRadius: { lamp: 0.16, bonfire: 0.62 },
  wind: { x: 0.42, z: 0.26 }, // fraction of the rise, drifting downwind
  fireCullRadius: 420,
}

// Path surface colours, LINEAR. The outer feather ramps toward C_GRASS in
// sim/chunk-mesh.js -- a ribbon that ends in a hard line reads as a decal, and
// two metres of ramp is the difference between a road and a sticker.
const PATH_DIRT = new THREE.Color(0.052, 0.043, 0.03)
const PATH_GRAVEL = new THREE.Color(0.078, 0.072, 0.062)
const PATH_EDGE = new THREE.Color(0.048, 0.07, 0.031)

// --- the geometry kit -------------------------------------------------------
//
// Everything that is the same from village to village is built once and reused.
// Buildings are NOT in here: their width, depth and plinth all come out of the
// terrain under the specific site, so each one is its own geometry. That is
// twenty geometries per village, which is nothing, and it is what lets a hut
// terrace into a hillside instead of being scaled to fit one.
//
// Crop rows and fence runs ARE in here, at a canonical length, and the instance
// matrix scales them along X to the length the plan asked for. The stretch is
// under 15% either way -- a fence post 13% thicker than its neighbour is not a
// thing anyone will ever see, and it saves a geometry per run on 150 runs.

const CANON_ROW = 6 // metres, matching VILLAGE_PLAN.rowSegment
const CANON_FENCE = 3 // ...and VILLAGE_PLAN.fenceRun
const CANON_FIRE = 1.3

class Kit {
  constructor(seed) {
    this.seed = seed
    this.cache = new Map()
    this.tris = 0
  }

  get(key, make) {
    let g = this.cache.get(key)
    if (!g) {
      g = make()
      this.tris += g.index.count / 3
      this.cache.set(key, g)
    }
    return g
  }

  // A stable per-key seed, so the third variant of a cabbage row is the same
  // third variant in every village in the world.
  seedFor(key) {
    let h = this.seed >>> 0
    for (let i = 0; i < key.length; i++) h = (Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0)
    return h
  }

  prop(kind, extra = '', variant = 0) {
    const key = `${kind}:${extra}:${variant}`
    return this.get(key, () => {
      const seed = this.seedFor(key)
      switch (kind) {
        case 'stall': return buildStall({ goods: extra, seed })
        case 'well': return buildWell({ seed })
        case 'cart': return buildCart({ seed })
        case 'barrel': return buildBarrel({ seed })
        case 'crate': return buildCrate({ seed })
        case 'haybale': return buildHaybale({ seed })
        case 'woodpile': return buildWoodpile({ seed })
        case 'dryingrack': return buildDryingRack({ seed })
        case 'trough': return buildTrough({ seed })
        case 'bench': return buildBench({ seed })
        case 'stool': return buildStool({ seed })
        case 'sheep': case 'cow': case 'goat': case 'chicken':
          return buildAnimal({ kind, seed })
        default:
          throw new Error(`village: no geometry for prop kind "${kind}"`)
      }
    })
  }

  cropRow(crop, variant) {
    const key = `row:${crop}:${variant}`
    return this.get(key, () =>
      buildCropRow({ len: CANON_ROW, crop, variant, seed: this.seedFor(key) })
    )
  }

  fence(kind, variant) {
    const key = `fence:${kind}:${variant}`
    return this.get(key, () =>
      kind === 'gate'
        ? buildGateRun(CANON_FENCE, this.seedFor(key))
        : buildFenceRun(CANON_FENCE, this.seedFor(key))
    )
  }

  lamp() {
    return this.get('lamp', () => buildLamppost({ seed: this.seedFor('lamp') }))
  }

  bonfire(variant) {
    const key = `bonfire:${variant}`
    return this.get(key, () => buildBonfire({ r: CANON_FIRE, seed: this.seedFor(key) }))
  }

  dispose() {
    for (const g of this.cache.values()) g.dispose()
    this.cache.clear()
  }
}

function buildingGeometry(b, seed) {
  switch (b.kind) {
    case 'hall': return buildLonghouse({ w: b.w, d: b.d, plinth: b.plinth, seed })
    case 'hut': return buildHut({ w: b.w, d: b.d, plinth: b.plinth, variant: b.variant, seed })
    case 'barn': return buildBarn({ w: b.w, d: b.d, plinth: b.plinth, seed })
    case 'shed': return buildShed({ w: b.w, d: b.d, plinth: b.plinth, seed })
    case 'workshop': return buildWorkshop({ w: b.w, d: b.d, plinth: b.plinth, seed })
    default: throw new Error(`village: no geometry for building kind "${b.kind}"`)
  }
}

// --- path ribbons -----------------------------------------------------------

/**
 * A polyline draped on the terrain as a four-vertex-wide strip: two vertices
 * for the running surface and one feathered vertex each side that ramps to the
 * ground colour and sinks most of the way back to it.
 *
 * The heights are sampled from the height field per vertex rather than
 * interpolated along the polyline, because the plan's vertices are 5 m apart
 * and a straight chord across 5 m of this terrain can be half a metre off the
 * ground in the middle.
 */
function ribbonGeometry(path, terrain, wobblePhase) {
  const pts = path.pts
  if (pts.length < 2) return null
  const lift = TUNING.pathLift[path.cls]
  if (lift === undefined) throw new Error(`village: no ribbon lift for path class "${path.cls}"`)
  const hw = path.width / 2
  const feather = TUNING.pathFeather
  const n = pts.length

  const pos = new Float32Array(n * 4 * 3)
  const col = new Float32Array(n * 4 * 3)
  const idx = new Uint16Array((n - 1) * 3 * 6)
  const c = new THREE.Color()

  for (let i = 0; i < n; i++) {
    const p = pts[i]
    // Tangent from the neighbours, so the ribbon mitres its corners rather
    // than notching them.
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    const tx = b.x - a.x
    const tz = b.z - a.z
    const tl = Math.hypot(tx, tz) || 1
    const nx = -tz / tl
    const nz = tx / tl

    // Ruts: the running surface is gravel down the middle and packed dirt at
    // the edges, mixed with a wobble along the path so it is not a stripe.
    const wear = 0.5 + 0.5 * Math.sin(i * 0.9 + wobblePhase)
    for (let k = 0; k < 4; k++) {
      const off = [-(hw + feather), -hw, hw, hw + feather][k]
      const edge = k === 0 || k === 3
      const vx = p.x + nx * off
      const vz = p.z + nz * off
      const vy = terrain.heightAt(vx, vz) + (edge ? lift * 0.35 : lift)
      const o = (i * 4 + k) * 3
      pos[o] = vx
      pos[o + 1] = vy
      pos[o + 2] = vz
      if (edge) c.copy(PATH_EDGE)
      else c.copy(PATH_DIRT).lerp(PATH_GRAVEL, wear * 0.7)
      col[o] = c.r
      col[o + 1] = c.g
      col[o + 2] = c.b
    }
  }

  let w = 0
  for (let i = 0; i + 1 < n; i++) {
    for (let k = 0; k < 3; k++) {
      const a = i * 4 + k
      const b = a + 1
      const d = (i + 1) * 4 + k
      const e = d + 1
      idx[w++] = a; idx[w++] = d; idx[w++] = b
      idx[w++] = b; idx[w++] = d; idx[w++] = e
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  g.computeVertexNormals()
  return g
}

// --- the layer --------------------------------------------------------------

const MAT4 = new THREE.Matrix4()
const QUAT = new THREE.Quaternion()
const VEC = new THREE.Vector3()
const SCL = new THREE.Vector3()
const AXIS_Y = new THREE.Vector3(0, 1, 0)

export class Villages {
  constructor(scene, terrainHeight, { seed = 1337, onChange = null } = {}) {
    this.scene = scene
    this.th = terrainHeight
    this.seed = seed >>> 0
    // Fired when the resident village appears or disappears, so the caller can
    // re-run whatever depends on the footprint -- in practice scatter.invalidate(),
    // because the props were placed before this village existed and a tree is
    // now standing in the great hall.
    this.onChange = onChange
    this.kit = new Kit(this.seed)
    this.sites = []

    this.solidMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      // Cloth awnings, crop leaves, hanging fish and fence rails seen edge-on
      // are all single quads. Mirroring each one in geometry -- the trick
      // props/shapes.js uses for grass -- would double the vertex count of
      // nearly everything, and the village is 4% of the triangle budget, so
      // paying for backfaces is the cheaper side of that trade.
      side: THREE.DoubleSide,
    })
    this.pathMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      // The ribbon is lifted above the ground, but only by centimetres, and at
      // 300 m the depth buffer does not resolve centimetres. Offset pulls it
      // toward the camera in depth without moving it in space.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    })
    // Unlit, so a flame does not go dark on the side away from the sun -- which
    // is the single thing that would give it away.
    this.flameMat = new THREE.MeshBasicMaterial({ vertexColors: true })
    this.puffMat = new THREE.MeshLambertMaterial({ vertexColors: true })

    this.flameGeo = buildFlame({ h: 1, r: 0.36, seed: this.seed })
    this.puffGeo = buildPuff({ r: 1, seed: this.seed ^ 0x9e37 })
    this.flames = new THREE.InstancedMesh(this.flameGeo, this.flameMat, 320)
    this.puffs = new THREE.InstancedMesh(this.puffGeo, this.puffMat, 512)
    for (const m of [this.flames, this.puffs]) {
      m.count = 0
      m.frustumCulled = false // both are tiny and the village is one place
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      scene.add(m)
    }

    this.plan = null
    this.solid = null
    this.pathMesh = null
    this.emitters = [] // smoke sources: { x, y, z, kind }
    this.flameSpecs = [] // { x, y, z, size, phase, jitter }
    this._queue = null
    this._parts = null
    this._pathParts = null
    this._pending = null

    this.stats = {
      resident: null,
      state: 'idle',
      tris: 0,
      pathTris: 0,
      instances: 0,
      flames: 0,
      puffs: 0,
      planMs: 0,
      buildMs: 0,
      warnings: [],
    }
  }

  /**
   * The village positions, from Phase A. Called once when the macro pass lands
   * and again whenever it is re-run; if the resident village is no longer in
   * the list, or has moved, it is torn down and rebuilt from the new site.
   */
  setSites(sites) {
    this.sites = sites.map((s, i) => ({ x: s.x, z: s.z, id: s.id ?? i }))
    if (this.plan) {
      const still = this.sites.some(
        (s) => Math.hypot(s.x - this.plan.x, s.z - this.plan.z) < 1
      )
      if (!still) this._unload()
    }
  }

  update(camX, camZ, time) {
    // Nearest site, with hysteresis so standing on the boundary does not thrash.
    let near = null
    let nearD = Infinity
    for (const s of this.sites) {
      const d = Math.hypot(s.x - camX, s.z - camZ)
      if (d < nearD) {
        nearD = d
        near = s
      }
    }

    const resident = this._pending ? this._pending.plan : this.plan
    if (resident && Math.hypot(resident.x - camX, resident.z - camZ) > TUNING.unloadRadius) {
      this._unload()
    }
    if (!this._pending && !this.plan && near && nearD < TUNING.loadRadius) {
      this._beginBuild(near)
    }

    if (this._pending) this._step()
    if (this.plan) this._animateFire(camX, camZ, time)
  }

  // --- build ----------------------------------------------------------------

  _beginBuild(site) {
    const t0 = performance.now()
    const plan = planVillage(site, this.th, { seed: this.seed, id: site.id })
    this.stats.planMs = performance.now() - t0
    this.stats.warnings = plan.warnings
    this.stats.resident = `${Math.round(site.x)},${Math.round(site.z)}`
    this.stats.state = 'building'
    this.stats.buildMs = 0

    // Every piece of the village, as a list of thunks the frame budget drains.
    // Fenceposts and crop rows dominate the count, so the queue is chunked
    // rather than one entry per piece -- 450 closures is 450 allocations and
    // the whole point is to keep the frame cheap.
    const jobs = []
    const chunk = (arr, fn, size = 24) => {
      for (let i = 0; i < arr.length; i += size) {
        const lo = i
        const hi = Math.min(arr.length, i + size)
        jobs.push(() => { for (let k = lo; k < hi; k++) fn(arr[k], k) })
      }
    }

    const parts = []
    const pathParts = []
    this._parts = parts
    this._pathParts = pathParts
    this._pending = { site, plan, jobs, at: 0 }

    const place = (geo, x, y, z, yaw, sx = 1, sy = 1, sz = 1) => {
      QUAT.setFromAxisAngle(AXIS_Y, yaw)
      VEC.set(x, y, z)
      SCL.set(sx, sy, sz)
      MAT4.compose(VEC, QUAT, SCL)
      parts.push(geo.clone().applyMatrix4(MAT4))
    }

    chunk(plan.buildings, (b, i) => {
      const geo = buildingGeometry(b, (this.seed ^ Math.imul(i + 1, 0x27d4eb2d)) >>> 0)
      // The plan's `y` is the floor, at the building's HIGHEST corner, and the
      // plinth grows DOWN from it -- so the geometry, which starts its plinth
      // at y = 0, drops by exactly the plinth height.
      place(geo, b.x, b.y - b.plinth, b.z, b.yaw)
      geo.dispose() // one-off: it is in `parts` now as a transformed clone
    })

    chunk(plan.fences, (f) => {
      const variant = f.kind === 'gate' ? 0 : (Math.abs(Math.round(f.x * 3 + f.z * 7)) % 3)
      place(this.kit.fence(f.kind, variant), f.x, f.y, f.z, f.yaw, f.len / CANON_FENCE, 1, 1)
    })

    for (const field of plan.fields) {
      chunk(field.rows, (r) => {
        place(this.kit.cropRow(r.crop, r.variant), r.x, r.y, r.z, r.yaw, r.len / CANON_ROW, 1, 1)
      })
    }

    // The variant is a hash of position rather than a counter, so a barrel does
    // not change which barrel it is when the plan grows a prop before it.
    chunk(plan.props, (p) => {
      const variant = Math.abs(Math.round(p.x * 3.1 + p.z * 5.7)) % 3
      const goods = p.kind === 'stall' ? p.goods : ''
      place(this.kit.prop(p.kind, goods, variant), p.x, p.y, p.z, p.yaw, p.scale, p.scale, p.scale)
    })

    chunk(plan.lamps, (l) => {
      place(this.kit.lamp(), l.x, l.y, l.z, l.yaw)
    })

    chunk(plan.bonfires, (f, i) => {
      const s = f.r / CANON_FIRE
      place(this.kit.bonfire(i % 2), f.x, f.y, f.z, (f.x * 0.7 + f.z * 0.3) % Math.PI, s, s, s)
    })

    // Four at a time: a ribbon costs a heightAt per vertex per side and the
    // arteries are 160 m long, so these are the most expensive jobs in the queue.
    chunk(plan.paths, (p, i) => {
      const g = ribbonGeometry(p, this.th, i * 2.399)
      if (g) pathParts.push(g)
    }, 4)

    // Fire last, and as data rather than geometry: these drive the two
    // InstancedMeshes every frame.
    jobs.push(() => this._collectFire(plan))
  }

  _step() {
    const p = this._pending
    const t0 = performance.now()
    while (p.at < p.jobs.length && performance.now() - t0 < TUNING.buildBudgetMs) {
      p.jobs[p.at++]()
    }
    this.stats.buildMs += performance.now() - t0
    if (p.at < p.jobs.length) return

    const tm0 = performance.now()
    const solidGeo = this._parts.length ? mergeGeometries(this._parts, false) : null
    if (this._parts.length && !solidGeo) {
      throw new Error('village merge failed -- a prop geometry has a mismatched attribute layout')
    }
    for (const g of this._parts) g.dispose()
    const pathGeo = this._pathParts.length ? mergeGeometries(this._pathParts, false) : null
    for (const g of this._pathParts) g.dispose()

    if (solidGeo) {
      solidGeo.computeBoundingSphere()
      this.solid = new THREE.Mesh(solidGeo, this.solidMat)
      this.solid.frustumCulled = true
      this.scene.add(this.solid)
      this.stats.tris = solidGeo.index.count / 3
    }
    if (pathGeo) {
      pathGeo.computeBoundingSphere()
      this.pathMesh = new THREE.Mesh(pathGeo, this.pathMat)
      this.scene.add(this.pathMesh)
      this.stats.pathTris = pathGeo.index.count / 3
    }

    this.plan = p.plan
    this.stats.buildMs += performance.now() - tm0
    this.stats.instances = p.plan.stats.instances
    this.stats.state = 'live'
    this._pending = null
    this._parts = null
    this._pathParts = null
    if (this.onChange) this.onChange()
  }

  _collectFire(plan) {
    const flames = []
    const emitters = []
    const rand = mulberry32(this.seed ^ 0x5f3a)

    for (const l of plan.lamps) {
      // The flame hangs off the lamp's arm, which is on local +X -- rotate the
      // offset into the lamp's frame rather than guessing where it ended up.
      const s = Math.sin(l.yaw)
      const c = Math.cos(l.yaw)
      const fx = l.x + LAMP_FLAME_OFFSET.x * c + LAMP_FLAME_OFFSET.z * s
      const fz = l.z - LAMP_FLAME_OFFSET.x * s + LAMP_FLAME_OFFSET.z * c
      const fy = l.y + LAMP_FLAME_OFFSET.y
      flames.push({ x: fx, y: fy, z: fz, size: TUNING.flameSize.lamp, phase: l.phase, sway: 0.06 })
      emitters.push({ x: fx, y: fy + 0.2, z: fz, kind: 'lamp', phase: l.phase })
    }
    for (const f of plan.bonfires) {
      const size = TUNING.flameSize.bonfire * (f.r / CANON_FIRE)
      flames.push({ x: f.x, y: f.y + f.r * 0.45, z: f.z, size, phase: rand() * Math.PI * 2, sway: 0.22 })
      emitters.push({ x: f.x, y: f.y + f.r * 1.5, z: f.z, kind: 'bonfire', phase: rand() * Math.PI * 2 })
    }

    this.flameSpecs = flames
    this.emitters = emitters

    const puffCount = emitters.reduce(
      (n, e) => n + (e.kind === 'lamp' ? TUNING.puffsPerLamp : TUNING.puffsPerFire), 0
    )
    if (flames.length > this.flames.instanceMatrix.count) {
      throw new Error(`village: ${flames.length} flames exceeds the ${this.flames.instanceMatrix.count} allocated`)
    }
    if (puffCount > this.puffs.instanceMatrix.count) {
      throw new Error(`village: ${puffCount} puffs exceeds the ${this.puffs.instanceMatrix.count} allocated`)
    }
    this.stats.flames = flames.length
    this.stats.puffs = puffCount
  }

  // --- fire animation -------------------------------------------------------

  _animateFire(camX, camZ, t) {
    const far = Math.hypot(this.plan.x - camX, this.plan.z - camZ) > TUNING.fireCullRadius + VILLAGE_PLAN.fieldOuter
    if (far) {
      this.flames.count = 0
      this.puffs.count = 0
      return
    }

    // Flames. Two sines at incommensurable rates, so the flicker never settles
    // into a visible beat, and the flame gets WIDER as it gets shorter -- a
    // flame that only scales in Y reads as a pulsing cone.
    let n = 0
    for (const f of this.flameSpecs) {
      const flick = 0.84 + 0.16 * Math.sin(t * 11.3 + f.phase) + 0.09 * Math.sin(t * 24.7 + f.phase * 2.3)
      const wide = 1.0 + (1 - flick) * 0.9
      QUAT.setFromAxisAngle(AXIS_Y, f.phase + Math.sin(t * 6.1 + f.phase) * 0.4)
      VEC.set(
        f.x + Math.sin(t * 3.7 + f.phase) * f.sway,
        f.y,
        f.z + Math.cos(t * 4.3 + f.phase * 1.7) * f.sway
      )
      SCL.set(f.size * wide, f.size * flick * 1.35, f.size * wide)
      MAT4.compose(VEC, QUAT, SCL)
      this.flames.setMatrixAt(n++, MAT4)
    }
    this.flames.count = n
    if (n) this.flames.instanceMatrix.needsUpdate = true

    // Smoke. Each puff is a pure function of (time + its phase) -- no state, no
    // allocation, and it restarts identically if the village unloads and comes
    // back. It cannot fade out: §7 reserves alpha blending for the aurora,
    // water, mist and snow, because blending inside batched or instanced
    // geometry cannot be depth-sorted. So it grows as it rises and then scales
    // to nothing, which is how stylised smoke has always been done.
    let m = 0
    for (const e of this.emitters) {
      const count = e.kind === 'lamp' ? TUNING.puffsPerLamp : TUNING.puffsPerFire
      const period = TUNING.smokePeriod[e.kind]
      const rise = TUNING.smokeRise[e.kind]
      const baseR = TUNING.puffRadius[e.kind]
      for (let i = 0; i < count; i++) {
        const raw = t / period + e.phase + i / count
        const u = raw - Math.floor(raw)
        // Zero at both ends, peaking early, so a puff never pops into or out of
        // existence at full size.
        const env = Math.sin(Math.PI * Math.pow(u, 0.55))
        const s = baseR * (0.5 + 1.4 * u) * env
        if (s < 0.005) continue
        // The drift accelerates, which reads as the puff clearing the roofline
        // and being taken by the wind rather than being blown sideways off the
        // flame.
        const drift = rise * u * u
        QUAT.setFromAxisAngle(AXIS_Y, e.phase + u * 2.1 + i)
        VEC.set(e.x + TUNING.wind.x * drift, e.y + rise * u, e.z + TUNING.wind.z * drift)
        SCL.set(s, s * 0.8, s)
        MAT4.compose(VEC, QUAT, SCL)
        this.puffs.setMatrixAt(m++, MAT4)
      }
    }
    this.puffs.count = m
    if (m) this.puffs.instanceMatrix.needsUpdate = true
  }

  // --- prop exclusion -------------------------------------------------------

  /**
   * §6: the scatter has to reject candidates inside a village footprint. Wired
   * into scatter.js as a callback rather than the scatter importing this,
   * because the scatter must not care whether villages exist.
   *
   * Grass is the exception and gets a much smaller exclusion: a village with no
   * grass anywhere inside 136 m reads as a bald patch visible from the ridge
   * above it, and grass growing between the huts is correct anyway. It still
   * stays out of the plaza, which is packed earth.
   */
  excludes(x, z, kindName) {
    if (!this.plan) return false
    const d = Math.hypot(x - this.plan.x, z - this.plan.z)
    if (kindName === 'grass') return d < VILLAGE_PLAN.plazaRadius + 3
    return d < this.plan.clearRadius
  }

  // --- teardown -------------------------------------------------------------

  _unload() {
    // Read before the teardown clears it: the scatter only needs re-running if
    // there WAS a footprint to release.
    const wasLive = this.plan !== null
    if (this.solid) {
      this.scene.remove(this.solid)
      this.solid.geometry.dispose()
      this.solid = null
    }
    if (this.pathMesh) {
      this.scene.remove(this.pathMesh)
      this.pathMesh.geometry.dispose()
      this.pathMesh = null
    }
    if (this._parts) for (const g of this._parts) g.dispose()
    if (this._pathParts) for (const g of this._pathParts) g.dispose()
    this._parts = null
    this._pathParts = null
    this._pending = null
    this.plan = null
    this.flameSpecs = []
    this.emitters = []
    this.flames.count = 0
    this.puffs.count = 0
    this.stats.state = 'idle'
    this.stats.resident = null
    this.stats.tris = 0
    this.stats.pathTris = 0
    this.stats.instances = 0
    this.stats.flames = 0
    this.stats.puffs = 0
    this.stats.warnings = []
    if (wasLive && this.onChange) this.onChange()
  }

  dispose() {
    this._unload()
    this.scene.remove(this.flames)
    this.scene.remove(this.puffs)
    this.flames.dispose()
    this.puffs.dispose()
    this.flameGeo.dispose()
    this.puffGeo.dispose()
    this.kit.dispose()
    this.solidMat.dispose()
    this.pathMat.dispose()
    this.flameMat.dispose()
    this.puffMat.dispose()
  }
}
