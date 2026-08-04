import * as THREE from 'three'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { TerrainHeight, WORLD_SIZE } from './sim/terrain-height.js'
import { Terrain, CHUNK_RES } from './terrain/terrain.js'
import { DEFAULT_SPLIT_K, MAX_DEPTH, MIN_SPLIT_K, MAX_SPLIT_K } from './terrain/quadtree.js'
import { Player, LOCOMOTION } from './player.js'
import { Scatter } from './props/scatter.js'
import { Vignette } from './vignette.js'
import { Hud } from './hud.js'
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
scene.background = new THREE.Color(FOG_COLOR)
// Atmospheric perspective does most of the work of selling scale, and it is
// also what hides LOD popping at the chunk ring boundaries (§5).
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

// --- world ------------------------------------------------------------------

const terrainHeight = new TerrainHeight(SEED)
const terrain = new Terrain(scene, { seed: SEED, workers: 2 })
// Scale reference only -- see the header of props/scatter.js. The real
// placement system is §6 and lands at build step 5.
const props = new Scatter(scene, terrainHeight, { seed: SEED })
const player = new Player(rig, camera, terrainHeight)
const vignette = new Vignette(camera)
const hud = new Hud()
camera.add(hud.mesh)
hud.mesh.position.set(0, -0.28, -1.1)
const input = new Input(renderer)

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
      if (h < 60 || h > 260) continue
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
  ' ': 'fly',
  h: 'hud',
  u: 'unstick',
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
  Space: 'fly',
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

addEventListener('keydown', (e) => {
  const actions = actionsFor(e)
  if (actions.length === 0) return
  if (actions.includes('fly')) e.preventDefault() // space scrolls the page otherwise
  const fresh = actions.filter((a) => !held.has(a))
  for (const a of actions) held.add(a)

  // One-shot actions fire on the transition, not while held.
  if (fresh.includes('hud')) hud.toggle()
  if (fresh.includes('fly')) setFlying(!player.flying)
  if (fresh.includes('coarser')) terrain.splitK = Math.max(MIN_SPLIT_K, terrain.splitK - 0.1)
  if (fresh.includes('finer')) terrain.splitK = Math.min(MAX_SPLIT_K, terrain.splitK + 0.1)
})

addEventListener('keyup', (e) => {
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
renderer.domElement.addEventListener('pointerdown', () => (dragging = true))
addEventListener('pointerup', () => (dragging = false))
addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return
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
const moveInput = { move: 0, strafe: 0, turn: 0, unstick: false, instant: false }
const headTmp = new THREE.Vector3()

function readInput() {
  const st = input.update()
  if (st.connected > 0) {
    // Left stick forward only (§12). axes[1] is negative when pushed up.
    moveInput.move = Math.max(0, -st.left.axes[1])
    moveInput.strafe = 0 // no strafing in VR, on purpose
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
  // and the whole point of fly mode is to see the periphery.
  vignette.update(player.flying ? 0 : player.speed / LOCOMOTION.maxSpeed, dt)

  // Called every frame, but it throttles its own quadtree reselection (§5:
  // stagger CPU work). Streaming has to run at frame rate even when selection
  // does not, or a chunk that arrived mid-interval keeps showing its coarse
  // ancestor until the next selection tick.
  player.headPosition(headTmp)
  terrain.update(headTmp.x, headTmp.z)
  props.update(headTmp.x, headTmp.z)

  hud.setLines(hudLines())
  hud.paint(now)
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

  return [
    '## AURORA -- step 2: terrain + locomotion',
    `frame ${avgMs.toFixed(2)}ms (${avgMs > 0 ? (1000 / avgMs).toFixed(1) : '--'} fps)  worst ${worst.toFixed(1)}ms`,
    `draw calls ${info.render.calls}   triangles ${(info.render.triangles / 1000).toFixed(1)}k`,
    budgetLine(info),
    '',
    '## terrain (1 batched draw call)',
    `chunks  render ${ts.rendered}/${ts.desired}   pending ${ts.pending}   slots ${ts.slots}/${ts.cached}`,
    `chunk tris ${(ts.tris / 1000).toFixed(1)}k   res ${CHUNK_RES}   gen ${ts.lastGenMs.toFixed(1)}ms`,
    `splitK ${terrain.splitK.toFixed(1)} ([ ])   depth<=${MAX_DEPTH}   world ${WORLD_SIZE / 1000}km`,
    '',
    '## props (1 batched draw call)',
    `tree ${bk.tree ?? 0}  rock ${bk.rock ?? 0}  grass ${bk.grass ?? 0}  cabin ${bk.cabin ?? 0}`,
    `${(pr.tris / 1000).toFixed(1)}k tris   last place ${pr.lastBuildKind} ${pr.lastBuildMs.toFixed(1)}ms`,
    '',
    '## position',
    `x ${head.x.toFixed(0)}  z ${head.z.toFixed(0)}`,
    `ground elev ${ground.toFixed(1)}m   eye ${head.y.toFixed(1)}m   agl ${(head.y - ground).toFixed(1)}m`,
    `slope ${slopeDeg.toFixed(0)}deg / max ${LOCOMOTION.maxSlopeDeg}${player.blocked ? '   !! BLOCKED' : ''}`,
    `speed ${player.speed.toFixed(2)} m/s${player.flying ? '   ** FLYING (space) **' : ''}`,
  ]
}

renderer.setAnimationLoop(tick)

// Reset the worst-frame marker when a session starts, so the load hitch and the
// desktop warm-up do not poison the number that actually matters in VR.
renderer.xr.addEventListener('sessionstart', () => {
  worst = 0
  player.setFlying(false) // desktop survey tool only; see LOCOMOTION in player.js
  held.clear()
  const session = renderer.xr.getSession()
  if (session?.supportedFrameRates?.includes(72)) session.updateTargetFrameRate(72)
})

console.log(
  `aurora: seed ${SEED}, spawn ${spawn.x.toFixed(0)},${spawn.z.toFixed(0)} at ${spawn.h.toFixed(0)}m, ` +
    `splitK ${DEFAULT_SPLIT_K}`
)
