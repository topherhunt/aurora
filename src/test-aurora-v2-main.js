import * as THREE from 'three'

import { Stars } from './stars.js'
import { Backdrop } from './aurora-lab/backdrop.js'
import { GpuTimer } from './aurora-lab/gpu-timer.js'
import { Sidebar } from './aurora-lab/ui/sidebar.js'
import { AuroraCards } from './aurora-cards/curtains.js'
import { CARD_GROUPS, SCENE_GROUPS, allGroups, allParams, defaults, REBUILD_KEYS } from './aurora-cards/params.js'
import { BUILTIN_PRESETS } from './aurora-cards/presets.js'

// ---------------------------------------------------------------------------
// The /test-aurora-v2 route: the bench for the GEOMETRY aurora.
//
// ===========================================================================
// WHY THIS IS A SECOND PAGE AND NOT A SECOND ALGORITHM ON /test-aurora
// ===========================================================================
//
// The raymarch lab's algorithm picker switches between things that differ only in the body of one fragment shader: same quad, same uniforms, same cost model, same "how many field evaluations per pixel" question. Nothing structural changes when you move between them, which is exactly what makes that picker cheap and honest.
//
// This aurora is not one of those. It is not a screen-space shader at all: the curves are found on the CPU by marching squares over a scalar field, turned into polylines, and hung with instanced billboards, so its cost is vertices and overdraw rather than steps per pixel, and its expensive operation is a re-trace that happens between frames rather than during one. Putting it behind the same picker would mean a page whose stats panel means two different things depending on a dropdown, and whose "randomize" has to know that half the knobs cost a millisecond and the other half cost a hundred. Two pages, each honest about one technique, is the cheaper arrangement.
//
// What IS shared is everything that is not the aurora: the sidebar, the mountain backdrop, the starfield, the GPU timer. Those are imported from their existing homes under aurora-lab/ rather than copied, so a fix to the panel lands on both benches at once.
//
// ===========================================================================
// THE STATE IS ONE FLAT MAP, AS IT IS NEXT DOOR
// ===========================================================================
//
// Every knob -- the trace's grid, the card geometry, the shader's tints, the mountains, the star brightness -- is one entry in one `{key: value}` object declared by one schema in aurora-cards/params.js. Save, load, copy, paste, reset, randomize and the localStorage round-trip are each a few lines because of that, instead of each being a list of fields that has to be extended every time a knob is added and is forgotten in two of the seven places.
//
// The price is the routing below: a param either belongs to the aurora, or to the backdrop, or to this file, and something has to know which. That is one lookup against the schema. Note what is NOT possible: a param that no route claims. It throws, at boot, rather than being a slider that moves and does nothing.
//
// ===========================================================================
// SOME KNOBS COST A RE-TRACE, AND THE PANEL HAS TO SAY SO
// ===========================================================================
//
// REBUILD_KEYS is the set whose change forces the CPU work again. AuroraCards handles the re-trace itself, so nothing here has to sequence it -- but the numbers in the footer (cards, triangles, components) are OUTPUTS of that trace and go stale the instant it reruns. So a rebuild key arms `statsDue` and the footer is redrawn on the next frame rather than up to half a second later, because the half second is exactly when you are looking to see what the knob you just moved did to the card count.
//
// The randomizer is the other place this shows up: it rolls `uniform: true` floats ONLY. Rolling the grid resolution or the span would re-trace on every click, which turns a button you press ten times in a row into a button you press once.
//
// ===========================================================================
// THE CAMERA IS A TURNTABLE, NOT A PLAYER
// ===========================================================================
//
// Drag to look, wheel to zoom, no walking -- same as the raymarch lab, and for the same reason: the aurora sits tens of thousands of units out, so crossing the whole world moves it by a fraction of a degree and a WASD rig here would only invite the wrong conclusion about parallax. Heading, pitch and field of view are what change the picture, so those are what the page gives you.
// ---------------------------------------------------------------------------

