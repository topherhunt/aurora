import * as THREE from 'three'
import { VRButton } from 'three/addons/webxr/VRButton.js'

import { HEIGHTMAP_URL, HEIGHTMAP_META_URL, SEED, WORLD_HALF } from './config.js'
import { Heightmap } from './height/heightmap.js'
import { V2Height } from './height/field.js'
import { RELIEF_DEFAULTS, normalizeRelief, sameRelief } from './height/relief.js'
import { Layers } from './layers/layers.js'
import { snowDefaults } from './layers/doc.js'
import { TerrainV2 } from './terrain/terrain-v2.js'
import { LOD, MIN_TRI_DEG, MAX_TRI_DEG } from './terrain/quadtree-v2.js'
import { SKYLINE } from './terrain/skyline.js'
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
import { Rocks } from './render/rocks.js'
import { Mushrooms } from './render/mushrooms.js'
import { Deadwood } from './render/deadwood.js'
import { Litter } from './render/litter.js'
import { buildTextureArray, loadImageLayers } from '../textures.js'
import { bakeLitterSet } from '../props/litter.js'
import { bakeRockImpostors } from '../props/rock-bank.js'
import { setSnow, setMoss, setPropClock, setStripTiling, getStripTiling } from '../material.js'

// v1 LEAF MODULES, shared on purpose (§18's shared list). Every one of these is
// about the SKY or about the BODY and neither depends on where the ground came
// from. What v2 must not import is v1's ANSWER to the ground question --
// sim/terrain-height.js and sim/phase-a.js -- and scripts/check-v2.mjs fails
// the build if it ever does. That is also why the spawn search below is
// rewritten here rather than imported from phase-a.js.
import { Player, LOCOMOTION } from '../player.js'
import { Sky } from '../sky.js'
import { Stars } from '../stars.js'
// v2's own aurora, not v1's band mesh. See the header of render/aurora.js: the
// field is integrated as a convolution on a 512x64 map once per frame instead of
// per pixel, which is what pays for a full sky dome. index.html still draws
// src/aurora.js and is untouched.
import { SkyAurora } from './render/aurora.js'
import { Water, UNDERWATER, CURRENT, currentDrift, murkDensity, murkLinear, murkAir } from '../water.js'
import { WorldClock, CLOCK } from '../clock.js'
import { WorldLighting } from '../lighting.js'
import { SkyProbe } from '../sky-probe.js'
import { WorldProbe } from '../world-probe.js'
import { Input } from '../input.js'
import { Netplay } from '../net.js'
import { PeerAvatars } from './render/avatar.js'

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
//   The prop scatter is TREES, GRASS, FERNS, ROCKS AND MUSHROOMS. The first
//   four are TILED, camera-following scatters that THIN WITH DISTANCE -- full
//   density inside 80 m for trees, 8 m for grass and 35 m for ferns, then
//   halving every time the distance doubles, out to 1.5 km, 70 m and 90 m
//   respectively. Those three are pure functions of position, so they cover the
//   whole map and the same plants come back when you walk away and return, and
//   the thinning is what makes a 1.5 km forest cost ~41k instances instead of
//   the 350k a uniform disc would need, a 3/m^2 grass bed 11k instead of 46k,
//   and a 0.5/m^2 fern bed ~9k instead of the 13k a 90 m disc would need. Grass
//   thins hardest of the three, and earliest, because it is the only one whose
//   bed is made of STRIPS -- see THE TWO STRATEGIES in render/grass.js. Each
//   instance also carries the distance at which it stops existing, and the prop
//   shader dissolves it over the last 15% of that, so the rim and the thinning
//   bands fade rather than pop. The plants' far tiers are camera-facing
//   billboards spun in the vertex shader; the rocks' is real geometry, because
//   a boulder photographed from the side has nothing to lean into. See the
//   headers of render/trees.js, render/grass.js, render/ferns.js and
//   render/rocks.js.
//
//   ROCKS RUN THREE OF THAT SAME SCATTER AT ONCE, because a pebble is 11 cm and
//   a summit fang is 7.5 m and no one density-and-radius pair can carry both:
//   an underfoot bed to 55 m, a boulder bed to 460 m and a giants bed to 1.25
//   km. What stands where is a function of the GROUND -- each site is classified
//   river / forest / cliff / peak, and that decides both which of the sixteen
//   variants may stand there and how many. Snow and moss then arrive from two
//   world lines running in opposite directions, so a rock on a summit is white,
//   the same rock in a damp wood is green, and neither costs a byte per
//   instance. See props/rock-bank.js for the sixteen and material.js for the
//   two lines.
//
//   MUSHROOMS ARE THE ONE LAYER THAT IS NOT A SCATTER OVER OPEN GROUND. A clump
//   grows at the foot of something, so where it goes is read back out of the
//   trees and the rocks that are ALREADY standing rather than rolled from
//   position alone. That is the whole reason this file builds, re-places and
//   steps them LAST everywhere -- see the note at their construction. They are
//   the cheapest layer in the world by a wide margin, a few thousand triangles
//   against the forest's 37k. See render/mushrooms.js.
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
const leftGrip = renderer.xr.getControllerGrip(0)
const rightGrip = renderer.xr.getControllerGrip(1)
rig.add(leftGrip, rightGrip)
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

