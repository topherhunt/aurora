import THREE from '../../three-instance.js'
import { taken, TOLERANCE_M } from '../taken.js'

// ---------------------------------------------------------------------------
// Pumpkins: a crop on the last row of every town field (layers/trades.js pumpkinSpots), pulled like a carrot (hands.js kind
// 'pumpkin'), and the jack-o'-lantern a knife carves one into (kind LANTERN). Both meshes are built here in code.
//
// THE LANTERN IS ONE DOUBLE-SIDED SHELL. Its holes are not in the mesh: the fragment shader discards the shell wherever
// its carving mask is set, so they are as fine as the mask at any tessellation. Back faces are the flesh inside, dark
// until a flint's spark lights it (rec.lit); lit, the inside glows and a flame (aPart 2, collapsed to its base while
// unlit) stands at FLAME.
//
// THE MASK is CARVE_W cells round by CARVE_H pole to pole, a bit each, set where a knife's blade passed through the wall
// (cutSweep; main.js carveStroke). It rides in the record as `carve`, base64, so the backpack, the save, a dropped
// lantern and a peer's copy all keep it; the relay holds it to CARVE_B64 (server/src/main.js). Drawn, a mask is one
// layer of a texture array every lantern shares, the least lately drawn given up for a new one; `aCarve` is its layer.
// ---------------------------------------------------------------------------

export const KIND = 'pumpkin'
export const LANTERN = 'jack-o-lantern'
// Longest side in metres, at scale 1: across the belly.
export const SIZE_M = 0.36
const R = SIZE_M / 2
const SQUASH = 0.8
const RIBS = 8
// The flame's base, in the pumpkin's frame: on the floor inside. Where a spark lights it and its light sits.
export const FLAME = new THREE.Vector3(0, -0.3 * R, 0)
const FLAME_H = 0.085
// Within this of FLAME, a spark lights the lantern.
export const LIGHT_M = R
// Pumpkins within NEAR_M of her are drawn, redrawn each time she has gone RESEAT_M.
const NEAR_M = 70
const RESEAT_M = 5

export const CARVE_W = 128
export const CARVE_H = 64
export const CARVE_BYTES = (CARVE_W * CARVE_H) / 8
export const CARVE_B64 = 4 * Math.ceil(CARVE_BYTES / 3)
// Masks drawn at once; layer 0 is the uncut one.
const CARVE_LAYERS = 32
// A blade point cuts where it is within the wall: between these fractions of the skin's radius there.
const WALL_IN = 0.75
const WALL_OUT = 1.1
// The blade is sampled this finely along it and between frames, and swept over at most SWEEP_MAX steps a frame.
const STEP_M = 0.004
const SWEEP_MAX = 16
const LIT = [1]
const UNLIT = [0]

export function encodeCarve(bits) {
  if (bits.length !== CARVE_BYTES) throw new Error(`encodeCarve: ${bits.length} bytes, not ${CARVE_BYTES}`)
  let s = ''
  for (let i = 0; i < bits.length; i++) s += String.fromCharCode(bits[i])
  return btoa(s)
}

export function decodeCarve(b64) {
  if (typeof b64 !== 'string' || b64.length !== CARVE_B64) throw new Error(`decodeCarve: not a carving, ${String(b64).slice(0, 40)}`)
  const s = atob(b64)
  const bits = new Uint8Array(CARVE_BYTES)
  for (let i = 0; i < bits.length; i++) bits[i] = s.charCodeAt(i)
  return bits
}

export const UNCUT = encodeCarve(new Uint8Array(CARVE_BYTES))

