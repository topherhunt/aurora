// The sited castles (design/44-castles.md, Tiers): a crossed far card per site, then the worker's full or mid-distance exterior and
// its court near by, and the exterior as stone. A castle's interior is set down CASTLE_RISE over it while she is inside, as its own
// stone (CastleInteriorStone) under her own walk; main.js swaps walks. Portals: `portalAt`.
import THREE from '../../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../../sim/mathx.js'
import { castleLayout, CASTLE } from '../castles/layout.js'
import { courtGeometry, exteriorGeometry, toGeometry, UV_METRES } from '../castles/shell.js'
import { exteriorSpans, interiorSpans, onFlight, spiralTreadAt, SPANS } from '../castles/solids.js'
import { castleExtents, toLocal } from '../layers/castles.js'
import { TriFlames, TRI_TORCH } from './fire-tris.js'
import { downsample, flipY, dilate, SUPERSAMPLE } from '../../props/impostor.js'
import { HELD_TORCH, HELD_TORCH_GLSL, skyThroughGlass } from './interior.js'
import { leadedTexture } from './town-interior.js'
import { GLASS } from '../castles/light.js'
import { TORCHES } from '../../lighting.js'
import { WorldProbe, WORLD_PROBE } from '../../world-probe.js'
import { WATER, RIPPLE_GLSL } from '../../water.js'

// Metres from the site: built within `build`, dropped past `drop`; its meshes drawn within `mesh` (the card past it), the full
// exterior within `full` and the mid-distance one past `low`.
export const CASTLE_BANDS = { build: 220, drop: 260, mesh: 200, full: 50, low: 55 }
// The far card: baked off seed `seed`'s castle from the front (its gate's side), scaled to each site's size.
export const CASTLE_CARD = { seed: 3, size: 512, bottom: -3 }
// How far over its site a castle's interior is set down.
export const CASTLE_RISE = 320
// The texture of each shell.js material slot.
export const MAP_KEYS = ['stone', 'plank', 'door', 'gate', 'thatch', 'leaded', 'cloth']
// Plan metres round a rope, a hatch or a ladder where each fires, and how near her feet must be to its height. The rope hangs a
// metre off the lookout's face, past its 1.3 m battlement band, which she cannot step onto: she takes it over the band. A door
// fires within `door` of its leaves' face, which is solid, so touching them is going through.
const ZONE = { rope: 2.2, hatch: 0.6, ladder: 0.7, door: 0.5, rise: 0.6 }
// The summit rope (render/castles.js ropeMeshes): coiled on the roof `back` m in from where it hangs until she clicks it (ropeOn),
// then hanging from `lift` over the roof to the foot of the face. A ray within `grab` of the coil or the hanging top takes it.
const ROPE = { r: 0.017, sides: 7, coil: 0.22, rings: 6, back: 2.2, lift: 0.45, grab: 0.35 }
// How square to the rope she must walk at it, as the cosine of her step on its way out.
const ROPE_INTO = 0.6
// The interior's light (castles/light.js channels): fill, firelight and the window light the hour gives, as colours.
export const INNER_LIGHT = { fill: [0.75, 0.85, 1], fire: [1, 0.72, 0.45], win: 0.9 }
// How far from her eye (m) the dungeon's water must be for its probe to capture.
const MIRROR_REACH = 30

