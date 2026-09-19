import THREE from '../../three-instance.js'

import { GEN_PROP_LODS, PROP_RUNGS, PROP_STEPS, createGenPropMaterial, ladderTris, loadGenProp, propCull } from './gen-props.js'
import { LOD_DEG, distAt, ladderTier } from './critters.js'
import { mulberry32 } from '../../sim/mathx.js'
import { keyHash } from '../../sim/score.js'
import { PropArena } from './prop-arena.js'

// ---------------------------------------------------------------------------
// THE LEAFKIN VILLAGE ENTRANCES (DESIGN.md §30): a stone arch on the face of
// each entrance boulder (rocks.js's `hollow` bed) with a black hole behind it.
// The layer owns no scatter of its own: every frame it asks the rocks for the
// resident hollows within RADIUS_M and seats a mouth on each new one, so a
// site is where its boulder is, on every client, and goes when the boulder
// goes. The face is found by rays against the boulder's own hull, from a
// bearing rolled off the site's key, so two clients agree on the mouth to the
// bit without exchanging it.
//
// The hole is a quad, not a cavity: an unlit black plane a hair proud of the
// stone across the arch's passage, so the depth test keeps it in front of the
// face and the arch's own walls around it. It reads as a hole because the
// parallax across the arch's protruding half metre is real.
//
// Drawn on the props' ladder (gen-props.js) with the shipped T3 in the card's
// place: an arch is on a wall, and a card spun to her would stand out of it.
// A rung switch is a plain swap -- a few dozen instances, none nearer than a
// boulder apart.
// ---------------------------------------------------------------------------

export const MOUTH_GLB = 'gen-props/cave-mouth.glb'
// Shipped tiers drawn, in rung order, on PROP_STEPS.
export const MOUTH_TIERS = [0, 2, 3]
export const RUNGS = PROP_RUNGS

// The arch, metres tall over its floor, and how far its centre is set into the face.
export const MOUTH_HEIGHT_M = 1.5
export const MOUTH_SINK_M = 0.1
// The hole: its size, how far it stands proud of the stone at its most bulging corner, and the bulge across it a face may have.
export const HOLE = { width: 1.1, height: 1.3, proud: 0.04, maxBulge: 0.4 }

// How far out a boulder is given a mouth, and its leafkin a home (leafkin.js).
export const RADIUS_M = 400

// The face probe: a ray from `out` metres past the hull's radius, `eye` above
// the ground there, toward the boulder's centre; the face passes when its
// normal is within `faceDeg` of horizontal, a second ray from the mouth point
// `wall` higher meets stone within `wallReach()`, and the ground at the hit
// and at the mouth point is within `level` of the ray's own.
export const PROBE = { out: 1, eye: 0.75, wall: 2, recede: 0.3, faceDeg: 20, level: 0.5, bearings: 8 }
// The mouth point: this far out from the face, on the ground.
export const MOUTH_STEP_M = 0.7
/** How far the wall ray may travel: the step, the lean a face at the limit has over `wall` metres, and `recede` of slack. */
export const wallReach = () => MOUTH_STEP_M + PROBE.wall * Math.tan((PROBE.faceDeg * Math.PI) / 180) + PROBE.recede

const HOLLOW_STRIDE = 5
const POOL = 48

/** The bank from the shipped ladder (gen-props.js loadGenProp): the drawn tiers, the scale to MOUTH_HEIGHT_M, the map. Pure, so the gate builds it in node. */
export function mouthBankFrom(ladder) {
  if (!ladder || ladder.geometries.length !== GEN_PROP_LODS + 1) {
    throw new Error(`Entrances: the mouth ladder has ${ladder?.geometries?.length ?? 0} tiers, expected ${GEN_PROP_LODS + 1}`)
  }
  const b = ladder.bounds
  // The passage runs along the pick's X: the ring of stones spans Z and stands in Y.
  if (!(b.long > b.width)) throw new Error(`Entrances: the mouth pick's ring must span Z, got ${b.width.toFixed(2)} x ${b.long.toFixed(2)}`)
  const scale = MOUTH_HEIGHT_M / b.height
  const geometries = MOUTH_TIERS.map((t) => ladder.geometries[t])
  return {
    tiers: geometries.map((g) => ({ geometries: [g] })),
    tris: ladderTris(geometries),
    scale,
    // Metres the arch reaches out of the face and across it at that scale.
    depth: b.width * scale,
    width: b.long * scale,
    map: ladder.map,
  }
}