/** The mask cell under the pumpkin-frame point (x, y, z), or -1 when the point is not within the wall. The shader's `carved` maps the same way. */
export function cellAt(x, y, z) {
  const ys = y / SQUASH
  const len = Math.hypot(x, ys, z)
  const a = Math.atan2(z, x)
  const skin = R * (0.9 + 0.1 * Math.sqrt(Math.abs(Math.cos((RIBS * a) / 2))))
  if (!(len > WALL_IN * skin && len < WALL_OUT * skin)) return -1
  const ix = Math.floor((a / (2 * Math.PI) + 0.5) * CARVE_W) % CARVE_W
  const iy = Math.min(CARVE_H - 1, Math.floor((Math.acos(ys / len) / Math.PI) * CARVE_H))
  return iy * CARVE_W + ix
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _pt = new THREE.Vector3()
/** Cuts into `bits` a blade swept from (a0, b0) to (a1, b1), its two ends in the pumpkin's frame; the cells newly cut. */
export function cutSweep(bits, a0, b0, a1, b1) {
  const steps = Math.min(SWEEP_MAX, Math.max(1, Math.ceil(Math.max(a0.distanceTo(a1), b0.distanceTo(b1)) / STEP_M)))
  let n = 0
  for (let s = 1; s <= steps; s++) {
    _a.lerpVectors(a0, a1, s / steps)
    _b.lerpVectors(b0, b1, s / steps)
    const along = Math.max(1, Math.ceil(_a.distanceTo(_b) / STEP_M))
    for (let k = 0; k <= along; k++) {
      _pt.lerpVectors(_a, _b, k / along)
      const c = cellAt(_pt.x, _pt.y, _pt.z)
      if (c < 0 || bits[c >> 3] & (1 << (c & 7))) continue
      bits[c >> 3] |= 1 << (c & 7)
      n++
    }
  }
  return n
}

/** Where a ray (in the pumpkin's frame, `dir` a unit vector) first meets the skin, into `out`; false if it misses. */
export function rayInto(origin, dir, out) {
  const tc = -origin.dot(dir)
  for (let t = Math.max(0, tc - 1.2 * R); t < tc + 1.2 * R; t += STEP_M / 2) {
    out.copy(dir).multiplyScalar(t).add(origin)
    const a = Math.atan2(out.z, out.x)
    if (Math.hypot(out.x, out.y / SQUASH, out.z) <= R * (0.9 + 0.1 * Math.sqrt(Math.abs(Math.cos((RIBS * a) / 2))))) return true
  }
  return false
}

const SKIN = [new THREE.Color(0xc8540c), new THREE.Color(0xf08a1c)]
const CROWN = new THREE.Color(0x8a6a1e)
const STEM = new THREE.Color(0x5a5222)

/** The pumpkin's skin: `u` round its ribs, `v` pole to pole, its point and colour into `p` and `c`. */
function skinAt(u, v, p, c) {
  const rib = Math.abs(Math.cos((RIBS * u) / 2))
  const lobe = 0.9 + 0.1 * Math.sqrt(rib)
  const s = Math.sin(v)
  const dimple = 0.32 * R * (Math.exp(-((v / 0.45) ** 2)) - 0.5 * Math.exp(-(((Math.PI - v) / 0.45) ** 2)))
  p.set(R * lobe * s * Math.cos(u), R * SQUASH * Math.cos(v) - dimple, R * lobe * s * Math.sin(u))
  c.copy(SKIN[0]).lerp(SKIN[1], rib).lerp(CROWN, Math.exp(-((v / 0.35) ** 2)))
}

/**
 * A pumpkin's geometry, `segs` round and `rings` pole to pole, with its stem; `flame` adds the lantern's flame. Every vertex
 * carries `aPart`: 0 the shell and stem, 2 the flame.
 */
export function buildPumpkinGeometry({ segs = 24, rings = 12, flame = false } = {}) {
  const pos = [], col = [], part = [], idx = []
  const p = new THREE.Vector3(), c = new THREE.Color()
  const push = (q, k, a) => { pos.push(q.x, q.y, q.z); col.push(k.r, k.g, k.b); part.push(a) }
  for (let j = 0; j <= rings; j++) {
    for (let i = 0; i < segs; i++) {
      skinAt((i / segs) * Math.PI * 2, (j / rings) * Math.PI, p, c)
      push(p, c, 0)
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * segs + i, b = j * segs + ((i + 1) % segs), d = a + segs, e = b + segs
      idx.push(a, b, d, b, e, d)
    }
  }
  // The stem: a bent, tapering hexagonal prism out of the crown's dimple.
  const top = R * SQUASH - 0.32 * R + 0.01
  const stem = pos.length / 3
  for (let k = 0; k <= 3; k++) {
    const t = k / 3
    const r = 0.02 * (1 - 0.35 * t)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      push(p.set(r * Math.cos(a) + 0.012 * t * t, top + 0.065 * t, r * Math.sin(a)), c.copy(STEM).multiplyScalar(0.8 + 0.2 * t), 0)
    }
  }
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 6; i++) {
      const a = stem + k * 6 + i, b = stem + k * 6 + ((i + 1) % 6)
      idx.push(a, a + 6, b, b, a + 6, b + 6)
    }
  }
  idx.push(stem + 18, stem + 19, stem + 20, stem + 18, stem + 20, stem + 21, stem + 18, stem + 21, stem + 23, stem + 23, stem + 21, stem + 22)
  if (flame) {
    // A six-sided spindle, widest a third of the way up.
    const f = pos.length / 3
    push(p.copy(FLAME), c.set(1, 1, 1), 2)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      push(p.set(FLAME.x + 0.02 * Math.cos(a), FLAME.y + FLAME_H / 3, FLAME.z + 0.02 * Math.sin(a)), c, 2)
    }
    push(p.set(FLAME.x, FLAME.y + FLAME_H, FLAME.z), c, 2)
    for (let i = 0; i < 6; i++) {
      const a = f + 1 + i, b = f + 1 + ((i + 1) % 6)
      idx.push(f, b, a, a, b, f + 7)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  if (flame) {
    geo.setAttribute('aLit', new THREE.InstancedBufferAttribute(new Float32Array(1), 1))
    geo.setAttribute('aCarve', new THREE.InstancedBufferAttribute(new Float32Array(1), 1))
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

// Whether the mask in layer `layer` is cut over the pumpkin-frame point `l`: cellAt's mapping, filtered, so a cut's edge is smooth.
const CARVED_GLSL = /* glsl */ `
  uniform highp sampler2DArray uCarve;
  bool carved( vec3 l, float layer ) {
    vec3 d = vec3( l.x, l.y / ${SQUASH.toFixed(4)}, l.z );
    vec2 uv = vec2( atan( d.z, d.x ) / 6.2831853 + 0.5, acos( clamp( d.y / length( d ), -1.0, 1.0 ) ) / 3.1415927 );
    return texture( uCarve, vec3( uv, layer ) ).r > 0.5;
  }
`

/** The lantern's material: `glow` ({ value }, 0..1) the flicker every lit lantern shares, set each frame, and `carve` the masks' texture array. */
function buildLanternMaterial(glow, carve) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = glow
    shader.uniforms.uCarve = { value: carve }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aLit;\nattribute float aCarve;\nuniform float uGlow;\nvarying vec3 vLocal;\nvarying float vPart;\nvarying float vLit;\nvarying float vCarve;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = position; vPart = aPart; vLit = aLit; vCarve = aCarve;
        if ( aPart > 1.5 ) {
          vec3 base = vec3( ${FLAME.x.toFixed(4)}, ${FLAME.y.toFixed(4)}, ${FLAME.z.toFixed(4)} );
          transformed = base + ( transformed - base ) * aLit * vec3( 0.9 + 0.2 * uGlow, 0.7 + 0.5 * uGlow, 0.9 + 0.2 * uGlow );
        }`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uGlow;\nvarying vec3 vLocal;\nvarying float vPart;\nvarying float vLit;\nvarying float vCarve;\n${CARVED_GLSL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if ( vPart < 0.5 && carved( vLocal, floor( vCarve + 0.5 ) ) ) discard;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if ( vPart > 1.5 ) {
          diffuseColor.rgb = vec3( 0.0 );
          totalEmissiveRadiance = mix( vec3( 1.0, 0.45, 0.08 ), vec3( 1.0, 0.92, 0.55 ), clamp( ( vLocal.y - ${FLAME.y.toFixed(4)} ) / ${FLAME_H.toFixed(4)}, 0.0, 1.0 ) ) * 2.2;
        } else if ( !gl_FrontFacing ) {
          float low = clamp( 1.0 - ( vLocal.y - ${FLAME.y.toFixed(4)} ) / ${(2 * R).toFixed(4)}, 0.3, 1.0 );
          diffuseColor.rgb = vec3( 0.2, 0.1, 0.03 );
          totalEmissiveRadiance += vec3( 1.0, 0.42, 0.08 ) * vLit * uGlow * low * 1.4;
        }`)
  }
  m.customProgramCacheKey = () => 'v2-jack-o-lantern'
  return m
}

