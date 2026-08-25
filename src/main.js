import * as THREE from 'three'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { TerrainHeight, WORLD_SIZE } from './sim/terrain-height.js'
// One spawn rule, shared with Phase A and check-sim. It used to be copied
// into all three, and the copies had already drifted apart -- check-sim held
// 85-140 m under a comment saying it must match main.js, which held 25-70 m.
import { findSpawn, SPAWN } from './sim/phase-a.js'
import { Terrain, CHUNK_RES } from './terrain/terrain.js'
import { LOD, MAX_DEPTH, MIN_TRI_DEG, MAX_TRI_DEG } from './terrain/quadtree.js'
import { Player, LOCOMOTION } from './player.js'
import { Scatter } from './props/scatter.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { Villages } from './village/village.js'
import { VILLAGE_PLAN } from './village/plan.js'
import { Water } from './water.js'
import { Vignette } from './vignette.js'
import { Sky } from './sky.js'
import { Stars } from './stars.js'
import { Aurora } from './aurora.js'
import { WorldClock, CLOCK } from './clock.js'
import { WorldLighting } from './lighting.js'
import { SkyProbe } from './sky-probe.js'
import { Measure } from './measure.js'
import { Hud } from './hud.js'
import { Tuner } from './tuner.js'
import { Input } from './input.js'
import { budgetLine } from './budget.js'

// ---------------------------------------------------------------------------
// Aurora -- build step 2: terrain + locomotion vertical slice (DESIGN.md §14).
//
// Goal for this step, verbatim from the build order: "Get this to a stable
// 72 Hz with an empty world before adding a single tree."
// ---------------------------------------------------------------------------

const SEED = 20260804
const FOG_COLOR = 0x9db4cf
const SUN_COLOR = 0xfff2dc

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
// Only ever seen if the sky dome fails to draw -- it is a full enclosing sphere.
// Kept as the fog colour so that failure degrades to the old flat sky rather
// than to black.
scene.background = new THREE.Color(FOG_COLOR)
// Atmospheric perspective does most of the work of selling scale, and it is
// also what hides LOD popping at the chunk ring boundaries (§5).
//
// FOG_COLOR has to stay close to the sky dome's HORIZON colour, not its zenith:
// distant terrain fades toward the fog, and it meets the sky at the horizon.
// Fog matching the zenith would ring every ridgeline in a colour the sky behind
// it does not have.
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00022)

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 20000)
camera.rotation.order = 'YXZ'
camera.position.y = LOCOMOTION.eyeHeight // desktop only; XR overwrites this from the pose

const rig = new THREE.Group()
rig.add(camera)
scene.add(rig)

// ONE directional light, per Meta's guidance (§5), and it does double duty: it
// is the sun by day and the moon after dark. Hemisphere fill is not a
// shadow-casting light and costs nothing meaningful in Lambert -- without it
// the shadowed faces of every cliff go flat black.
//
// The handover between the two bodies happens at -6 deg of sun elevation, where
// the sun's intensity has already reached zero, so the direction snapping from
// one to the other cannot be seen. clock.js has the argument in full.
const sun = new THREE.DirectionalLight(SUN_COLOR, 2.1)
sun.position.set(-0.45, 0.62, 0.3).normalize()
scene.add(sun)
const hemi = new THREE.HemisphereLight(0xbfd4ee, 0x2c3140, 0.85)
scene.add(hemi)

// The clock: 24 real minutes to the in-world day (§8), so a minute of standing
// still is an hour of light changing. Everything below reads its state; nothing
// below decides anything about time for itself.
const clock = new WorldClock({ seed: SEED })


// --- world ------------------------------------------------------------------

const terrainHeight = new TerrainHeight(SEED)
const terrain = new Terrain(scene, { seed: SEED, workers: 2 })
// The one prop texture: every textured prop in the world is a layer of this
// single DataArrayTexture, so they all share one material and one draw call.
// See the header of textures.js for why an array and not a packed atlas.
const propTextures = buildTextureArray()
// Scale reference only -- see the header of props/scatter.js. The real
// placement system is §6 and lands at build step 5.
const props = new Scatter(scene, terrainHeight, propTextures, { seed: SEED })
// Real PNG layers arrive asynchronously. The array is usable immediately --
// unloaded layers are transparent, so alphaTest discards them and a fern is
// briefly invisible rather than magenta. A failure here is a broken build and
// is thrown, not swallowed.
//
// The fern impostors are baked off the back of it, and the ORDER is the whole
// point: the card is a photograph of the fern wearing FROND_0, so taking it
// before that PNG lands would photograph an invisible plant. This is also why
// there is no offline bake step -- see Scatter.bakeCards.
loadImageLayers(propTextures)
  .then(() => props.bakeCards(renderer))
  .catch((err) => {
    console.error('prop textures failed to load', err)
    throw err
  })
