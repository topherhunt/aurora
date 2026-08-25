import * as THREE from 'three'
import { VRButton } from 'three/addons/webxr/VRButton.js'

import { HEIGHTMAP_URL, HEIGHTMAP_META_URL } from './v2/config.js'
import { Heightmap } from './v2/height/heightmap.js'
import { Input } from './input.js'
import { loadHeightTexture, heightUniforms, HeightProbe } from './newgrass/gpu-height.js'
import { GrassField, PRESETS, LINEAR_TINTS } from './newgrass/grass-field.js'
import { Ground } from './newgrass/ground.js'

// ---------------------------------------------------------------------------
// /v2-new-grass -- a bench for grass that costs no CPU.
//
// The argument this page exists to make, in three sentences: Breath of the Wild
// did not replace grass polygons with a shader, it arranged for there to be
// very few polygons; the near blades are generated in the vertex shader from
// world position so nothing is stored or visited; and everything past 72 m is
// PAINTED BY THE GROUND, which is where most of a hillside actually is. The
// long-form versions live at the top of grass-field.js (parts 1 and 3) and
// ground.js (part 2), and the honest caveats are at the top of gpu-height.js.
//
// This file is the harness: renderer, sky, camera, panel, numbers. It is
// deliberately its own page and its own world rather than a mode inside /v2,
// because the comparison worth making is a CLEAN one -- same hill, same light,
// two carpets, one button -- and because nothing here should be able to break
// the editor.
//
// WHAT IS NOT REAL HERE, so the numbers are read correctly:
//   - the terrain is the imported heightmap plus two procedural octaves, not
//     V2Height, so there are no rivers, lakes, roads or authored snow;
//   - the `tufts` preset reproduces the shipped scatter's DENSITY LAW, not its
//     implementation -- it is GPU-placed too, so its CPU cost here is zero and
//     the real one's is 0.9 ms. The versus table quotes the measured figure.
// ---------------------------------------------------------------------------

const SEED = 20260825

const boot = document.getElementById('boot')
const bootFail = (err) => {
  console.error(err)
  if (boot) {
    boot.classList.remove('gone')
    boot.innerHTML = `<pre>/v2-new-grass failed to start\n\n${err && err.stack ? err.stack : err}</pre>`
  }
}

// --- renderer ---------------------------------------------------------------

const stage = document.getElementById('stage')

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(1) // never above 1 in XR; the headset controls its own resolution
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.xr.enabled = true
renderer.xr.setFoveation(1.0)
stage.appendChild(renderer.domElement)
document.body.appendChild(VRButton.createButton(renderer))

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 4000)
camera.rotation.order = 'YXZ'

// The rig is what locomotion moves. In XR the headset writes the camera's pose
// relative to it; on the desktop the camera sits at eye height above it.
const rig = new THREE.Group()
rig.add(camera)
scene.add(rig)

const EYE = 1.65

function resize() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / Math.max(1, h)
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)

// --- the shared uniform block ------------------------------------------------
//
// Every material on this page -- eight ground levels, three grass rings, two
// shell layers, the height probe -- is handed THESE CELLS BY REFERENCE. One
// write to shared.time moves the wind everywhere; one write to shared.height's
// uDetail changes the terrain and the grass standing on it together, in the
// same frame, by exactly the same amount. That is not a convenience, it is the
// mechanism that makes it impossible for the grass and the ground to disagree
// about where the ground is.

const SUN = { elevation: 14, azimuth: 118 }

const shared = {
  height: null, // filled at boot, once the heightmap is decoded
  sky: {
    uSunDir: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color(1.35, 1.14, 0.86) },
    uSkyColor: { value: new THREE.Color(0.30, 0.42, 0.62) },
    uGroundColor: { value: new THREE.Color(0.10, 0.11, 0.09) },
    uFogColor: { value: new THREE.Color(0.62, 0.71, 0.82) },
    uFogDensity: { value: 0.0026 },
  },
  camXZ: { value: new THREE.Vector2() },
  time: { value: 0 },
  density: { value: 1 },
  windDir: { value: new THREE.Vector2(0.82, 0.57).normalize() },
  // amplitude, spatial frequency, scroll speed, gust mix
  wind: { value: new THREE.Vector4(0.26, 0.045, 0.55, 0.55) },
  tintA: { value: new THREE.Color(...LINEAR_TINTS[0]) },
  tintB: { value: new THREE.Color(...LINEAR_TINTS[1]) },
  tintC: { value: new THREE.Color(...LINEAR_TINTS[2]) },
  clutter: { value: 1 },
  ripple: { value: 1 },
  shellCount: { value: 16 },
  shellHeight: { value: 0.45 },
}