/**
 * The pumpkins on the fields and the Hands source for both kinds. `plots` is `[{ spots: [[x, z, grow]] }]` (main.js); each
 * spot grows one, sat on `ground(x, z)`. Drawn as one instanced mesh of those within NEAR_M of her.
 */
export class Pumpkins {
  constructor(scene, ground, plots) {
    this.ground = ground
    this.geometry = buildPumpkinGeometry()
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.heldGeometry = buildPumpkinGeometry({ segs: 40, rings: 20 })
    this.lanternGeometry = buildPumpkinGeometry({ segs: 40, rings: 20, flame: true })
    this.glow = { value: 1 }
    this.carveTex = new THREE.DataArrayTexture(new Uint8Array(CARVE_W * CARVE_H * CARVE_LAYERS), CARVE_W, CARVE_H, CARVE_LAYERS)
    this.carveTex.format = THREE.RedFormat
    this.carveTex.minFilter = this.carveTex.magFilter = THREE.LinearFilter
    this.carveTex.wrapS = THREE.RepeatWrapping
    this.carveTex.needsUpdate = true
    // carve string -> { layer, used: the frame it was last drawn }; `free` the layers no mask holds.
    this.layers = new Map()
    this.free = Array.from({ length: CARVE_LAYERS - 1 }, (_, i) => CARVE_LAYERS - 1 - i)
    this.frame = 0
    this.overflow = 0
    this.lanternMaterial = buildLanternMaterial(this.glow, this.carveTex)
    this.materials = [this.material]
    // [x, y, z, scale, yaw, r, g, b] per spot.
    this.spots = []
    for (const plot of plots) {
      for (const [x, z, grow] of plot.spots) {
        const h = Math.sin(x * 91.7 + z * 47.3) * 43758.5453
        const u = h - Math.floor(h)
        const scale = 0.55 + 0.6 * grow
        this.spots.push({ x, z, y: ground(x, z) + R * SQUASH * scale * 0.85, scale, yaw: u * Math.PI * 2, tint: 0.85 + 0.3 * u, gone: taken.has(KIND, x, z) })
      }
    }
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, this.spots.length))
    this.mesh.name = 'v2-pumpkins'
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.spots.length) * 3), 3)
    scene.add(this.mesh)
    this.shown = []
    this.cx = Infinity
    this.cz = Infinity
    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._v = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    this.size = SIZE_M
  }

  /** The instances redrawn when she has gone RESEAT_M since the last, or `force`. */
  update(x, z, force = false) {
    this.frame++
    if (!force && Math.hypot(x - this.cx, z - this.cz) < RESEAT_M) return
    this.cx = x
    this.cz = z
    this.shown.length = 0
    const col = this.mesh.instanceColor.array
    for (const s of this.spots) {
      if (s.gone || Math.hypot(s.x - x, s.z - z) > NEAR_M) continue
      const n = this.shown.length
      this._m.compose(this._v.set(s.x, s.y, s.z), this._q.setFromAxisAngle(this._up, s.yaw), this._s.setScalar(s.scale))
      this.mesh.setMatrixAt(n, this._m)
      col[n * 3] = s.tint; col[n * 3 + 1] = s.tint; col[n * 3 + 2] = s.tint
      this.shown.push(s)
    }
    this.mesh.count = this.shown.length
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
  }

  /** The drawn pumpkin nearest (x, y, z) within `reach` of its belly: `{ dist, spot, size }`, or null. For hands.js. */
  pickAt(x, y, z, reach) {
    let best = null
    for (const spot of this.shown) {
      if (spot.gone) continue
      const dist = Math.max(0, Math.hypot(spot.x - x, spot.y - y, spot.z - z) - R * spot.scale)
      if (dist < reach && (best === null || dist < best.dist)) best = { dist, spot, size: SIZE_M * spot.scale }
    }
    return best
  }

  /** Pull a pickAt() hit: gone from the field for good, and in the hand as a record. */
  take(hit) {
    const { spot } = hit
    if (spot.gone) throw new Error('Pumpkins.take: that pumpkin was taken already')
    spot.gone = true
    taken.add(KIND, spot.x, spot.z)
    this.update(this.cx, this.cz, true)
    return { ...this.slot(KIND, spot.scale, spot.tint), ...this.dress({ kind: KIND }) }
  }

  /** A peer took the pumpkin at (x, z): gone here too. */
  evict(key, x, z) {
    if (key !== KIND) return false
    const spot = this.spots.find((s) => !s.gone && Math.abs(s.x - x) < TOLERANCE_M && Math.abs(s.z - z) < TOLERANCE_M)
    if (!spot) return false
    spot.gone = true
    this.update(this.cx, this.cz, true)
    return true
  }

  dress(slot) {
    if (slot.kind === KIND) return { geometry: this.heldGeometry, material: this.material }
    if (slot.kind === LANTERN) {
      decodeCarve(slot.carve)
      return { geometry: this.lanternGeometry, material: this.lanternMaterial }
    }
    throw new Error(`Pumpkins.dress: not a pumpkin, ${slot.kind}`)
  }

  /** A lantern's instanced values as it is this frame, for hands.js: its flame, and the layer its carving is drawn from. */
  drawn(name, rec) {
    if (name === 'aLit') return rec.lit ? LIT : UNLIT
    if (name === 'aCarve') return [this.layerOf(rec.carve)]
    throw new Error(`Pumpkins.drawn: no ${name}`)
  }

  /** The texture layer holding mask `carve`, loaded into the least lately drawn one if no layer holds it; 0, uncut, when every layer was drawn this frame. */
  layerOf(carve) {
    let entry = this.layers.get(carve)
    if (!entry) {
      let layer = this.free.pop()
      if (layer === undefined) {
        let oldest = null
        for (const [key, e] of this.layers) if (oldest === null || e.used < this.layers.get(oldest).used) oldest = key
        if (this.layers.get(oldest).used === this.frame) {
          this.overflow++
          return 0
        }
        layer = this.layers.get(oldest).layer
        this.layers.delete(oldest)
      }
      const bits = decodeCarve(carve)
      const data = this.carveTex.image.data
      const at = layer * CARVE_W * CARVE_H
      for (let i = 0; i < CARVE_W * CARVE_H; i++) data[at + i] = bits[i >> 3] & (1 << (i & 7)) ? 255 : 0
      this.carveTex.addLayerUpdate(layer)
      this.carveTex.needsUpdate = true
      this.layers.set(carve, (entry = { layer, used: 0 }))
    }
    entry.used = this.frame
    return entry.layer
  }

  /** A pumpkin, or an uncut lantern, at `scale` and grey `tint`, packed for a hand or a backpack slot. */
  slot(kind, scale = 1, tint = 1) {
    if (kind !== KIND && kind !== LANTERN) throw new Error(`Pumpkins.slot: no ${kind}`)
    const slot = { kind, name: kind === KIND ? 'pumpkin' : "jack-o'-lantern", size: SIZE_M * scale, scale: [scale, scale, scale], color: [tint, tint, tint], stowable: true, lit: false, attrs: {} }
    return kind === LANTERN ? { ...slot, carve: UNCUT } : slot
  }

  /** The lantern a packed pumpkin becomes at its first cut, mask `carve`: its size and tint kept, unlit. */
  carved(slot, carve) {
    if (slot.kind !== KIND) throw new Error(`Pumpkins.carved: a ${slot.kind} is not carved`)
    decodeCarve(carve)
    return { ...slot, kind: LANTERN, name: "jack-o'-lantern", lit: false, carve }
  }

  setShown(shown) { this.mesh.visible = shown }

  get stats() { return { spots: this.spots.length, shown: this.shown.length, taken: this.spots.filter((s) => s.gone).length, carvings: this.layers.size, overflow: this.overflow } }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    for (const g of [this.geometry, this.heldGeometry, this.lanternGeometry]) g.dispose()
    this.material.dispose()
    this.lanternMaterial.dispose()
    this.carveTex.dispose()
  }
}
