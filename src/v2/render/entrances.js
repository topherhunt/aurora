import THREE from '../../three-instance.js'

import { GEN_PROP_LODS, PROP_RUNGS, PROP_STEPS, createGenPropMaterial, ladderTris, loadGenProp, propCull } from './gen-props.js'
import { LOD_DEG, distAt, ladderTier } from './critters.js'
import { mulberry32 } from '../../sim/mathx.js'
import { keyHash } from '../../sim/score.js'
import { PropArena } from './prop-arena.js'
import { ROCK_LOD_AT, ROCK_LOD_HYSTERESIS, rockLodSize } from '../../props/rock.js'

// ---------------------------------------------------------------------------
// THE LEAFKIN VILLAGE ENTRANCES (DESIGN.md §30): a stone arch on the flank of
// each entrance boulder (rocks.js's `hollow` bed) with a black hole behind it
// and a few smaller stones tucked against the boulder either side of it. The
// layer owns no scatter of its own: every frame it asks the rocks for the
// resident hollows within RADIUS_M and seats a mouth on each new one, so a
// site is where its boulder is, on every client, and goes when the boulder
// goes. The face is found by rays against the boulder's own hull, from a
// bearing rolled off the site's key, so two clients agree on the mouth to the
// bit without exchanging it.
//
// The hole is a polygon, not a cavity: an unlit black plane a hair proud of
// the stone across the arch's passage, so the depth test keeps it in front of
// the face and the arch's own ring around it. It reads as a hole because the
// parallax across the arch's protruding half metre is real -- and it is cut
// inside the ring's solid (HOLE.outline), because wherever it reaches past the
// ring it is a black shape on the boulder, and wherever it falls short a rim
// of stone shows inside the ring.
//
// Drawn on the props' ladder (gen-props.js) with the shipped T3 in the card's
// place: an arch is on a wall, and a card spun to her would stand out of it.
// A rung switch is a plain swap -- a few dozen instances, none nearer than a
// boulder apart. The flanking stones are the rocks' own boulder on the rocks'
// own material, on the rocks' own ladder.
// ---------------------------------------------------------------------------

export const MOUTH_GLB = 'gen-props/cave-mouth.glb'
// Shipped tiers drawn, in rung order, on PROP_STEPS.
export const MOUTH_TIERS = [0, 2, 3]
export const RUNGS = PROP_RUNGS

// The arch, metres tall over its floor, and how far its centre is set into the face.
export const MOUTH_HEIGHT_M = 1.5
export const MOUTH_SINK_M = 0.1
// The hole: its outline in the arch's frame, metres across the passage (the
// pick's Z) and above the arch's base, every edge inside the ring's solid at
// its plane, MOUTH_SINK_M + proud into the arch (check-entrances samples the
// pick), so no stone shows between the black and the ring; how far it stands
// proud of the stone at its most bulging vertex, the arch brought forward with
// it so that plane holds; how far a face may bulge, the arch standing that
// much further out of it; and the bulge across it a face may have. The left
// shoulder is notched under a seam that opens 0.1 past the plane.
export const HOLE = {
  outline: [[-0.62, 0.1], [-0.62, 0.8], [-0.6, 0.9], [-0.46, 0.9], [-0.45, 1.1], [0.35, 1.1], [0.45, 1.05], [0.55, 0.95], [0.6, 0.6], [0.6, 0.1]],
  proud: 0.04,
  maxProud: 0.2,
  maxBulge: 0.4,
}
/** The outline's box: `[u0, u1, v0, v1]`. */
export const holeBox = () => [
  Math.min(...HOLE.outline.map((p) => p[0])), Math.max(...HOLE.outline.map((p) => p[0])),
  Math.min(...HOLE.outline.map((p) => p[1])), Math.max(...HOLE.outline.map((p) => p[1])),
]

