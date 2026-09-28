import * as THREE from 'three'

// What her health and sleep look like from inside her head (design/33-vitals.md),
// all on the camera so it holds in the headset: a veil over the whole view (the
// red of a wound, the lids of sleep, the black of death), the health donut in
// the bottom-left, "Game saved" and the death card. Drawn after everything,
// the room swap's blackout (renderOrder 1e6) included.
const ORDER = 1e6 + 1
// Seconds for the view to go black on dying, and to come back on revival.
const DIE_S = 1.5
const REVIVE_S = 1
const SAVED_S = 3
const SAVED_FADE_S = 0.6
// The heartbeat's period at half health and at death.
const BEAT_S = [1.3, 0.75]

const veilVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

// vDir is in the camera's frame, so the lids close along the view's own up and
// down in either eye; s is the direction's place on a screen one metre out.
const veilFrag = /* glsl */ `
uniform float uHurt;
uniform float uPulse;
uniform float uLid;
uniform float uBlack;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec2 s = d.xy / max(-d.z, 0.05);
  float edge = smoothstep(0.1, 1.1, length(s));
  float red = uHurt * (0.25 + 0.5 * edge) * (0.75 + 0.25 * uPulse);
  float open = (1.0 - uLid) * 1.25 * (1.0 - 0.18 * s.x * s.x);
  float lids = max(smoothstep(open - 0.12, open, abs(s.y)), smoothstep(0.85, 1.0, uLid)) * step(0.001, uLid);
  float black = max(lids, uBlack);
  vec3 tint = mix(vec3(0.75, 0.02, 0.02), vec3(0.28, 0.0, 0.01), uHurt);
  float a = black + red * (1.0 - black);
  gl_FragColor = vec4(a > 0.0 ? tint * red * (1.0 - black) / a : vec3(0.0), a);
}`

const donutVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

// Filled clockwise from the top by the health left, red through to green.
const donutFrag = /* glsl */ `
uniform float uFrac;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ring = smoothstep(0.56, 0.6, r) * (1.0 - smoothstep(0.95, 0.99, r));
  float a = atan(p.x, p.y);
  float t = (a < 0.0 ? a + 6.2831853 : a) / 6.2831853;
  float filled = step(t, uFrac);
  vec3 full = mix(vec3(0.9, 0.15, 0.1), vec3(0.35, 0.85, 0.4), smoothstep(0.25, 0.75, uFrac));
  vec3 col = mix(vec3(0.12), full, filled);
  gl_FragColor = vec4(col, ring * mix(0.45, 0.9, filled) * uOpacity);
}`

function overlay(mesh, order) {
  mesh.renderOrder = order
  mesh.frustumCulled = false
  mesh.visible = false
  return mesh
}

function textPlane(w, h, px) {
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = Math.round((px * h) / w)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false, toneMapped: false }),
  )
  return { mesh, canvas, tex }
}

/** A lub-dub, synthesized: two thumps of a falling sine, the second softer. */
export function heartbeatBuffer(ctx) {
  const rate = ctx.sampleRate
  const buf = ctx.createBuffer(1, Math.round(rate * 0.6), rate)
  const out = buf.getChannelData(0)
  for (const [at, amp] of [[0, 1], [0.26, 0.7]]) {
    let phase = 0
    for (let i = Math.round(at * rate); i < out.length; i++) {
      const t = i / rate - at
      phase += (2 * Math.PI * (38 + 30 * Math.exp(-t / 0.05))) / rate
      out[i] += amp * Math.min(1, t / 0.005) * Math.exp(-t / 0.07) * Math.sin(phase)
    }
  }
  return buf
}

