import * as THREE from 'three'
import { VRButton } from 'three/addons/webxr/VRButton.js'

import { HEIGHTMAP_URL, HEIGHTMAP_META_URL, WORLD_HALF } from './config.js'
import { Heightmap } from './height/heightmap.js'
import { V2Height } from './height/field.js'
import { Layers } from './layers/layers.js'
import { snowDefaults } from './layers/doc.js'
import { TerrainV2 } from './terrain/terrain-v2.js'
import { LOD, MIN_TRI_DEG, MAX_TRI_DEG } from './terrain/quadtree-v2.js'
import { Markers } from './render/markers.js'
import { WaterSurfaces } from './render/water-surfaces.js'
import { RoadSurfaces } from './render/road-surfaces.js'
import { Editor, TOOL_KEYS, TOOLS } from './edit/editor.js'
import { Panel } from './ui/panel.js'
import * as persist from './edit/persist.js'

// v1 LEAF MODULES, shared on purpose (§18's shared list). Every one of these is
// about the SKY or about the BODY and neither depends on where the ground came
// from. What v2 must not import is v1's ANSWER to the ground question --
// sim/terrain-height.js and sim/phase-a.js -- and scripts/check-v2.mjs fails
// the build if it ever does. That is also why the spawn search below is
// rewritten here rather than imported from phase-a.js.
import { Player, LOCOMOTION } from '../player.js'
import { Sky } from '../sky.js'
import { Stars } from '../stars.js'
import { Aurora } from '../aurora.js'
import { Water } from '../water.js'
import { WorldClock, CLOCK } from '../clock.js'
import { WorldLighting } from '../lighting.js'
import { SkyProbe } from '../sky-probe.js'
import { Input } from '../input.js'

// ---------------------------------------------------------------------------
// The /v2 route (DESIGN.md §18): the imported world, walkable, with the
// authoring tools on top of it.
//
// This file is v1's src/main.js with the procedural half cut out and the
// editing half grafted on. What it keeps from v1 is the day-night wiring, which
// is unchanged and must STAY unchanged -- the ordering inside applySky() below
// is load-bearing and the reasons are written there. What it drops is
// everything downstream of Phase A: no props, no villages, no horizon maps, no
// measure beam, no HUD panel in the headset.
//
// THREE THINGS ARE VISIBLY DIFFERENT FROM v1 AND ARE NOT BUGS:
//
//   No terrain shadows. WorldLighting is constructed and every material is
//   patched, but nothing calls lighting.setMaps() -- the horizon map is baked by
//   Phase A, which is v1's macro pass over v1's procedural field. Until v2 grows
//   its own, uSunSky.z stays 0 and every shaded material returns full sun. The
//   mountains light correctly and cast nothing.
//
//   No Phase A water. water.setFromPhaseA() is never called, so water.levelAt()
//   is null everywhere and the v1 lake mesh does not exist. All water on this
//   route is AUTHORED -- lakes and rivers out of the document, built by
//   WaterSurfaces onto the same shared water material, so they wave and reflect
//   exactly like v1's does.
//
//   No prop scatter. §18 is about the ground and the layers on it. An empty
//   world is also the honest way to look at a heightmap.
//
// BOOT IS ASYNCHRONOUS AND ORDERED, and the order is forced by a real
// dependency, not by taste:
//
//   heightmap -> V2Height (with a scratch empty document, because the
//   constructor requires one) -> bands, which are measured off the image ->
//   the snow defaults, which are a function of those bands -> the loaded or
//   empty document -> height.setLayers(the real one).
//
// The scratch document exists for exactly one reason: `bands` needs a
// constructed V2Height and `persist.loadInitial` needs `bands`. See the note on
// setLayers() in height/field.js for why swapping it in later is safe and why
// swapping it in by assigning `.layers` would not be.
// ---------------------------------------------------------------------------

const FOG_COLOR = 0x9db4cf
const SUN_COLOR = 0xfff2dc
const SEED = 20260824

