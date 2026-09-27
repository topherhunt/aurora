import THREE from '../three-instance.js'

import { HEIGHTMAP_URL, HEIGHTMAP_META_URL, SEED, WORLD_HALF } from './config.js'
import { Heightmap } from './height/heightmap.js'
import { V2Height } from './height/field.js'
import { RELIEF_SHIPPED, normalizeRelief, sameRelief } from './height/relief.js'
import { Layers } from './layers/layers.js'
import { BiomeField } from './layers/biome.js'
import { snowDefaults } from './layers/doc.js'
import { TerrainV2 } from './terrain/terrain-v2.js'
import { TerrainWire } from './terrain/wire.js'
import { LOD, MIN_TRI_DEG, MAX_TRI_DEG } from './terrain/quadtree-v2.js'
import { Markers } from './render/markers.js'
import { WaterSurfaces } from './render/water-surfaces.js'
import { Editor, TOOL_KEYS, TOOLS } from './edit/editor.js'
import { raymarchGround, screenRay, pointerNdc, pickProp } from './edit/pick.js'
import { Panel } from './ui/panel.js'
import * as persist from './edit/persist.js'
import { installLogShip } from './log-ship.js'
import { Trees, DENSITY as TREE_DENSITY } from './render/trees.js'
import { Ferns } from './render/ferns.js'
import { Boulders } from './render/boulders.js'
import { Grass } from './render/grass.js'
import { TerrainTint } from '../terrain/terrain-tint.js'
import { createPlainTerrainMaterial } from '../terrain/terrain-material.js'
import { Rocks } from './render/rocks.js'
import { Mushrooms } from './render/mushrooms.js'
import { Deadwood, loadDeadwoodBank } from './render/deadwood.js'
import { Bones, loadBonesBank } from './render/bones.js'
import { Carrots, loadCarrotsBank } from './render/carrots.js'
import { Rowboats, loadRowboatsBank } from './render/rowboats.js'
import { Boats } from './boats.js'
import { Fish } from './render/fish.js'
import { FishLeap } from './render/fish-leap.js'
import { Frogs } from './render/frogs.js'
import { Crabs } from './render/crabs.js'
import { Butterflies } from './render/butterflies.js'
import { Grasshoppers } from './render/grasshoppers.js'
import { Fireflies } from './render/fireflies.js'
import { Spiders } from './render/spiders.js'
import { Wildlife } from './render/wildlife.js'
import { Snowmen } from './render/snowmen.js'
import { Leafkin } from './render/leafkin.js'
import { LeafkinGround } from './render/leafkin-ground.js'
import { Villagers } from './render/villagers.js'
import { Hobs } from './render/hobs.js'
import { Roosts, loadEggBank, loadRoostMaps } from './render/roosts.js'
import { Dragons } from './render/dragons.js'
import { Entrances, PORTAL, loadMouthBank } from './render/entrances.js'
import { RoomProps, loadHouseBank } from './render/room-props.js'
import { InteriorView, loadInteriorTextures } from './render/interior.js'
import { Residents } from './render/residents.js'
import { InteriorStone, flatField, rAt, rollInterior } from './rooms/interior.js'
import { Lamps, loadLampBank } from './render/lamps.js'
import { Hearth } from './render/hearth.js'
import { Stools } from './render/stools.js'
import { Shell } from './render/shell.js'
import { rollVillage, buildVillage, gardenSpots, plotsOccupy, roofFerns, weedGardens, WOOD, HER_SCALE } from './rooms/village.js'
import { keyHash } from '../sim/score.js'
import { loadCritterGlb, setTierTint } from './render/critters.js'
import { Litter } from './render/litter.js'
import { buildTextureArray, loadImageLayers } from '../textures.js'
import { bakeRockImpostor, buildRockBank } from '../props/rock-bank.js'
import { setSnow, setMoss, setPropClock, setStripTiling, getStripTiling, setWindEnabled } from '../material.js'

// v1 LEAF MODULES, shared on purpose (§18's shared list). Every one of these is
// about the SKY or about the BODY and neither depends on where the ground came
// from. What v2 must not import is v1's ANSWER to the ground question --
// sim/terrain-height.js and sim/phase-a.js -- and scripts/check-v2.mjs fails
// the build if it ever does.
import { Player, LOCOMOTION } from '../player.js'
import { WalkSurface } from './walk.js'
import { Hands, REACH_M } from './hands.js'
import { HandsNet } from './hands-net.js'
import { FLAREGUN_GLB, FlareGuns, GunWindows, ShotFlash, KIND as FLAREGUN, PALETTE, MUZZLE, aimTarget, roomKey } from './flaregun.js'
import { Flares, fromWire, toWire } from './render/flares.js'
import { CreatureNet } from './creature-net.js'
import { taken } from './taken.js'
import { Sky } from '../sky.js'
import { Stars } from '../stars.js'
// See the header of render/aurora.js: the field is integrated as a convolution
// on a 512x64 map once per frame instead of per pixel, which is what pays for a
// full sky dome. The band mesh it replaced is parked in archive/aurora-mesh/.
import { SkyAurora } from './render/aurora.js'
import { Water, WATER, UNDERWATER, CURRENT, currentDrift, murkDensity, murkLinear, murkAir } from '../water.js'
import { WorldClock, CLOCK, WEATHER, daynessOfElev } from '../clock.js'
import { WorldLighting } from '../lighting.js'
import { SkyProbe, PROBE } from '../sky-probe.js'
import { SKY_GLSL } from '../sky-glsl.js'
import { Wreaths } from './render/wreaths.js'
import { Precip } from './render/precip.js'
import { WorldProbe, WORLD_PROBE } from '../world-probe.js'
import { Input } from '../input.js'
import { Netplay } from '../net.js'
import { popLog } from './render/net-ease.js'
import { PeerAvatars, loadOwnHand, ownHand } from './render/avatar.js'
import { SoundEngine } from './audio/sound-engine.js'
import { WorldSense } from './audio/sense.js'
import { Ambience, RATE, SOUNDS } from './audio/ambience.js'

// First, before anything below can warn: a copy of every warning and error goes
// to the dev server's tmp/client-log.txt, for the headset, which shows none of
// them to anyone at a desk. See log-ship.js.
installLogShip()

// `/` is the world as it ships, on a desktop and in the headset alike. `?editor`
// is the same world with the §18 authoring tools over it: the corner panel, the
// handles and the Tab-armed tools, none of which the plain route constructs.
const EDITOR_MODE = new URLSearchParams(location.search).has('editor')

// ---------------------------------------------------------------------------
// The /v2 route (DESIGN.md §18): the imported world, walkable, with the
// authoring tools on top of it.
//
// This file grew out of the retired v1 host with the procedural half cut out and
// the editing half grafted on. What it KEEPS is the day-night wiring, and the
// ordering inside applySky() below must stay unchanged -- the reasons are
// written there. What it DROPS is everything downstream of Phase A: no villages,
// no horizon maps, no measure beam, no HUD panel in the headset.
//
// THREE THINGS ARE VISIBLY DIFFERENT FROM v1 AND ARE NOT BUGS:
//
//   No terrain shadows. WorldLighting is constructed and every material is
//   patched, but nothing calls lighting.setMaps() -- the horizon map is baked by
//   Phase A, which is v1's macro pass over v1's procedural field. Until v2 grows
//   its own, the patch compiles its unready variant: full sun and open sky as
//   constants, with the samplers, the trig and the two dead texture fetches left
//   out of every material rather than branched around at fragment rate. The
//   mountains light correctly and cast nothing.
//
//   No Phase A water. water.setFromPhaseA() is never called, so water.levelAt()
//   is null everywhere and the v1 lake mesh does not exist. All water here is
//   AUTHORED -- lakes and rivers out of the document, built by WaterSurfaces
//   onto the same shared water material, so they wave and reflect exactly like
//   v1's does.
//
//   The prop scatter is TREES, GRASS, FERNS, ROCKS, MUSHROOMS, DEADWOOD and
//   LITTER. Each is a TILED, camera-following scatter that THINS WITH DISTANCE:
//   full density inside its own radius, then halving every time the distance
//   doubles. They are pure functions of position, so they cover the whole map
//   and the same plants come back when you walk away and return, and the
//   thinning is what buys a 1.5 km forest for ~41k instances instead of the 350k
//   a uniform disc would need. Every instance carries the distance at which it
//   stops existing and render/rim.js stamps a quarter-second dither as it
//   crosses, so rims and thinning bands dissolve rather than pop. The plants'
//   far tiers are camera-facing billboards spun in the vertex shader. Each bed's
//   own radii, densities and ladder live in its own header and are deliberately
//   NOT restated here -- render/trees.js, grass.js, ferns.js, rocks.js.
//
//   ROCKS RUN SIX OF THAT SAME SCATTER AT ONCE, because a pebble is 25 cm and a
//   landmark is 20 m and no one density-and-radius pair carries both. There is
//   exactly ONE boulder mesh in the world; what varies is where copies of it go,
//   how big, which way up and what colour. Each site is classified river /
//   forest / cliff / peak, and that decides the size range, the rate and the
//   palette. Snow and moss then arrive from two world lines running in opposite
//   directions, so a rock on a summit is white and the same rock in a damp wood
//   is green, neither costing a byte per instance. See DESIGN.md §25,
//   props/rock-bank.js for the one asset and material.js for the two lines.
//
//   MUSHROOMS ARE THE ONE LAYER THAT IS NOT A SCATTER OVER OPEN GROUND. A clump
//   grows at the foot of something, so where it goes is read back out of the
//   trees and rocks ALREADY standing rather than rolled from position alone.
//   That is why this file builds, re-places and steps them LAST everywhere --
//   see the note at their construction. They are the cheapest layer in the world
//   by a wide margin. See render/mushrooms.js.
//
// BOOT IS ASYNCHRONOUS AND ORDERED, forced by a real dependency:
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

const boot = document.getElementById('boot')
const bootLine = document.getElementById('boot-line')
const bootSub = document.getElementById('boot-sub')
const bootSay = (html) => {
  if (bootLine) bootLine.innerHTML = html
}

// Boot's substeps, each timed, for the overlay's subline and the console.
//
// Everything in bootWorld after the two fetches is synchronous, so a status
// line written before a step is never painted: the browser gets no frame until
// bootDone, and the overlay sits on "loading world/layers.json" for the whole
// build. bootStep closes the previous step's timer, writes the running
// breakdown, then yields a frame so what it wrote is on screen while the step
// runs. The step's clock starts after the yield, so a render the yield lets
// through (flat mode draws the half-built scene until `ready`) is not charged
// to the step that follows it. The frame is raced against a timeout because a
// hidden tab never fires requestAnimationFrame, and boot must not stall in a
// tab nobody is looking at.
//
// A YIELD IS NOT FREE, so `YIELD_AFTER_MS` caps how stale the overlay may go
// rather than buying a frame per step: half the build's steps run under 5 ms
// and a frame costs 13.9 ms on a 72 Hz headset whatever the step did, so a run
// of cheap ones collapses into one frame and only what could hold the screen
// gets its own. No timer here reports that wait -- it falls between the steps.
const bootSteps = []
let bootStepName = null
let bootStepAt = 0
let bootUnyielded = 0
const YIELD_AFTER_MS = 16
const bootFmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`)
async function bootStep(name) {
  if (bootStepName !== null) {
    const ms = performance.now() - bootStepAt
    bootSteps.push({ name: bootStepName, ms })
    bootUnyielded += ms
  }
  bootStepName = name
  if (bootSub) {
    bootSub.innerHTML =
      bootSteps.map((s) => `${s.name} ${bootFmtMs(s.ms)}`).concat(name === null ? [] : [`<b>${name} ...</b>`]).join(' &middot; ')
  }
  if (bootUnyielded >= YIELD_AFTER_MS || bootSteps.length === 0) {
    bootUnyielded = 0
    await new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0))
      setTimeout(resolve, 100)
    })
  }
  bootStepAt = performance.now()
}
/**
 * Close the running step and print the build's table.
 *
 * EVERY build calls this, the first and each swap after it. A step left open
 * runs until the next `bootStep`, which for a swap is the next room -- so the
 * whole of her stay in this room would be charged to the step that finished
 * building it.
 */
function bootReport() {
  if (bootStepName !== null) bootSteps.push({ name: bootStepName, ms: performance.now() - bootStepAt })
  bootStepName = null
  const total = bootSteps.reduce((s, x) => s + x.ms, 0)
  console.log(
    `[v2] boot ${bootFmtMs(total)} in ${bootSteps.length} steps: ` +
      bootSteps.slice().sort((a, b) => b.ms - a.ms).map((s) => `${s.name} ${bootFmtMs(s.ms)}`).join(', ')
  )
}
const bootDone = async () => {
  await bootStep(null)
  bootReport()
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

// A headset has no devtools console. Quest V3 (quest-main.js) already solved
// this by routing crashes onto a world-space panel instead of a flat DOM
// overlay, since the DOM overlay isn't rendered inside the VR canvas at all
// -- ported here so a crash AFTER VR entry (this file's bootFail above only
// helps before/outside VR) is still visible on the headset. Set once there is a
// camera to attach the error plane to (see the block after the renderer boot
// below); reportRuntimeError still runs bootFail unconditionally, since it
// also covers the flatscreen case.
let showQuestRuntimeError = null

// The first error to arrive, held forever. Two things read it: tick(), which
// stops dead (a throw inside A-Frame's tick fires window.onerror EVERY frame
// after, and the fiftieth copy of a stack buries the first), and
// reportRuntimeError itself, so the overlay keeps the first error rather than
// whatever the dying frame threw next.
let fatalError = null

/**
 * Leave VR, so the DOM overlay is on a surface the wearer can actually see.
 *
 * Not a courtesy: while an XR session is live the headset composites the
 * SESSION's framebuffer and nothing in the page is on screen at all, so the red
 * message is invisible until the session is gone.
 *
 * try/catch around the whole of it, and around `sceneEl` in particular, because
 * this runs from window.onerror: a crash during module evaluation reaches here
 * before the `let sceneEl` line has run, and reading it then is a temporal dead
 * zone throw out of the one handler nobody else is watching.
 */
function exitVR() {
  try {
    // A-Frame's own exit, since A-Frame owns the session: it ends the session
    // AND does its bookkeeping (the vr-mode state, the enter-VR button, the
    // canvas resize back to the page). Raw session.end() is the fallback for a
    // crash that lands before the scene element is usable.
    //
    // `sceneEl.is` is guarded as well as `sceneEl`: the element is created
    // before A-Frame upgrades it, so a crash in that window would find a plain
    // <a-scene> with none of its prototype on it yet.
    if (sceneEl && sceneEl.is && sceneEl.is('vr-mode')) sceneEl.exitVR()
    else if (renderer) renderer.xr.getSession()?.end()
  } catch (err) {
    console.error('[v2] could not leave VR to show the error', err)
  }
}

function reportRuntimeError(err) {
  if (fatalError) {
    console.error(err)
    return
  }
  fatalError = err
  bootFail(err)
  exitVR()
  // Belt and braces, and the order matters: if the session refuses to end, the
  // world-space plane is the only surface the wearer has left.
  if (showQuestRuntimeError) showQuestRuntimeError(err)
}
window.addEventListener('error', (e) => reportRuntimeError(e.error ?? new Error(e.message)))
window.addEventListener('unhandledrejection', (e) => {
  reportRuntimeError(e.reason instanceof Error ? e.reason : new Error(String(e.reason)))
})

// --- renderer ---------------------------------------------------------------
//
// The renderer/session bootstrap is A-Frame's (the proven-reliable VR entry
// path, per quest.html/quest-main.js) but locomotion is NOT -- unlike
// quest.html, there's no movement-controls/look-controls/blink-controls here.
// Only laser-controls per hand, for the controller pose. Moving around is entirely
// Player.update(dt, moveInput) below, in and out of XR. Everything below this
// block only ever touches the `renderer`/`scene`/`camera`/`rig` locals, never
// the construction details.
// three-instance.js already resolves to AFRAME.THREE once A-Frame's own
// <script> tag has run (index.html loads it before this module), so objects
// built below are native to the THREE that owns the live scene -- no foreign
// objects, no shim.

let renderer, scene, camera, rig, leftGrip, rightGrip
let sceneEl = null, rigEl = null, leftHandEl = null, rightHandEl = null

// FIXED FOVEATED RENDERING, at the maximum, and stated rather than defaulted to.
// Both stacks under this file already land here silently -- three r180's
// WebXRManager opens `let foveation = 1.0`, A-Frame 1.8's renderer schema carries
// `foveationLevel: {default: 1}` -- so writing it down changes nothing and makes
// the number findable. 1 is the driver's most aggressive setting, 0 is off.
//
// MEASURED ON A QUEST 2 and it is load-bearing: in a frame already struggling at
// 41 fps, turning foveation off took it to 30. There is no toggle for it because
// every rung below 1 is worse and none of them buys anything -- 0.5 was
// indistinguishable from 1 by eye AND by framerate, which is the number to reach
// for if the peripheral softening ever becomes the thing that annoys.
//
// IT IS NOT THE CAUSE OF THE PANEL FLICKER. That was the first theory and the
// headset refuted it: the flashing survives every level including 0. Do not
// re-run this experiment.
const FOVEATION = 1

// Everything from here to the end of the file is wrapped in an async IIFE
// (rather than using a top-level `await`) because Vite's default esbuild
// build target predates ES2022 top-level await -- and every line below this
// point depends on renderer/scene/camera/rig, which aren't resolved until the
// injected <a-scene>'s 'loaded' event fires.
;(async () => {

sceneEl = document.createElement('a-scene')
// A-Frame's own enter-VR UI is off, and the button below is the only way in.
// Its xr-mode-ui offers the session to the headset's toolbar button
// (navigator.xr.offerSession) whenever its own button is showing, and a
// session entered from the toolbar is no user activation on the page: the
// AudioContext then stays suspended until the first trigger pull. A click on
// a page button is the activation the audio needs.
sceneEl.setAttribute('xr-mode-ui', 'enabled: false')
// A-Frame 1.8's renderer defaults are a plain `new THREE.WebGLRenderer(...)`:
// toneMapping defaults to 'no' and there is no physicallyCorrectLights
// property in the schema at all. What diverges from a bare three renderer is
// the LIGHTS, which are dealt with after appendChild below.
//
// `toneMapping: no` stays stated even though it is the default, because the
// value is interpolated straight into a THREE constant name with no
// validation: 'no' -> NoToneMapping, and the plausible-looking 'none' ->
// undefined, which three reports as unsupported and silently compiles as
// Linear.
//
// `antialias: true` is NOT redundant with A-Frame's default. A-Frame's
// renderer schema defaults antialias to `auto`, which it resolves to FALSE on
// mobile GPUs -- and the Quest browser is a mobile GPU. Without it the
// headset draws every distant ridge line with no edge coverage at all, and on
// a shimmering skyline that reads as the terrain itself flickering.
//
// `logarithmicDepthBuffer` is opt-in behind `?logdepth` rather than on
// by default: it costs a per-fragment gl_FragDepth write (which defeats early
// -Z on tiled mobile GPUs, exactly the wrong trade on a Quest 2) and the
// near/far fix below should make it unnecessary. It is here so the two can be
// A/B'd in the headset without a code change, because depth precision is not
// something a desktop can reproduce.
const questRenderer = ['toneMapping: no', 'antialias: true', `foveationLevel: ${FOVEATION}`]
if (new URLSearchParams(location.search).has('logdepth')) questRenderer.push('logarithmicDepthBuffer: true')
sceneEl.setAttribute('renderer', questRenderer.join('; '))
// No movement-controls/look-controls/blink-controls: locomotion is entirely
// Player.update(dt, moveInput) + the manual mouse-drag look below. Only
// laser-controls stays, for panel-button raycasting.
//
// look-controls and wasd-controls must be disabled EXPLICITLY, because the
// <a-camera> PRIMITIVE attaches both by default (defaultComponents in
// A-Frame's primitives/a-camera.js) whether or not they are written here.
// Left on, they do not merely duplicate this file's locomotion, they fight
// it at a different level of the graph: A-Frame's `camera` component parents
// the actual THREE.PerspectiveCamera UNDER the entity's object3D, so
// look-controls' yaw/pitch land on the parent while the mouse-drag handler
// below writes the child. Two pitch/yaw pairs composed like that produce
// roll (the tilted, eventually upside-down horizon), and wasd-controls then
// pushes along the PARENT's rotation only -- the entity's `rotation`
// attribute -- so its motion diverges from the direction actually being
// looked down. Its 65 m/s^2 acceleration with velocity easing rides on top
// of Player's 1.45 m/s walk as well, which is the ice-skating glide.
//
// The explicit `position` is the same class of default: the primitive puts
// the ENTITY at y 1.6. In XR A-Frame overwrites the entity's transform with
// the headset pose (local-floor, so y is her real eye height), and the THREE
// camera child under it must then carry NO offset of its own -- see the
// sessionstart handler at the end of the file. Zero the entity here and
// set the desktop eyeHeight on the camera itself below.
// near/far ARE NOT COSMETIC HERE, and this is the fix for the distant-ridge
// Z-fighting that only shows up in the headset. The <a-camera> primitive
// defaults to near 0.005 / far 10000 -- a 2,000,000:1 ratio -- against
// 0.1 / 20000 here, a ratio of 200,000. A 24-bit
// depth buffer spends its precision logarithmically in that ratio, so at
// 0.005 near the quantisation at 2 km is on the order of tens of metres and
// at 4 km it is hundreds. Chunk skirts alone are up to 192 m deep on the
// coarsest tiers (skirtDepth = max(2, step * 3) in the chunk mesher), so the
// skirt and the neighbouring chunk's face land in the SAME depth bucket and
// whichever drew last wins. On a monitor that is a static, invisible tie; in
// XR the head never stops moving by a millimetre or two, so the tie is
// re-broken every frame and the whole skyline crawls. 0.1 buys back a factor
// of twenty of near-plane precision.
//
// far 20000 also matters on its own: stars.js puts its sphere at 15000, which
// A-Frame's default far of 10000 clips away entirely.
sceneEl.innerHTML = `
  <a-entity id="rig">
    <a-camera id="camera" look-controls="enabled: false" wasd-controls="enabled: false" position="0 0 0" near="0.1" far="20000"></a-camera>
    <a-entity id="left-hand" laser-controls="hand: left"></a-entity>
    <a-entity id="right-hand" laser-controls="hand: right"></a-entity>
  </a-entity>
