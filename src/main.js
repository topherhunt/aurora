import * as THREE from 'three'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTextureArray, LAYER } from './textures.js'
import { createPropMaterial } from './material.js'
import { loadProps } from './props.js'
import { Hud } from './hud.js'
import { Input } from './input.js'

// ---------------------------------------------------------------------------
// DESIGN.md §0 -- the multi-draw spike.
//
// Question this answers: does Quest Browser expose WEBGL_multi_draw, and does
// THREE.BatchedMesh actually collapse many distinct geometries into one draw
// call on Quest hardware? The entire renderer design (DESIGN.md §5) rests on
// yes. If the answer is no, the asset variety budget shrinks a lot.
//
// Compares three strategies over an identical set of placements:
//   BATCHED     one BatchedMesh, N instances across all geometries
//   INSTANCED   one InstancedMesh per geometry
//   INDIVIDUAL  one Mesh per placement
// ---------------------------------------------------------------------------

const MODES = ['BATCHED', 'INSTANCED', 'INDIVIDUAL']
const MAX_INSTANCES = 30000
const INDIVIDUAL_CAP = 4000 // beyond this, individual Meshes lock up the tab
const SCATTER_RADIUS = 90
const COUNT_STEPS = [250, 500, 1000, 2000, 4000, 8000, 12000, 20000, 30000]

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(1) // never above 1 in XR; the headset drives resolution
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.xr.enabled = true
document.body.appendChild(renderer.domElement)
document.body.appendChild(VRButton.createButton(renderer))

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0e1622)
scene.fog = new THREE.Fog(0x0e1622, 40, 190)

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  600
)
camera.position.set(0, 1.7, 8)

// The player rig. In XR the headset pose is relative to this.
const player = new THREE.Group()
player.add(camera)
scene.add(player)

const orbit = new OrbitControls(camera, renderer.domElement)
orbit.target.set(0, 1.5, 0)

// One real-time directional light, per Meta's WebXR guidance (DESIGN.md §5).
const sun = new THREE.DirectionalLight(0xbcd4ff, 1.6)
sun.position.set(-40, 55, 30)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x5a76a8, 0x20242c, 0.85))

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

// ---------------------------------------------------------------------------
// Capability probe -- the actual point of the spike
// ---------------------------------------------------------------------------

const gl = renderer.getContext()
const caps = {
  multiDraw: !!gl.getExtension('WEBGL_multi_draw'),
  multiDrawInstancedBVB: !!gl.getExtension(
    'WEBGL_multi_draw_instanced_base_vertex_base_instance'
  ),
  ovrMultiview2: !!gl.getExtension('OVR_multiview2'),
  oculusMultiview: !!gl.getExtension('OCULUS_multiview'),
  textureArray: true, // WebGL2 core
  astc: !!gl.getExtension('WEBGL_compressed_texture_astc'),
  etc: !!gl.getExtension('WEBGL_compressed_texture_etc'),
  maxTexArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
  renderer: 'unknown',
}
{
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  if (dbg) caps.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const textureArray = buildTextureArray()
const propMaterial = createPropMaterial(textureArray)

const hud = new Hud()
scene.add(hud.mesh)
hud.setLines(['## AURORA SPIKE', '', 'loading props...'])

const input = new Input(renderer)

let geometries = []
let loadStats = null
let placements = []
let currentGroup = null
let modeIndex = 0
let countIndex = 4
let rebuildPending = 0

// Seeded so every mode renders an identical world and the comparison is fair.
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildPlacements(n) {
  const rand = mulberry32(1337)
  const out = new Array(n)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const pos = new THREE.Vector3()
  const scl = new THREE.Vector3()

  for (let i = 0; i < n; i++) {
    // sqrt for uniform area density rather than a bullseye at the origin
    const r = Math.sqrt(rand()) * SCATTER_RADIUS
    const a = rand() * Math.PI * 2
    pos.set(Math.cos(a) * r, 0, Math.sin(a) * r)
    q.setFromAxisAngle(up, rand() * Math.PI * 2)
    // Per-instance non-uniform scale: most of what stops a procedural forest
    // from looking procedural (DESIGN.md §6).
    const s = 0.8 + rand() * 0.5
    scl.set(s, s * (0.85 + rand() * 0.35), s)
    m.compose(pos, q, scl)
    out[i] = { geom: (rand() * geometries.length) | 0, matrix: m.clone() }
  }
  return out
}

function disposeGroup() {
  if (!currentGroup) return
  currentGroup.traverse((o) => {
    if (o.isBatchedMesh || o.isInstancedMesh) o.dispose?.()
  })
  scene.remove(currentGroup)
  currentGroup = null
}

function build() {
  disposeGroup()
  const count = COUNT_STEPS[countIndex]
  placements = buildPlacements(count)
  const group = new THREE.Group()
  const mode = MODES[modeIndex]

  if (mode === 'BATCHED') {
    const maxVerts = geometries.reduce(
      (s, g) => s + g.attributes.position.count,
      0
    )
    // All geometries are non-indexed, so no index buffer is allocated.
    const bm = new THREE.BatchedMesh(
      Math.min(count, MAX_INSTANCES),
      maxVerts,
      0,
      propMaterial
    )
    bm.perObjectFrustumCulled = true
    bm.sortObjects = false // opaque + alphaTest, so no sorting needed
    const ids = geometries.map((g) => bm.addGeometry(g))
    for (const p of placements) {
      const inst = bm.addInstance(ids[p.geom])
      bm.setMatrixAt(inst, p.matrix)
    }
    bm.computeBoundingSphere()
    group.add(bm)
  } else if (mode === 'INSTANCED') {
    const byGeom = geometries.map(() => [])
    for (const p of placements) byGeom[p.geom].push(p.matrix)
    for (let g = 0; g < geometries.length; g++) {
      const list = byGeom[g]
      if (list.length === 0) continue
      const im = new THREE.InstancedMesh(geometries[g], propMaterial, list.length)
      for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i])
      im.instanceMatrix.needsUpdate = true
      im.computeBoundingSphere()
      group.add(im)
    }
  } else {
    const n = Math.min(placements.length, INDIVIDUAL_CAP)
    for (let i = 0; i < n; i++) {
      const p = placements[i]
      const mesh = new THREE.Mesh(geometries[p.geom], propMaterial)
      mesh.matrixAutoUpdate = false
      mesh.matrix.copy(p.matrix)
      mesh.matrixWorld.copy(p.matrix)
      group.add(mesh)
    }
  }

  scene.add(group)
  currentGroup = group
  resetTiming()
}