// Which grass system is standing. 'strips' is how a REGION is grassed and is
// what stands here -- one flat card, metres wide, drawing the same cutout
// several times across itself, at a third of the triangles for more grass facing
// the camera. 'tufts' is the 3-card clump, which is the right answer for a
// grassy POINT and is stood up here as a whole carpet only so the two can be
// judged against the same hillside in the same light. See THE TWO STRATEGIES in
// the header of render/grass.js.
let grassStyle = 'strips'
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
  grass = new Grass(scene, height, waterSurfaces, layers.paths, propTextures, { seed: SEED, style, ...opts })
  // The cache key carries the style: the two materials compile DIFFERENT
  // programs (one billboards, one tiles), and a shared key would hand the second
  // one the first one's.
  lighting.patch(grass.material, { mode: 'vertex', cacheKey: `v2-grass-${style}` })
  grass.syncSnowLine(layers)
  grass.place(cx, cz)
  if (propLayersReady) grass.bakeCards(renderer)
  const gs = grass.stats
  const gr = gs.rejected
  console.log(
    `[v2] grass (${gs.style}) ${gs.placed} of ${gs.samples} placed over ${gs.tiles} tiles in ` +
    `${gs.placeMs.toFixed(0)} ms (${gs.density}/m^2 to ${gs.fullRadius} m, thinning to ` +
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
  // where it used to live: the terrain's rock surface wears LAYER.ROCK too, and
  // createTerrainMaterial decides at compile time whether to declare a sampler
  // at all, so it has to have the array in hand before the material exists.
  //
  // Building it early costs nothing. It is built empty and its image layers land
  // asynchronously (loadImageLayers, below); the bank and the batches do not wait
  // on them, so the world has trees and stone from the first frame wearing
  // whatever the procedural layers already hold.
  propTextures = buildTextureArray()
  terrain = new TerrainV2(scene, {
    heightmapRaw: heightmap.toRaw(), doc: layers.serialize(), relief, workers: 2, atlas: propTextures,
  })

  lighting.patch(terrain.material, {
    mode: 'fragment',
    // Bumped with the stone layer: the atlas variant compiles different source
    // and three keys its program cache on this string alone.
    cacheKey: 'v2-terrain-shadow-stone',
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

  // Trees. The atlas was built up at the terrain, above, because the terrain
  // needs it at material-compile time. The card BAKE does wait on the image
  // layers landing, because a photograph taken before the bark has loaded would
  // be a photograph of nothing -- see Trees.bakeCards.
  // `ground: terrain` is what stops distant trees floating: a tree's Y comes off
  // the chunk mesh that is actually drawn under it, not off the exact field the
  // chunk's triangles are chording across. See Trees._groundFor.
  trees = new Trees(scene, height, waterSurfaces, propTextures, { seed: SEED, ground: terrain })
  // Per-vertex, like v1's props: a leaf card is smaller than a fragment-rate
  // shadow lookup is worth. Skipping this is a visible failure -- the trees
  // would be the one surface the night lift never reaches.
  // The cacheKey MUST differ from the ferns' below. three keys its program cache
  // on it, and these two materials compile DIFFERENT shader source -- the tree
  // material's uBillboardLayers is four long, the ferns' is two -- so sharing a
  // key would hand one of them the other's program.
  lighting.patch(trees.material, { mode: 'vertex', cacheKey: 'v2-tree-bb' })
  // So a tree and the ground it stands on cross the snow line together.
  trees.syncSnowLine(layers)
  trees.place(spawn.x, spawn.z)
  const ts = trees.stats
  console.log(
    `[v2] trees ${ts.placed} placed over ${ts.tiles} tiles in ${ts.placeMs.toFixed(0)} ms ` +
    `(${ts.density}/m^2 to ${ts.fullRadius} m, thinning to ${ts.radius} m, ` +
    `pool ${ts.used}/${ts.pool}), ${ts.bankKB} KB bank`
  )

  // Ferns, as an undercarpet at ~1 per square metre. A SECOND BatchedMesh
  // and a second material rather than instances in the tree batch, and that is
  // not a violation of DESIGN.md §5's one-material rule -- the rule is that a
  // batch cannot be split by material, and these are two batches. Ferns need
  // their own program anyway: WHICH texture layers billboard is compiled into
  // the shader, and the two lists differ -- four tree impostor layers against
  // two fern ones -- so one shared material could not spin both correctly.
  //
  // The whole Layers goes in, not just its paths: a fern takes a hue cue from
  // the terrain colour underfoot, which needs the snow band and the road
  // flattening as well as the path exclusions.
  ferns = new Ferns(scene, height, waterSurfaces, layers, propTextures, { seed: SEED })
  lighting.patch(ferns.material, { mode: 'vertex', cacheKey: 'v2-prop-bb' })
  ferns.syncSnowLine(layers)
  ferns.place(spawn.x, spawn.z)
  const fs = ferns.stats
  const fr = fs.rejected
  console.log(
    `[v2] ferns ${fs.placed} placed over ${fs.tiles} tiles in ${fs.placeMs.toFixed(0)} ms ` +
    `(${fs.density}/m^2 to ${fs.fullRadius} m, thinning to ${fs.radius} m, ` +
    `${fs.heightRange[0]}-${fs.heightRange[1]} m tall, pool ${fs.used}/${fs.pool}) ` +
    `(dropped: ${fr.elev} elev, ${fr.slope} slope, ${fr.water} water, ${fr.snow} snow, ${fr.path} path)`
  )
  // A/B hook for the billboard, from the console: v2ferns.setFarTier('mesh')
  // holds real LOD2 geometry past 14 m so the card can be judged against ground
  // truth, and 'card' puts it back. See Ferns.setFarTier.
  window.v2ferns = ferns

  // Grass, at 3 tufts per square metre -- the densest thing in the world by a
  // factor of sixty, and a THIRD batch for the same reason ferns are a second
  // one: its billboard list is one layer long and neither of the others' is.
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

  // Stone, in three size beds at once: pebbles underfoot, boulders through the
  // wood and across the cliffsides, and giants on the crags and the summits.
  // Three more BatchedMeshes and three more draw calls, but ONE material for all
  // three -- nothing in the rock beds billboards, so unlike the trees, the ferns
  // and the grass there is no per-bed shader source. See render/rocks.js.
  //
  // Which shapes stand where is decided by the ground, not by a roll: each site
  // is classified river / forest / cliff / peak off the field sample the
  // placement test already pays for, and both WHICH variants may stand there and
  // HOW MANY of them follow from that.
  // The whole Layers again, and for the ferns' reason: a rock takes a hue cue
  // from the terrain colour underfoot, which needs the snow band and the road
  // flattening to reproduce what the chunk mesher painted.
  rocks = new Rocks(scene, height, waterSurfaces, layers, propTextures, { seed: SEED, ground: terrain })
  lighting.patch(rocks.material, { mode: 'vertex', cacheKey: 'v2-rock' })
  rocks.syncBands(layers)
  rocks.place(spawn.x, spawn.z)
  const rs = rocks.stats
  console.log(
    `[v2] rocks ${rs.placed} placed in ${rs.placeMs.toFixed(0)} ms, bank ${rs.shapes} shapes / ` +
    `${rs.bankTris} tris / ${rs.bankKB} KB in ${rs.buildMs.toFixed(0)} ms; ` +
    rs.beds.map((b) => `${b.name} ${b.placed} (${b.used}/${b.pool}) to ${b.radius} m`).join(', ')
  )
  // Same console hook the ferns, mushrooms and dead wood keep, and here it earns
  // itself twice over: `describeNear` is the only way to see what a rock that
  // misbehaves in the browser is actually doing, since a blink does not survive
  // into a headless traverse. See render/rocks.js.
  window.v2rocks = rocks

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
  litter = new Litter(scene, height, waterSurfaces, layers, propTextures, { seed: SEED, ground: terrain })
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
    ferns.bakeCards(renderer)
    grass.bakeCards(renderer)
    mushrooms.bakeCards(renderer)
    // Dead wood wears the TREES' bark PNGs, so this bake genuinely has to be
    // inside this promise and not merely conventionally: run before the decode
    // and it would photograph the procedural fallback bark into the two cards.
    deadwood.bakeCards(renderer)
    // The rock cards, one photograph per variant. Unlike the four above this is
    // not a method on the scatter, because there is nothing per-bed about it:
    // the same twenty-five pictures serve all five beds, so they live on the
    // bank. See ROCK_CARD_SEED in props/rock-bank.js for the seed they are all
    // taken at and why it is pinned.
    const rockCards = bakeRockImpostors(renderer, propTextures)
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
    // a distant boulder that has become a rectangle of sky. Printed as the range
    // over the twenty-five rather than one line each: the console is not where
    // twenty-five rows belong, and what a reader needs is whether any of them
    // came out empty.
    const worst = rockCards.reduce((a, b) => (b.coverage < a.coverage ? b : a))
    const bestC = rockCards.reduce((a, b) => (b.coverage > a.coverage ? b : a))
    console.log(
      `rock impostors baked: ${rockCards.length} variants, ` +
        `luma ${(rockCards.reduce((t, b) => t + b.meanLuma, 0) / rockCards.length).toFixed(3)} mean, ` +
        `cover ${worst.coverage.toFixed(3)} (${worst.subject}) .. ` +
        `${bestC.coverage.toFixed(3)} (${bestC.subject})`
    )
  })

  editor = new Editor({
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
  const isVisible = (kind, id, index) => editor.isVisible(kind, id, index)
  markers.setVisibility(isVisible)
  waterSurfaces.setVisibility(isVisible)
  roads.setVisibility(isVisible)

  panel = new Panel({ layers, editor, relief, hotkeys: HOTKEYS, onTool, onAction, onRelief })

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

  trees.syncSnowLine(layers)
  trees.place(cx, cz)
  ferns.syncSnowLine(layers)
  ferns.place(cx, cz)
  grass.syncSnowLine(layers)
  grass.place(cx, cz)
  rocks.syncBands(layers)
  rocks.place(cx, cz)
  litter.place(cx, cz)
  // LAST, and after rocks specifically, for the reason given where mushrooms
  // are constructed: a clump is placed against the trees and rocks that are
  // already standing, so re-placing it before they have moved onto the new
  // relief would anchor it to the old world.
  mushrooms.syncSnowLine(layers)
  mushrooms.place(cx, cz)
  deadwood.syncSnowLine(layers)
  deadwood.place(cx, cz)

  // Re-seat her at the same x/z on the new surface. spawnAt is the only method
  // that resolves y from the field rather than integrating toward it, and the
  // zeroed speed it also does is wanted here: the ground moved under her, so any
  // momentum she had was measured against terrain that no longer exists.
  player.spawnAt(cx, cz)

  console.log(
    `[v2] relief ${JSON.stringify(relief)} -- field ${fieldMs.toFixed(0)} ms, ` +
      `world ${bands.min.toFixed(1)}..${bands.max.toFixed(1)} m, props re-placed`
  )
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
  k: 'skyline',
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
  KeyK: 'skyline',
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
      { keys: 'k', what: 'skyline target on and off: extra detail on ground that draws a silhouette edge' },
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
  // M swaps the region bed for a carpet of the point clump under the player's
  // feet, in place, so the two can be judged against the same hillside in the
  // same light. Rebuilding the bed is ~100 ms of one frame; a swap is not
  // something a player does.
  if (fresh.includes('grassStyle')) {
    player.headPosition(headTmp)
    buildGrass(grassStyle === 'strips' ? 'tufts' : 'strips', headTmp.x, headTmp.z)
  }
  if (fresh.includes('flyUp')) onSpacePress(e.timeStamp)
  // triDeg is a size budget, so finer means smaller. Stepped multiplicatively
  // because the perceptual distance from 1.0 to 1.2 degrees is nothing like the
  // distance from 0.4 to 0.6.
  if (fresh.includes('coarser')) LOD.triDeg = Math.min(MAX_TRI_DEG, LOD.triDeg * 1.25)
  if (fresh.includes('finer')) LOD.triDeg = Math.max(MIN_TRI_DEG, LOD.triDeg / 1.25)
  // K turns the profile target off and on, and it invalidates rather than
  // letting the change ride out SELECT_EVERY_FRAMES the way the bracket keys do.
  // The whole value of this key is A/B on the SAME skyline in the SAME light --
  // a hundred milliseconds of lag is enough to make the two halves of the
  // comparison land on different frames, which is exactly what an eye judging a
  // silhouette edge will latch onto instead of the edge.
  if (fresh.includes('skyline')) {
    SKYLINE.on = !SKYLINE.on
    terrain.invalidate()
  }
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
  if (ready) editor.onBlur()
})

// THE LAST LINE OF DEFENCE FOR AN UNSAVED SCULPT, and it is here because it was
// once needed and absent. The document is autosaved to localStorage on every
// commit, so a reload costs it nothing; the heightmap has no such tier -- it is
// a Float32Array in this tab and, until Save reaches the dev server, nowhere
// else at all. Cmd-R on that state is silent, instant and total. Returning a
// string makes the browser ask first, which is the whole point.
addEventListener('beforeunload', (e) => {
  if (!ready || !editor.sculptor.dirty) return
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

  lighting.update(state)
  sky.update(head, state)
  stars.update(head, state, clock.elapsed, elapsedReal)
  aurora.update(head, state, elapsedReal)
  water.update(elapsedReal, hemi)

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
    // of the three that does not decide its own visibility every frame.
    sky.mesh.visible = true
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
  // height, which `RockBed.pickSizeAt` reads straight off the bank shape. The
  // constants that used to be here were 1.2 m either way at scale 1, which over
  // a bank running 7:1 wide to 3:1 tall was air above some rocks and a cursor
  // that pointed through the top of others.
  { label: 'rock', idKey: 'shapeAt' },
  // Nor here, and for a sharper version of the same reason: a tree is a thin
  // trunk under a wide crown, so it is TWO pick volumes and `bindCursorPicks`
  // expands this one entry into both. The constants that used to be here were a
  // 3 m radius column 26 m tall, which is the crown's width applied all the way
  // to the ground -- see `Trees.pickTrunkAt` for what that cost.
  { label: 'tree', idKey: 'variantAt' },
]

/**
 * The list `pickProp` actually walks, built by `bindCursorPicks`. It is not
 * `CURSOR_PICKS` because ROCKS ARE FIVE SCATTERS AND NOT ONE: `Rocks` is a
 * facade over five `RockBed`s, and every array pickProp needs -- tiles, instX,
 * shapeAt, instScale -- lives on a bed. So the rock template expands into one
 * bound source per bed and the array is longer than the table above.
 */
let boundPicks = null

/** Filled once the scatters exist; nearest-first, so the cheap sources prune for the dear ones. */
function bindCursorPicks() {
  const bySys = { mushroom: mushrooms, fern: ferns, deadwood: deadwood, rock: rocks, tree: trees }
  boundPicks = []
  for (const p of CURSOR_PICKS) {
    const sys = bySys[p.label]
    if (!sys) throw new Error(`bindCursorPicks: no scatter built for ${p.label}`)
    if (p.label === 'rock') {
      // One source per BED. `Rocks` is a facade and owns none of the arrays
      // pickProp walks; the beds do. Binding the facade is what made rocks
      // unnameable, and pickProp now throws rather than skipping it in silence.
      //
      // The id printed is `RockBed.shapeIdAt` -- `variant-index`, which
      // /gen-rock's shape box takes -- and not the raw `shapeAt` index, which
      // means a different rock in each bed. See that method for why.
      for (const bed of rocks.beds) {
        boundPicks.push({
          ...p,
          sys: bed,
          nameAt: (s, id) => s.shapeIdAt(id),
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
const cursorOut = { dist: null, label: null, variant: null }
function cursorPick() {
  cursorOut.dist = null
  cursorOut.label = null
  cursorOut.variant = null
  if (!cursorNdc.seen) return cursorOut

  const { origin, dir } = screenRay(camera, cursorNdc.x, cursorNdc.y)
  const hit = raymarchGround(height, origin, dir)
  if (hit) cursorOut.dist = Math.hypot(hit.x - origin.x, hit.y - origin.y, hit.z - origin.z)

  // Infinity rather than the ground range when the ray reaches the horizon:
  // there is no hill to hide behind, so every prop along it is fair game.
  if (boundPicks === null) throw new Error('cursorPick ran before bindCursorPicks')
  const prop = pickProp(boundPicks, origin, dir, cursorOut.dist === null ? Infinity : cursorOut.dist)
  if (prop) {
    cursorOut.label = prop.label
    // The PRINTABLE id, not the raw index. For rocks it is `variant-index`,
    // which /gen-rock's shape box takes; for trees `species-size`; for the
    // scatters whose variant array indexes their bank in order it is still the
    // integer.
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
    profileDeg: st.profileDeg,
    // `tris` above is the whole frame as the GPU sees it; these three say how
    // much of it is the prop scatter, which is the layer currently being tuned.
    treeCount: trees.stats.placed,
    treeTris: trees.stats.tris,
    fernCount: ferns.stats.placed,
    fernTris: ferns.stats.tris,
    mushroomCount: mushrooms.stats.placed,
    mushroomTris: mushrooms.stats.tris,
    deadwoodCount: deadwood.stats.placed,
    deadwoodTris: deadwood.stats.tris,
    grassCount: grass.stats.placed,
    grassHidden: grass.stats.rimHidden,
    grassTris: grass.stats.tris,
    rockCount: rocks.stats.placed,
    rockTris: rocks.stats.tris,
    litterCount: litter.stats.placed,
    litterTris: litter.stats.tris,
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
    mode: editor.active
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

  if (!ready) {
    renderer.render(scene, camera)
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
  swayStrength = THREE.MathUtils.clamp(swayStrength + (submerged ? dt : -dt) / CURRENT.ease, 0, 1)
  currentDrift(now / 1000, swayStrength, swayWant)
  player.rig.position.x += swayWant.x - swayApplied.x
  player.rig.position.z += swayWant.z - swayApplied.z
  swayApplied.copy(swayWant)

  player.update(dt, moveInput)

  // The clock the prop LOD cross-dissolves run on, and the only per-frame cost
  // any of them has. Set BEFORE the scatters update, so the sweep that retires
  // finished fades and the shader that draws them read the same instant. It
  // wraps at 1024 s inside setPropClock -- see the packing note in material.js.
  setPropClock(now / 1000)

  player.headPosition(headTmp)
  const [pose, hands] = currentPose()
  netplay.sendPose(pose, hands, now)
  netplay.update(now)
  // Altitude and gaze both feed the split rule: y makes the range term 3D and
  // yaw is what stops two thirds of the slot pool going to terrain behind her.
  terrain.update({ x: headTmp.x, y: headTmp.y, z: headTmp.z, yaw: player.headYaw() })
  trees.update(headTmp.x, headTmp.y, headTmp.z)
  ferns.update(headTmp.x, headTmp.y, headTmp.z)
  grass.update(headTmp.x, headTmp.y, headTmp.z)
  rocks.update(headTmp.x, headTmp.y, headTmp.z)
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

  // BEFORE the main render, and that ordering is load-bearing: both probes bind
  // a render target and toggle renderer.xr off to get their own camera looked
  // through. See sky-probe.js.
  probe.update(renderer, scene, headTmp)
  // `waterY` is the surface she is at or nearest to, written by applySubmersion
  // earlier this same frame. It is a FLOOR on how low the capture may sit, not
  // the answer -- see WORLD_PROBE.duck, which is what stops a lake shore
  // capturing from inside the bank. `dt` drives the cross-fade and nothing else.
  // The air hook only while she is under, because that is the only time the
  // frame's atmosphere is not the one the capture wants.
  airHook.state = state
  worldProbe.update(renderer, scene, headTmp, waterY, dt, submerged ? airHook : null)

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