// The flanking stones: this many each side of the arch, this many metres
// across, bedded this fraction of their height, this far off the arch and
// each other, and leaning into the boulder by this fraction of their radius.
export const FLANK = { perSide: [1, 2], size: [4.8, 8.8], sink: 0.4, gap: 0.25, lean: 0.4 }
// A stone steps down the rocks' own ladder at the rocks' own distances per
// metre of its size (rock.js ROCK_LOD_AT), not at the arch's rungs: those are
// scaled to a 1.5 m arch and put a 6 m stone on its 20-face tier at 10 m.
const FLANK_LOD_SQ = Float32Array.from(ROCK_LOD_AT, (k) => k * k)
const FLANK_LOD_SQ_OUT = Float32Array.from(ROCK_LOD_AT, (k) => (k * (1 + ROCK_LOD_HYSTERESIS)) ** 2)

// How far out a boulder is given a mouth, and its leafkin a home (leafkin.js).
export const RADIUS_M = 400
// The door (main.js portalTest): a mouth within `reach` takes her when the
// step just taken ends her feet within `walk` of its hole heading into the
// face (the cosine at least `into`), or a teleport lands them within `blink`.
// The limiter stops her feet 0.1-0.5 m short of the hole at the boulder's
// foot, so `walk` is as near as she can get and no nearer.
export const PORTAL = { reach: 20, walk: 0.5, blink: 0.8, into: 0.5 }

// The face probe: a ray from `out` metres past the hull's radius, `eye` above
// the ground there, toward the boulder's centre; the face passes when its
// normal is within `faceDeg` of horizontal, a second ray from the mouth point
// `wall` higher meets stone within `wallReach()`, and the ground at the hit
// and at the mouth point is within `level` of the ray's own.
export const PROBE = { out: 1, eye: 0.75, wall: 1.5, recede: 0.3, faceDeg: 20, level: 0.5, bearings: 16 }
// The mouth point: this far out from the face, on the ground.
export const MOUTH_STEP_M = 0.7
/** How far the wall ray may travel: the step, the lean a face at the limit has over `wall` metres, and `recede` of slack. */
export const wallReach = () => MOUTH_STEP_M + PROBE.wall * Math.tan((PROBE.faceDeg * Math.PI) / 180) + PROBE.recede

const HOLLOW_STRIDE = 5
const POOL = 48
const FLANK_POOL = POOL * 2 * 2

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

/** HOLE.outline as a fan in the arch's frame -- X out of the face, Y up, Z across -- wound to face out. */
function holeGeometry() {
  const o = HOLE.outline
  const pos = new Float32Array(o.length * 3)
  for (let i = 0; i < o.length; i++) { pos[i * 3 + 1] = o[i][1]; pos[i * 3 + 2] = o[i][0] }
  const idx = []
  for (let i = 1; i + 1 < o.length; i++) idx.push(0, i, i + 1)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  return g
}

