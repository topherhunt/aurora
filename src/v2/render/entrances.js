import THREE from '../../three-instance.js'

import { GEN_PROP_LODS, PROP_RUNGS, PROP_STEPS, createGenPropMaterial, ladderTris, loadGenProp, propCull } from './gen-props.js'
import { LOD_DEG, distAt, ladderTier } from './critters.js'
import { mulberry32 } from '../../sim/mathx.js'
import { keyHash } from '../../sim/score.js'
import { PropArena } from './prop-arena.js'
import { ROCK_LOD_AT, ROCK_LOD_HYSTERESIS, rockLodSize } from '../../props/rock.js'
import { BLOCKED, CELL, STONE } from './leafkin-ground.js'
import { FINAL_M, OUT_FAR_M } from './leafkin.js'
import { WALK } from '../walk.js'

// ---------------------------------------------------------------------------
// THE LEAFKIN VILLAGE ENTRANCES (DESIGN.md §30): a stone arch on the flank of
// each entrance boulder (rocks.js's `hollow` bed) with a black hole behind it
// and a screen of two pieces -- boulders and sunken pines -- before it or
// against the boulder beside it, so it is found only by sidling along
// the face. The layer owns no scatter of its own: every frame it asks the rocks for the
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
// boulder apart. A screen's stone is the rocks' own boulder on the rocks' own
// material and ladder, stone to the trees and ferns as a boulder is (their
// addStone), and its pine the trees' own (Trees.plant).
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
// A room's mouth casts a shadow on the ground from its hole's plane out this far, black there and fading to nothing, over the seam where the ground meets the black; drawn this far over the ground.
export const SHADOW_M = 1
const SHADOW_LIFT_M = 0.02
/** The outline's box: `[u0, u1, v0, v1]`. */
export const holeBox = () => [
  Math.min(...HOLE.outline.map((p) => p[0])), Math.max(...HOLE.outline.map((p) => p[0])),
  Math.min(...HOLE.outline.map((p) => p[1])), Math.max(...HOLE.outline.map((p) => p[1])),
]