// Ground plane, textured from the same array so we exercise a large
// fill-rate-heavy surface with the real material path.
function buildGround() {
  const size = SCATTER_RADIUS * 2.6
  const geo = new THREE.PlaneGeometry(size, size, 1, 1)
  geo.rotateX(-Math.PI / 2)
  const n = geo.attributes.position.count
  const uv = new Float32Array(n * 2)
  const layer = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    uv[i * 2] = geo.attributes.position.getX(i) * 0.35
    uv[i * 2 + 1] = geo.attributes.position.getZ(i) * 0.35
    layer[i] = LAYER.SNOW
  }
  geo.setAttribute('uvProj', new THREE.BufferAttribute(uv, 2))
  geo.setAttribute('texLayer', new THREE.BufferAttribute(layer, 1))
  const mesh = new THREE.Mesh(geo, propMaterial)
  mesh.position.y = -0.01
  scene.add(mesh)
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

// Three separate horizons, deliberately. The rolling average rolls over every
// 30 frames; `worst` must NOT, or it only ever reports the worst of the last
// half second and the spike's most important number -- the hitch -- goes
// invisible. `worst` survives until the scene is rebuilt; `soakWorst` survives
// until manually reset, so it can catch a thermal cliff 20 minutes in.
let frames = 0
let acc = 0
let avgMs = 0
let worst = 0
let soakStart = performance.now()
let soakWorst = 0

function rollAverage() {
  avgMs = acc / frames
  frames = 0
  acc = 0
}
function resetTiming() {
  frames = 0
  acc = 0
  worst = 0
}
function resetSoak() {
  soakStart = performance.now()
  soakWorst = 0
}

// ---------------------------------------------------------------------------
// XR session wiring
// ---------------------------------------------------------------------------

let foveation = 1.0
let targetRate = 72
let supportedRates = []
let actualRate = 0

renderer.xr.addEventListener('sessionstart', () => {
  renderer.xr.setFoveation(foveation)
  const session = renderer.xr.getSession()
  supportedRates = Array.from(session.supportedFrameRates || [])
  actualRate = session.frameRate || 0
  applyFrameRate()
  resetSoak()
})

function applyFrameRate() {
  const session = renderer.xr.getSession()
  if (!session || !session.updateTargetFrameRate || !supportedRates.length) return
  // Pick the supported rate nearest our target.
  const best = supportedRates.reduce((a, b) =>
    Math.abs(b - targetRate) < Math.abs(a - targetRate) ? b : a
  )
  session
    .updateTargetFrameRate(best)
    .then(() => {
      actualRate = session.frameRate || best
    })
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

let stickCooldown = 0

function handleInput(dt) {
  const s = input.update()
  if (!s.connected) return

  if (s.right.buttons.PRIMARY?.justPressed) {
    modeIndex = (modeIndex + 1) % MODES.length
    build()
  }
  if (s.right.buttons.SECONDARY?.justPressed) {
    foveation = foveation > 0.5 ? 0 : 1.0
    renderer.xr.setFoveation(foveation)
  }
  if (s.left.buttons.PRIMARY?.justPressed) {
    targetRate = targetRate === 72 ? 90 : 72
    applyFrameRate()
  }
  if (s.left.buttons.SECONDARY?.justPressed) hud.toggle()
  if (s.left.buttons.TRIGGER?.justPressed) resetSoak()

  stickCooldown -= dt
  const y = s.right.axes[1]
  if (Math.abs(y) > 0.7 && stickCooldown <= 0) {
    const next = countIndex + (y < 0 ? 1 : -1)
    if (next >= 0 && next < COUNT_STEPS.length) {
      countIndex = next
      rebuildPending = 0.25 // debounce so a stick sweep does not thrash
    }
    stickCooldown = 0.35
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === '1' || e.key === '2' || e.key === '3') {
    modeIndex = +e.key - 1
    build()
  }
  if (e.key === '=' || e.key === '+') {
    countIndex = Math.min(countIndex + 1, COUNT_STEPS.length - 1)
    build()
  }
  if (e.key === '-') {
    countIndex = Math.max(countIndex - 1, 0)
    build()
  }
  if (e.key === 'h') hud.toggle()
})

