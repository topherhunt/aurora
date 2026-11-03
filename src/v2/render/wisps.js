// Will-o'-wisps: after dark, outdoors, a few lights that wait ahead of her on the way to the nearest hideout whose skeleton is not
// hers yet, and drift on each time she catches up (design/45-bone-friends.md §Wisps).
// The vertex shader places them: the CPU writes the travel segment and the ground under it only when the waypoint changes, and the
// clock uniforms every frame. Orbit and bob run on a clock wrapped at PERIOD_S, so their rates are whole cycles per PERIOD_S.

import THREE from '../../three-instance.js'

export const WISP = {
  count: 3,
  // A hideout within `nearM` of her and further than `arriveM` draws them; past `dayness` they are gone.
  nearM: 220,
  arriveM: 8,
  dayness: 0.25,
  // Their waypoint, `aheadM` before her when they first show; she within `waitM` of it, it moves `hopM` on. She `strayM` off, it starts again before her.
  aheadM: 12,
  waitM: 5,
  hopM: 14,
  strayM: 40,
  speedMps: 3.5,
  hoverM: 1.3,
  fadeS: 1.5,
  sizeM: 0.45,
}

export const PERIOD_S = 1024
const TAU = Math.PI * 2
const snap = (w) => Math.round((w * PERIOD_S) / TAU) * (TAU / PERIOD_S)
// Each wisp circles its waypoint (radius ORBIT_M), bobs BOB_M and pulses its size by PULSE; i staggers them.
const ORBIT_M = 0.7
const BOB_M = 0.25
const PULSE = 0.2
const BOB_W = snap(1.7)
const PULSE_W = snap(9)
const orbitOf = (i) => {
  const w = 0.7 + 0.23 * i
  return [snap(w), i * 2.1, snap(w * 1.3), i * 2.1 * 1.3]
}

const num = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x))

/** Position and size of wisp i: its travel segment `seg` run to `clock`, its orbit and bob run to `now`. Twin of WISP_POSE_GLSL. */
export function wispPose(i, seg, now, clock) {
  const [wa, pa, wb, pb] = orbitOf(i)
  let d = clock - seg.t0
  if (d < 0) d += PERIOD_S
  const run = Math.min(seg.dist, WISP.speedMps * d)
  const u = seg.dist > 0 ? run / seg.dist : 0
  const [g0, g1, g2] = seg.ground
  const g = g0 * 2 * (u - 0.5) * (u - 1) - g1 * 4 * u * (u - 1) + g2 * 2 * u * (u - 0.5)
  return {
    x: seg.fromX + seg.dirX * run + Math.cos(wa * now + pa) * ORBIT_M,
    y: g + WISP.hoverM + Math.sin(BOB_W * now + 1.9 * i) * BOB_M,
    z: seg.fromZ + seg.dirZ * run + Math.sin(wb * now + pb) * ORBIT_M,
    size: WISP.sizeM * (1 - PULSE + PULSE * Math.sin(PULSE_W * now + 4 * i)),
  }
}

// seg.x/y = from x/z, seg.z/w = unit direction; segB.x = distance, segB.y = start clock; ground = height at the segment's start, middle, end.
export const WISP_POSE_GLSL = /* glsl */ `
  vec4 wispPose( float i, vec4 orbit, vec4 seg, vec2 segB, vec3 ground, float now, float clock ) {
    float d = clock - segB.y;
    if ( d < 0.0 ) d += ${num(PERIOD_S)};
    float run = min( segB.x, ${num(WISP.speedMps)} * d );
    float u = segB.x > 0.0 ? run / segB.x : 0.0;
    float g = ground.x * 2.0 * ( u - 0.5 ) * ( u - 1.0 ) - ground.y * 4.0 * u * ( u - 1.0 ) + ground.z * 2.0 * u * ( u - 0.5 );
    vec2 at = seg.xy + seg.zw * run;
    return vec4(
      at.x + cos( orbit.x * now + orbit.y ) * ${num(ORBIT_M)},
      g + ${num(WISP.hoverM)} + sin( ${BOB_W} * now + 1.9 * i ) * ${num(BOB_M)},
      at.y + sin( orbit.z * now + orbit.w ) * ${num(ORBIT_M)},
      ${num(WISP.sizeM)} * ( ${num(1 - PULSE)} + ${num(PULSE)} * sin( ${PULSE_W} * now + 4.0 * i ) )
    );
  }
`

const VERT = /* glsl */ `
  attribute vec4 aOrbit;
  attribute float aIdx;
  uniform vec4 uSeg;
  uniform vec2 uSegB;
  uniform vec3 uGround;
  uniform float uNow, uClock;
  varying vec2 vUv;
  ${WISP_POSE_GLSL}
  void main() {
    vec4 w = wispPose( aIdx, aOrbit, uSeg, uSegB, uGround, uNow, uClock );
    // A sprite: the quad is laid in view space, so each eye of a stereo pair faces it squarely.
    vec4 mv = modelViewMatrix * vec4( w.xyz, 1.0 );
    mv.xy += position.xy * w.w;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy + 0.5;
  }
`

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4( uColor, uOpacity ) * texture2D( uMap, vUv );
    #include <colorspace_fragment>
  }
