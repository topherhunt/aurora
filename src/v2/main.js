import THREE from '../three-instance.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'

import { HEIGHTMAP_URL, HEIGHTMAP_META_URL, SEED, WORLD_HALF } from './config.js'
import { Heightmap } from './height/heightmap.js'
import { V2Height } from './height/field.js'
import { RELIEF_DEFAULTS, normalizeRelief, sameRelief } from './height/relief.js'
import { Layers } from './layers/layers.js'
import { snowDefaults } from './layers/doc.js'
import { TerrainV2 } from './terrain/terrain-v2.js'
import { LOD, MIN_TRI_DEG, MAX_TRI_DEG } from './terrain/quadtree-v2.js'
import { Markers } from './render/markers.js'
import { WaterSurfaces } from './render/water-surfaces.js'
import { RoadSurfaces } from './render/road-surfaces.js'
import { Editor, TOOL_KEYS, TOOLS } from './edit/editor.js'
import { raymarchGround, screenRay, pointerNdc, pickProp } from './edit/pick.js'
import { Panel } from './ui/panel.js'
import * as persist from './edit/persist.js'
import { Trees } from './render/trees.js'
import { Ferns } from './render/ferns.js'
import { Grass } from './render/grass.js'
import { TerrainTint } from '../terrain/terrain-tint.js'
import { createPlainTerrainMaterial, createTerrainMaterial } from '../terrain/terrain-material.js'
import { Rocks } from './render/rocks.js'
import { Mushrooms } from './render/mushrooms.js'
import { Deadwood } from './render/deadwood.js'
import { Litter } from './render/litter.js'
import { buildTextureArray, loadImageLayers } from '../textures.js'
import { bakeLitterSet } from '../props/litter.js'
import { bakeRockImpostor } from '../props/rock-bank.js'
import { setSnow, setMoss, setPropClock, setStripTiling, getStripTiling, setWindEnabled } from '../material.js'

// v1 LEAF MODULES, shared on purpose (§18's shared list). Every one of these is
// about the SKY or about the BODY and neither depends on where the ground came
// from. What v2 must not import is v1's ANSWER to the ground question --
// sim/terrain-height.js and sim/phase-a.js -- and scripts/check-v2.mjs fails
// the build if it ever does. That is also why the spawn search below is
// rewritten here rather than imported from phase-a.js.
import { Player, LOCOMOTION } from '../player.js'
import { Sky } from '../sky.js'
import { Stars } from '../stars.js'
// See the header of render/aurora.js: the field is integrated as a convolution
// on a 512x64 map once per frame instead of per pixel, which is what pays for a
// full sky dome. The band mesh it replaced is parked in archive/aurora-mesh/.
import { SkyAurora } from './render/aurora.js'
import { Water, UNDERWATER, CURRENT, currentDrift, murkDensity, murkLinear, murkAir } from '../water.js'
import { WorldClock, CLOCK } from '../clock.js'
import { WorldLighting } from '../lighting.js'
import { SkyProbe } from '../sky-probe.js'
import { WorldProbe } from '../world-probe.js'
import { Input } from '../input.js'
import { Netplay } from '../net.js'
import { PeerAvatars } from './render/avatar.js'

// Explicit presentation mode, rather than a user-agent guess. This keeps
// desktop profiling unchanged and also makes Quest mode testable in a desktop
// browser with `?quest` before entering XR.
const QUEST_MODE = new URLSearchParams(location.search).has('quest')

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

// A headset has no devtools console. Quest V3 (quest-main.js) already solved
// this by routing crashes onto a world-space panel instead of a flat DOM
// overlay, since the DOM overlay isn't rendered inside the VR canvas at all
// -- ported here so a crash AFTER VR entry (this file's bootFail above only
// helps before/outside VR) is still visible on the headset. Set once quest
// mode has a camera to attach the error plane to (see the QUEST_MODE branch
// below); reportRuntimeError still runs bootFail unconditionally, since it
// also covers the flatscreen desktop-testing case.
let showQuestRuntimeError = null
function reportRuntimeError(err) {
  bootFail(err)
  if (showQuestRuntimeError) showQuestRuntimeError(err)
}
window.addEventListener('error', (e) => reportRuntimeError(e.error ?? new Error(e.message)))
window.addEventListener('unhandledrejection', (e) => {
  reportRuntimeError(e.reason instanceof Error ? e.reason : new Error(String(e.reason)))
})

// --- renderer ---------------------------------------------------------------
//
// Quest mode hands the renderer/session bootstrap to A-Frame (the proven-
// reliable VR entry path, per quest.html/quest-main.js) but NOT locomotion --
// unlike quest.html, there's no movement-controls/look-controls/blink-
// controls here. Only laser-controls per hand, for panel raycasting. Moving
// around is entirely Player.update(dt, moveInput) below, identical to normal
// mode, so walking/flying feel the same in and out of quest mode. Everything
// below this block only ever touches the `renderer`/`scene`/`camera`/`rig`
// locals, never the construction details, so it's unmodified by which branch
// ran.
// three-instance.js already resolves to AFRAME.THREE once A-Frame's own
// <script> tag has run (index.html loads it unconditionally, before this
// module), so objects built below are native to whichever THREE actually
// owns the live scene -- no foreign objects, no shim.

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
// point depends on renderer/scene/camera/rig, which in quest mode aren't
// resolved until the injected <a-scene>'s 'loaded' event fires.
;(async () => {

if (QUEST_MODE) {
  sceneEl = document.createElement('a-scene')
  sceneEl.setAttribute('vr-mode-ui', 'enabled: true')
  // A-Frame 1.8's renderer defaults already agree with normal mode's plain
  // `new THREE.WebGLRenderer(...)` below: toneMapping defaults to 'no' and
  // there is no physicallyCorrectLights property in the schema at all. What
  // diverged was the LIGHTS, which are dealt with after appendChild below.
  //
  // `toneMapping: no` stays stated even though it is the default, because the
  // value is interpolated straight into a THREE constant name with no
  // validation: 'no' -> NoToneMapping, and the plausible-looking 'none' ->
  // undefined, which three reports as unsupported and silently compiles as
  // Linear.
  //
  // `antialias: true` is NOT redundant with A-Frame's default. A-Frame's
  // renderer schema defaults antialias to `auto`, which it resolves to FALSE on
  // mobile GPUs -- and the Quest browser is a mobile GPU. Normal mode above
  // asks for MSAA explicitly and gets it, so the headset was the one target
  // drawing every distant ridge line with no edge coverage at all. On a
  // shimmering skyline that reads as the terrain itself flickering.
  //
  // `logarithmicDepthBuffer` is opt-in behind `?quest&logdepth` rather than on
  // by default: it costs a per-fragment gl_FragDepth write (which defeats early
  // -Z on tiled mobile GPUs, exactly the wrong trade on a Quest 2) and the
  // near/far fix below should make it unnecessary. It is here so the two can be
  // A/B'd in the headset without a code change, because depth precision is not
  // something a desktop can reproduce.
  const questRenderer = ['toneMapping: no', 'antialias: true', `foveationLevel: ${FOVEATION}`]
  if (new URLSearchParams(location.search).has('logdepth')) questRenderer.push('logarithmicDepthBuffer: true')
  sceneEl.setAttribute('renderer', questRenderer.join('; '))
  // No movement-controls/look-controls/blink-controls: locomotion in quest
  // mode must be identical to normal mode, which is entirely driven by
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
  // the ENTITY at y 1.6, and an entity offset is not the same thing as normal
  // mode's camera offset -- in XR the headset pose is written to the THREE
  // camera (the child), so a 1.6 on the parent stacks with it and lifts her a
  // whole standing height off the ground. Zero it here and set eyeHeight on
  // the camera itself below, exactly as normal mode does.
  // near/far ARE NOT COSMETIC HERE, and this is the fix for the distant-ridge
  // Z-fighting that only shows up in the headset. The <a-camera> primitive
  // defaults to near 0.005 / far 10000 -- a 2,000,000:1 ratio -- while normal
  // mode below builds its camera at 0.1 / 20000, a ratio of 200,000. A 24-bit
  // depth buffer spends its precision logarithmically in that ratio, so at
  // 0.005 near the quantisation at 2 km is on the order of tens of metres and
  // at 4 km it is hundreds. Chunk skirts alone are up to 192 m deep on the
  // coarsest tiers (skirtDepth = max(2, step * 3) in the chunk mesher), so the
  // skirt and the neighbouring chunk's face land in the SAME depth bucket and
  // whichever drew last wins. On a monitor that is a static, invisible tie; in
  // XR the head never stops moving by a millimetre or two, so the tie is
  // re-broken every frame and the whole skyline crawls. Matching normal mode's
  // 0.1 buys back a factor of twenty of near-plane precision.
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
  // Matches normal mode below. The mouse-drag look handler assigns
  // rotation.x/y directly (not via quaternion), and three's default Euler
  // order ('XYZ') couples yaw into roll as pitch grows -- without this she
  // twists onto her side and eventually upside-down under a plain up/down
  // drag, and WASD (read off the now-rolled local axes) comes out backwards.
  // 'YXZ' (yaw first, then pitch) is the standard FPS-camera order and is
  // what keeps normal mode's own drag-look free of that coupling.
  camera.rotation.order = 'YXZ'
  camera.position.y = LOCOMOTION.eyeHeight // desktop only; XR overwrites this from the pose
  rigEl = sceneEl.querySelector('#rig')
  leftHandEl = sceneEl.querySelector('#left-hand')
  rightHandEl = sceneEl.querySelector('#right-hand')
  rig = rigEl.object3D
  leftGrip = leftHandEl.object3D
  rightGrip = rightHandEl.object3D
} else {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(1) // never above 1 in XR; the headset controls its own resolution
  renderer.setSize(innerWidth, innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.xr.enabled = true
  renderer.xr.setFoveation(FOVEATION)
  document.body.appendChild(renderer.domElement)
  document.body.appendChild(VRButton.createButton(renderer))

  scene = new THREE.Scene()

  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 20000)
  camera.rotation.order = 'YXZ'
  camera.position.y = LOCOMOTION.eyeHeight // desktop only; XR overwrites this from the pose

  rig = new THREE.Group()
  rig.add(camera)
  leftGrip = renderer.xr.getControllerGrip(0)
  rightGrip = renderer.xr.getControllerGrip(1)
  rig.add(leftGrip, rightGrip)
  scene.add(rig)
}

if (QUEST_MODE) {
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
    const lines = ['quest mode: JavaScript error', '', ...String(err?.stack ?? err).split('\n')]
    lines.slice(0, 11).forEach((line, i) => errCtx.fillText(line.slice(0, 72), 14, 10 + i * 27))
    errTexture.needsUpdate = true
    errMesh.visible = true
  }

  sceneEl.canvas?.addEventListener('webglcontextlost', (e) => {
    e.preventDefault() // per spec: without this the context never becomes eligible to restore
    reportRuntimeError(new Error('WebGL context lost (GPU/driver crash, not a JS exception)'))
  })
}

scene.background = new THREE.Color(FOG_COLOR)
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00022)

// The fixed noon-ish rig, held rather than inlined into the two constructors
// because applySky overwrites all six values from the palette every frame. The
// `terrain & prop lighting` row turning off is the host ceasing to write them,
// so "off" has to be able to RESTATE them -- see setLightingEnabled.
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
const probe = new SkyProbe()
// AFTER those three, by reference: the water reflects the dome by calling its
// shading function, asks the (here always-empty) horizon map where the mountains
// are, adds the sky probe's aurora on top, and reads the world probe's capture
// of the bank for everything the horizon map cannot hold. See water.js.
const worldProbe = new WorldProbe()
const water = new Water(scene, { sky, lighting, probe, world: worldProbe })
const stars = new Stars(scene, { seed: SEED, pixelRatio: renderer.getPixelRatio() })
const aurora = new SkyAurora(scene, { renderer, seed: SEED })
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

if (QUEST_MODE) {
  // LITERALS AND NOT questToggles, only because this runs at module scope and
  // the toggles are declared further down -- reading them here is a temporal
  // dead zone throw at boot. These four have to be kept agreeing with
  // `dayNight`, `water` and `aurora` by hand; everything else the panel hides is
  // hidden inside bootWorld, which can read them.
  //
  // `water.group` IS THE NODE THE `water` ROW OWNS, all the way through. Every
  // v2 lake and river is a child of it -- WaterSurfaces parents its own group
  // under this one -- so hiding it here and then toggling the CHILD is a lake
  // that can never be shown, the parent flag still false underneath.
  sky.mesh.visible = true
  water.group.visible = false
  stars.points.visible = true
  aurora.mesh.visible = false
}

