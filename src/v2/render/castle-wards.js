// The wards, their anchor gems and the runebooks of a castle (design/46-castle-wards.md), built on the main thread from the worker's
// portals: indoors a child of the interior mesh, in interior metres; the tower tops' books a set of their own on the exterior.
import THREE from '../../three-instance.js'
import { RUNES } from '../castles/wards.js'

export const WARD_LOOK = {
  tint: [0.42, 0.78, 1.0], deep: [0.5, 0.22, 1.0],
  gem: 0.085, grab: 0.24, bob: 0.04,
  book: [0.5, 0.36], open: 1.4, fail: 0.9, spend: 1.2,
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
// Near opaque, so from her side the room beyond (and from the blocked side the gem) shows only faintly. uFade dissolves it through
// its own noise; uFlash whitens it.
const FRAG = /* glsl */ `
uniform float uTime, uFade, uFlash, uSeed;
uniform vec3 uTint, uDeep;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 p = vUv * vec2(2.0, 4.0) + uSeed;
  float n = noise(p * 2.0 + vec2(0.0, uTime * 0.5)) * 0.6 + noise(p * 5.0 - vec2(uTime * 0.35, uTime * 0.2)) * 0.4;
  float band = 0.5 + 0.5 * sin(vUv.y * 9.0 + n * 5.0 - uTime * 1.6);
  float rim = smoothstep(0.38, 0.5, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)));
  float pulse = 0.78 + 0.22 * sin(uTime * 2.1 + uSeed * 6.0);
  vec3 c = mix(uDeep, uTint, band) * (0.3 + 0.7 * n) * pulse + uTint * rim * 0.7;
  float keep = smoothstep(uFade - 0.04, uFade + 0.04, n);
  float edge = keep * (1.0 - smoothstep(0.0, 0.08, n - uFade)) * step(0.001, uFade);
  gl_FragColor = vec4(c * (0.55 + 0.45 * band) + uTint * edge * 2.0 + vec3(uFlash), keep * (0.8 + 0.18 * band));
}
`

function glowMaterial(seed, blending) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uFlash: { value: 0 }, uSeed: { value: seed }, uTint: { value: new THREE.Color(...WARD_LOOK.tint) }, uDeep: { value: new THREE.Color(...WARD_LOOK.deep) } },
    transparent: true, blending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  })
}

function haloTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(160,210,255,0.6)'); r.addColorStop(1, 'rgba(80,60,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

/** Three rune cells of the atlas side by side, `w` wide, centred. */
function runeStrip(code, w) {
  const h = w / 3, pos = [], uv = [], idx = []
  code.forEach((r, i) => {
    const x0 = -w / 2 + i * h, u0 = r / RUNES.length, u1 = (r + 1) / RUNES.length
    pos.push(x0, -h / 2, 0, x0 + h, -h / 2, 0, x0 + h, h / 2, 0, x0, h / 2, 0)
    uv.push(u0, 0, u1, 0, u1, 1, u0, 1)
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 3, i * 4)
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  return geo
}

const BURST = 90

export class WardSet {
  /** `P` the castle's portals, `runes` the rune atlas texture or null until setRunes, `open` and `spent` bitmasks of wards opened and books used. `roof`: draw the tower tops' books rather than the rooms'. */
  constructor(P, runes, open, spent, roof = false) {
    this.group = new THREE.Group()
    this.group.name = 'qa-castle-wards'
    this.halo = haloTexture()
    this.runeMat = new THREE.MeshBasicMaterial({ map: runes, visible: runes !== null, color: 0x000000, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    this.gemGeo = new THREE.OctahedronGeometry(WARD_LOOK.gem, 0).scale(1, 1.7, 1)
    this.gemMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...WARD_LOOK.tint).multiplyScalar(1.6), toneMapped: false })
    this.haloMat = new THREE.SpriteMaterial({ map: this.halo, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, color: new THREE.Color(...WARD_LOOK.tint) })
    this.wards = P.wards.map((w, i) => {
      const g = new THREE.Group(), mat = glowMaterial(i * 0.37 + 0.1, THREE.NormalBlending)
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(2 * w.hw + 0.08, w.h + 0.04), mat)
      sheet.position.set(w.x, w.y + w.h / 2, w.z)
      sheet.rotation.y = Math.atan2(w.nx, w.nz)
      sheet.name = 'qa-ward-sheet'
      const gem = new THREE.Mesh(this.gemGeo, this.gemMat), halo = new THREE.Sprite(this.haloMat)
      halo.scale.setScalar(0.45)
      gem.add(halo)
      gem.position.set(...w.gem)
      gem.name = 'qa-ward-gem'
      g.add(sheet, gem)
      this.group.add(g)
      const shut = !(open & (1 << i))
      g.visible = shut
      return { g, sheet, gem, mat, at: w.gem.slice(), nx: w.nx, nz: w.nz, shut, fade: shut ? 0 : 1, opening: false, flash: 0 }
    })
    this.books = P.books.map((b, j) => {
      const g = new THREE.Group(), mat = glowMaterial(j * 0.53 + 2.1, THREE.NormalBlending), [W, D] = WARD_LOOK.book
      const tilt = new THREE.Group()
      for (const s of [-1, 1]) {
        const page = new THREE.Mesh(new THREE.PlaneGeometry(W / 2, D).translate(s * W / 4, 0, 0), mat)
        page.rotation.y = -s * 0.22
        tilt.add(page)
      }
      const strip = new THREE.Mesh(runeStrip(b.code, W * 0.92), this.runeMat)
      strip.position.z = 0.035
      strip.renderOrder = 1
      strip.name = 'qa-book-runes'
      tilt.add(strip)
      tilt.rotation.x = -0.5
      g.add(tilt)
      g.position.set(...b.at)
      g.name = 'qa-runebook'
      this.group.add(g)
      const live = !(spent & (1 << j))
      g.visible = live && b.roof === roof
      return { g, mat, strip, at: b.at.slice(), code: b.code.slice(), live, fade: live ? 0 : 1, going: false }
    })
    const bp = new Float32Array(BURST * 3)
    this.burstGeo = new THREE.BufferGeometry()
    this.burstGeo.setAttribute('position', new THREE.BufferAttribute(bp, 3))
    this.burstMat = new THREE.PointsMaterial({ map: this.halo, size: 0.09, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color(...WARD_LOOK.tint), toneMapped: false })
    this.burstPts = new THREE.Points(this.burstGeo, this.burstMat)
    this.burstPts.visible = false
    this.burstPts.frustumCulled = false
    this.group.add(this.burstPts)
    this.burst = null
  }

  /** The rune atlas, for a set built before the far cards were baked: without it the pages are blank rather than black. */
  setRunes(runes) {
    this.runeMat.map = runes
    this.runeMat.visible = true
    this.runeMat.needsUpdate = true
  }

  /** Each frame: `t` seconds, `dt` the step, `eye` her eye in the set's frame (books turn to face it). */
  update(t, dt, eye) {
    for (const w of this.wards) {
      if (!w.g.visible) continue
      w.mat.uniforms.uTime.value = t % 512
      if (w.opening) {
        w.fade = Math.min(1, w.fade + dt / WARD_LOOK.open)
        w.gem.scale.setScalar(Math.max(0.01, 1 - w.fade * 1.6))
        if (w.fade >= 1) w.g.visible = false
      }
      w.flash = Math.max(0, w.flash - dt / WARD_LOOK.fail * 1.5)
      w.mat.uniforms.uFade.value = w.fade
      w.mat.uniforms.uFlash.value = w.flash * (0.6 + 0.4 * Math.sin(t * 60))
      w.gem.position.y = w.at[1] + Math.sin(t * 1.7) * WARD_LOOK.bob
      w.gem.rotation.y = t * 0.9
    }
    this.books.forEach((b, j) => {
      if (!b.g.visible) return
      b.mat.uniforms.uTime.value = t % 512
      if (b.going) {
        b.fade = Math.min(1, b.fade + dt / WARD_LOOK.spend)
        b.strip.visible = b.fade < 0.5
        if (b.fade >= 1) b.g.visible = false
      }
      b.mat.uniforms.uFade.value = b.fade
      b.g.position.y = b.at[1] + Math.sin(t * 1.3 + j) * WARD_LOOK.bob
      if (eye) b.g.rotation.y = Math.atan2(eye.x - b.at[0], eye.z - b.at[2])
    })
    if (this.burst !== null) {
      const B = this.burst, p = this.burstGeo.getAttribute('position')
      B.age += dt
      for (let k = 0; k < BURST; k++) {
        B.v[k * 3 + 1] -= 2.5 * dt
        for (let a = 0; a < 3; a++) p.array[k * 3 + a] += B.v[k * 3 + a] * dt
      }
      p.needsUpdate = true
      this.burstMat.opacity = Math.max(0, 1 - B.age / WARD_LOOK.fail)
      if (B.age >= WARD_LOOK.fail) { this.burst = null; this.burstPts.visible = false }
    }
  }

  /** The shut ward whose gem the ray from `o` along unit `d` (interior frame) passes within WARD_LOOK.grab of inside `maxDist`, or -1.
   * Only from the gem's side of its membrane: the search that plans the wards assumes she cannot open one from beyond it. */
  gemOn(o, d, maxDist) {
    let best = -1, bestT = maxDist
    this.wards.forEach((w, i) => {
      if (!w.shut || (o.x - w.sheet.position.x) * w.nx + (o.z - w.sheet.position.z) * w.nz <= 0) return
      const [x, y, z] = [w.gem.position.x - o.x, w.gem.position.y - o.y, w.gem.position.z - o.z], t = x * d.x + y * d.y + z * d.z
      if (t < 0 || t > bestT) return
      if (Math.hypot(x - d.x * t, y - d.y * t, z - d.z * t) < WARD_LOOK.grab) { best = i; bestT = t }
    })
    return best
  }

  /** The shut ward whose membrane is nearest `eye` (interior frame): `{ d, at }`, its distance and the nearest point on the sheet, or null when none is shut. */
  nearestShut(eye) {
    let best = null
    for (const w of this.wards) {
      if (!w.shut) continue
      const { x, y, z } = w.sheet.position, a = w.sheet.rotation.y, { width, height } = w.sheet.geometry.parameters
      const along = Math.max(-width / 2, Math.min(width / 2, (eye.x - x) * Math.cos(a) - (eye.z - z) * Math.sin(a)))
      const up = Math.max(-height / 2, Math.min(height / 2, eye.y - y))
      const px = x + along * Math.cos(a), py = y + up, pz = z - along * Math.sin(a), d = Math.hypot(eye.x - px, eye.y - py, eye.z - pz)
      if (best === null || d < best.d) best = { d, at: [px, py, pz] }
    }
    return best
  }

  /** Ward `i`'s gem, interior frame. */
  gemAt(i) { return this.wards[i].gem.position }

  /** Ward `i` dissolves; book `j` (whose code opened it) fades. */
  open(i, j) {
    const w = this.wards[i], b = this.books[j]
    if (!w.shut || !b.live) throw new Error(`WardSet: opening ward ${i} with book ${j}, one already spent`)
    w.shut = false; w.opening = true
    b.live = false; b.going = true
  }

  /** Wards `open` and books `spent` (bitmasks) that someone else opened or spent since: each dissolves or fades as if opened here. */
  catchUp(open, spent) {
    this.wards.forEach((w, i) => { if (w.shut && open & (1 << i)) { w.shut = false; w.opening = true } })
    this.books.forEach((b, j) => { if (b.live && spent & (1 << j)) { b.live = false; b.going = true } })
  }

  /** Ward `i` shimmers and bursts at its gem. */
  fail(i) {
    const w = this.wards[i]
    w.flash = 1
    const p = this.burstGeo.getAttribute('position'), v = new Float32Array(BURST * 3)
    for (let k = 0; k < BURST; k++) {
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = 1.5 + Math.random() * 2.5, r = Math.sqrt(1 - u * u)
      v.set([Math.cos(a) * r * s, u * s + 1, Math.sin(a) * r * s], k * 3)
      p.array.set([w.gem.position.x, w.gem.position.y, w.gem.position.z], k * 3)
    }
    p.needsUpdate = true
    this.burst = { age: 0, v }
    this.burstPts.visible = true
  }

  dispose() {
    for (const w of this.wards) { w.sheet.geometry.dispose(); w.mat.dispose() }
    for (const b of this.books) { b.mat.dispose(); b.g.traverse((o) => { if (o.geometry) o.geometry.dispose() }) }
    for (const x of [this.gemGeo, this.gemMat, this.haloMat, this.runeMat, this.halo, this.burstGeo, this.burstMat]) x.dispose()
  }
}