const boot = document.getElementById('boot')
const bootSay = (html) => {
  if (boot) boot.innerHTML = html
}
const bootDone = () => {
  if (boot) boot.classList.add('gone')
}
// A failed boot must READ as a failed boot. The overlay covers the canvas, so
// swallowing the error here would leave a grey rectangle and no explanation.
const bootFail = (err) => {
  console.error(err)
  if (boot) {
    boot.classList.remove('gone')
    boot.innerHTML = `<pre>v2 failed to start\n\n${err && err.stack ? err.stack : err}</pre>`
  }
}

// --- renderer ---------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(1) // never above 1 in XR; the headset controls its own resolution
renderer.setSize(innerWidth, innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.xr.enabled = true
renderer.xr.setFoveation(1.0)
document.body.appendChild(renderer.domElement)
document.body.appendChild(VRButton.createButton(renderer))

const scene = new THREE.Scene()
scene.background = new THREE.Color(FOG_COLOR)
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00022)

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 20000)
camera.rotation.order = 'YXZ'
camera.position.y = LOCOMOTION.eyeHeight // desktop only; XR overwrites this from the pose

const rig = new THREE.Group()
rig.add(camera)
scene.add(rig)

const sun = new THREE.DirectionalLight(SUN_COLOR, 2.1)
sun.position.set(-0.45, 0.62, 0.3).normalize()
scene.add(sun)
const hemi = new THREE.HemisphereLight(0xbfd4ee, 0x2c3140, 0.85)
scene.add(hemi)

const clock = new WorldClock({ seed: SEED })

// --- sky, which needs nothing from the ground -------------------------------

const lighting = new WorldLighting()
const sky = new Sky(scene)
const probe = new SkyProbe()
// AFTER those three, by reference: the water reflects the dome by calling its
// shading function, asks the (here always-empty) horizon map where the mountains
// are, and adds the probe's aurora on top. See water.js.
const water = new Water(scene, { sky, lighting, probe })
const stars = new Stars(scene, { seed: SEED, pixelRatio: renderer.getPixelRatio() })
const aurora = new Aurora(scene, { seed: SEED })
SkyProbe.include(aurora.mesh, stars.points)

const input = new Input(renderer)

// Filled in by boot(); the frame loop refuses to run until they exist.
let height = null
let layers = null
let terrain = null
let player = null
let markers = null
let waterSurfaces = null
let roads = null
let editor = null
let panel = null
let ready = false

// --- boot -------------------------------------------------------------------

/**
 * Where an unedited world puts its snow line, measured off the loaded image.
 *
 * NOT a constant, for the same reason nothing else vertical in v2 is one: the
 * heightmap is the thing the author replaces, and a literal fitted to one bake
 * is silently wrong under the next. doc.js carries provisional numbers so that
 * a document can be constructed without a heightmap at all (the node gates do
 * exactly that); this is the browser's answer and it wins here.
 *
 * p75 as the base: three quarters of the world's texels are below the line, so
 * the snow reads as caps on the high ground rather than as a white world. The
 * band is half the p50..p90 spread, which is the elevation over which the
 * middle of the terrain actually climbs -- a fixed band is either a hard line on
 * a gentle world or a hundred-metre smear on a steep one.
 */
/**
 * A place to stand, on v2's own field.
 *
 * v1 imports findSpawn from phase-a.js and v2 cannot -- that module IS v1's
 * procedural world. The rule here is deliberately weaker than v1's: v1 scores
 * against a baked macro pass with lakes and villages in it, and v2 has neither
 * at boot. So this asks for the three things that are actually checkable --
 * walkable slope, dry ground, low elevation -- over a spiral of candidates, and
 * takes the best.
 *
 * The spiral is golden-angle rather than a grid: a grid at this candidate count
 * is coarse enough that whole valleys fall between its rows, and its
 * regularity means the failure repeats identically every boot instead of
 * showing up once and being noticed.
 */
