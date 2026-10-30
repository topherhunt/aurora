// Trick-or-treat: after dark she knocks on a town door and is handed a sweet, or now and then a ghost cap
// (design/45-bone-friends.md §Trick-or-treat). Each door answers once a night.

import THREE from '../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { hash32 } from '../sim/score.js'
import { CAP_M } from './render/skeletons.js'

export const TREAT = {
  // Past `dayness` no door answers. A knock lands within `doorR` m of a door's face at `doorH` over its sill.
  dayness: 0.3,
  doorR: 0.8,
  doorH: 1.1,
  // The second knock `knockS` after the first, the door opening `waitS` after it; `capShare` of doors hand out a ghost cap.
  knockS: 0.3,
  waitS: 1.4,
  capShare: 0.25,
  candyM: 0.07,
}
export const CANDY = 'candy'

/** The night `elapsed` world hours falls in, noon to noon, so one evening and its small hours are one night. */
export const nightOf = (elapsed) => Math.floor((elapsed + 12) / 24)

/** The first of `doors` ({ key, x, y, z }) the ray from `origin` along unit `dir` passes within TREAT.doorR of, no further than `far`, or null. */
export function doorOnRay(origin, dir, far, doors) {
  let best = null, at = far
  for (const d of doors) {
    const dx = d.x - origin.x, dy = d.y + TREAT.doorH - origin.y, dz = d.z - origin.z
    const t = dx * dir.x + dy * dir.y + dz * dir.z
    if (t < 0 || t > at) continue
    if (Math.hypot(dx - dir.x * t, dy - dir.y * t, dz - dir.z * t) > TREAT.doorR) continue
    best = d; at = t
  }
  return best
}

/** A wrapped sweet, TREAT.candyM long along x: a round middle and a twist of wrapper either side. */
export function candyGeometry() {
  const r = TREAT.candyM * 0.22
  const middle = new THREE.SphereGeometry(r, 10, 8)
  middle.scale(1.25, 1, 1)
  const parts = [middle]
  for (const side of [-1, 1]) {
    const twist = new THREE.ConeGeometry(r * 0.8, TREAT.candyM / 2 - r, 8, 1, true)
    twist.rotateZ(side * Math.PI / 2)
    twist.translate(side * (TREAT.candyM / 4 + r * 0.5), 0, 0)
    parts.push(twist)
  }
  const colours = [[1, 0.45, 0.05], [0.55, 0.2, 0.75], [0.55, 0.2, 0.75]]
  parts.forEach((g, i) => {
    g.deleteAttribute('uv')
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).map((_, j) => colours[i][j % 3]), 3))
  })
  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

/** The sweets' Hands source (none lies in the world to pick up); `answered` the doors that have, by `${door}@${night}`, kept by the caller. */
export class Treats {
  constructor(seed, answered) {
    this.seed = seed
    this.geometry = candyGeometry()
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
    this.answered = answered
  }

  get materials() { return [this.material] }

  /** What door `key` hands out on `night`, or null when it has already tonight. */
  knock(key, night) {
    const k = `${key}@${night}`
    if (this.answered.has(k)) return null
    this.answered.add(k)
    return (hash32(this.seed, night, ...[...key].map((c) => c.charCodeAt(0))) >>> 0) / 2 ** 32 < TREAT.capShare ? 'ghostcap' : CANDY
  }

  /** A packed slot of `kind` (a sweet, or the bone-folk's ghost cap) for Hands.give. */
  slot(kind) {
    if (kind === CANDY) return { kind, name: 'sweet', size: TREAT.candyM, scale: [1, 1, 1], color: null, stowable: true, attrs: {} }
    if (kind === 'ghostcap') return { kind, name: 'ghost cap', size: CAP_M, scale: [1, 1, 1], color: null, stowable: true, attrs: {} }
    throw new Error(`Treats.slot: no treat ${kind}`)
  }

  pickAt() { return null }

  take() { throw new Error('Treats.take: no sweet lies in the world') }

  dress(slot) {
    if (slot.kind !== CANDY) throw new Error(`Treats.dress: not a sweet, ${slot.kind}`)
    return { geometry: this.geometry, material: this.material }
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