function applySun() {
  const el = (SUN.elevation * Math.PI) / 180
  const az = (SUN.azimuth * Math.PI) / 180
  shared.sky.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
  // A low sun is a warm, dim, orange one and a high sun is white. One lerp,
  // and it is most of why the low-sun look on this page reads as evening
  // rather than as the same light turned sideways.
  const t = Math.min(1, Math.max(0, (SUN.elevation - 3) / 40))
  shared.sky.uSunColor.value.setRGB(
    1.55 - 0.2 * t,
    0.95 + 0.24 * t,
    0.58 + 0.34 * t
  ).multiplyScalar(0.75 + 0.35 * t)
  shared.sky.uFogColor.value.setRGB(0.50 + 0.14 * t, 0.58 + 0.14 * t, 0.68 + 0.15 * t)
  // Linear, uncorrected: scene.background is read in the working colour space
  // and three converts on output. It is only ever seen if the dome fails to
  // draw, but a magenta-ish background would be a confusing way to find out.
  scene.background = shared.sky.uFogColor.value.clone()
}
applySun()

// --- sky dome ----------------------------------------------------------------
// Not the project's Sky: that one wants a WorldClock, a WorldLighting and a
// SkyProbe, and this page has an opinion about grass rather than about weather.
// A gradient and a sun disc is enough to light a meadow and to give the fog
// something to fade into.

const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(2000, 32, 16),
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: shared.sky.uSunDir,
      uSunColor: shared.sky.uSunColor,
      uSkyColor: shared.sky.uSkyColor,
      uFogColor: shared.sky.uFogColor,
    },
    vertexShader: /* glsl */ `
      out vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform vec3 uFogColor;
      in vec3 vDir;
      out vec4 fragColor;
      void main() {
        vec3 d = normalize(vDir);
        // The horizon band has to match uFogColor exactly or the distant hills
        // end against a visibly different sky, which is the one artefact that
        // makes an otherwise fine view read as a diorama.
        float t = smoothstep(-0.02, 0.55, d.y);
        vec3 col = mix(uFogColor, uSkyColor, t);
        float sun = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSunColor * (pow(sun, 900.0) * 8.0 + pow(sun, 12.0) * 0.35);
        fragColor = vec4(col, 1.0);
      }
    `,
  })
)
skyDome.name = 'newgrass-sky'
skyDome.frustumCulled = false
skyDome.renderOrder = -1
scene.add(skyDome)

// --- state filled at boot ----------------------------------------------------

let ground = null
let grass = null
let probe = null
let ready = false

// --- locomotion --------------------------------------------------------------

const keys = new Set()
const look = { yaw: 0, pitch: -0.12 }
let walking = false
let groundY = 0

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  keys.add(e.code)
})
addEventListener('keyup', (e) => keys.delete(e.code))

renderer.domElement.addEventListener('click', () => {
  // Rejects if the browser is still in its post-Escape cooldown. Swallowed
  // rather than left to become an unhandled rejection in the console, which on
  // a page whose console is where its errors are read would be noise.
  const p = renderer.domElement.requestPointerLock()
  if (p && p.catch) p.catch(() => {})
})
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return
  look.yaw -= e.movementX * 0.0022
  look.pitch = Math.max(-1.5, Math.min(1.5, look.pitch - e.movementY * 0.0022))
})

const input = new Input(renderer)
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _head = new THREE.Vector3()

function moveDesktop(dt) {
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 34 : 7) * dt
  _fwd.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw))
  _right.set(-_fwd.z, 0, _fwd.x)

  if (keys.has('KeyW')) rig.position.addScaledVector(_fwd, speed)
  if (keys.has('KeyS')) rig.position.addScaledVector(_fwd, -speed)
  if (keys.has('KeyD')) rig.position.addScaledVector(_right, speed)
  if (keys.has('KeyA')) rig.position.addScaledVector(_right, -speed)
  if (!walking) {
    if (keys.has('KeyE') || keys.has('Space')) rig.position.y += speed
    if (keys.has('KeyQ')) rig.position.y -= speed
  }
}