// A village appears and disappears under the scatter's feet, so the scatter has
// to be told to re-place -- otherwise the trees it put there before the village
// arrived are left standing in the great hall.
const villages = new Villages(scene, terrainHeight, { seed: SEED, onChange: () => props.invalidate() })

// Terrain shadows and ambient occlusion, from the horizon map baked alongside
// Phase A. The maps arrive a few seconds after the world does; until they land
// `uSunSky.z` is 0 and every material returns full sun, so the only visible
// difference is that the mountains have no shadows yet.
const lighting = new WorldLighting()

// The dome takes its colours from the clock every frame -- there is no separate
// night sky, just a different set of numbers. Stars and aurora are additive
// layers on top of it, both hidden entirely whenever their fade is zero.
const sky = new Sky(scene)

// The aurora and the stars are meshes, so the analytic sky reflection cannot
// see them. This captures those two and nothing else, five faces at 64 px, one
// face per update. See sky-probe.js -- particularly the note on why they are
// ENABLED on a second layer rather than moved to one.
const probe = new SkyProbe()

// Constructed AFTER those three on purpose: the water reflects the sky by
// calling the dome's own shading function, asks the horizon map where the
// mountains are, and adds the probe's aurora on top -- taking all three by
// reference. See water.js.
const water = new Water(scene, { sky, lighting, probe })
// Nothing grows underwater. The village test comes first because it is a
// distance check against a handful of sites, and heightAt is only paid on the
// few candidates that land on a water cell at all -- levelAt is one array
// lookup and returns null everywhere else.
props.setExclusion((x, z, kind) => {
  if (villages.excludes(x, z, kind)) return true
  const level = water.levelAt(x, z)
  return level !== null && terrainHeight.heightAt(x, z) < level
})

lighting.patch(terrain.material, {
  mode: 'fragment',
  cacheKey: 'aurora-terrain-v7-shadow',
  // terrain-material.js has carried this varying since the surface grain was
  // written; reusing it saves declaring a second one that holds the same value.
  worldPosVarying: 'vWorldPos',
})
for (const [mat, key] of [
  [props.material, 'prop-scatter-shadow-v1'],
  // Distinct key from the line above even though both are Lambert: this one's
  // program also carries the sampler2DArray patch, and sharing a cache key
  // would let three hand one material the other's compiled program.
  [props.atlasMaterial, 'prop-atlas-shadow-v1'],
  [villages.solidMat, 'village-solid-shadow-v1'],
  [villages.pathMat, 'village-path-shadow-v1'],
  [villages.puffMat, 'village-puff-shadow-v1'],
]) {
  // Per-vertex for these: a tree is small compared to a mountain's shadow, and
  // props are the triangle budget. villages.flameMat is deliberately NOT in
  // this list -- it is MeshBasicMaterial and unlit on purpose, and a fire that
  // went dark inside a shadow would be the one thing that gave the village
  // away.
  lighting.patch(mat, { mode: 'vertex', cacheKey: key })
}

const stars = new Stars(scene, { seed: SEED, pixelRatio: renderer.getPixelRatio() })
const aurora = new Aurora(scene, { seed: SEED })

// Both stay on layer 0 and keep rendering to both eyes exactly as before; this
// only ADDS them to the probe camera's layer. Moving them would make them
// invisible in the headset -- three reserves layers 1 and 2 for the eyes and
// masks with three bits, so anything above layer 2 is drawn by neither. The
// full trap is written out in sky-probe.js.
SkyProbe.include(aurora.mesh, stars.points)

