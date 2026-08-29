import THREE from './three-instance.js'

import { Stars } from './stars.js'
import { Backdrop } from './aurora-lab/backdrop.js'
import { AuroraScreen } from './aurora-lab/screen.js'
import { AuroraCurtains } from './aurora-lab/curtain/curtains.js'
import { LowResAurora } from './aurora-lab/lowres.js'
import { GpuTimer } from './aurora-lab/gpu-timer.js'
import { PlanMapAurora } from './aurora-lab/planmap/planmap.js'
import { SkyMapAurora } from './aurora-lab/skymap/skymap.js'
import { Sidebar } from './aurora-lab/ui/sidebar.js'
// The registry over BOTH kinds of aurora, not algorithms.js. It re-exports the
// same seven names with the geometry entry folded in, so every lookup on this
// page that only wants to know "what are this algorithm's groups" is unchanged;
// `isCurtain` is the one new name, and it is the only thing that knows the two
// kinds exist. See the header of curtain/registry.js.
import {
  ALGORITHMS, DEFAULT_ALGORITHM, SCENE_GROUPS,
  algorithmById, groupsFor, paramsFor, defaultsFor, isCurtain,
} from './aurora-lab/curtain/registry.js'
import { BUILTIN_NAMES, builtinByName } from './aurora-lab/presets.js'