function findSpawnV2(h, wet, bands) {
  const R = WORLD_HALF * 0.55
  const GOLDEN = Math.PI * (3 - Math.sqrt(5))
  const N = 512
  // Walkable with margin. Spawning exactly at the locomotion limit means the
  // first step in three of four directions is blocked.
  const maxSlope = (LOCOMOTION.maxSlopeDeg * 0.6 * Math.PI) / 180

  let best = null
  for (let i = 0; i < N; i++) {
    const r = R * Math.sqrt((i + 0.5) / N)
    const a = i * GOLDEN
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const y = h.heightAt(x, z)
    if (wet.isSubmerged(x, z, y)) continue
    const slope = h.slopeAt(x, z)
    if (slope > maxSlope) continue
    // Low ground, and flat, and near the middle -- in that order of weight. The
    // elevation term is normalised by the world's own relief so it stays
    // comparable to the other two under any bake.
    const relief = Math.max(1, bands.max - bands.min)
    const score =
      ((y - bands.min) / relief) * 2 + slope / maxSlope + (r / R) * 0.5
    if (best === null || score < best.score) best = { x, z, y, score }
  }
  if (best) return best
  throw new Error(
    `v2: no spawn found in ${N} candidates within ${R.toFixed(0)} m of the origin -- every one was underwater or steeper than ${((maxSlope * 180) / Math.PI).toFixed(0)} deg`
  )
}

async function bootWorld() {
  bootSay(`loading <b>${HEIGHTMAP_URL}</b> ...`)
  const heightmap = await Heightmap.load({ url: HEIGHTMAP_URL, metaUrl: HEIGHTMAP_META_URL })

  // The scratch document. See the header: `bands` needs a V2Height and the snow
  // defaults need `bands`, so something has to be constructed first.
  height = new V2Height({ heightmap, layers: new Layers(), seed: SEED })
  const bands = height.bands

  bootSay('loading <b>world/layers.json</b> ...')
  const snow = snowDefaults(bands)
  const { doc, from } = await persist.loadInitial(snow)
  layers = Layers.deserialize(doc)
  height.setLayers(layers)
  console.log(
    `[v2] world ${heightmap.width}x${heightmap.height} texels, ${heightmap.texelSize.toFixed(2)} m/texel, ` +
      `relief ${bands.min.toFixed(1)}..${bands.max.toFixed(1)} m, snow line ${snow.base.toFixed(0)} m +/- ${snow.band.toFixed(0)} m, ` +
      `document from ${from}`
  )

  bootSay('meshing ...')
  terrain = new TerrainV2(scene, { heightmapRaw: heightmap.toRaw(), doc: layers.serialize(), workers: 2 })

  lighting.patch(terrain.material, {
    mode: 'fragment',
    cacheKey: 'v2-terrain-shadow',
    // terrain-material.js has carried this varying since v1's surface grain was
    // written and v2 shares the material, so reusing it saves declaring a second
    // varying holding the same value.
    worldPosVarying: 'vWorldPos',
  })

  // The authored surfaces. Water first, because the spawn search asks it what is
  // wet before the player is placed.
  waterSurfaces = new WaterSurfaces({ water, layers })
  roads = new RoadSurfaces({ scene, layers })
  // Per-vertex, like v1's props and village and NOT like the terrain: a road is
  // a metre-wide ribbon, so a fragment-rate shadow lookup on it buys nothing.
  // Skipping this patch entirely is the visible failure -- the road would be the
  // one surface the night lift never reaches, and it would glow after sunset.
  lighting.patch(roads.material, { mode: 'vertex', cacheKey: 'v2-road' })
  markers = new Markers({ scene, layers })
  waterSurfaces.rebuild()
  roads.rebuild()
  markers.sync()

  player = new Player(rig, camera, height)
  const spawn = findSpawnV2(height, waterSurfaces, bands)
  player.spawnAt(spawn.x, spawn.z)
  console.log(`[v2] spawn ${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)} at ${spawn.y.toFixed(1)} m`)

  editor = new Editor({
    scene,
    camera,
    renderer,
    layers,
    height,
    markers,
    onDirty,
    onView,
    orbitLock,
    // The heightmap's DECODED extremes, not meta.minY/maxY: the encoding's range
    // is what the bake could have expressed, and the sliders should offer what
    // the image actually contains. See heightmap.js's `min`/`max`.
    elevation: { min: heightmap.min, max: heightmap.max },
  })
  // The hide set lives in the editor and every renderer that draws from the
  // document has to read it. Wired AFTER the editor exists rather than in each
  // constructor, because `markers.setVisibility` re-syncs immediately and the
  // predicate it is handed is the editor's.
  const isVisible = (kind, id, index) => editor.isVisible(kind, id, index)
  markers.setVisibility(isVisible)
  waterSurfaces.setVisibility(isVisible)
  roads.setVisibility(isVisible)

  panel = new Panel({ layers, editor, onTool, onAction })

  ready = true
  bootDone()
}