const INNER_VERT = /* glsl */ `
attribute vec3 light;
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vLight;
varying vec3 vPos;
varying vec3 vNrm;
void main() {
  vUv = uv;
  vCol = color;
  vLight = light;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  vNrm = mat3(modelMatrix) * normal;
  gl_Position = projectionMatrix * viewMatrix * w;
}`
// Glass (a window channel past GLASS) shows its leading lit by the sky alone.
const INNER_FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 uFill;
uniform vec3 uFire;
uniform float uWin;
uniform vec3 uSky;
uniform float uFlicker;
uniform vec4 uTorch[${TORCHES}];
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vLight;
varying vec3 vPos;
varying vec3 vNrm;
${HELD_TORCH_GLSL}
void main() {
  vec3 c;
  if (vLight.z > ${GLASS.toFixed(2)}) c = texture2D(map, vUv).rgb * vCol * (uSky * vLight.z * uWin + 0.06 * uFill);
  else {
    vec3 lit = uFill * vLight.x + uFire * vLight.y * uFlicker + uSky * vLight.z * uWin;
    lit += heldTorch(vPos, normalize(vNrm)) * vec3(${HELD_TORCH.color.map((v) => v.toFixed(2)).join(', ')});
    c = texture2D(map, vUv).rgb * vCol * lit;
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`
const WATER_VERT = /* glsl */ `
attribute vec3 light;
varying vec3 vLight;
varying vec3 vPos;
void main() {
  vLight = light;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`
// The cave water's (render/cave-room.js) in the dungeon: water.js's ripple, its body tint in the baked light, the probe's two cubes
// cross-faded by Fresnel, the held torch's glint, and water.js's clarity looking down.
const WATER_FRAG = /* glsl */ `
${RIPPLE_GLSL}
uniform samplerCube uMirrorA;
uniform samplerCube uMirrorB;
uniform float uMirrorFade;
uniform vec3 uTint;
uniform vec3 uReflTint;
uniform float uMirrorDown;
uniform vec2 uClarity;
uniform vec3 uFill;
uniform vec3 uFire;
uniform float uFlicker;
uniform vec4 uTorch[${TORCHES}];
varying vec3 vLight;
varying vec3 vPos;
${HELD_TORCH_GLSL}
void main() {
  vec3 n = rippleNormal(vPos.xz);
  vec3 v = normalize(vPos - cameraPosition);
  vec3 torch = vec3(${HELD_TORCH.color.map((x) => x.toFixed(2)).join(', ')});
  vec3 body = uTint * (uFill * vLight.x + uFire * vLight.y * uFlicker + heldTorch(vPos, n) * torch);
  vec3 r = reflect(v, n);
  if (r.y < 0.0) r.y = -r.y;
  vec3 refl = mix(texture(uMirrorA, r).rgb, texture(uMirrorB, r).rgb, uMirrorFade) * uReflTint;
  for (int i = 0; i < ${TORCHES}; i++) {
    float s = uTorch[i].w;
    if (s <= 0.0) continue;
    vec3 l = uTorch[i].xyz - vPos;
    refl += torch * s * pow(max(dot(r, normalize(l)), 0.0), 120.0) * 3.0 / (1.0 + 0.05 * dot(l, l));
  }
  float f = pow(1.0 - clamp(dot(-v, n), 0.0, 1.0), 5.0);
  vec3 c = mix(body, refl, mix(uMirrorDown, 1.0, f));
  float alpha = 1.0 - uClarity.x * smoothstep(uClarity.y, 1.0, -v.y);
  gl_FragColor = vec4(c / alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

const loadTile = (path, metres, done) => {
  const t = new THREE.TextureLoader().load(path, done, undefined, () => { throw new Error(`Castles: ${path} failed to load`) })
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  t.repeat.setScalar(UV_METRES / metres)
  return t
}
const tmpBox = new THREE.Box3()
const tmpV = new THREE.Vector3()
// Castle-local direction to world (layers/castles.js toWorld's turn).
const turn = (s, u, v) => [u * Math.cos(s.yaw) + v * Math.sin(s.yaw), -u * Math.sin(s.yaw) + v * Math.cos(s.yaw)]

// The court's baked firelight (castles/glow.js, the `light` attribute's x) added to a Lambert material, `uGlow` its colour by the hour.
// Set before lighting.js's patch, which chains it.
function glowed(material, uGlow) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCastleGlow = uGlow
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 light;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = light.x;')
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform vec3 uCastleGlow;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse += diffuseColor.rgb * uCastleGlow * vGlow;')
  }
  return material
}

// TriFlames draws in world coordinates: castle-local flames (x, y, z, height, radius) turned and set down at foot height `y0`.
function flamesOf(site, list, y0) {
  const n = list.length / 5
  if (n === 0) return null
  const f = new TriFlames(n, TRI_TORCH, { seed: site.seed % 97 + 1 })
  for (let i = 0; i < n; i++) {
    const [x, y, z, height, radius] = list.subarray(i * 5, i * 5 + 5), [wx, wz] = turn(site, x, z)
    f.place(i, site.x + wx, y0 + y, site.z + wz, { height, radius })
  }
  return f
}

/** The interior's materials, a slot each for `maps` in MAP_KEYS (shell.js SLOTS), and the dungeon water's, with their shared uniforms:
 * lit by the bake (castles/light.js), the hour through the windows (uSky) and the held torches in `uTorch` (lighting.js's). */
export function interiorMaterials(maps, uTorch) {
  const L = INNER_LIGHT
  const innerUniforms = { uFill: { value: new THREE.Color(...L.fill) }, uFire: { value: new THREE.Color(...L.fire) }, uWin: { value: L.win }, uSky: { value: new THREE.Color() }, uFlicker: { value: 1 }, uTorch }
  const innerMaterial = MAP_KEYS.map((k) => new THREE.ShaderMaterial({ uniforms: { ...innerUniforms, map: { value: maps[k] } }, vertexShader: INNER_VERT, fragmentShader: INNER_FRAG, vertexColors: true }))
  const waterUniforms = {
    ...innerUniforms, uTime: { value: 0 }, uChop: { value: WATER.chop }, uFlow: { value: WATER.flow }, uMirrorA: { value: null }, uMirrorB: { value: null }, uMirrorFade: { value: 0 },
    uTint: { value: new THREE.Color(WATER.tint) }, uMirrorDown: { value: WATER.mirrorDown }, uReflTint: { value: new THREE.Color(WATER.reflTint).multiplyScalar(WATER.reflDim) },
    uClarity: { value: new THREE.Vector2(WATER.clarity, Math.sin((WATER.clarityAngle * Math.PI) / 180)) },
  }
  // water.js's lake material: sorted with the other see-through things.
  const waterMaterial = new THREE.ShaderMaterial({ uniforms: waterUniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: WATER.clarity > 0, depthWrite: true })
  return { innerUniforms, innerMaterial, waterUniforms, waterMaterial }
}

export class Castles {
  /** `sites` layers/castles.js CastleSites.list; `patch(material, cacheKey)` lighting.js's vertex patch; `uTorch` lighting.js's
   * held torches, shared by reference; `probeHidden` what the dungeon water's probe must not capture (main.js's world probe's). */
  constructor(scene, sites, { patch, uTorch, probeHidden }) {
    if (!uTorch || uTorch.value.length !== TORCHES) throw new Error('Castles: needs lighting.uniforms.uTorch')
    if (!Array.isArray(probeHidden)) throw new Error('Castles: needs the world probe\'s hidden list')
    this.scene = scene
    this.sites = sites
    let left = 7, loaded
    this.texturesReady = new Promise((resolve) => { loaded = resolve })
    const done = () => { if (--left === 0) loaded() }
    this.maps = { stone: loadTile('/buildings/castle_stone.webp', UV_METRES, done), plank: loadTile('/buildings/timber_plank.png', UV_METRES, done), cobble: loadTile('/terrain/cobble.webp', 3, done), door: loadTile('/buildings/door.png', UV_METRES, done), gate: loadTile('/buildings/castle_gate.png', UV_METRES, done), thatch: loadTile('/buildings/thatch.png', UV_METRES, done), cloth: loadTile('/interiors/linen.webp', UV_METRES, done), leaded: leadedTexture(128, 0x1ead) }
    this.glow = { value: new THREE.Color(0, 0, 0) }
    this.material = MAP_KEYS.map((k) => patch(glowed(new THREE.MeshLambertMaterial({ vertexColors: true, map: this.maps[k] }), this.glow), `v2-castle-${k}`))
    this.courtMaterial = patch(glowed(new THREE.MeshLambertMaterial({ vertexColors: true, map: this.maps.cobble }), this.glow), 'v2-castle-court')
    Object.assign(this, interiorMaterials(this.maps, uTorch))
    this.probeHidden = probeHidden
    this.ropeMaterial = patch(new THREE.MeshLambertMaterial({ map: ropeTexture() }), 'v2-castle-rope')
    // Sites whose summit rope she has let down, for the session.
    this.ropesDown = new Set()

    this.cardTexture = new THREE.DataTexture(new Uint8Array(CASTLE_CARD.size * CASTLE_CARD.size * 4), CASTLE_CARD.size, CASTLE_CARD.size, THREE.RGBAFormat, THREE.UnsignedByteType)
    this.cardTexture.colorSpace = THREE.SRGBColorSpace
    this.cardTexture.minFilter = THREE.LinearMipmapLinearFilter
    this.cardTexture.magFilter = THREE.LinearFilter
    this.cardTexture.generateMipmaps = true
    this.cardMaterial = patch(new THREE.MeshLambertMaterial({ map: this.cardTexture, alphaTest: 0.5, side: THREE.DoubleSide }), 'v2-castle-card')
    // A unit picture standing on its bottom edge's middle, v running down it as the bake's rows do, its normal leant up so the
    // card takes the sky's light as a roofline does rather than going dark edge-on to the sun.
    const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
    const uv = plane.getAttribute('uv'), nrm = plane.getAttribute('normal')
    for (let i = 0; i < uv.count; i++) { uv.setY(i, 1 - uv.getY(i)); nrm.setXYZ(i, 0, 0.6, 0.8) }
    this.cards = new THREE.InstancedMesh(plane, this.cardMaterial, Math.max(1, sites.length * 2))
    this.cards.frustumCulled = false
    this.cards.visible = false
    scene.add(this.cards)
    this.cardFrame = null
    this._baking = false
    // Site id -> { site, state 'building' | 'ready' | 'failed', group, full, low, solids, shown }.
    this.live = new Map()
    this.worker = null
    this._job = 0
    this.inside = null
    this.stats = { built: 0, live: 0, full: 0, low: 0, cards: 0 }
  }

  /** Photograph seed CASTLE_CARD.seed's exterior and court from its gate's side into the far card, once its textures are in. */
  async bakeCard(renderer) {
    if (this._baking) return
    this._baking = true
    await this.texturesReady
    const lay = castleLayout(CASTLE_CARD.seed)
    if (!lay.stats.ok) throw new Error(`Castles: card seed ${CASTLE_CARD.seed} has no good layout`)
    const ext = castleExtents(lay), shell = toGeometry(exteriorGeometry(lay)), court = toGeometry(courtGeometry(lay))
    shell.computeBoundingBox()
    const half = Math.max(ext.hx, ext.hz) + 1.5, F = { half, bottom: CASTLE_CARD.bottom, top: shell.boundingBox.max.y + 0.5, size: Math.max(ext.hx, ext.hz) }
    const scene = new THREE.Scene()
    const mats = MAP_KEYS.map((k) => new THREE.MeshLambertMaterial({ vertexColors: true, map: this.maps[k] }))
    const courtMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: this.maps.cobble })
    scene.add(new THREE.Mesh(shell, mats), new THREE.Mesh(court, courtMat))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(half * 0.8, half * 2, half * 2)
    scene.add(key, new THREE.HemisphereLight(0xffffff, 0x6f6658, 1.1))
    const cam = new THREE.OrthographicCamera(-half, half, F.top, F.bottom, 0.1, half * 8)
    cam.position.set(0, 0, half * 3)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld()
    const big = CASTLE_CARD.size * SUPERSAMPLE
    const target = new THREE.WebGLRenderTarget(big, big, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true })
    const prev = { target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), xr: renderer.xr.enabled }
    // XR off: presenting, three swaps the camera passed to render() for the headset's (impostor.js renderLayer).
    renderer.xr.enabled = false
    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, true, false)
    renderer.render(scene, cam)
    const raw = new Uint8Array(big * big * 4)
    renderer.readRenderTargetPixels(target, 0, 0, big, big, raw)
    renderer.xr.enabled = prev.xr
    renderer.setRenderTarget(prev.target)
    renderer.setClearColor(prev.clear, prev.alpha)
    target.dispose()
    for (const m of [...mats, courtMat]) m.dispose()
    shell.dispose()
    court.dispose()
    const px = downsample(raw, big, CASTLE_CARD.size)
    flipY(px, CASTLE_CARD.size)
    dilate(px, CASTLE_CARD.size)
    this.cardTexture.image.data.set(px)
    this.cardTexture.needsUpdate = true
    this.cardFrame = F
    this._placeCards()
  }

  /** Every site's two crossed cards, a site with its meshes drawn scaled to nothing. */
  _placeCards() {
    if (this.cardFrame === null) return
    const F = this.cardFrame, m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    let n = 0
    this.sites.forEach((s, i) => {
      const c = this.live.get(s.id), f = Math.max(s.hx, s.hz) / F.size, hide = c !== undefined && c.shown
      for (let k = 0; k < 2; k++) {
        q.setFromAxisAngle(up, s.yaw + k * Math.PI / 2)
        p.set(s.x, s.y + F.bottom * f, s.z)
        sc.set(hide ? 0 : 2 * F.half * f, hide ? 0 : (F.top - F.bottom) * f, 1)
        this.cards.setMatrixAt(i * 2 + k, m.compose(p, q, sc))
      }
      if (!hide) n++
    })
    this.cards.count = this.sites.length * 2
    this.cards.instanceMatrix.needsUpdate = true
    this.cards.visible = n > 0
    this.stats.cards = n
  }

  /** Once a frame: build and drop castles by the eye, pick each one's tier, and run the flames, the court's and roofs' lit by `night`
   * (0 by day to 1); the interior's windows take the light of `dayness` (clock.js). */
  update(eye, t, night, dayness) {
    if (!(dayness >= 0)) throw new Error(`Castles.update: needs dayness, got ${dayness}`)
    const B = CASTLE_BANDS
    let cards = false
    const flicker = 0.9 + 0.06 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 13.7 + 1.3)
    this.glow.value.setRGB(...INNER_LIGHT.fire).multiplyScalar(night * flicker)
    for (const s of this.sites) {
      const d = Math.hypot(eye.x - s.x, eye.z - s.z), c = this.live.get(s.id)
      if (c === undefined) {
        if (d < B.build) this._build(s)
        continue
      }
      if (d > B.drop && this.inside !== c) { this._drop(c); cards = true; continue }
      if (c.state !== 'ready') continue
      const shown = d < B.mesh
      if (shown !== c.shown) { c.shown = shown; c.group.visible = shown; cards = true }
      const full = d < B.full ? true : d > B.low ? false : c.full.visible
      c.full.visible = full
      c.low.visible = !full
      if (c.flames !== null) {
        c.flames.update(t, [night, night, night])
        c.flames.mesh.visible &&= shown && full && night > 0.05
      }
    }
    if (this.inside !== null) {
      if (this.inside.innerFlames !== null) this.inside.innerFlames.update(t, [1, 1, 1])
      skyThroughGlass(dayness, this.innerUniforms.uSky.value)
      this.innerUniforms.uFlicker.value = flicker
      this.waterUniforms.uTime.value = t % 1024
    }
    if (cards) this._placeCards()
    this.stats.live = this.live.size
    this.stats.full = [...this.live.values()].filter((c) => c.state === 'ready' && c.shown && c.full.visible).length
    this.stats.low = [...this.live.values()].filter((c) => c.state === 'ready' && c.shown && c.low.visible).length
  }

  _build(s) {
    if (this.worker === null) {
      this.worker = new Worker(new URL('../castles/worker.js', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev) => this._built(ev.data)
      this.worker.onerror = (e) => { throw new Error(`Castles: the worker failed: ${e.message}`) }
    }
    const id = ++this._job
    this.live.set(s.id, { site: s, state: 'building', job: id, shown: false })
    this.worker.postMessage({ id, seed: s.seed })
  }

  _built(d) {
    const c = [...this.live.values()].find((v) => v.job === d.id)
    // Dropped while the worker was at it.
    if (c === undefined) return
    if (d.seed !== c.site.seed) throw new Error(`Castles: job ${d.id} came back as seed ${d.seed}, not ${c.site.seed}`)
    // A failed castle stays in `live` while near, keeping its card, not rebuilt each frame.
    if (d.error) { c.state = 'failed'; throw new Error(`Castles: castle ${c.site.id} (seed ${d.seed}) failed to build: ${d.error}`) }
    const s = c.site, group = new THREE.Group()
    group.position.set(s.x, s.y, s.z)
    group.rotation.y = s.yaw
    c.full = new THREE.Mesh(toGeometry(d.full), this.material)
    c.low = new THREE.Mesh(toGeometry(d.low), this.material)
    c.court = new THREE.Mesh(toGeometry(d.court), this.courtMaterial)
    group.add(c.full, c.low, c.court)
    c.rope = ropeMeshes(d.solids.portals.rope, this.ropeMaterial)
    c.rope.hang.visible = this.ropesDown.has(s.id)
    c.rope.coil.visible = !c.rope.hang.visible
    group.add(c.rope.hang, c.rope.coil)
    group.visible = false
    group.updateMatrixWorld(true)
    for (const m of [c.full, c.low, c.court, c.rope.hang, c.rope.coil]) m.matrixAutoUpdate = false
    this.scene.add(group)
    c.group = group
    c.interior = d.interior
    c.water = d.water
    c.door = d.door
    c.solids = d.solids
    c.flames = flamesOf(s, d.flames.exterior, s.y)
    if (c.flames !== null) this.scene.add(c.flames.group)
    c.innerFlameList = d.flames.interior
    c.state = 'ready'
    this.stats.built++
  }

  _drop(c) {
    this.live.delete(c.site.id)
    if (c.state !== 'ready') return
    c.group.removeFromParent()
    for (const m of [c.full, c.low, c.court, c.rope.hang, c.rope.coil]) m.geometry.dispose()
    if (c.flames !== null) { c.flames.group.removeFromParent(); c.flames.dispose() }
  }

  /** The built castle whose footprint holds world (x, z), with (x, z) in its local metres; null where there is none. */
  _at(x, z) {
    for (const c of this.live.values()) {
      if (c.state !== 'ready') continue
      const s = c.site
      if (Math.hypot(x - s.x, z - s.z) > s.reach) continue
      const [lx, lz] = toLocal(s, x, z)
      _hit.c = c; _hit.lx = lx; _hit.lz = lz
      return _hit
    }
    return null
  }

  // Stone spans on world (x, z) into `out`, from the castle there; the walk reads out.length / 2 spans or more as solid.
  columnAt(x, z, _minSize, out) {
    const h = this._at(x, z)
    if (h === null) return 0
    const n = exteriorSpans(h.c.solids.ex, h.lx, h.lz)
    return writeSpans(n, h.c.site.y, out)
  }

  /** A flight is 1.4 m wide, so the walk's slope samples either side of it would meet the court below: its treads read level. */
  deckAt(x, z) {
    const h = this._at(x, z)
    return h !== null && onFlight(h.c.solids.ex, h.lx, h.lz)
  }

  blockTopAt(x, z) {
    const h = this._at(x, z)
    if (h === null) return -Infinity
    const n = exteriorSpans(h.c.solids.ex, h.lx, h.lz)
    return n === 0 ? -Infinity : h.c.site.y + spanTop(n)
  }

  /** The built castle site `id`'s summit chest, world [x, y, z] of its top; null until built. */
  chestOf(id) {
    const c = this.live.get(id)
    if (c === undefined || c.state !== 'ready') return null
    const [x, y, z] = c.solids.portals.chest, [wx, wz] = turn(c.site, x, z)
    return [c.site.x + wx, c.site.y + y + 0.2, c.site.z + wz]
  }

  /** The dungeon key's and dungeon chest's spots in built castle site `id`'s interior, world [x, y, z] while it is drawn at
   * CASTLE_RISE; null until built. */
  keyOf(id) { return this._inner(id, 'key') }
  dungeonChestOf(id) { return this._inner(id, 'chest') }
  _inner(id, what) {
    const c = this.live.get(id)
    if (c === undefined || c.state !== 'ready') return null
    const [x, y, z] = c.solids.portals.dungeon[what], [wx, wz] = turn(c.site, x, z)
    return [c.site.x + wx, c.site.y + CASTLE_RISE + y, c.site.z + wz]
  }

  /** Opens the dungeon door of the castle she is in until she leaves it; the loot ledger remembers it for main.js. */
  unlock(site) {
    const c = this.inside
    if (c === null || c.site.id !== site.id || c.solids.it.unlocked) throw new Error(`Castles: unlocking castle ${site.id}, not the locked one she is in`)
    c.solids.it.unlocked = true
    c.doorMesh.removeFromParent()
    c.doorMesh.geometry.dispose()
    c.doorMesh = null
  }

  /** The drawn castle whose summit rope (its coil, or once let down its top) the ray from `origin` along unit `dir` passes within
   * ROPE.grab of inside `maxDist`: `{ site, down }`, or null. */
  ropeOn(origin, dir, maxDist) {
    for (const c of this.live.values()) {
      if (c.state !== 'ready' || !c.shown) continue
      const down = this.ropesDown.has(c.site.id), [x, y, z] = ropeGrip(c.site, c.solids.portals.rope, down)
      const dx = x - origin.x, dy = y - origin.y, dz = z - origin.z
      const t = Math.min(maxDist, Math.max(0, dx * dir.x + dy * dir.y + dz * dir.z))
      if (Math.hypot(dx - dir.x * t, dy - dir.y * t, dz - dir.z * t) < ROPE.grab) return { site: c.site, down }
    }
    return null
  }

  /** Site's summit rope uncoiled down the lookout's face, for the session. */
  dropRope(site) {
    this.ropesDown.add(site.id)
    const c = this.live.get(site.id)
    if (c !== undefined && c.state === 'ready') { c.rope.hang.visible = true; c.rope.coil.visible = false }
  }

  /** Site's summit rope as Climb.startRope takes it, but for `bottom`: world `{ x, z, top }` where she takes hold. */
  ropeAt(site) {
    const c = this.live.get(site.id)
    if (c === undefined || c.state !== 'ready') throw new Error(`Castles: castle ${site.id} is not built`)
    const [x, y, z] = ropeGrip(site, c.solids.portals.rope, true)
    return { x, z, top: y - ROPE.lift }
  }

  /** The scene children drawing the interior she is in: its stone, and its flames. */
  insideDrawn() {
    const c = this.inside
    return c.innerFlames === null ? [c.innerMesh] : [c.innerMesh, c.innerFlames.group]
  }

  /** The drawn castle site nearest world `p` ({ x, z }) within `maxD` m, or null. */
  nearestDrawn(p, maxD) {
    let best = null, bestD = maxD
    for (const c of this.live.values()) {
      const d = Math.hypot(p.x - c.site.x, p.z - c.site.z)
      if (c.state === 'ready' && c.shown && d < bestD) { bestD = d; best = c.site }
    }
    return best
  }

  /** Built castles, for the chests' loot. */
  *built() {
    for (const c of this.live.values()) if (c.state === 'ready') yield c.site
  }

  /** Castle `c`'s interior drawn and its stone made, for her to go in. */
  openInterior(site) {
    const c = this.live.get(site.id)
    if (c === undefined || c.state !== 'ready') throw new Error(`Castles: castle ${site.id} is not built`)
    if (this.inside !== null) throw new Error('Castles: already inside a castle')
    const mesh = new THREE.Mesh(toGeometry(c.interior), this.innerMaterial)
    mesh.position.set(site.x, site.y + CASTLE_RISE, site.z)
    mesh.rotation.y = site.yaw
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.inside = c
    c.innerMesh = mesh
    c.solids.it.unlocked = false
    c.doorMesh = new THREE.Mesh(toGeometry(c.door), this.innerMaterial)
    mesh.add(c.doorMesh)
    c.innerFlames = flamesOf(site, c.innerFlameList, site.y + CASTLE_RISE)
    if (c.innerFlames !== null) this.scene.add(c.innerFlames.group)
    c.waterMesh = c.probe = null
    if (c.water !== null) {
      // Its own probe, so the first capture snaps in.
      c.waterMesh = new THREE.Mesh(toGeometry(c.water), this.waterMaterial)
      c.waterMesh.geometry.computeBoundingBox()
      mesh.add(c.waterMesh)
      c.probe = new WorldProbe()
      c.probe.setVantage((head, out) => this._vantage(head, out))
      c.probe.exclude(c.waterMesh, ...this.probeHidden)
      this.waterUniforms.uMirrorA.value = c.probe.textureA
      this.waterUniforms.uMirrorB.value = c.probe.textureB
    }
    c.innerStone = new CastleInteriorStone(c)
    this._zone = null
    return c.innerStone
  }

  closeInterior() {
    const c = this.inside
    if (c === null) return
    c.innerMesh.removeFromParent()
    c.innerMesh.geometry.dispose()
    if (c.doorMesh !== null) c.doorMesh.geometry.dispose()
    if (c.innerFlames !== null) { c.innerFlames.group.removeFromParent(); c.innerFlames.dispose() }
    if (c.waterMesh !== null) { c.waterMesh.geometry.dispose(); c.probe.dispose() }
    c.innerMesh = c.innerStone = c.innerFlames = c.doorMesh = c.waterMesh = c.probe = null
    this.inside = null
    this._zone = null
  }

  /**
   * After the step, her feet now at `feet` and before it at `from` (world): the portal she just went through, as { kind: 'enter' |
   * 'leave' | 'rope', site, at: world [x, y, z], face: world [fx, fz], back: an enter's way out (world) }, { kind: 'locked', site, at }
   * at the dungeon's locked door (`at` over it), or null. The rope fires
   * walking at it; the rest on entering their zone, so an arrival inside one stays put.
   */
  portalAt(feet, from) {
    const c = this.inside ?? this._at(feet.x, feet.z)?.c
    if (!c) { this._zone = null; return null }
    const s = c.site, P = c.solids.portals, inside = this.inside === c
    const oy = s.y + (inside ? CASTLE_RISE : 0)
    const [lx, lz] = toLocal(s, feet.x, feet.z), [fx, fz] = toLocal(s, from.x, from.z), ly = feet.y - oy
    const sx = lx - fx, sz = lz - fz, step = Math.hypot(sx, sz)
    const world = (p, dy) => { const [wx, wz] = turn(s, p[0], p[2]); return [s.x + wx, dy + p[1], s.z + wz] }
    const face = (u, v) => turn(s, u, v)
    // The rope: walking at it off the summit, not merely past it.
    const r = P.rope, ru = r.x - r.from[0], rv = r.z - r.from[1], rl = Math.hypot(ru, rv)
    if (!inside && this.ropesDown.has(s.id) && Math.hypot(lx - r.x, lz - r.z) < ZONE.rope && Math.abs(ly - r.top) < ZONE.rise && step > 0 && (sx * ru + sz * rv) / (step * rl) >= ROPE_INTO) return { kind: 'rope', site: s, at: world([r.x, r.top, r.z], s.y), face: face(ru, rv) }
    // Zones: the first one her feet are in, by key; it fires only when it was not the one they were in last.
    let zone = null, act = null
    const near = (x, z, r, y) => Math.hypot(lx - x, lz - z) < r && Math.abs(ly - y) < ZONE.rise
    const atLeaves = (p, hw) => Math.abs(ly - p.y) <= ZONE.rise && Math.abs((lx - p.x) * p.nx + (lz - p.z) * p.nz) <= ZONE.door && Math.abs((lx - p.x) * p.nz - (lz - p.z) * p.nx) <= hw
    P.doors.forEach((d, i) => {
      if (zone !== null) return
      if (!inside && atLeaves(d.ext, d.hw)) { zone = `d${i}`; act = { kind: 'enter', site: s, at: world(d.in, s.y + CASTLE_RISE), face: face(-d.ext.nx, -d.ext.nz), back: world(d.out, s.y) } }
      if (inside && atLeaves(d.int, d.hw * CASTLE.scale)) { zone = `d${i}`; act = { kind: 'leave', site: s, at: world(d.out, s.y), face: face(d.ext.nx, d.ext.nz) } }
    })
    if (inside) {
      if (zone === null && !c.solids.it.unlocked && atLeaves(P.dungeon.door, P.dungeon.door.hw)) { const d = P.dungeon.door; zone = 'lock'; act = { kind: 'locked', site: s, at: world([d.x, d.y + 2.2, d.z], oy) } }
      P.ladders.forEach((l, i) => {
        if (zone === null && near(l.x, l.z, ZONE.ladder, l.down[1])) { zone = `l${i}`; act = { kind: 'leave', site: s, at: world(l.roof, s.y), face: face(-l.hatch[0], -l.hatch[2]) } }
      })
    } else {
      P.ladders.forEach((l, i) => {
        if (zone === null && near(l.hatch[0], l.hatch[2], ZONE.hatch, l.hatch[1])) { zone = `t${i}`; act = { kind: 'enter', site: s, at: world(l.down, s.y + CASTLE_RISE), face: face(-l.x, -l.z), back: world(l.roof, s.y) } }
      })
    }
    const fire = zone !== null && zone !== this._zone
    this._zone = zone
    return fire ? act : null
  }

  /** After a portal set her down: the zone she now stands in is the one she is in, so it does not fire. */
  arrived(feet) {
    this._zone = undefined
    this.portalAt(feet, feet)
  }

  /** Each frame she is in a castle, after update() and before the frame is drawn: the dungeon water's probe stepped while its water
   * is within MIRROR_REACH. `eye` world, `dt` real seconds, `look` her unit view direction. */
  reflect(renderer, scene, eye, dt, look) {
    const c = this.inside
    if (c === null || c.waterMesh === null) return
    if (tmpBox.copy(c.waterMesh.geometry.boundingBox).applyMatrix4(c.waterMesh.matrixWorld).distanceToPoint(eye) > MIRROR_REACH) return
    c.probe.update(renderer, scene, eye, null, dt, null, look)
    this.waterUniforms.uMirrorFade.value = c.probe.blend
  }

  // The probe's capture point at a re-anchor (WorldProbe.setVantage): WORLD_PROBE.height over the water vertex nearest her head.
  _vantage(head, out) {
    const m = this.inside.waterMesh, q = m.geometry.getAttribute('position').array
    tmpV.copy(head)
    m.worldToLocal(tmpV)
    let best = Infinity, at = 0
    for (let i = 0; i < q.length; i += 3) {
      const d = (q[i] - tmpV.x) ** 2 + (q[i + 1] - tmpV.y) ** 2 + (q[i + 2] - tmpV.z) ** 2
      if (d < best) { best = d; at = i }
    }
    out.set(q[at], q[at + 1] + WORLD_PROBE.height, q[at + 2])
    m.localToWorld(out)
    return true
  }

  dispose() {
    for (const c of [...this.live.values()]) this._drop(c)
    this.closeInterior()
    if (this.worker !== null) this.worker.terminate()
    this.cards.removeFromParent()
    this.cards.geometry.dispose()
    this.cards.dispose()
    for (const m of [...this.material, ...this.innerMaterial, this.waterMaterial, this.courtMaterial, this.cardMaterial, this.ropeMaterial]) m.dispose()
    for (const t of [...Object.values(this.maps), this.cardTexture, this.ropeMaterial.map]) t.dispose()
  }
}

