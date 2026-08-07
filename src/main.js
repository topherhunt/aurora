import * as THREE from 'three'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { TerrainHeight, WORLD_SIZE } from './sim/terrain-height.js'
import { Terrain, CHUNK_RES } from './terrain/terrain.js'
import { LOD, MAX_DEPTH, MIN_TRI_DEG, MAX_TRI_DEG } from './terrain/quadtree.js'
import { Player, LOCOMOTION } from './player.js'
import { Scatter } from './props/scatter.js'
import { Vignette } from './vignette.js'
import { Sky } from './sky.js'
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

// One directional light, per Meta's guidance (§5). Hemisphere fill is not a
// shadow-casting light and costs nothing meaningful in Lambert -- without it
// the shadowed faces of every cliff go flat black.
const sun = new THREE.DirectionalLight(SUN_COLOR, 2.1)
sun.position.set(-0.45, 0.62, 0.3).normalize()
scene.add(sun)
scene.add(new THREE.HemisphereLight(0xbfd4ee, 0x2c3140, 0.85))

// The dome takes the light's own direction, so the disc is guaranteed to sit
// where the terrain's highlights say it is -- and takes FOG_COLOR as its
// horizon, so distant ridges dissolve into the sky with no seam at all.
const sky = new Sky(scene, sun.position, { horizon: FOG_COLOR })

// --- world ------------------------------------------------------------------

const terrainHeight = new TerrainHeight(SEED)
const terrain = new Terrain(scene, { seed: SEED, workers: 2 })
// Scale reference only -- see the header of props/scatter.js. The real
// placement system is §6 and lands at build step 5.
const props = new Scatter(scene, terrainHeight, { seed: SEED })
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

// Spawn somewhere walkable and low. Dropping her onto a 40-degree face means
// the slope limiter refuses every direction and the world looks broken.
function findSpawn() {
  for (let r = 0; r <= 3000; r += 60) {
    const steps = r === 0 ? 1 : 24
    for (let a = 0; a < steps; a++) {
      const ang = (a / steps) * Math.PI * 2 + r * 0.21
      const x = Math.cos(ang) * r
      const z = Math.sin(ang) * r
      const h = terrainHeight.heightAt(x, z)
      // Valley floor, not a hillside, and this band is quoted in absolute
      // metres so it has to move whenever the terrain scale does. Flooring the
      // regional swell (see valleyLo in terrain-height.js) dropped the world
      // median from 137 m to 68 m and took the snow line down with it, and the
      // old 85-140 band then sat ON the snow: measured, it put her at 102 m, 7 m
      // ABOVE the 95 m mean snow line, on a white mountainside rather than in
      // the green valley this comment claimed. Re-measured against gentle ground
      // within 3 km of the origin, whose elevations now run p25 12 / p50 31 /
      // p75 66 / p90 105.
      if (h < 25 || h > 70) continue // green valley floor, well under the 95 m snow ramp
      if (terrainHeight.slopeAt(x, z) > (15 * Math.PI) / 180) continue
      return { x, z, h }
    }
  }
  throw new Error('no walkable spawn found within 3 km of the origin -- check TUNING in terrain-height.js')
}

const spawn = findSpawn()
player.spawnAt(spawn.x, spawn.z)

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
  // After terrain.update, because it reads this frame's selection size to catch
  // an LOD setting that is about to overrun the slot pool.
  tuner.update(headTmp)

  hud.setLines(hudLines())
  hud.paint(now)
  // headTmp is her head position, already computed above for terrain streaming.
  sky.update(headTmp)
  renderer.render(scene, camera)
}

function hudLines() {
  const info = renderer.info
  const head = player.headPosition(headTmp)
  const ts = terrain.stats
  const pr = props.stats
  const bk = pr.byKind
  const ground = terrainHeight.heightAt(head.x, head.z)
  const slopeDeg = (terrainHeight.slopeAt(head.x, head.z) * 180) / Math.PI
  const measureLine = measure.line(head)

  return [
    '## AURORA -- step 2: terrain + locomotion',
    `frame ${avgMs.toFixed(2)}ms (${avgMs > 0 ? (1000 / avgMs).toFixed(1) : '--'} fps)  worst ${worst.toFixed(1)}ms`,
    `draw calls ${info.render.calls}   triangles ${(info.render.triangles / 1000).toFixed(1)}k`,
    budgetLine(info),
    '',
    '## terrain (1 batched draw call)',
    `chunks  render ${ts.rendered}/${ts.desired}   pending ${ts.pending}   slots ${ts.slots}/${ts.cached}`,
    `chunk tris ${(ts.tris / 1000).toFixed(1)}k   res ${CHUNK_RES}   gen ${ts.lastGenMs.toFixed(1)}ms`,
    `triangles <=${LOD.triDeg.toFixed(2)}deg ([ ])   depth<=${MAX_DEPTH}   world ${WORLD_SIZE / 1000}km`,
    `bounds known for ${ts.bounds} nodes`,
    `T = live terrain tuner${tuner.visible ? '   ** OPEN **' : ''}`,
    '',
    '## props (1 batched draw call)',
    `tree ${bk.tree ?? 0}  rock ${bk.rock ?? 0}  grass ${bk.grass ?? 0}  cabin ${bk.cabin ?? 0}`,
    `${(pr.tris / 1000).toFixed(1)}k tris   last place ${pr.lastBuildKind} ${pr.lastBuildMs.toFixed(1)}ms`,
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