// ---------------------------------------------------------------------------
// Quest mode: a world-space toggle panel, ported from quest-main.js's
// already-proven pattern (same laser-controls raycast, same panel-button
// canvas-texture approach) rather than reinvented. Locomotion itself is NOT
// quest-specific -- it's the same Player.update(dt, moveInput) + mouse-drag
// look that normal mode uses, so flying/walking feel identical in and out
// of quest mode. Quest mode's only difference is this panel.
// ---------------------------------------------------------------------------

function labelTexture(text, bg = '#173154', fg = '#ffffff', width = 384) {
  const c = document.createElement('canvas'); c.width = width; c.height = 96
  const ctx = c.getContext('2d')
  if (bg !== null) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height) }
  ctx.fillStyle = fg; ctx.font = 'bold 26px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = bg === null ? 'left' : 'center'
  ctx.fillText(text, bg === null ? 18 : c.width / 2, 48)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

let questPanelGroup = null
const questPanelMeshes = []
const questControllerHits = new Map()

// --- toggle panel ------------------------------------------------------------

// Column order matters: the panel fills column-major over
// QUEST_PANEL_COLS columns, so these read as world layers, then systems, then
// one-shot actions, each group filling down a column.
//
// THERE IS NO `recall panel here` ROW, deliberately. It was here and it was
// useless: the only way to press it is to already be standing in front of the
// panel, which is the one situation in which nothing needs recalling. Recall is
// a CONTROLLER binding (B / Y) for exactly that reason -- the button you can
// reach when the panel is behind you.
const QUEST_TOGGLE_ROWS = [
  { key: 'terrain', text: 'terrain & LOD' },
  { key: 'trees', text: 'trees' },
  { key: 'rocks', text: 'rocks' },
  { key: 'grass', text: 'grass' },
  { key: 'ferns', text: 'ferns' },
  // ONE ROW FOR THREE LAYERS, because they are one thing to the wearer: the
  // small stuff lying on the forest floor. They also share a cost profile --
  // all three are ground scatters that only exist inside ~100 m -- so a
  // measurement that separated them would be three readings of the same number.
  { key: 'litter', text: 'litter, fungi & deadfall' },
  { key: 'grassDensity', text: 'grass', action: () => cycleGrassDensity(), value: () => `${grass ? grass.density : '?'}/m2 >` },
  { key: 'grassBlades', text: 'grass blades', action: () => cycleGrassBlades(), value: () => (grassStyle === 'blades' ? `${grass.bladeCount}/clump >` : 'n/a') },
  { key: 'grassRadius', text: 'grass reach', action: () => cycleGrassRadius(), value: () => `${grass ? grass.radius : '?'} m >` },
  { key: 'grassFalloff', text: 'grass falloff', action: () => cycleGrassFalloff(), value: () => `${grass ? grass.falloff : '?'}^ >` },
  // THE OTHER HALF OF THE `grass` ROW. Off leaves the bed on screen and stops
  // its update() -- the tile walk, the rim sweep, the tier loop and every
  // attribute upload those cause. `grass` off measures draw plus CPU together;
  // this one measures the CPU alone, and the difference is the draw. Standing
  // still it should be nearly free, because a settled rim writes nothing.
  { key: 'grassUpdate', text: 'grass scatter step', on: 'stepping', off: 'frozen' },
  { key: 'treeRadius', text: 'tree reach', action: () => cycleTreeRadius(), value: () => `${trees ? trees.radius : '?'} m >` },
  { key: 'treeFalloff', text: 'tree falloff', action: () => cycleTreeFalloff(), value: () => `${trees ? trees.falloff : '?'}^ >` },
  { key: 'treeMesh', text: 'tree LOD1 band', action: () => cycleTreeMesh(), value: () => `${trees ? meshBandLabel(trees.lodBands[1]) : '?'} >` },
  // The two ABLATIONS on the tree layer, both starting where the world ships so
  // that "off" is the measurement. `tree tiers` takes the mesh ladder away and
  // leaves the card ring, which is what makes the reach and falloff rows above
  // readable on their own; `tree leaf cutout` takes the alpha reject away and
  // with it the layer's transparency. See Trees.setCardsOnly and setCutout for
  // what each number does and does not prove.
  { key: 'treeTiers', text: 'tree tiers', on: 'full ladder', off: 'cards only' },
  { key: 'treeCutout', text: 'tree leaf cutout', on: 'masked', off: 'opaque' },
  { key: 'instCull', text: 'per-instance cull' },
  { key: 'wind', text: 'wind' },
  { key: 'teleport', text: 'move', on: 'teleport', off: 'walk' },
  { key: 'dayNight', text: 'day/night' },
  { key: 'lighting', text: 'terrain & prop lighting' },
  // A CYCLE and not a switch: see the block above TERRAIN_SHADERS for what each
  // rung is, why `plain` is a floor rather than a setting, and what to look at
  // on `axis` before deciding which of the two upper rungs stays.
  { key: 'terrainShader', text: 'landscape shader', action: () => cycleTerrainShader(), value: () => `${TERRAIN_SHADERS[terrainShaderMode]} >` },
  { key: 'water', text: 'rivers & lakes' },
  { key: 'reflections', text: 'cubemap reflections' },
  { key: 'aurora', text: 'aurora' },
  { key: 'auroraPattern', text: 'aurora pattern >', action: () => cycleAurora() },
  { key: 'skip5h', text: '+5h', action: () => skipTime() },
]

function questToggleLabel(row) {
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
  const row = QUEST_TOGGLE_ROWS.find((r) => r.key === key)
  if (!row) return
  if (row.action) { row.action(); return }
  const enabled = (questToggles[key] = !questToggles[key])
  switch (key) {
    case 'terrain': terrain.batch.visible = enabled; break
    case 'dayNight': sky.mesh.visible = enabled; stars.points.visible = enabled; break
    // A REAL OFF SWITCH, and it has to be one. This row used to gate only the
    // sun/hemi/lighting.update block in applySky(), which turned nothing off:
    // every one of those is a LATER WRITER with no restore, so "off" froze the
    // rig and the uniforms at the hour it was pressed and left every
    // instruction the patch compiles into every lit material still running.
    // The row read as permanently on because it WAS. Expect a one-off compile
    // hitch on the frame you press it, as with wind and reflections.
    case 'lighting': setLightingEnabled(enabled); break
    case 'trees': trees.batch.visible = enabled; break
    // Both rows read "the world as it ships" as ON, so the toggle is what gets
    // REMOVED -- the same polarity as `wind` and `landscape shader`.
    case 'treeTiers': trees.setCardsOnly(!enabled); break
    case 'treeCutout': trees.setCutout(enabled); break
    case 'rocks': rocks.beds.forEach((b) => { b.batch.visible = enabled }); break
    case 'grass': grass.batch.visible = enabled; break
    // Three meshes, not one: the fern bed is a ring per LOD, the way the rock
    // beds are a mesh per species. See render/ferns.js on why an InstancedMesh
    // cannot hold the ladder in one object.
    case 'ferns': ferns.meshes.forEach((m) => { m.visible = enabled }); break
    // Three layers on one row. Each is a prop arena -- a Group of
    // InstancedMeshes -- so `visible` on the group is the whole layer.
    case 'litter':
      litter.batch.visible = enabled
      mushrooms.batch.visible = enabled
      deadwood.batch.visible = enabled
      break
    case 'instCull': applyBatchCulling(); break
    // RECOMPILES the three prop materials rather than zeroing uWindStrength, so
    // "off" is the wind's whole per-vertex cost gone and the A/B against "on" is
    // its price in milliseconds. Strength 0 would stop the motion and leave every
    // instruction running, which measures nothing. Expect a one-off hitch on the
    // frame you press it -- that is the shader compile, not the result.
    case 'wind': setWindEnabled(enabled); break
    case 'teleport': // pure state; readInput branches on it. Drop any half-made aim.
      questTeleportArmed = false
      if (questTeleportMarker) questTeleportMarker.visible = false
      break
    case 'water': water.group.visible = enabled; break
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
  }
}

// ---------------------------------------------------------------------------
// THE PER-INSTANCE CULL SWITCH, and why it is the first thing to try when a
// layer "blinks" in the headset rather than merely running slow.
//
// A THREE.BatchedMesh with `perObjectFrustumCulled` on does a CPU sweep in
// onBeforeRender: for every instance it reads the 4x4 out of the matrix
// texture, transforms that instance's bounding sphere by it, and frustum-tests
// the result, then rebuilds the multi-draw list. The early-out at the top of
// that method only fires when NOTHING is on -- `!_visibilityChanged &&
// !perObjectFrustumCulled && !sortObjects`.
//
// IN XR THAT SWEEP RUNS TWICE PER FRAME. WebGLRenderer's XR path loops
// `for (const camera2 of camera.cameras) renderScene(...)`, once per eye, and
// onBeforeRender is called inside renderScene. That is CPU work on a mobile
// core, and CPU work is exactly what the headset has least of. It also explains
// the shape of the symptom: stalls long enough to miss the compositor's
// deadline make the runtime reproject a stale frame, which is the "furious
// blinking" -- not a shader crash, and not the GPU, which the same headset
// happily feeds a million alpha-masked triangles.
//
// WHAT IT STILL REACHES IS TERRAIN, and nothing else. Every scatter is on an
// InstancedMesh arena now -- trees, ferns, grass, litter, mushrooms, dead wood
// and the rock beds -- and those carry the two flags only so applyBatchCulling
// records a default rather than `undefined` (see the notes in trees.js /
// grass.js / instanced-arena.js / prop-arena.js); writing them changes no
// rendering, and there is no per-instance cull on an InstancedMesh to have.
// That leaves terrain.batch, which sorts its 1024 chunks as well as culling
// them. It is on three's defaults, so "on" is what the world ships.
//
// THE ROCKS WERE THE LAST LAYER OFF THIS PATH and are the measurement that
// settles the argument: eight beds, 323k pooled instances between them, swept
// twice per frame for two eyes, took the headset from 90 fps to about 20 the
// moment the layer was switched on. They are on PropArena now.
//
// Turning it OFF trades draw-time (every instance is submitted) for frame-time
// (no sweep). The user's own /quest measurements say this world is nowhere near
// GPU-bound, so that is the right side of the trade here -- but it is a toggle
// and not a constant precisely because it is a trade, and the panel is where it
// gets judged.
function questBatches() {
  const out = []
  if (terrain) out.push(terrain.batch)
  if (trees) out.push(trees.batch)
  if (ferns) ferns.meshes.forEach((m) => out.push(m))
  if (grass) out.push(grass.batch)
  if (rocks) rocks.beds.forEach((b) => out.push(b.batch))
  if (litter) out.push(litter.batch)
  if (mushrooms) out.push(mushrooms.batch)
  if (deadwood) out.push(deadwood.batch)
  return out
}

// The "on" state restores each batch's OWN defaults rather than setting both
// flags true, because they differ per layer by design -- terrain sorts and the
// scatters do not -- and a toggle that forgot that would be comparing the
// off state against a world nobody ships.
const questCullDefaults = new WeakMap()
function applyBatchCulling() {
  const on = questToggles.instCull
  for (const batch of questBatches()) {
    if (!questCullDefaults.has(batch)) {
      questCullDefaults.set(batch, { cull: batch.perObjectFrustumCulled, sort: batch.sortObjects })
    }
    const def = questCullDefaults.get(batch)
    batch.perObjectFrustumCulled = on ? def.cull : false
    batch.sortObjects = on ? def.sort : false
  }
}

// Repaint one row's cell in the shared atlas from the live toggle state.
// Separate from the click handler because a toggle can be flipped by something
// OTHER than its own button, and a row whose label disagreed with the world
// would make the panel worse than no panel.
function refreshQuestRow(key) {
  const i = QUEST_TOGGLE_ROWS.findIndex((r) => r.key === key)
  if (i < 0 || !questRowsCtx) return
  drawQuestRowCell(i)
}

function activateQuestButton(key) {
  applyQuestToggle(key)
  refreshQuestRow(key)
}

