import THREE from '../three-instance.js'

// The valuables and the smith's tools (design/42-valuables.md): one Hands source for every kind in ITEMS, each
// wearing its shipped mesh (public/gen-props/items/<kind>.glb, the 500-triangle tier). Small kinds stack: a record
// of one carries `count`, a fistful, and the backpack keeps them as counts in its brown row (main.js purse). Loot
// lying in the world -- a plinth's gem, a roost's hoard, a dead dragon's gems -- is a spot laid here against a
// place in the loot ledger (loot.js), drawn while the ledger says it is still there.

// `size` is the longest side in metres; `pile` is how many meshes a spot of `count` small things is drawn as.
export const ITEMS = {
  coin: { name: 'coin', small: true, size: 0.04 },
  jade: { name: 'jade', small: true, size: 0.05 },
  ruby: { name: 'ruby', small: true, size: 0.05 },
  sapphire: { name: 'sapphire', small: true, size: 0.05 },
  diamond: { name: 'diamond', small: true, size: 0.05 },
  'bog-iron': { name: 'bog iron', small: false, size: 0.16 },
  lodestone: { name: 'lodestone', small: false, size: 0.16 },
  rimesilver: { name: 'rimesilver', small: false, size: 0.16 },
  firestone: { name: 'firestone', small: false, size: 0.16 },
  pickaxe: { name: 'pickaxe', small: false, size: 0.6 },
  sword: { name: 'sword', small: false, size: 0.9 },
  shield: { name: 'shield', small: false, size: 0.6 },
  'flare-charges': { name: 'flare charges', small: false, size: 0.2 },
}
export const SMALL = Object.keys(ITEMS).filter((k) => ITEMS[k].small)
export const itemUrl = (kind) => `gen-props/items/${kind}.glb`

const PILE_MAX = 6
// Metres past which a spot is not drawn: a coin is under a pixel well inside it.
const SIGHT = 60
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()

export class Items {
  /** `loot` the ledger (loot.js). The spots are drawn in `group`, for the caller to add to its scene. */
  constructor(loot) {
    this.loot = loot
    this.group = new THREE.Group()
    this.group.name = 'v2-items'
    this.worn = new Map()
    // { place, bit, kind, count, x, y, z, yaw, mesh }
    this.spots = []
  }