function moveXR(dt) {
  const state = input.update()
  if (!state.connected) return
  const speed = 5 * dt
  const [rx, ry] = state.right.axes
  if (Math.abs(rx) > 0.15 || Math.abs(ry) > 0.15) {
    // Head-relative, which is what a Quest player expects from the right stick.
    camera.getWorldDirection(_fwd)
    _fwd.y = 0
    _fwd.normalize()
    _right.set(-_fwd.z, 0, _fwd.x)
    rig.position.addScaledVector(_fwd, -ry * speed)
    rig.position.addScaledVector(_right, rx * speed)
  }
  const [lx] = state.left.axes
  // Snap turn: smooth yaw in a headset is the fastest way to make someone ill.
  if (Math.abs(lx) > 0.7 && !moveXR.turned) {
    rig.rotation.y -= Math.sign(lx) * (Math.PI / 6)
    moveXR.turned = true
  } else if (Math.abs(lx) < 0.4) {
    moveXR.turned = false
  }
}

// --- the GPU timer -----------------------------------------------------------
//
// EXT_disjoint_timer_query_webgl2 is not available in every browser (it leaks
// timing, so several ship it off by default). When it is missing the panel says
// so rather than showing a plausible fabricated number, which on a page whose
// entire purpose is a cost comparison would be worse than showing nothing.

function makeGpuTimer(gl) {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  if (!ext) return { supported: false, ms: null, begin() {}, end() {} }
  let query = null
  const timer = {
    supported: true,
    ms: null,
    begin() {
      if (query) return
      query = gl.createQuery()
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    },
    end() {
      if (!query) return
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      const q = query
      query = null
      // Poll on a later turn: the result is not there this frame by definition.
      const poll = () => {
        if (gl.isContextLost()) return
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          requestAnimationFrame(poll)
          return
        }
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          timer.ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
        }
        gl.deleteQuery(q)
      }
      requestAnimationFrame(poll)
    },
  }
  return timer
}

const gpuTimer = makeGpuTimer(renderer.getContext())

// --- boot --------------------------------------------------------------------

async function start() {
  const height = await loadHeightTexture()
  shared.height = heightUniforms(height, { detail: 1 })

  ground = new Ground(scene, height, shared)
  grass = new GrassField(scene, height, shared, { preset: 'field', seed: SEED % 1000 })
  probe = new HeightProbe(shared.height)

  // A place to stand. The coarse imported field is enough to CHOOSE a spot --
  // it wants gentle, mid-altitude, well inside the map -- and the GPU probe
  // then supplies the exact height once the first frame has rendered.
  const cpu = await Heightmap.load({ url: HEIGHTMAP_URL, metaUrl: HEIGHTMAP_META_URL })
  const spawn = findSpawn(cpu)
  rig.position.set(spawn.x, spawn.y, spawn.z)
  groundY = spawn.y

  buildPanel()
  resize()
  ready = true
  boot.classList.add('gone')
}

/**
 * The gentlest patch of mid-altitude ground the coarse map can find.
 *
 * A golden-angle spiral rather than a grid, for the reason /v2's spawn search
 * gives: a grid coarse enough to be cheap drops whole valleys between its rows,
 * and it drops the SAME ones every boot, so the failure never gets noticed.
 */
function findSpawn(cpu) {
  const R = 2600
  let best = null
  for (let i = 0; i < 900; i++) {
    const t = i / 900
    const r = R * Math.sqrt(t)
    const a = i * 2.399963
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const y = cpu.sample(x, z)
    if (y < 40 || y > 260) continue
    const slope = cpu.slopeAt(x, z)
    const score = -slope * 4 - Math.abs(y - 120) * 0.004
    if (!best || score > best.score) best = { x, y, z, score }
  }
  if (!best) throw new Error('v2-new-grass: no spawn between 40 m and 260 m on this heightmap')
  return best
}

// --- the panel ---------------------------------------------------------------

