import THREE from '../three-instance.js'

// ---------------------------------------------------------------------------
// The flare gun: a thing her hands hold (hands.js kind 'flaregun') that shoots
// flares (render/flares.js). Its record carries `charges` and `hue`, a
// PALETTE index, as scalars, so the backpack, the save, a drop and the room
// all carry them with the gun. Nothing in the world hands one out -- it starts
// in the backpack (main.js) -- so its source picks nothing and takes nothing,
// and gives nothing back: a dropped gun lies loose until a hand lifts it.
// Until its generated mesh exists (prop-roster.mjs 'flaregun') it is drawn in
// primitives, barrel along -Z. The round window on top shows the colour it
// will fire as a disc, smaller as the charges run down and gone at none; only
// on her own held guns.
// ---------------------------------------------------------------------------

export const KIND = 'flaregun'
export const CHARGES = 10
// Red, green, white, amber, blue, violet.
export const PALETTE = [0xff3020, 0x30ff50, 0xfff4e0, 0xffb020, 0x3080ff, 0xc050ff]
// A shot's target: this far down the barrel, and at least this far over the ground or the water under it.
export const AIM_M = 100
export const CLEAR_M = 20
// In the gun's own frame: where a flare leaves, and the window's centre on its top face and its radius with every charge left.
export const MUZZLE = new THREE.Vector3(0, 0.02, -0.205)
export const WINDOW = new THREE.Vector3(0, 0.0526, -0.045)
export const WINDOW_R = 0.0095

const WOOD = 0x5b3a21
const IRON = 0x6e6f72
const BRASS = 0xb08a3a
const TWINE = 0xb59a68
const RED = 0xa51c1c
const GLASS = 0x10141a

/** The primitives' pile: each part a geometry of its own, painted its colour and merged by hand into one non-indexed geometry. */
function buildGeometry() {
  const parts = []
  const part = (geo, hex, place) => { place(geo); parts.push([geo.toNonIndexed(), new THREE.Color().setHex(hex)]) }
  // Y-axis cylinders turned onto Z, their +Y end to -Z.
  const alongZ = (x, y, z) => (g) => g.rotateX(-Math.PI / 2).translate(x, y, z)
  const at = (x, y, z) => (g) => g.translate(x, y, z)
  // The grip leans back from the barrel, its foot toward the wrist.
  const grip = (y, x, z) => (g) => g.translate(0, y, 0).rotateX(-0.35).translate(x, -0.04, z)
  part(new THREE.CylinderGeometry(0.026, 0.026, 0.19, 14), IRON, alongZ(0, 0.02, -0.075))
  part(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 14), TWINE, alongZ(0, 0.02, -0.08))
  for (const z of [-0.02, -0.14]) part(new THREE.CylinderGeometry(0.029, 0.029, 0.012, 14), BRASS, alongZ(0, 0.02, z))
  part(new THREE.CylinderGeometry(0.04, 0.026, 0.035, 14), BRASS, alongZ(0, 0.02, -0.1875))
  part(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 14), BRASS, alongZ(0, 0.02, 0.028))
  part(new THREE.BoxGeometry(0.034, 0.12, 0.048), WOOD, grip(0, 0, 0.035))
  part(new THREE.BoxGeometry(0.037, 0.035, 0.051), TWINE, grip(0.015, 0, 0.035))
  part(new THREE.BoxGeometry(0.04, 0.018, 0.056), BRASS, grip(-0.065, 0, 0.035))
  part(new THREE.BoxGeometry(0.006, 0.03, 0.008), IRON, at(0, -0.02, -0.005))
  part(new THREE.CylinderGeometry(0.012, 0.012, 0.006, 14), BRASS, at(0, 0.047, -0.005))
  part(new THREE.CylinderGeometry(0.009, 0.009, 0.012, 14), RED, at(0, 0.052, -0.005))
  part(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 14), BRASS, at(0, 0.048, WINDOW.z))
  part(new THREE.CylinderGeometry(0.011, 0.011, 0.0082, 14), GLASS, at(0, 0.048, WINDOW.z))
  let n = 0
  for (const [g] of parts) n += g.attributes.position.count
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3)
  let o = 0
  for (const [g, c] of parts) {
    const count = g.attributes.position.count
    pos.set(g.attributes.position.array, o * 3)
    nor.set(g.attributes.normal.array, o * 3)
    for (let i = 0; i < count; i++) c.toArray(col, (o + i) * 3)
    o += count
    g.dispose()
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.computeBoundingBox()
  return geo
}

/** The Hands source for the gun: see the header. One per Hands, built with it. */
export class FlareGuns {
  constructor() {
    this.geometry = buildGeometry()
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true })
    const size = this.geometry.boundingBox.getSize(new THREE.Vector3())
    this.size = Math.max(size.x, size.y, size.z)
  }

  pickAt() { return null }

  take() { throw new Error('FlareGuns.take: nothing in the world hands out a flare gun') }

  dress() { return { geometry: this.geometry, material: this.material } }

  /** A new gun, packed for a backpack slot: every charge, the first colour. */
  slot() {
    return { kind: KIND, name: 'flare gun', size: this.size, scale: [1, 1, 1], color: null, stowable: true, attrs: {}, charges: CHARGES, hue: 0 }
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/** The room a flare is shot in, as flares.js files it: the overworld, or a village by the mouth it is entered from. */
export const roomKey = (roomId, door) => (door ? `${roomId}:${door.key}` : roomId).toLowerCase()

/**
 * A shot's target into `out`: AIM_M down `dir` (unit) from `muzzle`, lifted to
 * CLEAR_M over whichever is higher under it, the ground (`groundAt(x, z)`)
 * or the water (`levelAt(x, z)`, null where there is none).
 */
export function aimTarget(muzzle, dir, groundAt, levelAt, out) {
  out.copy(dir).multiplyScalar(AIM_M).add(muzzle)
  const level = levelAt(out.x, out.z)
  const floor = Math.max(groundAt(out.x, out.z), level === null ? -Infinity : level) + CLEAR_M
  if (out.y < floor) out.y = floor
  return out
}

const _m = new THREE.Matrix4()
const _w = new THREE.Matrix4()

/** The windows of her held guns: a disc per hand, in the scene the held things are drawn over the frame in. */
export class GunWindows {
  constructor(parent, keys) {
    this.discs = new Map()
    const geo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2)
    for (const key of keys) {
      const disc = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
      disc.name = `v2-flaregun-window-${key}`
      disc.matrixAutoUpdate = false
      disc.visible = false
      parent.add(disc)
      this.discs.set(key, disc)
    }
  }

  /** One frame, after hands.update: each hand's disc on the gun it holds, sized to the charges left, or hidden. */
  update(hands) {
    for (const [key, disc] of this.discs) {
      const rec = hands.holding(key)
      disc.visible = rec !== null && rec.kind === KIND && rec.charges > 0
      if (!disc.visible) continue
      const r = WINDOW_R * Math.sqrt(rec.charges / CHARGES)
      hands.heldFrame(key, _m)
      disc.matrix.multiplyMatrices(_m, _w.makeScale(r, 1, r).setPosition(WINDOW))
      disc.matrixWorldNeedsUpdate = true
      disc.material.color.setHex(PALETTE[rec.hue])
    }
  }
}