`
document.body.appendChild(sceneEl)
await new Promise((resolve) => {
  if (sceneEl.hasLoaded) resolve()
  else sceneEl.addEventListener('loaded', resolve, { once: true })
})
// A-FRAME'S DEFAULT LIGHTS ARE THE WHOLE OF QUEST MODE'S LIGHTING DIVERGENCE.
// Its light system hangs two entities off any scene that has not declared a
// light of its own, on the 'loaded' event: an ambient #BBB at intensity 1 and
// a directional #FFF at 1.884 aimed down -0.5 1 1. This file builds its sun
// and hemi as bare THREE objects on scene.object3D, which that system cannot
// see, so it fired every time -- and the props and the terrain are
// MeshLambertMaterial, so a flat 0.46-linear ambient landed on all of them.
// It reads as bright, flat and fake because it is: a constant that noon
// merely dilutes and midnight has nothing to hide.
//
// BOTH CALLS, BECAUSE THE ORDER IS NOT OURS TO KNOW. The system builds the
// lights from its own 'loaded' listener, and whether that runs before this
// block depends on when A-Frame got round to initSystems -- which is NOT at
// appendChild: ANode.connectedCallback defers the whole of it to the
// `aframeready` event unless A-Frame is already up, so `sceneEl.systems` is
// still empty on the line after the append. So: the flag stops a setup that
// has not run, and removeDefaultLights clears one that has. Either way this
// is after 'loaded', by which point the system certainly exists.
//
// THE SYSTEM'S OWN DATA, and not the `light="defaultLightsEnabled: false"`
// attribute the docs suggest. `light` is a registered COMPONENT as well as a
// system, and A-Frame's entity code does not exempt the scene: the attribute
// would ALSO initialise a light component on <a-scene> itself, which warns
// about the unknown property, falls back to its own schema, and hangs a white
// directional light at intensity 1 on the scene root. That is the bug being
// fixed here, arrived at by the cure.
if (!sceneEl.systems.light) throw new Error("A-Frame's light system is missing: its default lights would light the world a second time")
sceneEl.systems.light.data.defaultLightsEnabled = false
sceneEl.systems.light.removeDefaultLights()
renderer = sceneEl.renderer
scene = sceneEl.object3D
camera = sceneEl.camera
// The mouse-drag look handler assigns rotation.x/y directly (not via
// quaternion), and three's default Euler order ('XYZ') couples yaw into roll
// as pitch grows -- without this she twists onto her side and eventually
// upside-down under a plain up/down drag, and WASD (read off the now-rolled
// local axes) comes out backwards. 'YXZ' (yaw first, then pitch) is the
// standard FPS-camera order.
camera.rotation.order = 'YXZ'
// Desktop only. In XR, A-Frame writes the headset pose to the camera ENTITY
// (renderer.xr.setPoseTarget(camera.el.object3D)), not to this child camera,
// so this offset would stack under the pose: the session handlers below zero
// it on entry and put it back on exit.
camera.position.y = LOCOMOTION.eyeHeight
rigEl = sceneEl.querySelector('#rig')
leftHandEl = sceneEl.querySelector('#left-hand')
rightHandEl = sceneEl.querySelector('#right-hand')
rig = rigEl.object3D
leftGrip = leftHandEl.object3D
rightGrip = rightHandEl.object3D
// LASER-CONTROLS' OWN RAYCASTER AND LINE ARE SWITCHED OFF THE MOMENT IT PUTS
// THEM ON. Its raycaster lists no objects, so it intersects every entity in the
// scene -- the other hand's line and controller model included -- and three
// raycasts a Line with a one-metre threshold, so with both controllers up each
// beam ended where it first passed within a metre of the other one: a length
// that wandered with the hands and never reached the menu. The menu draws its
// own pointer (updateQuestPointer) off the component's origin and direction,
// which laser-controls still fills in from the controller model, and the
// teleport aims along the same. Registered here, after the scene has loaded
// and so after laser-controls' own listeners, and before a session can start.
for (const el of [leftHandEl, rightHandEl]) {
  for (const ev of ['controllerconnected', 'controllermodelready']) {
    el.addEventListener(ev, () => el.setAttribute('raycaster', { enabled: false, showLine: false }))
  }
}

// The page's one Enter VR button, where three's VRButton would put it.
// sceneEl.enterVR() requests the session inside the click, so A-Frame keeps
// owning it (vr-mode state, pose target, enter-vr/exit-vr).
const enterVR = document.createElement('button')
enterVR.className = 'qa-enter-vr'
enterVR.textContent = 'ENTER VR'
enterVR.style.cssText = 'position:absolute;bottom:20px;left:calc(50% - 60px);width:120px;padding:12px 6px;border:1px solid #fff;border-radius:4px;background:rgba(0,0,0,0.5);color:#fff;font:normal 13px sans-serif;text-align:center;opacity:0.5;outline:none;z-index:999;cursor:pointer'
enterVR.onmouseenter = () => { enterVR.style.opacity = '1' }
enterVR.onmouseleave = () => { enterVR.style.opacity = '0.5' }
enterVR.onclick = () => {
  enterVR.textContent = 'ENTERING ...'
  sceneEl.enterVR().catch((err) => {
    console.error('[v2] enter VR', err)
    enterVR.textContent = `VR FAILED: ${err.message ?? err}`
  })
}
sceneEl.addEventListener('enter-vr', () => { enterVR.hidden = true })
sceneEl.addEventListener('exit-vr', () => { enterVR.hidden = false; enterVR.textContent = 'ENTER VR' })
document.body.appendChild(enterVR)

// A plane fixed to the camera (not the panel or the rig -- both can be
// anywhere, or not yet built) so it is guaranteed on-screen the instant an
// error fires, in or out of VR. Also catches a lost WebGL context, which
// fires no JS exception at all (a GPU/driver crash) and would otherwise
// look identical to the reported black-screen-after-VR-entry symptom.
const errCanvas = document.createElement('canvas')
errCanvas.width = 1024; errCanvas.height = 320
const errCtx = errCanvas.getContext('2d')
const errTexture = new THREE.CanvasTexture(errCanvas)
errTexture.colorSpace = THREE.SRGBColorSpace
const errMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1.1, 0.34),
  new THREE.MeshBasicMaterial({ map: errTexture, transparent: true, toneMapped: false, depthTest: false, side: THREE.DoubleSide })
)
errMesh.position.set(0, 0, -0.9)
errMesh.renderOrder = 999
errMesh.visible = false
camera.add(errMesh)

showQuestRuntimeError = (err) => {
  errCtx.fillStyle = '#2a0a0a'
  errCtx.fillRect(0, 0, errCanvas.width, errCanvas.height)
  errCtx.fillStyle = '#ff9a7a'
  errCtx.font = '22px monospace'
  errCtx.textBaseline = 'top'
  const lines = ['JavaScript error', '', ...String(err?.stack ?? err).split('\n')]
  lines.slice(0, 11).forEach((line, i) => errCtx.fillText(line.slice(0, 72), 14, 10 + i * 27))
  errTexture.needsUpdate = true
  errMesh.visible = true
}

sceneEl.canvas?.addEventListener('webglcontextlost', (e) => {
  e.preventDefault() // per spec: without this the context never becomes eligible to restore
  reportRuntimeError(new Error('WebGL context lost (GPU/driver crash, not a JS exception)'))
})

scene.background = new THREE.Color(FOG_COLOR)
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00022)

// The noon-ish rig the two lights are constructed with; applySky overwrites all
// six values from the palette every frame once the world is up.
const FIXED_RIG = {
  sunDir: new THREE.Vector3(-0.45, 0.62, 0.3).normalize(),
  sunColor: SUN_COLOR,
  sunIntensity: 2.1,
  hemiSky: 0xbfd4ee,
  hemiGround: 0x2c3140,
  hemiIntensity: 0.85,
}
const sun = new THREE.DirectionalLight(FIXED_RIG.sunColor, FIXED_RIG.sunIntensity)
sun.position.copy(FIXED_RIG.sunDir)
scene.add(sun)
const hemi = new THREE.HemisphereLight(FIXED_RIG.hemiSky, FIXED_RIG.hemiGround, FIXED_RIG.hemiIntensity)
scene.add(hemi)

const clock = new WorldClock({ seed: SEED })

// --- sky, which needs nothing from the ground -------------------------------

const lighting = new WorldLighting()
const sky = new Sky(scene)
const precip = new Precip(scene)
window.v2precip = precip
// The cloud layer's texture and the summit wreaths' card atlas (§10). Failing
// loudly rather than drawing a clear sky forever: a missing PNG is a build
// problem, not a weather.
let wreaths = null
const loader = new THREE.TextureLoader()
Promise.all([
  loader.loadAsync('world/clouds.png'),
  loader.loadAsync('world/cloud-cards.png'),
  fetch('world/summits.json').then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() }),
]).then(
  ([tex, cards, summits]) => {
    sky.setClouds(tex)
    sky.clouds = questToggles.clouds
    wreaths = new Wreaths(scene, summits, cards, { patch: (m) => lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-wreaths' }), seed: SEED })
    wreaths.visible = questToggles.wreaths
    window.v2wreaths = wreaths
  },
  (err) => { throw new Error(`world/clouds.png, world/cloud-cards.png or world/summits.json did not load: ${err?.message ?? err}`) }
)
const probe = new SkyProbe()
// AFTER those three, by reference: the water reflects the dome by calling its
// shading function, asks the (here always-empty) horizon map where the mountains
// are, adds the sky probe's aurora on top, and reads the world probe's capture
// of the bank for everything the horizon map cannot hold. See water.js.
const worldProbe = new WorldProbe()
const water = new Water(scene, { sky, lighting, probe, world: worldProbe })
// Both under the sky's clouds, by reference: the cloud that hides the sun hides the stars and the curtain behind it.
const stars = new Stars(scene, { seed: SEED, pixelRatio: renderer.getPixelRatio(), clouds: sky.uniforms })
const aurora = new SkyAurora(scene, { renderer, seed: SEED, clouds: sky.uniforms })
// The aurora only. The stars are POINTS, and gl_PointSize counts framebuffer
// pixels rather than angle -- so the 1.1-4.5 px speck that is right on a 1500 px
// screen spans 1.5 to 6.3 degrees of a 64 px cube face, against the ~0.05 degrees
// a real star has. All 2400 of them, blown up 30 to 100 times, is what the
// reflection was showing. There is no size that fixes it either: a star under one
// pixel is what stars.js exists to keep, and the probe's bilinear filter would
// smear it to nothing. See the header there.
SkyProbe.include(aurora.mesh)

// ...and the world probe's exclusion list, which is the mirror image of that
// call: it captures layer 0 wholesale, so what it must NOT see is named here
// rather than what it must. The water, or the reflection contains a 128 px
// reflection. The dome and the two additive meshes, because the water already
// has all three by other routes -- analytically for the sky, from the sky probe
// for the aurora -- and because a dome fills every face with alpha 1, which
// turns "is there land along this ray" into "yes, always". See world-probe.js.
worldProbe.exclude(water.group, sky.mesh, stars.points, aurora.mesh)

// WHERE THE WORLD PROBE CAPTURES FROM: out on the water, not on the bank beside
// her. Anchored at her own x/z, a shoreline capture is taken from among the
// trunks and boulders of the shore, and the lake then reflects the near side of
// a tree standing between the probe and the water -- a trunk drawn across the
// far mountains. So each re-anchor searches a few rings around her for VISIBLE
// water, meaning the drawn polygon covers the point AND the walk surface (the
// field, lifted onto any boulder) sits under the level by a margin, and takes
// the deepest point on the nearest ring that has one. Deepest is the cheap proxy
// for "furthest from every shore". Nothing within reach means the old rule, her
// own x/z under the duck floor, which is what a lake seen from a hilltop wants.
//
// Cost: at most 4 rings x 12 azimuths of levelAt + heightAt, and only on the
// frame a re-anchor fires -- once per 12 m walked, at most once per second.
const PROBE_VANTAGE = {
  near: 2.5,   // innermost ring, metres: "at least a couple of metres out"
  step: 2.5,
  rings: 4,    // outermost is near + (rings - 1) * step = 10 m
  azimuths: 12,
  // How far the ground must sit under the surface for the point to count. The
  // camera goes at level + WORLD_PROBE.height with a 0.3 m near plane, and the
  // drawn mesh sits a few centimetres either side of the field.
  minDepth: 0.3,
}
function probeVantage(head, out) {
  let bestDepth = 0
  for (let ring = 0; ring < PROBE_VANTAGE.rings; ring++) {
    const r = PROBE_VANTAGE.near + ring * PROBE_VANTAGE.step
    for (let i = 0; i < PROBE_VANTAGE.azimuths; i++) {
      const a = (i / PROBE_VANTAGE.azimuths) * Math.PI * 2
      const x = head.x + Math.cos(a) * r
      const z = head.z + Math.sin(a) * r
      const level = waterSurfaces.levelAt(x, z, true)
      if (level === null) continue
      const depth = level - walk.heightAt(x, z)
      if (depth < PROBE_VANTAGE.minDepth || depth <= bestDepth) continue
      bestDepth = depth
      out.set(x, level + WORLD_PROBE.height, z)
    }
    if (bestDepth > 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// The menu: a world-space panel, ported from quest-main.js's already-proven
// pattern (a raycast down the hand, canvas-texture buttons) rather than
// reinvented. It is the one control surface the headset has, and Tab
// opens it on a desktop. Four views under one tab bar -- backpack, settings,
// debug, help -- and the view she last chose is kept for the session only: a
// refresh opens on the backpack.
// ---------------------------------------------------------------------------

let questPanelGroup = null
// The pointer: one line and one dot, on ONE hand -- the hand whose button was
// pressed most recently, so the B or Y that opened the menu, then whichever
// trigger is pulled -- and only while the menu is open. Closed, the pointer
// and the controller models go away and she sees her hands instead.
let questPointerHand = null
let questPointer = null
// Her own hand under each grip: the shipped hand mesh (avatar.js), loaded before the panel is built.
const questHands = new Map()
let ownHandBank = null
const QUEST_POINTER_COLOR = 0x19d2ff
// The line's reach when it lands on nothing: the horizon.
const QUEST_POINTER_FAR = 1000
// The menu's render order, past the error plane's 999; its pointer draws over the menu in turn.
const QUEST_PANEL_ORDER = 1000
const QUEST_POINTER_ORDER = 1010
const questPointerDir = new THREE.Vector3()
const Z_AXIS = new THREE.Vector3(0, 0, 1)

const QUEST_VIEWS = ['backpack', 'settings', 'debug', 'help']
let questView = 'backpack'
// The tab bar, the two button grids (buildQuestGrid) and the view groups, shown
// one at a time by setQuestView. The meshes the lasers may land on are listed
// there too, because Raycaster ignores `visible`.
let questTabs = null
let questSettingsGrid = null
let questDebugGrid = null
let questViewGroups = null
let questHitMeshes = []
let paintBackpack = null
// The backpack view's photographs, one quad a slot; a press on one is the thing back in her hand.
let questBackpackSlots = null

// --- backpack ----------------------------------------------------------------

// Eight slots, each null or what her hand put there, packed (hands.pack): the
// record without its geometry and material, which its source dresses it in
// again on the way out. Saved and loaded with her position; see saveGame.
const BACKPACK_SLOTS = 8
const backpack = new Array(BACKPACK_SLOTS).fill(null)
// The photograph of each slot, in pixels a side, in one render target of two rows.
const BACKPACK_PHOTO_PX = 192

// --- settings ----------------------------------------------------------------

// The saved game: where she stands, which way she faces, what she carries and
// the hour of day. In this browser's localStorage and nowhere else -- nothing
// goes to a server -- and a refresh boots straight into it (see the spawn in
// bootWorld).
const SAVE_KEY = 'v2.save.2'
const hasSave = () => localStorage.getItem(SAVE_KEY) !== null
const readSave = () => { const raw = localStorage.getItem(SAVE_KEY); return raw === null ? null : JSON.parse(raw) }

function saveGame() {
  // The rig only ever turns about Y (snap turns, recenter), so its quaternion
  // is a yaw and this is exact; rig.rotation's Euler would fold past 90 deg.
  const q = rig.quaternion
  const doc = {
    // In a house, the step before its door: the house is rolled on entering and not saved.
    x: indoors ? indoors.back.x : rig.position.x, z: indoors ? indoors.back.z : rig.position.z,
    rigYaw: 2 * Math.atan2(q.y, q.w),
    camYaw: camera.rotation.y, camPitch: camera.rotation.x,
    backpack: backpack.slice(),
    held: {},
    hour: clock.hour,
    room: currentRoom.id,
    // A village is the one behind the mouth she came in by: its seed, and the door out.
    door: cameInBy,
    // Every flare hers or a peer's, in every room, as flares.js toWire has them.
    flares: flares.save(),
  }
  for (const key of HAND_KEYS) {
    const rec = hands.holding(key)
    if (rec !== null) doc.held[key] = hands.pack(rec)
  }
  localStorage.setItem(SAVE_KEY, JSON.stringify(doc))
  console.log(`[v2] saved at ${doc.x.toFixed(0)}, ${doc.z.toFixed(0)}, ${clock.clockText}`)
  refreshQuestRow('load')
  // The menu closes on the save, with the bag's closing voice: the press was seen.
  if (questPanelGroup.visible) toggleQuestPanel()
}

// Everything in a save but her position, which boot and the Load button put
// her at differently.
function applySave(doc) {
  rig.rotation.set(0, doc.rigYaw, 0)
  // In XR the headset owns the camera's rotation and overwrites it every frame.
  if (!sceneEl.is('vr-mode')) camera.rotation.set(doc.camPitch, doc.camYaw, 0)
  backpack.splice(0, BACKPACK_SLOTS, ...doc.backpack)
  // A save from before the hands were written has no `held`.
  restoreHeld(doc.held ?? {})
  // A save from before the hour was written has no `hour`.
  if (doc.hour !== undefined) restoreHour(doc.hour)
  // A save from before the flare gun has no `flares`, and no gun: she is given one.
  if (doc.flares === undefined) giveFlareGun()
  else flares.load(doc.flares)
}

/** A new flare gun into the first free backpack slot, unless she has one in the backpack or a hand already. */
function giveFlareGun() {
  if (backpack.some((s) => s !== null && s.kind === FLAREGUN)) return
  for (const key of HAND_KEYS) {
    const rec = hands.holding(key)
    if (rec !== null && rec.kind === FLAREGUN) return
  }
  const free = backpack.indexOf(null)
  if (free < 0) { console.warn('[v2] no free backpack slot for the flare gun'); return }
  backpack[free] = flareGuns.slot()
  paintBackpack()
}

// The hour of day a load or a new game asks for, until the room has been asked.
let pendingHour = null
const hourDelta = (hour) => (((hour - clock.hour) % 24) + 24) % 24

// Reached by skipping forward, so elapsed stays monotonic (see WorldClock).
// The room's clock is the relay's, resynced every frame, so the ask goes there
// (askRoomHour) once its clock is known, and the relay grants it only to a
// client alone in the room: with company, the room's hour stands. With no
// relay the skip lands here.
function restoreHour(hour) {
  pendingHour = hour
  if (netplay.time === null) { clock.tick(); clock.skip(hourDelta(hour)) }
}

// Each frame, after the clock has synced, until the relay has been asked.
function askRoomHour() {
  if (pendingHour === null || netplay.time === null) return
  if (!netplay.sendClock(netplay.time.skipHours + hourDelta(pendingHour))) return
  console.log(`[clock] asked room "${room}" for ${pendingHour.toFixed(2)} h (granted only to a room of one)`)
  pendingHour = null
}

function loadGame() {
  const doc = readSave()
  if (doc === null) { console.warn('[v2] load: nothing saved'); return }
  player.teleportTo(doc.x, doc.z)
  applySave(doc)
  // She has moved; the menu follows her rather than closing behind her.
  placeQuestPanel()
  console.log(`[v2] loaded at ${doc.x.toFixed(0)}, ${doc.z.toFixed(0)}`)
}

// The start as a first boot has it: SPAWN at CLOCK.startHour, facing the way
// the world opens, the sky clear of flares, hands empty and a fresh flare gun
// the only thing in the backpack -- what she held is let go where she stood,
// but a gun in hand is gone with the old one. The saved game is kept; Load
// still returns her to it.
function newGame() {
  restoreHour(CLOCK.startHour)
  for (const key of HAND_KEYS) {
    const rec = hands.holding(key)
    if (rec !== null && rec.kind === FLAREGUN) hands.put(key)
    else hands.drop(key, handsHead())
  }
  backpack.fill(null)
  flares.clear()
  giveFlareGun()
  paintBackpack()
  player.teleportTo(SPAWN.x, SPAWN.z)
  rig.rotation.set(0, 0, 0)
  if (!sceneEl.is('vr-mode')) camera.rotation.set(0, 0, 0)
  placeQuestPanel()
  console.log(`[v2] new game at ${SPAWN.x}, ${SPAWN.z}`)
}

// A row is `{ key, text }` and one of three shapes: a toggle on questToggles
// (with optional `on`/`off` state names), an action, or an action with a
// `value` readout. Shared by the settings and debug grids; a key is unique
// across both, since applyQuestToggle and refreshQuestRow find rows by it.
const QUEST_SETTING_ROWS = [
  { key: 'save', text: 'Save', action: () => saveGame() },
  { key: 'load', text: 'Load', action: () => loadGame(), value: () => (hasSave() ? 'saved game' : 'nothing saved') },
  { key: 'new', text: 'New game', action: () => newGame() },
  // Teleport is the headset's default (§12: comfort over capability); walk is
  // the continuous locomotion, for measuring what the world does to the frame
  // while she moves through it. Only readInput's XR branch reads this -- a
  // desktop walks on WASD and lobs the arc off the T key.
  { key: 'teleport', text: 'Move', on: 'Teleport', off: 'Walk' },
  { key: 'sound', text: 'Sound', on: 'On', off: 'Off' },
]

// --- debug ---------------------------------------------------------------------

// Column order matters: the grid fills column-major over QUEST_PANEL_COLS
// columns, so these read as world layers, then systems, then one-shot actions,
// each group filling down a column.
//
// THERE IS NO `recall panel here` ROW, deliberately. It was here and it was
// useless: the only way to press it is to already be standing in front of the
// panel, which is the one situation in which nothing needs recalling. Recall is
// a CONTROLLER binding (B / Y) for exactly that reason -- the button you can
// reach when the panel is behind you.
const QUEST_TOGGLE_ROWS = [
  { key: 'terrain', text: 'terrain & LOD' },
  // The drawn triangulation, green at 8 m cells and coarser, blue finer. Independent of the row above: the mesh keeps streaming while either is on. See terrain/wire.js.
  { key: 'terrainWire', text: 'terrain wireframe' },
  { key: 'trees', text: 'trees' },
  { key: 'boulders', text: 'boulders & rubble' },
  { key: 'grass', text: 'grass' },
  { key: 'ferns', text: 'bushes' },
  // ONE ROW FOR THREE LAYERS, because they are one thing to the wearer: the
  // small stuff lying on the forest floor. They also share a cost profile --
  // all three are ground scatters that only exist inside ~100 m -- so a
  // measurement that separated them would be three readings of the same number.
  { key: 'litter', text: 'litter, fungi & deadfall' },
  // ONE ROW OVER THE THREE BELOW, so a stutter can be blamed on the fauna as a
  // whole in one press before it is chased into a species. Off, no animal is
  // drawn, stepped or followed -- see the tick -- and the same holds for
  // whatever animal is added next, provided it goes through animalOn.
  { key: 'animals', text: 'animals' },
  { key: 'fish', text: 'fish' },
  { key: 'frogs', text: 'frogs' },
  { key: 'crabs', text: 'crabs' },
  { key: 'butterflies', text: 'butterflies' },
  { key: 'grasshoppers', text: 'grasshoppers' },
  { key: 'fireflies', text: 'fireflies' },
  { key: 'spiders', text: 'spiders' },
  { key: 'wildlife', text: 'wildlife' },
  { key: 'snowmen', text: 'snowmen' },
  { key: 'leafkin', text: 'leafkin' },
  { key: 'dragons', text: 'dragons & roosts' },
  { key: 'treeRadius', text: 'tree reach', action: () => cycleTreeRadius(), value: () => `${trees ? trees.radius : '?'} m >` },
  { key: 'treeFalloff', text: 'tree falloff', action: () => cycleTreeFalloff(), value: () => `${trees ? trees.falloff : '?'}^ >` },
  { key: 'treeMesh', text: 'tree LOD1 band', action: () => cycleTreeMesh(), value: () => `${trees ? meshBandLabel(trees.lodBands[1]) : '?'} >` },
  // The two ABLATIONS on the tree layer, both starting where the world ships so
  // that "off" is the measurement. `tree tiers` takes the mesh ladder away and
  // leaves the card ring, which is what makes the reach and falloff rows above
  // readable on their own; `tree leaf cutout` takes every `discard` out of the
  // tree program and with it the layer's transparency. See Trees.setCardsOnly
  // and setCutout for what each number does and does not prove.
  { key: 'treeTiers', text: 'tree tiers', on: 'full ladder', off: 'cards only' },
  { key: 'treeCutout', text: 'tree leaf cutout', on: 'masked', off: 'opaque' },
  // Flat-colours every creature but the butterflies by the tier it is drawing
  // -- green, yellow, orange, red, and blue for a card -- so the ladder in
  // critters.js can be confirmed by walking up to a stag and watching where it
  // changes. See THE TINT ROW in critters.js.
  { key: 'critterTint', text: 'critter LOD tint', on: 'by tier, entrances purple', off: 'normal' },
  // Her own body as a peer sees it, stood 2 m ahead and facing her: see placeMirror.
  { key: 'mirror', text: 'body double', on: 'shown', off: 'hidden' },
  { key: 'wind', text: 'wind' },
  // DEAD CODE (peaks): the `peaks` mesher knob, off in RELIEF_SHIPPED. See the
  // tag in chunk-mesh-v2.js.
  { key: 'peaks', text: 'far peaks', action: () => onRelief({ ...relief, peaks: relief.peaks > 0 ? 0 : 1 }), value: () => (relief.peaks > 0 ? 'max >' : 'sampled >') },
  { key: 'water', text: 'rivers & lakes' },
  { key: 'reflections', text: 'cubemap reflections' },
  { key: 'aurora', text: 'aurora' },
  // The sky's cloud layer (§10); off is the A/B against the frame-time readout.
  { key: 'clouds', text: 'sky clouds' },
  { key: 'wreaths', text: 'summit clouds' },
  { key: 'precip', text: 'rain and snow' },
  { key: 'auroraPattern', text: 'aurora pattern >', action: () => cycleAurora() },
  // How often the sky map is rebuilt; the dome blends the three newest. See MAP_INTERVALS in render/aurora.js.
  { key: 'auroraRate', text: 'aurora map >', action: () => cycleAuroraInterval(), value: () => `${aurora.interval}s` },
  { key: 'skip5h', text: '+5h', action: () => skipTime() },
  // Holds the weather channel (§10) at one of WEATHER.presets, this client
  // only; peers stay under the room's live sky. See cycleWeather.
  { key: 'weather', text: 'weather >', action: () => cycleWeather(), value: () => weatherLabel() },
  // The headset's ONLY way into flight -- there is no controller binding, see
  // the VR LOCOMOTION banner. Reads the player rather than questToggles
  // because the same state is flipped from the keyboard and cleared on XR
  // entry; setFlying repaints this row for those.
  { key: 'fly', text: 'fly', action: () => setFlying(!player.flying), value: () => (player.flying ? 'on' : 'off') },
]

function questRowByKey(key) {
  const row = QUEST_SETTING_ROWS.find((r) => r.key === key) ?? QUEST_TOGGLE_ROWS.find((r) => r.key === key)
  if (!row) throw new Error(`the menu has no row ${key}`)
  return row
}

function questRowLabel(row) {
  // A cycling row has to SHOW where it currently is, or the wearer is counting
  // presses to work out what they are looking at.
  if (row.value) return `${row.text}: ${row.value()}`
  if (row.action) return row.text
  const on = questToggles[row.key]
  // `on`/`off` let a row name its two STATES instead of reporting a boolean.
  // "move: walk" is a control the wearer can read; "teleport: off" makes them
  // work out what the other half of the switch even is.
  return `${row.text}: ${on ? (row.on ?? 'on') : (row.off ?? 'off')}`
}

function applyQuestToggle(key) {
  const row = questRowByKey(key)
  if (row.action) { row.action(); return }
  const enabled = (questToggles[key] = !questToggles[key])
  switch (key) {
    case 'terrain': terrain.batch.visible = enabled; break
    case 'terrainWire': terrainWire.visible = enabled; break
    case 'trees': trees.batch.visible = enabled; break
    // Both rows read "the world as it ships" as ON, so the toggle is what gets
    // REMOVED -- the same polarity as `wind`.
    case 'treeTiers': trees.setCardsOnly(!enabled); break
    case 'treeCutout': trees.setCutout(enabled); break
    case 'boulders': applyRockVisibility(); break
    case 'grass': grass.batch.visible = enabled; break
    // Three meshes, not one: the fern bed is a ring per LOD, the way the rock
    // beds are a mesh per species. See render/ferns.js on why an InstancedMesh
    // cannot hold the ladder in one object.
    // The carrots ride on this row: bushes, to the wearer, is the greenery underfoot.
    case 'ferns':
      ferns.meshes.forEach((m) => { m.visible = enabled })
      carrots.batch.visible = enabled
      break
    // Three layers on one row. Each is a prop arena -- a Group of
    // InstancedMeshes -- so `visible` on the group is the whole layer.
    case 'litter':
      litter.batch.visible = enabled
      mushrooms.batch.visible = enabled
      deadwood.batch.visible = enabled
      bones.batch.visible = enabled
      break
    // Back on, every animal layer is put down fresh at her feet: the ground
    // may have moved under it while it was frozen, and a frozen layer is
    // skipped by replacePropsOnMovedGround. Expect a hitch on the frame you
    // press it -- that is the boot placement, run again.
    case 'animals':
      if (enabled) placeAnimals(player.rig.position.x, player.rig.position.z)
      applyAnimalVisibility()
      break
    case 'fish': case 'frogs': case 'crabs': case 'butterflies': case 'grasshoppers': case 'fireflies': case 'spiders': case 'wildlife': case 'snowmen': case 'leafkin': case 'dragons': applyAnimalVisibility(); break
    case 'critterTint': setTierTint(enabled); rocks?.setHollowTint(enabled); break
    case 'mirror': if (enabled) placeMirror(); else peerAvatars.mirror(null); break
    // RECOMPILES the three prop materials rather than zeroing uWindStrength, so
    // "off" is the wind's whole per-vertex cost gone and the A/B against "on" is
    // its price in milliseconds. Strength 0 would stop the motion and leave every
    // instruction running, which measures nothing. Expect a one-off hitch on the
    // frame you press it -- that is the shader compile, not the result.
    case 'wind': setWindEnabled(enabled); break
    case 'teleport': // pure state; readInput branches on it. Drop any half-made aim.
      questTeleportArmed = false
      hideTeleport()
      break
    case 'water':
      water.group.visible = enabled
      rowboats.batch.visible = enabled
      break
    // Two halves of one thing, and they have to move together: the row gates
    // the two cube CAPTURES in tick(), and it compiles the water's fetches of
    // them in or out. Off, the lake reflects the sky function alone and nobody
    // renders a cube face for it; on, it costs the six-face sky probe, the
    // world probe's face-per-frame, and three cube fetches per water pixel.
    // Leaving the shader sampling captures that stopped updating is the state
    // this row must never be in -- that is a lake mirroring last minute's
    // world. Expect a one-off compile hitch on the frame you press it.
    case 'reflections': water.setCubeReflections(enabled); break
    case 'aurora': aurora.mesh.visible = enabled; break
    case 'clouds': sky.clouds = enabled; break
    case 'wreaths': if (wreaths) wreaths.visible = enabled; break
    case 'precip': precip.enabled = enabled; break
    // The master fader, not the rules: the ambience keeps sensing and firing so
    // it is where it should be the moment the row goes back on.
    case 'sound': if (sound) sound.setMuted(!enabled); break
  }
}

function applyRockVisibility() {
  rocks.batch.visible = questToggles.boulders
  // The village mouths are on their boulders' faces, so they go with the row.
  if (entrances) entrances.batch.visible = entrances.holes.visible = entrances.flank.visible = questToggles.boulders
}

// Repaint one row's cell from the live state, in whichever grid holds it.
// Separate from the click handler because a toggle can be flipped by something
// OTHER than its own button -- onRelief, the editor -- and a row whose label
// disagreed with the world would make the panel worse than no panel.
function refreshQuestRow(key) {
  if (!questDebugGrid) return
  const s = QUEST_SETTING_ROWS.findIndex((r) => r.key === key)
  if (s >= 0) { questSettingsGrid.repaint(s); return }
  const d = QUEST_TOGGLE_ROWS.findIndex((r) => r.key === key)
  if (d >= 0) { questDebugGrid.repaint(d); return }
  throw new Error(`the menu has no row ${key}`)
}

function activateQuestButton(key) {
  applyQuestToggle(key)
  refreshQuestRow(key)
}

// --- panel geometry ----------------------------------------------------------
//
// In metres, group-local, in one place because the plates, the tab bar, the
// stats plane and the button grids all have to agree on the width and there is
// no layout engine in a Three.js scene to make them. The group's origin sits up
// among the buttons rather than at the bottom of the plate, so bottoms are
// negative.
// 2.7 m at 2.8 m subtends about 52 degrees, as wide as the outer columns can
// go before a Quest 2's lenses soften them; the debug grid splits that width
// four ways so its rows stay up where a level look reads them.
const PANEL_W = 2.70
const QUEST_PANEL_COLS = 4
const QUEST_PANEL_COL_GAP = 0.06
const QUEST_PANEL_COL_W = (PANEL_W - (QUEST_PANEL_COLS - 1) * QUEST_PANEL_COL_GAP) / QUEST_PANEL_COLS
const QUEST_PANEL_TOP = 1.20
// The tab bar: one cell per view, the four sharing the panel's width.
const QUEST_TAB_Y = 1.08
const QUEST_TAB_H = 0.18
const QUEST_TAB_W = (PANEL_W - (QUEST_VIEWS.length - 1) * QUEST_PANEL_COL_GAP) / QUEST_VIEWS.length
// Where a view's content starts, just under the tabs.
const QUEST_VIEW_TOP = 0.96
// The debug view: the stats plane, then the toggle grid, which grows DOWNWARD
// with QUEST_TOGGLE_ROWS at QUEST_ROW_H a row. The stats canvas is 1536 wide
// for the panel's 2.7 m, 569 px/m, so the largest of QUEST_STATS_SIZES is a
// 6 cm glyph at the panel's 2.8 m -- readable in a headset, which the 16 px
// the old 288-tall canvas squeezed nine rows into was not. 640 tall holds ten
// rows at that size, every row updateQuestStats draws in the headset; on a
// desktop the cursor row wraps and the type steps down one size.
const QUEST_STATS_W = 1536
const QUEST_STATS_H = 640
const QUEST_STATS_M = PANEL_W * QUEST_STATS_H / QUEST_STATS_W
const QUEST_STATS_Y = QUEST_VIEW_TOP - QUEST_STATS_M / 2
const QUEST_ROW_H = 0.20
const QUEST_BTN_H = 0.18
const QUEST_ROW_TOP = QUEST_VIEW_TOP - QUEST_STATS_M - 0.06 - QUEST_BTN_H / 2
const questRowsPerCol = () => Math.ceil(QUEST_TOGGLE_ROWS.length / QUEST_PANEL_COLS)
// The settings view: two columns of wider buttons.
const QUEST_SETTING_COLS = 2
const QUEST_SETTING_W = 1.20
const QUEST_SETTING_GAP = 0.10
const QUEST_SETTING_ROW_H = 0.34
const QUEST_SETTING_BTN_H = 0.26
const QUEST_SETTING_TOP = 0.78
// The backpack view: the slots in two rows on one canvas plane, half a gap of
// margin inside each edge, set half their own height under the tabs with as
// much plate again below them, so the rows sit where a look down at the ground
// finds them while the tabs stay up where the debug view needs them.
const QUEST_SLOT = 0.50
const QUEST_SLOT_GAP = 0.10
const QUEST_SLOTS_H = 2 * (QUEST_SLOT + QUEST_SLOT_GAP)
const QUEST_SLOTS_TOP = QUEST_VIEW_TOP - QUEST_SLOTS_H / 2
// The help view: one canvas plane of text, QUEST_HELP_H tall, from QUEST_VIEW_TOP.
const QUEST_HELP_H = 1.40
// Where a view's plate ends: a grid's last row with 5 cm to spare.
const questGridBottom = (top, rows, rowH, btnH) => top - (rows - 1) * rowH - btnH / 2 - 0.05
const questDebugBottom = () => questGridBottom(QUEST_ROW_TOP, questRowsPerCol(), QUEST_ROW_H, QUEST_BTN_H)
const QUEST_SETTINGS_BOTTOM = questGridBottom(QUEST_SETTING_TOP, Math.ceil(QUEST_SETTING_ROWS.length / QUEST_SETTING_COLS), QUEST_SETTING_ROW_H, QUEST_SETTING_BTN_H)
const QUEST_BACKPACK_BOTTOM = QUEST_SLOTS_TOP - QUEST_SLOTS_H * 1.5
const QUEST_HELP_BOTTOM = QUEST_VIEW_TOP - QUEST_HELP_H - 0.05
// Canvas pixels per metre of panel, so every button's type is the same size
// whatever its shape: 96 px for the 18 cm button the debug rows were tuned on.
const QUEST_PX_PER_M = 96 / 0.18

// THE MENU'S TWO FACES. Everything she reads as a player -- tabs, settings,
// backpack, help -- is set in a serif, letter-spaced a little so it reads as
// set rather than typed; the debug view stays monospace because its rows are
// columns of numbers. SYSTEM FONTS ONLY, nothing fetched: the
// Quest's browser is Chromium on Android, whose one serif is Noto Serif and is
// what the generic `serif` resolves to there. Georgia is the desktop's answer
// to the same stack. Neither is a blackletter; a shipped OFL face is the way
// to that look if it is ever wanted, not a system name that no headset has.
const QUEST_SERIF = (px, weight = 'bold') => ({ px, font: `${weight} ${px}px "Noto Serif", Georgia, "Times New Roman", serif`, tracking: '1px' })
const QUEST_MONO = (px) => ({ px, font: `bold ${px}px monospace`, tracking: '0px' })
function setQuestFont(ctx, face) {
  ctx.font = face.font
  ctx.letterSpacing = face.tracking
}

// A label wider than its cell breaks at a space onto a second line; past two
// lines the rest runs on, since the type is the size it is to be read at 2.8 m.
const QUEST_CELL_PAD = 8
function paintQuestCell(ctx, x, y, w, h, text, face = QUEST_SERIF(28), bg = '#173154', fg = '#ffffff') {
  ctx.fillStyle = bg
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = fg
  setQuestFont(ctx, face)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  const limit = w - 2 * QUEST_CELL_PAD
  let lines = [text]
  if (ctx.measureText(text).width > limit) {
    const words = text.split(' ')
    let first = ''
    for (let i = 0; i < words.length - 1; i++) {
      const next = first ? `${first} ${words[i]}` : words[i]
      if (ctx.measureText(next).width > limit) break
      first = next
    }
    if (first) lines = [first, text.slice(first.length + 1)]
  }
  const lineH = face.px * 1.15
  const y0 = y + h / 2 - (lines.length - 1) * lineH / 2
  lines.forEach((line, i) => ctx.fillText(line, x + w / 2, y0 + i * lineH))
}

// UPLOAD THE CANVAS NOW, BETWEEN FRAMES, instead of leaving needsUpdate set for
// three to honour at the first draw that samples it. That deferred upload is the
// cause of the left-eye edge flicker on the Quest, and the mechanism is worth
// writing down because nothing about it is visible at the call site:
//
//   - three uploads lazily. `needsUpdate = true` queues nothing; the texImage2D
//     runs inside renderer.render(), from setTexture2D, at the first draw call
//     that binds the map. For the panel that is a draw in the LEFT eye, because
//     three walks cameraXR.cameras in view order and left is first. By the right
//     eye the texture is resident and no upload happens -- which is why the
//     artefact was in one eye and always the same eye.
//   - the Quest's Adreno is a tile-based deferred renderer. Redefining a texture
//     mid-pass makes the driver break the render pass: resolve the tiles, do the
//     upload, restore. What comes back is the resolved single-sample colour, not
//     the MSAA sample coverage that produced it (the context is antialias: true).
//   - so fully covered pixels restore exactly and interiors look perfect, while
//     PARTIALLY COVERED pixels -- the rim of every alpha-tested triangle in the
//     frame, every grass blade and every fern frond -- resolve against samples
//     that no longer exist. Whole-framebuffer, so it hits grass beside and behind
//     the panel too, not just grass silhouetted against it.
//
// initTexture forces the upload here in tick(), where A-Frame has not started
// the frame's render pass yet, so there is no pass to break. The cost is the
// same texImage2D either way; only its timing changes.
function uploadQuestTexture(texture) {
  texture.needsUpdate = true
  renderer.initTexture(texture)
}

// A canvas the panel draws on. NO MIP CHAIN: these are re-uploaded on every
// press, and the stats one on a timer, and three's upload path runs
// generateMipmap for the whole chain after every texImage2D. Mipmaps buy
// nothing here: the panel is world-locked at 2.8 m and read near head-on, where
// the canvases are minified about 1.3x, which is what LinearFilter is for.
function questCanvasTexture(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  return { canvas, ctx: canvas.getContext('2d'), texture }
}

// A canvas plane. forceSinglePass, or three draws every transparent DoubleSide
// material twice -- see buildQuestGrid.
function questCanvasMaterial(texture) {
  return new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, toneMapped: false, forceSinglePass: true })
}

/**
 * A grid of buttons as ONE mesh of loose quads over ONE canvas atlas.
 *
 * A draw-call decision rather than a tidiness one. A quad per button, each with
 * its own CanvasTexture and material, is a draw call per button -- and because
 * those materials are `transparent` AND `DoubleSide`, three splits every one of
 * them into a back pass and a front pass (WebGLRenderer, `material.transparent
 * === true && material.side === DoubleSide && material.forceSinglePass ===
 * false`), so the bill was TWO calls a button and 49 per eye for a menu with
 * nothing behind it. One geometry, one atlas, one material: 1 call. Loose quads
 * and not a PlaneGeometry grid, because the gaps between the buttons are the
 * plate showing through -- a continuous sheet would have to carry them as
 * transparent margin in every cell instead.
 *
 * Filled column-major: cell i is column floor(i / rows), row i % rows. Cells
 * are `colW` x `btnH` metres on a pitch of colW + gap across and rowH down,
 * centred on x = 0 with the first row centred at `top`. `paint(ctx, i, x, y, w,
 * h)` draws cell i into its atlas rect; `repaint(i)` redraws one cell in place
 * and re-uploads the atlas, which a click is human-rate enough to afford;
 * `indexAt(hit)` reads the cell off a raycast hit against the mesh (the quads
 * are two triangles each, in order), or -1 for a hit on anything else.
 */
function buildQuestGrid({ count, cols, colW, gap, rowH, btnH, top, paint }) {
  const rows = Math.ceil(count / cols)
  const cellW = Math.round(colW * QUEST_PX_PER_M)
  const cellH = Math.round(btnH * QUEST_PX_PER_M)
  const atlasW = cols * cellW
  const atlasH = rows * cellH
  const { ctx, texture } = questCanvasTexture(atlasW, atlasH)
  const cellAt = (i) => [Math.floor(i / rows) * cellW, (i % rows) * cellH]

  const positions = new Float32Array(count * 4 * 3)
  const uvs = new Float32Array(count * 4 * 2)
  const indices = new Uint16Array(count * 6)
  for (let i = 0; i < count; i++) {
    const col = Math.floor(i / rows)
    const row = i % rows
    const cx = (col - (cols - 1) / 2) * (colW + gap)
    const cy = top - row * rowH
    const x0 = cx - colW / 2, x1 = cx + colW / 2
    const y0 = cy - btnH / 2, y1 = cy + btnH / 2
    // The atlas cell, in UV. Canvas rows run downward and CanvasTexture flips Y,
    // so the cell's TOP edge is the larger v.
    const u0 = col * cellW / atlasW, u1 = (col + 1) * cellW / atlasW
    const v1 = 1 - row * cellH / atlasH, v0 = 1 - (row + 1) * cellH / atlasH
    positions.set([x0, y0, 0.03, x1, y0, 0.03, x1, y1, 0.03, x0, y1, 0.03], i * 12)
    uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8)
    const v = i * 4
    indices.set([v, v + 1, v + 2, v + 2, v + 3, v], i * 6)
    const [x, y] = cellAt(i)
    paint(ctx, i, x, y, cellW, cellH)
  }
  uploadQuestTexture(texture)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const mesh = new THREE.Mesh(geometry, questCanvasMaterial(texture))
  return {
    mesh,
    repaint(i) {
      const [x, y] = cellAt(i)
      paint(ctx, i, x, y, cellW, cellH)
      uploadQuestTexture(texture)
    },
    indexAt(hit) {
      if (!hit || hit.object !== mesh || hit.faceIndex === undefined || hit.faceIndex === null) return -1
      return Math.floor(hit.faceIndex / 2)
    },
  }
}

// --- the stats readout of the debug view -------------------------------------
//
// ONE canvas and ONE CanvasTexture for the life of the panel, redrawn in place
// at 4 Hz. The obvious shape -- build a fresh texture per update, the way the
// toggle rows do on click -- would allocate and upload a texture four times
// a second forever, which is a leak of GPU memory on a device that has 6 GB for
// everything. Rows get away with it because a click is a human-rate event.

// Sized in the panel geometry block: QUEST_STATS_W x QUEST_STATS_H. Rows past
// what the canvas holds do not run off it: drawQuestStats shrinks the type to
// fit and wraps what is still too wide.
let questStatsCanvas = null
let questStatsCtx = null
let questStatsTexture = null

const QUEST_STATS_PAD = 16
// The type sizes the stats are allowed to take, largest first. The panel hangs
// at a fixed size in world space, so shrinking the type is the only room there
// is: a row that has grown past the canvas is a row the wearer cannot read at
// all, and a stat nobody can see may as well not be measured.
const QUEST_STATS_SIZES = [36, 32, 28, 24, 20, 16]
const statsLineH = (px) => Math.round(px * 1.64)
const statsTop = (px) => Math.round(px * 0.93)
// Held between frames so a settled panel measures itself once and not eight times.
let questStatsPx = QUEST_STATS_SIZES[0]

// A row's cells laid left to right at `px`, wrapped at the canvas edge onto a
// hanging indent, a cell wider than a whole line broken across two. Returns
// lines of [text, colour, x] instead of drawing them, so a size can be measured
// before it is committed to. Sets ctx.font as a side effect.
function layoutQuestStats(ctx, lines, px) {
  ctx.font = `bold ${px}px monospace`
  const limit = QUEST_STATS_W - QUEST_STATS_PAD
  const indent = QUEST_STATS_PAD + ctx.measureText('  ').width
  const out = []
  for (const parts of lines) {
    let line = []
    let x = QUEST_STATS_PAD
    const wrap = () => { out.push(line); line = []; x = indent }
    for (const [text, color] of parts) {
      let rest = text
      while (rest !== '') {
        let fit = rest
        while (fit !== '' && x + ctx.measureText(fit).width > limit) fit = fit.slice(0, -1)
        if (fit === '') {
          // Not one glyph fits: wrap and try again, unless the line is already
          // empty -- then a single character is wider than the canvas and the
          // caller has handed this a size no layout can serve.
          if (line.length === 0) throw new Error(`drawQuestStats: ${px}px does not fit one glyph in ${QUEST_STATS_W}px`)
          wrap()
          continue
        }
        line.push([fit, color, x])
        x += ctx.measureText(fit).width
        rest = rest.slice(fit.length)
        if (rest !== '') wrap()
      }
    }
    out.push(line)
  }
  return out
}

// How many laid-out lines the canvas holds at `px`, the last one's descenders included.
const statsRoom = (px) => Math.floor((QUEST_STATS_H - statsTop(px) - px * 0.6) / statsLineH(px)) + 1

function drawQuestStats(lines) {
  const ctx = questStatsCtx
  ctx.fillStyle = '#08131f'
  ctx.fillRect(0, 0, QUEST_STATS_W, QUEST_STATS_H)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  let px = questStatsPx
  let rows = layoutQuestStats(ctx, lines, px)
  // Down until it fits, then one step up if that fits too -- so the panel
  // recovers its size when a row goes away, at one extra layout a frame.
  while (rows.length > statsRoom(px) && px > QUEST_STATS_SIZES[QUEST_STATS_SIZES.length - 1]) {
    px = QUEST_STATS_SIZES[QUEST_STATS_SIZES.indexOf(px) + 1]
    rows = layoutQuestStats(ctx, lines, px)
  }
  const up = QUEST_STATS_SIZES[QUEST_STATS_SIZES.indexOf(px) - 1]
  if (up !== undefined) {
    const bigger = layoutQuestStats(ctx, lines, up)
    if (bigger.length <= statsRoom(up)) { px = up; rows = bigger }
  }
  questStatsPx = px
  ctx.font = `bold ${px}px monospace`
  const lineH = statsLineH(px)
  // Even the smallest size can come up short. Rather than run off the bottom,
  // the last line the canvas holds says how many lines are not on it.
  const room = Math.max(1, statsRoom(px))
  const cut = rows.length > room
  const shown = cut ? room - 1 : rows.length
  for (let i = 0; i < shown; i++) {
    const y = statsTop(px) + i * lineH
    for (const [text, color, x] of rows[i]) {
      ctx.fillStyle = color
      ctx.fillText(text, x, y)
    }
  }
  if (cut) {
    ctx.fillStyle = '#ffd27a'
    ctx.fillText(`+${rows.length - shown} more`, QUEST_STATS_PAD, statsTop(px) + shown * lineH)
  }
  uploadQuestTexture(questStatsTexture)
}

// A view's backdrop: from the panel's top down to `bottom`, behind everything.
function buildQuestPlate(bottom) {
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W + 0.1, QUEST_PANEL_TOP - bottom),
    new THREE.MeshBasicMaterial({ color: 0x091321, transparent: true, opacity: 0.94, side: THREE.DoubleSide, forceSinglePass: true })
  )
  plate.position.set(0, (QUEST_PANEL_TOP + bottom) / 2, -0.01)
  return plate
}

// The slots are rounded squares, so they are drawn on one canvas plane rather
// than built as quads. Over each sits a quad of the thing in it, photographed
// by hands.js into one render target of two rows -- the quads are one mesh on
// that one texture, as buildQuestGrid's are on its atlas -- and a press on a
// quad is the thing back in her hand.
function buildBackpackView() {
  if (!hands) throw new Error('buildBackpackView: the hands are not built, and the slots are their photographs')
  const group = new THREE.Group()
  group.add(buildQuestPlate(QUEST_BACKPACK_BOTTOM))
  const { canvas, ctx, texture } = questCanvasTexture(Math.round(PANEL_W * QUEST_PX_PER_M), Math.round(QUEST_SLOTS_H * QUEST_PX_PER_M))
  const cols = BACKPACK_SLOTS / 2
  const rows = BACKPACK_SLOTS / cols
  const px = QUEST_PX_PER_M
  const PX = BACKPACK_PHOTO_PX
  const photos = new THREE.WebGLRenderTarget(cols * PX, rows * PX, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  })
  // Row 0 is the top row, and the target's rows run upward from its bottom.
  const rectOf = (i) => ({ x: (i % cols) * PX, y: (rows - 1 - Math.floor(i / cols)) * PX, w: PX, h: PX })
  // The packed slot each cell is a photograph of, so a repaint photographs only what changed -- and a slot whose source has not landed its asset stays unshot until the next paint.
  const shot = new Array(BACKPACK_SLOTS).fill(null)
  paintBackpack = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < BACKPACK_SLOTS; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = canvas.width / 2 + ((col - (cols - 1) / 2) * (QUEST_SLOT + QUEST_SLOT_GAP) - QUEST_SLOT / 2) * px
      const y = (QUEST_SLOT_GAP / 2 + row * (QUEST_SLOT + QUEST_SLOT_GAP)) * px
      ctx.beginPath()
      ctx.roundRect(x, y, QUEST_SLOT * px, QUEST_SLOT * px, 0.08 * px)
      ctx.fillStyle = '#173154'
      ctx.fill()
      ctx.lineWidth = 4
      ctx.strokeStyle = '#2f5f95'
      ctx.stroke()
      if (shot[i] !== backpack[i]) {
        const taken = hands.photograph(renderer, backpack[i], photos, rectOf(i))
        shot[i] = taken || backpack[i] === null ? backpack[i] : null
      }
    }
    uploadQuestTexture(texture)
  }
  paintBackpack()
  const slots = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, QUEST_SLOTS_H), questCanvasMaterial(texture))
  slots.position.set(0, QUEST_SLOTS_TOP - QUEST_SLOTS_H / 2, 0.02)
  group.add(slots)

  // The photograph quads: one loose quad a slot, inset from the frame, over the target as an atlas.
  const inset = 0.04
  const positions = new Float32Array(BACKPACK_SLOTS * 4 * 3)
  const uvs = new Float32Array(BACKPACK_SLOTS * 4 * 2)
  const indices = new Uint16Array(BACKPACK_SLOTS * 6)
  for (let i = 0; i < BACKPACK_SLOTS; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = (col - (cols - 1) / 2) * (QUEST_SLOT + QUEST_SLOT_GAP)
    const cy = QUEST_SLOTS_TOP - QUEST_SLOT_GAP / 2 - row * (QUEST_SLOT + QUEST_SLOT_GAP) - QUEST_SLOT / 2
    const half = QUEST_SLOT / 2 - inset
    const x0 = cx - half, x1 = cx + half, y0 = cy - half, y1 = cy + half
    const u0 = col / cols, u1 = (col + 1) / cols
    const v1 = 1 - row / rows, v0 = 1 - (row + 1) / rows
    positions.set([x0, y0, 0.03, x1, y0, 0.03, x1, y1, 0.03, x0, y1, 0.03], i * 12)
    uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8)
    const v = i * 4
    indices.set([v, v + 1, v + 2, v + 2, v + 3, v], i * 6)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const mesh = new THREE.Mesh(geometry, questCanvasMaterial(photos.texture))
  group.add(mesh)
  questBackpackSlots = {
    mesh,
    indexAt(hit) {
      if (!hit || hit.object !== mesh || hit.faceIndex === undefined || hit.faceIndex === null) return -1
      return Math.floor(hit.faceIndex / 2)
    },
  }
  return group
}

// A press on a slot by the hand that pressed -- the pointing controller in
// the headset, the desk's hand otherwise. An empty hand takes what is in the
// slot; a full hand puts what it holds there, with the bag's closing voice,
// and takes what the slot held, if anything, in exchange.
function pressBackpackSlot(i) {
  const was = backpack[i]
  const key = sceneEl.is('vr-mode') ? (questPointerHand === leftHandEl ? 'left' : 'right') : 'desk'
  if (was !== null && hands.dressed(was) === null) { console.warn(`[v2] backpack: the ${was.kind} has not landed its asset yet`); return }
  if (hands.holding(key)) {
    const slot = hands.put(key)
    if (slot === null) { console.warn('[v2] backpack: what the hand holds is too big for a slot'); return }
    backpack[i] = slot
    playStow()
  } else {
    if (was === null) return
    backpack[i] = null
  }
  if (was !== null) { hands.give(key, was, handsHead()); playPick() }
  paintBackpack()
}

/** The bag's closing voice, for a thing put in it: the same one-shot as the menu closing. */
function playStow() {
  if (ambience) sound.play('uiClose', { bus: 'near', rate: THREE.MathUtils.randFloat(RATE[0], RATE[1]), gain: 0.5 })
}

/** The pop of a thing coming into a hand, from the ground or a backpack slot: one voice for every kind until each has its own. */
function playPick() {
  if (ambience) sound.play('uiPop', { bus: 'near', rate: THREE.MathUtils.randFloat(RATE[0], RATE[1]), gain: 0.5 })
}

/** Whether the hand holds a flare gun. */
function holdsGun(key) {
  const rec = hands.holding(key)
  return rec !== null && rec.kind === FLAREGUN
}

const gunFrame = new THREE.Matrix4()
const gunMuzzle = new THREE.Vector3()
const gunAim = new THREE.Vector3()
const gunTarget = new THREE.Vector3()
/** The trigger on a hand holding the flare gun: a flare off down the barrel, or down `aim` (unit) where given, to the room; a dry click with no charge left. */
function fireFlare(key, aim = null) {
  const rec = hands.holding(key)
  if (rec.charges <= 0) {
    if (ambience) sound.play('uiPop', { bus: 'near', rate: 0.5, gain: 0.25 })
    return
  }
  hands.heldFrame(key, gunFrame)
  gunMuzzle.copy(MUZZLE).applyMatrix4(gunFrame)
  if (aim === null) gunAim.set(0, 0, -1).transformDirection(gunFrame)
  else gunAim.copy(aim)
  aimTarget(gunMuzzle, gunAim, (x, z) => walk.heightAt(x, z), (x, z) => waterSurfaces.levelAt(x, z, true), gunTarget)
  rec.charges--
  const f = {
    id: Math.random().toString(36).slice(2, 12), room: flares.room,
    ox: gunMuzzle.x, oy: gunMuzzle.y, oz: gunMuzzle.z, tx: gunTarget.x, ty: gunTarget.y, tz: gunTarget.z,
    color: PALETTE[rec.hue], seed: Math.random(),
  }
  flares.add(f, 0)
  shotFlash.fire(f.color)
  netplay.sendFlare(toWire(f))
  if (ambience) sound.play('flaregun', { bus: 'near', rate: FLARE_RATE * THREE.MathUtils.randFloat(RATE[0], RATE[1]), gain: 0.9 })
  questPulse(key, 0.8, 80)
}

/** A/X or Q: the next colour in the palette for the gun in the hand. */
function cycleFlareColor(key) {
  const rec = hands.holding(key)
  rec.hue = (rec.hue + 1) % PALETTE.length
  if (ambience) sound.play('uiPop', { bus: 'near', rate: 1.4, gain: 0.3 })
}

/** The flares peers shot since last frame, into the sky; one still leaving its muzzle in her room is heard, as far off as it is. */
function drainFlares() {
  player.headPosition(headTmp)
  for (const a of netplay.flares) {
    const age = a[10] / 1000
    const f = fromWire(a.slice(0, 10))
    if (!flares.add(f, age) || age > 0.5 || f.room !== flares.room || !ambience) continue
    const d = Math.hypot(f.ox - headTmp.x, f.oy - headTmp.y, f.oz - headTmp.z)
    if (d < FLARE_HEARD_M) sound.play('flaregun', { rate: FLARE_RATE * THREE.MathUtils.randFloat(RATE[0], RATE[1]), gain: 0.9 * (1 - d / FLARE_HEARD_M) ** 2, at: { x: f.ox, y: f.oy, z: f.oz }, distance: d })
  }
  netplay.flares.length = 0
}

function buildSettingsView() {
  const group = new THREE.Group()
  group.add(buildQuestPlate(QUEST_SETTINGS_BOTTOM))
  questSettingsGrid = buildQuestGrid({
    count: QUEST_SETTING_ROWS.length, cols: QUEST_SETTING_COLS,
    colW: QUEST_SETTING_W, gap: QUEST_SETTING_GAP, rowH: QUEST_SETTING_ROW_H, btnH: QUEST_SETTING_BTN_H, top: QUEST_SETTING_TOP,
    paint: (ctx, i, x, y, w, h) => paintQuestCell(ctx, x, y, w, h, questRowLabel(QUEST_SETTING_ROWS[i]), QUEST_SERIF(36)),
  })
  group.add(questSettingsGrid.mesh)
  return group
}

// Three side-by-side columns rather than one tall stack, so the view stays a
// comfortable height regardless of how many toggles it grows to. A fourth
// column would be the wrong fix for a longer list: at 2.8 m the three already
// subtend 51 degrees, and a fourth would put its outer edge where a Quest 2's
// lenses go soft.
function buildDebugView() {
  const group = new THREE.Group()
  group.add(buildQuestPlate(questDebugBottom()))

  const statsCanvas = questCanvasTexture(QUEST_STATS_W, QUEST_STATS_H)
  questStatsCanvas = statsCanvas.canvas
  questStatsCtx = statsCanvas.ctx
  questStatsTexture = statsCanvas.texture
  const stats = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, QUEST_STATS_M),
    new THREE.MeshBasicMaterial({ map: questStatsTexture, toneMapped: false, side: THREE.DoubleSide })
  )
  stats.position.set(0, QUEST_STATS_Y, 0.02)
  group.add(stats)
  drawQuestStats([[['booting...', '#7f95b4']]])

  questDebugGrid = buildQuestGrid({
    count: QUEST_TOGGLE_ROWS.length, cols: QUEST_PANEL_COLS,
    colW: QUEST_PANEL_COL_W, gap: QUEST_PANEL_COL_GAP, rowH: QUEST_ROW_H, btnH: QUEST_BTN_H, top: QUEST_ROW_TOP,
    paint: (ctx, i, x, y, w, h) => paintQuestCell(ctx, x, y, w, h, questRowLabel(QUEST_TOGGLE_ROWS[i]), QUEST_MONO(26)),
  })
  group.add(questDebugGrid.mesh)
  return group
}

// What she needs to know, as bullets on one canvas plane, wrapped to the
// panel's width. Text past the plane's foot is clipped with a console warning;
// the fix is shorter copy or a taller QUEST_HELP_H, never smaller type.
// Intentionally vague. Previously this help panel had much more detailed information, but it was nearly all spoilers or self-evident things that offend the reader's intelligence.
const QUEST_HELP = [
  'You find yourself in a strange and wild land, full of secrets to explore and dragons to meet.',
]

function buildHelpView() {
  const group = new THREE.Group()
  group.add(buildQuestPlate(QUEST_HELP_BOTTOM))
  const w = Math.round(PANEL_W * QUEST_PX_PER_M)
  const h = Math.round(QUEST_HELP_H * QUEST_PX_PER_M)
  const { ctx, texture } = questCanvasTexture(w, h)
  const px = 30
  const lineH = Math.round(px * 1.45)
  const pad = 40
  const indent = 36
  setQuestFont(ctx, QUEST_SERIF(px, 'normal'))
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#e8dcc0'
  let y = pad + px / 2
  for (const item of QUEST_HELP) {
    ctx.fillText('\u2022', pad, y)
    let line = ''
    for (const word of item.split(' ')) {
      const next = line === '' ? word : `${line} ${word}`
      if (ctx.measureText(next).width > w - pad * 2 - indent && line !== '') {
        ctx.fillText(line, pad + indent, y)
        y += lineH
        line = word
      } else {
        line = next
      }
    }
    ctx.fillText(line, pad + indent, y)
    y += Math.round(lineH * 1.4)
  }
  if (y - lineH * 0.4 + px / 2 > h) console.warn(`the help text runs ${y - h}px past its ${h}px plane; the tail is clipped`)
  uploadQuestTexture(texture)
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, QUEST_HELP_H), questCanvasMaterial(texture))
  plane.position.set(0, QUEST_VIEW_TOP - QUEST_HELP_H / 2, 0.02)
  group.add(plane)
  return group
}

// Show one view, repaint the tab bar to say which, and re-list what the lasers
// may land on. Session memory only: a refresh opens on the backpack.
function setQuestView(view) {
  if (!QUEST_VIEWS.includes(view)) throw new Error(`the menu has no view ${view}`)
  questView = view
  for (const [name, group] of Object.entries(questViewGroups)) group.visible = name === view
  for (let i = 0; i < QUEST_VIEWS.length; i++) questTabs.repaint(i)
  questHitMeshes = [questTabs.mesh]
  if (view === 'backpack') questHitMeshes.push(questBackpackSlots.mesh)
  if (view === 'settings') questHitMeshes.push(questSettingsGrid.mesh)
  if (view === 'debug') questHitMeshes.push(questDebugGrid.mesh)
  // The stats are drawn only while the debug view is up, so catch them up now
  // rather than a quarter-second later.
  updateQuestStats()
}

function buildQuestPanel() {
  questPanelGroup = new THREE.Group()
  questPanelGroup.name = 'v2-quest-panel'
  scene.add(questPanelGroup)

  // BUILT HIDDEN, AND HIDDEN IS THE RESTING STATE. A dozen meshes and the
  // widest textures in the scene, all of it for a menu that is wanted for a few
  // seconds at a time. `visible = false` is the whole saving: three's
  // projectObject returns early on an invisible object and never descends, so
  // the group's children are not culled, not sorted, and not drawn, and their
  // triangles never reach the render list at all.
  questPanelGroup.visible = false
  // A menu floating over the lake is not land, and neither are the laser dots
  // below: none of it may reach the water's reflection.
  worldProbe.exclude(questPanelGroup)

  questTabs = buildQuestGrid({
    count: QUEST_VIEWS.length, cols: QUEST_VIEWS.length,
    colW: QUEST_TAB_W, gap: QUEST_PANEL_COL_GAP, rowH: QUEST_TAB_H, btnH: QUEST_TAB_H, top: QUEST_TAB_Y,
    paint: (ctx, i, x, y, w, h) => {
      const active = QUEST_VIEWS[i] === questView
      const label = QUEST_VIEWS[i][0].toUpperCase() + QUEST_VIEWS[i].slice(1)
      paintQuestCell(ctx, x, y, w, h, label, QUEST_SERIF(30), active ? '#2f5f95' : '#0f2038', active ? '#ffffff' : '#7f95b4')
    },
  })
  questPanelGroup.add(questTabs.mesh)

  questViewGroups = { backpack: buildBackpackView(), settings: buildSettingsView(), debug: buildDebugView(), help: buildHelpView() }
  for (const group of Object.values(questViewGroups)) questPanelGroup.add(group)
  // THE MENU DRAWS OVER THE WORLD, never through it: opened in a cave or
  // against a hillside it would otherwise be cut by the terrain, and in the
  // headset a menu half inside a rock is unreadable. No depth test and a
  // render order past everything else -- so the panel's own layering, which
  // the depth buffer did along z, comes from the order instead: each mesh
  // after the one it sits in front of, by where its quads lie in the view
  // group (a grid's quads carry their z in the geometry, a plane in its
  // position). Every mesh is made transparent, since three draws the whole
  // opaque list before the transparent one whatever the order: an opaque
  // stats plane went under the plate and read through its 94%.
  questPanelGroup.traverse((o) => {
    if (!o.isMesh) return
    o.material.depthTest = false
    o.material.depthWrite = false
    o.material.transparent = true
    o.material.forceSinglePass = true
    o.geometry.computeBoundingBox()
    o.renderOrder = QUEST_PANEL_ORDER + Math.round((o.position.z + o.geometry.boundingBox.min.z) * 100)
  })
  setQuestView(questView)

  // THE POINTER IS TRANSPARENT LIKE THE MENU, or it never reaches it: three
  // draws the whole opaque list before the transparent one whatever the render
  // order, so an opaque dot went down first and the depth-test-off panel
  // painted over it. In the transparent list QUEST_POINTER_ORDER puts it last.
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3b3b, toneMapped: false, depthTest: false, depthWrite: false, transparent: true })
  )
  dot.visible = false
  dot.renderOrder = QUEST_POINTER_ORDER
  scene.add(dot)
  // A unit line up +Z under the pointing hand's grip: updateQuestPointer turns
  // it down the hand's ray, and scales it to the hit or the horizon. Drawn
  // over the world and the menu like the dot, so the beam reaches a menu that
  // stands through a wall.
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]),
    new THREE.LineBasicMaterial({ color: QUEST_POINTER_COLOR, toneMapped: false, depthTest: false, depthWrite: false, transparent: true })
  )
  line.visible = false
  line.renderOrder = QUEST_POINTER_ORDER
  worldProbe.exclude(dot, line)
  questPointer = { line, dot, hit: null }

  if (!ownHandBank) throw new Error('buildQuestPanel: the hand mesh is not loaded')
  for (const el of [leftHandEl, rightHandEl]) {
    const hand = ownHand(ownHandBank, el === leftHandEl ? 'left' : 'right')
    hand.visible = false
    el.object3D.add(hand)
    questHands.set(el, hand)
    // The hand that pulls the trigger takes the pointer, and the press lands on
    // whatever THAT hand's ray is on -- re-cast now, so a pull on the hand that
    // was not pointing does not act on the other hand's hit.
    el.addEventListener('triggerdown', () => {
      // With the menu open the trigger presses what the pointer is on; off the menu, and with it closed, the trigger is her hand: it takes, drops and stows (see hands.js), except that a flare gun held anywhere but the backpack fires.
      if (questPanelGroup.visible) {
        questPointerHand = el
        updateQuestPointer()
        const act = questActionAt(questPointer.hit)
        if (act) { act(); return }
        if (el.components.raycaster && questPanelBlocks(el.components.raycaster.raycaster)) return
      }
      if (!hands) return
      const key = el === leftHandEl ? 'left' : 'right'
      if (holdsGun(key) && !hands.wouldStow(key, handsHead())) fireFlare(key)
      else if (hands.press(key, handsHead()) === 'pick') playPick()
    })
  }

  // Flatscreen click support on a desktop, before entering XR. With the menu
  // open a click presses what is under the cursor, and one past the menu goes
  // on to the world: a click on the world reaches the desk hand down the
  // camera ray, to DESK_CLICK_M, for the first thing it can take (or drops
  // what the hand holds, or fires the flare gun it holds down the ray -- G drops that). With the mouse captured the ray is the view's
  // centre, since the cursor is not moving. A click is a press that moved
  // under DESK_CLICK_PX, so a drag-look never picks.
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let downX = 0
  let downY = 0
  renderer.domElement.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY })
  window.addEventListener('pointerup', (e) => {
    if (sceneEl.is('vr-mode')) return
    const cam = sceneEl.camera
    if (!cam) return
    if (mouseCaptured()) pointer.set(0, 0)
    else pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
    raycaster.setFromCamera(pointer, cam)
    // THE VISIBILITY CHECK IS NOT BELT AND BRACES. Raycaster does not consult
    // `visible` -- it tests layers and then calls raycast() -- so a closed menu
    // is still fully clickable unless the caller says otherwise, and a stray
    // click on empty ground would toggle whatever button happened to be behind
    // it. Same reason the hover loop below bails, and why questHitMeshes lists
    // only the open view's grid.
    if (questPanelGroup.visible) {
      const act = questActionAt(raycaster.intersectObjects(questHitMeshes)[0])
      if (act) act()
      if (act || questPanelBlocks(raycaster)) return
    }
    if (e.button !== 0 || e.target !== renderer.domElement || !ready || !hands) return
    if (editor && editor.active) return
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > DESK_CLICK_PX) return
    if (holdsGun('desk')) fireFlare('desk', raycaster.ray.direction)
    else if (hands.pressRay('desk', raycaster.ray.origin, raycaster.ray.direction, DESK_CLICK_M * herScale(), handsHead()) === 'pick') playPick()
  })
}

// Whether a ray lands anywhere on the open menu -- a button or the plate
// between them -- so a press there ends at the menu and only one past it
// reaches the world. The hidden views' plates are skipped by hand, since
// Raycaster does not consult `visible`.
function questPanelBlocks(raycaster) {
  return raycaster.intersectObjects(questPanelGroup.children.filter((c) => c.visible), true).length > 0
}

// What pressing on a raycast hit does, or null for a hit on nothing pressable.
// Each grid answers only for its own mesh, so the three cannot shadow each other.
function questActionAt(hit) {
  if (!hit) return null
  const t = questTabs.indexAt(hit)
  if (t >= 0) return () => setQuestView(QUEST_VIEWS[t])
  const b = questBackpackSlots.indexAt(hit)
  if (b >= 0) return () => pressBackpackSlot(b)
  const s = questSettingsGrid.indexAt(hit)
  if (s >= 0) return () => activateQuestButton(QUEST_SETTING_ROWS[s].key)
  const d = questDebugGrid.indexAt(hit)
  if (d >= 0) return () => activateQuestButton(QUEST_TOGGLE_ROWS[d].key)
  return null
}

// A hand entity with a controller matched to it. The entity's own object3D is
// auto-hidden without one, but not before a controller component has claimed
// it at all, and on a desktop that is never: the grips then sit at the rig's
// origin, at her feet.
function questHandConnected(el) {
  return !!el.components['tracked-controls']?.controller
}

// The hand the pointer comes off: the last one pressed, or failing a controller
// on it the other one, the right first when nothing has been pressed yet.
function questPointerEl() {
  const order = questPointerHand === leftHandEl ? [leftHandEl, rightHandEl] : [rightHandEl, leftHandEl]
  for (const el of order) if (questHandConnected(el) && el.components.raycaster) return el
  return null
}

function updateQuestPointer() {
  const open = questPanelGroup.visible
  for (const el of [leftHandEl, rightHandEl]) {
    const model = el.getObject3D('mesh')
    if (model) model.visible = open
    questHands.get(el).visible = !open && questHandConnected(el)
  }
  const p = questPointer
  const el = open ? questPointerEl() : null
  if (!el) {
    p.hit = null
    p.line.visible = false
    p.dot.visible = false
    return
  }
  // The component's ray is the controller model's pointing pose in the grip's
  // frame, which is what laser-controls put there; the component itself is
  // disabled and casts nothing.
  const rc = el.components.raycaster
  rc.updateOriginDirection()
  const hit = rc.raycaster.intersectObjects(questHitMeshes)[0] || null
  p.hit = hit
  if (p.line.parent !== el.object3D) el.object3D.add(p.line)
  p.line.visible = true
  p.line.position.copy(rc.data.origin)
  p.line.quaternion.setFromUnitVectors(Z_AXIS, questPointerDir.copy(rc.data.direction).normalize())
  // The line hangs under the rig, so a world distance is its length over her scale; the dot stands in the world at her scale.
  p.line.scale.z = (hit ? hit.distance : QUEST_POINTER_FAR) / herScale()
  p.dot.visible = !!hit
  if (hit) {
    p.dot.position.copy(hit.point)
    p.dot.scale.setScalar(herScale())
  }
}

const questPanelFwd = new THREE.Vector3()
const questPanelEye = new THREE.Vector3()
const questTempQuat = new THREE.Quaternion()
function questPanelDesiredPosition(out) {
  camera.getWorldQuaternion(questTempQuat)
  questPanelFwd.set(0, 0, -1).applyQuaternion(questTempQuat)
  questPanelFwd.y = 0
  if (questPanelFwd.lengthSq() < 1e-6) questPanelFwd.set(0, 0, -1)
  questPanelFwd.normalize()
  // At 2.2 m the 2.7 m panel subtends about 64 degrees, so the outer columns
  // sit out where a Quest 2's lenses go soft and you have to turn your head to
  // read them. In her metres: the panel is drawn at her scale and stands off her by it.
  const dist = 2.8 * herScale()
  out.x = rig.position.x + questPanelFwd.x * dist
  out.z = rig.position.z + questPanelFwd.z * dist

  // HER EYE, NOT THE GROUND. The panel draws over the terrain (buildQuestPanel
  // turns its depth test off), so the hillside under it is no concern: it sits
  // at the same height in view wherever she opens it, walking or flying. The
  // origin a hand above the eye puts the tab bar about 20 degrees up and the
  // debug grid's rows across the eye line.
  out.y = camera.getWorldPosition(questPanelEye).y + 0.1 * herScale()
  return out
}

/**
 * Put the panel in front of her, and leave it there.
 *
 * THE PANEL IS WORLD-FURNITURE, NOT A HUD. It used to re-seat itself every five
 * seconds to follow her, and that reads terrible for a reason worth writing
 * down: a surface that teleports on a timer has no physical explanation, so the
 * eye reads it as the world breaking rather than as a menu. Anything that must
 * follow the head belongs PARENTED to the camera, where it moves continuously
 * and is visibly attached; anything that does not belongs in the world, at rest.
 * This is the second kind, so it is placed on demand -- when it opens, and when
 * something moves the floor under it -- and never on a clock.
 *
 * A no-op while the menu is closed, on purpose: opening always places it fresh,
 * so re-seating something nobody can see is work with no observer.
 */
function placeQuestPanel() {
  if (!questPanelGroup || !questPanelGroup.visible) return
  questPanelDesiredPosition(questPanelGroup.position)
  questPanelGroup.scale.setScalar(herScale())
  questPanelGroup.lookAt(rig.position.x, questPanelGroup.position.y, rig.position.z)
}

// How far she may walk from the open menu before it closes behind her, at her
// full size: it is world-furniture, so she can leave it, and this is what
// stops it standing on a hillside two valleys back.
const QUEST_PANEL_LEAVE_M = 5

/**
 * B / Y, or Tab: open the menu here, or close it.
 *
 * This used to be "recall", which only ever moved the panel -- so the menu was
 * always in the world and the button just decided where. It is a MENU SCREEN
 * now: closed is the resting state, opening seats it at wherever she is
 * standing at that moment, and pressing again takes it away rather than
 * teleporting it to her feet.
 *
 * The saving is the point. A dozen meshes and the widest canvas textures in
 * the scene were being drawn every frame of a session in which the menu is
 * looked at for a few seconds -- and in VR both eyes pay. Hidden, three's
 * projectObject skips the whole subtree.
 */
function toggleQuestPanel() {
  if (!questPanelGroup) return
  const open = !questPanelGroup.visible
  questPanelGroup.visible = open
  // Placed AFTER the flag, not before: placeQuestPanel bails on a closed menu,
  // so seating it first would seat nothing.
  placeQuestPanel()
  // Each way has a voice, at half gain -- a bag beside her, not a call across
  // the valley -- on the same random pitch as every other one-shot. `ambience`
  // stands for the clips having loaded; before the context is unlocked play()
  // is a no-op.
  if (open) { if (ambience) sound.play('uiOpen', { bus: 'near', rate: THREE.MathUtils.randFloat(RATE[0], RATE[1]), gain: 0.5 }) } else playStow()
  // The stats are drawn only while the debug view is up, and a slot whose
  // source had not landed its asset when it was filled is photographed now.
  if (open) { updateQuestStats(); paintBackpack() }
  // Either way the pointer, the dot, the controller models and her hands
  // follow the menu's state this frame rather than next: a red dot hanging in
  // mid air pointing at a menu that is no longer there reads as a bug.
  updateQuestPointer()
}

function updateQuestPanel() {
  if (questPanelGroup.visible) {
    const dx = rig.position.x - questPanelGroup.position.x
    const dz = rig.position.z - questPanelGroup.position.z
    const leave = QUEST_PANEL_LEAVE_M * herScale()
    if (dx * dx + dz * dz > leave * leave) toggleQuestPanel()
  }
  updateQuestPointer()
}

// WHETHER BatchedMesh IS ONE DRAW CALL OR N OF THEM, which is a property of the
// DRIVER and not of anything in this repo, so it can only be read on device.
//
// A BatchedMesh submits through `renderMultiDraw`, which needs WEBGL_multi_draw.
// Without the extension three falls back (WebGLRenderer, `if ( ! extensions.get(
// 'WEBGL_multi_draw' ) )`) to a loop that sets the `_gl_DrawID` uniform and
// issues one drawElements PER VISIBLE INSTANCE -- so a 21,000-instance grass bed
// becomes 21,000 uniform writes and 21,000 draw calls per eye per frame, while
// `renderer.info.render.calls` still reports 1. That is exactly the signature the
// grass toggle produces: framerate collapses, triangles and calls stay flat, and
// standing still does not help.
//
// IT READS YES ON THE QUEST, so that fallback is not what is happening and the
// row is now here to keep the answer visible rather than to find it. What it
// does NOT settle is whether the driver's multi-draw is a hardware path or its
// own loop over the same 21,000 descriptors, and there is no extension to ask.
// The headset A/B answered that by elimination: the same bed as an InstancedMesh
// ran 50-60 fps at three times the triangles, so whatever the driver does with a
// multi-draw here, it is not free. See THE ARENA in render/grass.js.
//
// Memoised on first read rather than answered at module scope, because `renderer`
// is not built until boot() runs and the answer never changes after it is.
let multiDraw = null
function hasMultiDraw() {
  if (multiDraw === null) multiDraw = renderer.extensions.has('WEBGL_multi_draw')
  return multiDraw
}

// Short forms, because the panel is 2.7 m wide read from 2.8 m away and a raw
// 1043968 is a number nobody in a headset is going to parse.
function kilo(n) {
  if (n === null || n === undefined) return '-'
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(2)}M`
}

/**
 * The stats block, rebuilt from the same numbers the desktop panel shows.
 *
 * WHY EACH LINE IS HERE rather than "everything renderer.info has": the panel
 * exists to tell one failure mode from another in a headset with no console.
 *   1. fps reads `now→5s avg` with `LOW` beside it, the worst single frame of
 *      those five seconds. Three numbers and not one because "is this stable"
 *      is a question about a window: the mean says where the frame sits and the
 *      low says whether the mean is hiding a stutter inside it. `tris`/`calls`
 *      supposed to explain it. When fps collapses while both of those stay flat
 *      -- which is what the grass toggle actually does -- the cost is CPU-side,
 *      and that alone rules out "too many triangles" without a second test.
 *      MDRAW was the first suspect that test left standing -- `calls` counts a
 *      BatchedMesh as one, and without WEBGL_multi_draw it is one per instance --
 *      and it reads yes, so the row is now a standing answer rather than an open
 *      question. See hasMultiDraw above.
 *   2. geometries/textures/programs catch the other shape of the same bug: a
 *      count that climbs while nothing is being created is a per-frame
 *      allocation, and it is the reason the stats canvas above is reused.
 *   3. the terrain line separates RESIDENT chunks from DRAWN ones. The gap is
 *      the streaming margin, and `q` (queued) going non-zero and staying there
 *      is what a thrashing LOD looks like from inside.
 *   4. the per-layer lines are instances/triangles per scatter, so "which layer"
 *      is answerable without toggling each one off in turn. The forest gets its
 *      own, split by tier, because "which layer" stopped being a fine enough
 *      question once one of its four bands turned out to cost more than the
 *      other three together.
 *   5. the input line is a DIAGNOSTIC, not a stat. If locomotion is dead, the
 *      first question is whether the gamepads are even being seen, and there is
 *      no other way to ask it on-device.
 */
/**
 * One scatter layer's line item: `instances/triangles`, both counted after the
 * rim's hiding pass, so they are what the GPU was handed rather than what the
 * layer placed -- `placed` alone overstates by however much of the far rim is
 * currently hidden.
 *
 * `hidden` and not a count when the layer is not being drawn, because a count
 * there is a lie in two different ways at once. Rocks keep stepping while their
 * batches are invisible (a hidden boulder still displaces a tree), so their
 * numbers stay live and describe geometry nobody is rendering; trees, ferns and
 * grass skip update() entirely, so theirs freeze at whatever the world was when
 * the row was switched off and read as current.
 */
function scatterCells(label, shown, s) {
  return [
    [label, '#7f95b4'],
    shown
      ? [`${kilo(s.placed - s.rimHidden)}/${kilo(s.tris)}`.padEnd(11), '#8fd48f']
      : ['hidden'.padEnd(11), '#5c6b7d'],
  ]
}

function updateQuestStats() {
  if (!questStatsTexture || !ready) return
  // Nothing to read unless the debug view is up, and this is not free: it
  // measures and lays out nine rows of canvas text and then sets needsUpdate,
  // which re-uploads a 1536-wide texture. Measuring the frame is not worth
  // spending the frame on. It redraws on the frame the view opens, so the
  // numbers are current the instant they are visible.
  if (!questPanelGroup.visible || questView !== 'debug') return
  const info = renderer.info
  const st = terrain.stats
  const ts = trees.stats
  const rs = rocks.stats
  const fps = avgMs > 0 ? 1000 / avgMs : 0
  const fps5 = avgMs5 > 0 ? 1000 / avgMs5 : 0
  const low5 = worstMs5 > 0 ? 1000 / worstMs5 : 0
  const rate = (v) => (v >= 65 ? '#8fd48f' : v >= 45 ? '#ffd27a' : '#ff6b6b')
  const fpsColor = rate(fps)
  const inp = input.state
  const la = inp.left.axes
  const ra = inp.right.axes
  // Ground range under the MOUSE, and only on the flat screen: in the headset
  // there is no cursor to measure from, and cursorPick raymarches the height
  // field and then walks every scatter's instance arrays -- exactly the CPU
  // time this panel exists to hunt down. `null` here is what keeps it off the
  // row rather than a dash the wearer has to learn to ignore.
  const cursor = renderer.xr.isPresenting ? null : cursorPick()
  drawQuestStats([
    [
      ['FPS ', '#7f95b4'], [`${fps.toFixed(0)}→${fps5.toFixed(0)}`.padEnd(7), fpsColor],
      // The worst single frame in the same five seconds. A mean that holds while
      // this sits twenty below it is a stutter, not a stable frame.
      ['LOW ', '#7f95b4'], [low5.toFixed(0).padEnd(4), rate(low5)],
      ['MS ', '#7f95b4'], [avgMs.toFixed(1).padEnd(6), fpsColor],
      ['TRIS ', '#7f95b4'], [kilo(mainRender.triangles).padEnd(7), '#7fd7ff'],
      ['CALLS ', '#7f95b4'], [String(mainRender.calls).padEnd(5), '#ff9a7a'],
      // Metres to the ground under the cursor, the only ruler this view has,
      // and the world point it lands on. `-` is the ray reaching the horizon,
      // not a failure. QUEST_STATS_W is sized to this row.
      ...(cursor
        ? [
            ['CURSOR ', '#7f95b4'], [(cursor.dist === null ? '-' : `${cursor.dist.toFixed(1)}m`).padEnd(7), '#ff6b6b'],
            ['AT ', '#7f95b4'],
            [
              cursor.at === null
                ? '-'
                : `${cursor.at.x.toFixed(0)} ${cursor.at.y.toFixed(0)} ${cursor.at.z.toFixed(0)}`,
              '#ff6b6b',
            ],
          ]
        : []),
    ],
    [
      ['GEO ', '#7f95b4'], [String(info.memory.geometries).padEnd(6), '#b39ddb'],
      ['TEX ', '#7f95b4'], [String(info.memory.textures).padEnd(6), '#b39ddb'],
      ['PROG ', '#7f95b4'], [String(renderer.info.programs?.length ?? 0).padEnd(5), '#b39ddb'],
      ['MDRAW ', '#7f95b4'], [hasMultiDraw() ? 'yes' : 'NO', hasMultiDraw() ? '#8fd48f' : '#ff6b6b'],
    ],
    [
      ['terrain res ', '#7f95b4'], [String(st.slots).padEnd(6), '#cfe3ff'],
      ['drawn ', '#7f95b4'], [String(st.rendered).padEnd(6), '#cfe3ff'],
      ['tris ', '#7f95b4'], [kilo(st.drawnTris).padEnd(7), '#cfe3ff'],
      ['q ', '#7f95b4'], [String(st.queued).padEnd(4), st.queued > 0 ? '#ffd27a' : '#cfe3ff'],
      ['deg ', '#7f95b4'], [st.triDeg.toFixed(1).padEnd(5), '#cfe3ff'],
    ],
    [
      ...scatterCells('tree ', questToggles.trees, ts),
      ...(questToggles.trees
        ? [
            ['tiles ', '#7f95b4'], [`${ts.nearTiles}/${kilo(ts.tiles)}`.padEnd(11), '#cfe3ff'],
            // Main-thread ms of Trees.update, and how many tiles have been
            // re-seated on a re-split chunk since boot. Standing still, the
            // second should hold; if it climbs, the head's yaw is re-splitting
            // the terrain and every tick is a full re-upload of the card mesh's
            // matrix buffer (prop-arena.js, setMatrixAt).
            ['upd ', '#7f95b4'], [`${ts.updateMs.toFixed(1)}ms`.padEnd(7), ts.updateMs >= 1.5 ? '#ffd27a' : '#cfe3ff'],
            ['rg ', '#7f95b4'], [String(ts.regrounds).padEnd(7), '#cfe3ff'],
            // Present ONLY while an ablation is on. The row describes the shipped
            // forest unless it says otherwise, and a flag that is always there stops
            // being read -- so nothing is spent on the case that needs no warning.
            ...(ts.cardsOnly ? [['CARDS ONLY ', '#ffd27a']] : []),
            ...(ts.cutout ? [] : [['NO CUTOUT', '#ffd27a']]),
          ]
        : []),
    ],
    [
      ...scatterCells('grass ', questToggles.grass, grass.stats),
      ...scatterCells('rock ', questToggles.boulders, rs),
      // Main-thread ms of Rocks.update, and the instances its per-rock LOD
      // ladder walked this frame over the resident tile count. The draw cost
      // is what is left of the rock row's toll once this is subtracted.
      ...(questToggles.boulders
        ? [
            ['upd ', '#7f95b4'], [`${rs.updateMs.toFixed(1)}ms`.padEnd(7), rs.updateMs >= 1.5 ? '#ffd27a' : '#cfe3ff'],
            ['walk ', '#7f95b4'], [`${kilo(rs.walked)}/${kilo(rs.tiles)}`.padEnd(11), '#cfe3ff'],
          ]
        : []),
      ...scatterCells('fern ', questToggles.ferns, ferns.stats),
      ['flat ', '#7f95b4'], [(height.flatY === null ? 'off' : `${height.flatY.toFixed(0)}m`).padEnd(6), '#8fd48f'],
      ['mode ', '#7f95b4'], [player.flying ? 'fly' : questToggles.teleport ? 'teleport' : 'walk', '#8fd48f'],
    ],
    // The rock row split by ladder rung, T320 to T6: drawn rocks on that rung
    // over the triangles it costs, cross-fade ghosts included in the latter.
    [
      ['rock lod ', '#7f95b4'],
      ...(questToggles.boulders
        ? rs.lod.flatMap((l, t) => [[`${t} `, '#7f95b4'], [`${kilo(l.n)}/${kilo(l.tris)}`.padEnd(11), '#8fd48f']])
        : [['hidden'.padEnd(11), '#5c6b7d']]),
    ],
    // The same row for the wildlife, rung by rung: this is what says a stag
    // twenty metres off is on rung 1 and not rung 0 (critters.js LOD_DEG).
    // `card` is the rung under those four, where a body is a spun quad and has
    // no triangle count worth printing. `wildlife` is null and then unloaded
    // before its GLBs land, and this view runs from the first frame.
    [
      ['critter lod ', '#7f95b4'],
      ...(animalOn('wildlife') && wildlife && wildlife.loaded
        ? [
            ...wildlife.stats.lod.flatMap((l, t) => [[`${t} `, '#7f95b4'], [`${kilo(l.n)}/${kilo(l.tris)}`.padEnd(11), '#8fd48f']]),
            ['card ', '#7f95b4'], [String(wildlife.stats.cards).padEnd(4), '#8fd48f'],
          ]
        : [['hidden'.padEnd(11), '#5c6b7d']]),
    ],
    // And for the dragons, with what each of them is doing: the states are the hunt's, and `carrying` how many have a stag.
    [
      ['dragon lod ', '#7f95b4'],
      ...(animalOn('dragons') && dragons && dragons.loaded
        ? [
            ...dragons.stats.lod.flatMap((l, t) => [[`${t} `, '#7f95b4'], [`${kilo(l.n)}/${kilo(l.tris)}`.padEnd(11), '#8fd48f']]),
            ['card ', '#7f95b4'], [String(dragons.stats.cards).padEnd(3), '#8fd48f'],
            [Object.entries(dragons.stats.states).map(([s, n]) => `${s} ${n}`).join(' ').padEnd(20), '#cfe3ff'],
            ['carrying ', '#7f95b4'], [String(dragons.stats.carrying).padEnd(2), '#8fd48f'],
          ]
        : [['hidden'.padEnd(11), '#5c6b7d']]),
    ],
    // Main-thread ms in each animal layer's own step, a 5 s mean, and the nine added up.
    // The `animals` row costs whatever it costs; this says how much of that a
    // simulation could possibly account for, and the remainder is the draw.
    [
      ['animal ms ', '#7f95b4'],
      ...ANIMAL_LAYERS.flatMap((k) => [[`${k.slice(0, 4)} `, '#7f95b4'], [animalMs[k].toFixed(2).padEnd(5), animalMs[k] >= 0.5 ? '#ffd27a' : '#cfe3ff']]),
      ['sum ', '#7f95b4'], [animalMsSum().toFixed(2).padEnd(5), animalMsSum() >= 2 ? '#ff6b6b' : '#8fd48f'],
    ],
    [
      ['pads ', '#7f95b4'], [String(inp.connected).padEnd(3), inp.connected > 0 ? '#8fd48f' : '#ff6b6b'],
      ['L ', '#7f95b4'], [`${la[0].toFixed(2)},${la[1].toFixed(2)}`.padEnd(12), '#cfe3ff'],
      ['R ', '#7f95b4'], [`${ra[0].toFixed(2)},${ra[1].toFixed(2)}`.padEnd(12), '#cfe3ff'],
      [questInputSource.padEnd(7), '#7f95b4'],
      // The two numbers the submersion rule compares, which the view cannot be
      // trusted for. EYE is the head above the rig's feet: on the headset that is
      // the pose the floor calibration reports, and a standing wearer reading
      // anything but their own eye height has found the bug. WATER is signed
      // metres from the eye to the surface over it, negative under, `-` on dry
      // ground.
      ['EYE ', '#7f95b4'], [`${(eyeY - player.originPosition().y).toFixed(2)}`.padEnd(6), '#cfe3ff'],
      ['WATER ', '#7f95b4'], [(waterY === null ? '-' : (eyeY - waterY).toFixed(2)).padEnd(6), submerged ? '#7fd7ff' : '#cfe3ff'],
    ],
  ])
}

const input = new Input(renderer)
const peerAvatars = new PeerAvatars(scene, { camera, patch: (m) => lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-avatars' }) })
const room = new URLSearchParams(location.search).get('room') || 'default'
const netplay = new Netplay({
  room,
  url: import.meta.env.VITE_WS_URL || undefined,
  // A peer aboard a live boat is drawn where in the hull it says it stands, not where its late pose puts it.
  onState: (peers) => peerAvatars.apply(boats ? boats.anchorPeers(peers) : peers),
})
popLog.send = (line) => netplay.diag(line)
// A villager drawn at random on every load; the pick rides with each pose so
// everyone in the room sees the same one.
peerAvatars.ready.then((roster) => {
  netplay.avatar = roster[Math.floor(Math.random() * roster.length)].id
  console.log(`[net] wearing ${netplay.avatar}`)
})
peerAvatars.warm(renderer, camera)

const poseQuat = new THREE.Quaternion()
const posePos = new THREE.Vector3()
const netPose = new Array(21).fill(0)
function writePosePart(object, start) {
  object.getWorldPosition(posePos)
  object.getWorldQuaternion(poseQuat)
  netPose[start] = posePos.x
  netPose[start + 1] = posePos.y
  netPose[start + 2] = posePos.z
  netPose[start + 3] = poseQuat.x
  netPose[start + 4] = poseQuat.y
  netPose[start + 5] = poseQuat.z
  netPose[start + 6] = poseQuat.w
}

function currentPose() {
  writePosePart(camera, 0)
  writePosePart(leftGrip, 7)
  writePosePart(rightGrip, 14)
  return [netPose.slice(), [Boolean(input.state.left.source), Boolean(input.state.right.source)]]
}

// THE BODY DOUBLE: her own pose, played back on a peer body that stands 2 m
// ahead of where she was when she pressed the row and faces her, so she can
// walk round it and watch her own hands and head from the outside. It is
// posed in the RIG's frame, not the world's: walking, teleporting and a snap
// turn move the rig and leave a rig-local pose alone, so the double stays on
// its spot however she moves through the world, while stepping or turning in
// the room -- which moves the headset and the grips within the rig -- shows on
// it just as it would on the wire. `mirrorFrame` is the rig's world matrix at
// the press, turned half round about the vertical through her head and
// carried 2 m along her gaze; each frame the live pose is taken back into the
// rig's frame and placed through it.
const MIRROR_AHEAD_M = 2
const mirrorFrame = new THREE.Matrix4()
const mirrorM = new THREE.Matrix4()
const mirrorTmpM = new THREE.Matrix4()
const mirrorQ = new THREE.Quaternion()
const mirrorPos = new THREE.Vector3()
const mirrorFwd = new THREE.Vector3()
const mirrorPose = new Array(21).fill(0)

function placeMirror() {
  camera.getWorldPosition(mirrorPos)
  camera.getWorldQuaternion(mirrorQ)
  mirrorFwd.set(0, 0, -1).applyQuaternion(mirrorQ)
  mirrorFwd.y = 0
  // Looking straight up or down leaves no gaze to stand it along; the rig's -Z then.
  if (mirrorFwd.lengthSq() < 1e-4) mirrorFwd.set(0, 0, -1).applyQuaternion(rig.quaternion)
  mirrorFwd.normalize()
  const ahead = MIRROR_AHEAD_M * herScale()
  mirrorFrame.makeTranslation(mirrorPos.x + ahead * mirrorFwd.x, 0, mirrorPos.z + ahead * mirrorFwd.z)
    .multiply(mirrorTmpM.makeRotationY(Math.PI))
    .multiply(mirrorTmpM.makeTranslation(-mirrorPos.x, 0, -mirrorPos.z))
    .multiply(rig.matrixWorld)
}

/** `pose` (world, as sent on the wire) placed through the mirror frame; the rig's matrixWorld is current, currentPose just read through it. */
function mirroredPose(pose) {
  mirrorM.copy(rig.matrixWorld).invert().premultiply(mirrorFrame)
  mirrorQ.setFromRotationMatrix(mirrorM)
  for (let start = 0; start < 21; start += 7) {
    mirrorPos.set(pose[start], pose[start + 1], pose[start + 2]).applyMatrix4(mirrorM)
    poseQuat.set(pose[start + 3], pose[start + 4], pose[start + 5], pose[start + 6]).premultiply(mirrorQ)
    mirrorPose[start] = mirrorPos.x
    mirrorPose[start + 1] = mirrorPos.y
    mirrorPose[start + 2] = mirrorPos.z
    mirrorPose[start + 3] = poseQuat.x
    mirrorPose[start + 4] = poseQuat.y
    mirrorPose[start + 5] = poseQuat.z
    mirrorPose[start + 6] = poseQuat.w
  }
  return mirrorPose
}

// Filled in by boot(); the frame loop refuses to run until they exist.
let height = null
let layers = null
let terrain = null
let terrainWire = null
let terrainTint = null
let player = null
let walk = null
let markers = null
let waterSurfaces = null
let trees = null
let ferns = null
let grass = null
let propTextures = null
let rocks = null
let litter = null
let mushrooms = null
let deadwood = null
let bones = null
let carrots = null
let fish = null
let fishLeap = null
let frogs = null
let crabs = null
let butterflies = null
let grasshoppers = null
let fireflies = null
let spiders = null
let wildlife = null
let snowmen = null
let leafkin = null
let villagers = null
let hobs = null
let hands = null
let handsNet = null
let creatureNet = null
const HAND_KEYS = ['left', 'right', 'desk']
// The desk hand: a node under the camera, empty at DESK_HAND_REST, and with a
// thing in it moved out to the bottom-right corner of the view so the thing
// shows partly off screen, as if carried near her face by a hand out of frame.
let deskHand = null
const DESK_HAND_REST = { x: 0.15, y: -0.15, z: -0.45 }
// Metres a thing in the desk hand is drawn at, at most (placeDeskHand), at her full size: a fern is shown a third its size, like a thing carried near the face.
const DESK_HAND_MAX_M = 0.4
// A desktop click within this many px of its press picks along the camera ray this far, at her full size.
const DESK_CLICK_PX = 5
const DESK_CLICK_M = 2
// The flare gun (flaregun.js): its source, registered with every room's hands; every room's flares, drawn in the room she is in (render/flares.js), built at boot and never torn down; and the peers' shots heard within FLARE_HEARD_M, every shot's sound slowed to FLARE_RATE, then rolled like any other.
const flareGuns = new FlareGuns()
let flares = null
const FLARE_HEARD_M = 1000
const FLARE_RATE = 0.8
let roosts = null
let rowboats = null
let boats = null
let dragons = null
let entrances = null
// A village's own (DESIGN.md §30): its huts, its lamps, its gathering place and the boulder's inside; all null in the overworld.
let roomProps = null
let lamps = null
let hearth = null
let stools = null
// The stones set against its houses, and the ferns seated on their roofs (rooms/village.js DECOR); the roof ferns are grown by the fern bed, so they are a list rather than a layer.
let boulders = null
let roofPlants = []
let shell = null
// The mouth she came in by (Entrances.sites()): the village's seed, and where to put her back when she leaves. Saved with the game; null in the overworld.
let cameInBy = null
// A village's seed: the hash of its mouth's key, the boulder's place in the overworld.
const villageSeed = () => keyHash(cameInBy.key)
// The village doors (DESIGN.md §30, entrances.js PORTAL): where the step began, the mouths in reach, whether it was a teleport, and the door she stands in, so a mouth takes her once a visit.
const portalFrom = new THREE.Vector3()
const portalSites = []
let portalBlink = false
let portalIn = null
// The house she has gone into (design/30-leafkin.md, Interiors), or null: its entry (RoomProps.entries), the step before its door she comes back out to, the rolled room, its view, its residents, the door inside, and the village walk its own stands in for while she is in.
let indoors = null
// Through a house's door: her feet within `side` of the door's middle line (the door's half-width, less a little) and `walk` of its face, heading `into` it, or a teleport landing within `blink`, and outside, her feet within `rise` of the landing (not on the awning over it); the same at the door inside. Outside, her capsule stops up to 0.4 m short of the face across the door's width (the panel is not flat), and inside the wall's stone keeps her 0.3 m off it, so `walk` is the furthest she stops plus a little.
const HOUSE_DOOR = { walk: 0.5, side: 0.4, blink: 0.5, into: 0.6, rise: 0.6 }
let doorBusy = false
let editor = null
let panel = null
// The ambient sound (audio/): both stay null when the clips fail to load, and
// the frame loop runs silent rather than half-voiced. See bootWorld.
let sound = null
let ambience = null
let ready = false

// The menu's toggle state. The world boots as it ships -- every layer the
// wearer would see is on -- and the rows exist to take one away for a
// measurement.
const questToggles = {
  terrain: true,
  trees: true, boulders: true, grass: true, ferns: true, litter: true, animals: true, fish: true, frogs: true, crabs: true, butterflies: true, grasshoppers: true, fireflies: true, spiders: true, wildlife: true, snowmen: true, leafkin: true, dragons: true,
  water: true, reflections: true, aurora: true, clouds: true, precip: true, sound: true,
  // Off until the summit wreaths are redone; the menu row still turns them on.
  wreaths: false,
  critterTint: false, mirror: false, terrainWire: false,
  wind: true, treeTiers: true, treeCutout: true,
  // See QUEST_SETTING_ROWS.
  teleport: true,
}

/** Whether an animal layer runs this frame: its own row and the `animals` row both on. */
const animalOn = (key) => questToggles.animals && questToggles[key]

// Main-thread milliseconds each animal layer's step spent per frame, the mean
// over the last ANIMAL_MS_WINDOW_S seconds, keyed by its toggle row. This is
// the instrument that says whether the `animals` row's toll is CPU or draw: the
// row switches every animal layer at once, and if the numbers here sum to a
// fraction of the frame time the toggle moves, the rest of it is on the GPU and
// no amount of bucketing the simulation will find it. A window, not a running
// blend: performance.now() is coarsened to 100 us on this page, so a single
// frame reads 0 or 0.1, and a step that bursts once a second (a tile row of
// seats, a puppet pool refill) is only visible as its share of a long mean.
const ANIMAL_MS_WINDOW_S = 5
const ANIMAL_LAYERS = ['fish', 'frogs', 'crabs', 'butterflies', 'grasshoppers', 'fireflies', 'spiders', 'wildlife', 'snowmen', 'leafkin', 'dragons']
const animalMs = Object.fromEntries(ANIMAL_LAYERS.map((k) => [k, 0]))
const animalMsAcc = Object.fromEntries(ANIMAL_LAYERS.map((k) => [k, 0]))
let animalMsFrames = 0
let animalMsSince = 0
const animalMsSum = () => ANIMAL_LAYERS.reduce((sum, k) => sum + animalMs[k], 0)
/** Run `fn` if its layer's rows are on, and bank what it cost. A frozen layer banks nothing, so its next reading is zero. */
function stepAnimal(key, fn) {
  if (!animalOn(key)) return
  const t0 = performance.now()
  fn()
  animalMsAcc[key] += performance.now() - t0
}
/** Once a frame after every layer has stepped: close the window when it is full and publish each layer's mean. */
function bankAnimalMs(dt) {
  animalMsFrames++
  animalMsSince += dt
  if (animalMsSince < ANIMAL_MS_WINDOW_S) return
  for (const k of ANIMAL_LAYERS) {
    animalMs[k] = animalMsAcc[k] / animalMsFrames
    animalMsAcc[k] = 0
  }
  animalMsFrames = 0
  animalMsSince = 0
}

/**
 * The frogs', crabs', butterflies', grasshoppers', fireflies' and spiders' batches, off their rows. Not the fish's:
 * theirs is decided every frame in the tick, because it also asks whether her
 * head is under the water.
 */
function applyAnimalVisibility() {
  frogs.batch.visible = animalOn('frogs')
  crabs.batch.visible = animalOn('crabs')
  butterflies.batch.visible = animalOn('butterflies')
  grasshoppers.batch.visible = animalOn('grasshoppers')
  fireflies.batch.visible = animalOn('fireflies')
  spiders.batch.visible = animalOn('spiders')
  wildlife.batch.visible = animalOn('wildlife')
  snowmen.batch.visible = animalOn('snowmen')
  if (leafkin) leafkin.batch.visible = animalOn('leafkin')
  if (villagers) villagers.batch.visible = animalOn('leafkin')
  if (hobs) hobs.batch.visible = animalOn('leafkin')
  // The roosts go with their dragons: a nest is where a dragon lives, not litter. Neither in a village.
  if (dragons) dragons.batch.visible = animalOn('dragons')
  if (roosts) roosts.batch.visible = animalOn('dragons')
}

/** Every animal layer put down around (cx, cz), skipping any the panel has frozen. */
function placeAnimals(cx, cz) {
  if (fish && animalOn('fish')) fish.place(cx, cz)
  if (frogs && animalOn('frogs')) frogs.place(cx, cz)
  if (crabs && animalOn('crabs')) crabs.place(cx, cz, clock.seconds)
  if (butterflies && animalOn('butterflies')) butterflies.place(cx, cz, clock.seconds)
  if (grasshoppers && animalOn('grasshoppers')) grasshoppers.place(cx, cz)
  if (fireflies && animalOn('fireflies')) fireflies.place(cx, cz)
  if (spiders && animalOn('spiders')) spiders.place(cx, cz)
  if (wildlife && animalOn('wildlife')) wildlife.place(cx, cz)
  if (snowmen && animalOn('snowmen')) snowmen.place(cx, cz, clock.seconds)
  // After the wildlife: a dragon's kill is a wildlife slot, and place() hands it back.
  if (dragons && animalOn('dragons')) dragons.place()
}

// ---------------------------------------------------------------------------
// THE RELIEF KNOBS. See height/relief.js for what each one is; this is only
// where the live value lives and how it reaches the world.
//
// A MODULE-LEVEL let AND NOT PART OF THE DOCUMENT, deliberately. layers.json is
// the world a human authored and is committed to the repo; relief is an
// ablation setting for looking at that world two ways. Putting it in the
// document would mean every experiment with a knob showed up as a diff to be
// explained, and worse, would ship whichever setting happened to be on when the
// file was last saved.
//
// localStorage AND NOT A URL PARAMETER, which was the other option. A reload
// with the knobs still where you left them is the whole point of a session
// spent A/B-ing them, and a query string does not survive the editor's own
// reload-on-save.
// The suffix moves with RELIEF_SHIPPED: a browser holding a relief saved under
// the previous shipped configuration boots on the new one instead of the old.
const RELIEF_KEY = 'v2.relief.4'
let relief = RELIEF_SHIPPED

/**
 * Read the stored relief, falling back to RELIEF_SHIPPED.
 *
 * The catch is around normalizeRelief as much as around JSON.parse: a knob
 * renamed or removed since the value was written makes it THROW rather than
 * silently drop the key, which is right for a postMessage and wrong here --
 * being unable to boot because of a stale HUD setting is not a failure mode
 * worth having. Anything unreadable is reported once and replaced with the
 * shipped configuration.
 */
function loadRelief() {
  for (const stale of ['v2.relief', 'v2.relief.2', 'v2.relief.3']) localStorage.removeItem(stale)
  const raw = localStorage.getItem(RELIEF_KEY)
  if (!raw) return RELIEF_SHIPPED
  try {
    return normalizeRelief(JSON.parse(raw))
  } catch (err) {
    console.warn(`[v2] discarding stored relief: ${err.message}`)
    localStorage.removeItem(RELIEF_KEY)
    return RELIEF_SHIPPED
  }
}

// Which grass system is standing, and the M key cycles all three so they can be
// judged against the same hillside in the same light. 'tufts' is one
// camera-facing billboard per plant at every distance; 'strips' is the flat
// multi-metre card drawing the same cutout several times across itself, winning
// on triangles and losing on FILL; 'blades' is opaque geometry that pays no fill
// for transparency at all. See THE THREE STRATEGIES in render/grass.js.
//
// FILL IS THE BUDGET A QUEST RUNS OUT OF, so the world stands the blade bed and
// the cards are there to be cycled to for comparison.
const GRASS_STYLES = ['tufts', 'strips', 'blades']
let grassStyle = 'blades'
// Whether the prop atlas' PNGs have landed. The tuft's far tier is a photograph
// of the tuft, so a Grass built after they land has to bake immediately rather
// than waiting for a promise that has already resolved.
let propLayersReady = false

/**
 * Stand up a grass system in the given style, tearing down whatever was there.
 *
 * Rebuilding rather than reconfiguring, because nearly everything about the two
 * is different: the geometry bank, the material's compiled program, the density,
 * the height range and whether there is an LOD ladder at all. The tiled scatter
 * is a pure function of position (see render/grass.js), so the new bed is fully
 * grown by the time this returns and there is no frame where the ground is bare.
 */
function buildGrass(style, cx, cz, opts = {}) {
  if (grass) {
    scene.remove(grass.batch)
    grass.dispose()
    grass = null
  }
  grassStyle = style
  grass = new Grass(scene, height, waterSurfaces, layers.paths, propTextures, {
    seed: SEED, style, tint: terrainTint, rocks, ground: terrain, layers, bounds: roomBounds, ...opts,
  })
  // The cache key carries the style: the two materials compile DIFFERENT
  // programs (one billboards, one tiles), and a shared key would hand the second
  // one the first one's.
  lighting.patch(grass.material, { mode: 'vertex', cacheKey: `v2-grass-${style}` })
  grass.syncSnowLine(layers)
  grass.place(cx, cz)
  // A rebuilt bed is a new mesh and arrives visible. Without this, changing
  // the density while the grass row is OFF turns the grass back on.
  grass.batch.visible = questToggles.grass
  if (propLayersReady) once(`grass-${style}`, () => grass.bakeCards(renderer))
  const gs = grass.stats
  const gr = gs.rejected
  console.log(
    `[v2] grass (${gs.style}) ${gs.placed} of ${gs.samples} placed over ${gs.tiles} tiles in ` +
    `${gs.placeMs.toFixed(0)} ms (${gs.density}/m^2 to ${gs.fullRadius} m, thinning ^${gs.falloff} to ` +
    `${gs.radius.toFixed(0)} m, pool ${gs.used}/${gs.pool}; dropped: ${gr.elev} elev, ${gr.slope} slope, ` +
    `${gr.water} water, ${gr.snow} snow, ${gr.sand} sand, ${gr.path} path)`
  )
}

// --- boot -------------------------------------------------------------------

// Where the overworld starts. A fixed point rather than a search, so every boot
// and every headset opens on the same view. Chosen by hand; the boot throws if
// the water ever rises over it, since nothing else here checks the ground.
const SPAWN = { x: -320, z: 1367 }

// The rooms she can be in (DESIGN.md §30): the overworld, a set of world files
// under `dir`, and the village inside a hollow boulder, built in memory at boot
// (rooms/village.js) from the boulder's own inside. `scale` is her size
// against the room (HER_SCALE in a glade), and every metre that is hers --
// her pace, her reach, her lob, her menu -- follows it.
const ROOMS = {
  overworld: { id: 'overworld', dir: 'world', height: HEIGHTMAP_URL, meta: HEIGHTMAP_META_URL, spawn: SPAWN, hollows: true, leafkin: true, village: false, scale: 1 },
  leafkin: { id: 'leafkin', hollows: false, leafkin: false, village: true, scale: HER_SCALE },
}
let currentRoom = ROOMS.overworld
/** Her size against the room she is in. Set only under the swap's black, on the rig by the room's Player. */
const herScale = () => currentRoom.scale
// A village pond's water: how far she sees into it looking straight down and the angle below the horizontal the seeing-in begins at (water.js WATER.clarity, clarityAngle), set on the room's boot. A pond 20 m across is looked into from its shore at 20 or 30 degrees, where a lake's mirror would show her nothing of its fish.
const VILLAGE_POND = { clarity: 0.7, clarityAngle: 15 }
// What buildVillage answered for the room she is in: its layers document, its spawn, its exit mouth, its clearing and its huts; null in the overworld.
let roomSpec = null
let roomHeightmap = null
// THE DISC THIS ROOM IS INSIDE, or null for the open world. A village's
// heightmap is one 128 m tile repeated across the whole 8 km map
// (rooms/village.js buildHeightmap), so a scatter left to its own draw radius
// fills hundreds of copies of the hollow with a wood she can never reach and
// never see -- 27k trees over 11k tiles for a bowl 60 m across. Every tiled bed
// takes it and grows no tile outside it (render/tile-pool.js). Module state
// rather than a local, because buildGrass rebuilds the bed from the console.
let roomBounds = null
// Counts the builds, so a bake or the sound landing after the room it was for has gone does nothing.
let roomBuild = 0
// Resolves true once the clips are in, false if one failed -- and then the frame loop stays silent for good; see the sound step.
let soundReady = null
// How far out from a mouth she arrives, and the way she faces: along the mouth's normal, off the face.
const ARRIVE_M = 2
// Black over the whole view while a room is swapped: a sphere on the camera, so it holds in XR where the DOM overlay is not drawn, faded in over FADE_MS before the swap and out over FADE_MS after, its opacity stepped by the tick (fadeStep).
const FADE_MS = 500
let blackout = null
let fadeGoal = 0
let fadeDone = null
function fadeStep(ms) {
  if (blackout === null) return
  const m = blackout.material
  m.opacity = Math.max(0, Math.min(1, m.opacity + (Math.sign(fadeGoal - m.opacity) * ms) / FADE_MS))
  blackout.visible = m.opacity > 0
  if (m.opacity === fadeGoal && fadeDone !== null) { fadeDone(); fadeDone = null }
}
/** Resolves once the view has faded to `goal` (1 black, 0 clear); a hidden tab, which ticks no frame, snaps there after two fades' time so the swap cannot stall. */
function fade(goal) {
  fadeGoal = goal
  return new Promise((resolve) => {
    fadeDone = resolve
    setTimeout(() => { if (fadeDone === resolve) { blackout.material.opacity = goal; fadeStep(0) } }, 2 * FADE_MS)
  })
}

async function bootWorld() {
  // The atlas is built once, ahead of every room: createTerrainMaterial decides
  // at compile time whether to declare a sampler at all, so it has to have the
  // array in hand before the material exists. It is built empty and its image
  // layers land asynchronously (loadImageLayers, below); the bank and the
  // batches do not wait on them, so the world has trees and stone from the
  // first frame wearing whatever the procedural layers already hold.
  propTextures = buildTextureArray()
  // The flare gun's mesh, worn before the first room: a saved gun in a hand or the backpack is dressed as the room builds.
  const flareGunMesh = loadCritterGlb(FLAREGUN_GLB, { origin: [0, 0, 0] })

  // The ambient sound's clips (audio/) load in the background so a slow fetch
  // never holds the world; until they land, and forever if one fails, the
  // frame loop sees `ambience` null and stays silent -- a world with half its
  // sounds is worse than one with none. The context itself stays suspended
  // until the first gesture; see unlockSound.
  sound = new SoundEngine()
  soundReady = sound.load(SOUNDS).then(
    () => { console.log(`[v2] sound: ${Object.keys(SOUNDS).length} clips loaded`); return true },
    (err) => { console.error('[v2] sound disabled:', err); return false },
  )

  // A saved game is where she boots, and it decides where every layer is first
  // placed -- so it is read HERE and not applied after the fact, or the forest
  // would be planted around the room's spawn and she would be standing outside it.
  flares = new Flares(scene)
  let saved = readSave()
  let room = ROOMS[saved?.room ?? 'overworld']
  if (!room) throw new Error(`v2: the save is in a room this build has no file for: ${saved.room}`)
  if (room.village) {
    // A village save from before the door was written names no village to build.
    if (saved.door?.key === undefined) { console.warn('[v2] the save is in a village with no door: booting the overworld'); room = ROOMS.overworld; saved = null }
    else cameInBy = saved.door
  }
  flareGuns.wear(await flareGunMesh)
  const { fresh } = await buildRoom(room, saved)
  if (fresh) saved = null

  // The weather, which until now nothing in v2 ever turned on: the props have
  // carried a snow shader and a moss shader since they were written, and both
  // have been sitting at zero. Setting them here is what makes a rock on a
  // summit white and the same rock in a damp wood green -- and it also puts snow
  // on the TREES above the line for the first time, because it is one uniform
  // for the whole world by design (see material.js).
  //
  // Both are CEILINGS. What a given prop wears is this scaled by where it stands
  // against its line, which is what rocks.syncBands set from the terrain's own
  // snow band. How unevenly each is spread from one rock to the next is NOT set
  // here: both ranges are stone-only knobs and Rocks.syncBands owns them.
  setSnow(1)
  setMoss(0.85)

  // ONE loadImageLayers for every bake, whatever room she is in. Separate calls
  // would be separate decodes of the same PNGs into the same atlas.
  loadImageLayers(propTextures).then(() => {
    propLayersReady = true
    bakeImpostors()
  })

  if (EDITOR_MODE) editor = new Editor({
    scene,
    camera,
    renderer,
    layers,
    height,
    markers,
    terrain,
    onDirty,
    onGroundChanged: (rect) => waterSurfaces.rebuild(rect),
    onView,
    orbitLock,
    // The heightmap's DECODED extremes, not meta.minY/maxY: the encoding's range
    // is what the bake could have expressed, and the sliders should offer what
    // the image actually contains. See heightmap.js's `min`/`max`.
    elevation: { min: roomHeightmap.min, max: roomHeightmap.max },
  })
  // The hide set lives in the editor and every renderer that draws from the
  // document has to read it. Wired AFTER the editor exists rather than in each
  // constructor, because `markers.setVisibility` re-syncs immediately and the
  // predicate it is handed is the editor's.
  const isVisible = editor ? (kind, id, index) => editor.isVisible(kind, id, index) : () => true
  markers.setVisibility(isVisible)
  waterSurfaces.setVisibility(isVisible)

  if (EDITOR_MODE) panel = new Panel({ layers, editor, relief, hotkeys: HOTKEYS, onTool, onAction, onRelief })

  // The 8 m chunk floor is NOT set here. It is config.js's MAX_DEPTH: one
  // world, one cap, desktop and headset alike.
  ownHandBank = await loadOwnHand({ patch: (m) => lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-own-hand' }) })
  buildQuestPanel()
  window.v2menu = { toggle: toggleQuestPanel, view: setQuestView } // console: `v2menu.view('help')`
  // The rest of the save, now that there is a backpack view to paint. Her
  // position was the spawn above.
  if (saved) { applySave(saved); console.log(`[v2] resumed at ${saved.x.toFixed(0)}, ${saved.z.toFixed(0)} in ${currentRoom.id}`) }
  else giveFlareGun()
  logSceneCensus()

  ready = true
  await bootDone()
}

// WHAT THE SHARED ATLAS ALREADY HOLDS. The four scatter bakes and the rock bake
// photograph into `propTextures`, which is built once at boot and OUTLIVES a
// room swap -- and every one of them is a pure function of its bank and a pinned
// seed, so the second room's photographs would be byte-for-byte the first's.
// They are the most expensive thing in the boot (a readRenderTargetPixels stall
// per view), so walking into a glade from the overworld paid for all of them
// twice. Keyed by what the picture is OF: the grass bed's style decides whether
// its layer holds tufts or nothing at all, so it carries the style.
const atlasBaked = new Set()
/** `bake()` the first time this atlas picture is asked for, and its answer; null on every later room. */
function once(key, bake) {
  if (atlasBaked.has(key)) return null
  const out = bake()
  atlasBaked.add(key)
  return out
}

/** The far cards, once the atlas' images are in: every bake that reads the images, for the room standing now. */
function bakeImpostors() {
  // The images can land mid-swap, with no room standing; the next room bakes at its own end.
  if (!trees) return
  const baked = once('trees', () => trees.bakeCards(renderer))
  once('ferns', () => ferns.bakeCards(renderer))
  once(`grass-${grassStyle}`, () => grass.bakeCards(renderer))
  once('mushrooms', () => mushrooms.bakeCards(renderer))
  // The rock cards: one photograph per SHAPE in the bank, the boulder and the
  // cap. Unlike the four above this is not a method on the scatter, because
  // there is nothing per-bed about it -- a bed picks a shape and the shape's
  // picture serves every bed that picked it, so it lives on the bank. See
  // ROCK_CARD_SEED in props/rock-bank.js for the seeds and why they are pinned.
  const rockCards = once('rocks', () => bakeRockImpostor(renderer, propTextures))
  // NOT on that list: the hearth builds a card MESH of its own each time, so its
  // bake is per-hearth and not per-atlas.
  if (hearth) {
    const h = hearth.bakeCard(renderer)
    console.log(`hearth impostor baked: luma ${h.meanLuma.toFixed(3)} cover ${h.coverage.toFixed(3)} ${h.width.toFixed(2)} x ${h.height.toFixed(2)} m`)
  }
  // The one measurement that says whether the impostor bake rig is aimed
  // right, and there is nowhere else it can be taken: the bake needs a live
  // renderer, so no node gate can reach it. See BAKE_KEY in props/impostor.js
  // for what these numbers are supposed to be.
  if (baked) {
    console.log(
      'tree impostors baked:',
      baked.map((b) => `${b.species} luma ${b.meanLuma.toFixed(3)} cover ${b.coverage.toFixed(3)}`).join(', ')
    )
  }
  // Same instrument, same reason. A rock card is a grey blob, which makes
  // coverage the number that matters more than luma here: it says how much of
  // the quad is stone rather than hole, and a card whose coverage collapses is
  // a distant boulder that has become a rectangle of sky.
  //
  // THE KIND IS PRINTED because the two rows are not the same measurement. The
  // boulder is shot side-on and the cap from straight above (see THE CARD in
  // rock-bank.js), and a plate seen down its own axis fills far more of its
  // slice than anything seen broadside -- which is the whole reason it is shot
  // that way, and would read as an anomaly next to an unlabelled boulder.
  if (rockCards) {
    console.log(
      'rock impostors baked:',
      rockCards
        .map((b) => `${b.name} (${b.card}) luma ${b.meanLuma.toFixed(3)} `
          + `cover ${b.coverage.toFixed(3)} layer ${b.layer}`)
        .join(', ')
    )
  }
}

/**
 * Every layer of the room she is leaving, torn down: disposed and off the
 * scene, the terrain's workers ended, the loops silenced. The banks the layers
 * share stay loaded (the atlas, the GLBs, the sound clips); three re-uploads a
 * disposed geometry the next time it is drawn. What her hands hold is the
 * caller's to carry over -- see bootRoom.
 */
function disposeRoom() {
  const gone = (layer) => {
    if (!layer) return
    layer.dispose()
    for (const node of [layer.batch, layer.group, layer.mesh, layer.hulls, layer.lids, layer.holes]) node?.removeFromParent()
    if (Array.isArray(layer.meshes)) for (const m of layer.meshes) m.removeFromParent()
  }
  if (ambience) { ambience.dispose(); ambience = null; window.v2ambience = null }
  closeHouse()
  for (const layer of [
    leafkin, villagers, hobs, entrances, dragons, roosts, creatureNet, handsNet, hands, snowmen, wildlife, spiders, fireflies, grasshoppers, butterflies, crabs, frogs, fishLeap, fish,
    boats, rowboats, carrots, bones, mushrooms, litter, grass, ferns, trees, deadwood, rocks, roomProps, lamps, hearth, stools, boulders, shell, markers, waterSurfaces, terrainWire, terrain,
  ]) gone(layer)
  lighting.clearLamps()
  leafkin = villagers = hobs = entrances =dragons = roosts = creatureNet = handsNet = hands = snowmen = wildlife = spiders = fireflies = grasshoppers = butterflies = crabs = frogs = fishLeap = fish = null
  boats = rowboats = carrots = bones = mushrooms = litter = grass = ferns = trees = deadwood = rocks = roomProps = lamps = hearth = stools = boulders = shell = markers = waterSurfaces = terrainWire = terrain = null
  roofPlants = []
  terrainTint = player = walk = height = layers = roomSpec = roomHeightmap = null
  camera.remove(deskHand)
  deskHand = null
  portalIn = null
}

/**
 * The world she is leaving for another (DESIGN.md §30): the view faded to
 * black, every layer down, the room's files up and its stack built against
 * them, her feet ARRIVE_M out from `site` facing along its normal -- a
 * village's own exit when `site` is null, since only its own build knows where
 * that is -- and the view faded back in on the new room. The
 * clock, the backpack, the net and what her hands hold come with her; a
 * creature in a hand does not, since its layer is gone -- it goes in the
 * backpack if there is room.
 */
async function bootRoom(room, site) {
  if (EDITOR_MODE) throw new Error('v2: no room swap in the editor')
  makeBlackout()
  ready = false
  // The wait she meets at a mouth, split three ways, because only the middle of
  // it is the room build the boot table breaks down: the fade she watches, the
  // teardown of the room she is leaving, and the build of the one she enters.
  const t0 = performance.now()
  await fade(1)
  const held = {}
  for (const key of HAND_KEYS) {
    const rec = hands.holding(key)
    if (rec !== null) held[key] = hands.pack(rec)
  }
  const t1 = performance.now()
  disposeRoom()
  const at = site === null ? null : { x: site.x + site.nx * ARRIVE_M, z: site.z + site.nz * ARRIVE_M }
  const t2 = performance.now()
  const { spawn } = await buildRoom(room, at)
  const t3 = performance.now()
  const face = site ?? roomSpec.exit
  faceAlong(face.nx, face.nz)
  restoreHeld(held)
  logSceneCensus()
  ready = true
  console.log(
    `[v2] room: ${room.id} at ${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}` +
      ` -- fade ${bootFmtMs(t1 - t0)}, teardown ${bootFmtMs(t2 - t1)}, build ${bootFmtMs(t3 - t2)}`
  )
  await fade(0)
}

function makeBlackout() {
  if (blackout) return
  blackout = new THREE.Mesh(
    new THREE.SphereGeometry(1, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }),
  )
  blackout.renderOrder = 1e6
  blackout.frustumCulled = false
  blackout.visible = false
  camera.add(blackout)
}

/**
 * Into house `e` (RoomProps.entries) under the fade: its room rolled off the
 * village's seed and the house, set down past the village's disc on its own
 * floor above whatever ground is there, and her walk swapped for its own.
 * The village goes on around it unseen.
 */
async function enterHouse(e) {
  doorBusy = true
  if (ambience) sound.play('door', { bus: 'near', gain: 0.3 })
  makeBlackout()
  ready = false
  await fade(1)
  const room = rollInterior({ seed: villageSeed(), index: e.k, height: e.height })
  const ox = roomBounds.x + roomBounds.r + 40 + e.k * 10, oz = roomBounds.z
  let top = -Infinity
  for (let x = -room.R - 1; x <= room.R + 1; x += 0.5) for (let z = -room.R - 1; z <= room.R + 1; z += 0.5) top = Math.max(top, height.heightAt(ox + x, oz + z))
  const oy = top + 0.5
  const view = new InteriorView(room, await loadInteriorTextures(), ox, oy, oz, mushrooms)
  scene.add(view.group)
  const inner = new WalkSurface(flatField(oy), new InteriorStone(room, ox, oy, oz), { trunkAt: () => null }, { scale: currentRoom.scale })
  const home = villagers.graph.doorNodes[e.k]
  const who = villagers.all.filter((c) => c.home === home && c.state === 'inside').map((c) => ({ id: c.id, size: c.size, pace: c.pace }))
  const residents = new Residents(scene, room, { asset: villagers.asset, sitY: villagers.sitY, who, seed: villageSeed(), ox, oy, oz })
  const rDoor = rAt(room.rs, Math.PI)
  indoors = { e, back: e.back, room, view, residents, door: { x: ox - rDoor, z: oz, nx: -1, nz: 0 }, outside: walk }
  if (sound) sound.setIndoors(true)
  walk = window.v2walk = inner
  player.setGround(inner)
  player.teleportTo(ox + room.doorIn.x, oz + room.doorIn.z)
  faceAlong(1, 0)
  console.log(`[v2] house ${e.k}: ${room.items.length} things, ${room.windows.length} windows, ${room.loft ? 'a loft' : 'no loft'}, ${residents.all.length} at home`)
  ready = true
  await fade(0)
  doorBusy = false
}

/** Back out of the house she is in, onto its landing before the door (not the awning over it), facing away from it. */
async function leaveHouse() {
  doorBusy = true
  if (ambience) sound.play('door', { bus: 'near', gain: 0.3 })
  ready = false
  await fade(1)
  const { e, back } = indoors
  closeHouse()
  player.teleportTo(back.x, back.z, back.y)
  faceAlong(e.nx, e.nz)
  ready = true
  await fade(0)
  doorBusy = false
}

/** The house's view and residents down and the village walk hers again; nothing when she is outdoors. */
function closeHouse() {
  if (!indoors) return
  indoors.view.dispose()
  indoors.residents.dispose()
  if (sound) sound.setIndoors(false)
  walk = window.v2walk = indoors.outside
  if (player) player.setGround(walk)
  indoors = null
}

/** After the step, in a village: the house door her feet just went through, in or out. True when one did. */
function houseTest(blink) {
  if (doorBusy || EDITOR_MODE || !currentRoom.village || !roomProps || !villagers?.loaded) return false
  const feet = player.originPosition()
  const sx = feet.x - portalFrom.x, sz = feet.z - portalFrom.z
  const step = Math.hypot(sx, sz)
  const through = (x, z, nx, nz, inward) => {
    const out = (feet.x - x) * nx + (feet.z - z) * nz, side = Math.abs((feet.x - x) * nz - (feet.z - z) * nx)
    if (blink) return Math.hypot(out, side) <= HOUSE_DOOR.blink
    return side <= HOUSE_DOOR.side && Math.abs(out) <= HOUSE_DOOR.walk && step > 0 && (inward * -(sx * nx + sz * nz)) / step >= HOUSE_DOOR.into
  }
  if (indoors) {
    const d = indoors.door
    if (!through(d.x, d.z, d.nx, d.nz, -1)) return false
    leaveHouse().catch(reportRuntimeError)
    return true
  }
  for (const e of roomProps.entries()) {
    if (Math.abs(feet.y - e.y) > HOUSE_DOOR.rise || !through(e.x, e.z, e.nx, e.nz, 1)) continue
    enterHouse(e).catch(reportRuntimeError)
    return true
  }
  return false
}

// A house by its index from the console: `v2house(3)` in, `v2house(null)` out.
window.v2house = (k) => (k === null ? leaveHouse() : enterHouse(roomProps.entries()[k]))

// The swap without the walk: `v2enter()` into the glade by the mouth she last
// came in by (or a named door key), `v2enter(null)` back out. What the console
// needs to time a room swap, which is the wait she actually complains about --
// a cold page load is the app coming up, and the overworld pays more of it.
window.v2enter = (key = cameInBy?.key ?? 'hollow:160.0:-356.0') => {
  if (key === null) {
    const by = cameInBy
    cameInBy = null
    return bootRoom(ROOMS.overworld, by)
  }
  const [, x, z] = key.split(':').map(Number)
  cameInBy = { key, x, y: 0, z, nx: 1, nz: 0, r: 8 }
  return bootRoom(ROOMS.leafkin, null)
}

/** The rig turned so her gaze runs along (fx, fz), wherever her head is turned within it. */
function faceAlong(fx, fz) {
  const q = rig.quaternion
  const rigYaw = 2 * Math.atan2(q.y, q.w)
  // headYaw is atan2(fwd.x, fwd.z), which is the rig's Y rotation plus the head's own plus pi.
  const headLocal = player.headYaw() - Math.PI - rigYaw
  rig.rotation.set(0, Math.atan2(-fx, -fz) - headLocal, 0)
}

/**
 * The room's stack, built against its files or, for a village, against the
 * valley built in memory: heightmap, layers, terrain, the water, then every
 * scatter and creature layer around `at` (or the room's own spawn when `at`
 * is null or under water), her walk surface, her hands, the mouths and, in
 * the overworld, the leafkin. Returns `{ spawn, fresh }`, `fresh` when `at`
 * was refused.
 */
async function buildRoom(room, at) {
  const build = ++roomBuild
  currentRoom = room
  flares.setRoom(roomKey(room.id, room.village ? cameInBy : null))
  bootSteps.length = 0
  // ONE SEED FOR EVERY ROOM: the terrain worker seeds its own V2Height from the
  // shared constant (terrain/worker.js), so a room seeded otherwise would draw
  // one ground and collide with another.
  const seed = SEED
  // EVERY GEN-PROP BANK AT ONCE, awaited where it is used. Each is a GLB fetch
  // and a texture decode that runs off the main thread, so taken in turn down
  // the build they queue behind one another with the CPU idle: the mouth's,
  // last in line, waited the better part of a second for a decode that could
  // have run while the village was being rolled.
  const banks = {
    deadwood: loadDeadwoodBank(),
    bones: loadBonesBank(),
    carrots: loadCarrotsBank(),
    rowboats: loadRowboatsBank(),
    mouth: loadMouthBank(),
    house: room.village ? loadHouseBank() : null,
    lamp: room.village ? loadLampBank() : null,
  }
  let heightmap
  // The rock bank a village's shell is cut from; the rocks share it below.
  let bank = null
  if (room.village) {
    bootSay('building the village ...')
    await bootStep('village')
    bank = buildRockBank()
    const house = (await banks.house).bounds
    const spec = rollVillage(villageSeed(), house)
    shell = new Shell(scene, bank, propTextures, spec.shell)
    lighting.patch(shell.material, { mode: 'vertex', cacheKey: 'v2-shell' })
    roomSpec = buildVillage({ spec, shell, house })
    heightmap = roomSpec.heightmap
  } else {
    bootSay(`loading <b>${room.height}</b> ...`)
    await bootStep('heightmap')
    heightmap = await Heightmap.load({ url: room.height, metaUrl: room.meta })
    roomSpec = null
  }
  roomHeightmap = heightmap
  const bounds = roomSpec ? roomSpec.ground.bounds : null
  roomBounds = bounds
  if (bounds) console.log(`[v2] ${room.id} is a ${bounds.r.toFixed(0)} m disc; the scatters keep inside it`)

  // BEFORE the scratch V2Height, because the relief changes what `bands` says
  // and the snow defaults are derived from bands. Booting with the knobs off and
  // applying them afterwards would put the snow line where the unrelieved world
  // wanted it and then move the ground out from under it.
  await bootStep('height field')
  relief = loadRelief()

  // The scratch document. See the header: `bands` needs a V2Height and the snow
  // defaults need `bands`, so something has to be constructed first.
  height = new V2Height({ heightmap, layers: new Layers(), seed, relief })
  const bands = height.bands

  await bootStep('layers')
  const snow = snowDefaults(bands)
  let doc, from
  if (room.village) {
    // A village's document is what buildVillage drew: never the editor's.
    doc = roomSpec.doc
    from = 'the village build'
  } else {
    bootSay(`loading <b>${room.dir}/layers.json</b> ...`)
    ;({ doc, from } = await persist.loadInitial(snow))
  }
  layers = Layers.deserialize(doc)
  height.setLayers(layers)
  console.log(
    `[v2] ${room.id} ${heightmap.width}x${heightmap.height} texels, ${heightmap.texelSize.toFixed(2)} m/texel, ` +
      `relief ${bands.min.toFixed(1)}..${bands.max.toFixed(1)} m, snow line ${layers.snow.base.toFixed(0)} m +/- ${layers.snow.band.toFixed(0)} m, ` +
      `document from ${from}`
  )

  bootSay('building the world ...')
  await bootStep('terrain')
  terrain = new TerrainV2(scene, {
    heightmapRaw: heightmap.toRaw(), doc: layers.serialize(), relief, workers: 2, atlas: propTextures, axis: true,
  })
  terrainWire = new TerrainWire(scene, terrain)
  window.v2terrainWire = terrainWire // console: `v2terrainWire.visible = true`

  lighting.patch(terrain.material, {
    mode: 'fragment',
    // The variant compiles different source and three keys its program cache on
    // this string alone, so the key names which one is in hand.
    cacheKey: 'v2-terrain-shadow-axis',
    // terrain-material.js has carried this varying since v1's surface grain was
    // written and v2 shares the material, so reusing it saves declaring a second
    // varying holding the same value.
    worldPosVarying: 'vWorldPos',
  })

  // What colour the ground is DRAWN, on the CPU, for anything that has to match
  // it -- the blade bed's whole look. Built here because it holds the terrain's
  // own uniform objects by reference, so it cannot exist before the material
  // does and must not be rebuilt when the bed is. See terrain/terrain-tint.js.
  terrainTint = new TerrainTint(terrain.material, layers, height.bands)

  // The stipple rung goes on here and not at construction, because TerrainV2
  // compiles terrain-material.js's full chain either way -- the depth material
  // and the tint above both need its uniforms -- so without this the mesh would
  // draw with a surface nobody ships. See plainTerrainRung.
  applyTerrainShader()

  // The authored surfaces. Water before the spawn search, which asks it what is
  // wet before the player is placed. A road draws nothing of its own: the
  // smooth flattens the terrain to the spline and the litter cobbles it.
  await bootStep('water')
  waterSurfaces = new WaterSurfaces({ water, layers, field: height })
  markers = new Markers({ scene, layers })
  waterSurfaces.rebuild()
  markers.sync()

  await bootStep('spawn')
  // A save taken flying over a lake would put her under it on every refresh,
  // so that one case falls back to the room's spawn rather than trapping her.
  let fresh = at === null
  if (!fresh && waterSurfaces.isSubmerged(at.x, at.z, height.heightAt(at.x, at.z))) {
    console.warn(`[v2] ${at.x.toFixed(0)}, ${at.z.toFixed(0)} is underwater; spawning fresh`)
    fresh = true
  }
  const home = room.village ? roomSpec.spawn : room.spawn
  const start = fresh ? home : at
  const spawn = { x: start.x, z: start.z, y: height.heightAt(start.x, start.z) }
  if (waterSurfaces.isSubmerged(spawn.x, spawn.z, spawn.y)) throw new Error(`v2: ${room.id}'s spawn (${spawn.x}, ${spawn.z}) is underwater`)
  console.log(`[v2] spawn ${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)} at ${spawn.y.toFixed(1)} m`)

  // Stone, in six size beds at once: boulders through the wood and across the
  // cliffsides, scree at the foot of a face, giants on the crags and the
  // summits, blocks let into the faces and the lake floors, stones along the
  // shore. Four draw calls for all of them -- one InstancedMesh per LOD tier
  // shared by every bed -- and ONE material, so unlike the trees, the ferns and
  // the grass there is no per-bed shader source. See render/rocks.js.
  //
  // Which shapes stand where is decided by the ground, not by a roll: each site
  // is classified river / forest / cliff / peak off the field sample the
  // placement test already pays for, and both WHICH variants may stand there and
  // HOW MANY of them follow from that.
  //
  // FIRST OF THE SCATTERS, AHEAD OF THE TREES, THE FERNS AND THE GRASS, and that
  // is a hard ordering rather than reading order. A boulder is the only prop that
  // displaces other props: a tree or a fern whose trunk lands inside one is
  // raised to stand ON it, and grass and litter inside one are dropped outright
  // (`rocks.blockAt`). Every one of those tests needs the stone already on the
  // ground. The menu's rock rows do not weaken it -- the toggle only sets
  // `batch.visible` and the beds are placed and stepped either way, so what the
  // trees see does not change when the rocks are switched off.
  await bootStep('rocks')
  rocks = new Rocks(scene, height, waterSurfaces, layers, propTextures, { seed, ground: terrain, hollows: room.hollows, bank, bounds })
  lighting.patch(rocks.material, { mode: 'vertex', cacheKey: 'v2-rock' })
  rocks.syncBands(layers)
  rocks.place(spawn.x, spawn.z)
  const rs = rocks.stats
  console.log(
    `[v2] rocks ${rs.placed} placed in ${rs.placeMs.toFixed(0)} ms, bank ` +
    `${rs.bankTris} tris / ${rs.bankKB} KB in ${rs.buildMs.toFixed(0)} ms; ` +
    rs.beds.map((b) => `${b.name} ${b.placed} (${b.used}/${b.pool}) to ${b.radius.toFixed(0)} m`).join(', ')
  )
  // Same console hook the ferns, mushrooms and dead wood keep, and here it earns
  // itself twice over: `describeNear` is the only way to see what a rock that
  // misbehaves in the browser is actually doing, since a blink does not survive
  // into a headless traverse. See render/rocks.js.
  window.v2rocks = rocks
  // The shell wears the tint a boulder placed in a wood would (render/shell.js).
  if (shell) shell.setTint(rocks.tintAt(0, 0, 'forest'))

  // Fallen logs and rotten stumps. BEFORE THE TREES, on purpose: a piece is
  // metres long and claims its ground first, and the forest keeps off it
  // (Trees `deadwood`, Deadwood.occupiesAt) rather than the reverse. Both
  // are pure functions of position, so nothing here depends on the order the
  // frame loop steps them in. Full density in forest cover and a quarter of it
  // in the open, off the same biome field the trees read.
  await bootStep('deadwood')
  // A village is wood to its walls, thickest along its roads (village.js WOOD), meadow in the clearing.
  const biome = room.village ? villageBiome(seed, roomSpec.clearing, layers.paths) : new BiomeField({ seed })
  // The village's garden plots, wanted here before the trees: nothing grows on a planted plot but its rows (render/carrots.js).
  let plots = room.village ? roomSpec.gardens.map((g) => ({ x: g.x, z: g.z, r: g.r, spots: gardenSpots(g) })) : []
  deadwood = new Deadwood(scene, height, waterSurfaces, layers, { seed, bank: await banks.deadwood, biome, bounds })
  // ONE KEY FOR EVERY GENERATED PROP, here and at the bones and roosts: their
  // materials differ by map alone (render/gen-props.js keys the program on its
  // card flags), so one program serves every mesh variant and each call is a
  // material switch, not a program switch.
  for (const m of deadwood.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-gen-prop' })
  deadwood.place(spawn.x, spawn.z)
  // The far cards are photographed off the loaded picks; until this runs distant dead wood is not drawn.
  deadwood.bakeCards(renderer)
  const ds = deadwood.stats
  const dr = Object.entries(ds.rejected).map(([why, n]) => `${n} ${why}`).join(', ')
  console.log(
    `[v2] deadwood ${ds.logs} logs + ${ds.snags} stumps over ${ds.tiles} tiles in ` +
    `${ds.placeMs.toFixed(0)} ms (pool ${ds.used}/${ds.pool}, bank ${ds.bankKB} KB, cards ${ds.cardBakeMs.toFixed(0)} ms) (dropped: ${dr})`
  )
  window.v2deadwood = deadwood

  // The village's huts (render/room-props.js), where its build puts them, and
  // stone to her. Before the trees, which keep off the clearing and the huts
  // the way they keep off the dead wood.
  if (room.village) {
    await bootStep('huts')
    roomProps = new RoomProps(scene, height, { bank: await banks.house, props: roomSpec.props, clearing: roomSpec.clearing })
    for (const m of roomProps.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-gen-prop' })
    // The carrots the houses' roots stand over, dropped now that the houses are built: only they know where the pick's mesh reaches.
    const sown = plots.reduce((n, p) => n + p.spots.length, 0)
    plots = weedGardens(plots, roomProps)
    console.log(`[v2] huts ${roomProps.stats.placed}, gardens ${plots.length} plots, ${plots.reduce((n, p) => n + p.spots.length, 0)}/${sown} carrots clear of the roots`)
    window.v2village = roomSpec // console: `v2village.lake`, `v2village.props`
    // The lamps where the build put them (render/lamps.js), their light and the huts' windows' baked into every lit material until the room goes.
    lamps = new Lamps(scene, height, { bank: await banks.lamp, lamps: roomSpec.lamps, windows: roomProps.windows(), seed, patch: (m) => lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-lamps' }) })
    if (lamps.map) lighting.setLamps(lamps.map.tex, lamps.map.frame)
    console.log(`[v2] lamps ${lamps.lamps.length}`)
    window.v2lamps = lamps // console: `v2lamps.lamps`, `v2lamps.postMaterial`
    // The gathering place at the clearing's centre (render/hearth.js): the fire, its ring and the stools round it, its card baked with the rock cards.
    hearth = new Hearth(scene, height, { bank, at: roomSpec.clearing, textures: propTextures, seed: villageSeed(), patch: (m, cacheKey) => lighting.patch(m, { mode: 'vertex', cacheKey }) })
    console.log(`[v2] hearth ${hearth.stats.stools} stools, ${hearth.tris.join('/')} tris`)
    window.v2hearth = hearth // console: `v2hearth.stats`, `v2hearth.tier`
    // The scattered stools where the build put them (render/stools.js): by the outlying doors and on the shore, the villagers' other seats.
    stools = new Stools(scene, height, { sites: roomSpec.stools, textures: propTextures, seed: villageSeed(), patch: (m, cacheKey) => lighting.patch(m, { mode: 'vertex', cacheKey }) })
    console.log(`[v2] stools ${stools.stats.stools}`)
    window.v2stools = stools // console: `v2stools.stools`
    // The stones set against the houses (render/boulders.js), and the ferns on
    // the roofs, whose seats only the built huts know (room-props.js roofSpots).
    boulders = new Boulders(scene, height, rocks, { boulders: roomSpec.decor.boulders, seed: villageSeed() })
    roofPlants = roofFerns(roomProps, roomSpec.decor.roofs)
    console.log(`[v2] decor ${roomSpec.decor.trees.length} trees, ${roomSpec.decor.ferns.length + roofPlants.length} ferns (${roofPlants.length} on roofs), ${boulders.stats.placed} boulders`)
    window.v2boulders = boulders // console: `v2boulders.stones`
    window.v2roofferns = roofPlants // console: where the roofs seated their ferns
  }
  window.v2huts = roomProps

  // Trees. The atlas was built up ahead of the terrain, because the terrain
  // needs it at material-compile time. The card BAKE does wait on the image
  // layers landing, because a photograph taken before the bark has loaded would
  // be a photograph of nothing -- see Trees.bakeCards.
  // `ground: terrain` is what stops distant trees floating: a tree's Y comes off
  // the chunk mesh that is actually drawn under it, not off the exact field the
  // chunk's triangles are chording across. See Trees._groundFor.
  await bootStep('trees')
  trees = new Trees(scene, height, waterSurfaces, propTextures, {
    seed,
    density: room.village ? TREE_DENSITY * WOOD.density : TREE_DENSITY,
    ground: terrain,
    // Constructed above, and it has to be: a trunk that lands inside a boulder
    // stands on the boulder. See Rocks.blockTopAt.
    rocks,
    // Where the wood is dense, sparse or open meadow. Off the world seed, like
    // the scatter itself, so the clearings are the same on every boot.
    biome,
    // Placed above; a trunk that would stand through a piece of it is refused,
    // and in a village one in the clearing, through a hut, on a lamp, in the gathering place, on a stool or over a garden.
    deadwood: roomProps ? { occupiesAt: (x, z, pad) => deadwood.occupiesAt(x, z, pad) || roomProps.occupiesAt(x, z, pad) || lamps.occupiesAt(x, z, pad) || hearth.occupiesAt(x, z, pad) || stools.occupiesAt(x, z, pad) || plotsOccupy(plots, x, z, pad) } : deadwood,
    // No trunk on a road, and the wood crowds the verge.
    paths: layers.paths,
    bounds,
    // The village's own trees (rooms/village.js): the crowns standing where a
    // house does, so the trunk comes up through its roof, the ones set against
    // a wall (DECOR), and the thicket that carries the wood up the bowl's side
    // to the stone (RIM_WOOD), on ground too steep for the bed above. Planted,
    // so none of the tests above can refuse them.
    plants: room.village ? [...roomSpec.decor.trees, ...roomSpec.wood] : [],
  })
  // Per-vertex, like v1's props: a leaf card is smaller than a fragment-rate
  // shadow lookup is worth. Skipping this is a visible failure -- the trees
  // would be the one surface the night lift never reaches.
  // The cacheKey MUST differ from the ferns' below. three keys its program cache
  // on it, and these two materials compile DIFFERENT shader source -- the tree
  // material's uBillboardLayers is four long, the ferns' is one -- so sharing a
  // key would hand one of them the other's program.
  lighting.patch(trees.material, { mode: 'vertex', cacheKey: 'v2-tree-bb' })
  // So a tree and the ground it stands on cross the snow line together.
  trees.syncSnowLine(layers)
  trees.place(spawn.x, spawn.z)
  const ts = trees.stats
  console.log(
    `[v2] trees ${ts.placed} placed over ${ts.tiles} tiles in ${ts.placeMs.toFixed(0)} ms ` +
    `(${ts.density}/m^2 to ${ts.fullRadius} m, thinning ^${ts.falloff} to ${ts.radius.toFixed(0)} m, ` +
    `pool ${ts.used}/${ts.pool}), ${ts.bankKB} KB bank`
  )

  // She stands on the rocks and walks around the trunks, so she is placed only
  // once both are on the ground. See v2/walk.js.
  walk = new WalkSurface(height, rocks, trees, { scale: room.scale })
  // Dead wood is stone to her and the creatures: a step, a wall or nothing, by height, the way a rock is.
  walk.addStone(deadwood)
  if (roomProps) walk.addStone(roomProps)
  if (boulders) walk.addStone(boulders)
  // And the shell: its wall stops her and its roof stops her flight, but for the door (render/shell.js).
  if (shell) walk.addStone(shell)
  if (lamps) walk.addStone(lamps)
  // And the fire ring and every stool: a step up onto each.
  if (hearth) walk.addStone(hearth)
  if (stools) walk.addStone(stools)
  // And so are the other players, and her double: their bodies stand on it, feet planted.
  peerAvatars.ground(walk)
  window.v2walk = walk // console: `v2walk.heightAt(x, z)`, `v2walk.obstacleAt(x, z, {})`
  // Only now: probeVantage reads the walk surface and the water polygons.
  worldProbe.setVantage(probeVantage)
  window.v2probe = worldProbe // console: `v2probe.anchor`, `v2probe.origin`
  player = new Player(rig, camera, walk, { scale: room.scale })
  netplay.scale = room.scale
  window.v2player = player // console: `v2player.pathClear(x0, z0, x1, z1)`
  player.spawnAt(spawn.x, spawn.z)

  // Ferns, as an undercarpet at half a plant per square metre. Its own material
  // rather than instances in the tree batch, and that is not a violation of
  // DESIGN.md §5's one-material rule -- the rule is that one mesh cannot be split
  // by material. Ferns need their own program anyway: WHICH texture layers
  // billboard is compiled into the shader, and the two lists differ -- four tree
  // impostor layers against the fern's one -- so one shared material could not
  // spin both correctly.
  //
  // Three MESHES share that one material: the bed is an InstancedMesh per LOD
  // ring, because BatchedMesh is unusable on the Quest 2 and an InstancedMesh
  // holds one geometry. render/ferns.js's header has the argument.
  //
  // The whole Layers goes in, not just its paths: a fern takes a hue cue from
  // the terrain colour underfoot, which needs the snow band and the road
  // flattening as well as the path exclusions.
  await bootStep('ferns')
  // The village's own ferns come in as plants: the ones leaning on a wall, and the ones seated on a roof, which carry their own y.
  ferns = new Ferns(scene, height, waterSurfaces, layers, propTextures, { seed, rocks, bounds, plants: room.village ? [...roomSpec.decor.ferns, ...roofPlants] : [] })
  lighting.patch(ferns.material, { mode: 'vertex', cacheKey: 'v2-prop-bb' })
  ferns.syncSnowLine(layers)
  ferns.place(spawn.x, spawn.z)
  const fs = ferns.stats
  const fr = fs.rejected
  console.log(
    `[v2] ferns ${fs.placed} placed over ${fs.tiles} tiles in ${fs.placeMs.toFixed(0)} ms ` +
    `(${fs.density}/m^2 to ${fs.fullRadius} m, thinning to ${fs.radius} m, ` +
    `${fs.heightRange[0]}-${fs.heightRange[1]} m tall, pool ${fs.used}/${fs.pool}, ` +
    `rings ${fs.rings.join(', ')}) ` +
    `(dropped: ${fr.elev} elev, ${fr.slope} slope, ${fr.water} water, ${fr.snow} snow, ${fr.path} path)`
  )
  window.v2ferns = ferns

  // Grass, at 3 tufts per square metre -- the densest thing in the world by a
  // factor of sixty, and a material of its own for the same reason the ferns
  // have one: a mesh carries ONE material, and uBillboardLayers is a property of
  // the material, so a scatter whose cards live on a different impostor layer
  // needs its own. (Grass spins layer 34, ferns layer 31.)
  //
  // It follows the TREE pattern rather than the fern one, which is the whole
  // point of it: a tiled scatter that follows the camera, thinned so every
  // doubling of distance halves the density, and dissolved with an ordered
  // dither at each tuft's own cull distance so nothing pops. A fixed disc at
  // this density would be 46,000 instances for the same horizon. See
  // render/grass.js, which lays out where its ~54k triangles go.
  await bootStep('grass')
  buildGrass(grassStyle, spawn.x, spawn.z)
  // A/B hooks for the two grass strategies, from the console. `M` swaps the bed;
  // these tune it without a reload.
  //
  //   v2grass.tiling({ keep, short, flare })  the per-tile treatment, live --
  //     `keep` is the fragment mask and is OFF at 1.0 by default; see the note
  //     by stripKeep in material.js for why it is a LOOK knob and not a
  //     performance one, since the strip is two triangles either way.
  //   v2grass.size([lo, hi])  the height range in metres, which is also the
  //     clump WIDTH because a tile is square. Rebuilds.
  //   v2grass.density(n)  strips per square metre at full density. Rebuilds, and
  //     the triangle count is LINEAR in it -- the log line prints both.
  //
  // Those last two are the whole trade and they pull opposite ways: a strip is
  // two triangles at any size, so halving `size` costs 4x the instances to cover
  // the same ground. Both rebuild rather than reconfigure, because the pool, the
  // tile candidate count and the bank all depend on them.
  {
    const rebuild = (opts) => {
      player.headPosition(headTmp)
      buildGrass(grassStyle, headTmp.x, headTmp.z, opts)
    }
    window.v2grass = {
      style: (s) => { player.headPosition(headTmp); buildGrass(s, headTmp.x, headTmp.z) },
      tiling: (o) => { setStripTiling(o); return getStripTiling() },
      size: (h) => rebuild({ height: h }),
      density: (d) => rebuild({ density: d }),
    }
  }

  // Strewn litter: the small stones underfoot, tens of thousands of one
  // twenty-triangle pebble bedded into the ground within a few strides of her.
  // It is a sibling of the rock beds rather than a fifth bed of them because it
  // shares none of their machinery -- no bank, no tier ladder, no anchors -- and
  // it is constructed AFTER them so it can refuse to bed a pebble inside one.
  // See render/litter.js.
  await bootStep('litter')
  litter = new Litter(scene, height, waterSurfaces, layers, propTextures, { seed, ground: terrain, rocks, bounds })
  lighting.patch(litter.material, { mode: 'vertex', cacheKey: 'v2-litter' })
  litter.place(spawn.x, spawn.z)
  // Reachable from the console so the layer's cost can be measured on its own:
  // the panel's litter toggle also freezes mushrooms and deadwood.
  window.v2litter = litter
  const ls = litter.stats
  console.log(
    `[v2] litter ${ls.placed} pebbles (${ls.pool} pool) over ${ls.tiles} tiles in ` +
    `${ls.placeMs.toFixed(0)} ms, ${ls.tris} tris`
  )

  // Mushrooms, in clumps at the foot of what is already standing. THIS BLOCK
  // MUST STAY BELOW BOTH `trees` AND `rocks`, and that is a real dependency
  // rather than a tidy reading order: it is handed the live trees and rocks
  // instances and asks them, through anchorsInto, where their PLACED instances
  // actually are, because a clump grows against a trunk or a boulder and not on
  // open ground. Move this above the rocks block and nothing throws -- Rocks
  // would simply be an object with an empty scatter in it, every anchor query
  // would come back with nothing, and the world would silently have no
  // mushrooms in it. A missing layer with no error is the expensive kind of
  // bug, so leave the order alone.
  //
  // The array order is load-bearing too: [trees, rocks] is the order the
  // constructor documents, and the layer weights its anchor kinds by it.
  await bootStep('mushrooms')
  // A village grows no mushroom and no bone (DESIGN.md §30): the layers still
  // exist so a mushroom she carried in stays hers.
  mushrooms = new Mushrooms(scene, height, waterSurfaces, layers, propTextures, [trees, rocks], { seed, none: !!room.village, bounds })
  // A FOURTH cacheKey, distinct for the reason spelled out at the trees above:
  // three keys its program cache on this string, and this material's
  // uBillboardLayers is its own length, so reusing the ferns' 'v2-prop-bb'
  // would hand one of the two layers the other's compiled program.
  lighting.patch(mushrooms.material, { mode: 'vertex', cacheKey: 'v2-mushroom-bb' })
  // So a clump and the ground it stands on cross the snow line together, and so
  // that nothing sprouts above the line -- same contract as the trees and ferns.
  mushrooms.syncSnowLine(layers)
  mushrooms.place(spawn.x, spawn.z)
  const ms = mushrooms.stats
  // The rejection breakdown is printed by walking the object rather than by
  // naming its keys, because WHICH tests a site can fail is the mushroom
  // layer's own business and a key added there should show up here without a
  // second edit in this file.
  const mr = Object.entries(ms.rejected).map(([why, n]) => `${n} ${why}`).join(', ')
  console.log(
    `[v2] mushrooms ${ms.placed} in ${ms.clumps} clumps over ${ms.tiles} tiles in ` +
    `${ms.placeMs.toFixed(0)} ms (pool ${ms.used}/${ms.pool}) (dropped: ${mr})`
  )
  // The console hook lives here rather than beside window.v2ferns, because the
  // layer does not exist until this line has run.
  window.v2mushrooms = mushrooms

  // The bones: a rare find on any ground (render/bones.js), on the litter row
  // with the dead wood.
  await bootStep('bones')
  bones = new Bones(scene, height, waterSurfaces, layers, { seed, bank: await banks.bones, none: !!room.village, bounds })
  for (const m of bones.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-gen-prop' })
  bones.place(spawn.x, spawn.z)
  bones.bakeCards(renderer)
  const bs = bones.stats
  console.log(
    `[v2] bones ${bs.skeletons} skeletons + ${bs.skulls} skulls over ${bs.tiles} tiles in ` +
    `${bs.placeMs.toFixed(0)} ms (pool ${bs.used}/${bs.pool}, bank ${bs.bankKB} KB, cards ${bs.cardBakeMs.toFixed(0)} ms)`
  )
  window.v2bones = bones

  // The carrots: bunches on open ground (render/carrots.js), placed against the
  // trees and rocks already standing, like the mushrooms; every tile in a
  // village, and its gardens planted in rows on top of the wild bed.
  await bootStep('carrots')
  carrots = new Carrots(scene, height, waterSurfaces, layers, rocks, { seed, bank: await banks.carrots, keep: room.village ? 1 : undefined, bounds, plots })
  for (const m of carrots.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-gen-prop' })
  carrots.place(spawn.x, spawn.z)
  const cs = carrots.stats
  console.log(
    `[v2] carrots ${cs.placed} in ${cs.clumps} clumps over ${cs.tiles} tiles in ${cs.placeMs.toFixed(0)} ms ` +
    `(pool ${cs.used}/${cs.pool}, bank ${cs.bankKB} KB, rejected ${Object.entries(cs.rejected).map(([why, n]) => `${n} ${why}`).join(', ')})`
  )
  window.v2carrots = carrots

  // The rowboats: the viking rowboat afloat in the shallows of every lake, one
  // every 300 m or so of shoreline (render/rowboats.js), on the water row.
  await bootStep('rowboats')
  // A village's pond is a puddle with no shoreline to moor on: `none` grows no
  // tile and photographs no card, which is a quarter second of GPU readback.
  rowboats = new Rowboats(scene, height, waterSurfaces, { seed, bank: await banks.rowboats, none: !!room.village, bounds })
  for (const m of rowboats.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-gen-prop' })
  rowboats.place(spawn.x, spawn.z)
  rowboats.bakeCards(renderer)
  const rbs = rowboats.stats
  console.log(
    `[v2] rowboats ${rbs.placed} over ${rbs.tiles} tiles in ${rbs.placeMs.toFixed(0)} ms ` +
    `(pool ${rbs.used}/${rbs.pool}, bank ${rbs.bankKB} KB, cards ${rbs.cardBakeMs.toFixed(0)} ms, rejected ${Object.entries(rbs.rejected).map(([why, n]) => `${n} ${why}`).join(', ')})`
  )
  window.v2rowboats = rowboats
  // And the boats she can board: near ones come off the scatter and move,
  // rock and carry her (boats.js); the hull is stone to the walker.
  boats = new Boats(scene, rowboats, waterSurfaces, player, netplay)
  walk.addStone(boats)
  window.v2boats = boats // console: `v2boats.stats`, `v2boats.live`

  // The fish: a pool that follows her through whatever water is in reach (see
  // render/fish.js). Its materials are patched here, like every other layer's,
  // before the mesh and cutouts arrive -- the pool stays empty until they do.
  // A village seeds them on the seed its build found a school for in its lake.
  await bootStep('fish')
  fish = new Fish(scene, height, waterSurfaces, { seed: room.village ? roomSpec.fishSeed : seed })
  // A village's pond is clear: seen into from the shore (VILLAGE_POND), and its fish drawn from above (the frame loop's fishShown), where the overworld's lakes are mirrors until she dives.
  water.uniforms.uClarity.value.set(room.village ? VILLAGE_POND.clarity : WATER.clarity, Math.sin(((room.village ? VILLAGE_POND.clarityAngle : WATER.clarityAngle) * Math.PI) / 180))
  for (const sp of fish.species) lighting.patch(sp.material, { mode: 'vertex', cacheKey: `v2-fish-${sp.id}` })
  fish.place(spawn.x, spawn.z)
  fish.ready.then(() => { if (build === roomBuild) fish.place(fish.head.x, fish.head.z) })
  window.v2fish = fish
  // Now and then one clears the surface of a lake near her and falls back in (render/fish-leap.js).
  fishLeap = new FishLeap(scene, height, waterSurfaces, fish)
  window.v2fishLeap = fishLeap

  // The frogs on the banks and the crabs on the lake boulders (render/frogs.js,
  // render/crabs.js). Both are tile scatters that ask the rocks, so after them.
  await bootStep('frogs')
  frogs = new Frogs(scene, height, waterSurfaces, { seed, rocks, ground: terrain })
  lighting.patch(frogs.material, { mode: 'vertex', cacheKey: 'v2-frogs' })
  frogs.place(spawn.x, spawn.z)
  console.log(`[v2] frogs ${frogs.stats.alive} on ${frogs.stats.tiles} tiles at boot`)
  window.v2frogs = frogs
  await bootStep('crabs')
  // The crab's cross card is photographed off its GLB, so the bake waits on the load.
  crabs = new Crabs(scene, height, waterSurfaces, { seed, rocks })
  lighting.patch(crabs.material, { mode: 'vertex', cacheKey: 'v2-crabs' })
  lighting.patch(crabs.cardMaterial, { mode: 'vertex', cacheKey: 'v2-crabs-card' })
  crabs.place(spawn.x, spawn.z, clock.seconds)
  crabs.ready.then(() => { if (build === roomBuild) crabs.bakeCard(renderer) })
  console.log(`[v2] crabs ${crabs.stats.alive} on ${crabs.stats.perches} perches at boot`)
  window.v2crabs = crabs

  // The butterflies over the fields and through the woods (render/butterflies.js):
  // a scatter that lands on the trees, the rocks, the ferns and the deadwood, so after all of them.
  await bootStep('butterflies')
  butterflies = new Butterflies(scene, height, waterSurfaces, { seed, walk, clock, rocks, trees, ferns, deadwood })
  lighting.patch(butterflies.material, { mode: 'vertex', cacheKey: 'v2-butterflies' })
  butterflies.place(spawn.x, spawn.z, clock.seconds)
  console.log(`[v2] butterflies ${butterflies.stats.alive} on ${butterflies.stats.tiles} tiles at boot`)
  window.v2butterflies = butterflies

  // The grasshoppers on the grass and the forest floor (render/grasshoppers.js):
  // one instanced low-poly mesh, seated on the walk surface, so after the rocks.
  // The GLB lands after boot; until it does the mesh stays hidden.
  await bootStep('grasshoppers')
  grasshoppers = new Grasshoppers(scene, height, waterSurfaces, { seed, walk, clock })
  lighting.patch(grasshoppers.material, { mode: 'vertex', cacheKey: 'v2-grasshoppers' })
  grasshoppers.place(spawn.x, spawn.z)
  console.log(`[v2] grasshoppers ${grasshoppers.stats.alive} on ${grasshoppers.stats.tiles} tiles at boot`)
  window.v2grasshoppers = grasshoppers

  // The fireflies under the trees after dark (render/fireflies.js): one
  // instanced draw of sprite cards, admitted only beside a resident trunk, so after the trees.
  await bootStep('fireflies')
  fireflies = new Fireflies(scene, height, waterSurfaces, { seed, walk, trees })
  fireflies.place(spawn.x, spawn.z)
  window.v2fireflies = fireflies

  // The spiders on the trunks, the boulders and the ground (render/spiders.js):
  // a scatter that climbs the trees and the rocks, so after both. One material
  // for the mesh, its legs in the vertex shader, and one for the card.
  await bootStep('spiders')
  spiders = new Spiders(scene, height, waterSurfaces, { seed, trees, rocks })
  lighting.patch(spiders.material, { mode: 'vertex', cacheKey: 'v2-spiders' })
  lighting.patch(spiders.cardMaterial, { mode: 'vertex', cacheKey: 'v2-spiders-card' })
  spiders.place(spawn.x, spawn.z)
  spiders.ready.then(() => { if (build === roomBuild) spiders.bakeCard(renderer) })
  console.log(`[v2] spiders ${spiders.stats.alive} in ${spiders.stats.groups} groups at boot`)
  window.v2spiders = spiders

  // The stag, the fox and the hare wandering the open ground (render/wildlife.js):
  // they stand on the WalkSurface, so after the rocks and the trees that compose
  // it. The GLBs land after boot; until they do the layer places nothing, and
  // the first frame after they land fills the tiles around her. A village holds
  // the small ones only (DESIGN.md §30): no stag, and no dragons below.
  await bootStep('wildlife')
  wildlife = new Wildlife(scene, height, waterSurfaces, { seed, walk, dayness: (s) => clock.daynessAt(s), species: room.village ? ['fox', 'hare'] : null })
  for (const m of wildlife.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-wildlife' })
  wildlife.ready.then(() => {
    if (build !== roomBuild) return
    wildlife.place(player.rig.position.x, player.rig.position.z)
    // The card rung's picture is photographed off the posed body, so the bake waits on the load.
    wildlife.bakeCards(renderer)
    console.log(`[v2] wildlife ${JSON.stringify(wildlife.stats.alive)} on ${wildlife.stats.tiles} tiles`)
  })
  window.v2wildlife = wildlife
  // The room's creatures over the relay (creature-net.js): a lured animal's
  // anchors out, everyone else's in, routed to its layer by the key's first word.
  creatureNet = new CreatureNet(netplay, clock, [{ layer: wildlife, prefixes: ['st', 'fx', 'hr'] }])
  creatureNet.add(frogs, ['fg'])
  creatureNet.add(fish, ['fs'])
  // The four small layers whose whole life is closed form send one thing only:
  // the release, so a creature let out of a hand lands on every client rather
  // than vanishing into it for everyone but the one who dropped it.
  creatureNet.add(butterflies, ['bf'])
  creatureNet.add(spiders, ['sp'])
  creatureNet.add(crabs, ['cb'])
  creatureNet.add(grasshoppers, ['gh'])
  window.v2creatureNet = creatureNet

  // The abominable snowmen above the snow line (render/snowmen.js): the same
  // ground and the same late-landing GLB as the wildlife.
  await bootStep('snowmen')
  snowmen = new Snowmen(scene, height, waterSurfaces, { seed, walk })
  for (const m of snowmen.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-snowmen' })
  snowmen.ready.then(() => {
    if (build !== roomBuild) return
    snowmen.place(player.rig.position.x, player.rig.position.z, clock.seconds)
    console.log(`[v2] snowmen ${snowmen.stats.alive} on ${snowmen.stats.tiles} tiles`)
  })
  creatureNet.add(snowmen, ['sn'])
  window.v2snowmen = snowmen

  // Her hands (hands.js): what a controller takes from the beds, the ground
  // and the creature layers, holds, drops and stows, so after every layer it
  // picks from; the roosts come later and register their eggs themselves. The desktop's hand is a point a little under and ahead of the camera
  // with a longer reach, so G takes what the cursor is looking at up close.
  await bootStep('hands')
  hands = new Hands(scene, {
    walk,
    water: waterSurfaces,
    haptic: questPulse,
    stow: (rec) => {
      const slot = backpack.indexOf(null)
      if (slot < 0) return false
      backpack[slot] = hands.pack(rec)
      paintBackpack()
      playStow()
      return true
    },
    // A drop meeting the ground: an animal's footfall where it lands. `ambience` stands for the clips having loaded.
    thud: (x, y, z) => { if (ambience) sound.play('footfall', { bus: 'near', rate: THREE.MathUtils.randFloat(RATE[0], RATE[1]), gain: 0.6, at: { x, y, z } }) },
    splash: (x, y, z) => { if (ambience) sound.play('splash', { bus: 'near', rate: THREE.MathUtils.randFloat(RATE[0], RATE[1]), gain: 0.7, at: { x, y, z } }) },
    scale: room.scale,
  })
  hands.addSource(mushrooms, 'mushroom')
  hands.addSource(carrots, 'carrot')
  hands.addSource(spiders, 'spider')
  hands.addSource(butterflies, 'butterfly')
  hands.addSource(fish, 'fish')
  hands.addSource(crabs, 'crab')
  hands.addSource(ferns, 'fern')
  hands.addSource(litter, 'pebble')
  hands.addSource(grasshoppers, 'grasshopper')
  hands.addSource(bones, bones.kinds)
  hands.addSource(rocks, 'rock')
  hands.addSource(flareGuns, FLAREGUN)
  hands.addHand('left', leftGrip)
  hands.addHand('right', rightGrip)
  deskHand = new THREE.Group()
  deskHand.position.set(DESK_HAND_REST.x, DESK_HAND_REST.y, DESK_HAND_REST.z)
  camera.add(deskHand)
  hands.addHand('desk', deskHand, { reach: 4 * REACH_M })
  window.v2hands = hands
  // The room's things (hands-net.js): what her hands hold and let go, to the relay; every peer's, and the beds a peer has picked from, back.
  handsNet = new HandsNet(hands, netplay, peerAvatars, taken)
  window.v2handsNet = handsNet

  // The dragons' roosts (render/roosts.js), a scatter like the bones with its
  // own bark and stone maps and the shipped egg in half of them, and the
  // dragons that live in them (render/dragons.js), hunting the wildlife's
  // stags. The roosts stand at once; the dragons wait for their GLB like the rest.
  await bootStep('dragons')
  if (!room.village) {
    const [roostMaps, eggBank] = await Promise.all([loadRoostMaps(), loadEggBank()])
    roosts = new Roosts(scene, height, waterSurfaces, layers, { seed, maps: roostMaps, egg: eggBank })
    for (const m of roosts.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-gen-prop' })
    roosts.place(spawn.x, spawn.z)
    roosts.bakeCards(renderer)
    console.log(`[v2] roosts ${roosts.stats.placed} with ${roosts.stats.eggs} eggs over ${roosts.stats.tiles} tiles in ${roosts.placeMs.toFixed(1)} ms`)
    window.v2roosts = roosts
    hands.addSource(roosts, 'egg')
    dragons = new Dragons(scene, height, { seed, roosts, wildlife, water: waterSurfaces })
    for (const m of dragons.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-dragons' })
    dragons.ready.then(() => {
      if (build !== roomBuild) return
      dragons.bakeCards(renderer)
      console.log(`[v2] dragons: fly pose ${(2 * dragons.fly.halfZ * dragons.asset.sizeM / dragons.asset.span).toFixed(1)} m across`)
    })
    window.v2dragons = dragons
    creatureNet.add(dragons, ['dr'])
  }

  // The leafkin village entrances (render/entrances.js, DESIGN.md §30): a
  // mouth on the face of every hollow boulder the rocks hold resident, or in a
  // village the one mouth out, where its file says.
  await bootStep('entrances')
  entrances = new Entrances(scene, height, waterSurfaces, rocks, { seed, bank: await banks.mouth, fixed: room.village ? [roomSpec.exit] : null })
  for (const m of entrances.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-gen-prop' })
  entrances.place(spawn.x, spawn.z)
  walk.addStone(entrances)
  console.log(`[v2] entrances ${entrances.stats.placed} mouths in ${entrances.placeMs.toFixed(1)} ms, refused ${JSON.stringify(entrances.stats.rejected)}`)
  window.v2entrances = entrances

  // One leafkin a village (render/leafkin.js), out of its mouth into the wood for mushrooms, its caps carried by the hands' pool. None inside a village.
  if (room.leafkin) {
    await bootStep('leafkin')
    const ground = new LeafkinGround({ field: height, water: waterSurfaces, trees, rocks, deadwood, mushrooms })
    leafkin = new Leafkin(scene, { ground, walk, entrances, mushrooms, hands })
    for (const m of leafkin.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-leafkin' })
    leafkin.ready.then(() => console.log(`[v2] leafkin ${leafkin.asset.height.toFixed(2)} m body, ${Object.keys(leafkin.durations).length} clips`))
    creatureNet.add(leafkin, ['lk'])
  }
  window.v2leafkin = leafkin
  // The villagers (render/villagers.js): the leafkin who live here, one a house and a spare, about the roads and in and out of their doors.
  if (room.village) {
    await bootStep('villagers')
    // Their seats: the hearth's stools, sat on facing the fire, and the scattered ones.
    const seats = [...hearth.stools.map((s) => ({ x: hearth.x + s.x, z: hearth.z + s.z, top: hearth.y + s.top, r: s.r, lookX: hearth.x, lookZ: hearth.z })), ...stools.seats()]
    villagers = new Villagers(scene, waterSurfaces, { walk, roads: roomSpec.doc.roads, doors: roomProps.doors(), lake: roomSpec.lake, seats, seed: villageSeed() })
    for (const m of villagers.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-villagers' })
    villagers.ready.then(() => console.log(`[v2] villagers ${villagers.all.length} over ${villagers.graph.nodes.length} road nodes`))
    creatureNet.add(villagers, ['vg'])
    // Their pets (render/hobs.js): a hob weevil at most houses, trailing its owner or keeping the yard, babies trailing it.
    hobs = new Hobs(scene, { walk, villagers, seed: villageSeed() })
    for (const m of hobs.materials) lighting.patch(m, { mode: 'vertex', cacheKey: 'v2-hobs' })
    hobs.ready.then(() => console.log(`[v2] hobs ${hobs.stats.adults} adults, ${hobs.stats.babies} babies`))
  }
  window.v2villagers = villagers
  window.v2hobs = hobs

  // The ambient sound over this room's layers, once the clips are in.
  await bootStep('sound')
  soundReady.then((ok) => {
    if (!ok || build !== roomBuild) return
    ambience = new Ambience({
      engine: sound,
      sense: new WorldSense({ field: height, water: waterSurfaces, rocks, frogs, biome: trees.biome }),
      // Whose feet are heard: each herd's walking bodies against the footfalls of its clip library, the fox's yip and the stag's grunt on top; the crabs together hold one loop and a startled spider fires it once; the dragons beat, roar and growl; the fish swoosh as they set off.
      herds: [{ layer: wildlife, clips: 'quadruped', calls: { fox: 'foxYip', stag: 'deerGrunt' } }, { layer: snowmen, clips: 'human' }, ...[leafkin, villagers].filter(Boolean).map((layer) => ({ layer, clips: 'human' }))],
      voiced: [leafkin && { layer: leafkin, rule: 'voice' }, villagers && { layer: villagers, rule: 'villagerVoice' }, { layer: frogs, rule: 'frogHop' }, { layer: fishLeap, rule: 'splash' }].filter(Boolean),
      crawlers: [crabs],
      startlers: [spiders],
      dragons,
      fish,
      grasshoppers,
      // A village's pond is too small for a wave to break on its shore: the quiet lapping alone.
      waves: !room.village,
      // A violin through the wall of half a village's houses.
      fiddlers: room.village ? roomProps.fiddlers() : [],
      // The crackle of the clearing's hearth, and a soft one from every torch while they are lit.
      campfires: hearth ? [hearth.fire] : [],
      torches: lamps ? { at: lamps.lamps.map((l) => ({ x: l.x, y: l.flameY, z: l.z })), lit: () => lamps.lit } : null,
    })
    window.v2ambience = ambience
  })

  // Last of the layers, so the cursor readout can be bound now. Deliberately
  // here rather than lazily inside the readout: a missing scatter should be a
  // boot error next to the thing that failed to build, not a readout that
  // silently stops naming ferns.
  await bootStep('ui')
  bindCursorPicks()
  if (propLayersReady) bakeImpostors()

  // Each layer starts where its toggle says, READ FROM THE TOGGLE rather than
  // from a literal, so a changed default takes effect instead of leaving the
  // panel claiming a layer is on while the world shows none.
  // litter/mushrooms/deadwood share the one `litter` row -- see
  // QUEST_TOGGLE_ROWS -- and are always constructed either way, because
  // mushrooms anchors onto placed trees and rocks whether it is drawn or not.
  //
  // `water.group` IS THE NODE THE `water` ROW OWNS, all the way through. Every
  // v2 lake and river is a child of it -- WaterSurfaces parents its own group
  // under this one -- so hiding it and then toggling the CHILD is a lake that
  // can never be shown, the parent flag still false underneath.
  terrain.batch.visible = questToggles.terrain
  terrainWire.visible = questToggles.terrainWire
  trees.batch.visible = questToggles.trees
  trees.setCardsOnly(!questToggles.treeTiers)
  trees.setCutout(questToggles.treeCutout)
  setTierTint(questToggles.critterTint)
  rocks.setHollowTint(questToggles.critterTint)
  applyRockVisibility()
  grass.batch.visible = questToggles.grass
  ferns.meshes.forEach((m) => { m.visible = questToggles.ferns })
  carrots.batch.visible = questToggles.ferns
  water.group.visible = questToggles.water
  rowboats.batch.visible = questToggles.water
  water.setCubeReflections(questToggles.reflections)
  aurora.mesh.visible = questToggles.aurora
  litter.batch.visible = questToggles.litter
  mushrooms.batch.visible = questToggles.litter
  deadwood.batch.visible = questToggles.litter
  bones.batch.visible = questToggles.litter
  applyAnimalVisibility()
  // THE EDITOR OVERLAY, drawn only where there is an editor. Markers is three
  // InstancedMeshes of authoring handles -- 96 triangles a spline point, 8 a
  // snow point, 168 a lake -- and the shipped document carries 37 river points,
  // 77 snow points and 2 lakes, so it is ~4.5k triangles and 3 draw calls per
  // eye of pure editor furniture.
  //
  // Without an editor it would also draw them WRONG. Markers.update() writes
  // the instance matrices and its only caller is `editor.update` -- so every
  // handle would sit at the origin at unit scale, and the material is
  // depthTest:false, so they would draw over the world from wherever the
  // camera was. That was the speck at the horizon.
  markers.group.visible = EDITOR_MODE
  // The quadtree's own header says the XR route wants 4.0 degrees or coarser
  // and that 3.0 spends 91% of terrain's whole triangle share, against 68% at
  // 4.0.
  //
  // 5.72 rather than 4.0: measured over a 48-camera walking sweep of the real
  // heightmap, worst-case selection is 262 leaves at 4.0 against 175 at 5.72,
  // which is 335k triangles against 224k before any culling. The ceiling is
  // MAX_TRI_DEG = atan(2 / CHUNK_RES) = 7.125 degrees, where the range floor in
  // the split rule stops the rule from refining at all.
  LOD.triDeg = Math.min(MAX_TRI_DEG, 5.72)
  // NO PER-INSTANCE FRUSTUM CULL AND NO SORT ON THE TERRAIN BATCH. Both run a
  // CPU sweep over every chunk in BatchedMesh.onBeforeRender -- read the 4x4
  // out of the matrix texture, transform the bounding sphere, test it, rebuild
  // the multi-draw list -- and in XR onBeforeRender is called once per EYE.
  // That sweep is what made a layer "blink" in the headset: stalls past the
  // compositor's deadline reproject a stale frame. The rock beds, 323k pooled
  // instances swept twice a frame, took it from 90 fps to about 20 before they
  // moved to InstancedMesh arenas, which have no per-instance cull to run.
  // Submitting every chunk to the GPU is the cheaper side of that trade on a
  // world that is nowhere near GPU-bound, and the yaw cull below gets most of
  // it back for free: TerrainV2.cullDeg reuses the cone test _syncVisibility
  // was already running for a stats readout. Worst case over the same sweep:
  // 224k submitted becomes 108k. A menu row used to A/B this; it measured the
  // same answer every time and is gone.
  terrain.batch.perObjectFrustumCulled = false
  terrain.batch.sortObjects = false
  terrain.cullDeg = (70 * Math.PI) / 180
  // The first build reports from bootDone, which has the overlay to take down
  // and a save to apply after this returns; a swap has nothing after it.
  if (build > 1) bootReport()
  return { spawn, fresh }
}

/** A village's wood (village.js WOOD): meadow in the clearing, full cover along the roads' verges and WOOD.cover between them. */
function villageBiome(seed, clearing, paths) {
  const { x, z, r } = clearing
  return {
    seed,
    coverAt: (px, pz) => {
      const dx = px - x, dz = pz - z
      if (dx * dx + dz * dz < r * r) return 0
      const road = paths.nearest(px, pz, 'road')
      return road !== null && road.dist - road.halfWidth < WOOD.verge ? 1 : WOOD.cover
    },
  }
}

/** What each hand held goes back into that hand, or, while its source has not landed the asset it is dressed with, into a free backpack slot. */
function restoreHeld(held) {
  for (const key of HAND_KEYS) {
    if (!(key in held)) continue
    const slot = held[key]
    if (hands.dressed(slot) !== null) { hands.give(key, slot, handsHead()); continue }
    const free = backpack.indexOf(null)
    if (free >= 0) { backpack[free] = slot; console.warn(`[v2] the ${slot.kind} in the ${key} hand is not dressed yet, put in slot ${free}`) }
    else console.warn(`[v2] the ${slot.kind} in the ${key} hand is not dressed yet and the backpack is full; lost`)
  }
  paintBackpack()
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
 * The water rebuilds WHOLE, and that is not an oversight: a lake is two
 * hundred triangles and a river is one per metre, so the entire authored set is
 * cheaper to rebuild than to diff. `rebuildOne(id)` exists for when that stops
 * being true. A road has no mesh to rebuild; its surface is the terrain the
 * rect just rebaked.
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
  waterSurfaces.rebuild(rect)
}

/**
 * A relief knob moved. This is the one call in the file that changes the SHAPE
 * OF THE GROUND, and everything below follows from that one fact.
 *
 * THE ORDER IS LOAD-BEARING, and each step is here because leaving it out is a
 * visible bug rather than a missed optimisation:
 *
 *   1. `height.setRelief` first, and synchronously. It is the slow half -- a
 *      full-field erosion at the top of the erode knob -- and every step after
 *      it reads the field it rebuilds. It is also the field the PLAYER collides
 *      with, so until it is current she is standing on the old mountain.
 *   2. `terrain.setRelief` posts to both workers, which rebuild their own copies
 *      concurrently with nothing here. The workers hold SEPARATE V2Height
 *      instances (see relief.js's banner and V2Height's WORLD_SEED comment); a
 *      knob that reached one and not the other is the hover-or-sink failure that
 *      module exists to prevent, and neither call can be dropped for the other.
 *   3. `bands` is re-read, because the relief moves the world's own min and max
 *      -- erosion alone takes metres off the summits -- and the rock beds and
 *      the snow line are both expressed against that range.
 *   4. Every prop layer is re-placed. Props are scattered ONTO the field: their
 *      y comes from a heightAt taken when they were placed, so a tree placed on
 *      the old surface stands in the air over an eroded one. Re-placing is the
 *      only correction available, since nothing keeps the site list.
 *   5. The player is lifted onto the new ground, for the same reason and because
 *      the alternative -- falling through a summit that just dropped 3 m -- is
 *      the one that is actually alarming.
 *
 * WHAT IS NOT HERE. No `onDirty`: the document did not change, so there is
 * nothing to autosave, no undo entry, and no layer rebake. Water levels and
 * road heights are untouched for the same reason -- both are authored
 * elevations, and a lake does not move because the hillside beside it grew a
 * crag. That is deliberate rather than an oversight: relief is gated off
 * flat, concave ground precisely so that it cannot walk a river out of its bed.
 * The river meshes alone are rebuilt, because the lift they carry over the far
 * terrain is measured from the ground as the `peaks` knob draws it.
 */
function onRelief(next) {
  const want = normalizeRelief(next)
  if (sameRelief(want, relief)) return
  relief = want
  localStorage.setItem(RELIEF_KEY, JSON.stringify(relief))
  // Two views of one value: the editor's relief zone and the world menu's
  // row. Whichever one was pressed, the other has to follow.
  if (panel) panel.setRelief(relief)
  refreshQuestRow('peaks') // DEAD CODE (peaks)

  const t0 = performance.now()
  height.setRelief(relief)
  const fieldMs = performance.now() - t0
  terrain.setRelief(relief)
  if (waterSurfaces !== null) waterSurfaces.rebuild()

  const bands = height.bands
  const cx = player.rig.position.x
  const cz = player.rig.position.z

  replacePropsOnMovedGround(cx, cz)

  console.log(
    `[v2] relief ${JSON.stringify(relief)} -- field ${fieldMs.toFixed(0)} ms, ` +
      `world ${bands.min.toFixed(1)}..${bands.max.toFixed(1)} m, props re-placed`
  )
}

/**
 * The ground moved. Put every scatter back down on it and re-seat the player.
 *
 * EXTRACTED FROM onRelief RATHER THAN COPIED, because there are now two callers
 * and the ORDER is the whole content of this function: mushrooms are anchored
 * to the trees and rocks that are already standing, so re-placing them before
 * those have moved would anchor a clump to the world that just went away. That
 * is a silent bug -- nothing throws, the clumps simply hang in the old places --
 * and a second copy of the block is exactly how it would come back.
 *
 * A prop's y is read ONCE, when it is placed. Nothing keeps the site list, so
 * re-placing is not an optimisation over moving them; it is the only correction
 * available.
 */
function replacePropsOnMovedGround(cx, cz) {
  // First: the trees keep off it, and the plans it answers them from were
  // tested on the old ground.
  if (deadwood) deadwood.place(cx, cz)
  if (trees) {
    trees.syncSnowLine(layers)
    trees.place(cx, cz)
  }
  if (ferns) {
    ferns.syncSnowLine(layers)
    ferns.place(cx, cz)
  }
  if (grass) {
    grass.syncSnowLine(layers)
    grass.place(cx, cz)
  }
  if (rocks) {
    rocks.syncBands(layers)
    rocks.place(cx, cz)
  }
  if (entrances) entrances.place(cx, cz)
  if (litter) litter.place(cx, cz)
  // LAST, and after rocks specifically, for the reason given where mushrooms
  // are constructed: a clump is placed against the trees and rocks that are
  // already standing, so re-placing it before they have moved onto the new
  // relief would anchor it to the old world.
  if (mushrooms) {
    mushrooms.syncSnowLine(layers)
    mushrooms.place(cx, cz)
  }
  if (bones) bones.place(cx, cz)
  if (carrots) carrots.place(cx, cz)
  if (rowboats) rowboats.place(cx, cz)
  if (roosts) roosts.place(cx, cz)
  placeAnimals(cx, cz)

  // Re-seat her at the same x/z on the new surface. spawnAt is the only method
  // that resolves y from the field rather than integrating toward it, and the
  // zeroed speed it also does is wanted here: the ground moved under her, so any
  // momentum she had was measured against terrain that no longer exists.
  player.spawnAt(cx, cz)
}

// WHAT IS DRAWING BEFORE ANYTHING IS SWITCHED ON.
//
// The quest panel reports CALLS and TRIS off renderer.info, and those are totals
// with no names attached -- "88 draw calls and 8000 triangles on an empty world"
// is a question the panel cannot answer, and the headset has no console to poke
// at. This walks the graph once at boot and names every drawable that is actually
// visible, so the boot number is an inventory rather than a mystery.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO. It does not filter by frustum -- an
// object out of view still costs its slot in this inventory the moment you turn
// towards it, and hiding it here would make the census disagree with the panel
// depending on which way the wearer happened to be facing. And it counts three's
// side of the graph only: A-Frame's own entities (the controller models once a
// controller connects) live in the same scene and are counted like anything
// else, which is the point -- they are draw calls too.
//
// One line per drawable, coarsest first, and a total that should match the
// panel's CALLS on the flatscreen. In XR the panel's number is the TWO-EYE sum
// (three resets info once per render() and then loops camera.cameras), so expect
// the panel to read double this.
function logSceneCensus() {
  const rows = []
  scene.traverseVisible((o) => {
    const geo = o.geometry
    if (!geo || !o.isMesh) return
    const instances = o.isInstancedMesh ? o.count : 1
    // A layer waiting on its GLB stands as an empty geometry with no instance
    // on it (spiders.js, and every critter layer built the same way). Nothing
    // is drawn, so there is no row -- and the throw below is for a mesh that IS
    // drawn with no geometry under it, which is a bug.
    if (instances === 0) return
    const index = geo.getIndex()
    const position = geo.getAttribute('position')
    if (!index && !position) throw new Error(`scene census: ${o.name || o.type} is a mesh with neither an index nor a position attribute`)
    const verts = index ? index.count : position.count
    rows.push({
      name: o.name || o.type,
      tris: Math.floor(verts / 3) * instances,
      // A BatchedMesh's index buffer is its whole ALLOCATION -- SLOT_COUNT chunks
      // worth -- not what a frame draws, so its row is an upper bound and says so
      // rather than being silently wrong. Every batch is hidden at boot, which is
      // the only reason this is a footnote and not a correction.
      note: o.isInstancedMesh ? `${instances} instances` : o.isBatchedMesh ? 'batched, whole allocation' : '',
    })
  })
  rows.sort((a, b) => b.tris - a.tris)
  const tris = rows.reduce((s, r) => s + r.tris, 0)
  console.log(`[v2] scene census at boot: ${rows.length} visible meshes = ${rows.length} draw calls, ${tris} triangles (one eye)`)
  for (const r of rows.slice(0, 24)) {
    console.log(`      ${String(r.tris).padStart(7)} tris  ${r.name}${r.note ? `  (${r.note})` : ''}`)
  }
  if (rows.length > 24) console.log(`      ... and ${rows.length - 24} more`)
}

// THE GROUND'S MATERIAL: the stipple rung, and it is the only one drawn.
//
// It is the plain vertex-lit chain -- vColor times an already-interpolated
// irradiance plus fog, a stock Lambert patched in vertex mode for the night
// lift, the shadow lookup and the aerial ramp -- plus ONE implicit-LOD fetch of
// the stipple tile laid into each triangle face on the per-face frame the
// mesher baked (chunk-mesh-v2 STIPPLE FRAME): world-aligned on the face's
// dominant plane, tile size stepped by the face's distance at build time, and
// a tilt on the normal. The vertex colour says what the ground IS, the stipple
// says what it is made of, and that is the whole surface. No derivatives, no
// guards, no per-pixel classification, no blending between materials, no
// triplanar: a cliff takes the same one fetch on its own face and reads fine.
// It is VASTLY better to look at than every surface shader tried before it and
// costs what a textured static mesh costs. See §7 for the ladder it replaced
// and the measurements that retired it; the `landscape shader` menu row that
// cycled those rungs went with them. terrain-material.js's full chain is still
// compiled by TerrainV2 at boot -- the depth material and TerrainTint hold its
// uniforms -- and by the benches and gates, and is never drawn.
//
// Built on first use rather than at construction, and keyed by whether it
// carries caustics: the wet twin is the one thing that still swaps the
// material. See applySubmersion.
const builtPlainTerrain = new Map()

/**
 * The stipple rung, dry or wet, built once each and kept.
 *
 * PATCHED IN VERTEX MODE. Unpatched it had no aerial ramp, so distant mountains
 * faded to flat white fogColor -- the opposite of what air does, which is to go
 * blue with depth. It also had no night lift and no terrain shadow, so it was
 * wrong twice more at dusk.
 *
 * 'vertex' AND NOT 'fragment', and it is the cheaper mode in every direction.
 * It carries ONE small varying rather than needing a vWorldPos this material
 * does not have, it moves the sun and sky horizon lookups to the vertex stage,
 * and it still installs AERIAL_GLSL in the fragment shader -- the ramp is a
 * function of vFogDepth, which every fogged material already interpolates, so
 * the thing that was actually missing costs nothing to add. At a 50 cm leaf
 * cell the per-vertex shading is finer near the camera than the shadow map it
 * samples, which is the same argument this mode already wins for the props.
 *
 * THE WET TWIN is the same material with the caustic net compiled in, and it
 * exists as a SECOND PROGRAM rather than as a uniform branch because the net
 * needs a world position per pixel and the vertex path has none: switching it
 * on inside one program would interpolate a vec3 across every hillside in the
 * world to light the lake beds. Two programs put the whole cost -- varying,
 * noise and branch -- inside the one she is only ever drawn with under water.
 * Caustics are not what makes a bed a bed, so a dry build is unchanged from what
 * shipped, byte for byte. See applySubmersion for when the swap happens.
 */
function plainTerrainRung(wet) {
  const key = wet ? 'stipple-wet' : 'stipple'
  let mat = builtPlainTerrain.get(key)
  if (!mat) {
    mat = createPlainTerrainMaterial(terrain.material, { stipple: true })
    lighting.patch(mat, { mode: 'vertex', cacheKey: `v2-terrain-shadow-${key}`, caustics: wet })
    builtPlainTerrain.set(key, mat)
  }
  return mat
}

/** Put the ground's material on the mesh, wet or dry for where her head is. */
function applyTerrainShader() {
  terrain.batch.material = plainTerrainRung(causticsArmed)
}

/**
 * A row's eye button was clicked. Nothing about the DOCUMENT changed, so this is
 * deliberately not onDirty: no rebake, no rebuild, no dirty rect, no undo entry
 * -- hiding a lake must not cost a terrain remesh. The water already holds the
 * predicate, so all that is needed is for it to re-read it.
 */
function onView() {
  waterSurfaces.applyVisibility()
}

function onTool(name) {
  if (!editor || !panel) return
  editor.setActive(true)
  editor.setTool(name)
  panel.syncSelection()
}

async function onAction(name) {
  if (!editor || !panel) return
  panel.setError('')
  try {
    if (name === 'save') {
      // ONE SAVE BUTTON, TWO FILES. The terrain brush edits the import rather
      // than the document (see height/sculpt.js), so a sculpted world is only
      // half-saved by layers.json -- and a second button that has to be
      // remembered is how an afternoon of sculpting gets lost to a reload.
      // Written only when there is something to write: it is a megabyte of PNG.
      //
      // THE HEIGHTMAP GOES FIRST, and a failure to write it downloads it. The
      // document has a localStorage tier behind it and the field has none, so
      // between the two this is the one whose only other copy is a tab.
      let sculpt = ''
      if (editor.sculptor.dirty) {
        try {
          const h = await editor.sculptor.save()
          sculpt = `, ${(h.bytes / 1024).toFixed(0)} kB to ${h.path}`
        } catch (err) {
          const f = await persist.exportHeightFile(editor.sculptor.heightmap)
          throw new Error(
            `${err.message} (downloaded ${f.name}, ${(f.bytes / 1024).toFixed(0)} kB -- ` +
              'copy it over public/world/height.png if the retry does not work)'
          )
        }
      }
      const r = await persist.saveServer(layers)
      panel.setError(`saved ${r.bytes} B to ${r.path}${sculpt}`)
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
 * instance, which is what makes this a one-liner: V2Height, WaterSurfaces and
 * Markers all hold that same object by reference and would otherwise every one
 * of them keep editing the document that was just replaced.
 * See restore.js.
 */
function loadDoc(doc) {
  editor.loadDoc(doc)
  // A whole-document replacement is not a rect, so the terrain is told
  // everything changed. This is the one call site where a full invalidation is
  // correct rather than lazy.
  terrain.setLayers(layers.serialize(), null)
  waterSurfaces.rebuild()
  markers.sync()
}

// --- input ------------------------------------------------------------------

// v1's table minus `h`, which the panel binds itself (see its constructor), and
// with `t` reassigned from v1's tuner to teleport. Everything else is v1's,
// including the Dvorak double binding -- `,aoe` sit on the physical WASD keys,
// `KeyboardEvent.code` reports position and `.key` reports the character, so
// binding both means the file works on either layout.
const KEY_ACTIONS = {
  ',': 'forward',
  a: 'left',
  o: 'back',
  e: 'right',
  ' ': 'flyUp',
  Shift: 'flyDown',
  t: 'teleport',
  u: 'unstick',
  g: 'grab',
  v: 'stow',
  q: 'flareColor',
  n: 'timeSkip',
  p: 'auroraPattern',
  k: 'weather',
  m: 'grassStyle',
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
  KeyT: 'teleport',
  KeyG: 'grab',
  KeyV: 'stow',
  KeyQ: 'flareColor',
  KeyN: 'timeSkip',
  KeyP: 'auroraPattern',
  KeyK: 'weather',
  KeyM: 'grassStyle',
  BracketLeft: 'coarser',
  BracketRight: 'finer',
}

// ---------------------------------------------------------------------------
// EVERY HOTKEY IN /v2 MUST BE LISTED HERE. This is the table the panel's
// `hotkeys` button prints, and it is the only place a player can find out that a
// key exists: an unlisted binding is, from the outside, a key that does nothing.
// Adding a binding anywhere under src/v2/ -- here, in the panel, in the editor
// -- means adding its row in the same change.
//
// It lives beside KEY_ACTIONS/CODE_ACTIONS rather than in the panel because the
// panel is a leaf: main.js drives it and it never imports the host. So the list
// is defined where the key map already is and handed to the Panel constructor.
//
// The rows the editor and the panel own are here too, deliberately duplicated
// from editor.js and panel.js. One list the reader can scan beats three that are
// each locally correct, and the alternative -- every module exporting its own
// fragment -- makes the panel import the editor's private key table to render a
// help screen.
// ---------------------------------------------------------------------------
const HOTKEYS = [
  {
    group: 'movement',
    rows: [
      // `,aoe` are the characters the physical WASD keys produce on Dvorak; both
      // bindings are live at once, which is what actionsFor resolves.
      { keys: 'W A S D  /  , a o e', what: 'walk forward, strafe left, back, strafe right' },
      { keys: 'mouse', what: 'look around once a click on the world has captured it; esc gives the cursor back, and a drag looks around while it is free' },
      { keys: 'up / down', what: 'walk forward and back' },
      { keys: 'left / right', what: 'turn on the spot' },
      { keys: 'space', what: 'start flying, and hold to climb' },
      { keys: 'space space', what: 'double-tap to stop flying and land' },
      { keys: 'shift', what: 'fly down while flying' },
      { keys: 't', what: 'hold to lob a teleport arc at the cursor, release to go -- the same throw the headset makes' },
      { keys: 'u', what: 'unstick: hop to the nearest walkable ground when wedged on a slope' },
      { keys: 'g', what: 'take the nearest thing under two metres within reach of a hand under the camera -- a mushroom, carrot, fern, pebble, stone, skull, dragon egg, spider, butterfly, grasshopper, fish or crab -- and let go of what it holds, the flare gun too; the trigger in the headset, and a grip lets go' },
      { keys: 'click', what: `take the thing under the cursor -- the centre of the view while the mouse is captured -- within ${DESK_CLICK_M} m, and let go of what the hand holds, or fire the flare gun it holds; with the backpack open, press a slot to stow, take or swap, and a click past the menu still reaches the world` },
      { keys: 'v', what: 'put what the hand holds in the backpack; over the shoulder in the headset' },
      { keys: 'q', what: 'the next colour for the flare gun in the hand, shown in its window; A / X in the headset' },
    ],
  },
  {
    group: 'world',
    rows: [
      { keys: 'n', what: `skip time forward ${CLOCK.skipHours} hours` },
      { keys: 'p', what: 'cycle the aurora pattern' },
      { keys: 'k', what: 'hold the weather: live, clear, scattered, overcast, rain' },
      { keys: 'm', what: 'swap the grass bed between scattered strips and card clumps' },
      { keys: 'h', what: 'hide and show this panel' },
      { keys: 'tab', what: 'open and close the world menu, the same one B / Y opens in the headset' },
    ],
  },
  {
    group: 'terrain LOD',
    rows: [
      { keys: '[', what: 'coarser terrain: triDeg up one step of 1.25x' },
      { keys: ']', what: 'finer terrain: triDeg down one step of 1.25x' },
    ],
  },
  {
    group: 'editor',
    rows: [
      { keys: '`', what: 'arm and disarm the editor' },
      { keys: `${TOOL_KEYS.join(' ')}`, what: `arm a tool: ${TOOLS.join(', ')}` },
      // G/R/S are the editor's only while a gizmo is attached -- see the
      // key-conflict note at the top of editor.js. With nothing selected, S is
      // still walk-backward.
      { keys: 'g r s', what: 'gizmo move, rotate, scale -- only with something selected' },
      { keys: 'x y z', what: 'constrain the gizmo to one axis, same key again to release' },
      { keys: 'enter', what: 'finish the river or road being drawn' },
      { keys: 'esc', what: 'cancel the path being drawn, else deselect; also closes this list, and frees a captured mouse' },
      { keys: 'delete / backspace', what: 'delete the selected point or object' },
      { keys: 'ctrl/cmd Z', what: 'undo, and shift-Z or Y to redo' },
    ],
  },
]

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
// THE MOUSE IS CAPTURED FOR LOOKING. A left click on the world takes the
// pointer lock, and from then on the mouse turns the view with no button held
// and a click lands at the centre of the view, under the crosshair -- on the
// open menu too, which is aimed at like the world. Escape (the browser's own
// exit, which the page never sees as a key) gives the cursor back; so does
// arming the editor, which wants it for its handles. Without the lock a drag
// still looks around, so nothing is lost while the cursor is free.
const mouseCaptured = () => document.pointerLockElement === renderer.domElement
function captureMouse() {
  if (mouseCaptured() || renderer.xr.isPresenting) return
  // Refused by the browser without a fresh user gesture, or while the tab is
  // not focused; both are the browser's call and neither is worth an error.
  const p = renderer.domElement.requestPointerLock()
  if (p && typeof p.catch === 'function') p.catch(() => {})
}
function freeMouse() {
  if (mouseCaptured()) document.exitPointerLock()
}
const crosshair = document.createElement('div')
crosshair.className = 'qa-crosshair'
crosshair.style.cssText = 'position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,0.75);box-shadow:0 0 2px rgba(0,0,0,0.8);pointer-events:none;z-index:998;display:none'
document.body.appendChild(crosshair)
document.addEventListener('pointerlockchange', () => {
  crosshair.style.display = mouseCaptured() ? 'block' : 'none'
  dragging = false
})
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

// Flight is allowed in the headset, against LOCOMOTION's comfort rule (free
// flight with no ground reference is a nausea generator, and §12 puts comfort
// over capability): at 1.45 m/s the far side of an 8 km world is unreachable
// inside a session, and the menu's layer rows are only worth pressing from
// somewhere specific. `want && !renderer.xr.isPresenting` is the line that
// takes it away again. Every path into flight goes through here so the menu's
// `fly` row is never showing the wrong state.
function setFlying(want) {
  player.setFlying(want)
  refreshQuestRow('fly')
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

// The room's clock lives on the relay, so a skip is a request: everyone in the
// room, this client included, moves when the next snapshot carries the new
// count. With no relay to ask, the skip lands here directly.
function skipTime() {
  if (netplay.sendSkip(CLOCK.skipHours)) {
    console.log(`[clock] +${CLOCK.skipHours}h requested of room "${room}"`)
    return
  }
  clock.skip(CLOCK.skipHours)
  console.log(`[clock] +${CLOCK.skipHours}h -> ${clock.clockText}  sun ${clock.sun.elevDeg.toFixed(1)}deg`)
}

// The debug hold on the weather: live, then each preset in turn, then live.
const WEATHER_CYCLE = [null, ...Object.keys(WEATHER.presets)]
const weatherLabel = () => (clock.weather === null ? `live ${(clock.state().cover * 100).toFixed(0)}%` : WEATHER_CYCLE.find((k) => k !== null && WEATHER.presets[k] === clock.weather) ?? `${clock.weather}`)
function cycleWeather() {
  const at = clock.weather === null ? 0 : WEATHER_CYCLE.findIndex((k) => k !== null && WEATHER.presets[k] === clock.weather)
  const next = WEATHER_CYCLE[(at + 1) % WEATHER_CYCLE.length]
  clock.weather = next === null ? null : WEATHER.presets[next]
  console.log(`[weather] ${weatherLabel()}`)
}

function cycleAurora() {
  const i = aurora.cyclePattern()
  console.log(`[aurora] ${aurora.label}${aurora.blurb ? `  --  ${aurora.blurb}` : ''}`, i)
}

function cycleAuroraInterval() {
  console.log(`[aurora] map every ${aurora.cycleInterval()}s`)
}

/**
 * Step a cycle from wherever the layer currently sits. A value that is not on
 * the list lands on the list's head, so the row always goes somewhere sensible
 * rather than nowhere.
 */
function stepCycle(list, now) {
  const i = list.findIndex((v) => Math.abs(v - now) < 1e-6)
  return i < 0 ? list[0] : list[(i + 1) % list.length]
}

// --- the tree knobs, and WHY THERE ARE THREE OF THEM -------------------------
//
// The forest's per-frame bill has two halves that the shipped numbers move
// together, and these rows exist to pull them apart on the headset:
//
//   REACH moves BOTH. Resident tiles go as the radius SQUARED -- 1500 m is
//   ~11,300 of them, walked in eight phase buckets and only once the camera has
//   moved since the bucket's last walk (trees.js, STILL_M) -- while INSTANCES
//   go as the radius linearly, because of the graded thinning. Halving the
//   reach quarters the tile walk and halves the billboards.
//
//   FALLOFF moves only the instances. The tile set is identical at every
//   exponent; what changes is how many trees each far tile keeps. ^3 cuts the
//   far field by roughly 94% and leaves the walk exactly where it was.
//
// So falloff pressed ALONE is the measurement: if the headset recovers at a
// fixed 1500 m reach, the bill is instances, which is the GPU; if it barely
// moves and only reach helps, the bill is the per-tile CPU walk.
//
// Both regrow the whole scatter and cost a hitch on the frame they are pressed,
// but NEITHER rebuilds the bank, the impostor bake, the material or the arena --
// so unlike the grass rows these keep the panel's cull and visibility flags,
// because the meshes are the same objects afterwards. See Trees.setScatter.
//
//   MESH moves NEITHER, and it is the only row that trades quality for cost
//   rather than lushness for cost. It moves where a tree stops being a MESH and
//   becomes one flat spun card, which is the only remaining boundary in the
//   ladder and the one place a Quest wearer can catch the forest being made of
//   pictures -- stereo resolves about 1.3 m of depth at 24 m against a crown 3
//   to 6 m deep. Outward costs ~380 triangles a tree over an area growing as the
//   square; inward is nearly free and is how you find out whether 24 m was ever
//   needed. `off` puts the band at LOD0's edge, which empties the arena's four
//   LOD1 meshes -- and three.js skips an instanced draw of zero, so `off` is
//   genuinely four fewer calls per eye.
//
// Only this row re-tiers in place; there is no regrow behind it. See
// Trees.setMeshBand.
const TREE_RADIUS_CYCLE = [1500, 1000, 750, 400]
const TREE_FALLOFF_CYCLE = [1, 1.5, 2, 3]
// Shipped, then out to the ceiling the meshes were sized for, then down to
// LOD_BANDS[0], which is the tier's inner edge and therefore `off`.
// Where LOD1 hands over to the billboard. The list runs INWARD from where the
// forest ships, ending on the 8 m LOD0 edge -- a band with no width, which is
// LOD1 switched off and four fewer draw calls per eye. See Trees.setMeshBand.
// The outward rungs are gone: MESH_BAND_MAX still allows 45 m, but what this row
// is being read for is what the middle tier COSTS, and that is measured by
// taking it away.
const TREE_MESH_CYCLE = [24, 16, 8]

const meshBandLabel = (b) => (b <= TREE_MESH_CYCLE[TREE_MESH_CYCLE.length - 1] ? `${b} m off` : `${b} m`)

function cycleTreeMesh() {
  if (!trees) return
  trees.setMeshBand(stepCycle(TREE_MESH_CYCLE, trees.lodBands[1]))
  console.log(`[v2] tree LOD1 band: ${meshBandLabel(trees.lodBands[1])}`)
}

function cycleTreeRadius() {
  setTreeScatter({ radius: stepCycle(TREE_RADIUS_CYCLE, trees ? trees.radius : NaN) })
}

function cycleTreeFalloff() {
  setTreeScatter({ falloff: stepCycle(TREE_FALLOFF_CYCLE, trees ? trees.falloff : NaN) })
}

function setTreeScatter(patch) {
  if (!trees) return
  player.headPosition(headTmp)
  trees.setScatter(headTmp.x, headTmp.z, patch)
  const ts = trees.stats
  console.log(
    `[v2] trees regrown: ${ts.placed} over ${ts.tiles} tiles in ${ts.placeMs.toFixed(0)} ms ` +
    `(${ts.density}/m^2 to ${ts.fullRadius} m, thinning ^${ts.falloff} to ${ts.radius.toFixed(0)} m, ` +
    `pool ${ts.used}/${ts.pool})`
  )
}

addEventListener('keydown', (e) => {
  if (!ready || typing(e)) return

  // Tab opens and closes the menu, the keyboard twin of B / Y. On a desktop
  // there is no controller to press, so without this the menu is unreachable.
  // Not Escape: the browser takes that key to free a captured mouse and the
  // page never sees it, so a menu on Escape could not be opened while looking
  // around.
  if (e.code === 'Tab') {
    e.preventDefault()
    toggleQuestPanel()
    return
  }

  // Backquote arms and disarms the editor. A dedicated key rather than a mode
  // that is always on, because an armed lake tool turns every stray click on
  // the ground into a lake -- and because G/R/S mean two different things
  // depending on this flag (see the key-conflict note in editor.js).
  if (e.code === 'Backquote') {
    e.preventDefault()
    if (editor && panel) {
      editor.setActive(!editor.active)
      panel.syncSelection()
      // An armed editor wants the cursor, for its handles and its context menu.
      if (editor.active) freeMouse()
    }
    return
  }

  // THE EDITOR GETS FIRST REFUSAL, and it reports whether it took the key.
  // Anything it consumed must not also move the player: `S` is walk-backward
  // here and scale-mode in Blender, and editor.js resolves that by consuming
  // G/R/S only while a gizmo is attached. Acting on a consumed key anyway would
  // walk her backwards through the object she is scaling.
  if (editor && editor.onKeyDown(e)) return

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
  if (fresh.includes('grab') && hands && hands.press('desk', handsHead()) === 'pick') playPick()
  if (fresh.includes('stow') && hands) hands.stowPress('desk')
  if (fresh.includes('flareColor') && hands && holdsGun('desk')) cycleFlareColor('desk')
  if (fresh.includes('auroraPattern')) cycleAurora()
  if (fresh.includes('weather')) cycleWeather()
  // M cycles the three grass beds in place, under the player's feet, so they can
  // be judged against the same hillside in the same light. Rebuilding a bed is
  // ~100 ms of one frame; a swap is not something a player does.
  if (fresh.includes('grassStyle')) {
    player.headPosition(headTmp)
    if (grass) {
      const next = GRASS_STYLES[(GRASS_STYLES.indexOf(grassStyle) + 1) % GRASS_STYLES.length]
      buildGrass(next, headTmp.x, headTmp.z)
    }
  }
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
// A held POINTER is the same failure with a worse ending: no pointerup arrives
// either, and a brush stroke left open keeps digging at 60 Hz for as long as the
// tab is away.
addEventListener('blur', () => {
  held.clear()
  if (ready && editor) editor.onBlur()
})

// THE LAST LINE OF DEFENCE FOR AN UNSAVED SCULPT, and it is here because it was
// once needed and absent. The document is autosaved to localStorage on every
// commit, so a reload costs it nothing; the heightmap has no such tier -- it is
// a Float32Array in this tab and, until Save reaches the dev server, nowhere
// else at all. Cmd-R on that state is silent, instant and total. Returning a
// string makes the browser ask first, which is the whole point.
addEventListener('beforeunload', (e) => {
  if (!ready || !editor || !editor.sculptor.dirty) return
  e.preventDefault()
  e.returnValue = 'The terrain you sculpted has not been saved and will be lost.'
  return e.returnValue
})

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!ready) return
  // Left button only, now that the right one opens the editor's context menu:
  // otherwise a right-click also spins the camera out from under the menu it
  // just opened.
  dragging = e.button === 0 && !orbitLocked
  if (editor) editor.onPointerDown(e)
})
// A click on the world captures the mouse; not with the menu up or the editor
// armed, which want the cursor. ON CLICK, NOT POINTERDOWN: the lock is taken
// the moment it is asked for, and TransformControls' own pointerdown listener,
// which runs after this one on the same press, then throws out of
// setPointerCapture -- pointer lock and pointer capture exclude each other.
renderer.domElement.addEventListener('click', (e) => {
  if (!ready || e.button !== 0) return
  if (!(questPanelGroup && questPanelGroup.visible) && !(editor && editor.active)) captureMouse()
})
// Right-click on a handle. The editor decides WHAT can be done to the thing
// under the cursor and hands back closures; the panel draws them. The browser's
// own menu is suppressed only when the editor is armed and actually answered --
// on a right-click over empty ground in walk mode you still get the browser's.
renderer.domElement.addEventListener('contextmenu', (e) => {
  if (!ready || !editor || !editor.active) return
  const items = editor.menuFor(e)
  if (items.length === 0) return
  e.preventDefault()
  panel.showMenu(e.clientX, e.clientY, items)
})
addEventListener('pointerup', (e) => {
  dragging = false
  if (ready && editor) editor.onPointerUp(e)
})
addEventListener('pointermove', (e) => {
  if (!ready) return
  // Always forwarded, drag or not: the editor tracks the pointer for its ground
  // readout and for the placement preview, both of which have to follow the
  // cursor while nothing is pressed.
  if (editor) editor.onPointerMove(e)
  // And the host keeps its own copy for the panel's range readout. The editor
  // already tracks this, but only while it is ARMED -- the readout is wanted in
  // walk mode too, which is most of when anyone is looking at the panel. Two
  // floats and no work: the march happens at the panel's 4 Hz, not here.
  const ndc = pointerNdc(e, renderer.domElement)
  cursorNdc.x = ndc.x
  cursorNdc.y = ndc.y
  cursorNdc.seen = true
  if (!(dragging || mouseCaptured()) || orbitLocked || renderer.xr.isPresenting) return
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

/** How much of a day it is, 0 to 1: the world's one scalar for "is it night" (clock.js daynessOfElev), read by the caustics, the ambience and the animals that settle after dark. */
const daynessOf = (state) => daynessOfElev(state.sun.elevDeg)
// Last frame's, for the layers that are stepped before the clock is read. It moves over minutes; a frame of lag is not a thing that can be seen.
let dayness = 1

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

  lighting.update(state)

  setSRGB(scene.fog.color, state.fog)
  // hazeDensity, NOT fogDensity, and that is what makes v2's distance read as
  // aerial perspective rather than as a wash. The FogExp2 density is the
  // EXTINCTION coefficient of lighting.js's two-term aerial model -- how fast a
  // surface stops being its own colour -- and `scene.fog.color` is only the far
  // end of the ramp it lands on; the near end rides in a uniform of its own.
  // See the note on the pair in clock.js for why the two densities cannot be
  // one number, and note that this is the scene's OWN fog object, so v1 keeps
  // fogDensity and is not touched. It also reaches the lake for free: water.js
  // reads the same fogDensity, so v2's water and v2's land recede at one rate.
  scene.fog.density = state.hazeDensity
  setSRGB(tmpCol, state.fog)
  scene.background.copy(tmpCol)

  sky.update(head, state)
  stars.update(head, state, clock.elapsed, elapsedReal)
  if (questToggles.aurora) aurora.update(head, state, elapsedReal)
  if (questToggles.water) water.update(elapsedReal, hemi)
  // Returns at once until the eye has moved LOD_STEP or the terrain's render set changed; the rivers' distance ladder and the terrain rung under each are read per ten metres walked or per re-split, not per frame.
  if (waterSurfaces !== null) waterSurfaces.updateLod(head.x, head.z, terrain)

  // LAST, and that is the whole of its plumbing. Everything above writes the
  // world as seen through air, straight from the palette; this overwrites the
  // half-dozen values that are not true underwater. Being the later writer
  // rather than a branch inside each of them is what keeps it to one function:
  // there is no mode for anything above to know about, no flag to leave set,
  // and surfacing is simply the frame where it stops overwriting.
  applySubmersion(head, elapsedReal, state)
  // The same later writer for the inside of a boulder, and the murk wins under its lake.
  if (currentRoom.village && !submerged) sinkCave()
}

// --- underwater (§11) --------------------------------------------------------
//
// The extinction coefficient for UNDERWATER.visibility, computed once here
// rather than per frame -- it is a constant of a constant.
const MURK_DENSITY = murkDensity(UNDERWATER.visibility)

/**
 * True while her head is under a water surface. Read by the panel; the rest of
 * the effect is uniforms.
 */
let submerged = false
// The two numbers the submersion rule compares, held for the panel. Not state
// anything reads back -- a readout, and the only one there is for a decision
// taken every frame inside a headset where a console is no use.
let eyeY = 0
let waterY = null

// Whether the ground is currently being drawn with the caustic-carrying build of
// the plain rung (plainTerrainRung). ARMED IS NOT SUBMERGED and is deliberately
// the wider question: a program is compiled the first time it is drawn with, so
// arming on submersion exactly would put that compile on the frame her head goes
// under, which is a stall in the middle of the one moment this effect exists for.
// Armed at the waterline instead, she pays it while wading, where a hitch is a
// hitch in walking rather than in the dive -- and the net itself is still off,
// because the gain uniform below is what decides that.
let causticsArmed = false
// How far ABOVE the local water surface her head can be and still have the wet
// build on the mesh. One stride of headroom: enough that stepping into a lake
// arms it well before her head goes under, and not so much that swimming over a
// lake in fly mode does.
const CAUSTIC_ARM_M = 3

// THE CURRENT. `swayApplied` is the offset currently sitting in her rig
// position, and it is the whole of the bookkeeping: every frame the DIFFERENCE
// between where the current wants her and where it last put her is added, so
// her displacement from her own path is always exactly currentDrift's answer
// and never an integral of it. Adding the drift itself each frame would walk
// her out of the world in about a minute.
const swayApplied = new THREE.Vector3()
const swayWant = new THREE.Vector3()
let swayStrength = 0

/**
 * Everything that changes when her head goes under, and it is deliberately all
 * in one place and all on the JS side.
 *
 * WHY THIS IS NOT A POST-PROCESS. The obvious way to tint and darken a whole
 * scene is a full-screen pass, and this project has no composer -- deliberately
 * (§5). It would also not survive the headset: three's post-processing renders
 * to its own framebuffer rather than the XR layer, so the effect would exist on
 * the desktop canvas and be missing in VR, which is the one place this world is
 * actually looked at (§17). What is used instead is the aerial-perspective
 * chunk lighting.js already patches into every material in the scene -- the
 * same tint, applied per surface at no cost at all, and identical in both eyes
 * because it is not a screen-space effect in the first place.
 */
function applySubmersion(head, elapsedReal, state) {
  // `drawn`, because the question here is not the scatter's. The scatter asks
  // where the ground is wet and wants the authored footprint; the eye asks
  // whether it is under the POLYGON, and a river's polygon is widened past its
  // footprint to bury its edge under the bank. Same 3x3 block and same scan
  // either way -- the cost that made levelAt careful was one call per scatter
  // candidate, and this is one call a frame.
  let level = waterSurfaces === null ? null : waterSurfaces.levelAt(head.x, head.z, true)
  // A lake is DRAWN water.lap over its level this frame (the vertex stage's
  // lap) and a river is not; the eye is under what is drawn, so a lake wins
  // here where its risen plane stands over the river's.
  const lake = waterSurfaces === null ? null : waterSurfaces.lakeLevelAt(head.x, head.z)
  if (lake !== null && (level === null || lake + water.lap > level)) level = lake + water.lap
  // Aboard, her eye is over the lid whatever the level says, and the bilge is dry.
  submerged = level !== null && head.y < level && !(boats && boats.aboard)
  // Kept for the panel, which is the only way to see the two numbers this rule
  // compares from inside a headset. This y is exactly where the surface is
  // drawn this frame, so eye and level meeting anywhere other than at the
  // visible waterline is a disagreement worth reading off rather than
  // guessing at.
  eyeY = head.y
  waterY = level

  water.setSubmerged(submerged)

  // THE RUNG SWAP, which is what gives the ground a net at all: the stipple
  // rung is patched in vertex mode and only its wet build emits CAUSTIC_APPLY.
  // Done on the TRANSITION and not every frame.
  //
  // No null guard on `terrain`: waterSurfaces is built after it, so a non-null
  // `level` means the ground is on screen.
  const arm = level !== null && head.y < level + CAUSTIC_ARM_M
  if (arm !== causticsArmed) {
    causticsArmed = arm
    applyTerrainShader()
  }

  // THE CAUSTICS, and they are set on both paths rather than only the wet one.
  // A gain of zero is the off switch, so writing it every frame is what makes
  // this the same kind of later-writer setAir is -- there is no state to leave
  // behind and surfacing cannot strand a net on a dry hillside. `level` and not
  // `head.y`: the shader is asking how much water stands over the GROUND it is
  // shading, which does not change when she swims up.
  const causticGain = UNDERWATER.caustic * (UNDERWATER.causticNight + (1 - UNDERWATER.causticNight) * daynessOf(state))
  lighting.setCaustic(
    submerged ? causticGain : 0,
    UNDERWATER.causticScale,
    level === null ? 0 : level,
    UNDERWATER.causticFade,
    // Wrapped at the props' 1024 s for the props' reason: a seconds-since-load
    // float run through a noise hash loses its low bits inside an hour, and the
    // net stops moving without ever stopping.
    elapsedReal % 1024
  )

  if (!submerged) {
    // Nothing to restore but the dome, and only the dome because it is the one
    // of the three that does not decide its own visibility every frame.
    sky.mesh.visible = true
    return
  }

  sinkAir()
}

// --- the ambient sound -------------------------------------------------------
// The world's half lives in audio/; this is only what main.js knows and hands
// over each frame: where her ears are and which way they face, the hour, and
// whether she is under. Runs after applySky so `submerged` is this frame's.
const earFwd = new THREE.Vector3()
const earUp = new THREE.Vector3()
const earQuat = new THREE.Quaternion()
function updateAmbience(dt, state) {
  if (!ambience) return
  camera.getWorldDirection(earFwd)
  camera.getWorldQuaternion(earQuat)
  earUp.set(0, 1, 0).applyQuaternion(earQuat)
  sound.setListener(headTmp.x, headTmp.y, headTmp.z, earFwd.x, earFwd.y, earFwd.z, earUp.x, earUp.y, earUp.z)
  ambience.update(dt, {
    head: headTmp,
    // The room's clock, last frame's reading, as every creature layer takes it: the dragons' roars are scored against it (sim/score.js), so two headsets in the room hear the one roar.
    now: clock.seconds,
    dayness: daynessOf(state),
    submerged,
    // In her own metres, so a walk at half size is still a walk to the footstep rule.
    speed: player.speed / player.scale,
    afoot: !player.flying && !player.travel,
    cover: state.cover,
    precip: state.precip,
  })
}

// Browsers keep an AudioContext suspended until a user gesture on the page;
// every gesture the world already listens for is one, and the resume is
// idempotent. Entering VR is not always one: A-Frame offers the session to the
// headset's own toolbar button (offerSession), so the resume at sessionstart
// can be refused and the first gesture the page ever sees is a trigger pull.
// A WebXR select is a user activation, so the session's own events unlock too.
function unlockSound() {
  if (sound) sound.unlock()
}
for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) addEventListener(ev, unlockSound, { passive: true })
renderer.xr.addEventListener('sessionstart', () => {
  unlockSound()
  const session = renderer.xr.getSession()
  for (const ev of ['selectstart', 'select', 'squeezestart', 'squeeze']) session.addEventListener(ev, unlockSound)
})

/**
 * The half-dozen values that are not true underwater, written over the top of
 * the ones applySky has already set from the palette.
 *
 * SEPARATE FROM applySubmersion because it is called twice on a frame where the
 * world capture runs -- once at the end of the frame's submersion pass, and
 * again by the probe's air hook to sink the atmosphere back after the capture
 * has borrowed the air. Two callers, one implementation; a second copy of these
 * six lines would be a second place for a knob to be forgotten.
 *
 * NOT IDEMPOTENT, and it cannot be: the light lines are multiplicative, because
 * what they are dimming is the palette's own answer for this hour rather than
 * any fixed number. Calling it twice in a row dims twice. Every caller must put
 * liftAir() between two calls, which is exactly what the hook does.
 */
function sinkAir() {
  // THE FOG, and it reaches everything. scene.fog.density is the extinction
  // coefficient of lighting.js's aerial model, so one number here is what puts
  // the 20 m ceiling on terrain, trees, rocks, grass, litter, mushrooms and
  // buildings at once. The water's own fog term reads the same fogDensity, so
  // a lake surface across the way recedes at exactly the rate the land does --
  // which is the arrangement §11 already went to some trouble to arrive at in
  // air, kept rather than special-cased.
  scene.fog.density = MURK_DENSITY
  lighting.setAir(murkAir)

  // What the frame is cleared to, for the pixels no geometry covers. Without
  // it those come out the palette's horizon colour and read as bright gaps
  // torn in the murk, which is worse than any amount of wrong blue.
  scene.background.copy(murkLinear)

  // THE LIGHTS. The fog above handles anything more than a couple of metres
  // out; this is what stops her own hands, the lake bed under her and the
  // boulder she is standing beside being lit as though the water were not
  // there. Colours are lerped as well as intensities scaled, because water
  // takes red out of what passes through it -- turning white light down gives
  // grey water rather than blue-gray.
  sun.intensity *= UNDERWATER.light
  hemi.intensity *= UNDERWATER.ambient
  sun.color.lerp(murkLinear, UNDERWATER.tint)
  hemi.color.lerp(murkLinear, UNDERWATER.tint)
  hemi.groundColor.lerp(murkLinear, UNDERWATER.tint)

  // THE SKY, THE STARS AND THE AURORA, none of which are seen directly from
  // down here. The dome carries fog: false -- correctly, since it IS the
  // distance -- so it is the one thing in the scene the murk cannot reach, and
  // left drawing it would ring every lake with bright sky exactly where the
  // surface mesh runs out. The water shader is unaffected: it gets the sky from
  // uniforms and the aurora from the probe's cubemap, neither of which cares
  // whether the meshes are drawn.
  //
  // Asymmetric on purpose. The dome is restored above because nothing else
  // sets it; these two are not, because their own update() decides their
  // visibility from the hour every frame and forcing them true here would
  // hang stars in a midday sky.
  sky.mesh.visible = false
  stars.points.visible = false
  aurora.mesh.visible = false
}

/**
 * Inside a boulder (DESIGN.md §30): the overworld's hour, air and lights,
 * unchanged, and no sky, stars or aurora, since the shell closes over all of
 * them. A later writer like sinkAir, and it holds for the frame the same way.
 */
function sinkCave() {
  sky.mesh.visible = false
  stars.points.visible = false
  aurora.mesh.visible = false
}

/**
 * Air again, for the length of one world-probe face. The inverse of sinkAir --
 * and it is a real inverse rather than an undo, because every line here is the
 * same ABSOLUTE write applySky makes at the top of the frame, restated from the
 * same `state`. Nothing is subtracted, so nothing can drift.
 *
 * The dome, the stars and the aurora are not restored: the probe hides all
 * three for its own reasons before it calls this, and it puts them back itself.
 */
function liftAir(state) {
  sun.intensity = state.lightIntensity
  setSRGB(sun.color, state.lightColor)
  hemi.intensity = state.hemiIntensity
  setSRGB(hemi.color, state.hemiSky)
  setSRGB(hemi.groundColor, state.hemiGround)
  scene.fog.density = state.hazeDensity
  // Rewrites uAirNear and uAirFar from the palette, which is what undoes
  // setAir(murkAir) -- setAir is a later writer over exactly those two, with no
  // state of its own, so re-running the earlier writer IS the restore.
  lighting.update(state)
}

// The pair handed to the world probe around every face it captures. Two jobs,
// undone in reverse order: while she is under, the murk is lifted so the capture
// is taken in air; always, the aerial ramp's ends go to linear for the linear
// target (see WorldLighting.airToLinear), AFTER the lift, which rewrites them
// from the palette. Held at module scope with the frame's clock state in a slot
// rather than built per frame, so it allocates nothing.
const airHook = {
  state: null,
  enter: () => {
    if (submerged) liftAir(airHook.state)
    lighting.airToLinear()
  },
  leave: () => {
    lighting.airToOutput()
    if (submerged) sinkAir()
  },
}

// --- frame loop -------------------------------------------------------------

let last = performance.now()
let frames = 0
let acc = 0
let avgMs = 0

// A FIVE-SECOND WINDOW on the frame, in ten half-second buckets, because the
// question actually being asked of the FPS number in a headset is "is this
// stable", and that is a question about the window rather than the frame. Three
// numbers answer it and one does not: the 30-frame reading swings with whatever
// the head is pointed at, the five-second mean says where it sits, and the
// WORST frame in those five seconds says whether the mean is honest -- a 70 fps
// average with one 40 ms frame in fifty is a stutter you can feel and a mean
// that will not show you.
//
// Buckets rather than a ring of frame times so the cost is ten adds a frame at
// any refresh rate, and so a bucket that ages out takes its whole contribution
// with it instead of decaying forever the way an EMA would.
const FPS_BUCKET_MS = 500
const FPS_BUCKETS = 10
const fpsSum = new Float64Array(FPS_BUCKETS)
const fpsCount = new Int32Array(FPS_BUCKETS)
const fpsWorst = new Float64Array(FPS_BUCKETS)
let fpsBucket = 0
let fpsBucketAt = last
let avgMs5 = 0
let worstMs5 = 0
let lastPanelAt = 0
let shownError = ''
// The main render's counts, copied out in tock() the moment it finishes.
// renderer.info resets at the START of every renderer.render(), and the skymap
// (at night) and both probes each render before the frame's real pass -- so
// read live from tick(), info holds whichever pass ran last: the aurora's one
// quad, 2 tris and 1 call. Both stats panels read this copy instead.
const mainRender = { triangles: 0, calls: 0 }
const moveInput = { move: 0, strafe: 0, lift: 0, turn: 0, unstick: false, instant: false, flyDirection: null }
const headTmp = new THREE.Vector3()
// The things in her hands this frame, as the creature layers read them (hands.js lures).
const lures = []
// The peers' heads this frame, `{ x, y, z, foot, by }` with `by` the peer's client id, as the snowmen read them (render/snowmen.js) and the spiders flee them (render/spiders.js): a pool, so a frame allocates nothing. `foot` is where that peer says its feet are, and is NaN for a peer that sends no foot -- one whose body is known by its head alone.
const peerHeads = []
const peerHeadPool = []
function peerHeadsNow() {
  peerHeads.length = 0
  for (const peer of netplay.peers.values()) {
    if (!(peer.alpha > 0)) continue
    const h = peerHeadPool[peerHeads.length] ?? (peerHeadPool[peerHeads.length] = { x: 0, y: 0, z: 0, foot: NaN, by: null })
    h.x = peer.pose[0]; h.y = peer.pose[1]; h.z = peer.pose[2]; h.by = peer.id
    h.foot = Number.isFinite(peer.foot) ? peer.foot : NaN
    peerHeads.push(h)
  }
  return peerHeads
}

// ---------------------------------------------------------------------------
// VR LOCOMOTION. The binding, in one place, because a control scheme spread
// across a switch statement is a control scheme nobody can read back.
//
// THE TWO CONTROLLERS ARE MIRRORED. Every binding below is on BOTH hands and
// means the same thing on both, so the world is fully playable one-handed --
// which is how it actually gets played. The previous scheme split locomotion
// across the hands (left stick walked, right stick turned and teleported) and
// that is unplayable with one controller down, for no benefit: there is nothing
// a walk needs that a turn cannot share a stick with.
//
//   either stick  Y   walk, forward and BACK -- or aim/fire a teleport when the
//                     panel's `move` row says teleport. While flying, throttle.
//   either stick  X   snap turn
//   either stick  click   recentre
//   B / Y             recall the toggle panel to where you are standing
//   A / X             the next flare colour, on a hand holding the flare gun
//   grips             drop what that hand holds, anywhere -- the trigger fires a
//                     held flare gun, so this is how one is let go
//
// A grip is the button a hand presses by accident just holding a controller, so
// it carries only a drop, which costs a stoop to undo; nothing that moves the
// sky or the player belongs on it. There is no one-press fly: it would make the
// far side of the map a snap of the fingers. Flight in the headset lives on the
// debug view's `fly` row, reached by opening the menu on purpose. Flying still
// steers off whichever HAND is pushing its stick, wherever that hand points. A
// desktop keeps space / shift for previewing.
//
// AXIS DOMINANCE, not a per-hand split, is what stops a walk from turning you.
// Each stick contributes to move only while |y| > |x| and to turn only while
// |x| > |y|; a thumb pushed forward-ish walks and does not snap-turn, and the
// two hands can never fight because whichever is pushed further wins.
//
// Walking is 1.45 m/s across an 8 km world, which is why fly and teleport are
// not optional extras here: on foot the far side of the map is an hour away and
// every layer being profiled looks identical from one standing spot.
// ---------------------------------------------------------------------------

// Standard xr-standard gamepad mapping; same table as input.js, repeated here
// because the fallback below decodes a raw gamepad that Input never saw.
const QUEST_BTN = { TRIGGER: 0, GRIP: 1, STICK: 3, PRIMARY: 4, SECONDARY: 5 }
const questFallbackPrev = { left: {}, right: {} }

// Which path produced this frame's axes, shown on the panel. If locomotion is
// dead in the headset the FIRST thing to know is whether the sticks are being
// read at all, and there is no console in there to ask.
let questInputSource = 'none'

/**
 * Fill `input.state` from A-Frame's own controller entities.
 *
 * A SECOND ROUTE TO THE SAME GAMEPADS, not a second input scheme. Input polls
 * `renderer.xr.getSession().inputSources` directly; A-Frame's tracked-controls
 * holds the XRInputSource it matched to each hand entity. Those are normally
 * the same objects -- but this file does not own the session (A-Frame does),
 * and if the session this file's renderer reference exposes is ever not the one
 * A-Frame entered, the direct poll returns nothing and locomotion silently
 * dies with no error anywhere. The hand entities are visibly tracking in that
 * case, which is the confusing part, so the fallback reads from the same place
 * the visible hands do.
 */
function readQuestFallback(st) {
  let found = 0
  for (const [hand, el] of [['left', leftHandEl], ['right', rightHandEl]]) {
    const side = st[hand]
    const tracked = el?.components?.['tracked-controls-webxr'] ?? el?.components?.['tracked-controls']
    const gp = tracked?.controller?.gamepad
    if (!gp) {
      side.axes = [0, 0]
      continue
    }
    found++
    side.source = el
    side.axes = [gp.axes[2] ?? 0, gp.axes[3] ?? 0]
    const prev = questFallbackPrev[hand]
    for (const [name, idx] of Object.entries(QUEST_BTN)) {
      const pressed = !!gp.buttons[idx]?.pressed
      side.buttons[name] = { pressed, justPressed: pressed && !prev[name] }
      prev[name] = pressed
    }
  }
  st.connected = found
}

// Her head for the hands: where it is and the bearing it faces, the frame the
// backpack zone is judged in. One object, rewritten each call.
const handsHeadTmp = { x: 0, y: 0, z: 0, yaw: 0 }
// The desk hand's node under the camera: at rest while empty, and with a thing
// in it at the bottom-right corner of the view, drawn at its size up to
// DESK_HAND_MAX_M (a bigger thing is shrunk to that, hands.draw), far enough
// out that the drawn thing fits the frustum's height and set 0.35 s inside each
// edge so about a third of it hangs off screen. Drawn at its own size a 1.5 m
// fern sat 2.4 m out with its centre at the ground, and was never seen.
// Nothing in XR, where the grips are the hands.
function placeDeskHand() {
  if (sceneEl.is('vr-mode')) return
  const held = hands.holding('desk')
  if (held === null) { deskHand.position.set(DESK_HAND_REST.x, DESK_HAND_REST.y, DESK_HAND_REST.z); return }
  const k = herScale()
  hands.draw('desk', Math.min(1, DESK_HAND_MAX_M * k / held.size))
  // The node's metres are hers (the camera hangs under the scaled rig), so the drawn size is taken into them.
  const s = Math.min(held.size, DESK_HAND_MAX_M * k) / k
  const d = Math.max(0.45, 1.6 * s)
  const halfH = d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
  const halfW = halfH * camera.aspect
  deskHand.position.set(halfW - 0.35 * s, -(halfH - 0.35 * s), -d)
}

function handsHead() {
  player.headPosition(headTmp)
  handsHeadTmp.x = headTmp.x
  handsHeadTmp.y = headTmp.y
  handsHeadTmp.z = headTmp.z
  handsHeadTmp.yaw = player.headYaw()
  return handsHeadTmp
}

// A buzz on one controller, read from the same place the fallback reads the
// gamepad. A hand with no actuator -- the desktop's, or a Quest tracked without
// haptics -- is silent, which is not an error.
function questPulse(key, intensity, ms) {
  const el = key === 'left' ? leftHandEl : key === 'right' ? rightHandEl : null
  if (!el) return
  const tracked = el.components?.['tracked-controls-webxr'] ?? el.components?.['tracked-controls']
  const actuator = tracked?.controller?.gamepad?.hapticActuators?.[0]
  if (actuator) actuator.pulse(intensity, ms)
}

// Teleport. In the headset, armed by pushing a stick forward and fired on
// release -- the Quest system convention. On the desktop, hold T and release.
//
// THE AIM IS A LOB, NOT A RAY. The destination is where a ball thrown from the
// pointer at TELEPORT_LOB m/s along the pointer's direction lands under
// gravity, so it is always SHORT of a straight-line hit and never beyond it,
// and pointing higher reaches further only up to 45 degrees. Flat-ground reach
// from a hand at 1.3 m: ~3.3 m level, ~5.4 m at the best angle -- that is
// what LOB tunes, at reach ~ LOB^2 / g. All three are hers, at her full size:
// the lob, its gravity and the cap go by her scale (herScale), so the arc
// keeps its shape and its timing and lands half as far when she is half as tall.
//
// THE REACH CUTS THE FLIGHT SHORT, IT DOES NOT REFUSE IT. TELEPORT_RANGE caps
// the landing's horizontal distance from the rig -- on the flat the lob cannot
// carry that far anyway, but a lob down a cliff would otherwise carry as far
// as the cliff is tall -- and the cap is another thing the flight STOPS at,
// like the ground and a trunk: the arc ends at the reach and the ring drops to
// the ground under it. So no way of aiming can turn the arc red. Red is only
// ever the ground refusing her -- a slope past the limiter's, a trunk, a
// boulder her legs could not climb -- which is a thing she can see and aim off.
const QUEST_TELEPORT_ARM = 0.7
const QUEST_TELEPORT_FIRE = 0.35
const TELEPORT_LOB = 6.5
const TELEPORT_GRAVITY = 9.81
const TELEPORT_RANGE = 6
// THE COOLDOWN SHORTENS THE LOB, IT DOES NOT REFUSE IT. Without any cooldown
// the gesture repeats as fast as a stick can be flicked -- four or five 6 m
// jumps a second, 25-30 m/s, twenty times the walk -- and a hike stops being
// one. But a flat refusal makes the answer to "may I move?" no, which is the
// one answer locomotion should never give. So the wait caps the REACH instead:
// it grows from a notch to the whole of TELEPORT_RANGE over
// TELEPORT_COOLDOWN_S, a step every TELEPORT_GROW_S, and a release inside the
// wait always goes -- just not far. Held out through the wait, the arc visibly
// grows a notch at a time until it is full length.
//
// That caps her speed exactly as the refusal did, and by the same number,
// because the reach is PROPORTIONAL to the time waited: ten flicks a second
// carry 0.6 m each and one flick a second carries 6 m, and both are
// TELEPORT_RANGE / TELEPORT_COOLDOWN_S = 6 m/s, four times the walk. It is
// also the rate the peer bodies are paced to cross (avatar-rig.js
// MAX_TRAVEL_S), so a watcher's copy of her is never more than one jump behind.
const TELEPORT_COOLDOWN_S = 1
// The notch the reach grows by. Quantised rather than continuous so the growth
// reads as steps rather than as a creep, and floored at one notch so an
// instant re-flick has some arc to aim rather than a zero-length one.
const TELEPORT_GROW_S = 0.1
// Samples along the flight. 0.04 s at 6.5 m/s is a 26 cm segment, and the ground
// crossing is bisected between samples, so the landing is exact at that
// spacing. 40 samples is 1.6 s of flight, past which the lob is a fall.
const TELEPORT_STEP_S = 0.04
const TELEPORT_SAMPLES = 40
// A landing is refused where she could not have walked to: a slope past the
// limiter's, or inside a trunk. The arc turns TELEPORT_NO to say so, and it is
// the ONLY thing that turns it red. TELEPORT_WAIT is not a refusal: it says
// the cooldown still has the reach short of full, and a release on an orange
// arc goes.
const TELEPORT_OK = 0x7fd7ff
const TELEPORT_NO = 0xff5a5a
const TELEPORT_WAIT = 0xffb347
const TELEPORT_MAX_SLOPE = (LOCOMOTION.maxSlopeDeg * Math.PI) / 180
// How far the ring floats over the drawn ground. Enough that a chunk mesh
// sitting a little proud of the field does not swallow it, not so much that it
// reads as hovering.
const TELEPORT_RING_LIFT = 0.06
const TELEPORT_UP = new THREE.Vector3(0, 1, 0)
let questTeleportArmed = false
let desktopTeleportArmed = false
// performance.now() ms of the last landing; the reach grows from it. Set a
// whole cooldown in the past so the first lob of a session is full length.
let teleportFiredAt = -TELEPORT_COOLDOWN_S * 1000
const teleportTarget = { x: 0, z: 0, valid: false }
// The arc and the landing ring, built together on first aim. The arc is a
// dotted trail -- one instanced bead per sample -- rather than a Line, because
// WebGL draws every line one pixel wide and a 1 px line at half opacity
// vanishes into the ferns. Instance matrices are overwritten in place: no
// geometry is allocated while aiming. Both are depth-tested like anything else
// in the world: a bead behind a bank is behind the bank.
let teleportGfx = null
const teleportOrigin = new THREE.Vector3()
const teleportDir = new THREE.Vector3()
const teleportRight = new THREE.Vector3()
const teleportBead = new THREE.Matrix4()
const teleportNormal = new THREE.Vector3()
const teleportObstacle = { x: 0, z: 0, r: 0 }
const questFlyDir = new THREE.Vector3()

function ensureTeleportGfx() {
  if (teleportGfx) return teleportGfx
  // The ring lies in XZ in its own frame and is turned onto the ground's normal
  // where it lands, so on a slope it lies ALONG the slope instead of cutting
  // into the uphill side. The polygon offset pulls its depth a little toward
  // the eye, so a chunk drawn a few centimetres proud of the exact field does
  // not swallow it, while a hill actually in front still hides it.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.42, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: TELEPORT_OK, toneMapped: false, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    })
  )
  const arc = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.03, 6, 4),
    new THREE.MeshBasicMaterial({ color: TELEPORT_OK, toneMapped: false, transparent: true, opacity: 0.7, depthWrite: false }),
    TELEPORT_SAMPLES
  )
  arc.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  arc.frustumCulled = false
  scene.add(ring, arc)
  teleportGfx = { ring, arc }
  return teleportGfx
}

function hideTeleport() {
  teleportTarget.valid = false
  if (!teleportGfx) return
  teleportGfx.ring.visible = false
  teleportGfx.arc.visible = false
}

/**
 * How much of TELEPORT_RANGE the cooldown allows right now: 0 to 1, a notch
 * per TELEPORT_GROW_S since the last landing, never less than one notch.
 */
function teleportAllowance() {
  const waited = (performance.now() - teleportFiredAt) / 1000
  const notches = Math.max(TELEPORT_GROW_S, Math.floor(waited / TELEPORT_GROW_S) * TELEPORT_GROW_S)
  return Math.min(1, notches / TELEPORT_COOLDOWN_S)
}

/** Land the aimed teleport, and let the ambience count it as the walk it stands in for. */
function fireTeleport() {
  if (!teleportTarget.valid) return
  const dist = Math.hypot(teleportTarget.x - player.rig.position.x, teleportTarget.z - player.rig.position.z)
  player.teleportTo(teleportTarget.x, teleportTarget.z)
  portalBlink = true
  teleportFiredAt = performance.now()
  // The full range, not the allowance: the sound is how far this jump went against a whole one.
  if (ambience) ambience.onTeleport(dist, TELEPORT_RANGE * herScale())
}

/** After the step: the mouth her feet just entered, if any (PORTAL), and the village it opens on. */
function portalTest() {
  const blink = portalBlink
  portalBlink = false
  if (houseTest(blink) || indoors || !entrances) return
  const feet = player.originPosition()
  const sx = feet.x - portalFrom.x, sz = feet.z - portalFrom.z
  const step = Math.hypot(sx, sz)
  portalSites.length = 0
  entrances.sites(portalSites)
  let door = null
  for (const site of portalSites) {
    const d = Math.hypot(feet.x - site.holeX, feet.z - site.holeZ)
    if (d > PORTAL.reach) continue
    const walked = d <= PORTAL.walk && step > 0 && -(sx * site.nx + sz * site.nz) / step >= PORTAL.into
    if (walked || (blink && d <= PORTAL.blink)) { door = site; break }
  }
  if (door === portalIn) return
  portalIn = door
  if (!door || EDITOR_MODE) return
  // Out of a village, the mouth she came in by; into one, its own way out.
  const out = currentRoom.village
  const by = out ? cameInBy : { ...door }
  cameInBy = out ? null : by
  bootRoom(out ? ROOMS.overworld : ROOMS.leafkin, out ? by : null).catch(reportRuntimeError)
}

/**
 * Fly the lob from `origin` along `dir` (unit), write the arc, place the ring
 * where it meets the WALK surface -- the field plus the rock tops, the same
 * thing Player stands on, so the arc lands on a boulder rather than inside it
 * and lands in the same place whether or not the terrain layer is drawn. A
 * trunk in the way stops the arc at the bark with no landing.
 *
 * THREE THINGS STOP THE FLIGHT and they are asked as one question: the ground
 * under it, a trunk, and the reach the cooldown allows. Horizontal distance
 * from her grows monotonically along a lob, so the reach has exactly one
 * crossing and the same bisection finds it to the same precision as the
 * ground's. Stopped at the reach the arc is over open air, so the ring goes on
 * the ground below -- which is then asked the same slope and path questions as
 * any other landing, and may well refuse, since the ground under a lob cut
 * short over a cliff IS the cliff face.
 */
function aimTeleport(origin, dir) {
  const { ring, arc } = ensureTeleportGfx()
  const feet = player.originPosition()
  const k = herScale()
  const reach = TELEPORT_RANGE * k * teleportAllowance()
  const vx = dir.x * TELEPORT_LOB * k
  const vy = dir.y * TELEPORT_LOB * k
  const vz = dir.z * TELEPORT_LOB * k
  const gravity = TELEPORT_GRAVITY * k
  const at = (t) => ({ x: origin.x + vx * t, y: origin.y + vy * t - 0.5 * gravity * t * t, z: origin.z + vz * t })
  const clear = (t) => {
    const p = at(t)
    return p.y > walk.heightAt(p.x, p.z) && !walk.obstacleAt(p.x, p.z, teleportObstacle) &&
      Math.hypot(p.x - feet.x, p.z - feet.z) <= reach
  }
  let count = 0
  let hit = null
  let stopped = false
  let prevT = 0
  for (let i = 0; i < TELEPORT_SAMPLES; i++) {
    const t = i * TELEPORT_STEP_S
    const p = at(t)
    if (i > 0 && !clear(t)) {
      let lo = prevT
      let hi = t
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) * 0.5
        if (clear(mid)) lo = mid
        else hi = mid
      }
      const end = at(hi)
      stopped = true
      if (walk.obstacleAt(end.x, end.z, teleportObstacle)) {
        // Bark: the last bead sits on the trunk, nothing to land on.
        p.x = end.x
        p.y = end.y
        p.z = end.z
      } else {
        hit = { x: end.x, y: walk.heightAt(end.x, end.z), z: end.z }
        // The last bead sits ON the ground, not a sample past it.
        p.x = hit.x
        p.y = hit.y
        p.z = hit.z
      }
    }
    arc.setMatrixAt(count++, teleportBead.makeScale(k, k, k).setPosition(p.x, p.y, p.z))
    if (stopped) break
    prevT = t
  }
  arc.count = count
  arc.instanceMatrix.needsUpdate = true
  arc.visible = true
  // A landing counts only where she could have walked: on ground the slope
  // limiter would let her stand on (a cliff face or a boulder's flank is a step
  // in the walk surface, so it fails this), not inside a trunk, and with a
  // walkable straight line from her feet to it -- a lob clears a boulder or a
  // trunk that her legs would not. Reach is not asked here: the flight already
  // stopped at it, so every landing is one she may take. Orange says the
  // cooldown still has the arc short of full length, not that she may not go.
  const standable = hit !== null && walk.slopeAt(hit.x, hit.z) <= TELEPORT_MAX_SLOPE &&
    !walk.obstacleAt(hit.x, hit.z, teleportObstacle) && player.pathClear(feet.x, feet.z, hit.x, hit.z)
  teleportTarget.valid = standable
  const colour = !standable ? TELEPORT_NO : reach >= TELEPORT_RANGE * k ? TELEPORT_OK : TELEPORT_WAIT
  arc.material.color.setHex(colour)
  ring.material.color.setHex(colour)
  if (hit !== null) {
    teleportTarget.x = hit.x
    teleportTarget.z = hit.z
    // Over the DRAWN ground where a chunk exists, since that is what would hide
    // it; the walk height is the field, which the chunk mesh sits a few
    // centimetres either side of.
    const drawn = terrain.groundAt(hit.x, hit.z)
    const ground = drawn !== null && drawn > hit.y ? drawn : hit.y
    ring.position.set(hit.x, ground + TELEPORT_RING_LIFT * k, hit.z)
    ring.scale.setScalar(k)
    ring.quaternion.setFromUnitVectors(TELEPORT_UP, walk.normalAt(hit.x, hit.z, 0.35, teleportNormal))
  }
  ring.visible = hit !== null
}

/**
 * The pointer of the hand pushing the stick, taken from the SAME ray the menu's
 * pointer is drawn along. The hand entity itself sits at the XR gripSpace, whose
 * -Z is pitched well above where a Touch controller points; the ray is the
 * model's pointing pose, and the arc has to leave from where the wearer would
 * see the pointer. Aimed off the pushing hand rather than the gaze so that
 * looking around while holding the stick does not move the destination.
 */
function questTeleportAim(handEl) {
  const rc = handEl.components.raycaster
  if (!rc || typeof rc.updateOriginDirection !== 'function') {
    throw new Error(`teleport: ${handEl.id} has no raycaster component to aim along`)
  }
  rc.updateOriginDirection()
  aimTeleport(rc.raycaster.ray.origin, rc.raycaster.ray.direction)
}

/**
 * Desktop stand-in for the hand: the cursor's ray, thrown from a point a little
 * below and to the right of the eye so the arc reads as leaving a hand rather
 * than the face. With no cursor seen yet, straight ahead.
 */
function desktopTeleportAim() {
  camera.getWorldPosition(teleportOrigin)
  camera.getWorldQuaternion(questTempQuat)
  teleportRight.set(1, 0, 0).applyQuaternion(questTempQuat)
  teleportOrigin.addScaledVector(teleportRight, 0.2)
  teleportOrigin.y -= 0.35
  if (cursorNdc.seen) teleportDir.copy(screenRay(camera, cursorNdc.x, cursorNdc.y).dir)
  else teleportDir.set(0, 0, -1).applyQuaternion(questTempQuat)
  aimTeleport(teleportOrigin, teleportDir)
}

function readInput() {
  const st = input.update()
  questInputSource = st.connected > 0 ? 'xr' : 'none'
  // Only when the direct poll came up empty: when it works it is the shorter
  // path.
  if (st.connected === 0) {
    readQuestFallback(st)
    if (st.connected > 0) questInputSource = 'aframe'
  }
  if (st.connected > 0) {
    const lx = st.left.axes[0]
    const ly = st.left.axes[1]
    const rx = st.right.axes[0]
    const ry = st.right.axes[1]

    // Axis dominance, per stick, then the harder push wins between the hands.
    // See the banner: this is what lets both sticks carry both move and turn
    // without a sideways lean during a walk snap-turning her.
    const lMove = Math.abs(ly) > Math.abs(lx) ? ly : 0
    const rMove = Math.abs(ry) > Math.abs(rx) ? ry : 0
    const lTurn = Math.abs(lx) > Math.abs(ly) ? lx : 0
    const rTurn = Math.abs(rx) > Math.abs(ry) ? rx : 0
    // Which hand is driving. Also decides where fly and teleport point, so the
    // aim comes off the hand actually doing the pushing.
    const useRight = Math.abs(rMove) > Math.abs(lMove)
    const moveAxis = useRight ? rMove : lMove
    const moveHand = useRight ? rightGrip : leftGrip

    // Backwards used to be clamped away by a Math.max(0, ...). Reversing out of
    // a rock face is the single most-wanted move in a world with no strafe.
    moveInput.move = -moveAxis
    moveInput.strafe = 0 // no strafing in VR, on purpose
    moveInput.lift = 0
    moveInput.turn = Math.abs(rTurn) > Math.abs(lTurn) ? rTurn : lTurn
    // NO UNSTICK IN THE HEADSET. It had a panel row and it is gone: flight
    // reaches anywhere a wedged walker wants to be, and it does it without
    // teleporting her 80 m sideways with no explanation.
    moveInput.unstick = false
    moveInput.instant = false
    moveInput.flyDirection = null

    // Any button takes the menu's pointer for its hand, BEFORE the B / Y below
    // opens the menu, so it opens with the pointer on the hand that pressed.
    for (const [hand, el] of [['left', leftHandEl], ['right', rightHandEl]]) {
      if (Object.values(st[hand].buttons).some((b) => b.justPressed)) questPointerHand = el
    }

    // Mirrored; see the banner.
    if (st.left.buttons.SECONDARY?.justPressed || st.right.buttons.SECONDARY?.justPressed) toggleQuestPanel()
    if (st.left.buttons.STICK?.justPressed || st.right.buttons.STICK?.justPressed) player.recenterXR(renderer)
    if (hands) {
      for (const hand of ['left', 'right']) {
        if (st[hand].buttons.GRIP?.justPressed) hands.drop(hand, handsHead())
        if (st[hand].buttons.PRIMARY?.justPressed && holdsGun(hand)) cycleFlareColor(hand)
      }
    }

    if (player.flying) {
      moveHand.getWorldQuaternion(questTempQuat)
      questFlyDir.set(0, 0, -1).applyQuaternion(questTempQuat).normalize()
      moveInput.flyDirection = questFlyDir
      hideTeleport()
      questTeleportArmed = false
      return
    }

    if (!questToggles.teleport) return

    // Teleport: aim while held, go on release. Fired from readInput rather than
    // from a button event because the whole gesture is a stick threshold. Push
    // is the same forward push that walks in the other mode, so the panel row
    // swaps the meaning of one gesture rather than adding a second one.
    moveInput.move = 0
    const push = -moveAxis
    if (push > QUEST_TELEPORT_ARM) {
      questTeleportArmed = true
      questTeleportAim(useRight ? rightHandEl : leftHandEl)
    } else if (questTeleportArmed && push < QUEST_TELEPORT_FIRE) {
      questTeleportArmed = false
      fireTeleport()
      hideTeleport()
    }
    return
  }
  moveInput.move = (on('forward') ? 1 : 0) - (on('back') ? 1 : 0)
  moveInput.strafe = (on('right') ? 1 : 0) - (on('left') ? 1 : 0)
  moveInput.lift = (on('flyUp') ? 1 : 0) - (on('flyDown') ? 1 : 0)
  moveInput.instant = true
  moveInput.turn = (on('turnRight') ? 1 : 0) - (on('turnLeft') ? 1 : 0)
  // U only, and only here: unstick is a keyboard escape hatch now.
  moveInput.unstick = on('unstick')
  // Cleared explicitly: the VR branch above sets it, and a stale hand vector
  // left in place after the controllers drop out would steer desktop flight off
  // a quaternion nothing is updating any more.
  moveInput.flyDirection = null
  // T held aims the same lob the headset throws, off the cursor; release goes.
  // Not while flying, matching the headset, and the walk keys stay live so the
  // arc can be aimed by walking or dragging the view as well as by the mouse.
  if (on('teleport') && !player.flying) {
    desktopTeleportArmed = true
    desktopTeleportAim()
  } else if (desktopTeleportArmed) {
    desktopTeleportArmed = false
    fireTeleport()
    hideTeleport()
  }
}

// Where the mouse last was, in NDC. `seen` stays false until the pointer has
// actually moved over the canvas once, because (0,0) is the centre of the
// screen and defaulting to it would print a confident range to whatever the
// camera happens to be aimed at before anyone has pointed at anything.
const cursorNdc = { x: 0, y: 0, seen: false }

// The pick volumes, in metres at instance scale 1. See PickSource in pick.js:
// these are per-SPECIES capsules for naming things, not collision hulls, and
// they are sized to be easy to aim at rather than to be tight.
//
// The radii come from what the banks actually build -- a tree crown runs 3 to
// 6 m across, a fern about 1 m, a cap-and-stem mushroom 20 cm -- rounded toward
// the generous side. The rises are the drawn height of the tallest variant in
// each bank, so a capsule covers a trunk from root to crown rather than
// stopping at chest height, which is where a naive radius-only volume would
// leave everything above unnameable.
//
// Grass and litter are absent on purpose. Litter is centimetre-scale debris
// nobody is going to name, and grass is not a model with variants at all -- it
// is a strip texture, so there is no id to print.
// These are TEMPLATES: `bindCursorPicks` copies each one and fills in the
// scatter, because one label does not always mean one scatter to walk.
const CURSOR_PICKS = [
  { label: 'mushroom', idKey: 'variantAt', radius: 0.18, rise: 0.3 },
  { label: 'fern', idKey: 'variantAt', radius: 0.6, rise: 1.2 },
  { label: 'deadwood', idKey: 'variantAt', radius: 0.9, rise: 1.5 },
  { label: 'bones', idKey: 'variantAt', radius: 1.5, rise: 1.0 },
  // No radius/rise: a rock's pick volume is its own measured footprint and
  // height, which `RockBed.pickSizeAt` reads straight off the bank shape and
  // scales per instance. No `idKey` either -- there is one boulder in the world,
  // so there is no variant array to index; the bed's name is the readout.
  { label: 'rock' },
  // Nor here, and for a sharper version of the same reason: a tree is a thin
  // trunk under a wide crown, so it is TWO pick volumes and `bindCursorPicks`
  // expands this one entry into both. The constants that used to be here were a
  // 3 m radius column 26 m tall, which is the crown's width applied all the way
  // to the ground -- see `Trees.pickTrunkAt` for what that cost.
  { label: 'tree', idKey: 'variantAt' },
]

/**
 * The list `pickProp` actually walks, built by `bindCursorPicks`. It is not
 * `CURSOR_PICKS` because ROCKS ARE SIX SCATTERS AND NOT ONE: `Rocks` is a
 * facade over six `RockBed`s, and every array pickProp needs -- tiles, instX,
 * instScale -- lives on a bed. So the rock template expands into one bound
 * source per bed and the array is longer than the table above.
 */
let boundPicks = null

/** Filled once the scatters exist; nearest-first, so the cheap sources prune for the dear ones. */
function bindCursorPicks() {
  const bySys = { mushroom: mushrooms, fern: ferns, deadwood: deadwood, bones: bones, rock: rocks, tree: trees }
  boundPicks = []
  for (const p of CURSOR_PICKS) {
    const sys = bySys[p.label]
    if (!sys) {
      // Some presentation-only scatters have no pick source, so leave them out
      // of the cursor list as well.
      continue
    }
    if (p.label === 'rock') {
      // One source per BED. `Rocks` is a facade and owns none of the arrays
      // pickProp walks; the beds do. Binding the facade is what made rocks
      // unnameable, and pickProp now throws rather than skipping it in silence.
      //
      // Every rock in the world is the same boulder, so the only thing a readout
      // can usefully say is which BED put this one here -- which is the answer to
      // "why is that one 12 m across", the question actually being asked.
      for (const bed of rocks.beds) {
        boundPicks.push({
          ...p,
          sys: bed,
          nameAt: (s) => `boulder (${s.cfg.name})`,
          sizeAt: (s, id, out) => s.pickSizeAt(id, out),
        })
      }
      continue
    }
    if (p.label === 'tree') {
      // Two volumes, one prop. Both carry the same label and the same nameAt,
      // so whichever the ray enters first the readout says the same thing --
      // pickProp shares one `bestT` across sources, so the nearer of the two
      // wins exactly as if they were one shape.
      const nameAt = (s, id) => s.nameAt(id)
      boundPicks.push({ ...p, sys, nameAt, sizeAt: (s, id, out) => s.pickTrunkAt(id, out) })
      boundPicks.push({ ...p, sys, nameAt, sizeAt: (s, id, out) => s.pickCrownAt(id, out) })
      continue
    }
    // A generated prop's bank names its variants, so the readout says "stump" rather than "0".
    if (p.label === 'deadwood' || p.label === 'bones') {
      boundPicks.push({ ...p, sys, nameAt: (s, id) => s.bank.variants[s.variantAt[id]].name })
      continue
    }
    boundPicks.push({ ...p, sys })
  }
}

// What is under the cursor: the range to the ground, and the prop in front of
// it if there is one.
//
// THE RANGE IS GROUND, and only ground. The march in pick.js walks the height
// FIELD, which is the exact surface rather than whatever LOD the streamer has
// meshed there -- so the number does not jump when a chunk swaps tier, which is
// the whole reason the editor picks this way too. Raycasting the prop batches
// for a range instead would be both far more expensive at this rate and WRONG
// for the far tiers, whose cards are spun into place by a vertex shader that a
// CPU-side raycast knows nothing about.
//
// THE PROP IS A NAME, and only a name. pickProp walks the scatters' instance
// arrays against a cylinder or two per instance; it is there so that "that tree
// needs to be shorter" can be said as "tree oak-2 needs to be shorter", about a
// tree that can then be loaded in /gen-tree. The ground range is
// its ceiling, so a hill in front of a tree hides the tree, but nothing else
// occludes: point through a near trunk at a far rock and you get the trunk,
// which is the answer wanted anyway.
//
// Called at the panel's 4 Hz. One march is a few hundred heightAt calls at the
// step schedule in pick.js, which is the same order as one frame of scatter
// placement and a quarter-second apart; the prop pass is a few tens of
// thousands of multiply-adds on top.
const cursorOut = { dist: null, at: null, label: null, variant: null }
function cursorPick() {
  cursorOut.dist = null
  cursorOut.at = null
  cursorOut.label = null
  cursorOut.variant = null
  if (!cursorNdc.seen) return cursorOut

  const { origin, dir } = screenRay(camera, cursorNdc.x, cursorNdc.y)
  const hit = raymarchGround(height, origin, dir)
  if (hit) {
    cursorOut.dist = Math.hypot(hit.x - origin.x, hit.y - origin.y, hit.z - origin.z)
    // WHERE, not just how far. A range alone cannot be typed into a probe script
    // or compared against a heightmap sample, and every placement question this
    // panel gets pointed at ("why is there nothing HERE") is asked about a world
    // position. `raymarchGround` already has it; it was being thrown away.
    cursorOut.at = hit
  }

  // Infinity rather than the ground range when the ray reaches the horizon:
  // there is no hill to hide behind, so every prop along it is fair game.
  if (boundPicks === null) throw new Error('cursorPick ran before bindCursorPicks')
  const prop = pickProp(boundPicks, origin, dir, cursorOut.dist === null ? Infinity : cursorOut.dist)
  if (prop) {
    cursorOut.label = prop.label
    // The PRINTABLE id, not the raw index. For rocks it is the bed that placed
    // it; for trees `species-size`; for the scatters whose variant array indexes
    // their bank in order it is still the integer.
    cursorOut.variant = prop.name
  }
  return cursorOut
}

function panelStats() {
  const st = terrain.stats
  const h = height.heightAt(headTmp.x, headTmp.z)
  const cursor = cursorPick()
  return {
    fps: avgMs > 0 ? 1000 / avgMs : null,
    ms: avgMs,
    tris: mainRender.triangles,
    calls: mainRender.calls,
    // "resident" is chunks holding a geometry slot; "drawn" is the subset the
    // selection actually renders this frame. The gap between them IS the
    // streaming margin, so showing one without the other hides the thing worth
    // watching.
    resident: st.slots,
    drawn: st.rendered,
    terrainTris: st.drawnTris,
    queued: st.queued,
    triDeg: st.triDeg,
    // `tris` above is the whole frame as the GPU sees it; these three say how
    // much of it is the prop scatter, which is the layer currently being tuned.
    treeCount: trees ? trees.stats.placed : 0,
    treeTris: trees ? trees.stats.tris : 0,
    fernCount: ferns ? ferns.stats.placed : 0,
    fernTris: ferns ? ferns.stats.tris : 0,
    mushroomCount: mushrooms ? mushrooms.stats.placed : 0,
    mushroomTris: mushrooms ? mushrooms.stats.tris : 0,
    deadwoodCount: deadwood ? deadwood.stats.placed : 0,
    deadwoodTris: deadwood ? deadwood.stats.tris : 0,
    bonesCount: bones ? bones.stats.placed : 0,
    bonesTris: bones ? bones.stats.tris : 0,
    carrotCount: carrots ? carrots.stats.placed : 0,
    carrotTris: carrots ? carrots.stats.tris : 0,
    rowboatCount: rowboats ? rowboats.stats.placed : 0,
    rowboatTris: rowboats ? rowboats.stats.tris : 0,
    boatsLive: boats ? boats.stats.live : 0,
    boatSpeed: boats ? boats.stats.speed : 0,
    grassCount: grass ? grass.stats.placed : 0,
    grassHidden: grass ? grass.stats.rimHidden : 0,
    grassTris: grass ? grass.stats.tris : 0,
    rockCount: rocks ? rocks.stats.placed : 0,
    rockTris: rocks ? rocks.stats.tris : 0,
    litterCount: litter ? litter.stats.placed : 0,
    litterTris: litter ? litter.stats.tris : 0,
    x: headTmp.x,
    y: headTmp.y,
    z: headTmp.z,
    ground: h,
    // The chunk under HER, not the finest one on screen -- see the note on
    // cellUnderfoot in terrain-v2.js for why those are different readouts.
    cell: st.cellUnderfoot,
    cursorDist: cursor.dist,
    cursorLabel: cursor.label,
    cursorVariant: cursor.variant,
    snowHere: layers.snowLineAt(headTmp.x, headTmp.z),
    snowBase: layers.snow.base,
    // 'under' beats 'fly' and 'walk' because it is the one of the three that
    // is not obvious from the view -- once everything is murk, the readout is
    // how you tell "she is submerged" from "the shader broke".
    mode: editor && editor.active
      ? `edit:${editor.tool}`
      : submerged
        ? 'under'
        : player.flying
          ? 'fly'
          : 'walk',
    // Signed metres from the eye to the water over it: negative under, positive
    // above, null on dry ground. The one reading that says whether the murk
    // switches at the waterline or beside it, which is not a judgement the view
    // can be trusted for -- an eye a hand's breadth over a flat mirror looks a
    // great deal like an eye a hand's breadth under one.
    eyeToWater: waterY === null ? null : eyeY - waterY,
  }
}

function tick() {
  // A frame that threw once throws every frame, and A-Frame's tick loop has no
  // catch of its own -- so without this the overlay's first stack is replaced
  // sixty times a second by the same one. See reportRuntimeError.
  if (fatalError) return

  const now = performance.now()
  const raw = now - last
  last = now
  // Clamp dt so a tab-switch or a GC pause cannot teleport her across a valley.
  const dt = Math.min(0.1, raw / 1000)
  fadeStep(dt * 1000)

  acc += raw
  frames++
  if (frames >= 30) {
    avgMs = acc / frames
    frames = 0
    acc = 0
  }

  // Advance past EVERY bucket the gap covers, clearing each. Stepping only one
  // would let a session that was backgrounded for a minute carry five seconds of
  // stale frames back into the window; a gap longer than the whole window
  // empties it outright rather than spinning the loop a hundred times.
  if (now - fpsBucketAt >= FPS_BUCKET_MS * FPS_BUCKETS) {
    fpsSum.fill(0)
    fpsCount.fill(0)
    fpsWorst.fill(0)
    fpsBucketAt = now
  } else {
    while (now - fpsBucketAt >= FPS_BUCKET_MS) {
      fpsBucketAt += FPS_BUCKET_MS
      fpsBucket = (fpsBucket + 1) % FPS_BUCKETS
      fpsSum[fpsBucket] = 0
      fpsCount[fpsBucket] = 0
      fpsWorst[fpsBucket] = 0
    }
  }
  fpsSum[fpsBucket] += raw
  fpsCount[fpsBucket]++
  if (raw > fpsWorst[fpsBucket]) fpsWorst[fpsBucket] = raw
  let winMs = 0
  let winN = 0
  let winWorst = 0
  for (let i = 0; i < FPS_BUCKETS; i++) {
    winMs += fpsSum[i]
    winN += fpsCount[i]
    if (fpsWorst[i] > winWorst) winWorst = fpsWorst[i]
  }
  avgMs5 = winN > 0 ? winMs / winN : 0
  worstMs5 = winWorst

  if (!ready) return

  readInput()

  // THE CURRENT, applied BEFORE the mover rather than after it. Everything that
  // keeps her out of the ground and inside the world runs in player.update, and
  // a push added afterwards would be a push it never saw -- 70 cm is enough to
  // put her inside a bank. Added first, the drift is just somewhere she is, and
  // if the clamp refuses part of it the refusal is absorbed into her own path
  // instead of fighting the next frame's difference.
  //
  // `submerged` is last frame's answer, because applySubmersion runs later in
  // this one. A frame of lag on a 2.5 s ease is not a thing that can be seen.
  swayStrength = THREE.MathUtils.clamp(swayStrength + (submerged ? dt : -dt) / CURRENT.ease, 0, 1)
  currentDrift(now / 1000, swayStrength, swayWant)
  player.rig.position.x += swayWant.x - swayApplied.x
  player.rig.position.z += swayWant.z - swayApplied.z
  swayApplied.copy(swayWant)

  // The boats move before she does, so the one under her carries her and the
  // mover's step is then hers alone; where her feet came to rest in it is read after.
  if (boats) boats.update(dt, now)
  portalFrom.copy(player.originPosition())
  player.update(dt, moveInput)
  if (boats) boats.settle()
  portalTest()
  // A mouth she stepped into has just torn the room down under this frame.
  if (!ready) return

  updateQuestPanel()

  // The clock the prop LOD cross-dissolves run on, and the only per-frame cost
  // any of them has. Set BEFORE the scatters update, so the sweep that retires
  // finished fades and the shader that draws them read the same instant. It
  // wraps at 1024 s inside setPropClock -- see the packing note in material.js.
  setPropClock(now / 1000)
  // THE BLADE BED CARRIES ITS OWN CLOCK, and it is not uPropClock. Every other
  // wind material snaps its frequency to a whole number of cycles per 1024 s so
  // the wrap above is invisible (windFreq in material.js); a blade's rate is a
  // uniform the previewer slides, so that snap is unavailable to it and a
  // wrapped clock would step the whole meadow every 17 minutes. Unwrapped
  // seconds instead, and the bed is the only thing reading them.
  if (grass && grass.style === 'blades') grass.material.userData.uniforms.uTime.value = now / 1000

  player.headPosition(headTmp)
  const [pose, poseHands] = currentPose()
  netplay.sendPose(pose, poseHands, now, boats ? boats.netState() : null, player.originPosition().y)
  if (questToggles.mirror) peerAvatars.mirror({ id: 'double', pose: mirroredPose(pose), hands: poseHands, avatar: netplay.avatar, scale: herScale() })
  netplay.update(now)
  // Altitude and gaze both feed the split rule: y makes the range term 3D and
  // yaw is what stops two thirds of the slot pool going to terrain behind her.
  if (questToggles.terrain || questToggles.terrainWire) {
    terrain.update({ x: headTmp.x, y: headTmp.y, z: headTmp.z, yaw: player.headYaw() })
    terrainWire.update()
  }
  // Rocks first, and it is the same hard ordering the construction has: the tree,
  // fern, grass and litter scatters all ask the stone where it is before they
  // place anything, so a tile of stone has to be grown before the tile of wood
  // over it.
  //
  // A LAYER TOGGLE HALTS THE SCATTER, it does not merely hide the batch. The
  // hidden-but-stepping version cost 2.4 ms a frame in `rocks` alone at 1000 m/s
  // (headless, desktop node -- a Quest 2 core is several times slower) against
  // 0.65 ms standing, spent on a layer the panel said was off, which made the
  // panel unable to answer the one question it exists for. The stale-anchor consequence is
  // real and accepted: with rocks frozen and trees on, wood placed in ground you
  // fly into afterwards does not know about stone that was never grown there, so
  // trees may sit where a boulder would have pushed them. That is invisible while
  // the boulder is, and an ablation panel that cannot ablate is worth less than an
  // exact one.
  if (questToggles.boulders) {
    rocks.update(headTmp.x, headTmp.y, headTmp.z)
    // After the rocks: a mouth follows its boulder's residency.
    if (entrances) entrances.update(headTmp.x, headTmp.y, headTmp.z)
    if (roomProps) roomProps.update(headTmp.x, headTmp.y, headTmp.z)
    if (boulders) boulders.update(headTmp.x, headTmp.y, headTmp.z)
  }
  // The gathering place's rung and its flame's flicker: not under any toggle, the fire is the village's one light that never goes out.
  if (hearth) hearth.update(headTmp.x, headTmp.y, headTmp.z, (now / 1000) % 1024)
  if (questToggles.trees) trees.update(headTmp.x, headTmp.y, headTmp.z)
  if (questToggles.ferns) {
    ferns.update(headTmp.x, headTmp.y, headTmp.z)
    carrots.update(headTmp.x, headTmp.y, headTmp.z)
  }
  if (questToggles.grass) grass.update(headTmp.x, headTmp.y, headTmp.z)
  // Three layers on one `litter` row, hidden AND frozen together -- see the row's
  // own note for why they share a button. Cheap per frame standing still, which is
  // what "the cheapest layers in the world" was measured at; all three are tiled
  // ground scatters, so at flight speed they churn their whole footprint like
  // every other one and the row has to be able to take that away.
  if (questToggles.litter) {
    litter.update(headTmp.x, headTmp.y, headTmp.z)
    // After rocks, and for the same reason the construction and the relief
    // re-place are: a clump follows the anchors, so it wants them stepped first.
    mushrooms.update(headTmp.x, headTmp.y, headTmp.z)
    deadwood.update(headTmp.x, headTmp.y, headTmp.z)
    bones.update(headTmp.x, headTmp.y, headTmp.z)
  }
  // The rowboats sit on the water row: moored where they were placed, so this
  // is the rim sweep and the mesh-to-card step alone.
  if (questToggles.water) rowboats.update(headTmp.x, headTmp.y, headTmp.z)
  // The animals are simulations as well as scatters, so they take dt. Each is
  // frozen with its row, and all of them with the `animals` row.
  //
  // WHAT IS UNDER THE SURFACE IS ONLY DRAWN FROM UNDER IT. The water is nearly
  // opaque from above (WATER.clarity), so with her head in the air every fish
  // and every sunk crab is triangles and a step spent on something nobody can
  // see; a village's pond is the exception, clear from the shore (VILLAGE_POND),
  // so its fish are drawn from above. The fish pool still FOLLOWS her along the shore -- retiring, seeding,
  // no fish stepped, one frame in fish.js FOLLOW_EVERY -- so the lake is stocked
  // the moment she dives; a sunk crab simply pauses on its stone. `submerged` is last frame's answer (see
  // applySubmersion), one frame late on the dive and the surfacing, which the
  // eye cannot tell from the splash.
  //
  // Each is timed through stepAnimal, whose readings the HUD's `animal ms` row
  // shows: ten-odd layers behind one switch is exactly the shape where a guess at
  // which one costs what is worthless.
  //
  // WHAT SHE HOLDS IS A LURE to the fish, the frogs, the wildlife and the
  // dragons, each layer choosing what it wants from the list (hands.js lures):
  // where the hand nodes are this frame, ahead of hands.update, which only
  // moves the items to them.
  lures.length = 0
  hands.lures(lures)
  const fishShown = animalOn('fish') && (submerged || currentRoom.village)
  fish.batch.visible = fishShown
  // The fish and the frogs run on the room's clock (creature-sync.md): every client has each one in the same place.
  stepAnimal('fish', () => {
    if (fishShown) fish.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds, lures)
    else fish.follow(headTmp.x, headTmp.y, headTmp.z)
    fishLeap.update(dt, headTmp, submerged)
  })
  fishLeap.group.visible = animalOn('fish')
  stepAnimal('frogs', () => frogs.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds, lures))
  stepAnimal('crabs', () => crabs.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds, submerged))
  // The butterflies run on the room's clock too, and the chain they fly reads the night off it at the second each rest ends, not off this frame.
  stepAnimal('butterflies', () => butterflies.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds))
  // The grasshoppers run on the room's clock too, and read the night off it themselves at a segment's turn; the scalar is only for a world with no clock.
  stepAnimal('grasshoppers', () => grasshoppers.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds, dayness))
  // The fireflies exist only after dark, off the same scalar.
  stepAnimal('fireflies', () => fireflies.update(headTmp.x, headTmp.y, headTmp.z, dt, dayness))
  // The spiders flee a whole body, so they take her feet too -- the rig's, under her head -- and the peers' bodies beside hers, so a spider bolts from whoever walks up to it and both clients watch it go.
  stepAnimal('spiders', () => spiders.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds, player.originPosition().y, peerHeadsNow()))
  // The wildlife runs on the room's clock (sim/score.js), last frame's reading, the same on every client; its night rest reads the clock's dayness at the planned hour, not this frame's.
  stepAnimal('wildlife', () => wildlife.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds, lures))
  // The snowmen run on the room's clock too, live on her head or a peer's relayed one (creature-sync.md).
  stepAnimal('snowmen', () => snowmen.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds, peerHeadsNow(), dt))
  // The leafkin is startled by her feet and steps on the room's clock (sim/score.js), last frame's reading.
  if (leafkin) stepAnimal('leafkin', () => leafkin.update(player.originPosition(), headTmp, clock.seconds, dt))
  // The villagers likewise, under the leafkin's row.
  if (villagers) stepAnimal('leafkin', () => { villagers.update(player.originPosition(), headTmp, clock.seconds, dt); hobs.update(headTmp, clock.seconds, dt) })
  // After the wildlife, whose stags the dragons hunt this same frame; the roosts first, because a dragon lives where its roost is resident. The dragons run on the room's clock (sim/score.js), last frame's reading, the same on every client.
  if (dragons) stepAnimal('dragons', () => {
    roosts.update(headTmp.x, headTmp.y, headTmp.z)
    dragons.update(headTmp.x, headTmp.y, headTmp.z, clock.seconds, lures)
  })
  bankAnimalMs(dt)
  // After the layers, so a creature let go of this frame is stepped by its own layer next frame from where the hand left it.
  placeDeskHand()
  hands.update(dt, handsHead())
  gunWindows.update(hands)
  shotFlash.update(dt, headTmp)
  drainFlares()
  flares.update(dt, renderer.getDrawingBufferSize(flarePx).y)
  // After the hands, so what this frame took or let go leaves for the relay this frame; the peers' copies are placed at the bodies' wrists as rendered last frame.
  handsNet.update()
  // After the wildlife, so the anchor an animal owes this frame leaves this frame, and a peer's anchor lands before the animal's next step.
  creatureNet.update()

  // Wall-clock time, anchored by the relay when there is one, so every headset
  // in the room reads the same hour off Date.now() with nothing sent per frame.
  if (netplay.time) clock.sync(netplay.time)
  clock.tick()
  askRoomHour()
  // Held in a local because the world probe wants it too: the capture is taken
  // in air even while she is under, and putting the air back for that one face
  // means restating this hour's palette. See airHook.
  const state = clock.state()
  // A wreath she is inside is culled, and the air thickens in its place (§10). Under a roof there is no cloud and no weather.
  if (currentRoom.village) { state.cover = 0; state.precip = 0 }
  if (wreaths) wreaths.visible = questToggles.wreaths && !currentRoom.village
  if (wreaths && wreaths.visible) {
    state.hazeDensity *= wreaths.hazeGain(headTmp)
    wreaths.update(headTmp, state)
  }
  dayness = daynessOf(state)
  // The lamps light after dark on the room's clock; their flicker is real time, this frame's glow into the lighting and the huts' windows.
  if (lamps) {
    lamps.update((now / 1000) % 1024, dayness)
    lighting.uniforms.uLampGlow.value.copy(lamps.glow)
    roomProps.setGlow(lamps.breath)
  }
  if (indoors) {
    indoors.view.update((now / 1000) % 1024, dayness)
    indoors.residents.sync(new Map(villagers.all.filter((c) => c.home === villagers.graph.doorNodes[indoors.e.k] && c.state === 'inside').map((c) => [c.id, c])))
    indoors.residents.update(dt, indoors.view)
  }
  applySky(state, headTmp, now / 1000)
  // Snow above the line, rain below, sleet across it (§10); after applySky, which is where this frame's `submerged` is decided, and none under water.
  precip.update(dt, headTmp, state, height.snowLineAt(headTmp.x, headTmp.z), submerged)
  updateAmbience(dt, state)

  // BEFORE the render, and it must be the only caller of markers.update(): the
  // handles are scaled to hold a constant angular size, so a second call with a
  // different camera would size them for a frame nobody is looking through.
  if (editor) editor.update(dt, camera)

  if (now - lastPanelAt >= 250) {
    lastPanelAt = now
    if (panel) panel.setStats(panelStats())
    // The menu's equivalent of the editor panel's stats block. Same 4 Hz, and
    // deliberately NOT panelStats() itself: that one calls cursorPick(), which
    // raymarches the height field and walks every scatter's instance arrays --
    // a mouse-cursor readout, on a device with no mouse, costing exactly the
    // kind of CPU time the menu exists to hunt down.
    updateQuestStats()
    // The editor RECORDS what went wrong (a click that missed the ground, a
    // failed autosave) and the panel DISPLAYS what it is told; nothing joins the
    // two, so the host does. Only on change, so a message this file put up --
    // "saved 710 B to public/world/layers.json" -- is not overwritten every
    // quarter second by an empty string.
    if (editor && editor.error !== shownError) {
      shownError = editor.error
      panel.setError(editor.error)
    }
  }

  // BEFORE the main render, and that ordering is load-bearing: both probes bind
  // a render target and toggle renderer.xr off to get their own camera looked
  // through. See sky-probe.js.
  if (questToggles.reflections) probe.update(renderer, scene, headTmp)
  // `waterY` is the surface she is at or nearest to, written by applySubmersion
  // earlier this same frame. It is a FLOOR on how low the capture may sit, not
  // the answer -- see WORLD_PROBE.duck, which is what stops a lake shore
  // capturing from inside the bank. `dt` drives the cross-fade and nothing else.
  // The air hook on every frame: the linear ramp ends are wanted for every
  // capture, wet or dry, and the hook itself decides whether there is murk to lift.
  airHook.state = state
  if (questToggles.reflections) worldProbe.update(renderer, scene, headTmp, waterY, dt, airHook)

  // A-Frame renders the scene itself after every registered component's tick()
  // runs (see the `v2-quest-tick` component below) -- a renderer.render here
  // would be a second render of the same frame.
}

// A-Frame drives its own render loop via component tick() methods, not
// renderer.setAnimationLoop -- see quest-main.js's header for why calling
// setAnimationLoop here would silently stop laser-controls (and any other
// A-Frame component) from ticking at all.
// WHAT HER HANDS HOLD DRAWS OVER THE FINISHED FRAME: hands.js keeps it in
// `over`, a group outside the scene, rendered here as a pass of its own with
// the depth cleared, so it is never behind the menu (which has no depth) nor a
// wall she stands against. Her shot's flash is drawn in it last, over them. Its lights are this frame's sun and sky copied, and
// the scene's own fog, so the pool materials keep the one program.
const overlay = new THREE.Scene()
overlay.fog = scene.fog
const overSun = new THREE.DirectionalLight()
const overHemi = new THREE.HemisphereLight()
overlay.add(overSun, overHemi)
const gunWindows = new GunWindows(overlay, HAND_KEYS)
const shotFlash = new ShotFlash(overlay)
const flarePx = new THREE.Vector2()
function renderOverlay() {
  if (!hands || (!hands.over.children.some((m) => m.count > 0) && !shotFlash.mesh.visible)) return
  if (hands.over.parent !== overlay) overlay.add(hands.over)
  overSun.position.copy(sun.position); overSun.color.copy(sun.color); overSun.intensity = sun.intensity
  overHemi.color.copy(hemi.color); overHemi.groundColor.copy(hemi.groundColor); overHemi.intensity = hemi.intensity
  const autoClear = renderer.autoClear
  renderer.autoClear = false
  renderer.clearDepth()
  renderer.render(overlay, sceneEl.camera)
  renderer.autoClear = autoClear
}

AFRAME.registerComponent('v2-quest-tick', {
  tick: () => tick(),
  // After A-Frame's renderer.render, so this is the main pass and not the last
  // offscreen one -- see mainRender. The overlay pass goes after the copy.
  tock: () => {
    mainRender.triangles = renderer.info.render.triangles
    mainRender.calls = renderer.info.render.calls
    renderOverlay()
  },
})
sceneEl.setAttribute('v2-quest-tick', '')

// §18: editing is a desktop activity and the gizmo has no controller binding.
// Entering XR with a tool armed would leave a mode running that nothing in the
// headset can see, exit or undo.
renderer.xr.addEventListener('sessionstart', () => {
  if (!ready) return
  setFlying(false)
  if (editor) editor.setActive(false)
  if (panel) panel.syncSelection()
})

// The headset pose lands on the camera ENTITY, and `camera` is a child under it
// (A-Frame's setPoseTarget, see the renderer boot block). Its desktop offset --
// eyeHeight and whatever the drag-look left in its rotation -- composes under
// the pose, invisibly to the wearer (cameraXR is built from the entity alone)
// but not to anything that asks `camera` where her head is: the netplay pose
// put every peer's feet at her eye line, and headPosition / headYaw feed
// terrain selection. So the child is made identity for the session and handed
// its desktop offset back on exit.
const desktopRotation = new THREE.Euler()
renderer.xr.addEventListener('sessionstart', () => {
  desktopRotation.copy(camera.rotation)
  camera.position.y = 0
  camera.rotation.set(0, 0, 0)
})
renderer.xr.addEventListener('sessionend', () => {
  camera.position.y = LOCOMOTION.eyeHeight
  camera.rotation.copy(desktopRotation)
})

bootWorld().catch(reportRuntimeError)

})().catch(bootFail)