// The screen: `count` pieces, each a boulder or a sunken pine. The first
// stands beside the arch on a rolled side, against the boulder (a stone `bite`
// of its radius into the face, a pine's trunk `pass` out of it), `gap` past
// the arch's side. The second, `across` of the time, stands so on the other
// side; otherwise before the arch, its hull `front` metres clear of the mouth
// point and its centre off the arch's axis by up to `drift` of its cover.
// A boulder is `size` across, bedded `sink` of its height, turned broadside to
// the face within `twist` radians; a pine is sunk `sink` metres and scaled so
// its lowest boughs come to `hem` over the ground (below it, so they sweep it),
// its trunk `pass` past the hull line.
export const SCREEN = {
  count: 2, kinds: ['boulder', 'pine'], front: [0.3, 0.8], drift: 0.1, across: 0.5, bite: 0.4, gap: 0.2, tries: 8,
  boulder: { size: [5.5, 7.5], sink: 0.25, twist: 0.5 },
  pine: { sink: [2.5, 3], hem: [-0.8, -0.5], pass: 1.2 },
}
// A layout is kept only if a walker of her width still gets from the mouth point out to OUT_FAR_M over the leafkin's ground (leafkin-ground.js), each piece's column grown by this: her shoulder and the cell's half diagonal.
const PASS_PAD = WALK.radius + CELL * Math.SQRT1_2
const NO_STONES = []
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
// Pieces of one kind the resident mouths may stand at once; the trees' `plantRoom`.
export const SCREEN_POOL = POOL * SCREEN.count

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
   * @param rocks  Rocks: hollowsInto, hollowRayAt, boulder, boulderSpanAt, hollowTintAt
   * @param opts.bank  mouthBankFrom's answer. Required.
   * @param opts.fixed  a room's own mouths in place of the rocks' hollows: `[{ key, x, z, nx, nz }]`, the face point and its outward normal, seated once.
   * @param opts.ground  LeafkinGround (cell), which every screen is walked over; required unless `fixed`.
   * @param opts.trees  Trees (plant, unplant, plantShape, addStone, restone), booted with `plantRoom` SCREEN_POOL, for the screen's pines and to stand on its stones; required unless `fixed`.
   * @param opts.ferns  Ferns, optional: the screen's stones are stone to them as to the trees (addStone, restone).
   */
  constructor(scene, field, water, rocks, { seed = 1, radius = null, bank = null, fixed = null, ground = null, trees = null, ferns = null } = {}) {
    if (!bank || !Array.isArray(bank.tiers)) throw new Error('Entrances: needs the bank from loadMouthBank (or mouthBankFrom)')
    if (!field || typeof field.heightAt !== 'function') throw new Error('Entrances: needs a V2Height with heightAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Entrances: needs WaterSurfaces with isSubmerged')
    if (!rocks || ['hollowsInto', 'hollowRayAt', 'boulder', 'boulderSpanAt', 'hollowTintAt'].some((f) => typeof rocks[f] !== 'function')) {
      throw new Error('Entrances: needs Rocks with hollowsInto, hollowRayAt, boulder, boulderSpanAt and hollowTintAt')
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
    if (fixed === null && (!ground || typeof ground.cell !== 'function')) throw new Error('Entrances: needs the LeafkinGround, to walk each screen')
    if (fixed === null && (!trees || ['plant', 'unplant', 'plantShape', 'addStone', 'restone'].some((f) => typeof trees[f] !== 'function'))) throw new Error('Entrances: needs Trees with plant, unplant, plantShape, addStone and restone')
    this.ground = ground
    this.trees = trees
    // Whatever stands on and about a screen's stones: told of them here, and asked to look again (restone) as they come and go.
    this.growth = fixed === null ? [trees, ferns].filter(Boolean) : []
    for (const g of this.growth) g.addStone(this)
    this._seen = new Uint8Array(0)
    this._queue = new Int32Array(0)
    this.bank = bank
    // A fixed set is seated whole, so it sizes the pool.
    const pool = fixed === null ? POOL : Math.max(POOL, fixed.length)
    this.maxInstances = pool

    this.material = createGenPropMaterial()
    this.material.map = bank.map
    this.materials = [this.material]
    this.batch = new PropArena(pool, bank.tiers, new Array(bank.tiers.length).fill(pool), () => this.material, 'v2-entrances')
    this.free = new Int32Array(pool)
    this.freeCount = pool
    for (let i = 0; i < pool; i++) {
      const id = this.batch.addInstance(0)
      this.batch.setVisibleAt(id, false)
      this.free[pool - 1 - i] = id
    }
    this.tierAt = new Int8Array(pool).fill(-1)

    // The holes, one instance per arch on the same ids; a hidden one is a zero matrix.
    this.holeMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false })
    this.holes = new THREE.InstancedMesh(holeGeometry(), this.holeMaterial, pool)
    this.holes.name = 'v2-entrance-holes'
    this.holes.frustumCulled = false
    this.holes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.scene = scene
    this.shadows = []
    this.shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, vertexColors: true, transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    this.holeM = new Float32Array(pool * 16)
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0)
    for (let i = 0; i < pool; i++) this.holes.setMatrixAt(i, this._zero)

    // The screen's stones: the tiers are cloned because PropMeshes hangs its
    // fade attribute on the geometry it is given, and the rocks' own meshes
    // already hold that on these.
    const boulder = rocks.boulder()
    this.boulder = boulder.measured
    const a = new PropArena(SCREEN_POOL, boulder.tiers.map((g) => ({ geometries: [g.clone()] })), new Array(boulder.tiers.length).fill(SCREEN_POOL), () => boulder.material, 'v2-entrance-stones')
    const free = new Int32Array(SCREEN_POOL)
    for (let i = 0; i < SCREEN_POOL; i++) {
      const id = a.addInstance(0)
      a.setVisibleAt(id, false)
      free[SCREEN_POOL - 1 - i] = id
    }
    this.stones = { arena: a, free, freeCount: SCREEN_POOL, tier: new Int8Array(SCREEN_POOL).fill(-1), tris: ladderTris(boulder.tiers) }
    this.flank = a

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
    this.rejected = { face: 0, wall: 0, level: 0, water: 0, bulge: 0, sealed: 0, none: 0, screen: 0 }
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
   * x, y, z, nx, nz, r, ax, ay, az, holeX, holeZ, scale, state, flank, flankReach, screened }`
   * -- the point on the ground MOUTH_STEP_M + MOUTH_SINK_M out from the arch's
   * centre, the face's outward normal in the plane, the boulder's hull radius
   * about its centre, the arch's own position, the hole's plane on the ground
   * line (MOUTH_SINK_M + HOLE.proud out from the arch), the arch's and hole's scale, the site's own record,
   * which survives eviction, its screen's pieces (`{ kind, x, z, y, r, top,
   * cover, low }`: `r` the column she and the leafkin meet, `cover` the
   * radius it hides the arch within from `low` to `top`), how far from the
   * mouth point they reach, and whether it has a screen at all.
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
        if (site.shadow !== null) site.shadow.visible = drawn
        this.holes.setMatrixAt(i, drawn ? this._m.fromArray(this.holeM, i * 16) : this._zero)
        this.holes.instanceMatrix.needsUpdate = true
      }
      if (tier < RUNGS) tris += this.bank.tris[tier] + HOLE.outline.length - 2
      // The screen stands while the boulder does, each piece on the rung its own size and distance earn; a stone leaves a rung 12% further out than it came in. The trees draw the pines.
      for (const f of site.flank) {
        if (f.kind === 'pine') continue
        const fx = f.x - camX, fy = 0.5 * (f.y + f.top) - camY, fz = f.z - camZ
        const d2 = fx * fx + fy * fy + fz * fz
        const s = this.stones
        const fcur = s.tier[f.id]
        let ft = FLANK_LOD_SQ.length
        for (let b = 0; b < FLANK_LOD_SQ.length; b++) {
          if (d2 < f.size * f.size * (fcur >= 0 && fcur <= b ? FLANK_LOD_SQ_OUT[b] : FLANK_LOD_SQ[b])) { ft = b; break }
        }
        if (ft !== fcur) {
          s.tier[f.id] = ft
          s.arena.setGeometryIdAt(f.id, ft)
          s.arena.setVisibleAt(f.id, true)
        }
        tris += s.tris[ft]
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
      this.resident.delete(key)
      this._release(site)
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
      // Sealed: no way out over the leafkin's ground as far as its leafkin is placed out (leafkin.js _emerge), so none could come home.
      if (!this._pathable(mx, mz, NO_STONES, OUT_FAR_M)) { this.rejected.sealed++; continue }
      this._place(key, hx, hz, nx, nz, floor, my, mx, mz, r, bulge)
      return
    }
    this.rejected.none++
    this.resident.set(key, { key, id: -1, blind: true })
  }

  /**
   * A room's mouth: the arch on the face point, `scale` times MOUTH_HEIGHT_M, brought forward by the room's own `bulge` (village.js placeExit), the hole at HOLE.proud past that, no hull.
   * Its floor is the lowest ground under it from the face out past its front: the floor falls away from the wall, and an arch seated at the face alone stands its front lip in the air.
   */
  _seatFixed({ key, x, z, nx, nz, bulge = 0, scale = 1 }) {
    const nl = Math.hypot(nx, nz)
    nx /= nl
    nz /= nl
    const mx = x + nx * (MOUTH_STEP_M + bulge)
    const mz = z + nz * (MOUTH_STEP_M + bulge)
    let floor = Infinity
    const reach = bulge + this.bank.depth * scale, half = this.bank.width * scale * 0.45
    for (let k = 0; k <= 8; k++) {
      const px = x + nx * ((reach * k) / 8), pz = z + nz * ((reach * k) / 8)
      for (const s of [-half, 0, half]) floor = Math.min(floor, this.field.heightAt(px - nz * s, pz + nx * s))
    }
    this._place(key, x, z, nx, nz, floor, this.field.heightAt(mx, mz), mx, mz, 0, bulge, scale)
    this._shade(this.resident.get(key), scale)
  }

  /** The shadow out of a room's mouth: a sheet on the ground across the hole's width, from just inside its plane SHADOW_M out, its alpha falling from 1 to 0. */
  _shade(site, scale) {
    const [u0, u1] = holeBox().map((w) => w * scale)
    const { nx, nz, holeX, holeZ } = site
    const across = 12, out = 6
    const pos = new Float32Array((across + 1) * (out + 1) * 3)
    const col = new Float32Array((across + 1) * (out + 1) * 4).fill(1)
    for (let j = 0; j <= out; j++) {
      const t = j / out, d = -0.05 + (SHADOW_M + 0.05) * t
      for (let i = 0; i <= across; i++) {
        const u = u0 + ((u1 - u0) * i) / across
        const x = holeX + nx * d - nz * u, z = holeZ + nz * d + nx * u
        const k = j * (across + 1) + i
        pos.set([x, this.field.heightAt(x, z) + SHADOW_LIFT_M, z], k * 3)
        col[k * 4 + 3] = 1 - t
      }
    }
    const idx = []
    for (let j = 0; j < out; j++) {
      for (let i = 0; i < across; i++) {
        const a = j * (across + 1) + i, b = a + across + 1
        idx.push(a, a + 1, b, a + 1, b + 1, b)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(col, 4))
    g.setIndex(idx)
    g.computeBoundingSphere()
    const mesh = new THREE.Mesh(g, this.shadowMaterial)
    mesh.name = 'v2-entrance-shadow'
    mesh.renderOrder = 1
    // Drawn while its arch is (update).
    mesh.visible = false
    site.shadow = mesh
    this.scene.add(mesh)
    this.shadows.push(mesh)
  }

  /** `bulge` is how far the stone stands out of the face point's plane across the hole: the arch and the hole come forward by it together, so the hole keeps its one plane in the ring. `scale` sizes the arch and its hole together. */
  _place(key, hx, hz, nx, nz, floor, my, mx, mz, r, bulge, scale = 1) {
    if (this.freeCount === 0) throw new Error(`Entrances: instance pool exhausted at ${this.maxInstances}`)
    const id = this.free[--this.freeCount]
    const bank = this.bank
    // The arch's floor at the lower of its two feet, so the higher is bedded and neither floats.
    const half = bank.width * scale * 0.45
    const ay = Math.min(floor, this.field.heightAt(hx - nz * half, hz + nx * half), this.field.heightAt(hx + nz * half, hz - nx * half)) - 0.05
    const ax = hx - nx * (MOUTH_SINK_M * scale - bulge)
    const az = hz - nz * (MOUTH_SINK_M * scale - bulge)
    // Yawed so the pick's +X, the passage, runs along the normal.
    this._q.setFromAxisAngle(this._up, Math.atan2(-nz, nx))
    this._s.setScalar(bank.scale * scale)
    this.batch.setMatrixAt(id, this._m.compose(this._p.set(ax, ay, az), this._q, this._s))
    // The hole's outline is over the arch's base, so it stays inside the ring where the ground steps.
    this._s.setScalar(scale)
    const hole = bulge + HOLE.proud * scale
    const holeX = hx + nx * hole, holeZ = hz + nz * hole
    this._m.compose(this._p.set(holeX, ay, holeZ), this._q, this._s)
    this._m.toArray(this.holeM, id * 16)
    this.tierAt[id] = -1
    let state = this.memory.get(key)
    if (!state) {
      state = {}
      this.memory.set(key, state)
    }
    const site = { key, id, blind: false, x: mx, y: my, z: mz, nx, nz, r, ax, ay, az, holeX, holeZ, scale, state, flank: [], flankReach: 0, shadow: null }
    if (r > 0) this._screen(site, hx, hz)
    this.resident.set(key, site)
    this._restone(site)
    this.placed++
  }

  /** The screen, rolled off the key (SCREEN). A layout that shuts the mouth's way out is rolled again, SCREEN.tries times in all, then left out. */
  _screen(site, hx, hz) {
    const rand = mulberry32(keyHash(site.key + ':screen') ^ this.seed)
    let pieces = null
    for (let t = 0; t < SCREEN.tries && pieces === null; t++) {
      const plan = this._layout(site, hx, hz, rand)
      if (this._pathable(site.x, site.z, plan, OUT_FAR_M)) pieces = plan
    }
    site.screened = pieces !== null
    if (pieces === null) {
      this.rejected.screen++
      return
    }
    // A stone wears the boulder's own colour, so it reads as its stone and not the wood's.
    const tint = this.rocks.hollowTintAt(hx, hz, new THREE.Color())
    for (const f of pieces) {
      const ground = this.field.heightAt(f.x, f.z)
      let id = -1, y = ground, top = ground + f.top, low = ground + f.hem, m = null
      if (f.kind === 'pine') {
        this.trees.plant([f.plant])
      } else {
        const s = this.stones
        if (s.freeCount === 0) throw new Error(`Entrances: stone pool exhausted at ${SCREEN_POOL}`)
        id = s.free[--s.freeCount]
        y = ground - f.sink * f.height
        top = y + f.height
        low = ground
        this._q.setFromAxisAngle(this._up, f.yaw)
        this._s.setScalar(f.scale)
        s.arena.setMatrixAt(id, this._m.compose(this._p.set(f.x, y, f.z), this._q, this._s))
        m = Float64Array.from(this._m.elements)
        s.arena.setColorAt(id, tint)
        s.tier[id] = -1
      }
      site.flank.push({ id, kind: f.kind, x: f.x, z: f.z, y, r: f.r, top, size: f.size, cover: f.cover, low, plant: f.plant, m })
      site.flankReach = Math.max(site.flankReach, Math.hypot(f.x - site.x, f.z - site.z) + Math.max(f.hull, f.size))
    }
  }

  /** One roll of the screen's plan: SCREEN.count pieces, placed and shaped but not stood. */
  _layout(site, hx, hz, rand) {
    const { nx, nz } = site
    const ax = -nz, az = nx
    const roll = ([lo, hi]) => lo + rand() * (hi - lo)
    const pick = () => this._piece(SCREEN.kinds[Math.floor(rand() * SCREEN.kinds.length)], rand)
    // `n` metres out from the mouth point, `u` along the face; a stone broadside to the face.
    const at = (f, u, n) => {
      f.x = site.x + nx * n + ax * u
      f.z = site.z + nz * n + az * u
      f.yaw = f.kind === 'boulder' ? Math.atan2(-nx, -nz) + (rand() - 0.5) * SCREEN.boulder.twist : rand() * Math.PI * 2
    }
    const beside = (f, side) => {
      at(f, side * (this.bank.width * 0.5 + SCREEN.gap + f.hull), 0)
      // The boulder's face there, from three metres out at knee height, or the mouth's own line without one.
      const t = this.rocks.hollowRayAt(f.x + nx * 3, this.field.heightAt(site.x, site.z) + 0.3, f.z + nz * 3, -nx, 0, -nz, 6, this._hit)
      if (t !== Infinity) { f.x = this._hit.x; f.z = this._hit.z }
      const out = f.kind === 'pine' ? SCREEN.pine.pass : f.hull * (1 - SCREEN.bite)
      f.x += nx * out
      f.z += nz * out
    }
    const side = rand() < 0.5 ? -1 : 1
    const a = pick()
    beside(a, side)
    const b = pick()
    if (rand() < SCREEN.across) beside(b, -side)
    else at(b, (rand() * 2 - 1) * SCREEN.drift * b.cover, roll(SCREEN.front) + b.hull)
    for (const f of [a, b]) if (f.kind === 'pine') this._shapePine(f, rand)
    return [a, b]
  }

  /**
   * A piece of `kind` before it is placed: `hull` the radius it is spaced by,
   * `r` the column she meets, `cover` the radius it hides the arch within, and
   * `hem`/`top` its cover's span over the ground. A pine is spaced as a crown
   * `SCREEN.pine.pass` across until `_shapePine` sizes it where it stands.
   */
  _piece(kind, rand) {
    const roll = ([lo, hi]) => lo + rand() * (hi - lo)
    if (kind === 'boulder') {
      const mm = this.boulder
      const scale = roll(SCREEN.boulder.size) / mm.width
      const radius = 0.5 * Math.max(mm.width, mm.depth) * scale
      return { kind, x: 0, z: 0, yaw: 0, scale, height: mm.height * scale, sink: SCREEN.boulder.sink, hull: radius, r: radius * 0.8, cover: radius * 0.8, hem: 0, top: 0, size: rockLodSize(mm) * scale }
    }
    if (kind === 'pine') return { kind, x: 0, z: 0, yaw: 0, hull: SCREEN.pine.pass, r: 0, cover: SCREEN.pine.pass, hem: 0, top: 0, size: 0, plant: null }
    throw new Error(`Entrances: no screen piece '${kind}'`)
  }

  /** Size a placed pine so its lowest boughs come to SCREEN.pine.hem once sunk: a tree's look is rolled off its point (Trees.plantShape), so it is shaped where it stands. */
  _shapePine(f, rand) {
    const sink = SCREEN.pine.sink[0] + rand() * (SCREEN.pine.sink[1] - SCREEN.pine.sink[0])
    const hem = SCREEN.pine.hem[0] + rand() * (SCREEN.pine.hem[1] - SCREEN.pine.hem[0])
    const one = this.trees.plantShape({ x: f.x, z: f.z, scale: 1 })
    const scale = (hem + sink) / one.hem
    f.plant = { x: f.x, z: f.z, scale, sink }
    f.r = one.trunk * scale
    f.cover = one.crown * scale
    f.hem = hem
    f.top = one.top * scale - sink
  }

  /**
   * Whether a walker gets from the mouth point (x0, z0) `reach` metres out: a
   * search over the leafkin's ground on its own CELL grid, open as leafkin.js
   * open() has it (never BLOCKED; anything within FINAL_M of the mouth; never
   * STONE) and clear of each of `stones` by its column and PASS_PAD.
   * Four-connected, so no corner the leafkin's walk refuses is cut. Depth
   * first, the most outward step taken first: open ground is crossed in a
   * straight run, and a pocket is searched whole before it is called sealed.
   */
  _pathable(x0, z0, stones, reach) {
    const c = Math.ceil(reach / CELL) + 1, n = 2 * c + 1
    const ox = Math.round(x0 / CELL) * CELL, oz = Math.round(z0 / CELL) * CELL
    if (this._seen.length < n * n) {
      this._seen = new Uint8Array(n * n)
      this._queue = new Int32Array(n * n)
    }
    const seen = this._seen, stack = this._queue
    seen.fill(0, 0, n * n)
    const passable = (i, j) => {
      const x = ox + (i - c) * CELL, z = oz + (j - c) * CELL
      const v = this.ground.cell(x, z)
      if (v === BLOCKED) return false
      if ((x - x0) ** 2 + (z - z0) ** 2 <= FINAL_M * FINAL_M) return true
      if (v === STONE) return false
      for (const f of stones) {
        const pad = f.r + PASS_PAD
        if ((x - f.x) ** 2 + (z - f.z) ** 2 < pad * pad) return false
      }
      return true
    }
    if (!passable(c, c)) return false
    const goal = reach * reach
    const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let top = 0
    stack[top++] = c * n + c
    seen[c * n + c] = 1
    while (top > 0) {
      const k = stack[--top]
      const i = k % n, j = (k - i) / n
      const u = (ox + (i - c) * CELL - x0), w = (oz + (j - c) * CELL - z0)
      if (u * u + w * w >= goal) return true
      // Pushed least outward first, so the most outward is popped next.
      steps.sort((a, b) => (a[0] * u + a[1] * w) - (b[0] * u + b[1] * w))
      for (const [di, dj] of steps) {
        const ii = i + di, jj = j + dj
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue
        const kk = jj * n + ii
        if (seen[kk]) continue
        seen[kk] = 1
        if (passable(ii, jj)) stack[top++] = kk
      }
    }
    return false
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
      if (f.kind === 'pine') {
        this.trees.unplant([f.plant])
        continue
      }
      const s = this.stones
      s.arena.setVisibleAt(f.id, false)
      s.tier[f.id] = -1
      s.free[s.freeCount++] = f.id
    }
    this._restone(site)
    this.placed--
  }

  /** Ask the trees and ferns to look again over a screen's stones, which have just stood or gone. */
  _restone(site) {
    for (const f of site.flank) {
      if (f.kind === 'pine') continue
      for (const g of this.growth) g.restone(f.x - f.size, f.z - f.size, f.x + f.size, f.z + f.size)
    }
  }

  // -- the screen's stones to the walker (walk.js addStone), the trees and the ferns; the trees answer for a pine's trunk --

  /** Stride 4 from anchor `w` as Rocks.anchorsInto, each stone with its centre in the half-open box; returns the new cursor. */
  anchorsInto(x0, z0, x1, z1, out, w = 0) {
    const cap = (out.length / 4) | 0
    for (const site of this.resident.values()) {
      if (site.blind) continue
      for (const f of site.flank) {
        if (f.kind === 'pine' || f.x < x0 || f.x >= x1 || f.z < z0 || f.z >= z1) continue
        if (w >= cap) return w
        out[w * 4] = f.x
        out[w * 4 + 1] = f.y
        out[w * 4 + 2] = f.z
        out[w * 4 + 3] = f.r
        w++
      }
    }
    return w
  }

  /** Each stone's own [bottom, top] on the vertical through (x, z), off the rocks' hull as their own rocks answer (Rocks.boulderSpanAt). */
  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    for (const site of this.resident.values()) {
      if (site.blind) continue
      const sx = x - site.x, sz = z - site.z
      if (sx * sx + sz * sz > site.flankReach * site.flankReach) continue
      for (const f of site.flank) {
        if (n >= cap) return n
        const span = this._spanAt(f, x, z)
        if (!span) continue
        out[n * 2] = span[0]
        out[n * 2 + 1] = span[1]
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
        const span = this._spanAt(f, x, z)
        if (span && span[1] > top) top = span[1]
      }
    }
    return top
  }

  /** A stone's span through (x, z), or null; `size`, its longest extent, is past its turned box's corners. */
  _spanAt(f, x, z) {
    if (f.kind === 'pine') return null
    const dx = x - f.x, dz = z - f.z
    return dx * dx + dz * dz < f.size * f.size ? this.rocks.boulderSpanAt(f.m, dx, dz) : null
  }

  get stats() {
    return {
      placed: this.placed,
      blind: this.resident.size - this.placed,
      tris: this.tris,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
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
    for (const s of this.shadows) {
      this.scene.remove(s)
      s.geometry.dispose()
    }
    this.shadowMaterial.dispose()
    if (this.material.map) this.material.map.dispose()
    this.material.dispose()
    for (const t of this.bank.tiers) for (const g of t.geometries) g.dispose()
  }
}