// --- the edit -> world channel ----------------------------------------------

/**
 * One authored change has landed. `rect` is the world-space box it touched, and
 * everything that has baked something from the document has to be told.
 *
 * The terrain gets the RECT and rebakes only the chunks that overlap it -- that
 * is the whole reason the rect exists, and passing null here would silently
 * re-mesh the world on every drag of a river point.
 *
 * The surfaces rebuild WHOLE, and that is not an oversight: a lake is two
 * hundred triangles and a road is one per metre, so the entire authored set is
 * cheaper to rebuild than to diff. `rebuildOne(id)` exists for when that stops
 * being true.
 *
 * V2Height is NOT told anything. It holds the live Layers by reference and
 * re-reads `epoch` per query, so it is already correct by the time this runs.
 *
 * Neither is localStorage. The editor autosaves from its own `_commit`, and a
 * second saveLocal here would serialise and write the whole document twice per
 * edit for nothing.
 */
function onDirty(rect) {
  terrain.setLayers(layers.serialize(), rect)
  waterSurfaces.rebuild()
  roads.rebuild()
}

/**
 * A row's eye button was clicked. Nothing about the DOCUMENT changed, so this is
 * deliberately not onDirty: no rebake, no rebuild, no dirty rect, no undo entry
 * -- hiding a lake must not cost a terrain remesh. Both surface sets already
 * hold the predicate, so all that is needed is for them to re-read it.
 */
function onView() {
  waterSurfaces.applyVisibility()
  roads.applyVisibility()
}

function onTool(name) {
  editor.setActive(true)
  editor.setTool(name)
  panel.syncSelection()
}

async function onAction(name) {
  panel.setError('')
  try {
    if (name === 'save') {
      const r = await persist.saveServer(layers)
      panel.setError(`saved ${r.bytes} B to ${r.path}`)
    } else if (name === 'load') {
      const doc = await persist.loadServer()
      if (!doc) throw new Error('no committed world/layers.json to load')
      loadDoc(doc)
    } else if (name === 'export') {
      persist.exportFile(layers)
    } else if (name === 'import') {
      loadDoc(await persist.importFile())
    } else if (name === 'undo') {
      editor.undo()
    } else if (name === 'redo') {
      editor.redo()
    } else {
      throw new Error(`unknown panel action ${name}`)
    }
  } catch (err) {
    console.error(err)
    panel.setError(err.message)
  }
  panel.syncSelection()
}

/**
 * Replace the whole document in place.
 *
 * `editor.loadDoc` restores INTO the live Layers rather than swapping in a new
 * instance, which is what makes this a one-liner: V2Height, WaterSurfaces,
 * RoadSurfaces and Markers all hold that same object by reference and would
 * otherwise every one of them keep editing the document that was just replaced.
 * See restore.js.
 */
function loadDoc(doc) {
  editor.loadDoc(doc)
  // A whole-document replacement is not a rect, so the terrain is told
  // everything changed. This is the one call site where a full invalidation is
  // correct rather than lazy.
  terrain.setLayers(layers.serialize(), null)
  waterSurfaces.rebuild()
  roads.rebuild()
  markers.sync()
}

// --- input ------------------------------------------------------------------

// v1's table minus two rows. `h` and `t` are gone: the panel binds H itself
// (see its constructor) and there is no tuner on this route. Everything else is
// v1's, including the Dvorak double binding -- `,aoe` sit on the physical WASD
// keys, `KeyboardEvent.code` reports position and `.key` reports the character,
// so binding both means the file works on either layout.
const KEY_ACTIONS = {
  ',': 'forward',
  a: 'left',
  o: 'back',
  e: 'right',
  ' ': 'flyUp',
  Shift: 'flyDown',
  u: 'unstick',
  n: 'timeSkip',
  p: 'auroraPattern',
  '[': 'coarser',
  ']': 'finer',
}

