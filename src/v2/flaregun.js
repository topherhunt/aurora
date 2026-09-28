import THREE from '../three-instance.js'

// ---------------------------------------------------------------------------
// The flare gun: a thing her hands hold (hands.js kind 'flaregun') that shoots
// flares (render/flares.js). Its record carries `charges`, `hue` (a PALETTE
// index, null until first armed) and `armed` as scalars, so the backpack, the
// save, a drop and the room all carry them with the gun. It starts safe: the
// trigger only dry-clicks until A/X arms it (see pressSafety). Nothing in the
// world hands one out -- it starts in the backpack (main.js) -- so its source
// picks nothing and takes nothing, and gives nothing back: a dropped gun lies
// loose until a hand lifts it. It wears its generated mesh (FLAREGUN_GLB).
// The round window at the back of the lock shows the colour it will fire as a
// disc, smaller as the charges run down and gone at none or on safe; only on
// her own held guns. Her own shot flashes her whole view in its colour, washed
// toward white (ShotFlash).
// ---------------------------------------------------------------------------

export const KIND = 'flaregun'
export const CHARGES = 10
// Red, green, white, amber, blue, violet.
export const PALETTE = [0xff3020, 0x30ff50, 0xfff4e0, 0xffb020, 0x3080ff, 0xc050ff]
// A shot's target: this far down the barrel, and at least this far over the ground or the water under it.
export const AIM_M = 100
export const CLEAR_M = 20
// The shipped pick (tools/props/gen/prop-roster.mjs 'flaregun'), drawn SIZE_M long in its own frame: barrel along -Z, grip down.
export const FLAREGUN_GLB = 'gen-props/flaregun.glb'
export const SIZE_M = 0.32
// Measured on pick 0 in its own units, where it is PICK_LONG along Z: the muzzle's centre, and the brass collar
// ship.mjs glasses (the red button that stood in it is cut) -- the centre of its face, a hair proud of it, and
// the glass's radius. A new pick wants these measured again; wear() throws on one of another length.
const PICK_LONG = 0.998046875
const S = SIZE_M / PICK_LONG
// In the gun's frame: where a flare leaves, and the window's centre, facing and radius with every charge left.
export const MUZZLE = new THREE.Vector3(-0.0073, 0.1281, -0.499).multiplyScalar(S)
export const WINDOW = new THREE.Vector3(-0.0036, 0.1842, 0.1315).multiplyScalar(S)
export const WINDOW_N = new THREE.Vector3(-0.099, 0.149, 0.984).normalize()
export const WINDOW_R = 0.029 * S

/** The Hands source for the gun: see the header. One per Hands; wear() gives it the shipped mesh before anything dresses one. */
export class FlareGuns {
  constructor() {
    this.geometry = null
    this.material = null
    this.size = SIZE_M
  }

  /** The pick as critters.js loadCritterGlb hands it over, loaded with origin [0, 0, 0] so it keeps its own frame. */
  wear(asset) {
    if (this.geometry) throw new Error('FlareGuns.wear: already wearing its mesh')
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(asset.pos), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(asset.nrm), 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(asset.uv), 2))
    geo.setIndex(asset.idx)
    geo.computeBoundingBox()
    const long = geo.boundingBox.max.z - geo.boundingBox.min.z
    if (Math.abs(long - PICK_LONG) > 1e-3) throw new Error(`FlareGuns.wear: the pick is ${long.toFixed(4)} long, not the ${PICK_LONG} MUZZLE and WINDOW were measured on`)
    geo.scale(S, S, S)
    geo.computeBoundingBox()
    this.geometry = geo
    this.material = new THREE.MeshLambertMaterial({ map: asset.map })
  }

  pickAt() { return null }

  take() { throw new Error('FlareGuns.take: nothing in the world hands out a flare gun') }

  dress() {
    if (!this.geometry) throw new Error('FlareGuns.dress: before wear()')
    return { geometry: this.geometry, material: this.material }
  }

  /** A new gun, packed for a backpack slot: every charge, on safe, no colour yet. */
  slot() {
    return { kind: KIND, name: 'flare gun', size: this.size, scale: [1, 1, 1], color: null, stowable: true, attrs: {}, charges: CHARGES, hue: null, armed: false }
  }

  dispose() {
    this.geometry.dispose()
    this.material.map.dispose()
    this.material.dispose()
  }
}

/** A/X or Q on a held gun: armed goes to safe; safe arms it with the next colour (the first, on a gun never armed). */
export function pressSafety(rec) {
  if (rec.armed) rec.armed = false
  else {
    rec.hue = rec.hue === null ? 0 : (rec.hue + 1) % PALETTE.length
    rec.armed = true
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
const _s = new THREE.Vector3()
// The disc (a CircleGeometry, facing +Z) turned to face out of the window.
const FACING = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), WINDOW_N)

/** The windows of her held guns: a disc per hand, in the scene the held things are drawn over the frame in. */
export class GunWindows {
  constructor(parent, keys) {
    this.discs = new Map()
    const geo = new THREE.CircleGeometry(1, 24)
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
      disc.visible = rec !== null && rec.kind === KIND && rec.armed && rec.charges > 0
      if (!disc.visible) continue
      const r = WINDOW_R * Math.sqrt(rec.charges / CHARGES)
      hands.heldFrame(key, _m)
      disc.matrix.multiplyMatrices(_m, _w.compose(WINDOW, FACING, _s.set(r, r, 1)))
      disc.matrixWorldNeedsUpdate = true
      disc.material.color.setHex(PALETTE[rec.hue])
    }
  }
}

// The flash of her own shot: its peak opacity, how far its colour is washed toward white, and the seconds it fades over.
export const FLASH_PEAK = 0.85
export const FLASH_WHITE = 0.6
export const FLASH_S = 0.5
const WHITE = new THREE.Color(0xffffff)

/**
 * Her shot's flash: a sphere round her head, inside out and drawn last with no
 * depth, like main.js's blackout, so it covers the whole view in both eyes of a
 * headset for one blended layer of fill and no pass of its own.
 */
export class ShotFlash {
  constructor(parent) {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }),
    )
    this.mesh.name = 'v2-flaregun-flash'
    this.mesh.renderOrder = 1e6
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    parent.add(this.mesh)
    this.age = Infinity
  }

  /** A shot in `hex`: the flash at its peak. */
  fire(hex) {
    this.mesh.material.color.setHex(hex).lerp(WHITE, FLASH_WHITE)
    this.age = 0
  }

  /** One frame, `dt` seconds on, round her head at `eye`: fading as the square of the time left, gone at FLASH_S. */
  update(dt, eye) {
    this.age += dt
    const k = 1 - this.age / FLASH_S
    this.mesh.visible = k > 0
    if (!this.mesh.visible) return
    this.mesh.material.opacity = FLASH_PEAK * k * k
    this.mesh.position.copy(eye)
  }
}