/**
 * Every dial on the left, as [id, label, tooltip, min, max, step, get, set].
 *
 * The set of dials IS the argument: density and card width are the two that
 * trade cost against look, and the rest are here so that "it only looks good at
 * these exact settings" can be checked rather than assumed.
 */
const SLIDERS = [
  ['density', 'density', 'Multiplier over the whole ladder. The point of the spike: this is a uniform, so moving it costs GPU only -- no rebuild, no CPU, no hitch.', 0.1, 3, 0.05,
    () => shared.density.value, (v) => { shared.density.value = v }],
  ['wind', 'wind', 'How far a card bends downwind, as a fraction of its own height.', 0, 0.8, 0.01,
    () => shared.wind.value.x, (v) => { shared.wind.value.x = v }],
  ['gust', 'gust speed', 'How fast the gust field scrolls across the meadow. This drives the ground ripple too, which is why the far field moves with the near one.', 0, 2, 0.02,
    () => shared.wind.value.z, (v) => { shared.wind.value.z = v }],
  ['gustmix', 'gust mix', 'Blend between per-instance sway (0) and the shared scrolling gust (1). All sway is an animation; all gust is a weather system with no local life in it.', 0, 1, 0.02,
    () => shared.wind.value.w, (v) => { shared.wind.value.w = v }],
  ['detail', 'terrain detail', 'Amplitude of the two procedural octaves on top of the imported heightmap. The ground and the grass read it from the same cell, so they cannot come apart.', 0, 2, 0.05,
    () => shared.height.uDetail.value, (v) => { shared.height.uDetail.value = v }],
  ['slope', 'slope cutoff', 'Where grass gives up on a bank, as (1 - n.y). Grass and bare ground blend by the same number, so the margin matches.', 0.03, 0.6, 0.01,
    () => shared.height.uCoverSlope.value.y, (v) => { shared.height.uCoverSlope.value.y = v }],
  ['transmit', 'transmission', 'Back-lit glow through a blade. Turn the sun low, look into it, and this is what makes the hillside silver.', 0, 3, 0.05,
    () => ringUniform('uTransmit'), (v) => setRings('uTransmit', v)],
  ['cut', 'alpha cut', 'Cutout threshold at the near edge. It is lowered with distance to compensate for mip loss; this is the value it starts from.', 0.15, 0.75, 0.01,
    () => ringUniform('uAlphaTest'), (v) => setRings('uAlphaTest', v)],
  ['lean', 'downhill lean', 'How far a card leans downslope. Zero is a hairbrush.', 0, 0.9, 0.02,
    () => ringUniform('uLean'), (v) => setRings('uLean', v)],
  ['sunel', 'sun elevation', 'Degrees above the horizon.', 2, 70, 1,
    () => SUN.elevation, (v) => { SUN.elevation = v; applySun() }],
  ['sunaz', 'sun azimuth', 'Degrees. Swing it behind the far hills to see the transmission term work.', 0, 359, 1,
    () => SUN.azimuth, (v) => { SUN.azimuth = v; applySun() }],
  ['fog', 'fog', 'Exponential-squared density. The grass, the ground and the sky all use this one number.', 0, 0.006, 0.0001,
    () => shared.sky.uFogDensity.value, (v) => { shared.sky.uFogDensity.value = v }],
  ['shellN', 'shells', 'Layers in the shell-texturing comparison. Watch frame time, not triangles.', 2, 40, 1,
    () => shared.shellCount.value, (v) => { shared.shellCount.value = v; ground.setShells(shellsOn, v) }],
  ['shellH', 'shell height', 'Metres of fur.', 0.05, 1.5, 0.05,
    () => shared.shellHeight.value, (v) => { shared.shellHeight.value = v }],
]

const ringUniform = (name) => grass.rings[0]?.uniforms[name].value ?? 0
const setRings = (name, v) => {
  for (const r of grass.rings) r.uniforms[name].value = v
}

const els = {}
let shellsOn = false
let wireOn = false