const CODE_ACTIONS = {
  KeyW: 'forward',
  KeyA: 'left',
  KeyS: 'back',
  KeyD: 'right',
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'turnLeft',
  ArrowRight: 'turnRight',
  Space: 'flyUp',
  ShiftLeft: 'flyDown',
  ShiftRight: 'flyDown',
  KeyN: 'timeSkip',
  KeyP: 'auroraPattern',
  BracketLeft: 'coarser',
  BracketRight: 'finer',
}

const actionsFor = (e) => {
  const a = KEY_ACTIONS[e.key.length === 1 ? e.key.toLowerCase() : e.key]
  const b = CODE_ACTIONS[e.code]
  if (a && b && a !== b) return [a, b]
  return a ? [a] : b ? [b] : []
}

const held = new Set()
const on = (action) => held.has(action)
const typing = (e) =>
  e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

let dragging = false
// Set by the gizmo through the Editor while a handle is being dragged. Without
// it, dragging the translate arrow also spins the camera, and the object appears
// to fly off across the world because the ray it is being dragged along moved.
let orbitLocked = false
const orbitLock = (lock) => {
  orbitLocked = Boolean(lock)
  if (orbitLocked) dragging = false
}

const DOUBLE_TAP_MS = 320
let lastSpaceTap = -Infinity

function setFlying(want) {
  player.setFlying(want && !renderer.xr.isPresenting)
}

function onSpacePress(now) {
  if (now - lastSpaceTap < DOUBLE_TAP_MS) {
    lastSpaceTap = -Infinity
    setFlying(false)
    return
  }
  lastSpaceTap = now
  setFlying(true)
}

function skipTime() {
  clock.skip(CLOCK.skipHours)
  console.log(`[clock] +${CLOCK.skipHours}h -> ${clock.clockText}  sun ${clock.sun.elevDeg.toFixed(1)}deg`)
}

function cycleAurora() {
  const i = aurora.cyclePattern()
  console.log(`[aurora] ${aurora.label}${aurora.blurb ? `  --  ${aurora.blurb}` : ''}`, i)
}

addEventListener('keydown', (e) => {
  if (!ready || typing(e)) return

  // Tab arms and disarms the editor. A dedicated key rather than a mode that is
  // always on, because an armed lake tool turns every stray click on the ground
  // into a lake -- and because G/R/S mean two different things depending on this
  // flag (see the key-conflict note in editor.js).
  if (e.code === 'Tab') {
    e.preventDefault()
    editor.setActive(!editor.active)
    panel.syncSelection()
    return
  }

  // THE EDITOR GETS FIRST REFUSAL, and it reports whether it took the key.
  // Anything it consumed must not also move the player: `S` is walk-backward
  // here and scale-mode in Blender, and editor.js resolves that by consuming
  // G/R/S only while a gizmo is attached. Acting on a consumed key anyway would
  // walk her backwards through the object she is scaling.
  if (editor.onKeyDown(e)) return

  // Arming a tool from the digit that names it, when the editor is not active
  // yet. Once it IS active the branch above has already handled these.
  const tool = TOOL_KEYS.indexOf(e.key)
  if (tool >= 0) {
    onTool(TOOLS[tool])
    return
  }

  const actions = actionsFor(e)
  if (actions.length === 0) return
  if (actions.includes('flyUp')) e.preventDefault() // space scrolls the page otherwise
  const fresh = actions.filter((a) => !held.has(a))
  for (const a of actions) held.add(a)

  if (fresh.includes('timeSkip')) skipTime()
  if (fresh.includes('auroraPattern')) cycleAurora()
  if (fresh.includes('flyUp')) onSpacePress(e.timeStamp)
  // triDeg is a size budget, so finer means smaller. Stepped multiplicatively
  // because the perceptual distance from 1.0 to 1.2 degrees is nothing like the
  // distance from 0.4 to 0.6.
  if (fresh.includes('coarser')) LOD.triDeg = Math.min(MAX_TRI_DEG, LOD.triDeg * 1.25)
  if (fresh.includes('finer')) LOD.triDeg = Math.max(MIN_TRI_DEG, LOD.triDeg / 1.25)
})