const STORE = 'aurora-cards.state.v1'
const PRESETS = 'aurora-cards.presets.v1'

// The star field turns on the clock's monotonic hours. A whole revolution in eight minutes of wall clock: fast enough that you can see the sky is not a painted backdrop, slow enough that it is never what you are looking at.
const HOURS_PER_SECOND = 24 / 480

// The sidebar builds itself from an algorithm list and there is exactly one technique on this page, so the picker is a nameplate. It stays because the Sidebar's constructor requires the list, and because the blurb slot under it is the only place on the panel that can say what you are looking at.
const ONLY_ALGORITHM = {
  id: 'cards',
  name: 'ley-line glow cards',
  blurb: 'Contours traced through a scalar field, hung with instanced billboards. Branching comes from the field, not from a parameter.',
}

const panelEl = document.getElementById('panel')
const stageEl = document.getElementById('stage')
const bootEl = document.getElementById('boot')
const shaderEl = document.getElementById('shader')

// ---------------------------------------------------------------------------
// Boot. Everything below the try is a hard failure -- a bench that comes up with half a scene and no message is worse than one that does not come up, because the half that is missing is exactly the half you were about to judge.

try {
  main()
} catch (err) {
  bootEl.innerHTML = ''
  const pre = document.createElement('pre')
  pre.textContent = String(err && err.stack ? err.stack : err)
  bootEl.append('the card lab failed to start', pre)
  throw err
}

