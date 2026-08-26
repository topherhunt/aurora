import * as THREE from 'three'

import { Stars } from './stars.js'
import { Backdrop } from './aurora-lab/backdrop.js'
import { AuroraScreen } from './aurora-lab/screen.js'
import { Sidebar } from './aurora-lab/ui/sidebar.js'
import {
  ALGORITHMS, DEFAULT_ALGORITHM, SCENE_GROUPS,
  algorithmById, groupsFor, paramsFor, defaultsFor,
} from './aurora-lab/algorithms.js'
import { BUILTIN_NAMES, builtinByName } from './aurora-lab/presets.js'

// ---------------------------------------------------------------------------
// The /test-aurora route: a rig for designing the aurora that replaces
// src/aurora.js.
//
// ===========================================================================
// WHAT THIS PAGE IS AND IS NOT
// ===========================================================================
//
// It is not a game mode and it is not a preview. It is a bench: a starfield, a
// nominal skyline, one quad carrying a raymarched aurora, and every knob that
// shader has exposed at once. The shipped aurora is untouched and still what
// index.html and /v2 draw; nothing here is wired into either until an algorithm
// wins and gets promoted.
//
// The reason it is a separate page rather than a mode inside /v2 is the cost of
// the question you come here to ask. That question is always "what does this one
// exponent do", and asking it inside the world means a terrain load, a document
// fetch and a walk to somewhere with a view, every time. Here it is a page
// reload and there is nothing in the scene but the sky.
//
// ===========================================================================
// WHY THE STATE LIVES IN ONE FLAT MAP
// ===========================================================================
//
// Every knob on the page -- shader uniforms, the time scale, the mountains, the
// star brightness -- is one entry in one `{key: value}` object, declared by one
// schema in aurora-lab/algorithms.js. That is what makes save, load, copy,
// paste, reset, randomize and the localStorage round-trip each about four lines
// instead of each being a list of fields that has to be extended every time a
// knob is added, and forgotten in two of the seven places.
//
// The routing below is the price: a param either drives a uniform, or drives the
// backdrop, or drives this file, and something has to know which. It is one
// lookup against the schema, and the schema's `uniform: false` flag is what
// carries it. Note what is NOT possible: a param that no route claims. It
// throws, loudly, at the moment you touch it, rather than being a slider that
// moves and does nothing.
//
// ===========================================================================
// THE CAMERA IS A TURNTABLE, NOT A PLAYER
// ===========================================================================
//
// Drag to look, wheel to zoom, and that is all -- there is no walking. This is
// deliberate. The aurora is sky-locked (see the header of glsl/frame.js): at 100
// km altitude, crossing the entire 16 km world moves a channel by under five
// degrees, so translation is very nearly a no-op and a WASD rig here would
// simply invite the wrong conclusion about parallax. What DOES change the
// picture is heading, pitch and field of view, so those are what the page gives
// you.
// ---------------------------------------------------------------------------

const STORE = 'aurora-lab.state.v1'
const PRESETS = 'aurora-lab.presets.v1'

// The star field turns on the clock's monotonic hours. A whole revolution in
// eight minutes of wall clock: fast enough that you can see the sky is not a
// painted backdrop, slow enough that it is never what you are looking at.
const HOURS_PER_SECOND = 24 / 480

const panelEl = document.getElementById('panel')
const stageEl = document.getElementById('stage')
const bootEl = document.getElementById('boot')
const shaderEl = document.getElementById('shader')

// ---------------------------------------------------------------------------
// Boot. Everything below the try is a hard failure -- a lab that comes up with
// half a scene and no message is worse than one that does not come up, because
// the half that is missing is exactly the half you were about to judge.

try {
  main()
} catch (err) {
  bootEl.innerHTML = ''
  const pre = document.createElement('pre')
  pre.textContent = String(err && err.stack ? err.stack : err)
  bootEl.append('the lab failed to start', pre)
  throw err
}