addEventListener('keyup', (e) => {
  if (typing(e)) return
  for (const a of actionsFor(e)) held.delete(a)
})

// The browser stops delivering keyup while the window is unfocused, so a key
// held across an alt-tab would otherwise stick down and she would fly away.
addEventListener('blur', () => held.clear())

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!ready) return
  // Left button only, now that the right one opens the editor's context menu:
  // otherwise a right-click also spins the camera out from under the menu it
  // just opened.
  dragging = e.button === 0 && !orbitLocked
  editor.onPointerDown(e)
})
// Right-click on a handle. The editor decides WHAT can be done to the thing
// under the cursor and hands back closures; the panel draws them. The browser's
// own menu is suppressed only when the editor is armed and actually answered --
// on a right-click over empty ground in walk mode you still get the browser's.
renderer.domElement.addEventListener('contextmenu', (e) => {
  if (!ready || !editor.active) return
  const items = editor.menuFor(e)
  if (items.length === 0) return
  e.preventDefault()
  panel.showMenu(e.clientX, e.clientY, items)
})
addEventListener('pointerup', (e) => {
  dragging = false
  if (ready) editor.onPointerUp(e)
})
addEventListener('pointermove', (e) => {
  if (!ready) return
  // Always forwarded, drag or not: the editor tracks the pointer for its ground
  // readout and for the placement preview, both of which have to follow the
  // cursor while nothing is pressed.
  editor.onPointerMove(e)
  if (!dragging || orbitLocked || renderer.xr.isPresenting) return
  camera.rotation.y -= e.movementX * 0.0026
  camera.rotation.x = THREE.MathUtils.clamp(
    camera.rotation.x - e.movementY * 0.0026,
    -Math.PI / 2.2,
    Math.PI / 2.2
  )
})
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

// --- day and night ----------------------------------------------------------

const tmpCol = new THREE.Color()
const setSRGB = (col, rgb) => col.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)

// Unchanged from v1, ordering included. The comments there explain each step;
// what matters when reading this file is that the order is a dependency chain
// and not a list: lighting writes the night terms the water reads, sky.update
// writes the reflection the water bends, and hemi is set before water.update
// because it is the ambient the water's silhouettes are matched to.
function applySky(state, head, elapsedReal) {
  sun.position.set(state.lightDir.x, state.lightDir.y, state.lightDir.z)
  setSRGB(sun.color, state.lightColor)
  sun.intensity = state.lightIntensity

  setSRGB(hemi.color, state.hemiSky)
  setSRGB(hemi.groundColor, state.hemiGround)
  hemi.intensity = state.hemiIntensity

  setSRGB(scene.fog.color, state.fog)
  scene.fog.density = state.fogDensity
  setSRGB(tmpCol, state.fog)
  scene.background.copy(tmpCol)

  lighting.update(state)
  sky.update(head, state)
  stars.update(head, state, clock.elapsed, elapsedReal)
  aurora.update(head, state, elapsedReal)
  water.update(elapsedReal, hemi)
}

// --- frame loop -------------------------------------------------------------

let last = performance.now()
let frames = 0
let acc = 0
let avgMs = 0
let lastPanelAt = 0
let shownError = ''
const moveInput = { move: 0, strafe: 0, lift: 0, turn: 0, unstick: false, instant: false }
const headTmp = new THREE.Vector3()