// --- the stats readout at the top of the panel -------------------------------
//
// ONE canvas and ONE CanvasTexture for the life of the panel, redrawn in place
// at 4 Hz. The obvious shape -- build a fresh labelTexture per update, the way
// the toggle rows do on click -- would allocate and upload a texture four times
// a second forever, which is a leak of GPU memory on a device that has 6 GB for
// everything. Rows get away with it because a click is a human-rate event.
// Panel geometry, in metres, in one place because the background, the title,
// the stats plane and the button grid all have to agree on the width and there
// is no layout engine in a Three.js scene to make them.
const QUEST_PANEL_COLS = 3
const QUEST_PANEL_COL_W = 0.86
const QUEST_PANEL_COL_GAP = 0.06
const PANEL_W = QUEST_PANEL_COLS * QUEST_PANEL_COL_W + (QUEST_PANEL_COLS - 1) * QUEST_PANEL_COL_GAP

// Button grid metrics, shared by the grid itself and by the backdrop that has
// to be tall enough for it.
const QUEST_ROW_H = 0.20
const QUEST_ROW_TOP = 0.30
const questRowsPerCol = () => Math.ceil(QUEST_TOGGLE_ROWS.length / QUEST_PANEL_COLS)

// The panel's LOWEST EDGE, in group-local metres, and negative: the group's
// origin sits up among the buttons rather than at the bottom of the plate. Two
// callers need the same number and they are 170 lines apart -- buildQuestPanel
// sizes the backdrop from it, questPanelDesiredPosition subtracts it to keep
// that backdrop out of the ground -- so it is one expression rather than two.
// It GROWS DOWNWARD WITH THE GRID: rows run from QUEST_ROW_TOP down at
// QUEST_ROW_H each, and the plate ends half a button below the last one.
const questPanelBottom = () => QUEST_ROW_TOP - (questRowsPerCol() - 1) * QUEST_ROW_H - 0.14

// How far the plate's bottom edge stands clear of the terrain when the ground is
// what decides its height. Small enough to read as resting on the ground rather
// than hovering, big enough that grass and the ground's own shading do not saw
// through the edge as she moves her head.
const QUEST_PANEL_GROUND_GAP = 0.05

// THE BUTTON GRID IS ONE MESH OVER ONE ATLAS, and that is a draw-call decision
// rather than a tidiness one. A quad per row, each with its own CanvasTexture
// and its own material, is a draw call per row -- and because those materials
// are `transparent` AND `DoubleSide`, three splits every one of them into a
// back pass and a front pass (WebGLRenderer, `material.transparent === true &&
// material.side === DoubleSide && material.forceSinglePass === false`), so the
// bill was TWO calls a button. Twenty rows plus the backdrop, title and stats
// came to 49 calls per eye for a menu with nothing behind it.
//
// One geometry holding all the quads, one atlas holding all the labels, one
// material: 1 call. The cells are laid out on the same grid the quads are, at
// the same 459x96 each row's own texture used to be, so this is pixel-for-pixel
// what was there. A click identifies its row from the hit's faceIndex (two
// triangles per quad) instead of from the mesh it landed on, and a label change
// repaints ONE cell in place and re-uploads the atlas -- a click is a
// human-rate event, so that upload is affordable where the stats readout's
// 4 Hz one would not be.
const QUEST_CELL_W_PX = Math.round(QUEST_PANEL_COL_W / 0.18 * 96)
const QUEST_CELL_H_PX = 96
let questRowsCanvas = null
let questRowsCtx = null
let questRowsTexture = null

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

function drawQuestRowCell(i) {
  const row = QUEST_TOGGLE_ROWS[i]
  const rowsPerCol = questRowsPerCol()
  const x = Math.floor(i / rowsPerCol) * QUEST_CELL_W_PX
  const y = (i % rowsPerCol) * QUEST_CELL_H_PX
  const ctx = questRowsCtx
  ctx.fillStyle = '#173154'
  ctx.fillRect(x, y, QUEST_CELL_W_PX, QUEST_CELL_H_PX)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 26px monospace'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText(questToggleLabel(row), x + QUEST_CELL_W_PX / 2, y + QUEST_CELL_H_PX / 2)
  uploadQuestTexture(questRowsTexture)
}

const QUEST_STATS_W = 1280
const QUEST_STATS_H = 240
let questStatsCanvas = null
let questStatsCtx = null
let questStatsTexture = null

function drawQuestStats(lines) {
  const ctx = questStatsCtx
  ctx.fillStyle = '#08131f'
  ctx.fillRect(0, 0, QUEST_STATS_W, QUEST_STATS_H)
  ctx.font = 'bold 28px monospace'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  lines.forEach((parts, row) => {
    let x = 16
    const y = 22 + row * 39
    for (const [text, color] of parts) {
      ctx.fillStyle = color
      ctx.fillText(text, x, y)
      x += ctx.measureText(text).width
    }
  })
  uploadQuestTexture(questStatsTexture)
}

function buildQuestPanel() {
  questPanelGroup = new THREE.Group()
  scene.add(questPanelGroup)

  // BUILT HIDDEN, AND HIDDEN IS THE RESTING STATE. Four meshes and the three
  // widest textures in the scene, all of it for a menu that is wanted for a few
  // seconds at a time. `visible = false` is the whole saving: three's
  // projectObject returns early on an invisible object and never descends, so
  // the group's children are not culled, not sorted, and not drawn, and their
  // triangles never reach the render list at all.
  questPanelGroup.visible = false

  // See questPanelBottom for why the bottom edge is computed rather than typed;
  // the title at 1.05 fixes the top. A fourth column would be the wrong fix for
  // a longer list: at 2.8 m the three already subtend 51 degrees, and a fourth
  // would put its outer edge where a Quest 2's lenses go soft.
  const gridBottom = questPanelBottom()
  const bgTop = 1.20
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W + 0.1, bgTop - gridBottom),
    new THREE.MeshBasicMaterial({ color: 0x091321, transparent: true, opacity: 0.94, side: THREE.DoubleSide, forceSinglePass: true })
  )
  bg.position.set(0, (bgTop + gridBottom) / 2, -0.01)
  questPanelGroup.add(bg)

  const title = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, 0.13),
    new THREE.MeshBasicMaterial({ map: labelTexture('sticks move & turn -- A/X fly -- B/Y or esc closes this menu -- stick click recenters', null, '#8fd48f', 1560), transparent: true, toneMapped: false, side: THREE.DoubleSide, forceSinglePass: true })
  )
  title.position.set(0, 1.05, 0.02)
  questPanelGroup.add(title)

  questStatsCanvas = document.createElement('canvas')
  questStatsCanvas.width = QUEST_STATS_W
  questStatsCanvas.height = QUEST_STATS_H
  questStatsCtx = questStatsCanvas.getContext('2d')
  questStatsTexture = new THREE.CanvasTexture(questStatsCanvas)
  questStatsTexture.colorSpace = THREE.SRGBColorSpace
  // NO MIP CHAIN. This texture is the only one in the scene RE-UPLOADED ON A
  // TIMER -- updateQuestStats redraws it at 4 Hz for as long as the menu is open
  // -- and three's upload path runs generateMipmap for the whole chain after
  // every texImage2D. Mipmaps buy nothing to lose here: the panel is world-locked
  // at 2.8 m and read near head-on, where 1280 px across 2.7 m is minified about
  // 1.3x, which is what LinearFilter is for. Cheaper only; see uploadQuestTexture
  // for what actually made the upload visible.
  questStatsTexture.generateMipmaps = false
  questStatsTexture.minFilter = THREE.LinearFilter
  const stats = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, PANEL_W * QUEST_STATS_H / QUEST_STATS_W),
    new THREE.MeshBasicMaterial({ map: questStatsTexture, toneMapped: false, side: THREE.DoubleSide })
  )
  stats.position.set(0, 0.70, 0.02)
  questPanelGroup.add(stats)
  drawQuestStats([[['booting...', '#7f95b4']]])

  // Three side-by-side columns rather than one tall stack, so the panel stays a
  // comfortable height regardless of how many toggles it grows to. Column-major
  // fill, so QUEST_TOGGLE_ROWS reads top-to-bottom in source order.
  //
  // ONE geometry of loose quads, at the positions a mesh per row used to sit at.
  // Loose and not a PlaneGeometry grid, because the gaps between the buttons are
  // the backdrop showing through -- a continuous sheet would have to carry them
  // as transparent margin in every cell instead.
  const rowsPerCol = questRowsPerCol()
  const n = QUEST_TOGGLE_ROWS.length
  const atlasW = QUEST_PANEL_COLS * QUEST_CELL_W_PX
  const atlasH = rowsPerCol * QUEST_CELL_H_PX
  questRowsCanvas = document.createElement('canvas')
  questRowsCanvas.width = atlasW
  questRowsCanvas.height = atlasH
  questRowsCtx = questRowsCanvas.getContext('2d')
  questRowsTexture = new THREE.CanvasTexture(questRowsCanvas)
  questRowsTexture.colorSpace = THREE.SRGBColorSpace
  // Same reasoning as the stats texture above, on a slower clock: this atlas is
  // redrawn on every button press rather than on a timer.
  questRowsTexture.generateMipmaps = false
  questRowsTexture.minFilter = THREE.LinearFilter

  const positions = new Float32Array(n * 4 * 3)
  const uvs = new Float32Array(n * 4 * 2)
  const indices = new Uint16Array(n * 6)
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / rowsPerCol)
    const rowInCol = i % rowsPerCol
    const cx = (col - (QUEST_PANEL_COLS - 1) / 2) * (QUEST_PANEL_COL_W + QUEST_PANEL_COL_GAP)
    const cy = QUEST_ROW_TOP - rowInCol * QUEST_ROW_H
    const x0 = cx - QUEST_PANEL_COL_W / 2, x1 = cx + QUEST_PANEL_COL_W / 2
    const y0 = cy - 0.09, y1 = cy + 0.09
    // The atlas cell, in UV. Canvas rows run downward and CanvasTexture flips Y,
    // so the cell's TOP edge is the larger v.
    const u0 = col * QUEST_CELL_W_PX / atlasW, u1 = (col + 1) * QUEST_CELL_W_PX / atlasW
    const v1 = 1 - rowInCol * QUEST_CELL_H_PX / atlasH, v0 = 1 - (rowInCol + 1) * QUEST_CELL_H_PX / atlasH
    positions.set([x0, y0, 0.03, x1, y0, 0.03, x1, y1, 0.03, x0, y1, 0.03], i * 12)
    uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8)
    const v = i * 4
    indices.set([v, v + 1, v + 2, v + 2, v + 3, v], i * 6)
    drawQuestRowCell(i)
  }
  const rowsGeometry = new THREE.BufferGeometry()
  rowsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  rowsGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  rowsGeometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const rowsMesh = new THREE.Mesh(
    rowsGeometry,
    // forceSinglePass, or three draws the whole grid twice -- see the atlas note
    // above drawQuestRowCell.
    new THREE.MeshBasicMaterial({ map: questRowsTexture, side: THREE.DoubleSide, transparent: true, toneMapped: false, forceSinglePass: true })
  )
  questPanelGroup.add(rowsMesh)
  questPanelMeshes.push(rowsMesh)

  const dotGeometry = new THREE.SphereGeometry(0.012, 12, 8)
  const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xff3b3b, toneMapped: false, depthTest: false })
  function wireQuestController(el) {
    const dot = new THREE.Mesh(dotGeometry, dotMaterial)
    dot.visible = false
    scene.add(dot)
    questControllerHits.set(el, { hit: null, dot })
    el.addEventListener('triggerdown', () => {
      const key = questKeyAt(questControllerHits.get(el)?.hit)
      if (key) activateQuestButton(key)
    })
  }
  ;[leftHandEl, rightHandEl].forEach(wireQuestController)

  // Flatscreen click support for desktop `?quest` testing before entering XR.
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  window.addEventListener('pointerup', (e) => {
    if (sceneEl.is('vr-mode')) return
    const cam = sceneEl.camera
    if (!cam) return
    // THE VISIBILITY CHECK IS NOT BELT AND BRACES. Raycaster does not consult
    // `visible` -- it tests layers and then calls raycast() -- so a closed menu
    // is still fully clickable unless the caller says otherwise, and a stray
    // click on empty ground would toggle whatever button happened to be behind
    // it. Same reason the hover loop below bails.
    if (!questPanelGroup.visible) return
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
    raycaster.setFromCamera(pointer, cam)
    const key = questKeyAt(raycaster.intersectObjects(questPanelMeshes)[0])
    if (key) activateQuestButton(key)
  })
}

