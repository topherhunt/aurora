import THREE from '../../three-instance.js'

import { GEN_PROP_LODS, PROP_STEPS, createGenPropMaterial, ladderTris, loadGenProp } from './gen-props.js'
import { LOD_DEG, distAt, ladderTier } from './critters.js'
import { PropArena } from './prop-arena.js'

// ---------------------------------------------------------------------------
// A ROOM'S OWN PROPS (DESIGN.md §30): the huts of a leafkin village, seated
// where the room file says rather than scattered. One shipped ladder, a few
// dozen instances at most, each `height` metres tall on the ground at its
// point, facing `yaw`; re-runged by distance on the props' steps with the
// shipped T3 in the card's place, like the entrances' arch. Every one is stone
// to the walker: a column over its footprint, so she walks round a hut and
// not through it.
// ---------------------------------------------------------------------------

export const HOUSE_GLB = 'gen-props/house-leafkin.glb'
// Shipped tiers drawn, in rung order, on PROP_STEPS.
export const TIERS = [0, 2, 3]
// Which way the pick's door faces, in its own frame: +X at yaw 0.
export const DOOR = { x: 1, z: 0 }
const POOL = 32

/** The bank from a shipped ladder (loadGenProp): the drawn tiers, the pick's box. */
export function propBankFrom(ladder) {
  if (!ladder || ladder.geometries.length !== GEN_PROP_LODS + 1) {
    throw new Error(`RoomProps: the ladder has ${ladder?.geometries?.length ?? 0} tiers, expected ${GEN_PROP_LODS + 1}`)
  }
  const geometries = TIERS.map((t) => ladder.geometries[t])
  return { tiers: geometries.map((g) => ({ geometries: [g] })), tris: ladderTris(geometries), bounds: ladder.bounds, map: ladder.map }
}

export async function loadHouseBank() {
  return propBankFrom(await loadGenProp(HOUSE_GLB))
}

export class RoomProps {
  /**
   * @param field  V2Height: heightAt
   * @param opts.bank  propBankFrom's answer. Required.
   * @param opts.props  `[{ x, z, yaw, height }]`, metres and radians. Required.
   * @param opts.clearing  `{ x, z, r }`: the disc the wood keeps off, with the huts. Required.
   */
  constructor(scene, field, { bank = null, props = null, clearing = null } = {}) {
    if (!bank || !Array.isArray(bank.tiers)) throw new Error('RoomProps: needs the bank from loadHouseBank (or propBankFrom)')
    if (!field || typeof field.heightAt !== 'function') throw new Error('RoomProps: needs a V2Height with heightAt')
    if (!Array.isArray(props) || props.some((p) => ![p.x, p.z, p.yaw, p.height].every(Number.isFinite) || !(p.height > 0))) {
      throw new Error('RoomProps: `props` is a list of { x, z, yaw, height }')
    }
    if (props.length > POOL) throw new Error(`RoomProps: ${props.length} props, the pool holds ${POOL}`)
    if (!clearing || ![clearing.x, clearing.z, clearing.r].every(Number.isFinite) || !(clearing.r > 0)) throw new Error('RoomProps: `clearing` is { x, z, r }')
    this.clearing = { ...clearing }
    this.field = field
    this.bank = bank
    this.material = createGenPropMaterial()
    this.material.map = bank.map
    this.materials = [this.material]
    this.batch = new PropArena(POOL, bank.tiers, new Array(bank.tiers.length).fill(POOL), () => this.material, 'v2-room-props')
    this.tierAt = new Int8Array(POOL).fill(-1)
    // Per prop: its point on the ground, its yaw, its scale, its footprint radius and its top.
    this.props = []
    this.tris = 0
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const b = bank.bounds
    for (const { x, z, yaw, height } of props) {
      const scale = height / b.height
      const y = field.heightAt(x, z)
      const id = this.batch.addInstance(0)
      this.batch.setVisibleAt(id, false)
      q.setFromAxisAngle(up, yaw)
      this.batch.setMatrixAt(id, m.compose(p.set(x, y, z), q, s.setScalar(scale)))
      this.props.push({ id, x, y, z, yaw, scale, r: Math.min(b.halfX, b.halfZ) * scale, top: y + height, size: b.lodSize * scale, base: distAt(b.lodSize * scale, LOD_DEG) })
    }
    scene.add(this.batch)
  }

  /** Where each prop's door is, on the ground a step out from its wall: `[{ x, z }]`. */
  doors() {
    return this.props.map((h) => {
      const c = Math.cos(h.yaw), sn = Math.sin(h.yaw)
      const dx = DOOR.x * c + DOOR.z * sn
      const dz = -DOOR.x * sn + DOOR.z * c
      return { x: h.x + dx * (h.r + 0.5), z: h.z + dz * (h.r + 0.5) }
    })
  }

  /** Re-rung every prop by its distance. */
  update(camX, camY, camZ) {
    let tris = 0
    for (const h of this.props) {
      const ex = h.x - camX, ey = h.y + (h.top - h.y) / 2 - camY, ez = h.z - camZ
      const cur = this.tierAt[h.id]
      const tier = ladderTier(h.base, PROP_STEPS, TIERS.length, Math.sqrt(ex * ex + ey * ey + ez * ez), cur)
      if (tier !== cur) {
        this.tierAt[h.id] = tier
        const drawn = tier < TIERS.length
        this.batch.setVisibleAt(h.id, drawn)
        if (drawn) this.batch.setGeometryIdAt(h.id, tier)
      }
      if (tier < TIERS.length) tris += this.bank.tris[tier]
    }
    this.tris = tris
  }

  /** Whether (x, z) is within `pad` of the clearing or a hut: the trees' `deadwood` contract, so the wood stops at the village. */
  occupiesAt(x, z, pad) {
    const c = this.clearing
    const cx = x - c.x, cz = z - c.z, cr = c.r + pad
    if (cx * cx + cz * cz < cr * cr) return true
    for (const h of this.props) {
      const dx = x - h.x, dz = z - h.z, r = h.r + pad
      if (dx * dx + dz * dz < r * r) return true
    }
    return false
  }

  // -- stone to the walker (walk.js addStone) ---------------------------------

  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    for (const h of this.props) {
      if (n >= cap) break
      const dx = x - h.x, dz = z - h.z
      if (dx * dx + dz * dz > h.r * h.r) continue
      out[n * 2] = h.y
      out[n * 2 + 1] = h.top
      n++
    }
    return n
  }

  blockTopAt(x, z) {
    let top = -Infinity
    for (const h of this.props) {
      const dx = x - h.x, dz = z - h.z
      if (dx * dx + dz * dz <= h.r * h.r && h.top > top) top = h.top
    }
    return top
  }

  get stats() {
    return { placed: this.props.length, tris: this.tris, pool: POOL }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.batch.dispose()
    if (this.material.map) this.material.map.dispose()
    this.material.dispose()
    for (const t of this.bank.tiers) for (const g of t.geometries) g.dispose()
  }
}