function readInput() {
  const st = input.update()
  if (st.connected > 0) {
    moveInput.move = Math.max(0, -st.left.axes[1])
    moveInput.strafe = 0 // no strafing in VR, on purpose
    moveInput.lift = 0
    const lx = st.left.axes[0]
    const rx = st.right.axes[0]
    moveInput.turn = Math.abs(lx) > Math.abs(rx) ? lx : rx
    moveInput.unstick = !!st.left.buttons.SECONDARY?.justPressed
    moveInput.instant = false
    if (st.right.buttons.GRIP?.justPressed) skipTime()
    if (st.right.buttons.PRIMARY?.justPressed) cycleAurora()
    if (st.left.buttons.PRIMARY?.justPressed) player.recenterXR(renderer)
    return
  }
  moveInput.move = (on('forward') ? 1 : 0) - (on('back') ? 1 : 0)
  moveInput.strafe = (on('right') ? 1 : 0) - (on('left') ? 1 : 0)
  moveInput.lift = (on('flyUp') ? 1 : 0) - (on('flyDown') ? 1 : 0)
  moveInput.instant = true
  moveInput.turn = (on('turnRight') ? 1 : 0) - (on('turnLeft') ? 1 : 0)
  moveInput.unstick = on('unstick')
}

function panelStats() {
  const info = renderer.info
  const st = terrain.stats
  const h = height.heightAt(headTmp.x, headTmp.z)
  return {
    fps: avgMs > 0 ? 1000 / avgMs : null,
    ms: avgMs,
    tris: info.render.triangles,
    calls: info.render.calls,
    // "resident" is chunks holding a geometry slot; "drawn" is the subset the
    // selection actually renders this frame. The gap between them IS the
    // streaming margin, so showing one without the other hides the thing worth
    // watching.
    resident: st.slots,
    drawn: st.rendered,
    queued: st.queued,
    triDeg: st.triDeg,
    x: headTmp.x,
    y: headTmp.y,
    z: headTmp.z,
    ground: h,
    cell: st.finestCell,
    snowHere: layers.snowLineAt(headTmp.x, headTmp.z),
    snowBase: layers.snow.base,
    mode: editor.active ? `edit:${editor.tool}` : player.flying ? 'fly' : 'walk',
  }
}

function tick() {
  const now = performance.now()
  const raw = now - last
  last = now
  // Clamp dt so a tab-switch or a GC pause cannot teleport her across a valley.
  const dt = Math.min(0.1, raw / 1000)

  acc += raw
  frames++
  if (frames >= 30) {
    avgMs = acc / frames
    frames = 0
    acc = 0
  }

  if (!ready) {
    renderer.render(scene, camera)
    return
  }

  readInput()
  player.update(dt, moveInput)

  player.headPosition(headTmp)
  // Altitude and gaze both feed the split rule: y makes the range term 3D and
  // yaw is what stops two thirds of the slot pool going to terrain behind her.
  terrain.update({ x: headTmp.x, y: headTmp.y, z: headTmp.z, yaw: player.headYaw() })

  clock.advance(dt)
  applySky(clock.state(), headTmp, now / 1000)

  // BEFORE the render, and it must be the only caller of markers.update(): the
  // handles are scaled to hold a constant angular size, so a second call with a
  // different camera would size them for a frame nobody is looking through.
  editor.update(dt, camera)

  if (now - lastPanelAt >= 250) {
    lastPanelAt = now
    panel.setStats(panelStats())
    // The editor RECORDS what went wrong (a click that missed the ground, a
    // failed autosave) and the panel DISPLAYS what it is told; nothing joins the
    // two, so the host does. Only on change, so a message this file put up --
    // "saved 710 B to public/world/layers.json" -- is not overwritten every
    // quarter second by an empty string.
    if (editor.error !== shownError) {
      shownError = editor.error
      panel.setError(editor.error)
    }
  }

  // BEFORE the main render, and that ordering is load-bearing: the probe binds a
  // render target and toggles renderer.xr off to get its own camera looked
  // through. See sky-probe.js.
  probe.update(renderer, scene, headTmp)

  renderer.render(scene, camera)
}

renderer.setAnimationLoop(tick)

// §18: editing is a desktop activity and the gizmo has no controller binding.
// Entering XR with a tool armed would leave a mode running that nothing in the
// headset can see, exit or undo.
renderer.xr.addEventListener('sessionstart', () => {
  if (!ready) return
  player.setFlying(false)
  editor.setActive(false)
  panel.syncSelection()
})

bootWorld().catch(bootFail)