// Phase A, in the browser, for the first time. It has existed since §2 and been
// exercised only by map.html; the game itself has been running on the raw
// analytic surface with no water in it at all.
//
// RESOLUTION IS 1024, NOT world-grid's 2048. The pass costs ~4 s at 1024^2 and
// ~15 s at 2048^2, against §2's 1-3 s load budget. Neither fits, so this is the
// one that fits WORST-LESS, and it is off the main thread: the world is walkable
// immediately and the lakes arrive a few seconds later. Say so out loud rather
// than let it look like a hitch.
//
// The cell is 16 m at this resolution instead of 8 m, which costs nothing
// visible -- Water dilates the mask and lets the terrain cut the shoreline, so
// the grid never reaches the screen. What it does cost is small ponds: a body
// has to clear LAKE.minCells at whatever cell size it is measured in.
const PHASE_A_RES = 1024
const phaseAWorker = new Worker(new URL('./sim/phase-a-worker.js', import.meta.url), { type: 'module' })
phaseAWorker.onmessage = (e) => {
  const m = e.data
  if (m.type === 'log') {
    console.log(`[phase A] ${m.line}`)
    return
  }
  // Not a silent fallback. A world with no water is a world missing a feature
  // §11 exists to provide, and it should be loud about it.
  if (m.type === 'error') throw new Error(`Phase A failed: ${m.message}\n${m.stack}`)
  const r = m.result

  // The horizon map, baked in the worker off Phase A's own elevation grid.
  // From this frame on, mountains cast shadows and valleys are occluded --
  // see src/sim/horizon.js.
  lighting.setMaps(r.horizon, r.skyView, r.n)
  console.log(`[phase A] horizon map live: ${r.n}^2 x 16 azimuths, ${(r.horizon.length / 1048576).toFixed(1)} MB`)

  const built = water.setFromPhaseA({ lake: r.lake, filled: r.filled, ground: r.base, n: r.n, cell: r.cell })

  // Put her where the water is, if she has not already walked off.
  //
  // Measured on seed 20260804: the nearest lake to the analytic spawn is 3.7 km
  // away, which is a forty-minute walk to look at the feature you just built.
  // findSpawn cannot fix this itself -- it runs on the main thread before Phase
  // A exists, and waiting for the lakes would cost 3.5 s of standing still.
  //
  // So the analytic spawn stands, and is REVISED once the water lands. The
  // "has she moved" test is what keeps this from being a teleport: if she is
  // already exploring, the ground under her does not move.
  const moved = Math.hypot(player.rig.position.x - spawn.x, player.rig.position.z - spawn.z)
  const big = r.lakes.filter((l) => l.cells >= 200)
  if (moved < 5 && big.length) {
    const target = big.map((l) => ({ l, d: Math.hypot(l.x - spawn.x, l.z - spawn.z) })).sort((a, b) => a.d - b.d)[0].l
    // The centroid of a lake is IN the lake. Walk out from it until the ground
    // clears the water, so she starts on the shore rather than treading water.
    let sx = target.x
    let sz = target.z
    for (let rad = r.cell; rad <= 4000; rad += r.cell) {
      let found = null
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2
        const x = target.x + Math.cos(ang) * rad
        const z = target.z + Math.sin(ang) * rad
        const h = terrainHeight.heightAt(x, z)
        if (h > target.level + 2 && terrainHeight.slopeAt(x, z) < SPAWN.maxSlope) { found = { x, z }; break }
      }
      if (found) { sx = found.x; sz = found.z; break }
    }
    player.spawnAt(sx, sz)
    console.log(`[phase A] spawn revised to the shore of a ${target.cells}-cell lake at ${target.level.toFixed(0)}m, ${(Math.hypot(sx - spawn.x, sz - spawn.z) / 1000).toFixed(2)} km from the analytic spawn`)
  }
  console.log(
    `[phase A] water: ${r.lakes.length} bodies, ${built.tiles} tiles, ${built.triangles} tris, ` +
      `surfaces ${Math.min(...r.lakes.map((l) => l.level)).toFixed(0)}..${Math.max(...r.lakes.map((l) => l.level)).toFixed(0)}m`
  )
  // The scatter only rebuilds when the camera crosses a grid cell, and the
  // lakes arriving is a change to the answer that standing still will not
  // notice. Without this the trees already placed stay in the water.
  props.invalidate()
  phaseAWorker.terminate()
}
phaseAWorker.postMessage({ seed: SEED, n: PHASE_A_RES })

const player = new Player(rig, camera, terrainHeight)
const vignette = new Vignette(camera)
const measure = new Measure(scene, terrainHeight)
const hud = new Hud()
camera.add(hud.mesh)
hud.mesh.position.set(0, -0.28, -1.1)
const input = new Input(renderer)
// Desktop-only survey tool (§0): the terrain constants are named after what
// they do, not after the scale they act at, so tuning them from a written
// description means guessing which one you meant. The panel labels each one
// with its real-world wavelength instead. See the header of tuner.js. It also
// takes terrainHeight so it can report what each knob is worth on the ground
// she is standing on -- most of these layers are gated, and a gated-off knob is
// indistinguishable from a broken one without that.
const tuner = new Tuner(terrain, terrainHeight)

const spawn = findSpawn(terrainHeight)
player.spawnAt(spawn.x, spawn.z)