// ---------------------------------------------------------------------------
// The /test-aurora route: a rig for designing the aurora that replaces
// archive/aurora-mesh/aurora.js.
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
// TWO IMPLEMENTATIONS BEHIND ONE PICKER
// ===========================================================================
//
// Most entries in the picker are one raymarched shader plugged into one shared
// frame, and AuroraScreen draws all of them. One entry -- `curtain` -- is not a
// shader at all: it is a mesh of folded sheets with an analytic glow, drawn by
// AuroraCurtains. Both objects are built at boot and both live in the same
// scene for the whole session; what the picker changes is which one is VISIBLE.
//
// They are not rebuilt on each switch, because the thing this page is for is
// flipping between two candidates and seeing which sky you prefer, and a flip
// that costs a shader compile or a geometry build is a flip you take fewer of.
// The price is that exactly one rule may decide who draws, and that rule is
// setLive() below. Both drawing at once is not a cosmetic bug -- the material
// is additive, so it would show as a brighter sky that neither implementation
// produces, and every judgement made in front of it would be about a third
// thing that does not exist.
//
// Two asymmetries between them are real and are handled rather than papered
// over. AuroraCurtains has no setAlgorithm, because it IS its algorithm, so
// switchAlgorithm cannot lean on the screen as the authority on what survives
// a switch when the destination is the curtain. And AuroraScreen resolves its
// id through algorithms.js, which has never heard of `curtain`, so the screen
// is always constructed and always switched to a SHADER id.
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

  // The screen is built for a SHADER id even when the page is opening on the
  // curtain, because AuroraScreen resolves its id through algorithms.js and
  // `curtain` is not in there -- constructing it with that id throws in the
  // constructor and takes the whole page down. It also gets no `values` in that
  // case: those are the curtain's forty cu-prefixed knobs, and handing them to
  // the screen is forty console warnings about a schema that has not changed.
  // It sits on its own defaults, hidden, until the picker asks for a shader
  // entry, and switchAlgorithm hands it the shared knobs on the way back.
  const openingOnCurtain = isCurtain(algorithmId)
  const screen = new AuroraScreen(scene, openingOnCurtain
    ? { algorithm: DEFAULT_ALGORITHM }
    : { algorithm: algorithmId, values })

  // The other implementation, built once and kept. It exposes the same surface
  // as the screen minus setAlgorithm -- setParam, getParam, setValues, update,
  // fragmentSource -- so almost everything below can hold either in a variable
  // and treat them alike. See the header of curtain/curtains.js.
  //
  // Handed `values` whichever kind the page is opening on: its constructor takes
  // only the keys its own schema declares and drops the rest silently, so on a
  // shader boot this picks up the shared scene knobs -- FOV, star brightness,
  // the mountains -- and leaves every cu-prefixed knob on its default.
  const curtains = new AuroraCurtains(scene, { values })

  // The aurora, optionally drawn small and blurred back up. It borrows the screen's geometry and material rather than owning any of its own, so the composite covers the same sector in the same place and the mountains go on occluding it -- see the header of lowres.js. Constructed here, above the sidebar, because applyAll() below routes lowRes/lowBlur straight into it.
  const lowres = new LowResAurora(renderer, screen)
  scene.add(lowres.mesh)

  // ---- the clock ------------------------------------------------------------
  //
  // Until this existed, every cost claim on this page was a hand count of shader ALU ops, and hand counts predicted a 9x-17x spread across the algorithms that a browser then rendered at identical frame rates. `field evals/frame` below is one of those counts: it is arithmetic about the shader, not a measurement of it, and it stays only because it is the number that transfers to another machine. The two ms figures beside it are what says whether it means anything here.
  //
  // Two regions, and the timer alternates between them because a GL context has one TIME_ELAPSED query at a time (see gpu-timer.js). `aurora` is the sector's own draw; `frame` is every GL command the loop issues, so `frame - aurora` is what the stars, the mountains and the composite cost. Read `frame` against `ms` from the fps counter: when they diverge badly the page is CPU-bound or vsync-bound and no shader change will move it, which is exactly the conclusion the fps counter alone was hiding.
  const timer = new GpuTimer(renderer, { regions: ['aurora', 'frame', 'planmap', 'skymap'] })

  // The plan-space field map, rebuilt from the live field every frame under the `planmap` algorithm and a no-op under every other one. It gets its OWN timer region, and that bracket is worth insisting on: the whole claim of that algorithm is that it moves the field out of the per-pixel loop, and leaving the generator pass outside every region is exactly how an optimisation reports a saving it did not make.
  const planmap = new PlanMapAurora(renderer)

  // The sky map: four passes that integrate the ley-line field along every ray ONCE PER SKY TEXEL, leaving the screen shader a single bilinear fetch. A no-op under every other algorithm, on the same `needs` self-gate planmap uses.
  //
  // Its timer bracket matters more than planmap's did, and for a reason worth stating: every other entry in this list moved cost around inside the per-pixel loop, so `aurora ms` alone told the story. This one claims its cost does not scale with pixel count AT ALL -- the generator, the kernel and the convolution are sized in sky texels and do not care how many pixels look at them. That claim is only checkable as two numbers side by side: `skymap ms` staying flat while `aurora ms` falls. One number cannot say it.
  const skymap = new SkyMapAurora(renderer)

  // At a divisor of 1 the sector draws inside the main scene, so the only place that can bracket exactly that one draw call is the mesh's own render hooks. Above 1 it draws in lowres's offscreen scene, on a DIFFERENT mesh object that these hooks are not on, and the bracket around lowres.render() below covers it instead. Exactly one of the two paths runs in any frame -- lowres keeps precisely one of the meshes visible -- so both write into one region without ever overlapping.
  screen.mesh.onBeforeRender = () => timer.begin('aurora')
  screen.mesh.onAfterRender = () => timer.end('aurora')

  // The curtain is a third path into the same region, and it gets the same
  // treatment for the same reason: `aurora ms` has to mean "what the sky cost"
  // under every entry in the picker, or the one number the two implementations
  // are going to be compared on is measured differently on each side of the
  // comparison. There is no low-res path here to complicate it -- the divisor
  // is a shader knob and the curtain has none -- so the mesh's own hooks are
  // the whole story. The three sources can never overlap because setLive()
  // leaves exactly one of the three meshes visible.
  curtains.mesh.onBeforeRender = () => timer.begin('aurora')
  curtains.mesh.onAfterRender = () => timer.end('aurora')

  // ---- which implementation is live ----------------------------------------
  //
  // The single place that answers "who draws". Everything else asks this flag
  // rather than re-deriving it from the id, so there is one rule and not five
  // copies of it that drift apart the first time a third implementation lands.
  let curtainLive = false

  function setLive() {
    curtainLive = isCurtain(algorithmId)
    curtains.mesh.visible = curtainLive

    // In shader mode WHICH of the screen's two meshes draws is not this file's
    // decision -- lowres owns that pair and the divisor is what picks between
    // them. Its choice is read back off the live divisor rather than remembered
    // here, and it has to be re-derived rather than delegated: setDiv() only
    // reapplies visibility when the divisor actually CHANGES, so coming back
    // from the curtain with the same divisor you left on would restore nothing
    // and the sky would stay black with no error anywhere.
    screen.mesh.visible = !curtainLive && lowres.div === 1
    lowres.mesh.visible = !curtainLive && lowres.div !== 1
  }

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
    // Routed HERE and not left to fall through to the screen. Both are `uniform: false` params, so screen.setParam would accept them and then return without writing anything -- a slider that moves and does nothing, which is the precise failure the schema exists to prevent.
    // Two destinations, not one. The divisor sizes the offscreen buffer, and it ALSO has to reach the march, whose dither lattice is measured in texels of that buffer and has to stay measured in pixels of the finished frame -- see setDitherScale and the dither in glsl/frame.js. Routing it to only one of the two is how the low-res tiers ended up with horizontal banding low in the sky.
    lowRes: (v) => { lowres.setDiv(v); screen.setDitherScale(v) },
    lowBlur: (v) => lowres.setBlur(v),
    // Same story as lowRes/lowBlur: both are `uniform: false`, so without a route here they are sliders that move and do nothing.
    pmRadRes: () => planmap.setSize(values.pmRadRes, values.pmAzRes),
    pmAzRes: () => planmap.setSize(values.pmRadRes, values.pmAzRes),
    stars: () => {},
  }

  function applyParam(key, value) {
    values[key] = value
    if (backdropKeys.has(key)) { backdrop.set(key, value); return }
    if (key in sceneApply) { sceneApply[key](value); return }
    // Anything left belongs to whichever implementation is live. Both setParams
    // throw on a key their schema does not declare, which is the point: a key no
    // route claims is a bug in the schema, and it should surface the first time
    // the slider moves rather than never. The branch is on the LIVE flag and not
    // on the shape of the key, because a prefix test would quietly send a
    // mistyped cu-key to the curtain under a shader algorithm and get an
    // exception that names the wrong culprit.
    if (curtainLive) { curtains.setParam(key, value); return }
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
  setLive()
  applyAll()

  function switchAlgorithm(id) {
    algorithmId = id

    if (isCurtain(id)) {
      // No screen to ask. AuroraCurtains has no setAlgorithm -- it IS its
      // algorithm -- so the carry rule has to be written here, and it is
      // written to be the SAME rule the screen applies: take the destination's
      // defaults, and keep whatever the panel was already showing for any knob
      // the destination also has. In practice that is the scene group and the
      // mountains, which is the entire overlap between a raymarch's schema and
      // this one, and it is exactly the overlap you want held still: switching
      // implementation must not also move the camera and repaint the skyline.
      const next = defaultsFor(id)
      for (const k of Object.keys(next)) {
        if (k in values) next[k] = values[k]
      }
      replaceValues(next)
    } else {
      // The screen is the authority on what survived the switch -- it carries
      // shared knobs across and takes the new algorithm's own defaults and
      // overrides for the rest. Recomputing that here would be a second copy of
      // the rule, and the two would drift.
      //
      // But it can only carry across what IT is holding, and while the curtain
      // owned the panel every shared knob was routed past the screen: turn the
      // FOV down under the curtain, switch back, and the screen would hand back
      // the FOV from whenever you last left it and applyAll would obediently
      // restore it. So the shared knobs go home first. Filtered to the keys the
      // screen already has, because setValues warns about the rest and forty
      // warnings a switch is how a console stops being read.
      const shared = {}
      for (const k of Object.keys(values)) {
        if (k in screen.values) shared[k] = values[k]
      }
      screen.setValues(shared)
      screen.setAlgorithm(id)
      replaceValues(screen.values)
    }

    sidebar.setBlurb(algorithmById(id).blurb)
    sidebar.setGroups(groupsFor(id), values)
    // Before applyAll, not after: applyParam routes on the live flag, so a
    // stale flag here would push the incoming algorithm's knobs at the outgoing
    // implementation and throw on the first key the two do not share.
    setLive()
    applyAll()
    saveState()
  }

  // `values` is captured by the sidebar, by backdropOptsFrom and by the frame
  // loop, so a switch has to refill the object in place rather than rebind the
  // name -- rebinding would leave every one of those holding the old algorithm's
  // state forever.
  function replaceValues(next) {
    for (const k of Object.keys(values)) delete values[k]
    Object.assign(values, next)
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
        // Whichever implementation is on screen. Showing the raymarch's source
        // while the mesh is drawing would be a viewer that reads as authoritative
        // and is describing something the page is not currently doing.
        shaderEl.querySelector('pre').textContent =
          (curtainLive ? curtains : screen).fragmentSource()
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

  // A three camera looks down -z with no rotation at all, and -z is north, which is where the belt is. This was Math.PI, which with _euler.set(pitch, yaw, 0, 'YXZ') turns the camera to +z -- SOUTH, away from the belt. Back when the screen was a northern sector that meant the sector was outside the frustum and nothing was drawn at all: the page opened on stars and mountains and no curtain, at 60 fps, and every fps reading anyone took at the opening view was a reading of an empty sky. The dome no longer hides the mistake that way -- facing south now draws a full sky's worth of fragments and merely finds the belt dark -- so the opening heading is a matter of the view being the intended one rather than of the benchmark being honest.
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
    // DRAWING-BUFFER pixels, which already carry the render scale applied via setPixelRatio above. The divisor therefore COMPOSES with `render scale`: the aurora is drawn at resScale / lowRes of native in each axis, so the fast preset's 0.7 with a divisor of 4 is 0.175, or 1/33 of the fragments. Read off the canvas rather than recomputed, for the same reason the star point size is: two expressions for one number drift.
    lowres.setSize(renderer.domElement.width, renderer.domElement.height)
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
    // Only the live one. Both take (camera, elapsed) and both only write
    // uniforms and a position, so ticking the hidden one would be harmless and
    // it would also be a second thing consuming the clock, which is the kind of
    // detail that stops being harmless the day one of them grows a simulation
    // step that expects to be called once per frame.
    if (curtainLive) curtains.update(camera, shaderTime)
    else screen.update(camera, shaderTime)

    timer.beginFrame()
    timer.begin('frame')

    timer.begin('planmap')
    planmap.render(algorithmId, values, shaderTime)
    timer.end('planmap')

    timer.begin('skymap')
    skymap.render(algorithmId, values, shaderTime)
    timer.end('skymap')

    // Pass 1: the expensive shader into the small target, in a scene that contains nothing else. A no-op at a divisor of 1, where the real mesh in the main scene below is doing the drawing instead.
    // Bracketed only when it is going to do something. Timing the early return would push a stream of near-zero samples into the same median as the real ones and halve the reported cost of the aurora at a divisor of 1, which is the flavour of quietly wrong number this whole file is trying to stop.
    // Skipped entirely under the curtain. lowres borrows the SCREEN's material
    // and geometry, so at a divisor above 1 it would go on rendering the
    // raymarch into an offscreen target every frame that nothing then composites
    // -- the full cost of the implementation you just switched away from,
    // invisible, and folded into `aurora ms` on top of the curtain's own draw.
    if (!curtainLive) {
      if (lowres.div > 1) {
        timer.begin('aurora')
        lowres.render(camera)
        timer.end('aurora')
      } else {
        lowres.render(camera)
      }
    }

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
      const info = renderer.info.render
      sidebar.setStats({
        fps: Math.round(fps),
        ms: 1000 / fps,
        // Two decimals, formatted here rather than left to the sidebar, whose fmtStat rounds to one -- and a fast sky at a high divisor is a few tenths of a millisecond, where one decimal is the difference between "0.3" and "0.3".
        'aurora ms': fmtMs(timer.median('aurora')),
        'frame ms': fmtMs(timer.median('frame')),
        // Zero under every algorithm but `planmap`, and shown always rather than only under that one, because a row that appears and disappears is a row nobody reads as part of the total. Under planmap this is the price of the saving: it has to be smaller than what `aurora ms` dropped by, and it is the number that says so.
        'planmap ms': fmtMs(timer.median('planmap')),

        // The prepass cost of `skymap`, and the row this page exists to read. Under that algorithm it should be roughly constant while `aurora ms` and the resolution divisor move underneath it; if it tracks them instead, the convolution is not actually off the per-pixel path and the whole scheme is a longer way of doing the march.
        'skymap ms': fmtMs(timer.median('skymap')),
        // Never omitted and never abbreviated to something that could pass for a GPU reading. `cpu-sync` means this browser has no GPU timer and these are wall-clock intervals fenced by a readPixels: correct for ranking two shaders against each other, biased high in absolute terms, and not a number to quote as "the aurora costs X on this GPU".
        timer: timer.mode,
        // The one number that predicts the cost of this shader anywhere else.
        // At 40 steps a full-screen 1080p quad is ~83 million field evaluations
        // a frame, and the headset has to do it twice. Divided by the low-res divisor SQUARED, because a buffer smaller in both axes is what makes this quadratic; without it the stat goes on reporting the reference's cost for a sky that is costing a sixteenth of it.
        // The curtain has neither `steps` nor `lowRes` in its schema, and it is
        // not that they are missing -- there is no march to count steps of and
        // no low-res buffer to divide by, which is the entire claim the geometry
        // approach makes. So it reports none rather than a number: printing 0
        // would read as a measured zero next to a shader's 83M, and letting the
        // arithmetic run on two undefineds would print NaN, which is a stat
        // saying "something here is broken" about a mode that is fine.
        'field evals/frame': curtainLive ? 'none -- no march' : Math.round(
          renderer.domElement.width * renderer.domElement.height * values.steps
          / (values.lowRes * values.lowRes) / 1e6
        ) + 'M',
        steps: curtainLive ? 'n/a' : values.steps,
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