// Which row a raycast landed on. The grid is ONE mesh, so the answer is not on
// the hit object -- it is the quad the hit triangle belongs to, and the quads
// are laid out in QUEST_TOGGLE_ROWS order at two triangles each.
function questKeyAt(hit) {
  if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null
  return QUEST_TOGGLE_ROWS[Math.floor(hit.faceIndex / 2)]?.key ?? null
}

function updateQuestControllerHover() {
  const open = questPanelGroup.visible
  for (const [el, entry] of questControllerHits) {
    const raycasterComp = open ? el.components.raycaster : null
    const hit = raycasterComp ? (raycasterComp.raycaster.intersectObjects(questPanelMeshes)[0] || null) : null
    entry.hit = hit
    entry.dot.visible = !!hit
    if (hit) entry.dot.position.copy(hit.point)
  }
}

const questPanelFwd = new THREE.Vector3()
const questTempQuat = new THREE.Quaternion()
function questPanelDesiredPosition(out) {
  camera.getWorldQuaternion(questTempQuat)
  questPanelFwd.set(0, 0, -1).applyQuaternion(questTempQuat)
  questPanelFwd.y = 0
  if (questPanelFwd.lengthSq() < 1e-6) questPanelFwd.set(0, 0, -1)
  questPanelFwd.normalize()
  // Backed off with the third column: at 2.2 m a 2.7 m-wide panel subtends
  // about 64 degrees, so the outer columns sit out where a Quest 2's lenses go
  // soft and you have to turn your head to read them.
  const dist = 2.8
  out.x = rig.position.x + questPanelFwd.x * dist
  out.z = rig.position.z + questPanelFwd.z * dist

  // HER FLOOR, NOT THE GROUND UNDER THE PANEL. `rig.position.y` is the damped
  // terrain height while she is walking and her actual altitude while she is
  // flying, so one expression seats the panel at reading height in both --
  // whereas sampling the terrain 2.8 m ahead leaves the menu lying on the
  // hillside while she is a hundred metres above it. 1.3 is unchanged and is
  // the offset from her floor to the group's origin.
  out.y = rig.position.y + 1.3

  // AND THEN FLOORED, because her elevation and the ground in front of her are
  // not the same number. Walking uphill, 2.8 m ahead is above her own footing,
  // and the plate's lower corner goes into the slope; on the flat it went in
  // anyway, by 14 cm, because the grid has grown taller than the 1.3 allows for.
  //
  // Three samples along the bottom EDGE, not one under the centre, because that
  // edge is 2.8 m wide and a corner is what digs in first on a side slope. Three
  // is enough rather than a compromise: the heightmap is 8.0 m per texel, so the
  // whole edge fits inside one bilinear cell and the surface under it has no
  // curvature for a fourth sample to find.
  const halfW = (PANEL_W + 0.1) / 2
  const rightX = questPanelFwd.z * halfW
  const rightZ = -questPanelFwd.x * halfW
  const ground = Math.max(
    height.heightAt(out.x, out.z),
    height.heightAt(out.x + rightX, out.z + rightZ),
    height.heightAt(out.x - rightX, out.z - rightZ)
  )
  out.y = Math.max(out.y, ground + QUEST_PANEL_GROUND_GAP - questPanelBottom())
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
  questPanelGroup.lookAt(rig.position.x, questPanelGroup.position.y, rig.position.z)
}

/**
 * B / Y, or Escape: open the menu here, or close it.
 *
 * This used to be "recall", which only ever moved the panel -- so the menu was
 * always in the world and the button just decided where. It is a MENU SCREEN
 * now: closed is the resting state, opening seats it at wherever she is
 * standing at that moment, and pressing again takes it away rather than
 * teleporting it to her feet.
 *
 * The saving is the point. Four meshes and three wide canvas textures were being
 * drawn every frame of a session in which the menu is looked at for a few
 * seconds -- and in VR that is eight draw calls, since both eyes pay. Hidden,
 * three's projectObject skips the whole subtree.
 */
function toggleQuestPanel() {
  if (!questPanelGroup) return
  questPanelGroup.visible = !questPanelGroup.visible
  // Placed AFTER the flag, not before: placeQuestPanel bails on a closed menu,
  // so seating it first would seat nothing.
  placeQuestPanel()
  if (!questPanelGroup.visible) {
    // Drop the laser dots with it. They are separate scene children, so nothing
    // about the group's visibility reaches them, and a red dot hanging in mid
    // air pointing at a menu that is no longer there is exactly the kind of
    // stranded artefact that reads as a bug.
    for (const entry of questControllerHits.values()) {
      entry.hit = null
      entry.dot.visible = false
    }
  }
}

function updateQuestPanel() {
  updateQuestControllerHover()
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
  // Nothing to read while the menu is closed, and this is not free: it lays out
  // six lines of canvas text and then sets needsUpdate, which re-uploads a
  // 1280-wide texture EVERY FRAME. Measuring the frame is not worth spending
  // the frame on. It redraws on the frame the menu opens, so the numbers are
  // current the instant they are visible.
  if (!questPanelGroup.visible) return
  const info = renderer.info
  const st = terrain.stats
  const ts = trees.stats
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
      ['FPS ', '#7f95b4'], [`${fps.toFixed(0)}→${fps5.toFixed(0)}`.padEnd(8), fpsColor],
      // The worst single frame in the same five seconds. A mean that holds while
      // this sits twenty below it is a stutter, not a stable frame.
      ['LOW ', '#7f95b4'], [low5.toFixed(0).padEnd(5), rate(low5)],
      ['MS ', '#7f95b4'], [avgMs.toFixed(1).padEnd(6), fpsColor],
      ['TRIS ', '#7f95b4'], [kilo(info.render.triangles).padEnd(8), '#7fd7ff'],
      ['CALLS ', '#7f95b4'], [String(info.render.calls).padEnd(6), '#ff9a7a'],
      // Metres to the ground under the cursor, which is the only ruler this
      // view has. `-` is the ray reaching the horizon, not a failure.
      ...(cursor
        ? [
            ['CURSOR ', '#7f95b4'], [cursor.dist === null ? '-' : `${cursor.dist.toFixed(1)}m`, '#ff6b6b'],
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
      ['CULL ', '#7f95b4'], [(questToggles.instCull ? 'on' : 'off').padEnd(5), questToggles.instCull ? '#ffd27a' : '#8fd48f'],
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
      ...scatterCells('rock ', questToggles.rocks, rocks.stats),
      ...scatterCells('fern ', questToggles.ferns, ferns.stats),
      ['flat ', '#7f95b4'], [(height.flatY === null ? 'off' : `${height.flatY.toFixed(0)}m`).padEnd(6), '#8fd48f'],
      ['mode ', '#7f95b4'], [player.flying ? 'fly' : questToggles.teleport ? 'teleport' : 'walk', '#8fd48f'],
    ],
    [
      ['pads ', '#7f95b4'], [String(inp.connected).padEnd(3), inp.connected > 0 ? '#8fd48f' : '#ff6b6b'],
      ['L ', '#7f95b4'], [`${la[0].toFixed(2)},${la[1].toFixed(2)}`.padEnd(13), '#cfe3ff'],
      ['R ', '#7f95b4'], [`${ra[0].toFixed(2)},${ra[1].toFixed(2)}`.padEnd(13), '#cfe3ff'],
      [questInputSource, '#7f95b4'],
    ],
  ])
}

const input = new Input(renderer)
const peerAvatars = new PeerAvatars(scene)
const room = new URLSearchParams(location.search).get('room') || 'default'
const netplay = new Netplay({
  room,
  url: import.meta.env.VITE_WS_URL || undefined,
  onState: (peers) => peerAvatars.apply(peers),
})

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

// Filled in by boot(); the frame loop refuses to run until they exist.
let height = null
let layers = null
let terrain = null
let terrainTint = null
let player = null
let markers = null
let waterSurfaces = null
let roads = null
let trees = null
let ferns = null
let grass = null
let propTextures = null
let rocks = null
let litter = null
let mushrooms = null
let deadwood = null
let editor = null
let panel = null
let ready = false

// Quest-mode toggle panel state. Most layers default off so the headset can
// isolate one system's cost at a time; the ground and the sky do not, because
// they are what everything else is measured ON -- a bed of grass floating over
// a black void is not the picture anyone is judging. Non-quest mode never reads
// this.
//
// `lighting` is in that second group for a stricter reason than composition:
// off, the sun and hemi lights keep the fixed noon-ish rig they were
// constructed with and never hear about the hour, so the headset shows a
// brighter, flatter world than the desktop at every time of day and a wholly
// fake one at night. Quest mode is supposed to be the same world seen through
// a headset, so the day/night shading is on and the row is there to take it
// away for a measurement.
//
// `instCull` is the one that does NOT default to the three.js default. See the
// banner on applyBatchCulling: the per-instance frustum sweep runs once per EYE
// in XR, which is CPU work the Quest 2 has least of, and turning it off is the
// first thing to try when a layer stutters rather than merely renders slowly.
// It starts off so the headset boots into the cheap configuration; flip it on
// to measure what the sweep actually costs. Terrain does not pay for that
// choice: TerrainV2.cullDeg culls the same batch by yaw during a sweep it was
// already running. The scatter layers still submit everything when this is off.
const questToggles = QUEST_MODE
  ? {
      terrain: true, dayNight: true, lighting: true,
      trees: false, rocks: false, grass: false, ferns: false, litter: false,
      instCull: false, water: false, reflections: false, aurora: false,
      // The toggles that start ON, because unlike every layer above them these
      // are not things being added to an empty world -- they are how the world
      // already ships, and the measurement being made is what REMOVING them
      // buys. Starting one off would mean the panel's default state disagreed
      // with the world outside quest mode.
      wind: true, treeTiers: true, treeCutout: true, grassUpdate: true,
      // Walk, not teleport, is the default: teleport hides exactly the symptom
      // this panel exists to look at, which is what the world does to the frame
      // while you are moving continuously through it.
      teleport: false,
    }
  : null

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
const RELIEF_KEY = 'v2.relief'
let relief = RELIEF_DEFAULTS

/**
 * Read the stored relief, falling back to all-off.
 *
 * The catch is around normalizeRelief as much as around JSON.parse: a knob
 * renamed or removed since the value was written makes it THROW rather than
 * silently drop the key, which is right for a postMessage and wrong here --
 * being unable to boot because of a stale HUD setting is not a failure mode
 * worth having. Anything unreadable is reported once and replaced with off,
 * which is the state the world ships in anyway.
 */
function loadRelief() {
  const raw = localStorage.getItem(RELIEF_KEY)
  if (!raw) return RELIEF_DEFAULTS
  try {
    return normalizeRelief(JSON.parse(raw))
  } catch (err) {
    console.warn(`[v2] discarding stored relief: ${err.message}`)
    localStorage.removeItem(RELIEF_KEY)
    return RELIEF_DEFAULTS
  }
}