export class VitalsHud {
  constructor(camera) {
    this.veil = overlay(new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 24, 16),
      new THREE.ShaderMaterial({
        uniforms: { uHurt: { value: 0 }, uPulse: { value: 0 }, uLid: { value: 0 }, uBlack: { value: 0 } },
        vertexShader: veilVert, fragmentShader: veilFrag,
        side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false,
      }),
    ), ORDER)
    this.donut = overlay(new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uFrac: { value: 1 }, uOpacity: { value: 0 } },
        vertexShader: donutVert, fragmentShader: donutFrag,
        transparent: true, depthTest: false, depthWrite: false,
      }),
    ), ORDER + 1)
    this.saved = textPlane(0.36, 0.09, 512)
    overlay(this.saved.mesh, ORDER + 2).position.set(0, 0, -0.8)
    const g = this.saved.canvas.getContext('2d')
    g.font = '600 64px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = '#fff'
    g.fillText('Game saved', this.saved.canvas.width / 2, this.saved.canvas.height / 2)
    this.saved.tex.needsUpdate = true
    this.card = textPlane(0.6, 0.3, 1024)
    overlay(this.card.mesh, ORDER + 2).position.set(0, 0.02, -0.8)
    for (const m of [this.veil, this.donut, this.saved.mesh, this.card.mesh]) camera.add(m)
    this.black = 0
    this.savedT = -1
    this.beatT = 0
    this.pulse = 0
  }

  /** The donut in the bottom-left: of the desktop's frustum, or at a fixed glance down and left in the headset. */
  place(xr, fovDeg, aspect) {
    const d = 0.8
    if (xr) {
      this.donut.scale.setScalar(0.07)
      this.donut.position.set(-0.24, -0.22, -d)
      return
    }
    const halfH = d * Math.tan((fovDeg * Math.PI) / 360), halfW = halfH * aspect
    const size = 0.22 * halfH
    this.donut.scale.setScalar(size)
    this.donut.position.set(-halfW + size, -halfH + size, -d)
  }

  /** "Game saved", in and out over SAVED_S. */
  showSaved() {
    this.savedT = 0
  }

  /** The death card: `lines` under "You died", or nothing more when the page's buttons carry the choice. */
  showDeath(lines) {
    const { canvas, tex } = this.card
    const g = canvas.getContext('2d')
    g.clearRect(0, 0, canvas.width, canvas.height)
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = '#fff'
    g.font = '600 120px system-ui, sans-serif'
    g.fillText('You died', canvas.width / 2, lines.length === 0 ? canvas.height / 2 : 140)
    g.font = '52px system-ui, sans-serif'
    lines.forEach((line, i) => g.fillText(line, canvas.width / 2, 300 + i * 80))
    tex.needsUpdate = true
  }

  /**
   * One frame. `hp` of `max`, `hurt` 0..1 (vitals.js Health), `lid` 0..1
   * (Sleep), `dead`, and whether the death `card` may show once the view has
   * gone wholly black (then `deathShown`). True on the frame a heartbeat is due.
   */
  update(dt, { hp, max, hurt, lid, dead, card }) {
    this.black = Math.max(0, Math.min(1, this.black + (dead ? dt / DIE_S : -dt / REVIVE_S)))
    this.deathShown = dead && this.black === 1
    let beat = false
    if (hurt > 0 && !dead && lid === 0) {
      this.beatT += dt
      if (this.beatT >= BEAT_S[0] + (BEAT_S[1] - BEAT_S[0]) * hurt) {
        this.beatT = 0
        beat = true
      }
    } else this.beatT = 0
    this.pulse = beat ? 1 : this.pulse * Math.exp(-dt / 0.25)

    const u = this.veil.material.uniforms
    u.uHurt.value = hurt
    u.uPulse.value = this.pulse
    u.uLid.value = lid
    u.uBlack.value = this.black
    this.veil.visible = hurt > 0 || lid > 0 || this.black > 0

    const d = this.donut.material.uniforms
    d.uFrac.value = hp / max
    d.uOpacity.value = Math.max(0, Math.min(1, d.uOpacity.value + (hp < max && !dead && lid === 0 ? dt : -dt) / 0.4))
    this.donut.visible = d.uOpacity.value > 0

    if (this.savedT >= 0) {
      this.savedT += dt
      const t = this.savedT
      this.saved.mesh.material.opacity = Math.max(0, Math.min(1, t / SAVED_FADE_S, (SAVED_S - t) / SAVED_FADE_S))
      if (t >= SAVED_S) this.savedT = -1
    }
    this.saved.mesh.visible = this.savedT >= 0
    this.card.mesh.material.opacity = 1
    this.card.mesh.visible = card && this.deathShown
    return beat
  }
}
