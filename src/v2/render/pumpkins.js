import THREE from '../../three-instance.js'
import { taken, TOLERANCE_M } from '../taken.js'

// ---------------------------------------------------------------------------
// Pumpkins: a crop on the last row of every town field (layers/trades.js pumpkinSpots), pulled like a carrot (hands.js kind
// 'pumpkin'), and the jack-o'-lantern a knife carves one into (kind LANTERN). Both meshes are built here in code.
//
// THE LANTERN IS ONE DOUBLE-SIDED SHELL. Its eyes, nose and smile are not in the mesh: the fragment shader discards the
// shell wherever the face plan (`carved`, in the pumpkin's own x/y, on its +Z side) says it is cut, so the holes are
// crisp at any tessellation. Back faces are the flesh inside, dark until a flint's spark lights it (rec.lit); lit, the
// inside glows and a flame (aPart 2, collapsed to its base while unlit) stands at FLAME. hands.js draws `aLit` from
// rec.lit, the one value that changes in place.
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
  if (flame) geo.setAttribute('aLit', new THREE.InstancedBufferAttribute(new Float32Array(1), 1))
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

// The face, in the pumpkin's x/y over R, on its +Z side: two eyes, a nose, and a smile with two teeth left standing.
const FACE_GLSL = /* glsl */ `
  float side( vec2 p, vec2 a, vec2 b ) { return ( b.x - a.x ) * ( p.y - a.y ) - ( b.y - a.y ) * ( p.x - a.x ); }
  bool inTri( vec2 p, vec2 a, vec2 b, vec2 c ) {
    float d1 = side( p, a, b ), d2 = side( p, b, c ), d3 = side( p, c, a );
    return !( ( d1 < 0.0 || d2 < 0.0 || d3 < 0.0 ) && ( d1 > 0.0 || d2 > 0.0 || d3 > 0.0 ) );
  }
  bool carved( vec3 l ) {
    if ( l.z < 0.3 * ${R.toFixed(4)} ) return false;
    vec2 p = l.xy / ${R.toFixed(4)};
    if ( inTri( p, vec2( -0.46, 0.1 ), vec2( -0.16, 0.1 ), vec2( -0.3, 0.38 ) ) ) return true;
    if ( inTri( p, vec2( 0.16, 0.1 ), vec2( 0.46, 0.1 ), vec2( 0.3, 0.38 ) ) ) return true;
    if ( inTri( p, vec2( -0.07, -0.08 ), vec2( 0.07, -0.08 ), vec2( 0.0, 0.05 ) ) ) return true;
    float x = p.x / 0.58;
    if ( abs( x ) >= 1.0 ) return false;
    float lo = -0.46 + 0.32 * x * x, hi = -0.2 + 0.1 * x * x;
    if ( p.y < lo || p.y > hi ) return false;
    return !( p.y > hi - 0.08 && ( abs( p.x - 0.16 ) < 0.045 || abs( p.x + 0.16 ) < 0.045 ) );
  }
`

/** The lantern's material: `glow` ({ value }, 0..1) the flicker every lit lantern shares, set each frame. */
function buildLanternMaterial(glow) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = glow
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aLit;\nuniform float uGlow;\nvarying vec3 vLocal;\nvarying float vPart;\nvarying float vLit;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = position; vPart = aPart; vLit = aLit;
        if ( aPart > 1.5 ) {
          vec3 base = vec3( ${FLAME.x.toFixed(4)}, ${FLAME.y.toFixed(4)}, ${FLAME.z.toFixed(4)} );
          transformed = base + ( transformed - base ) * aLit * vec3( 0.9 + 0.2 * uGlow, 0.7 + 0.5 * uGlow, 0.9 + 0.2 * uGlow );
        }`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uGlow;\nvarying vec3 vLocal;\nvarying float vPart;\nvarying float vLit;\n${FACE_GLSL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if ( vPart < 0.5 && carved( vLocal ) ) discard;')
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
    this.lanternMaterial = buildLanternMaterial(this.glow)
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
    if (slot.kind === LANTERN) return { geometry: this.lanternGeometry, material: this.lanternMaterial }
    throw new Error(`Pumpkins.dress: not a pumpkin, ${slot.kind}`)
  }

  /** A pumpkin, or a lantern, at `scale` and grey `tint`, packed for a hand or a backpack slot. */
  slot(kind, scale = 1, tint = 1) {
    if (kind !== KIND && kind !== LANTERN) throw new Error(`Pumpkins.slot: no ${kind}`)
    return { kind, name: kind === KIND ? 'pumpkin' : "jack-o'-lantern", size: SIZE_M * scale, scale: [scale, scale, scale], color: [tint, tint, tint], stowable: true, lit: false, attrs: {} }
  }

  /** The lantern a packed pumpkin carves into: its size and tint kept, unlit. */
  carved(slot) {
    if (slot.kind !== KIND) throw new Error(`Pumpkins.carved: a ${slot.kind} is not carved`)
    return { ...slot, kind: LANTERN, name: "jack-o'-lantern", lit: false }
  }

  setShown(shown) { this.mesh.visible = shown }

  get stats() { return { spots: this.spots.length, shown: this.shown.length, taken: this.spots.filter((s) => s.gone).length } }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    for (const g of [this.geometry, this.heldGeometry, this.lanternGeometry]) g.dispose()
    this.material.dispose()
    this.lanternMaterial.dispose()
  }
}