  /** A kind's mesh as critters.js loadCritterGlb hands it over: centred on its box and scaled to ITEMS[kind].size. */
  wear(kind, asset) {
    const def = ITEMS[kind]
    if (!def) throw new Error(`Items.wear: no item ${kind}`)
    if (this.worn.has(kind)) throw new Error(`Items.wear: ${kind} twice`)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(asset.pos), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(asset.nrm), 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(asset.uv), 2))
    geo.setIndex(asset.idx)
    geo.computeBoundingBox()
    const box = geo.boundingBox
    const c = box.getCenter(new THREE.Vector3())
    const s = def.size / Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    geo.translate(-c.x, -c.y, -c.z)
    geo.scale(s, s, s)
    geo.computeBoundingBox()
    geo.computeBoundingSphere()
    this.worn.set(kind, { geometry: geo, material: new THREE.MeshLambertMaterial({ map: asset.map }) })
    for (const spot of this.spots) if (spot.kind === kind) this._draw(spot)
  }

  /** Thing `bit` of ledger `place` lies at (x, y, z): `count` of a small kind, one of a large. Nothing if it was taken. */
  lay(place, bit, kind, x, y, z, count = 1) {
    const def = ITEMS[kind]
    if (!def) throw new Error(`Items.lay: no item ${kind}`)
    if (!Number.isInteger(count) || count < 1 || (!def.small && count !== 1)) throw new Error(`Items.lay: ${count} of a ${kind}`)
    if (this.loot.taken(place, bit)) return
    if (this.spots.some((s) => s.place === place && s.bit === bit)) return
    const spot = { place, bit, kind, count, x, y, z, yaw: ((bit * 2.39996) % 1) * Math.PI * 2, mesh: null }
    this.spots.push(spot)
    if (this.worn.has(kind)) this._draw(spot)
  }

  /** Every spot gone, for a world being rebuilt. */
  clear() {
    for (const spot of this.spots) if (spot.mesh) this.group.remove(spot.mesh)
    this.spots.length = 0
  }

  _draw(spot) {
    const { geometry, material } = this.worn.get(spot.kind)
    const n = ITEMS[spot.kind].small ? Math.min(PILE_MAX, Math.ceil(spot.count / 10)) : 1
    const mesh = new THREE.InstancedMesh(geometry, material, n)
    mesh.name = `v2-item-${spot.kind}`
    const r = ITEMS[spot.kind].size
    for (let i = 0; i < n; i++) {
      const a = spot.yaw + i * 2.39996
      const d = i === 0 ? 0 : r * 0.9 * Math.sqrt(i)
      _q.setFromEuler(_e.set(ITEMS[spot.kind].small ? Math.PI / 2 : 0, a, 0))
      _m.compose(new THREE.Vector3(spot.x + Math.cos(a) * d, spot.y + geometry.boundingBox.max.y, spot.z + Math.sin(a) * d), _q, new THREE.Vector3(1, 1, 1))
      mesh.setMatrixAt(i, _m)
    }
    mesh.computeBoundingSphere()
    this.group.add(mesh)
    spot.mesh = mesh
  }

  /** One frame: spots the room has looted since are gone, and those past SIGHT of (x, z) not drawn. */
  update(x, z) {
    for (let i = this.spots.length - 1; i >= 0; i--) {
      const spot = this.spots[i]
      if (!this.loot.taken(spot.place, spot.bit)) {
        if (spot.mesh) spot.mesh.visible = (spot.x - x) ** 2 + (spot.z - z) ** 2 < SIGHT * SIGHT
        continue
      }
      if (spot.mesh) this.group.remove(spot.mesh)
      this.spots.splice(i, 1)
    }
  }

  pickAt(x, y, z, reach) {
    let best = null
    for (const spot of this.spots) {
      if (!spot.mesh) continue
      const dist = Math.max(0, Math.hypot(spot.x - x, spot.y - y, spot.z - z) - ITEMS[spot.kind].size)
      if (dist < reach && (!best || dist < best.dist)) best = { dist, size: ITEMS[spot.kind].size, spot }
    }
    return best
  }

  take(hit) {
    const { spot } = hit
    if (!this.loot.take(spot.place, spot.bit)) throw new Error(`Items.take: ${spot.place} ${spot.bit} was taken already`)
    this.group.remove(spot.mesh)
    this.spots.splice(this.spots.indexOf(spot), 1)
    return this.record(spot.kind, spot.count)
  }

  /** A record of `count` of `kind`, dressed: for a mined vein, a smith's sale, a trade. */
  record(kind, count = 1) {
    const rec = { ...this.slot(kind, count), ...this.worn.get(kind) }
    if (!rec.geometry) throw new Error(`Items.record: the ${kind} has not landed its mesh`)
    return rec
  }

  /** Half of `kind`'s mesh along its longest side, in its own frame, into `out`: wear centres it, so its two ends are at +out and -out. */
  half(kind, out) {
    const worn = this.worn.get(kind)
    if (!worn) throw new Error(`Items.half: the ${kind} has not landed its mesh`)
    const { min, max } = worn.geometry.boundingBox
    const x = max.x - min.x, y = max.y - min.y, z = max.z - min.z
    return out.set(x >= y && x >= z ? x / 2 : 0, y > x && y >= z ? y / 2 : 0, z > x && z > y ? z / 2 : 0)
  }

  dress(slot) {
    return this.worn.has(slot.kind) ? this.worn.get(slot.kind) : null
  }

  /** `count` of `kind`, packed for a slot or a hand. */
  slot(kind, count = 1) {
    const def = ITEMS[kind]
    if (!def) throw new Error(`Items.slot: no item ${kind}`)
    const s = { kind, name: def.name, size: def.size, scale: [1, 1, 1], color: null, stowable: true, attrs: {} }
    if (def.small) s.count = count
    else if (count !== 1) throw new Error(`Items.slot: ${count} of a ${kind}, which does not stack`)
    return s
  }
}