// ---------------------------------------------------------------------------
// HUD content
// ---------------------------------------------------------------------------

function hudLines() {
  const info = renderer.info
  const mode = MODES[modeIndex]
  const shown =
    mode === 'INDIVIDUAL'
      ? Math.min(COUNT_STEPS[countIndex], INDIVIDUAL_CAP)
      : COUNT_STEPS[countIndex]
  const soakMin = ((performance.now() - soakStart) / 60000).toFixed(1)
  const fps = avgMs > 0 ? (1000 / avgMs).toFixed(1) : '--'

  const verdict = caps.multiDraw
    ? '++ WEBGL_multi_draw: YES'
    : '!! WEBGL_multi_draw: NO -- see DESIGN.md §0 fallback'

  return [
    '## AURORA -- multi-draw spike',
    verdict,
    `GPU: ${String(caps.renderer).slice(0, 42)}`,
    `multiview: OVR=${caps.ovrMultiview2 ? 'y' : 'n'} OCULUS=${
      caps.oculusMultiview ? 'y' : 'n'
    }   astc=${caps.astc ? 'y' : 'n'} etc=${caps.etc ? 'y' : 'n'}`,
    `max tex array layers: ${caps.maxTexArrayLayers}`,
    '',
    `## MODE  ${mode}   (A cycles)`,
    `instances   ${shown}${
      mode === 'INDIVIDUAL' && COUNT_STEPS[countIndex] > INDIVIDUAL_CAP
        ? ` (capped from ${COUNT_STEPS[countIndex]})`
        : ''
    }`,
    `geometries  ${geometries.length}  (${loadStats?.fullMeshes ?? 0} mesh + ${
      loadStats?.billboards ?? 0
    } billboard)`,
    '',
    `## draw calls ${info.render.calls}    triangles ${(
      info.render.triangles / 1000
    ).toFixed(1)}k`,
    `frame ${avgMs.toFixed(2)}ms (${fps} fps)  worst ${worst.toFixed(1)}ms`,
    `geoms ${info.memory.geometries}  textures ${info.memory.textures}  programs ${
      renderer.info.programs?.length ?? 0
    }`,
    '',
    `foveation ${foveation.toFixed(1)} (B)   target ${targetRate}Hz actual ${
      actualRate || '--'
    }Hz (X)`,
    `soak ${soakMin} min   worst since reset ${soakWorst.toFixed(1)}ms (L-trigger)`,
    `rates: ${supportedRates.join('/') || 'n/a'}`,
    '',
    'R-stick up/down = instance count   Y = hide HUD',
  ]
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let last = performance.now()

function tick() {
  const now = performance.now()
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now

  const ms = dt * 1000
  acc += ms
  frames++
  if (frames > 10) {
    if (ms > worst) worst = ms
    if (ms > soakWorst) soakWorst = ms
  }
  if (frames >= 30) rollAverage()

  handleInput(dt)

  if (rebuildPending > 0) {
    rebuildPending -= dt
    if (rebuildPending <= 0) build()
  }

  const activeCam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera
  hud.follow(activeCam, dt)
  hud.setLines(hudLines())
  hud.paint(now)

  if (!renderer.xr.isPresenting) orbit.update()
  renderer.render(scene, camera)
}

async function boot() {
  try {
    const result = await loadProps('./props/')
    geometries = result.geometries
    loadStats = result.stats

    if (loadStats.failures.length) {
      console.warn('prop load failures:', loadStats.failures)
    }
    console.log('loaded props:', loadStats)

    buildGround()
    build()
    renderer.setAnimationLoop(tick)
  } catch (err) {
    // Fail loudly. A silent half-loaded scene would make the measurements lie.
    hud.setLines(['!! LOAD FAILED', String(err.message)])
    hud.paint(performance.now())
    renderer.setAnimationLoop(() => renderer.render(scene, camera))
    throw err
  }
}

boot()