// TEMPORARY, and the only temporary thing about the village. SITING belongs to
// Phase A (§6), which scores sites on proximity to fresh water and rejects
// anything sitting in a lake -- and Phase A is not wired into main.js yet, only
// into map.html via the worker. So that there is something to walk to
// meanwhile, one stand-in site is dropped on the gentlest ground in a ring
// around spawn. Delete this whole block and pass Phase A's scored villages to
// setSites() the moment the macro pass lands here: nothing about the village
// CONTENT changes, it just moves to where the water is.
//
// No absolute metres anywhere in here, deliberately. The band is SPAWN's own
// snow-line-relative one, and the slope test is "gentlest of the candidates"
// rather than a threshold -- §3's recurring failure is a constant drifting out
// from under the thing it names, and this file has already been bitten once by
// an elevation window that stopped meaning what it said.
//
// Slope is measured across the PLAZA RIM, not at the point. Measured over 263
// candidates in this band, ranking by point slope gave a best of 1.7 deg that
// was 24.7 deg across the rim -- a knife-edge crest, gentle exactly where it
// was sampled -- and 9 of the top 20 could not fit a great hall. Ranking by rim
// slope: 2 of 20. A village is 136 m across and cares about the ground it
// covers, not about one probe.
function devVillageSite() {
  const rimSlope = (x, z) => {
    let sum = 0
    for (const r of [VILLAGE_PLAN.plazaRadius, VILLAGE_PLAN.ringRadius]) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2
        sum += terrainHeight.slopeAt(x + Math.cos(ang) * r, z + Math.sin(ang) * r)
      }
    }
    return sum / 24
  }
  let best = null
  for (let r = 300; r <= 1200; r += 50) {
    for (let a = 0; a < 32; a++) {
      const ang = (a / 32) * Math.PI * 2 + r * 0.37
      const x = spawn.x + Math.cos(ang) * r
      const z = spawn.z + Math.sin(ang) * r
      const h = terrainHeight.heightAt(x, z)
      const snow = terrainHeight.snowLineAt(x, z)
      if (h > snow - SPAWN.minBelowSnow) continue // green ground, same rule as spawn
      if (h < snow - SPAWN.maxBelowSnow) continue
      const slope = rimSlope(x, z)
      if (!best || slope < best.slope) best = { x, z, slope, id: 0 }
    }
  }
  if (!best) throw new Error('no stand-in village site within 1.2 km of spawn -- check SPAWN in phase-a.js')
  return best
}

const devSite = devVillageSite()
villages.setSites([devSite])

// --- desktop controls -------------------------------------------------------