/** The interior of the castle she is in, as stone: interior metres at CASTLE_RISE over the site. A column asked without her foot
 * (ceilingAt, a teleport landing) reads the storeys round `hint`, the castle layer's last sight of her. */
export class CastleInteriorStone {
  constructor(c) {
    this.c = c
    this.oy = c.site.y + CASTLE_RISE
    this.hint = 0
  }

  columnAt(x, z, _minSize, out, foot) {
    const [lx, lz] = toLocal(this.c.site, x, z)
    const n = interiorSpans(this.c.solids.it, lx, lz, (foot === undefined ? this.hint : foot) - this.oy + 0.5)
    return writeSpans(n, this.oy, out)
  }

  blockTopAt(x, z) {
    const [lx, lz] = toLocal(this.c.site, x, z)
    const n = interiorSpans(this.c.solids.it, lx, lz, this.hint - this.oy + 0.5)
    return this.oy + spanTop(n)
  }

  /** Every top inside is level, so the walk reads a spiral's steps as floor and not the slope across them. */
  deckAt() { return true }

  stairAt(x, y, z) {
    const [lx, lz] = toLocal(this.c.site, x, z), top = spiralTreadAt(this.c.solids.it, lx, y - this.oy, lz)
    return top === null ? null : this.oy + top
  }
}