export async function loadMouthBank() {
  return mouthBankFrom(await loadGenProp(MOUTH_GLB))
}

export class Entrances {
  /**
   * @param field  V2Height: heightAt
   * @param water  WaterSurfaces: isSubmerged
   * @param rocks  Rocks: hollowsInto, hollowRayAt
   * @param opts.bank  mouthBankFrom's answer. Required.
   * @param opts.fixed  a room's own mouths in place of the rocks' hollows: `[{ key, x, z, nx, nz }]`, the face point and its outward normal, seated once.
   */
  constructor(scene, field, water, rocks, { seed = 1, radius = null, bank = null, fixed = null } = {}) {
    if (!bank || !Array.isArray(bank.tiers)) throw new Error('Entrances: needs the bank from loadMouthBank (or mouthBankFrom)')
    if (!field || typeof field.heightAt !== 'function') throw new Error('Entrances: needs a V2Height with heightAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Entrances: needs WaterSurfaces with isSubmerged')
    if (!rocks || typeof rocks.hollowsInto !== 'function' || typeof rocks.hollowRayAt !== 'function') {
      throw new Error('Entrances: needs Rocks with hollowsInto and hollowRayAt')
    }
    this.field = field
    this.water = water
    this.rocks = rocks
    this.seed = seed | 0
    this.radius = radius ?? RADIUS_M
    if (fixed !== null && (!Array.isArray(fixed) || fixed.some((f) => typeof f.key !== 'string' || ![f.x, f.z, f.nx, f.nz].every(Number.isFinite)))) {
      throw new Error('Entrances: `fixed` is a list of { key, x, z, nx, nz }')
    }
    this.fixed = fixed
    this.bank = bank
    this.maxInstances = POOL

    this.material = createGenPropMaterial()
    this.material.map = bank.map
    this.materials = [this.material]
    this.batch = new PropArena(POOL, bank.tiers, new Array(bank.tiers.length).fill(POOL), () => this.material, 'v2-entrances')
    this.free = new Int32Array(POOL)
    this.freeCount = POOL
    for (let i = 0; i < POOL; i++) {
      const id = this.batch.addInstance(0)
      this.batch.setVisibleAt(id, false)
      this.free[POOL - 1 - i] = id
    }
    this.tierAt = new Int8Array(POOL).fill(-1)

    // The holes, one instance per arch on the same ids; a hidden one is a zero matrix.
    const quad = new THREE.PlaneGeometry(HOLE.width, HOLE.height)
    quad.rotateY(Math.PI / 2)
    this.holeMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false })
    this.holes = new THREE.InstancedMesh(quad, this.holeMaterial, POOL)
    this.holes.name = 'v2-entrance-holes'
    this.holes.frustumCulled = false
    this.holes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.holeM = new Float32Array(POOL * 16)
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0)
    for (let i = 0; i < POOL; i++) this.holes.setMatrixAt(i, this._zero)

    // key -> site, the resident mouths; `memory` keeps a site's `state` past its eviction, for the leafkin's cooldown.
    this.resident = new Map()
    this.memory = new Map()
    this.cull = propCull(MOUTH_HEIGHT_M)
    this.base = distAt(MOUTH_HEIGHT_M, LOD_DEG)
    this.hollows = new Float32Array(POOL * HOLLOW_STRIDE)
    this.seen = new Set()
    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    this._hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, ox: 0, oz: 0, size: 0 }

    this.placed = 0
    this.tris = 0
    this.rejected = { face: 0, wall: 0, level: 0, water: 0, bulge: 0, none: 0 }
    this.placeMs = 0

    scene.add(this.batch)
    scene.add(this.holes)
  }

  /** Seat a mouth on every resident hollow within the radius. For boot and for a relief edit. */
  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /**
   * Every resident mouth, for the portal (main.js) and the leafkin: `{ key,
   * x, y, z, nx, nz, r, state }` -- the point on the ground MOUTH_STEP_M out
   * from the face, the face's outward normal in the plane, the boulder's hull
   * radius about its centre and the site's own record, which survives
   * eviction.
   */
  sites(into = []) {
    for (const site of this.resident.values()) if (!site.blind) into.push(site)
    return into
  }

  /** Follow the rocks' residency and re-rung every arch by its distance. */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ)
    let tris = 0
    for (const site of this.resident.values()) {
      if (site.blind) continue
      const i = site.id
      const ex = site.ax - camX
      const ey = site.ay - camY
      const ez = site.az - camZ
      const cur = this.tierAt[i]
      const tier = ladderTier(this.base, PROP_STEPS, RUNGS, Math.sqrt(ex * ex + ey * ey + ez * ez), cur)
      if (tier !== cur) {
        this.tierAt[i] = tier
        const drawn = tier < RUNGS
        this.batch.setVisibleAt(i, drawn)
        if (drawn) this.batch.setGeometryIdAt(i, tier)
        this.holes.setMatrixAt(i, drawn ? this._m.fromArray(this.holeM, i * 16) : this._zero)
        this.holes.instanceMatrix.needsUpdate = true
      }
      if (tier < RUNGS) tris += this.bank.tris[tier] + 2
    }
    this.tris = tris
  }

  _reseat(cx, cz) {
    if (this.fixed !== null) {
      for (const f of this.fixed) if (!this.resident.has(f.key)) this._seatFixed(f)
      return
    }
    const r = this.radius
    const n = this.rocks.hollowsInto(cx - r, cz - r, cx + r, cz + r, this.hollows)
    if (n >= POOL) throw new Error(`Entrances: ${POOL} or more hollows within ${r} m`)
    const seen = this.seen
    seen.clear()
    for (let k = 0; k < n; k++) {
      const o = k * HOLLOW_STRIDE
      const key = `hollow:${this.hollows[o].toFixed(1)}:${this.hollows[o + 2].toFixed(1)}`
      seen.add(key)
      if (this.resident.has(key)) continue
      this._seat(key, this.hollows[o], this.hollows[o + 1], this.hollows[o + 2], this.hollows[o + 3])
    }
    for (const [key, site] of this.resident) {
      if (seen.has(key)) continue
      this._release(site)
      this.resident.delete(key)
    }
  }

  /**
   * The mouth on the boulder centred at (cx, cy, cz) with hull radius `r`: the
   * first of PROBE.bearings bearings off the key's roll whose face passes, or
   * none. A site that fails every bearing is recorded so it is not probed
   * again while resident.
   */
  _seat(key, cx, cy, cz, r) {
    const rand = mulberry32(keyHash(key) ^ this.seed)
    const a0 = rand() * Math.PI * 2
    const hit = this._hit
    const field = this.field
    const rocks = this.rocks
    const faceCos = Math.sin((PROBE.faceDeg * Math.PI) / 180)
    const reach = r + PROBE.out + 1
    for (let b = 0; b < PROBE.bearings; b++) {
      const a = a0 + (b / PROBE.bearings) * Math.PI * 2
      const dx = -Math.cos(a)
      const dz = -Math.sin(a)
      const sx = cx - dx * (r + PROBE.out)
      const sz = cz - dz * (r + PROBE.out)
      const g = field.heightAt(sx, sz)
      const y = g + PROBE.eye
      const t = rocks.hollowRayAt(sx, y, sz, dx, 0, dz, reach, hit)
      if (t === Infinity || t < PROBE.out * 0.5) { this.rejected.face++; continue }
      const hx = hit.x, hy = hit.y, hz = hit.z
      if (Math.abs(hit.ny) > faceCos) { this.rejected.face++; continue }
      // The outward normal in the plane, the arch's own axis.
      const nl = Math.hypot(hit.nx, hit.nz)
      const nx = hit.nx / nl
      const nz = hit.nz / nl
      const floor = field.heightAt(hx, hz)
      const mx = hx + nx * MOUTH_STEP_M
      const mz = hz + nz * MOUTH_STEP_M
      const my = field.heightAt(mx, mz)
      // The wall: from the mouth point, PROBE.wall above the eye, along the
      // normal, stone within the step plus what a face at the limit leans back.
      if (rocks.hollowRayAt(mx, my + PROBE.eye + PROBE.wall, mz, -nx, 0, -nz, wallReach(), hit) === Infinity) { this.rejected.wall++; continue }
      if (Math.abs(floor - g) > PROBE.level || Math.abs(my - g) > PROBE.level) { this.rejected.level++; continue }
      if (this.water.isSubmerged(mx, mz, my)) { this.rejected.water++; continue }
      // The stone across the hole: probed at the quad's corners, along the
      // normal from a metre out, so the quad stands proud of the most bulging
      // one and a face that recedes or bulges past HOLE.maxBulge is refused.
      const ax = -nz, az = nx
      let proud = -Infinity, deep = Infinity
      for (let c = 0; c < 4; c++) {
        const u = (c & 1 ? 0.45 : -0.45) * HOLE.width
        const v = floor + (c & 2 ? 0.92 : 0.08) * HOLE.height
        const tc = rocks.hollowRayAt(hx + ax * u + nx, v, hz + az * u + nz, -nx, 0, -nz, 2, hit)
        if (tc === Infinity) { proud = Infinity; break }
        const p = 1 - tc
        if (p > proud) proud = p
        if (p < deep) deep = p
      }
      if (proud === Infinity || proud - deep > HOLE.maxBulge) { this.rejected.bulge++; continue }
      this._place(key, hx, hz, nx, nz, floor, my, mx, mz, r, Math.max(0, proud) + HOLE.proud)
      return
    }
    this.rejected.none++
    this.resident.set(key, { key, id: -1, blind: true })
  }

  /** A room's mouth: the arch on the face point, the hole at HOLE.proud, no hull. */
  _seatFixed({ key, x, z, nx, nz }) {
    const nl = Math.hypot(nx, nz)
    nx /= nl
    nz /= nl
    const mx = x + nx * MOUTH_STEP_M
    const mz = z + nz * MOUTH_STEP_M
    this._place(key, x, z, nx, nz, this.field.heightAt(x, z), this.field.heightAt(mx, mz), mx, mz, 0, HOLE.proud)
  }

  _place(key, hx, hz, nx, nz, floor, my, mx, mz, r, hole) {
    if (this.freeCount === 0) throw new Error(`Entrances: instance pool exhausted at ${POOL}`)
    const id = this.free[--this.freeCount]
    const bank = this.bank
    // The arch's floor at the lower of its two feet, so the higher is bedded and neither floats.
    const half = bank.width * 0.45
    const ay = Math.min(floor, this.field.heightAt(hx - nz * half, hz + nx * half), this.field.heightAt(hx + nz * half, hz - nx * half)) - 0.05
    const ax = hx - nx * MOUTH_SINK_M
    const az = hz - nz * MOUTH_SINK_M
    // Yawed so the pick's +X, the passage, runs along the normal.
    this._q.setFromAxisAngle(this._up, Math.atan2(-nz, nx))
    this._s.setScalar(bank.scale)
    this.batch.setMatrixAt(id, this._m.compose(this._p.set(ax, ay, az), this._q, this._s))
    this._s.setScalar(1)
    this._m.compose(this._p.set(hx + nx * hole, floor + HOLE.height / 2, hz + nz * hole), this._q, this._s)
    this._m.toArray(this.holeM, id * 16)
    this.tierAt[id] = -1
    let state = this.memory.get(key)
    if (!state) {
      state = {}
      this.memory.set(key, state)
    }
    this.resident.set(key, { key, id, blind: false, x: mx, y: my, z: mz, nx, nz, r, ax, ay, az, state })
    this.placed++
  }

  _release(site) {
    if (site.blind) return
    const id = site.id
    this.batch.setVisibleAt(id, false)
    this.holes.setMatrixAt(id, this._zero)
    this.holes.instanceMatrix.needsUpdate = true
    this.tierAt[id] = -1
    this.free[this.freeCount++] = id
    this.placed--
  }

  get stats() {
    return {
      placed: this.placed,
      blind: this.resident.size - this.placed,
      tris: this.tris,
      pool: POOL,
      used: POOL - this.freeCount,
      radius: this.radius,
      cull: this.cull,
      placeMs: this.placeMs,
      rejected: this.rejected,
    }
  }

  dispose() {
    this.batch.dispose()
    this.holes.geometry.dispose()
    this.holeMaterial.dispose()
    if (this.material.map) this.material.map.dispose()
    this.material.dispose()
    for (const t of this.bank.tiers) for (const g of t.geometries) g.dispose()
  }
}