// Which grass system is standing, and the M key cycles all three so they can be
// judged against the same hillside in the same light. 'tufts' is one
// camera-facing billboard per plant at every distance; 'strips' is the flat
// multi-metre card drawing the same cutout several times across itself, winning
// on triangles and losing on FILL; 'blades' is opaque geometry that pays no fill
// for transparency at all. See THE THREE STRATEGIES in render/grass.js.
//
// FILL IS THE BUDGET A QUEST RUNS OUT OF, so `?quest` -- which exists to be worn
// and measured -- stands the blade bed and the desktop route keeps the cards.
const GRASS_STYLES = ['tufts', 'strips', 'blades']
let grassStyle = QUEST_MODE ? 'blades' : 'tufts'
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
    seed: SEED, style, tint: terrainTint, rocks, ...opts,
  })
  // The cache key carries the style: the two materials compile DIFFERENT
  // programs (one billboards, one tiles), and a shared key would hand the second
  // one the first one's.
  lighting.patch(grass.material, { mode: 'vertex', cacheKey: `v2-grass-${style}` })
  grass.syncSnowLine(layers)
  grass.place(cx, cz)
  // A rebuilt bed is a NEW mesh, so it arrives with three's defaults rather than
  // whatever the panel's cull switch is currently set to. Without this, swapping
  // grass style silently un-does the toggle.
  if (QUEST_MODE) {
    applyBatchCulling()
    // A rebuilt bed is a new mesh and arrives visible. Without this, changing
    // the density while the grass row is OFF turns the grass back on.
    grass.batch.visible = questToggles.grass
  }
  if (propLayersReady) grass.bakeCards(renderer)
  const gs = grass.stats
  const gr = gs.rejected
  console.log(
    `[v2] grass (${gs.style}) ${gs.placed} of ${gs.samples} placed over ${gs.tiles} tiles in ` +
    `${gs.placeMs.toFixed(0)} ms (${gs.density}/m^2 to ${gs.fullRadius} m, thinning ^${gs.falloff} to ` +
    `${gs.radius} m, pool ${gs.used}/${gs.pool}; dropped: ${gr.elev} elev, ${gr.slope} slope, ` +
    `${gr.water} water, ${gr.snow} snow, ${gr.path} path)`
  )
}

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

  // BEFORE the scratch V2Height, because the relief changes what `bands` says
  // and the snow defaults are derived from bands. Booting with the knobs off and
  // applying them afterwards would put the snow line where the unrelieved world
  // wanted it and then move the ground out from under it.
  relief = loadRelief()

  // The scratch document. See the header: `bands` needs a V2Height and the snow
  // defaults need `bands`, so something has to be constructed first.
  height = new V2Height({ heightmap, layers: new Layers(), seed: SEED, relief })
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
  // The atlas is built HERE, ahead of the terrain, and not down with the trees
  // where it used to live: createTerrainMaterial decides at compile time whether
  // to declare a sampler at all, so it has to have the array in hand before the
  // material exists. `axis` then declines it -- that variant wears no photographic
  // tile -- but the argument stays so the /gen-* benches and this call are the
  // same shape.
  //
  // Building it early costs nothing. It is built empty and its image layers land
  // asynchronously (loadImageLayers, below); the bank and the batches do not wait
  // on them, so the world has trees and stone from the first frame wearing
  // whatever the procedural layers already hold.
  propTextures = buildTextureArray()
  terrain = new TerrainV2(scene, {
    heightmapRaw: heightmap.toRaw(), doc: layers.serialize(), relief, workers: 2, atlas: propTextures, axis: true,
  })

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

  // The shipped rung goes on here and not at construction, because TerrainV2
  // compiles `axis` either way -- the depth material and the tint above both need
  // its uniforms -- so without this the mesh would draw with the one thing on the
  // row that nobody selected. See TERRAIN_SHADERS.
  applyTerrainShader()

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

  // Stone, in seven size beds at once: pebbles underfoot, boulders through the
  // wood and across the cliffsides, giants on the crags and the summits, and
  // blocks let into the faces and the lake floors. Seven more BatchedMeshes and
  // seven more draw calls, but ONE material for all of them -- every rock bed
  // billboards the same single card layer, so unlike the trees, the ferns and
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
  // ground. Quest mode does not weaken it -- the toggle only sets `batch.visible`
  // and the beds are placed and stepped either way, so what the trees see does
  // not change when the rocks are switched off.
  rocks = new Rocks(scene, height, waterSurfaces, layers, propTextures, { seed: SEED, ground: terrain })
  lighting.patch(rocks.material, { mode: 'vertex', cacheKey: 'v2-rock' })
  // A cacheKey of its own, not a second use of the one above: the shell is a
  // separate program (BackSide flips FLIP_SIDED) and sharing the key would pin
  // both materials to whichever entry compiled first. See lighting.patch.
  lighting.patch(rocks.shellMaterial, { mode: 'vertex', cacheKey: 'v2-rock-shell' })
  rocks.syncBands(layers)
  rocks.place(spawn.x, spawn.z)
  const rs = rocks.stats
  console.log(
    `[v2] rocks ${rs.placed} placed in ${rs.placeMs.toFixed(0)} ms, bank ` +
    `${rs.bankTris} tris / ${rs.bankKB} KB in ${rs.buildMs.toFixed(0)} ms; ` +
    rs.beds.map((b) => `${b.name} ${b.placed} (${b.used}/${b.pool}) to ${b.radius} m`).join(', ')
  )
  // Same console hook the ferns, mushrooms and dead wood keep, and here it earns
  // itself twice over: `describeNear` is the only way to see what a rock that
  // misbehaves in the browser is actually doing, since a blink does not survive
  // into a headless traverse. See render/rocks.js.
  window.v2rocks = rocks

  // Trees. The atlas was built up at the terrain, above, because the terrain
  // needs it at material-compile time. The card BAKE does wait on the image
  // layers landing, because a photograph taken before the bark has loaded would
  // be a photograph of nothing -- see Trees.bakeCards.
  // `ground: terrain` is what stops distant trees floating: a tree's Y comes off
  // the chunk mesh that is actually drawn under it, not off the exact field the
  // chunk's triangles are chording across. See Trees._groundFor.
  trees = new Trees(scene, height, waterSurfaces, propTextures, {
    seed: SEED,
    ground: terrain,
    // Constructed above, and it has to be: a trunk that lands inside a boulder
    // stands on the boulder. See Rocks.blockTopAt.
    rocks,
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
    `(${ts.density}/m^2 to ${ts.fullRadius} m, thinning ^${ts.falloff} to ${ts.radius} m, ` +
    `pool ${ts.used}/${ts.pool}), ${ts.bankKB} KB bank`
  )

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
  ferns = new Ferns(scene, height, waterSurfaces, layers, propTextures, { seed: SEED, rocks })
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

  // Strewn litter: the small stones, as four baked photographs stamped flat on
  // the ground instead of as tens of thousands of modelled pebbles. It is a
  // sibling of the rock beds rather than a fifth bed of them because it shares
  // none of their machinery -- no bank, no tier ladder, no anchors -- and it is
  // constructed AFTER them only for reading order. See render/litter.js.
  //
  // ITS FOUR ATLAS LAYERS ARE STILL BLANK AT THIS POINT and that is fine: the
  // bake needs the renderer and hangs off the same loadImageLayers promise the
  // impostor bakes do, a few screens down. The atlas is one texture object, so
  // the stamps pick the pictures up the frame they land in it. What would NOT
  // be fine is placing litter before the atlas exists at all, which is why this
  // sits below `propTextures` like everything else that samples it.
  litter = new Litter(scene, height, waterSurfaces, layers, propTextures, { seed: SEED, ground: terrain, rocks })
  lighting.patch(litter.material, { mode: 'vertex', cacheKey: 'v2-litter' })
  litter.place(spawn.x, spawn.z)
  const ls = litter.stats
  console.log(
    `[v2] litter ${ls.placed} stamps (${ls.pool} pool) over ${ls.tiles} tiles in ` +
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
  mushrooms = new Mushrooms(scene, height, waterSurfaces, layers, propTextures, [trees, rocks], { seed: SEED })
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

  // Fallen logs and rotten stumps on the forest floor. A PLAIN GROUND SCATTER,
  // unlike the mushrooms directly above -- it asks the height field where the
  // wood may lie and nothing else -- so it carries none of that block's ordering
  // dependency and could sit anywhere below `layers`. It is here because this is
  // where the forest floor is assembled, and it reads in the order the player
  // sees it: trees, ferns, grass, rocks, litter, mushrooms, deadfall.
  // `trees` is passed for the keep-out, not for anchoring: dead wood is scattered
  // on its own grid and then refuses any candidate lying on a trunk. That reads
  // the forest's PLACED instances, so this must stay after trees.place above and
  // deadwood.update must stay after trees.update in the frame loop.
  deadwood = new Deadwood(scene, height, waterSurfaces, layers, propTextures, trees, { seed: SEED })
  // A FIFTH cacheKey, for the reason spelled out at the trees: the key is what
  // the program cache is keyed on, and this material's uBillboardLayers is its
  // own list, so sharing a neighbour's key would hand one layer the other's
  // compiled program.
  lighting.patch(deadwood.material, { mode: 'vertex', cacheKey: 'v2-deadwood-bb' })
  // So a log and the ground under it cross the snow line together, and so that
  // nothing lies above the line -- same contract as the trees and ferns.
  deadwood.syncSnowLine(layers)
  deadwood.place(spawn.x, spawn.z)
  const ds = deadwood.stats
  const dr = Object.entries(ds.rejected).map(([why, n]) => `${n} ${why}`).join(', ')
  console.log(
    `[v2] deadwood ${ds.logs} logs + ${ds.snags} stumps over ${ds.tiles} tiles in ` +
    `${ds.placeMs.toFixed(0)} ms (pool ${ds.used}/${ds.pool}, bank ${ds.bankKB} KB) (dropped: ${dr})`
  )
  window.v2deadwood = deadwood

  // Last of the five, so the cursor readout can be bound now. Deliberately here
  // rather than lazily inside the readout: a missing scatter should be a boot
  // error next to the thing that failed to build, not a readout that silently
  // stops naming ferns.
  bindCursorPicks()

  // The weather, which until now nothing in v2 ever turned on: the props have
  // carried a snow shader and a moss shader since they were written, and both
  // have been sitting at zero. Setting them here is what makes a rock on a
  // summit white and the same rock in a damp wood green -- and it also puts snow
  // on the TREES above the line for the first time, because it is one uniform
  // for the whole world by design (see material.js).
  //
  // Both are CEILINGS. What a given prop wears is this scaled by where it stands
  // against its line, which is what rocks.syncBands set from the terrain's own
  // snow band a few lines up.
  setSnow(1)
  setMoss(0.85)
  // How unevenly each of the two is spread from one rock to the next is NOT set
  // here: both ranges are stone-only knobs and Rocks.syncBands owns them, a few
  // lines up. Setting them here as well would just be a second place to forget
  // to change.

  // ONE loadImageLayers for all three, and the bakes hang off the same promise.
  // Separate calls would be separate decodes of the same PNGs into the same
  // atlas.
  loadImageLayers(propTextures).then(() => {
    propLayersReady = true
    const baked = trees.bakeCards(renderer)
    if (ferns) ferns.bakeCards(renderer)
    if (grass) grass.bakeCards(renderer)
    mushrooms.bakeCards(renderer)
    // Dead wood wears the TREES' bark PNGs, so this bake genuinely has to be
    // inside this promise and not merely conventionally: run before the decode
    // and it would photograph the procedural fallback bark into the two cards.
    deadwood.bakeCards(renderer)
    // The rock cards: one photograph per SHAPE in the bank, the boulder and the
    // cap. Unlike the four above this is not a method on the scatter, because
    // there is nothing per-bed about it -- a bed picks a shape and the shape's
    // picture serves every bed that picked it, so it lives on the bank. See
    // ROCK_CARD_SEED in props/rock-bank.js for the seeds and why they are pinned.
    const rockCards = bakeRockImpostor(renderer, propTextures)
    // The four strewn-pebble patches. Same rig as the impostors above and the
    // same reason for being here rather than on disk -- see props/litter.js.
    const lit = bakeLitterSet(renderer, propTextures)
    // Printed with the band they are supposed to land in, because a number with
    // nothing to be read against is not a measurement. Over the band means
    // something is lighting the stones twice; under it means the patch is dark
    // grit rather than stones. See LITTER_KEY in props/litter.js.
    console.log(
      'litter patches baked (luma want 0.50-0.56, cover want ~0.45):',
      lit.map((b, i) => `#${i} luma ${b.meanLuma.toFixed(3)} cover ${b.coverage.toFixed(3)}`).join(', ')
    )
    // The one measurement that says whether the impostor bake rig is aimed
    // right, and there is nowhere else it can be taken: the bake needs a live
    // renderer, so no node gate can reach it. See BAKE_KEY in props/impostor.js
    // for what these numbers are supposed to be.
    console.log(
      'tree impostors baked:',
      baked.map((b) => `${b.species} luma ${b.meanLuma.toFixed(3)} cover ${b.coverage.toFixed(3)}`).join(', ')
    )
    // Same instrument, same reason. A rock card is a grey blob, which makes
    // coverage the number that matters more than luma here: it says how much of
    // the quad is stone rather than hole, and a card whose coverage collapses is
    // a distant boulder that has become a rectangle of sky.
    console.log(
      'rock impostors baked:',
      rockCards
        .map((b) => `${b.name} luma ${b.meanLuma.toFixed(3)} cover ${b.coverage.toFixed(3)} layer ${b.layer}`)
        .join(', ')
    )
  })

  if (!QUEST_MODE) editor = new Editor({
    scene,
    camera,
    renderer,
    layers,
    height,
    markers,
    terrain,
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
  const isVisible = editor ? (kind, id, index) => editor.isVisible(kind, id, index) : () => true
  markers.setVisibility(isVisible)
  waterSurfaces.setVisibility(isVisible)
  roads.setVisibility(isVisible)

  if (!QUEST_MODE) panel = new Panel({ layers, editor, relief, hotkeys: HOTKEYS, onTool, onAction, onRelief })

  if (QUEST_MODE) {
    // Each layer starts where its toggle says, READ FROM THE TOGGLE rather than
    // from a literal, so a changed default takes effect instead of leaving the
    // panel claiming a layer is on while the world shows none.
    // litter/mushrooms/deadwood share the one `litter` row -- see
    // QUEST_TOGGLE_ROWS -- and are always constructed either way, because
    // mushrooms anchors onto placed trees and rocks whether it is drawn or not.
    terrain.batch.visible = questToggles.terrain
    trees.batch.visible = questToggles.trees
    trees.setCardsOnly(!questToggles.treeTiers)
    trees.setCutout(questToggles.treeCutout)
    rocks.beds.forEach((b) => { b.batch.visible = questToggles.rocks })
    grass.batch.visible = questToggles.grass
    ferns.meshes.forEach((m) => { m.visible = questToggles.ferns })
    water.group.visible = questToggles.water
    water.setCubeReflections(questToggles.reflections)
    litter.batch.visible = questToggles.litter
    mushrooms.batch.visible = questToggles.litter
    deadwood.batch.visible = questToggles.litter
    // THE EDITOR OVERLAY, which had no business being in the headset and was the
    // single largest thing drawing before any layer is switched on. Markers is
    // three InstancedMeshes of authoring handles -- 96 triangles a spline point,
    // 8 a snow point, 168 a lake -- and the shipped document carries 37 river
    // points, 77 snow points and 2 lakes, so it is ~4.5k triangles and 3 draw
    // calls per eye of pure editor furniture.
    //
    // Worse, it was drawing them WRONG. Markers.update() writes the instance
    // matrices and its only caller is `editor.update`, which quest mode never
    // runs because it has no editor -- so every handle sat at the origin at unit
    // scale, and the material is depthTest:false, so they drew over the world
    // from wherever the camera was. That is the speck at the horizon.
    markers.group.visible = false
    // The quadtree's own header says the XR route wants 4.0 degrees or coarser
    // and that 3.0 -- the desktop default this route was inheriting -- spends
    // 91% of terrain's whole triangle share, against 68% at 4.0. Quest mode was
    // running the desktop budget on a mobile GPU.
    //
    // 5.72 rather than 4.0: measured over a 48-camera walking sweep of the real
    // heightmap, worst-case selection is 262 leaves at 4.0 against 175 at 5.72,
    // which is 335k triangles against 224k before any culling. The ceiling is
    // MAX_TRI_DEG = atan(2 / CHUNK_RES) = 7.125 degrees, where the range floor in
    // the split rule stops the rule from refining at all.
    LOD.triDeg = Math.min(MAX_TRI_DEG, 5.72)
    // The yaw cull that replaces per-instance frustum culling on this route. See
    // the banner on applyBatchCulling for why the GPU-side one is off here, and
    // TerrainV2.cullDeg for why doing it in the visibility sweep is free -- that
    // loop was already running this test for a stats readout. Worst case over the
    // same sweep: 224k submitted becomes 108k.
    terrain.cullDeg = (70 * Math.PI) / 180
    // The 8 m chunk floor is NOT set here. It was, briefly, and it is config.js's
    // MAX_DEPTH now: one world, one cap, desktop and headset alike. See the note
    // on that constant for why a per-route override was the wrong trade.
    applyBatchCulling()
    buildQuestPanel()
    logSceneCensus()
  }

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
 * nothing to autosave, no undo entry, and no layer rebake. Water and roads are
 * untouched for the same reason -- both are authored surfaces at authored
 * elevations, and a lake does not move because the hillside beside it grew a
 * crag. That is deliberate rather than an oversight: relief is gated off flat,
 * concave ground precisely so that it cannot walk a river out of its bed.
 */
function onRelief(next) {
  const want = normalizeRelief(next)
  if (sameRelief(want, relief)) return
  relief = want
  localStorage.setItem(RELIEF_KEY, JSON.stringify(relief))

  const t0 = performance.now()
  height.setRelief(relief)
  const fieldMs = performance.now() - t0
  terrain.setRelief(relief)

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
  if (litter) litter.place(cx, cz)
  // LAST, and after rocks specifically, for the reason given where mushrooms
  // are constructed: a clump is placed against the trees and rocks that are
  // already standing, so re-placing it before they have moved onto the new
  // relief would anchor it to the old world.
  if (mushrooms) {
    mushrooms.syncSnowLine(layers)
    mushrooms.place(cx, cz)
  }
  if (deadwood) {
    deadwood.syncSnowLine(layers)
    deadwood.place(cx, cz)
  }

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
// side of the graph only: A-Frame's own entities (the laser-controls lines, and
// the controller models once a controller connects) live in the same scene and
// are counted like anything else, which is the point -- they are draw calls too.
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
    const index = geo.getIndex()
    const position = geo.getAttribute('position')
    if (!index && !position) throw new Error(`scene census: ${o.name || o.type} is a mesh with neither an index nor a position attribute`)
    const verts = index ? index.count : position.count
    const instances = o.isInstancedMesh ? o.count : 1
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

// Built on first press rather than at boot, so a session that never touches the
// `landscape shader` row never compiles a program it does not look at. The
// plain rung is keyed by whether it carries caustics -- see plainTerrainRung.
const builtPlainTerrain = new Map()
const builtTerrainVariants = new Map()

// THREE RUNGS, and `plain` IS NOW THE ONE THAT SHIPS -- the other two are what
// it is measured against and what it would cost to go back.
//
// The question this row exists to answer: when the headset sits at 50-60 fps
// instead of 90, triangles are rarely what an Adreno 650 is struggling with --
// 7 Mpixel a frame at 72 Hz is 506 Mpix/s of fill against 7.3 M tri/s of setup,
// two orders apart. So either the ground is fill bound in the FRAGMENT shader or
// it is not, and nothing about the triangle count can tell you which. It IS.
//
// MEASURED on a Quest 2 under medium load, walking the four rungs that used to
// live here: full 46 fps (21.7 ms), lo-fi 57 (17.5), lean 60 (16.7), plain 73
// (13.7). Lean beat lo-fi on both cost and looks, and full bought nothing the
// headset could see, so both middle rungs are gone and `lean` is now what
// TerrainV2 compiles at boot. terrain-material.js still holds the full source --
// the /gen-* benches and the gates compile it.
//
// `plain` swaps nothing else -- same BatchedMesh, same slots, same selection,
// same draw calls, same vertex colours, same Gouraud lighting -- which is what
// made it a clean control and is now what makes it a cheap default: the 2.74 ms
// between it and `axis` is exactly terrain-material.js's fragment patch, and
// there is nothing else in the swap to give back. It is NOT MeshBasicMaterial,
// though "flat colour" is what it would give: Lambert's fragment shader is
// vColor times an already-interpolated irradiance plus fog, a handful of
// instructions, so Basic would buy a rounding error and stop the ground being
// lit. See createPlainTerrainMaterial for the two exposure stages it does keep
// and why they are in the VERTEX shader.
//
// `axis` is what TerrainV2 still compiles at boot, and it has to: the depth
// material and TerrainTint both hold its uniforms. It is simply not what the
// BatchedMesh draws with. `grain` is one quality rung below it: same projection,
// but the near block cut to the speckle and the relief normals, dropping the dirt
// and moss mixes and the colour guard that wrapped them.
//
// THE LADDER THAT SETTLED IT, on a Quest 2 under load from trees and ferns, three
// cycles agreeing: lean 53 fps (18.87 ms), axis 53, near block folded away 57
// (17.54), plain 62 (16.13). Read as time, the terrain shader is 2.74 ms, of which
// the entire near block is 1.33 and everything else -- the far-field colour chain,
// the lighting patch, the two varyings and the vertex-stage macro fetch -- is
// 1.41. Two conclusions worth keeping: the near block is HALF the gap, so no trim
// inside it can ever pay more than 1.33 ms; and axis matching lean exactly, while
// removing 3 of 4 fetches and the only divergent fetch-gating branch, says the
// near field is neither fetch bound nor branch bound.
//
// AND THE WHOLE ROW IS 2.74 ms OF A 7.76 ms OVERSPEND against 90 fps. Deleting the
// terrain shader outright lands at 62, so the rest is props. That is why this
// stops at two rungs, and why the 2.74 was eventually taken.
//
// FIRST ENTRY IS THE DEFAULT, and the row still cycles all three -- what it costs
// to put the near field back is the thing this is read for.
const TERRAIN_SHADERS = ['plain', 'axis', 'grain']
let terrainShaderMode = 0

/**
 * One of the compiled rungs, built on first press and kept.
 *
 * PATCHED, like the boot material and unlike `plain`. Each of these has to carry
 * the night lift, the shadow lookup and the aerial ramp or pressing the row would
 * change the time of day as well as the surface. Each
 * takes its own cache key, because three keys its program cache on that string
 * alone and the variants compile different source.
 *
 * The atlas goes in the way TerrainV2 passes it, even though every one of these
 * flags wins over it inside the factory and no tile is sampled -- same shape as
 * that call, so the two cannot drift apart.
 *
 * No uniform sync needed: nothing writes the terrain material's own uniforms
 * after construction, so a variant's defaults are the numbers the boot material
 * is still holding. The only live uniforms are lighting.patch's, and patch() is
 * what subscribes a material to them.
 */
function terrainVariant(mode) {
  let mat = builtTerrainVariants.get(mode)
  if (!mat) {
    mat = createTerrainMaterial({ atlas: propTextures, [mode]: true })
    lighting.patch(mat, {
      mode: 'fragment', cacheKey: `v2-terrain-shadow-${mode}`, worldPosVarying: 'vWorldPos',
    })
    builtTerrainVariants.set(mode, mat)
  }
  return mat
}

/**
 * The plain rung, dry or wet, built once each and kept.
 *
 * PATCHED IN VERTEX MODE, which is the whole difference between this rung being
 * a control and being shippable. Unpatched it had no aerial ramp, so distant
 * mountains faded to flat white fogColor -- the opposite of what air does, which
 * is to go blue with depth. It also had no night lift and no terrain shadow, so
 * it was wrong twice more at dusk.
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
  let mat = builtPlainTerrain.get(wet)
  if (!mat) {
    mat = createPlainTerrainMaterial(terrain.material)
    lighting.patch(mat, {
      mode: 'vertex', cacheKey: `v2-terrain-shadow-plain${wet ? '-wet' : ''}`, caustics: wet,
    })
    builtPlainTerrain.set(wet, mat)
  }
  return mat
}

function terrainShaderMaterial() {
  const mode = TERRAIN_SHADERS[terrainShaderMode]
  if (mode === 'axis') return terrain.material
  if (mode !== 'plain') return terrainVariant(mode)
  return plainTerrainRung(causticsArmed)
}

function cycleTerrainShader() {
  terrainShaderMode = (terrainShaderMode + 1) % TERRAIN_SHADERS.length
  applyTerrainShader()
}

/**
 * Put the selected rung on the mesh, and tell TerrainTint which chain the ground
 * is now being drawn through so newly placed clumps are painted the colour of the
 * ground they are standing in. Beds already on screen keep the colour they were
 * given until their tiles recycle -- see TerrainTint's constructor.
 */
function applyTerrainShader() {
  const mode = TERRAIN_SHADERS[terrainShaderMode]
  terrain.batch.material = terrainShaderMaterial()
  terrainTint.setChain(mode === 'plain' ? 'plain' : 'shader')
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
  KeyN: 'timeSkip',
  KeyP: 'auroraPattern',
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
      { keys: 'up / down', what: 'walk forward and back' },
      { keys: 'left / right', what: 'turn on the spot' },
      { keys: 'space', what: 'start flying, and hold to climb' },
      { keys: 'space space', what: 'double-tap to stop flying and land' },
      { keys: 'shift', what: 'fly down while flying' },
      { keys: 'u', what: 'unstick: hop to the nearest walkable ground when wedged on a slope' },
    ],
  },
  {
    group: 'world',
    rows: [
      { keys: 'n', what: `skip time forward ${CLOCK.skipHours} hours` },
      { keys: 'p', what: 'cycle the aurora pattern' },
      { keys: 'm', what: 'swap the grass bed between scattered strips and card clumps' },
      { keys: 'h', what: 'hide and show this panel' },
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
      { keys: 'tab', what: 'arm and disarm the editor' },
      { keys: `${TOOL_KEYS.join(' ')}`, what: `arm a tool: ${TOOLS.join(', ')}` },
      // G/R/S are the editor's only while a gizmo is attached -- see the
      // key-conflict note at the top of editor.js. With nothing selected, S is
      // still walk-backward.
      { keys: 'g r s', what: 'gizmo move, rotate, scale -- only with something selected' },
      { keys: 'x y z', what: 'constrain the gizmo to one axis, same key again to release' },
      { keys: 'enter', what: 'finish the river or road being drawn' },
      { keys: 'esc', what: 'cancel the path being drawn, else deselect; also closes this list' },
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

// The `!isPresenting` guard is LOCOMOTION's comfort rule -- free flight with no
// ground reference is a nausea generator and §12 puts comfort over capability.
// Quest mode is exempt, and deliberately so: it is a profiling route, not the
// game. The whole point of it is to stand somewhere specific and look at one
// layer's cost, and at 1.45 m/s the far side of an 8 km world is unreachable
// inside a session. If quest mode ever stops being a lab and becomes something
// a player is handed, this exemption is the line to delete.
function setFlying(want) {
  player.setFlying(want && (QUEST_MODE || !renderer.xr.isPresenting))
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

// --- the grass knobs, on the panel because grass is the layer under suspicion --
//
// WHAT THESE FOUR ARE FOR, and it is worth being blunt because they do not cost
// the same thing. Measured on the settled bed, the fill a grass card costs goes
// as its facing area over its distance squared, and that puts 53% of the whole
// bed's fill inside FIVE METRES and 70% inside ten. So:
//
//   REACH is nearly free to cut and nearly worthless. Going from 70 m to 20 m
//   drops 72% of the instances and 17% of the fill. It is the right knob if the
//   bed is ever CPU-bound on its scatter, and the wrong one if it is fill-bound.
//
//   DENSITY scales every ring at once, so half the density is half of both the
//   fill and the instances. It moves the number on every bed.
//
//   BLADES PER CLUMP is the blade bed's only knob that moves the geometry
//   WITHOUT moving the instance count, which is what makes the pair of it and
//   density a proper experiment rather than two ways of asking for less grass.
//
//   SCATTER STEP is not a knob at all but an ablation -- see the row.
//
// The first three rebuild rather than reconfigure -- the pool, the tile
// candidate count, the clump geometry and the material's compiled ramp all
// depend on them -- so each costs a hitch on the frame it is pressed. See
// buildGrass.
// A BED PER CYCLE, because the same number buys a different bill on each: a card
// is two triangles out to 70 m, a blade clump is ten out to 30 m. A shared list
// would step one of them off the end of its own useful range on the first press.
// Each rung rebuilds the pool from the density, so 24/m2 is a real bed and not a
// clamp against the shipped pool.
const GRASS_DENSITY_CYCLE = {
  cards: [6, 3, 1.5, 0.75],
  blades: [8, 12, 24, 4],
}
const GRASS_RADIUS_CYCLE = {
  cards: [70, 40, 25, 15],
  blades: [30, 20, 12, 8],
}

// TRIANGLES PER CLUMP, and the blade bed's sharpest measured lever. It moves
// triangles, vertices and per-vertex instance-attribute fetch together while
// leaving the instance count, the pool, the draw call and the CPU sweep exactly
// where they were -- which is what makes it the clean read that blade SIZE was
// not. Halving height and width, a 4x cut in projected area, changed the frame
// by nothing; halving this one does show up.
//
// Paired with the density row it separates per-vertex cost from per-instance
// cost outright: 5 blades at 24/m2 draws the same triangles as 10 at 12 and
// twice the instances, so whatever moves between those two settings is the
// arena's and not the geometry's.
//
// Cards have no such knob -- a billboard is two triangles whatever you ask for
// -- so the row REFUSES rather than being given a second meaning. Stepping a
// card bed here would park a blade count in grassOpts that nothing applies until
// the next style swap, and then the bed would come back changed for no reason
// the wearer pressed.
const GRASS_BLADE_CYCLE = [10, 5, 20]

// The exponent p in the blade bed's thinning law -- see _keepAt in
// render/grass.js. Cards are on 1 and have no reason not to be: their far field
// is already the cheap end of the bed. What this row is for is the blade bed,
// where the question is how hard the far field can be cut before the ground
// reads as bare. 3 IS THE HARD END AND THE ROW DOES NOT GO PAST IT: a steeper
// exponent does cut triangles, and triangles are the bed's cost, but it buys
// them by emptying ground the player can see. A distance card was the other way
// to spend the far field and it was rejected on look -- see the header of
// props/grass-blades.js.
const GRASS_FALLOFF_CYCLE = [3, 2, 1.5, 1]

// The live overrides, carried across every rebuild so the three grass rows
// compose. Without this, changing the reach would silently restore the shipped
// density, and the wearer would read the frame-time change as the reach's.
const grassOpts = {}

function rebuildGrass(patch) {
  Object.assign(grassOpts, patch)
  player.headPosition(headTmp)
  buildGrass(grassStyle, headTmp.x, headTmp.z, grassOpts)
}

/**
 * Step a cycle from wherever the bed currently sits. A value that is not on the
 * list -- which is what a style swap leaves behind -- lands on the list's head,
 * so the row always goes somewhere sensible rather than nowhere.
 */
function stepCycle(list, now) {
  const i = list.findIndex((v) => Math.abs(v - now) < 1e-6)
  return i < 0 ? list[0] : list[(i + 1) % list.length]
}

function grassCycle(table) {
  return grassStyle === 'blades' ? table.blades : table.cards
}

function cycleGrassDensity() {
  const list = grassCycle(GRASS_DENSITY_CYCLE)
  rebuildGrass({ density: stepCycle(list, grass ? grass.density : NaN) })
}

function cycleGrassBlades() {
  if (grassStyle !== 'blades') {
    console.log(`[v2] blades per clump is a blade-bed knob; the bed is '${grassStyle}'`)
    return
  }
  rebuildGrass({ bladeCount: stepCycle(GRASS_BLADE_CYCLE, grass.bladeCount) })
}

function cycleGrassRadius() {
  const list = grassCycle(GRASS_RADIUS_CYCLE)
  rebuildGrass({ radius: stepCycle(list, grass ? grass.radius : NaN) })
}

function cycleGrassFalloff() {
  rebuildGrass({ falloff: stepCycle(GRASS_FALLOFF_CYCLE, grass ? grass.falloff : NaN) })
}

// --- the tree knobs, and WHY THERE ARE THREE OF THEM -------------------------
//
// The forest's per-frame bill has two halves that the shipped numbers move
// together, and these rows exist to pull them apart on the headset:
//
//   REACH moves BOTH. Resident tiles go as the radius SQUARED -- 1500 m is
//   ~11,300 of them, and `update` walks every one every frame whether or not
//   anything about it has changed -- while INSTANCES go as the radius linearly,
//   because of the graded thinning. Halving the reach quarters the tile walk and
//   halves the billboards.
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
    `(${ts.density}/m^2 to ${ts.fullRadius} m, thinning ^${ts.falloff} to ${ts.radius} m, ` +
    `pool ${ts.used}/${ts.pool})`
  )
}

addEventListener('keydown', (e) => {
  if (!ready || typing(e)) return

  // Escape opens and closes the quest menu, the keyboard twin of B / Y. On a
  // desktop there is no controller to press, and `?quest` is regularly driven
  // from a laptop -- so without this the menu is unreachable. Gated on
  // QUEST_MODE so Escape keeps whatever it means to the editor in the normal
  // route, where this menu does not exist.
  if (QUEST_MODE && e.code === 'Escape') {
    toggleQuestPanel()
    return
  }

  // Tab arms and disarms the editor. A dedicated key rather than a mode that is
  // always on, because an armed lake tool turns every stray click on the ground
  // into a lake -- and because G/R/S mean two different things depending on this
  // flag (see the key-conflict note in editor.js).
  if (e.code === 'Tab') {
    e.preventDefault()
    if (editor && panel) {
      editor.setActive(!editor.active)
      panel.syncSelection()
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
  if (fresh.includes('auroraPattern')) cycleAurora()
  // M cycles the three grass beds in place, under the player's feet, so they can
  // be judged against the same hillside in the same light. Rebuilding a bed is
  // ~100 ms of one frame; a swap is not something a player does.
  if (fresh.includes('grassStyle')) {
    player.headPosition(headTmp)
    // Through grassOpts so a style swap keeps whatever density and reach the
    // panel has set: the two beds are only comparable at the same numbers.
    if (grass) {
      const next = GRASS_STYLES[(GRASS_STYLES.indexOf(grassStyle) + 1) % GRASS_STYLES.length]
      buildGrass(next, headTmp.x, headTmp.z, grassOpts)
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

/**
 * The `terrain & prop lighting` row, both halves of it.
 *
 * TWO HALVES BECAUSE THERE ARE TWO COSTS, and only one of them is ours to
 * compile out. lighting.setEnabled rebuilds every lit material in the world
 * with the shadow lookup, the night lift, the near-field envelope, the aerial
 * ramp and the caustics ABSENT, so the A/B against on is this system's price in
 * milliseconds and nothing else. The rig is the other half: applySky's writes
 * of sun and hemi stop, so this restates the fixed noon-ish one the two lights
 * were constructed with. Without that restore, "off" leaves the palette's last
 * answer standing in both lights and the row reads as having done nothing --
 * which is what it did for its whole life before this.
 */
function setLightingEnabled(enabled) {
  lighting.setEnabled(enabled)
  if (enabled) return
  sun.position.copy(FIXED_RIG.sunDir)
  sun.color.setHex(FIXED_RIG.sunColor)
  sun.intensity = FIXED_RIG.sunIntensity
  hemi.color.setHex(FIXED_RIG.hemiSky)
  hemi.groundColor.setHex(FIXED_RIG.hemiGround)
  hemi.intensity = FIXED_RIG.hemiIntensity
}

// Unchanged from v1, ordering included. The comments there explain each step;
// what matters when reading this file is that the order is a dependency chain
// and not a list: lighting writes the night terms the water reads, sky.update
// writes the reflection the water bends, and hemi is set before water.update
// because it is the ambient the water's silhouettes are matched to.
function applySky(state, head, elapsedReal) {
  // Gated in quest mode like every other layer, so the sun/hemi lights and the
  // WorldLighting shader patch (the day/night shading terrain, trees, rocks etc.
  // all read) can be isolated from the rest of the atmosphere (fog/background/
  // sky dome, which stay always-on below). setLightingEnabled owns the other
  // half of the row and is where the isolation is actually paid for.
  if (!QUEST_MODE || questToggles.lighting) {
    sun.position.set(state.lightDir.x, state.lightDir.y, state.lightDir.z)
    setSRGB(sun.color, state.lightColor)
    sun.intensity = state.lightIntensity

    setSRGB(hemi.color, state.hemiSky)
    setSRGB(hemi.groundColor, state.hemiGround)
    hemi.intensity = state.hemiIntensity

    lighting.update(state)
  }

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
  if (!QUEST_MODE || questToggles.dayNight) stars.update(head, state, clock.elapsed, elapsedReal)
  if (!QUEST_MODE || questToggles.aurora) aurora.update(head, state, elapsedReal)
  if (!QUEST_MODE || questToggles.water) water.update(elapsedReal, hemi)

  // LAST, and that is the whole of its plumbing. Everything above writes the
  // world as seen through air, straight from the palette; this overwrites the
  // half-dozen values that are not true underwater. Being the later writer
  // rather than a branch inside each of them is what keeps it to one function:
  // there is no mode for anything above to know about, no flag to leave set,
  // and surfacing is simply the frame where it stops overwriting.
  applySubmersion(head, elapsedReal, state)
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
  const level = waterSurfaces === null ? null : waterSurfaces.levelAt(head.x, head.z, true)
  submerged = level !== null && head.y < level
  // Kept for the panel, which is the only way to see the two numbers this rule
  // compares from inside a headset. The surfaces are drawn flat at exactly the
  // y this returns -- there is no vertex displacement in the water shader -- so
  // eye and level meeting anywhere other than at the visible waterline is a
  // disagreement worth reading off rather than guessing at.
  eyeY = head.y
  waterY = level

  water.setSubmerged(submerged)

  // THE RUNG SWAP, which is what gives the shipping ground a net at all: `plain`
  // is patched in vertex mode and only its wet build emits CAUSTIC_APPLY. Done
  // on the TRANSITION and not every frame, and it reaches the mesh through
  // applyTerrainShader so that the two upper rungs -- already fragment-patched,
  // already causticked -- are left alone by it.
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
  //
  // DAYNESS is the sun's own elevation on the ramp the moonlight uses in
  // reverse, and it is the sun's rather than `state.lightIntensity` because
  // that number swaps bodies at -6 degrees: read it instead and the net would
  // brighten at nightfall as the moon took over. -6 to +4 puts the whole
  // handover inside civil twilight, where the light is visibly changing anyway.
  const dayness = Math.max(0, Math.min(1, (state.sun.elevDeg + 6) / 10))
  const causticGain = UNDERWATER.caustic * (UNDERWATER.causticNight + (1 - UNDERWATER.causticNight) * dayness)
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
    // of the three that does not decide its own visibility every frame. In
    // quest mode the day/night toggle owns this instead of a bare `true`,
    // since she can't be submerged while the (default-off) water toggle is
    // off but this still runs every frame.
    sky.mesh.visible = !QUEST_MODE || questToggles.dayNight
    return
  }

  sinkAir()
}

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

// The pair handed to the world probe while she is under. Held at module scope
// with the frame's clock state in a slot rather than built per frame, so a
// swim allocates nothing.
const airHook = {
  state: null,
  enter: () => liftAir(airHook.state),
  leave: sinkAir,
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
const moveInput = { move: 0, strafe: 0, lift: 0, turn: 0, unstick: false, instant: false, flyDirection: null }
const headTmp = new THREE.Vector3()

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
//   A / X             toggle fly. Flying steers off whichever HAND is pushing
//                     its stick, wherever that hand points.
//   B / Y             recall the toggle panel to where you are standing
//   grips             NOTHING. See below.
//
// GRIPS DO NOTHING, ON PURPOSE. They used to carry +5 hours and panel-recall,
// and a grip is the button a hand presses by accident just holding a controller
// -- so the sky would lurch five hours forward while you were reaching for
// something. A binding you fire without meaning to is worse than no binding.
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
 * the same objects -- but quest mode does not own the session (A-Frame does),
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

// Teleport. Armed by pushing the right stick forward, fired on release -- the
// Quest system convention, so it needs no explanation in the headset.
const QUEST_TELEPORT_ARM = 0.7
const QUEST_TELEPORT_FIRE = 0.35
const QUEST_TELEPORT_RANGE = 250
let questTeleportArmed = false
let questTeleportMarker = null
const questTeleportTarget = { x: 0, z: 0, valid: false }
const questHandPos = new THREE.Vector3()
const questHandDir = new THREE.Vector3()
const questFlyDir = new THREE.Vector3()

function questTeleportAim(hand) {
  // Aimed down the HAND THAT IS PUSHING THE STICK, not the gaze. Marching the
  // head ray would make the destination move whenever she looked around while
  // holding the stick, and would put it wherever she happened to be reading the
  // panel. Taking it off the pushing hand is what keeps the two mirrored.
  hand.getWorldPosition(questHandPos)
  hand.getWorldQuaternion(questTempQuat)
  questHandDir.set(0, 0, -1).applyQuaternion(questTempQuat)
  // The march walks the exact height FIELD, not the meshed chunk, so it lands
  // in the same place whether or not the terrain layer is even switched on --
  // which it usually is not, in the mode this panel exists for.
  const hit = raymarchGround(height, questHandPos, questHandDir, { maxDist: QUEST_TELEPORT_RANGE })
  questTeleportTarget.valid = !!hit
  if (hit) {
    questTeleportTarget.x = hit.x
    questTeleportTarget.z = hit.z
    if (!questTeleportMarker) {
      questTeleportMarker = new THREE.Mesh(
        new THREE.RingGeometry(0.28, 0.42, 28),
        new THREE.MeshBasicMaterial({ color: 0x7fd7ff, toneMapped: false, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false })
      )
      questTeleportMarker.rotation.x = -Math.PI / 2
      questTeleportMarker.renderOrder = 998
      scene.add(questTeleportMarker)
    }
    questTeleportMarker.position.set(hit.x, hit.y + 0.05, hit.z)
  }
  if (questTeleportMarker) questTeleportMarker.visible = questTeleportTarget.valid
}

function readInput() {
  const st = input.update()
  questInputSource = st.connected > 0 ? 'xr' : 'none'
  // Only when the direct poll came up empty: when it works it is the shorter
  // path and it is the one normal (non-quest) XR uses too.
  if (st.connected === 0 && QUEST_MODE) {
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

    // Mirrored, and NOTHING on the grips. +5h and aurora-cycle moved to the
    // panel, where they cannot go off in your hand.
    if (st.left.buttons.SECONDARY?.justPressed || st.right.buttons.SECONDARY?.justPressed) toggleQuestPanel()
    if (st.left.buttons.STICK?.justPressed || st.right.buttons.STICK?.justPressed) player.recenterXR(renderer)
    if (st.left.buttons.PRIMARY?.justPressed || st.right.buttons.PRIMARY?.justPressed) {
      setFlying(!player.flying)
    }

    if (player.flying) {
      moveHand.getWorldQuaternion(questTempQuat)
      questFlyDir.set(0, 0, -1).applyQuaternion(questTempQuat).normalize()
      moveInput.flyDirection = questFlyDir
      if (questTeleportMarker) questTeleportMarker.visible = false
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
      questTeleportAim(moveHand)
    } else if (questTeleportArmed && push < QUEST_TELEPORT_FIRE) {
      questTeleportArmed = false
      if (questTeleportMarker) questTeleportMarker.visible = false
      if (questTeleportTarget.valid) player.teleportTo(questTeleportTarget.x, questTeleportTarget.z)
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
  const bySys = { mushroom: mushrooms, fern: ferns, deadwood: deadwood, rock: rocks, tree: trees }
  boundPicks = []
  for (const p of CURSOR_PICKS) {
    const sys = bySys[p.label]
    if (!sys) {
      // Quest mode deliberately omits some presentation-only scatters. They
      // have no pick source, so leave them out of the cursor list as well.
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
  const info = renderer.info
  const st = terrain.stats
  const h = height.heightAt(headTmp.x, headTmp.z)
  const cursor = cursorPick()
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

  if (!ready) {
    if (!QUEST_MODE) renderer.render(scene, camera)
    return
  }

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
  //
  // Identical in quest mode -- quest mode only differs by which layers are
  // visible (the toggle panel below), never by how she moves.
  swayStrength = THREE.MathUtils.clamp(swayStrength + (submerged ? dt : -dt) / CURRENT.ease, 0, 1)
  currentDrift(now / 1000, swayStrength, swayWant)
  player.rig.position.x += swayWant.x - swayApplied.x
  player.rig.position.z += swayWant.z - swayApplied.z
  swayApplied.copy(swayWant)

  player.update(dt, moveInput)

  if (QUEST_MODE) updateQuestPanel()

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
  const [pose, hands] = currentPose()
  netplay.sendPose(pose, hands, now)
  netplay.update(now)
  // Altitude and gaze both feed the split rule: y makes the range term 3D and
  // yaw is what stops two thirds of the slot pool going to terrain behind her.
  if (!QUEST_MODE || questToggles.terrain) {
    terrain.update({ x: headTmp.x, y: headTmp.y, z: headTmp.z, yaw: player.headYaw() })
  }
  // Rocks first, and it is the same hard ordering the construction has: the tree,
  // fern, grass and litter scatters all ask the stone where it is before they
  // place anything, so a tile of stone has to be grown before the tile of wood
  // over it. `rocks.update` is called whatever the quest toggle says -- the
  // toggle hides the batches, and a hidden boulder still displaces a tree.
  rocks.update(headTmp.x, headTmp.y, headTmp.z)
  if (!QUEST_MODE || questToggles.trees) trees.update(headTmp.x, headTmp.y, headTmp.z)
  if (!QUEST_MODE || questToggles.ferns) ferns.update(headTmp.x, headTmp.y, headTmp.z)
  // TWO ROWS, ONE LAYER, and the split is the whole point: `grass` hides the
  // batch and `grassUpdate` stops the per-frame CPU work, so pressing them one
  // at a time says which half of the bed's frame time is the DRAW and which is
  // the scatter's own bookkeeping -- the tile walk, the rim sweep and the
  // attribute uploads they trigger. Gated on `grass` too, because a bed nobody
  // is drawing has nothing to keep current.
  if (!QUEST_MODE || (questToggles.grass && questToggles.grassUpdate)) {
    grass.update(headTmp.x, headTmp.y, headTmp.z)
  }
  // litter/mushrooms/deadwood aren't among the 9 requested toggles -- always
  // updated (they're the cheapest layers in the world; see their own
  // headers), just permanently hidden in quest mode with no button to show them.
  litter.update(headTmp.x, headTmp.y, headTmp.z)
  // After rocks, and for the same reason the construction and the relief
  // re-place are: a clump follows the anchors, so it wants them stepped first.
  mushrooms.update(headTmp.x, headTmp.y, headTmp.z)
  deadwood.update(headTmp.x, headTmp.y, headTmp.z)

  clock.advance(dt)
  // Held in a local because the world probe wants it too: the capture is taken
  // in air even while she is under, and putting the air back for that one face
  // means restating this hour's palette. See airHook.
  const state = clock.state()
  applySky(state, headTmp, now / 1000)

  // BEFORE the render, and it must be the only caller of markers.update(): the
  // handles are scaled to hold a constant angular size, so a second call with a
  // different camera would size them for a frame nobody is looking through.
  if (editor) editor.update(dt, camera)

  if (now - lastPanelAt >= 250) {
    lastPanelAt = now
    if (panel) panel.setStats(panelStats())
    // The headset's equivalent of the desktop panel's stats block. Same 4 Hz,
    // and deliberately NOT panelStats() itself: that one calls cursorPick(),
    // which raymarches the height field and walks every scatter's instance
    // arrays -- a mouse-cursor readout, on a device with no mouse, costing
    // exactly the kind of CPU time this panel exists to hunt down.
    if (QUEST_MODE) updateQuestStats()
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
  if (!QUEST_MODE || questToggles.reflections) probe.update(renderer, scene, headTmp)
  // `waterY` is the surface she is at or nearest to, written by applySubmersion
  // earlier this same frame. It is a FLOOR on how low the capture may sit, not
  // the answer -- see WORLD_PROBE.duck, which is what stops a lake shore
  // capturing from inside the bank. `dt` drives the cross-fade and nothing else.
  // The air hook only while she is under, because that is the only time the
  // frame's atmosphere is not the one the capture wants.
  airHook.state = state
  if (!QUEST_MODE || questToggles.reflections) worldProbe.update(renderer, scene, headTmp, waterY, dt, submerged ? airHook : null)

  // A-Frame renders the scene itself after every registered component's tick()
  // runs (see the `v2-quest-tick` component below) -- calling renderer.render
  // here too would be a second render of the same frame.
  if (!QUEST_MODE) renderer.render(scene, camera)
}

if (QUEST_MODE) {
  // A-Frame drives its own render loop via component tick() methods, not
  // renderer.setAnimationLoop -- see quest-main.js's header for why calling
  // setAnimationLoop here would silently stop laser-controls (and any other
  // A-Frame component) from ticking at all.
  AFRAME.registerComponent('v2-quest-tick', { tick: () => tick() })
  sceneEl.setAttribute('v2-quest-tick', '')
} else {
  renderer.setAnimationLoop(tick)
}

// §18: editing is a desktop activity and the gizmo has no controller binding.
// Entering XR with a tool armed would leave a mode running that nothing in the
// headset can see, exit or undo.
renderer.xr.addEventListener('sessionstart', () => {
  if (!ready) return
  player.setFlying(false)
  if (editor) editor.setActive(false)
  if (panel) panel.syncSelection()
})

bootWorld().catch(reportRuntimeError)

})().catch(bootFail)