/** World [x, y, z] of portals().rope `r`'s grip in site `s`: the coil's top on the roof, or let `down`, the hanging rope's top. */
function ropeGrip(s, r, down) {
  const [u, v] = ropeBack(r), lx = down ? r.x : r.x + u * ROPE.back, lz = down ? r.z : r.z + v * ROPE.back
  const [wx, wz] = turn(s, lx, lz)
  return [s.x + wx, s.y + r.top + (down ? ROPE.lift : ROPE.r * 3.8), s.z + wz]
}

// The unit from where the rope hangs in toward the summit.
const ropeBack = (r) => { const u = r.from[0] - r.x, v = r.from[1] - r.z, l = Math.hypot(u, v); return [u / l, v / l] }

/** A seven-sided rope of ROPE.r from a to b (local metres), its texture wrapping once round and tiling square along it. */
function ropeRun(a, b) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), L = d.length(), around = 2 * Math.PI * ROPE.r
  const g = new THREE.CylinderGeometry(ROPE.r, ROPE.r, L, ROPE.sides, 1, true)
  const uv = g.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) uv.setY(i, (uv.getY(i) * L) / (2 * around))
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()))
  return g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
}

/** The summit rope's two looks, local to the castle's group: `coil` on the roof, and `hang`, over the parapet and down the face. */
function ropeMeshes(r, material) {
  const [u, v] = ropeBack(r), top = r.top + ROPE.lift, tie = [r.x + u * ROPE.back, top, r.z + v * ROPE.back]
  // A flat coil, ring inside ring on the roof, its outer turns laid again on top.
  const rings = (n, x, z) => Array.from({ length: n }, (_, i) => {
    const up = i >= n - Math.floor(n / 3) ? 1 : 0, rad = ROPE.coil - 2.1 * ROPE.r * (up ? n - 1 - i : i)
    const g = new THREE.TorusGeometry(rad, ROPE.r, ROPE.sides, 16).rotateX(Math.PI / 2)
    const uv = g.getAttribute('uv')
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getY(k), (uv.getX(k) * 2 * Math.PI * rad) / (4 * Math.PI * ROPE.r))
    return g.translate(x, r.top + ROPE.r * (1 + 1.8 * up), z)
  })
  const merge = (parts) => { const g = mergeGeometries(parts); for (const p of parts) p.dispose(); return g }
  const mesh = (g) => { const m = new THREE.Mesh(g, material); m.name = 'v2-castle-rope'; return m }
  return {
    coil: mesh(merge(rings(ROPE.rings, tie[0], tie[2]))),
    hang: mesh(merge([...rings(1, tie[0], tie[2]), ropeRun([tie[0], r.top + ROPE.r, tie[2]], tie), ropeRun(tie, [r.x, top, r.z]), ropeRun([r.x, top, r.z], [r.x, -CASTLE.raise, r.z])])),
  }
}