function buildPanel() {
  const preset = document.getElementById('preset')
  for (const [key, def] of Object.entries(PRESETS)) {
    const opt = document.createElement('option')
    opt.value = key
    opt.textContent = def.label
    preset.appendChild(opt)
  }
  preset.value = grass.presetName
  preset.addEventListener('change', () => {
    grass.setPreset(preset.value)
    // A new preset means new ring materials, so the dials that live on them
    // have to be pushed back out or the panel is lying about the scene.
    for (const [id, , , , , , get] of SLIDERS) {
      if (id === 'transmit' || id === 'cut' || id === 'lean') setSlider(id, get())
    }
    applyWire()
  })

  const host = document.getElementById('sliders')
  for (const [id, label, tip, min, max, step, get, set] of SLIDERS) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<label title="${tip.replace(/"/g, '&quot;')}">${label}</label>`
    const range = document.createElement('input')
    range.type = 'range'
    range.min = min
    range.max = max
    range.step = step
    range.value = get()
    const readout = document.createElement('span')
    readout.className = 'v'
    const show = () => {
      readout.textContent = step >= 1 ? String(Math.round(range.valueAsNumber)) : range.valueAsNumber.toFixed(step < 0.01 ? 4 : 2)
    }
    range.addEventListener('input', () => {
      set(range.valueAsNumber)
      show()
    })
    show()
    row.append(range, readout)
    host.appendChild(row)
    els[id] = { range, show, set, get }
  }

  toggle('grass', true, (on) => { grass.visible = on })
  toggle('clutter', true, (on) => { shared.clutter.value = on ? 1 : 0 })
  toggle('ripple', true, (on) => { shared.ripple.value = on ? 1 : 0 })
  toggle('shells', false, (on) => { shellsOn = on; ground.setShells(on, shared.shellCount.value) })
  toggle('wire', false, (on) => { wireOn = on; applyWire() })
  toggle('walk', false, (on) => { walking = on })

  document.getElementById('reset').addEventListener('click', () => location.reload())
}

function setSlider(id, v) {
  const s = els[id]
  if (!s) return
  s.range.value = v
  s.show()
}

function applyWire() {
  for (const level of ground.levels) level.mesh.material.wireframe = wireOn
  for (const ring of grass.rings) ring.material.wireframe = wireOn
}

function toggle(id, initial, apply) {
  const btn = document.getElementById(id)
  let on = initial
  btn.classList.toggle('on', on)
  btn.addEventListener('click', () => {
    on = !on
    btn.classList.toggle('on', on)
    apply(on)
  })
  apply(on)
}

// --- the numbers -------------------------------------------------------------
//
// Measured against src/v2/render/grass.js as reported by scripts/check-grass.mjs
// on the same 70 m radius. These are the shipped carpet's real figures, not an
// estimate, and they are the only reason the comparison on this page means
// anything.
const SHIPPED = {
  instances: 22353,
  triangles: 53400,
  calls: 1,
  cpuPerInstance: 0.82,
  cpuUpdate: 0.096,
}

const n = (v) => Math.round(v).toLocaleString()

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls = ''] ) => `<tr class="${cls}"><td class="k">${k}</td><td class="n">${v}</td></tr>`)
    .join('')
}

const frameEl = document.getElementById('frame')
const grassEl = document.getElementById('grassTable')
const grassNote = document.getElementById('grassNote')
const versusEl = document.getElementById('versus')
const groundEl = document.getElementById('groundTable')

let fps = 60
let cpuMs = 0
let hudAt = 0