function main() {
  // ---- renderer ------------------------------------------------------------

  const renderer = new THREE.WebGLRenderer({
    // The mountains are a hard `discard` silhouette against a starfield, which is the one edge on this page that aliases visibly. The cards themselves are soft-edged everywhere and gain nothing from MSAA.
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x000000, 1)
  stageEl.appendChild(renderer.domElement)

  const scene = new THREE.Scene()

  // The near and far planes have to straddle three very different distances: the backdrop cap at 1500, the starfield at 15000, and the cards themselves out to roughly 30000. Far at 40000 clears all of it with room to spare. Near at 1 is not chosen for a first-person body -- there is no geometry within 1500 units -- it is chosen for the depth precision the mountain silhouette needs where it cuts across the aurora.
  const camera = new THREE.PerspectiveCamera(62, 1, 1, 40000)
  camera.position.set(0, 1.7, 0)

  // ---- state ---------------------------------------------------------------

  const values = defaults()
  const saved = loadJSON(STORE)
  if (saved && saved.values) {
    for (const k of Object.keys(saved.values)) {
      if (k in values) values[k] = saved.values[k]
    }
  }

  // Armed whenever the footer's numbers may have gone stale ahead of the usual half-second tick, which is every re-trace. Declared up here because applyAll() below runs during construction and can arm it before the frame loop's own counters exist.
  let statsDue = true

  // ---- the scene's three objects ------------------------------------------

  const stars = new Stars(scene, { seed: 7, pixelRatio: window.devicePixelRatio })
  const backdrop = new Backdrop(scene, backdropOptsFrom(values))

  // ---- the clock -----------------------------------------------------------
  //
  // Two regions, and the timer alternates between them because a GL context has one TIME_ELAPSED query at a time (see gpu-timer.js). `aurora` is the card mesh's own draw; `frame` is every GL command the loop issues, so `frame - aurora` is what the stars and the mountains cost. Read `frame` against `ms` from the fps counter: when they diverge badly the page is CPU-bound or vsync-bound and no change to the cards will move it, which is exactly the conclusion an fps counter alone hides.
  //
  // This matters more here than on the raymarch bench, because the failure mode of a billboard aurora is OVERDRAW -- thousands of large, screen-blended, mostly transparent quads stacked on the same pixels -- and overdraw is invisible in a still frame and invisible in a triangle count. `aurora ms` against the card count in the same footer is the only pairing that shows it.
  const timer = new GpuTimer(renderer, { regions: ['aurora', 'frame'] })

  const cards = new AuroraCards(scene, { values })

  // The mesh's own render hooks are the only place that can bracket exactly this one draw call and nothing else in the frame. They are safe to leave armed unconditionally because the card mesh sets `frustumCulled = false`: an object that is skipped by culling fires neither hook, which would be balanced but would also quietly stop the region from ever resolving a sample.
  cards.mesh.onBeforeRender = () => timer.begin('aurora')
  cards.mesh.onAfterRender = () => timer.end('aurora')

  // ---- param routing -------------------------------------------------------

  const cardKeys = keysOf(CARD_GROUPS)
  const backdropKeys = keysOf(SCENE_GROUPS.filter(g => g.title === 'Mountains'))
  const sceneKeys = keysOf(SCENE_GROUPS.filter(g => g.title === 'Scene'))

  // Scene params this file owns. Each is applied on the spot rather than read out of `values` in the frame loop, so the loop stays a loop and there is one place per knob that knows what it does. `timeScale` and `stars` are read by the loop directly and so have nothing to do here, but they are listed rather than left out: a key in the Scene group with no entry here throws below, and that check is worth more than the two empty functions cost.
  const sceneApply = {
    timeScale: () => {},
    fov: (v) => { camera.fov = v; camera.updateProjectionMatrix() },
    stars: () => {},
  }

  // Everything that is not the aurora's own. Split out from applyParam so that the bulk path below can batch the card keys into ONE setValues call -- see applyMany.
  function routeOther(key, value) {
    if (backdropKeys.has(key)) { backdrop.set(key, value); return }
    if (sceneKeys.has(key)) {
      // A Scene knob this file has no handler for is a slider that moves and does nothing, which is the precise failure the schema exists to prevent.
      if (!(key in sceneApply)) throw new Error('test-aurora-v2: scene param "' + key + '" has no handler')
      sceneApply[key](value)
      return
    }
    throw new Error('test-aurora-v2: no route claims param "' + key + '"')
  }

  function applyParam(key, value) {
    values[key] = value
    if (cardKeys.has(key)) {
      // AuroraCards.set re-traces by itself when the key is a rebuild key. All this has to do is notice, so the footer's card and triangle counts are redrawn against the geometry that now exists.
      cards.set(key, value)
      if (REBUILD_KEYS.has(key)) statsDue = true
      return
    }
    routeOther(key, value)
  }

  // The bulk path, for reset, randomize, paste and preset load. It exists for one reason: a re-trace is CPU work measured in milliseconds, and applying a forty-key preset one key at a time would run it once per rebuild key in the preset. setValues re-traces once for the whole batch.
  function applyMany(obj) {
    const batch = {}
    let batched = false
    for (const key of Object.keys(obj)) {
      const value = obj[key]
      values[key] = value
      if (cardKeys.has(key)) {
        batch[key] = value
        batched = true
        if (REBUILD_KEYS.has(key)) statsDue = true
      } else {
        routeOther(key, value)
      }
    }
    if (batched) cards.setValues(batch)
  }

  function applyAll() {
    const all = {}
    for (const p of allParams()) all[p.key] = values[p.key]
    applyMany(all)
  }

  // ---- sidebar -------------------------------------------------------------

  const sidebar = new Sidebar(panelEl, {
    algorithms: [ONLY_ALGORITHM],
    // There is one entry in the list, so this can only ever fire with that id. If it fires with anything else the schema and the picker have come apart, and a silent return would leave the panel claiming a technique the stage is not running.
    onAlgorithm: (id) => {
      if (id !== ONLY_ALGORITHM.id) throw new Error('test-aurora-v2: no algorithm "' + id + '"')
    },
    onParam: (key, value) => { applyParam(key, value); saveState() },
    onAction: (name) => action(name),
  })
  sidebar.setAlgorithm(ONLY_ALGORITHM.id)
  sidebar.setBlurb(ONLY_ALGORITHM.blurb)
  sidebar.setGroups(allGroups(), values)
  refreshPresets()
  applyAll()

  // ---- actions -------------------------------------------------------------

  let paused = false
  let stepOnce = false

  function action(name) {
    if (name.startsWith('preset:')) { loadPreset(name.slice(7)); return }

    switch (name) {
      case 'reset': {
        const d = defaults()
        Object.assign(values, d)
        sidebar.setValues(d)
        applyMany(d)
        saveState()
        sidebar.flash('back to the aurora as written')
        break
      }

      case 'randomize': {
        // `uniform: true` floats ONLY. Two reasons, and the second is the one that decides it. The first is the raymarch lab's: rolling every knob gives a black screen most of the time, and a randomizer whose usual result is "nothing" gets pressed twice and then never again. The second is that the trace's own knobs -- grid resolution, span, level count -- are in REBUILD_KEYS, so rolling them means a full CPU re-trace on every click of a button that is meant to be mashed.
        const rolled = {}
        for (const p of allParams()) {
          if (p.type !== 'float' || p.uniform !== true) continue
          rolled[p.key] = roundTo(p.min + Math.random() * (p.max - p.min), p.step)
        }
        Object.assign(values, rolled)
        sidebar.setValues(rolled)
        applyMany(rolled)
        saveState()
        sidebar.flash('rolled ' + Object.keys(rolled).length + ' knobs')
        break
      }

      case 'copy':
        writeClipboard(JSON.stringify({ values }, null, 2))
          .then(() => sidebar.flash('tuning copied'))
          .catch(() => sidebar.flash('clipboard refused'))
        break

      case 'paste':
        readClipboard()
          .then(text => {
            adopt(JSON.parse(text))
            sidebar.flash('pasted')
          })
          .catch(err => sidebar.flash('paste failed: ' + err.message))
        break

      case 'shader': {
        // Both halves, labelled. The vertex shader is where a card is turned to face the eye and where the whole mesh is sky-locked, so the fragment source alone would show the colour and hide the geometry.
        const m = cards.material
        shaderEl.querySelector('pre').textContent =
          '// ======== vertex ========\n\n' + m.vertexShader +
          '\n\n// ======== fragment ========\n\n' + m.fragmentShader
        shaderEl.classList.add('open')
        break
      }

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
        // A builtin is a fixed point you compare against. Letting a save shadow one would mean the reference silently became whatever was last on the panel, which is precisely the failure the builtins exist to prevent.
        if (name in BUILTIN_PRESETS) {
          sidebar.flash('"' + name + '" is a builtin -- pick another name')
          break
        }
        const all = loadJSON(PRESETS) || {}
        all[name] = { values: { ...values } }
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
        // Builtins are not in `all` at all, so they are already undeletable -- but silently doing nothing looks like a broken button, so say why.
        if (name in BUILTIN_PRESETS) { sidebar.flash('"' + name + '" is a builtin'); break }
        if (!(name in all)) { sidebar.flash('no preset "' + name + '"'); break }
        delete all[name]
        localStorage.setItem(PRESETS, JSON.stringify(all))
        refreshPresets()
        sidebar.flash('deleted "' + name + '"')
        break
      }

      default:
        // A button whose name nothing handles is a button that does nothing, and the sidebar's own header makes the same argument about silent controls. Say so rather than falling through.
        throw new Error('test-aurora-v2: unhandled action "' + name + '"')
    }
  }

  // Take a {values} blob from a preset or the clipboard. A missing `values` is a hard error: there is nothing to apply and pretending otherwise leaves the panel claiming it pasted something. Unknown KEYS inside it are a different case and are dropped with a warning, because a tuning saved before a knob was renamed should still mostly load and the alternative is that one rename bricks every preset anyone kept. It is also what stops a tuning copied from /test-aurora, whose keys are almost entirely different, from throwing here.
  function adopt(blob) {
    if (!blob || typeof blob !== 'object' || !blob.values) {
      throw new Error('not a card-aurora tuning: no "values"')
    }
    const accepted = {}
    const dropped = []
    for (const k of Object.keys(blob.values)) {
      if (k in values) accepted[k] = blob.values[k]
      else dropped.push(k)
    }
    if (dropped.length) console.warn('aurora-cards: dropped unknown params', dropped)
    Object.assign(values, accepted)
    sidebar.setValues(accepted)
    applyMany(accepted)
    saveState()
    if (dropped.length) sidebar.flash('skipped ' + dropped.length + ' unknown knobs -- see the console')
  }

  // Builtins first, because they are the ones checked in and the ones anything else is judged against. A saved name can never collide with one -- savePreset refuses it -- so the lookup order here is a preference, not a rule.
  function loadPreset(name) {
    if (name in BUILTIN_PRESETS) {
      adopt(BUILTIN_PRESETS[name])
      sidebar.flash('loaded "' + name + '"')
      return
    }
    const all = loadJSON(PRESETS) || {}
    if (!all[name]) { sidebar.flash('no preset "' + name + '"'); return }
    adopt(all[name])
    sidebar.flash('loaded "' + name + '"')
  }

  function refreshPresets(selected) {
    const mine = Object.keys(loadJSON(PRESETS) || {})
    sidebar.setPresets([ ...Object.keys(BUILTIN_PRESETS), ...mine ], selected)
  }

  function saveState() {
    localStorage.setItem(STORE, JSON.stringify({ values }))
  }

  // ---- look controls -------------------------------------------------------

  // Facing -z, which is north, which is where the belt is. Zero is not a placeholder and PI is not the fix: the quaternion below is built from `_euler.set(pitch, yaw, 0, 'YXZ')`, and under that order a yaw of zero looks down -z while PI looks down +z. -z is north here because the belt is centred at plan z = `beltOffset` and that param's default is negative (see its hint in params.js: "Negative is north"). The page opens pointed at it on purpose -- the aurora is confined to the northern sky rather than filling it, so booting at any other heading opens the bench on empty stars and reads as a broken trace.
  let yaw = 0
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
    // Clamped short of straight up: at the pole the yaw axis and the view axis coincide and dragging sideways stops doing anything, which reads as the controls having jammed.
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
    // Only reached when a key was handled, so an unhandled key still reaches the sidebar's own inputs. Hiding the panel changes the stage's width, and the canvas only learns that from a resize.
    if (ev.key === 'h') requestAnimationFrame(() => resize())
  })

  // ---- resize --------------------------------------------------------------

  // There is no render-scale knob on this page, and it is not an omission. The raymarch bench needs one because its cost is fragments and dropping the resolution is the only way to keep a heavy tuning interactive; this aurora's cost is vertices and overdraw, so a half-resolution buffer buys far less and costs the one thing a card aurora has to be judged at full resolution for -- whether the thin end of a card resolves at all or dissolves into stipple.
  function resize() {
    const w = stageEl.clientWidth
    const h = stageEl.clientHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // Star point size is in FRAMEBUFFER pixels, so it has to track the framebuffer or a device-pixel-ratio change silently resizes every star. Read it back off the renderer rather than recomputing the expression above, so the two can never drift apart.
    stars.setPixelRatio(renderer.getPixelRatio())
    renderer.setSize(w, h, false)
    renderer.domElement.style.width = w + 'px'
    renderer.domElement.style.height = h + 'px'
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', resize)
  resize()

  // ---- frame ---------------------------------------------------------------

  const clock = new THREE.Clock()
  let shaderTime = 0
  let fpsAccum = 0
  let fpsFrames = 0
  let fps = 0
  let statTimer = 0
  const head = new THREE.Vector3()

  function pushStats() {
    const info = renderer.info.render
    const s = cards.stats
    sidebar.setStats({
      fps: Math.round(fps),
      ms: 1000 / fps,
      // Two decimals, formatted here rather than left to the sidebar, whose fmtStat rounds to one -- and the difference between a sky that costs 0.3 ms and one that costs 0.34 is the difference between two card budgets.
      'aurora ms': fmtMs(timer.median('aurora')),
      'frame ms': fmtMs(timer.median('frame')),
      // Never omitted and never abbreviated to something that could pass for a GPU reading. `cpu-sync` means this browser has no GPU timer and these are gl.finish() intervals: correct for ranking two tunings against each other, biased high in absolute terms, and not a number to quote as "the aurora costs X on this GPU".
      timer: timer.mode,
      cards: s.cards,
      // The card mesh's own triangles, from the aurora, beside the renderer's total below. The gap between the two is the backdrop cap and the starfield, and that gap is constant -- so a moving gap means something else started drawing.
      'card tris': s.tris,
      // How many separate curves the trace found. This is the number that says whether the field is doing the thing this technique exists for: a component count that moves as the field morphs is branching, and a component count pinned to the level count is a mesh with extra steps.
      components: s.components,
      levels: s.levels,
      km: Math.round(s.totalKm),
      // CPU milliseconds, not GPU. It is spent between frames, so it never shows up in `frame ms`, and it is the entire cost of every knob in REBUILD_KEYS.
      'trace ms': fmtMs(s.traceMs),
      calls: info.calls,
      tris: info.triangles,
      px: renderer.domElement.width + 'x' + renderer.domElement.height,
    })
  }

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1)

    // Pause freezes the AURORA's clock, not the render loop: the camera must stay draggable so you can walk around a frozen sky and look at what the last change actually did. That is most of what pause is for, and it is worth more here than on the raymarch bench, because the thing you most often want to stare at is whether a single card can still be picked out of the sheet.
    const running = !paused || stepOnce
    if (running) shaderTime += dt * values.timeScale
    stepOnce = false

    camera.quaternion.setFromEuler(_euler.set(pitch, yaw, 0, 'YXZ'))
    camera.getWorldPosition(head)

    // EVERY FRAME, not once at boot. The backdrop's fragment shader treats `normalize(position)` as the view ray, and that identity only holds while the cap is centred on the eye. See the header of backdrop.js.
    backdrop.update(head)
    stars.update(head, { stars: values.stars }, shaderTime * HOURS_PER_SECOND, shaderTime)
    cards.update(camera, shaderTime)

    timer.beginFrame()
    timer.begin('frame')
    renderer.render(scene, camera)
    timer.end('frame')
    timer.endFrame()

    fpsAccum += dt
    fpsFrames++
    statTimer += dt
    if (statTimer > 0.5) {
      fps = fpsFrames / fpsAccum
      fpsAccum = 0
      fpsFrames = 0
      statTimer = 0
      statsDue = true
    }
    // Two paths into one push: the half-second tick above, and a re-trace, which can land at any point in that window and invalidates every count in the footer the moment it does.
    if (statsDue) {
      statsDue = false
      pushStats()
    }

    if (!bootEl.classList.contains('gone')) bootEl.classList.add('gone')
  })
}

// ---------------------------------------------------------------------------

const _euler = new THREE.Euler()

// Every param key in a list of groups, as a Set. Used to decide which of the three routes owns a knob, so it is built once at boot rather than searched per slider tick. A duplicate key across two groups means two sliders writing one value, and hunting that down from the symptom -- one slider mysteriously moves another -- is an afternoon.
function keysOf(groups) {
  const out = new Set()
  for (const g of groups) {
    for (const p of g.params) {
      if (out.has(p.key)) throw new Error('test-aurora-v2: duplicate param key "' + p.key + '"')
      out.add(p.key)
    }
  }
  return out
}

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

// A region with no resolved samples reads as "--", never as 0. A timer query takes a frame or two to come back and the aurora region only gets armed every other frame, so there is a real window after boot where the honest answer is "not yet".
function fmtMs(ms) {
  return ms === null ? '--' : ms.toFixed(2)
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
    // Corrupt storage is recoverable and a hard throw here would leave the page permanently unable to boot until someone cleared it by hand from a console they would first have to know to open.
    console.warn('aurora-cards: discarding unreadable "' + key + '"', err)
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