`

/** A soft round glow, white at the centre to clear at the rim. */
function glowTexture(n = 32) {
  const data = new Uint8Array(n * n * 4)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const r = Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) / (n / 2)
    const a = Math.max(0, 1 - r) ** 2
    data.set([255, 255, 255, Math.round(a * 255)], (j * n + i) * 4)
  }
  const t = new THREE.DataTexture(data, n, n)
  t.needsUpdate = true
  return t
}

export class Wisps {
  constructor(scene) {
    this.group = new THREE.Group()
    this.group.name = 'v2-wisps'
    scene.add(this.group)
    this.texture = glowTexture()
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: this.texture },
        uColor: { value: new THREE.Vector3(0.6, 1, 0.85) },
        uOpacity: { value: 0 },
        uNow: { value: 0 },
        uClock: { value: 0 },
        uSeg: { value: new THREE.Vector4() },
        uSegB: { value: new THREE.Vector2() },
        uGround: { value: new THREE.Vector3() },
      },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    const orbit = new Float32Array(WISP.count * 4)
    for (let i = 0; i < WISP.count; i++) orbit.set(orbitOf(i), i * 4)
    geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4))
    geo.setAttribute('aIdx', new THREE.InstancedBufferAttribute(Float32Array.from({ length: WISP.count }, (_, i) => i), 1))
    this.mesh = new THREE.InstancedMesh(geo, this.material, WISP.count)
    this.mesh.name = 'v2-wisps'
    this.mesh.frustumCulled = false
    this.group.add(this.mesh)
    this.target = null
    this.anchor = null
    // Their own clock, summed from dt, so the travel never runs backwards with the caller's.
    this.clock = 0
    this.seg = null
    this.startAt = 0
    this.arriveAt = 0
    this.alpha = 0
    this.group.visible = false
  }

  /**
   * One frame. `places` the hideouts `{ key, x, z }` whose skeleton is not hers yet; `heightAt(x, z)` the overworld's ground.
   * `outdoors` false (a cave, a castle, a house) hides them at once.
   */
  update(dt, now, feet, { dayness, outdoors, places, heightAt }) {
    this.clock += dt
    let target = null, best = WISP.nearM
    if (outdoors && dayness < WISP.dayness) {
      for (const p of places) {
        const d = Math.hypot(p.x - feet.x, p.z - feet.z)
        if (d < best && d > WISP.arriveM) { best = d; target = p }
      }
    }
    if (!outdoors) this.alpha = 0
    if (target !== null && (this.target === null || target.key !== this.target.key)) this.anchor = null
    if (target !== null) this.target = target
    this.alpha = Math.max(0, Math.min(1, this.alpha + (target !== null ? dt : -dt) / WISP.fadeS))
    this.group.visible = this.alpha > 0
    if (!this.group.visible) { this.target = null; this.anchor = null; return }
    const t = this.target
    if (this.anchor === null || Math.hypot(this.anchor.x - feet.x, this.anchor.z - feet.z) > WISP.strayM) {
      this.anchor = this._toward(feet, t, WISP.aheadM)
      this._go(this.anchor, this.anchor, heightAt)
    } else if (Math.hypot(this.anchor.x - feet.x, this.anchor.z - feet.z) < WISP.waitM) {
      const hop = this._toward(this.anchor, t, WISP.hopM)
      if (hop.x !== this.anchor.x || hop.z !== this.anchor.z) {
        const from = this._at()
        this.anchor = hop
        this._go(from, hop, heightAt)
      }
    } else if (this.seg.dist > 0 && this.clock >= this.arriveAt) {
      // Parked: a stale segment would run again when the wrapped clock comes round.
      const g = this.seg.ground[2]
      this._set({ fromX: this.anchor.x, fromZ: this.anchor.z, dirX: 0, dirZ: 0, dist: 0, ground: [g, g, g] })
    }
    const night = Math.min(1, (WISP.dayness - dayness) / WISP.dayness * 2)
    const u = this.material.uniforms
    u.uOpacity.value = this.alpha * Math.max(0, night)
    u.uNow.value = now % PERIOD_S
    u.uClock.value = this.clock % PERIOD_S
  }

  /** Start a segment from `from` to `to` now, with the ground read at its start, middle and end: the only ground reads the wisps make. */
  _go(from, to, heightAt) {
    const dx = to.x - from.x, dz = to.z - from.z, dist = Math.hypot(dx, dz)
    const ground = dist > 0
      ? [heightAt(from.x, from.z), heightAt(from.x + dx / 2, from.z + dz / 2), heightAt(to.x, to.z)]
      : Array(3).fill(heightAt(to.x, to.z))
    this._set({ fromX: from.x, fromZ: from.z, dirX: dist > 0 ? dx / dist : 0, dirZ: dist > 0 ? dz / dist : 0, dist, ground })
  }

  _set(seg) {
    seg.t0 = this.clock % PERIOD_S
    this.seg = seg
    this.startAt = this.clock
    this.arriveAt = this.clock + seg.dist / WISP.speedMps
    const u = this.material.uniforms
    u.uSeg.value.set(seg.fromX, seg.fromZ, seg.dirX, seg.dirZ)
    u.uSegB.value.set(seg.dist, seg.t0)
    u.uGround.value.set(...seg.ground)
  }

  /** Where the waypoint-follower is now, on the segment. */
  _at() {
    const run = Math.min(this.seg.dist, WISP.speedMps * (this.clock - this.startAt))
    return { x: this.seg.fromX + this.seg.dirX * run, z: this.seg.fromZ + this.seg.dirZ * run }
  }

  /** `m` on from `from` toward `t`, never past it. */
  _toward(from, t, m) {
    const dx = t.x - from.x, dz = t.z - from.z, d = Math.hypot(dx, dz)
    if (d <= m) return { x: t.x, z: t.z }
    return { x: from.x + (dx / d) * m, z: from.z + (dz / d) * m }
  }

  get stats() {
    return { target: this.target && this.target.key, alpha: this.alpha, at: this.anchor && this._at() }
  }

  dispose() {
    this.group.removeFromParent()
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}