function main() {
  // ---- renderer ------------------------------------------------------------

  const renderer = new THREE.WebGLRenderer({
    // The mountains are a hard `discard` silhouette against a starfield, which
    // is the one edge on this page that aliases visibly. The sky itself is
    // smooth everywhere and gains nothing from MSAA.
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x000000, 1)
  stageEl.appendChild(renderer.domElement)

  const scene = new THREE.Scene()

  // Far plane past the stars at 15000. The near plane is nowhere near anything
  // -- there is no geometry within 1500 units -- so it is set for the depth
  // precision the mountain silhouette needs and not for a first-person body.
  const camera = new THREE.PerspectiveCamera(62, 1, 1, 40000)
  camera.position.set(0, 1.7, 0)

  // ---- state ---------------------------------------------------------------

  const saved = loadJSON(STORE)
  let algorithmId = saved && saved.algorithm ? saved.algorithm : DEFAULT_ALGORITHM
  // A stored id from a schema that has since lost that algorithm must not brick
  // the page -- fall back and say so, rather than throwing on boot.
  if (!ALGORITHMS.some(a => a.id === algorithmId)) {
    console.warn('aurora-lab: stored algorithm "' + algorithmId + '" no longer exists')
    algorithmId = DEFAULT_ALGORITHM
  }

  const values = defaultsFor(algorithmId)
  if (saved && saved.values) {
    for (const k of Object.keys(saved.values)) {
      if (k in values) values[k] = saved.values[k]
    }
  }

  // ---- the scene's three objects ------------------------------------------

  const stars = new Stars(scene, { seed: 7, pixelRatio: window.devicePixelRatio })
  const backdrop = new Backdrop(scene, backdropOptsFrom(values))
  const screen = new AuroraScreen(scene, { algorithm: algorithmId, values })

  // ---- param routing -------------------------------------------------------

  const backdropKeys = new Set(SCENE_GROUPS
    .filter(g => g.title === 'Mountains')
    .flatMap(g => g.params.map(p => p.key)))

  // Scene params this file owns. Each is applied on the spot rather than read
  // out of `values` in the frame loop, so the loop stays a loop and there is one
  // place per knob that knows what it does.
  const sceneApply = {
    timeScale: () => {},
    fov: (v) => { camera.fov = v; camera.updateProjectionMatrix() },
    resScale: (v) => resize(v),
    stars: () => {},
  }

  function applyParam(key, value) {
    values[key] = value
    if (backdropKeys.has(key)) { backdrop.set(key, value); return }
    if (key in sceneApply) { sceneApply[key](value); return }
    // Anything left must be a shader uniform. setParam throws if it is not,
    // which is the point: a key no route claims is a bug in the schema, and it
    // should surface the first time the slider moves rather than never.
    screen.setParam(key, value)
  }

  function applyAll() {
    for (const p of paramsFor(algorithmId)) applyParam(p.key, values[p.key])
  }

  // ---- sidebar -------------------------------------------------------------

  const sidebar = new Sidebar(panelEl, {
    algorithms: ALGORITHMS,
    onAlgorithm: (id) => switchAlgorithm(id),
    onParam: (key, value) => { applyParam(key, value); saveState() },
    onAction: (name) => action(name),
  })
  sidebar.setAlgorithm(algorithmId)
  sidebar.setBlurb(algorithmById(algorithmId).blurb)
  sidebar.setGroups(groupsFor(algorithmId), values)
  refreshPresets()
  applyAll()

  function switchAlgorithm(id) {
    screen.setAlgorithm(id)
    algorithmId = id
    // The screen is the authority on what survived the switch -- it carries
    // shared knobs across and takes the new algorithm's own defaults and
    // overrides for the rest. Recomputing that here would be a second copy of
    // the rule, and the two would drift.
    for (const k of Object.keys(values)) delete values[k]
    Object.assign(values, screen.values)
    sidebar.setBlurb(algorithmById(id).blurb)
    sidebar.setGroups(groupsFor(id), values)
    applyAll()
    saveState()
  }

  // ---- actions -------------------------------------------------------------

  let paused = false
  let stepOnce = false

  function action(name) {
    if (name.startsWith('preset:')) { loadPreset(name.slice(7)); return }

    switch (name) {
      case 'reset': {
        const d = defaultsFor(algorithmId)
        Object.assign(values, d)
        sidebar.setValues(d)
        applyAll()
        saveState()
        sidebar.flash('back to the algorithm as written')
        break
      }

      case 'randomize': {
        // Only this algorithm's OWN knobs, never the shared ones. Rolling all
        // sixty gives a black screen roughly nine times in ten -- exposure,
        // altitudes and the deposition curve have narrow windows where anything
        // is visible at all -- and a randomizer whose usual result is "nothing"
        // gets pressed twice and then never again.
        const rolled = {}
        for (const g of algorithmById(algorithmId).groups) {
          for (const p of g.params) {
            if (p.type !== 'float') continue
            rolled[p.key] = roundTo(p.min + Math.random() * (p.max - p.min), p.step)
          }
        }
        Object.assign(values, rolled)
        sidebar.setValues(rolled)
        for (const k of Object.keys(rolled)) applyParam(k, rolled[k])
        saveState()
        sidebar.flash('rolled ' + Object.keys(rolled).length + ' knobs')
        break
      }

      case 'copy':
        writeClipboard(JSON.stringify({ algorithm: algorithmId, values }, null, 2))
          .then(() => sidebar.flash('tuning copied'))
          .catch(() => sidebar.flash('clipboard refused'))
        break

      case 'paste':
        readClipboard()
          .then(text => {
            const blob = JSON.parse(text)
            adopt(blob)
            sidebar.flash('pasted')
          })
          .catch(err => sidebar.flash('paste failed: ' + err.message))
        break

      case 'shader':
        shaderEl.querySelector('pre').textContent = screen.fragmentSource()
        shaderEl.classList.add('open')
        break

      case 'pause':
        paused = !paused
        sidebar.setPaused(paused)
        break

      case 'step':
        stepOnce = true
        break

      case 'savePreset': {
        const name = window.prompt('name this tuning')
        if (!name) break
        // A builtin is a fixed point you compare against. Letting a save shadow
        // one would mean the reference silently became whatever was last on the
        // panel, which is precisely the failure the builtins exist to prevent.
        if (BUILTIN_NAMES.includes(name)) {
          sidebar.flash('"' + name + '" is a builtin -- pick another name')
          break
        }
        const all = loadJSON(PRESETS) || {}
        all[name] = { algorithm: algorithmId, values: { ...values } }
        localStorage.setItem(PRESETS, JSON.stringify(all))
        refreshPresets(name)
        sidebar.flash('saved "' + name + '"')
        break
      }

      case 'deletePreset': {
        const all = loadJSON(PRESETS) || {}
        const names = Object.keys(all)
        if (names.length === 0) { sidebar.flash('no presets'); break }
        const name = window.prompt('delete which preset?', names[names.length - 1])
        if (!name) break
        // Builtins are not in `all` at all, so they are already undeletable --
        // but silently doing nothing looks like a broken button, so say why.
        if (BUILTIN_NAMES.includes(name)) { sidebar.flash('"' + name + '" is a builtin'); break }
        if (!(name in all)) { sidebar.flash('no preset "' + name + '"'); break }
        delete all[name]
        localStorage.setItem(PRESETS, JSON.stringify(all))
        refreshPresets()
        sidebar.flash('deleted "' + name + '"')
        break
      }

      default:
        // A button whose name nothing handles is a button that does nothing, and
        // the sidebar's own header makes the same argument about silent
        // controls. Say so rather than falling through.
        throw new Error('test-aurora: unhandled action "' + name + '"')
    }
  }

  // Take a {algorithm, values} blob from a preset or the clipboard. Unknown keys
  // are dropped with a warning rather than thrown on: a tuning saved before a
  // knob was renamed should still mostly load, and the alternative is that one
  // rename bricks every preset anyone kept.
  function adopt(blob) {
    if (blob.algorithm && blob.algorithm !== algorithmId) {
      if (!ALGORITHMS.some(a => a.id === blob.algorithm)) {
        throw new Error('no algorithm "' + blob.algorithm + '"')
      }
      switchAlgorithm(blob.algorithm)
    }
    const accepted = {}
    const dropped = []
    for (const k of Object.keys(blob.values || {})) {
      if (k in values) accepted[k] = blob.values[k]
      else dropped.push(k)
    }
    if (dropped.length) console.warn('aurora-lab: dropped unknown params', dropped)
    Object.assign(values, accepted)
    sidebar.setValues(accepted)
    for (const k of Object.keys(accepted)) applyParam(k, accepted[k])
    saveState()
  }

  // Builtins first, because they are the ones checked in and the ones anything
  // else is judged against. A saved name can never collide with one -- savePreset
  // refuses it -- so the lookup order here is a preference, not a rule.
  function loadPreset(name) {
    const builtin = builtinByName(name)
    if (builtin) {
      adopt(builtin)
      sidebar.flash('loaded "' + name + '" -- ' + builtin.note)
      return
    }
    const all = loadJSON(PRESETS) || {}
    if (!all[name]) { sidebar.flash('no preset "' + name + '"'); return }
    adopt(all[name])
    sidebar.flash('loaded "' + name + '"')
  }

  function refreshPresets(selected) {
    const saved = Object.keys(loadJSON(PRESETS) || {})
    sidebar.setPresets([ ...BUILTIN_NAMES, ...saved ], selected)
  }

  function saveState() {
    localStorage.setItem(STORE, JSON.stringify({ algorithm: algorithmId, values }))
  }

  // ---- look controls -------------------------------------------------------

  let yaw = Math.PI            // facing -z, which is north, which is where the belt is
  let pitch = 0.22
  let dragging = false
  let lastX = 0
  let lastY = 0

  renderer.domElement.addEventListener('pointerdown', (ev) => {
    dragging = true
    lastX = ev.clientX
    lastY = ev.clientY
    renderer.domElement.setPointerCapture(ev.pointerId)
  })
  renderer.domElement.addEventListener('pointerup', (ev) => {
    dragging = false
    renderer.domElement.releasePointerCapture(ev.pointerId)
  })
  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (!dragging) return
    yaw -= (ev.clientX - lastX) * 0.004
    // Clamped short of straight up: at the pole the yaw axis and the view axis
    // coincide and dragging sideways stops doing anything, which reads as the
    // controls having jammed.
    pitch = clamp(pitch - (ev.clientY - lastY) * 0.004, -0.6, 1.45)
    lastX = ev.clientX
    lastY = ev.clientY
  })
  renderer.domElement.addEventListener('wheel', (ev) => {
    ev.preventDefault()
    const next = clamp(values.fov + Math.sign(ev.deltaY) * 2, 25, 110)
    values.fov = next
    sidebar.setValue('fov', next)
    sceneApply.fov(next)
    saveState()
  }, { passive: false })

  shaderEl.querySelector('.close').onclick = () => shaderEl.classList.remove('open')

  window.addEventListener('keydown', (ev) => {
    if (ev.key === ' ') { ev.preventDefault(); action('pause') }
    else if (ev.key === '.') action('step')
    else if (ev.key === 'h') panelEl.hidden = !panelEl.hidden
    else if (ev.key === 'Escape') shaderEl.classList.remove('open')
    else return
    // Only reached when a key was handled, so an unhandled key still reaches
    // the sidebar's own inputs.
    if (ev.key === 'h') requestAnimationFrame(() => resize(values.resScale))
  })

  // ---- resize --------------------------------------------------------------

  function resize(scaleParam) {
    const s = scaleParam === undefined ? values.resScale : scaleParam
    const w = stageEl.clientWidth
    const h = stageEl.clientHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * s)
    // Star point size is in FRAMEBUFFER pixels, so it has to track the
    // framebuffer or dropping the render scale silently magnifies every star.
    // Read it back off the renderer rather than recomputing the expression
    // above, so the two can never drift apart.
    stars.setPixelRatio(renderer.getPixelRatio())
    renderer.setSize(w, h, false)
    renderer.domElement.style.width = w + 'px'
    renderer.domElement.style.height = h + 'px'
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', () => resize())
  resize()

  // ---- frame ---------------------------------------------------------------

  const clock = new THREE.Clock()
  let shaderTime = 0
  let fpsAccum = 0
  let fpsFrames = 0
  let fps = 0
  let statTimer = 0
  const head = new THREE.Vector3()

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1)

    // Pause freezes the SHADER's clock, not the render loop: the camera must
    // stay draggable so you can walk around a frozen sky and look at what the
    // last change actually did. That is most of what pause is for.
    const running = !paused || stepOnce
    if (running) shaderTime += dt * values.timeScale
    stepOnce = false

    camera.quaternion.setFromEuler(_euler.set(pitch, yaw, 0, 'YXZ'))
    camera.getWorldPosition(head)

    backdrop.update(head)
    stars.update(head, { stars: values.stars }, shaderTime * HOURS_PER_SECOND, shaderTime)
    screen.update(camera, shaderTime)

    renderer.render(scene, camera)

    fpsAccum += dt
    fpsFrames++
    statTimer += dt
    if (statTimer > 0.5) {
      fps = fpsFrames / fpsAccum
      fpsAccum = 0
      fpsFrames = 0
      statTimer = 0
      const info = renderer.info.render
      sidebar.setStats({
        fps: Math.round(fps),
        ms: 1000 / fps,
        // The one number that predicts the cost of this shader anywhere else.
        // At 40 steps a full-screen 1080p quad is ~83 million field evaluations
        // a frame, and the headset has to do it twice.
        'field evals/frame': Math.round(
          renderer.domElement.width * renderer.domElement.height * values.steps / 1e6
        ) + 'M',
        steps: values.steps,
        calls: info.calls,
        tris: info.triangles,
        px: renderer.domElement.width + 'x' + renderer.domElement.height,
      })
    }

    if (!bootEl.classList.contains('gone')) bootEl.classList.add('gone')
  })
}

// ---------------------------------------------------------------------------

const _euler = new THREE.Euler()

function backdropOptsFrom(values) {
  const out = {}
  for (const g of SCENE_GROUPS) {
    if (g.title !== 'Mountains') continue
    for (const p of g.params) out[p.key] = values[p.key]
  }
  return out
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function roundTo(v, step) {
  return Math.round(v / step) * step
}

function loadJSON(key) {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (err) {
    // Corrupt storage is recoverable and a hard throw here would leave the page
    // permanently unable to boot until someone cleared it by hand from a
    // console they would first have to know to open.
    console.warn('aurora-lab: discarding unreadable "' + key + '"', err)
    localStorage.removeItem(key)
    return null
  }
}

function writeClipboard(text) {
  if (!navigator.clipboard) return Promise.reject(new Error('no clipboard API'))
  return navigator.clipboard.writeText(text)
}

function readClipboard() {
  if (!navigator.clipboard) return Promise.reject(new Error('no clipboard API'))
  return navigator.clipboard.readText()
}