function updateHud() {
  const info = renderer.info.render
  const g = grass.stats()
  const gr = ground.stats()

  table(frameEl, [
    ['fps', `<span class="big ${fps > 65 ? 'ok' : fps > 40 ? '' : 'warn'}">${fps.toFixed(0)}</span>`],
    ['frame ms (cpu)', cpuMs.toFixed(2)],
    ['gpu ms', gpuTimer.supported ? (gpuTimer.ms === null ? '--' : gpuTimer.ms.toFixed(2)) : 'unavailable'],
    ['draw calls', n(info.calls)],
    // renderer.info counts what was HANDED TO THE DRIVER -- instanceCount times
    // the index buffer -- so this is the submitted figure for the whole scene,
    // grass and clipmap and shells together. The grass table below splits out
    // what survives the vertex shader.
    ['triangles submitted', n(info.triangles)],
  ])

  table(grassEl, [
    ['ladder', g.preset, 'here'],
    ['rings / draws', `${g.rings} / ${g.calls}`],
    ['instances submitted', n(g.submitted)],
    ['instances drawn (est)', n(g.drawn)],
    ['triangles submitted', n(g.submittedTris)],
    ['triangles drawn (est)', n(g.drawnTris), 'here'],
    ['per-instance cpu', '<span class="ok">0.00 ms</span>', 'here'],
  ])
  const waste = 1 - g.drawn / Math.max(1, g.submitted)
  grassNote.innerHTML =
    `<em>Drawn</em> is analytic, not measured: the ring annulus over the grid square, with the thinning law integrated, and coverage deliberately left out -- so it over-estimates, which is the safe direction for a cost claim. The ${(waste * 100).toFixed(0)}% gap to <em>submitted</em> is the price of putting a round scatter on a square lattice; a rejected candidate costs one vertex invocation and no fill. It is much larger for <em>tufts</em>, and that is an artefact of making a GPU grid imitate a CPU thinning law, not a fact about the shipped scatter, which places exactly what it draws.`

  const triRatio = SHIPPED.triangles / Math.max(1, g.drawnTris)
  const instRatio = SHIPPED.instances / Math.max(1, g.drawn)
  versusEl.innerHTML = `
    <tr><td class="k"></td><td class="n">here</td><td class="n">shipped</td></tr>
    <tr class="here"><td class="k">instances</td><td class="n">${n(g.drawn)}</td><td class="n">${n(SHIPPED.instances)}</td></tr>
    <tr class="here"><td class="k">triangles</td><td class="n">${n(g.drawnTris)}</td><td class="n">${n(SHIPPED.triangles)}</td></tr>
    <tr><td class="k">draw calls</td><td class="n">${g.calls}</td><td class="n">${SHIPPED.calls}</td></tr>
    <tr class="here"><td class="k">cpu / frame</td><td class="n ok">0.00 ms</td><td class="n warn">${(SHIPPED.cpuPerInstance + SHIPPED.cpuUpdate).toFixed(2)} ms</td></tr>
    <tr><td class="k">ratio</td><td class="n" colspan="2">${instRatio.toFixed(1)}&times; instances, ${triRatio.toFixed(1)}&times; triangles</td></tr>`

  table(groundEl, [
    ['clipmap levels', String(ground.levels.length)],
    ['triangles', n(gr.tris)],
    ['reach', `${n(gr.reach)} m`],
    ['draw calls', String(gr.calls)],
    ['shell triangles', gr.shellTris ? `<span class="warn">${n(gr.shellTris)}</span>` : 'off'],
  ])
}

// --- frame -------------------------------------------------------------------

const clock = new THREE.Clock()
let smoothed = null

renderer.setAnimationLoop(() => {
  if (!ready) return
  const t0 = performance.now()
  const dt = Math.min(0.05, clock.getDelta())

  gpuTimer.begin()

  if (renderer.xr.isPresenting) {
    moveXR(dt)
  } else {
    moveDesktop(dt)
    camera.rotation.set(look.pitch, look.yaw, 0)
    camera.position.set(0, EYE, 0)
  }

  // Where the head is on the ground plane. The grass rings and the clipmap both
  // anchor to this, and it is the HEAD rather than either eye on purpose -- see
  // the billboarding note in grass-field.js.
  camera.getWorldPosition(_head)
  shared.camXZ.value.set(_head.x, _head.z)
  shared.time.value += dt

  ground.update(_head.x, _head.z)
  skyDome.position.set(_head.x, _head.y, _head.z)

  // The probe answers a frame or three late, so the height is eased toward
  // rather than snapped to -- otherwise a fast walk staircases.
  probe.request(renderer, _head.x, _head.z)
  if (probe.valid) groundY += (probe.height - groundY) * Math.min(1, dt * 12)
  if (walking) rig.position.y = groundY
  else rig.position.y = Math.max(rig.position.y, groundY + 0.6)

  renderer.render(scene, camera)
  gpuTimer.end()

  const ms = performance.now() - t0
  smoothed = smoothed === null ? ms : smoothed + (ms - smoothed) * 0.06
  cpuMs = smoothed
  fps = fps + (1 / Math.max(dt, 1e-4) - fps) * 0.06

  const now = performance.now()
  if (now - hudAt > 250) {
    hudAt = now
    updateHud()
  }
})

start().catch(bootFail)