// Bindings are resolved to named ACTIONS from both the typed character and the
// physical key position, and either one firing is enough.
//
// This matters here: the keyboard is Dvorak, where `,aoe` sit on the physical
// WASD keys. `KeyboardEvent.code` reports position (KeyW) and ignores layout;
// `KeyboardEvent.key` reports the character the layout produced (`,`). Binding
// only one of them means either the letters are wrong or the finger positions
// are. Binding both means `,aoe` and `wasd` are the same keys on Dvorak, and
// the file still works unchanged on a QWERTY machine.
const KEY_ACTIONS = {
  ',': 'forward',
  a: 'left',
  o: 'back',
  e: 'right',
  ' ': 'flyUp',
  Shift: 'flyDown',
  h: 'hud',
  u: 'unstick',
  t: 'tuner',
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
  KeyT: 'tuner',
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
let dragging = false

// Space does two jobs, Minecraft-style: hold it to rise, tap it twice to land.
// There is no separate "enter fly mode" key -- the first tap does that, because
// the only reason to press space on the ground is to leave it.
const DOUBLE_TAP_MS = 320
let lastSpaceTap = -Infinity

function onSpacePress(now) {
  if (now - lastSpaceTap < DOUBLE_TAP_MS) {
    // Reset rather than carry the timestamp forward, so three taps read as one
    // pair and a fresh single rather than as two overlapping pairs.
    lastSpaceTap = -Infinity
    setFlying(false)
    return
  }
  lastSpaceTap = now
  setFlying(true)
}

// Typing a number into the tuning panel must not also walk her across the
// valley: `,aoe` are movement keys and every one of them is a digit's
// neighbour on the way to the number box.
const typing = (e) =>
  e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

addEventListener('keydown', (e) => {
  if (typing(e)) return
  const actions = actionsFor(e)
  if (actions.length === 0) return
  if (actions.includes('flyUp')) e.preventDefault() // space scrolls the page otherwise
  const fresh = actions.filter((a) => !held.has(a))
  for (const a of actions) held.add(a)

  // One-shot actions fire on the transition, not while held. Auto-repeat is
  // already filtered out by `fresh`, which matters for the double-tap: a held
  // space would otherwise machine-gun taps and land her immediately.
  if (fresh.includes('hud')) hud.toggle()
  if (fresh.includes('tuner')) tuner.toggle()
  if (fresh.includes('timeSkip')) skipTime()
  if (fresh.includes('auroraPattern')) cycleAurora()
  if (fresh.includes('flyUp')) onSpacePress(e.timeStamp)
  // triDeg is a size budget, so finer means smaller. Stepped
  // multiplicatively because the perceptual distance from 1.0 to 1.2 degrees is
  // nothing like the distance from 0.4 to 0.6, and a fixed step would crawl at
  // the coarse end and leap at the fine one.
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

function setFlying(want) {
  // Never in the headset: 29 m/s of free flight with no ground reference is
  // exactly the vestibular mismatch §12 exists to prevent.
  player.setFlying(want && !renderer.xr.isPresenting)
}
// The mouse does double duty: drag to look, click to measure. Distinguishing
// them by accumulated pointer travel rather than by button or modifier keeps
// both on the same gesture you already use, and 5 px is comfortably above
// hand-tremor and comfortably below any intentional look.
const CLICK_SLOP = 5
let dragTravel = 0
let lastGroundClick = -Infinity
const ndc = new THREE.Vector2()

renderer.domElement.addEventListener('pointerdown', () => {
  dragging = true
  dragTravel = 0
})
addEventListener('pointerup', (e) => {
  const wasDragging = dragging
  dragging = false
  if (!wasDragging || renderer.xr.isPresenting || dragTravel > CLICK_SLOP) return
  const rect = renderer.domElement.getBoundingClientRect()
  ndc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  )
  // A click on the sky misses the height field and clears the marker, which is
  // also how you get rid of one.
  const onGround = measure.measure(camera, ndc)

  // Double-click the ground to fly there. Same DOUBLE_TAP_MS as the space
  // gesture, so there is one "do it twice" timing in the whole app rather than
  // two that feel subtly different.
  //
  // The single click still measures, which is the point: the first click plants
  // the beam so you can see exactly where the second one is going to send you.
  // A miss resets the timer -- clicking sky then ground should not teleport.
  if (!onGround) {
    lastGroundClick = -Infinity
    return
  }
  if (e.timeStamp - lastGroundClick < DOUBLE_TAP_MS) {
    lastGroundClick = -Infinity
    player.travelTo(measure.hit.x, measure.hit.z)
    // The beam has done its job once the trip is committed. Leaving it up plants
    // it exactly where she lands, so she arrives inside a 90 m red pillar and
    // has to click the sky to get rid of it.
    measure.clear()
  } else {
    lastGroundClick = e.timeStamp
  }
})
addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return
  dragTravel += Math.abs(e.movementX) + Math.abs(e.movementY)
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

// --- time -------------------------------------------------------------------

// The hotkey: N on the keyboard, right grip in VR.
//
// Six in-world hours, which at §8's pace is six real minutes of standing about
// waiting for dusk. That ratio is the entire reason this exists: the day-night
// cycle is a twenty-four minute loop, so without a skip, checking whether the
// sunset looks right means watching sixteen minutes of afternoon first.
//
// It moves the clock's MONOTONIC hour counter, not the hour of day, so the
// aurora's substorm envelope advances by the same six hours the sun does. Skip
// four times and you land back at the same time of day with entirely different
// weather, which is what should happen.
let skipFlash = -Infinity
function skipTime() {
  clock.skip(CLOCK.skipHours)
  skipFlash = performance.now()
  console.log(`[clock] +${CLOCK.skipHours}h -> ${clock.clockText}  sun ${clock.sun.elevDeg.toFixed(1)}deg`)
}

// Step the aurora through auto, then each named form in turn, then back to
// auto. Pinning a form is how you look at one deliberately instead of waiting
// for the composer to roll it -- some of these are rare on purpose, and a form
// you cannot summon is a form you cannot judge or debug.
let auroraFlash = -Infinity
function cycleAurora() {
  const i = aurora.cyclePattern()
  auroraFlash = performance.now()
  console.log(`[aurora] ${aurora.label}${aurora.blurb ? `  --  ${aurora.blurb}` : ''}`, i)
}

const tmpCol = new THREE.Color()
const setSRGB = (col, rgb) => col.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)

// Push one clock state into every consumer. This is the whole day-night cycle
// as far as the scene is concerned: six colours, three intensities and a fog
// density, all read from one table in clock.js.
function applySky(state, head, elapsedReal) {
  // The single directional light follows whichever body is in charge.
  // `position` on a DirectionalLight is a DIRECTION, since its target sits at
  // the origin and three uses the difference.
  sun.position.set(state.lightDir.x, state.lightDir.y, state.lightDir.z)
  setSRGB(sun.color, state.lightColor)
  sun.intensity = state.lightIntensity

  setSRGB(hemi.color, state.hemiSky)
  setSRGB(hemi.groundColor, state.hemiGround)
  hemi.intensity = state.hemiIntensity

  // Fog tracks the sky's HORIZON colour, not its zenith (see the note at
  // scene.fog): distant terrain fades toward the fog and meets the sky at the
  // horizon, so any mismatch draws a coloured line along every ridge. Density
  // rises a little after dark because night air reads as thicker -- and because
  // it hides the far terrain that the moon is not bright enough to light.
  setSRGB(scene.fog.color, state.fog)
  scene.fog.density = state.fogDensity
  setSRGB(tmpCol, state.fog)
  scene.background.copy(tmpCol)

  lighting.update(state)
  sky.update(head, state)
  stars.update(head, state, clock.elapsed, elapsedReal)
  aurora.update(head, state, elapsedReal)
  // After sky.update: the waves are the only thing here on the wall clock, but
  // the reflection they bend is written by the line above, and a frame where
  // the two disagree is a frame where the lake is reflecting yesterday's sky.
  // ...and after the hemi light is set, which is the ambient the water's
  // mountain silhouettes are matched to. `hemi` is passed rather than `state`
  // because these three have already made the trip into linear here, and the
  // water needs the same numbers the terrain's shader will get, not the sRGB
  // triples they were authored as.
  water.update(elapsedReal, hemi)
}

// --- frame loop -------------------------------------------------------------

let last = performance.now()
let frames = 0
let acc = 0
let avgMs = 0
let worst = 0
const moveInput = { move: 0, strafe: 0, lift: 0, turn: 0, unstick: false, instant: false }
const headTmp = new THREE.Vector3()

function readInput() {
  const st = input.update()
  if (st.connected > 0) {
    // Left stick forward only (§12). axes[1] is negative when pushed up.
    moveInput.move = Math.max(0, -st.left.axes[1])
    moveInput.strafe = 0 // no strafing in VR, on purpose
    moveInput.lift = 0 // fly mode never runs in XR; see LOCOMOTION in player.js
    // Snap turn from either stick, so she does not have to remember which.
    const lx = st.left.axes[0]
    const rx = st.right.axes[0]
    moveInput.turn = Math.abs(lx) > Math.abs(rx) ? lx : rx
    moveInput.unstick = !!st.left.buttons.SECONDARY?.justPressed
    // The eased ramp is a VR comfort measure (§12) and belongs only here, where
    // there is a vestibular system to disagree with the moving world.
    moveInput.instant = false
    if (st.right.buttons.SECONDARY?.justPressed) hud.toggle()
    // Right GRIP: skip six hours. GRIP rather than a face button because the
    // face buttons are taken and because a squeeze is hard to hit by accident
    // -- this is the one control in the game that changes the world rather than
    // her position in it.
    if (st.right.buttons.GRIP?.justPressed) skipTime()
    // Right PRIMARY (A): cycle aurora patterns. The one face button still free
    // on that hand, and the aurora is the thing you are most likely to want to
    // change while standing in the headset looking up at it.
    if (st.right.buttons.PRIMARY?.justPressed) cycleAurora()
    if (st.left.buttons.PRIMARY?.justPressed) player.recenterXR(renderer)
    return
  }
  moveInput.move = (on('forward') ? 1 : 0) - (on('back') ? 1 : 0)
  moveInput.strafe = (on('right') ? 1 : 0) - (on('left') ? 1 : 0)
  moveInput.lift = (on('flyUp') ? 1 : 0) - (on('flyDown') ? 1 : 0)
  // A key is already a binary input; ramping it up over half a second just reads
  // as lag when the world is on a monitor.
  moveInput.instant = true
  // Snap turn on the arrow keys, so the VR turn path still gets exercised on
  // desktop now that the letter keys strafe instead.
  moveInput.turn = (on('turnRight') ? 1 : 0) - (on('turnLeft') ? 1 : 0)
  moveInput.unstick = on('unstick')
}

function tick() {
  const now = performance.now()
  const raw = now - last
  last = now
  // Clamp dt so a tab-switch or a GC pause cannot teleport her across a valley.
  const dt = Math.min(0.1, raw / 1000)

  acc += raw
  frames++
  if (raw > worst) worst = raw
  if (frames >= 30) {
    avgMs = acc / frames
    frames = 0
    acc = 0
  }

  readInput()
  player.update(dt, moveInput)
  // Suppressed while flying: at 29 m/s the speed vignette closes to a pinhole,
  // and the whole point of fly mode is to see the periphery. Travel is the same
  // argument several times over -- 500 m/s against a walking top speed of 1.45
  // would peg the vignette shut for the entire flight.
  vignette.update(player.flying || player.travel ? 0 : player.speed / LOCOMOTION.maxSpeed, dt)

  // Called every frame, but it throttles its own quadtree reselection (§5:
  // stagger CPU work). Streaming has to run at frame rate even when selection
  // does not, or a chunk that arrived mid-interval keeps showing its coarse
  // ancestor until the next selection tick.
  player.headPosition(headTmp)
  // Altitude and gaze both feed the split rule: y makes the range term 3D (at
  // 500 m up, ground 100 m away on the map is 510 m away in fact) and yaw is
  // what stops two thirds of the slot pool going to terrain behind her head.
  terrain.update({ x: headTmp.x, y: headTmp.y, z: headTmp.z, yaw: player.headYaw() })
  props.update(headTmp.x, headTmp.z)
  // After props.update, because a village that finishes building this frame
  // invalidates the scatter, and the scatter should rebuild on the next frame
  // rather than twice on this one.
  villages.update(headTmp.x, headTmp.z, now / 1000)
  // After terrain.update, because it reads this frame's selection size to catch
  // an LOD setting that is about to overrun the slot pool.
  tuner.update(headTmp)

  // Real seconds in, in-world hours out. Advanced with the SAME clamped dt the
  // player uses, so a tab-switch does not fast-forward the sun across the sky
  // while she stands still.
  clock.advance(dt)
  const skyState = clock.state()
  // headTmp is her head position, already computed above for terrain streaming.
  applySky(skyState, headTmp, now / 1000)

  hud.setLines(hudLines(skyState))
  hud.paint(now)

  // BEFORE the main render, and that ordering is load-bearing: the probe binds
  // a render target and toggles renderer.xr off to get its own camera looked
  // through. Doing it after the XR framebuffer is set up but before the scene
  // is drawn would put the frame in the wrong buffer.
  probe.update(renderer, scene, headTmp)

  renderer.render(scene, camera)
}

function hudLines(skyState) {
  const info = renderer.info
  const head = player.headPosition(headTmp)
  const ts = terrain.stats
  const pr = props.stats
  const bk = pr.byKind
  const ground = terrainHeight.heightAt(head.x, head.z)
  const slopeDeg = (terrainHeight.slopeAt(head.x, head.z) * 180) / Math.PI
  const measureLine = measure.line(head)
  const vs = villages.stats
  const vd = Math.hypot(head.x - devSite.x, head.z - devSite.z)

  return [
    '## AURORA -- step 2: terrain + locomotion',
    `frame ${avgMs.toFixed(2)}ms (${avgMs > 0 ? (1000 / avgMs).toFixed(1) : '--'} fps)  worst ${worst.toFixed(1)}ms`,
    `draw calls ${info.render.calls}   triangles ${(info.render.triangles / 1000).toFixed(1)}k`,
    // Batched instances, which are a budget of their own -- see budget.js. The
    // terrain's resident chunks count: they are instances in a BatchedMesh and
    // pay the same per-frame cull-and-sort as a prop does.
    budgetLine(info, pr.count + ts.rendered),
    '',
    '## sky  --  N (or right grip) = +6h   P (or right A) = aurora pattern',
    `${clock.clockText}   sun ${clock.sun.elevDeg.toFixed(1)}deg az ${clock.sun.azDeg.toFixed(0)}   ` +
      `moon ${clock.moon.elevDeg.toFixed(1)}deg lit ${(clock.moonLit * 100).toFixed(0)}%`,
    `light ${skyState.isNight ? 'moon' : 'sun'} ${skyState.lightIntensity.toFixed(2)}   ` +
      `stars ${(skyState.stars * 100).toFixed(0)}%   shadows ${lighting.ready ? 'on' : 'baking'}`,
    `${skyState.aurora > 0.004 ? '++' : ''}aurora ${(skyState.aurora * 100).toFixed(0)}%   ` +
      `substorm ${(skyState.activity * 100).toFixed(0)}%   ceiling ${(skyState.auroraMax * 100).toFixed(0)}%` +
      (performance.now() - skipFlash < 1500 ? `   ++ +${CLOCK.skipHours}h` : ''),
    // What is actually in the sky right now, named. In auto mode this lists
    // every form the composer has up and its weight, which is the only way to
    // tell a deliberate overlay from a bug.
    `pattern ${skyState.aurora > 0.004 ? aurora.label : '-- (daylight)'}` +
      (performance.now() - auroraFlash < 2500 ? '   ** CHANGED **' : ''),
    ...(aurora.blurb && skyState.aurora > 0.004 ? [`        ${aurora.blurb}`] : []),
    '',
    '## terrain (1 batched draw call)',
    `chunks  render ${ts.rendered}/${ts.desired}   pending ${ts.pending}   slots ${ts.slots}/${ts.cached}`,
    `chunk tris ${(ts.drawnTris / 1000).toFixed(1)}k drawn of ${(ts.tris / 1000).toFixed(1)}k resident   res ${CHUNK_RES}   gen ${ts.lastGenMs.toFixed(1)}ms`,
    `triangles <=${LOD.triDeg.toFixed(2)}deg ([ ])   depth<=${MAX_DEPTH}   world ${WORLD_SIZE / 1000}km`,
    `bounds known for ${ts.bounds} nodes`,
    `T = live terrain tuner${tuner.visible ? '   ** OPEN **' : ''}`,
    '',
    '## props (1 batched draw call)',
    `tree ${bk.tree ?? 0}  rock ${bk.rock ?? 0}  grass ${bk.grass ?? 0}  cabin ${bk.cabin ?? 0}`,
    `fern ${bk.fern ?? 0} to 26m  + ${bk.fern_far ?? 0} to 80m (card past 26m, ` +
      `${pr.cardBakeMs ? `baked ${pr.cardBakeMs.toFixed(1)}ms` : 'not baked yet'})`,
    `${(pr.tris / 1000).toFixed(1)}k tris   last place ${pr.lastBuildKind} ${pr.lastBuildMs.toFixed(1)}ms`,
    '',
    '## village (1 draw call + paths + fire)',
    `${vs.state}${vs.resident === null ? '' : ` #${vs.resident}`}   ${vd.toFixed(0)}m away   (stand-in site -- siting is Phase A's)`,
    `${(vs.tris / 1000).toFixed(1)}k tris + ${(vs.pathTris / 1000).toFixed(1)}k path   ${vs.instances} pieces   ${vs.flames} flames  ${vs.puffs} puffs`,
    `plan ${vs.planMs.toFixed(1)}ms   build ${vs.buildMs.toFixed(1)}ms${vs.warnings.length ? `   !! ${vs.warnings.join('; ')}` : ''}`,
    '',
    '## position',
    `x ${head.x.toFixed(0)}  z ${head.z.toFixed(0)}`,
    `ground elev ${ground.toFixed(1)}m   eye ${head.y.toFixed(1)}m   agl ${(head.y - ground).toFixed(1)}m`,
    `slope ${slopeDeg.toFixed(0)}deg / max ${LOCOMOTION.maxSlopeDeg}${player.blocked ? '   !! BLOCKED' : ''}`,
    `speed ${player.speed.toFixed(2)} m/s${
      player.travel
        ? `   ** TRAVELLING -- ${((1 - player.travel.t) * player.travel.dist).toFixed(0)} m to go **`
        : player.flying
          ? '   ** FLYING -- space/shift = up/down, space x2 = land **'
          : ''
    }`,
    ...(measureLine ? ['', measureLine] : []),
  ]
}

renderer.setAnimationLoop(tick)

// Reset the worst-frame marker when a session starts, so the load hitch and the
// desktop warm-up do not poison the number that actually matters in VR.
renderer.xr.addEventListener('sessionstart', () => {
  worst = 0
  player.cancelTravel() // a 500 m/s rail is the last thing to be on entering XR
  player.setFlying(false) // desktop survey tool only; see LOCOMOTION in player.js
  held.clear()
  // In the headset the stats live on the head-locked panel; the DOM corner
  // panel is not visible there at all. On desktop it is the other way round.
  hud.setPresenting(true)
  const session = renderer.xr.getSession()
  if (session?.supportedFrameRates?.includes(72)) session.updateTargetFrameRate(72)
})

renderer.xr.addEventListener('sessionend', () => {
  hud.setPresenting(false)
})

console.log(
  `aurora: seed ${SEED}, spawn ${spawn.x.toFixed(0)},${spawn.z.toFixed(0)} at ${spawn.h.toFixed(0)}m, ` +
    `triangles <=${LOD.triDeg}deg`
)