export class Entrances {
  /**
   * @param field  V2Height: heightAt
   * @param water  WaterSurfaces: isSubmerged
   * @param rocks  Rocks: hollowsInto, hollowRayAt, boulder, hollowTintAt
   * @param opts.bank  mouthBankFrom's answer. Required.
   * @param opts.fixed  a room's own mouths in place of the rocks' hollows: `[{ key, x, z, nx, nz }]`, the face point and its outward normal, seated once.
   */
  constructor(scene, field, water, rocks, { seed = 1, radius = null, bank = null, fixed = null } = {}) {
    if (!bank || !Array.isArray(bank.tiers)) throw new Error('Entrances: needs the bank from loadMouthBank (or mouthBankFrom)')
    if (!field || typeof field.heightAt !== 'function') throw new Error('Entrances: needs a V2Height with heightAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Entrances: needs WaterSurfaces with isSubmerged')
    if (!rocks || ['hollowsInto', 'hollowRayAt', 'boulder', 'hollowTintAt'].some((f) => typeof rocks[f] !== 'function')) {
      throw new Error('Entrances: needs Rocks with hollowsInto, hollowRayAt, boulder and hollowTintAt')
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
    this.holeMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false })
    this.holes = new THREE.InstancedMesh(holeGeometry(), this.holeMaterial, POOL)
    this.holes.name = 'v2-entrance-holes'
    this.holes.frustumCulled = false
    this.holes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.holeM = new Float32Array(POOL * 16)
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0)
    for (let i = 0; i < POOL; i++) this.holes.setMatrixAt(i, this._zero)

    // The flanking stones: the tiers are cloned because PropMeshes hangs its
    // fade attribute on the geometry it is given, and the rocks' own meshes
    // already hold that on these.
    const boulder = rocks.boulder()
    this.boulder = boulder.measured
    this.flank = new PropArena(FLANK_POOL, boulder.tiers.map((g) => ({ geometries: [g.clone()] })), new Array(boulder.tiers.length).fill(FLANK_POOL), () => boulder.material, 'v2-entrance-flank')
    this.flankTris = ladderTris(boulder.tiers)
    this.flankFree = new Int32Array(FLANK_POOL)
    this.flankFreeCount = FLANK_POOL
    for (let i = 0; i < FLANK_POOL; i++) {
      const id = this.flank.addInstance(0)
      this.flank.setVisibleAt(id, false)
      this.flankFree[FLANK_POOL - 1 - i] = id
    }
    this.flankTier = new Int8Array(FLANK_POOL).fill(-1)
    this._c = new THREE.Color()

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
    scene.add(this.flank)
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
   * x, y, z, nx, nz, r, ax, ay, az, holeX, holeZ, state, flank, flankReach }`
   * -- the point on the ground MOUTH_STEP_M + MOUTH_SINK_M out from the arch's
   * centre, the face's outward normal in the plane, the boulder's hull radius
   * about its centre, the arch's own position, the hole's plane on the ground
   * line (MOUTH_SINK_M + HOLE.proud out from the arch), the site's own record,
   * which survives eviction, its flanking stones and how far from the mouth
   * point they reach.
   */
  sites(into = []) {
    for (const site of this.resident.values()) if (!site.blind) into.push(site)
    return into
  }

  /** Follow the rocks' residency and re-rung every arch and stone by its distance. */
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
      if (tier < RUNGS) tris += this.bank.tris[tier] + HOLE.outline.length - 2
      // The stones stand while the boulder does, each on the rung its own size and distance earn, leaving a rung 12% further out than it came in.
      for (const f of site.flank) {
        const fx = f.x - camX, fy = 0.5 * (f.y + f.top) - camY, fz = f.z - camZ
        const d2 = fx * fx + fy * fy + fz * fz
        const fcur = this.flankTier[f.id]
        let ft = FLANK_LOD_SQ.length
        for (let b = 0; b < FLANK_LOD_SQ.length; b++) {
          if (d2 < f.size * f.size * (fcur >= 0 && fcur <= b ? FLANK_LOD_SQ_OUT[b] : FLANK_LOD_SQ[b])) { ft = b; break }
        }
        if (ft !== fcur) {
          this.flankTier[f.id] = ft
          this.flank.setGeometryIdAt(f.id, ft)
          this.flank.setVisibleAt(f.id, true)
        }
        tris += this.flankTris[ft]
      }
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
      // The stone across the hole: probed at the outline's vertices and its
      // box's centre, along the normal from a metre out. The arch, the hole
      // and the mouth point all come forward by the most bulging one, so the
      // hole keeps its plane in the ring; a face bulging past HOLE.maxProud,
      // or receding or bulging across itself past HOLE.maxBulge, is refused.
      const ax = -nz, az = nx
      const box = holeBox()
      let proud = -Infinity, deep = Infinity
      for (let c = 0; c <= HOLE.outline.length; c++) {
        const u = c < HOLE.outline.length ? HOLE.outline[c][0] : (box[0] + box[1]) / 2
        const v = floor + (c < HOLE.outline.length ? HOLE.outline[c][1] : (box[2] + box[3]) / 2)
        const tc = rocks.hollowRayAt(hx + ax * u + nx, v, hz + az * u + nz, -nx, 0, -nz, 2, hit)
        if (tc === Infinity) { proud = Infinity; break }
        const p = 1 - tc
        if (p > proud) proud = p
        if (p < deep) deep = p
      }
      if (proud === Infinity || proud > HOLE.maxProud || proud - deep > HOLE.maxBulge) { this.rejected.bulge++; continue }
      const bulge = Math.max(0, proud)
      const mx = hx + nx * (MOUTH_STEP_M + bulge)
      const mz = hz + nz * (MOUTH_STEP_M + bulge)
      const my = field.heightAt(mx, mz)
      // The wall: from the mouth point, PROBE.wall above the eye, along the
      // normal, stone within the step plus what a face at the limit leans back.
      if (rocks.hollowRayAt(mx, my + PROBE.eye + PROBE.wall, mz, -nx, 0, -nz, wallReach() + bulge, hit) === Infinity) { this.rejected.wall++; continue }
      if (Math.abs(floor - g) > PROBE.level || Math.abs(my - g) > PROBE.level) { this.rejected.level++; continue }
      if (this.water.isSubmerged(mx, mz, my)) { this.rejected.water++; continue }
      this._place(key, hx, hz, nx, nz, floor, my, mx, mz, r, bulge)
      return
    }
    this.rejected.none++
    this.resident.set(key, { key, id: -1, blind: true })
  }

  /** A room's mouth: the arch on the face point, brought forward by the room's own `bulge` (village.js placeExit), the hole at HOLE.proud past that, no hull. */
  _seatFixed({ key, x, z, nx, nz, bulge = 0 }) {
    const nl = Math.hypot(nx, nz)
    nx /= nl
    nz /= nl
    const mx = x + nx * (MOUTH_STEP_M + bulge)
    const mz = z + nz * (MOUTH_STEP_M + bulge)
    this._place(key, x, z, nx, nz, this.field.heightAt(x, z), this.field.heightAt(mx, mz), mx, mz, 0, bulge)
  }

  /** `bulge` is how far the stone stands out of the face point's plane across the hole: the arch and the hole come forward by it together, so the hole keeps its one plane in the ring. */
  _place(key, hx, hz, nx, nz, floor, my, mx, mz, r, bulge) {
    if (this.freeCount === 0) throw new Error(`Entrances: instance pool exhausted at ${POOL}`)
    const id = this.free[--this.freeCount]
    const bank = this.bank
    // The arch's floor at the lower of its two feet, so the higher is bedded and neither floats.
    const half = bank.width * 0.45
    const ay = Math.min(floor, this.field.heightAt(hx - nz * half, hz + nx * half), this.field.heightAt(hx + nz * half, hz - nx * half)) - 0.05
    const ax = hx - nx * (MOUTH_SINK_M - bulge)
    const az = hz - nz * (MOUTH_SINK_M - bulge)
    // Yawed so the pick's +X, the passage, runs along the normal.
    this._q.setFromAxisAngle(this._up, Math.atan2(-nz, nx))
    this._s.setScalar(bank.scale)
    this.batch.setMatrixAt(id, this._m.compose(this._p.set(ax, ay, az), this._q, this._s))
    // The hole's outline is over the arch's base, so it stays inside the ring where the ground steps.
    this._s.setScalar(1)
    const hole = bulge + HOLE.proud
    const holeX = hx + nx * hole, holeZ = hz + nz * hole
    this._m.compose(this._p.set(holeX, ay, holeZ), this._q, this._s)
    this._m.toArray(this.holeM, id * 16)
    this.tierAt[id] = -1
    let state = this.memory.get(key)
    if (!state) {
      state = {}
      this.memory.set(key, state)
    }
    const site = { key, id, blind: false, x: mx, y: my, z: mz, nx, nz, r, ax, ay, az, holeX, holeZ, state, flank: [], flankReach: 0 }
    if (r > 0) this._flank(site, hx, hz)
    this.resident.set(key, site)
    this.placed++
  }

  /**
   * The flanking stones, rolled off the key: FLANK.perSide each side of the
   * arch, along the face from its ring outward, each leaning into the
   * boulder where a ray along the normal finds its face at that offset, and
   * bedded in the ground there.
   */
  _flank(site, hx, hz) {
    const rand = mulberry32(keyHash(site.key + ':flank') ^ this.seed)
    const { nx, nz } = site
    const ax = -nz, az = nx
    const mm = this.boulder
    const hit = this._hit
    const my = this.field.heightAt(site.x, site.z)
    // The boulder's own colour, so the stones read as its stone and not the wood's.
    const tint = this.rocks.hollowTintAt(hx, hz, this._c)
    for (const side of [-1, 1]) {
      const n = FLANK.perSide[0] + Math.floor(rand() * (FLANK.perSide[1] - FLANK.perSide[0] + 1))
      let u = this.bank.width * 0.5 + FLANK.gap
      for (let k = 0; k < n; k++) {
        if (this.flankFreeCount === 0) throw new Error(`Entrances: flank pool exhausted at ${FLANK_POOL}`)
        const across = FLANK.size[0] + rand() * (FLANK.size[1] - FLANK.size[0])
        const scale = across / mm.width
        const radius = 0.5 * Math.max(mm.width, mm.depth) * scale
        const height = mm.height * scale
        u += radius
        let fx = hx + ax * u * side
        let fz = hz + az * u * side
        // The boulder's face at this offset, from three metres out at knee height, or the arch's own face line without one.
        const t = this.rocks.hollowRayAt(fx + nx * 3, my + 0.3, fz + nz * 3, -nx, 0, -nz, 6, hit)
        if (t !== Infinity) { fx = hit.x; fz = hit.z }
        fx += nx * radius * (1 - FLANK.lean)
        fz += nz * radius * (1 - FLANK.lean)
        const y = this.field.heightAt(fx, fz) - FLANK.sink * height
        const id = this.flankFree[--this.flankFreeCount]
        this._q.setFromAxisAngle(this._up, rand() * Math.PI * 2)
        this._s.setScalar(scale)
        this.flank.setMatrixAt(id, this._m.compose(this._p.set(fx, y, fz), this._q, this._s))
        this.flank.setColorAt(id, tint)
        this.flankTier[id] = -1
        // The walker's stone: a column at the rock's plan radius, to its top.
        site.flank.push({ id, x: fx, z: fz, y, r: radius * 0.8, top: y + height, size: rockLodSize(mm) * scale })
        site.flankReach = Math.max(site.flankReach, Math.hypot(fx - site.x, fz - site.z) + radius)
        u += radius + FLANK.gap
      }
    }
  }

  _release(site) {
    if (site.blind) return
    const id = site.id
    this.batch.setVisibleAt(id, false)
    this.holes.setMatrixAt(id, this._zero)
    this.holes.instanceMatrix.needsUpdate = true
    this.tierAt[id] = -1
    this.free[this.freeCount++] = id
    for (const f of site.flank) {
      this.flank.setVisibleAt(f.id, false)
      this.flankTier[f.id] = -1
      this.flankFree[this.flankFreeCount++] = f.id
    }
    this.placed--
  }

  // -- the flanking stones to the walker (walk.js addStone) -------------------

  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    for (const site of this.resident.values()) {
      if (site.blind) continue
      const sx = x - site.x, sz = z - site.z
      if (sx * sx + sz * sz > site.flankReach * site.flankReach) continue
      for (const f of site.flank) {
        if (n >= cap) return n
        const dx = x - f.x, dz = z - f.z
        if (dx * dx + dz * dz > f.r * f.r) continue
        out[n * 2] = f.y
        out[n * 2 + 1] = f.top
        n++
      }
    }
    return n
  }

  blockTopAt(x, z) {
    let top = -Infinity
    for (const site of this.resident.values()) {
      if (site.blind) continue
      const sx = x - site.x, sz = z - site.z
      if (sx * sx + sz * sz > site.flankReach * site.flankReach) continue
      for (const f of site.flank) {
        const dx = x - f.x, dz = z - f.z
        if (dx * dx + dz * dz <= f.r * f.r && f.top > top) top = f.top
      }
    }
    return top
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
    this.flank.dispose()
    this.holes.geometry.dispose()
    this.holeMaterial.dispose()
    if (this.material.map) this.material.map.dispose()
    this.material.dispose()
    for (const t of this.bank.tiers) for (const g of t.geometries) g.dispose()
  }
}