/** A braided rope's wrapping tile, made in code: speckled browns, strands lit across their middles, darker grooves between them
 * running diagonally both ways so the lay reads as plaited. u goes once round the rope, v twice its girth along it. */
function ropeTexture() {
  const W = 32, H = 64, data = new Uint8Array(W * H * 4), rng = mulberry32(0x40be)
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const u = i / W, v = j / H
    // Integer slopes in u and v, so each family of strands wraps and tiles seamlessly.
    const a = (3 * u + 4 * v) % 1, b = (((3 * u - 4 * v) % 1) + 1) % 1, over = Math.floor(8 * v + 3 * u) % 2 === 0
    const s = over ? a : b, strand = 0.72 + 0.28 * Math.sin(Math.PI * s), groove = Math.min(a, 1 - a) < 0.06 || Math.min(b, 1 - b) < 0.06
    const k = strand * (groove ? 0.55 : 1) * (0.88 + 0.24 * rng()) * (rng() < 0.07 ? 0.65 : 1)
    const o = (j * W + i) * 4
    data[o] = Math.min(255, 150 * k); data[o + 1] = Math.min(255, 112 * k); data[o + 2] = Math.min(255, 70 * k); data[o + 3] = 255
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.needsUpdate = true
  return t
}

const _hit = { c: null, lx: 0, lz: 0 }
const { LO, HI } = SPANS

function writeSpans(n, oy, out) {
  if (n * 2 > out.length) throw new Error(`Castles: ${n} spans on one column, past the walk's ${out.length / 2}`)
  for (let i = 0; i < n; i++) { out[i * 2] = LO[i] + oy; out[i * 2 + 1] = HI[i] + oy }
  return n
}

/** The highest top of the `n` spans solids.js last left, short of the open sky over a castle's interior. */
function spanTop(n) {
  let top = -Infinity
  for (let i = 0; i < n; i++) if (HI[i] < 999) top = Math.max(top, HI[i])
  return top
}
