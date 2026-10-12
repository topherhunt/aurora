// The palisade bench (gen-palisade.html): a post at LOD0 and LOD1 and its card, then a curved run of wall at the labyrinths' spacing with the gate and its two torches, in the real prop material.
import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TEX_SIZE, buildTextureArray, loadImageLayers } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture } from './preview-stage.js'
import { bakeImpostor, flipY } from './props/impostor.js'
import { POST, POST_CARD_FRAME, POST_LODS, TORCH_POLE, buildPalisadePost, buildTorchPole, tonePostCard } from './props/palisade.js'
import { LABYRINTH, POST_SPACING, POST_STRIDE } from './v2/layers/labyrinths.js'
import { GATE_LIGHT, postPose } from './v2/render/palisades.js'
import { TORCH_REACH } from './lighting.js'
import { TriFlames, TRI_TORCH } from './v2/render/fire-tris.js'
import { flicker } from './v2/render/fire.js'
import { mulberry32 } from './sim/mathx.js'

let seed = 1
let spin = false
let night = false

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const DAY_SKY = new THREE.Color(0x8fb4d8)
const NIGHT_SKY = new THREE.Color(0x0a1220)
scene.background = DAY_SKY.clone()
scene.fog = new THREE.Fog(scene.background, 60, 160)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400)
camera.position.set(4, 3.2, 9)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 2, 0)
controls.enableDamping = true
controls.autoRotateSpeed = 0.6

const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
const hemi = new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85)
scene.add(sun, hemi)

const textureArray = buildTextureArray()
const material = createPropMaterial(textureArray, { vertexColors: true })
material.side = THREE.FrontSide

const groundTex = grassTexture(renderer)
groundTex.repeat.set(40, 40)
const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: groundTex }))
scene.add(ground)

// The row: LOD0, LOD1 and the card a metre apart; the wall's arc behind them, its gate facing the camera.
const ROW = [-1, 0, 1]
const WALL_R = 8
const WALL_SWEEP = 1.2
const wallCentre = new THREE.Vector3(0, 0, -WALL_R - 3)

const lods = [null, null]
const lodMeshes = POST_LODS.map((_, i) => {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), material)
  m.position.x = ROW[i]
  scene.add(m)
  return m
})
const cardMat = new THREE.MeshLambertMaterial({ alphaTest: 0.5, side: THREE.DoubleSide })
const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cardMat)
card.position.x = ROW[2]
scene.add(card)
let cardTex = null

const VARIANTS = 4
let wall = null
const poles = new THREE.InstancedMesh(buildTorchPole(), material, 2)
scene.add(poles)
const flames = new TriFlames(2, { ...TRI_TORCH, height: 0.34, radius: 0.1 })
scene.add(flames.group)
const torchLights = [0, 1].map(() => new THREE.PointLight(0xffa850, 0, TORCH_REACH * GATE_LIGHT, 1.6))
scene.add(...torchLights)

const m4 = new THREE.Matrix4(), tint = new THREE.Color()
let wallPosts = 0

/** The arc's posts at the labyrinths' spacing, both sides of a gate LABYRINTH.gate wide, as palisades.js places them. */
function buildWall() {
  for (const g of lods) if (g) g.dispose()
  lods[0] = buildPalisadePost({ lod: 0, seed })
  lods[1] = buildPalisadePost({ lod: 1, seed })
  lodMeshes.forEach((m, i) => { m.geometry = lods[i] })

  if (wall) { scene.remove(wall); wall.geometry.dispose() }
  const variants = Array.from({ length: VARIANTS }, (_, i) => buildPalisadePost({ lod: 0, seed: seed * 31 + i }))
  const gateHalf = LABYRINTH.gate / 2 / WALL_R
  const arcLen = WALL_R * (WALL_SWEEP / 2 - gateHalf)
  const count = Math.ceil(arcLen / POST_SPACING) + 1
  const rand = mulberry32(seed)
  // Records as Labyrinths.postsOf writes them.
  const placed = []
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      const a = Math.PI / 2 + side * (gateHalf + (i * (WALL_SWEEP / 2 - gateHalf)) / (count - 1))
      placed.push(wallCentre.x + Math.cos(a) * WALL_R, wallCentre.z + Math.sin(a) * WALL_R, -Math.sin(a), Math.cos(a), rand() * Math.PI * 2, rand())
    }
  }
  wallPosts = placed.length / POST_STRIDE
  const byVariant = variants.map(() => [])
  for (let i = 0; i < wallPosts; i++) {
    const vi = postPose(placed, i, 0, m4, tint)
    byVariant[vi].push([m4.clone(), tint.clone()])
  }
  const group = new THREE.Group()
  variants.forEach((g, vi) => {
    const mine = byVariant[vi]
    const im = new THREE.InstancedMesh(g, material, Math.max(1, mine.length))
    im.count = mine.length
    mine.forEach(([m, c], i) => { im.setMatrixAt(i, m); im.setColorAt(i, c) })
    group.add(im)
  })
  group.geometry = { dispose: () => { for (const g of variants) g.dispose() } }
  wall = group
  scene.add(wall)

  const out = WALL_R + 0.55
  for (const [i, side] of [[0, -1], [1, 1]]) {
    const a = Math.PI / 2 + side * gateHalf
    const x = wallCentre.x + Math.cos(a) * out, z = wallCentre.z + Math.sin(a) * out
    poles.setMatrixAt(i, m4.makeTranslation(x, 0, z))
    flames.place(i, x, TORCH_POLE.height, z, { height: 0.34, radius: 0.1, phase: i * 2.1 })
    torchLights[i].position.set(x, TORCH_POLE.height + 0.2, z)
  }
  poles.instanceMatrix.needsUpdate = true
  renderStats()
}

/** The card the shared pool draws past LOD1, baked as palisades.js bakes it and shown on a plane its own size. */
function bakeCard() {
  const baked = bakeImpostor(renderer, lods[0], textureArray, null, { ...POST_CARD_FRAME, vertexColors: true })
  if (cardTex) cardTex.dispose()
  const px = tonePostCard(baked.pixels.slice())
  flipY(px)
  cardTex = new THREE.DataTexture(px, TEX_SIZE, TEX_SIZE)
  cardTex.colorSpace = THREE.SRGBColorSpace
  cardTex.needsUpdate = true
  cardMat.map = cardTex
  cardMat.needsUpdate = true
  card.scale.set(baked.width, baked.height, 1)
  card.position.y = baked.height / 2 - baked.sink
}

const tris = (g) => g.getAttribute('position').count / 3
function renderStats() {
  const rows = [
    ['post', `${(POST.radius * 2).toFixed(2)} x ${POST.height} m`],
    ['LOD0 tris', `${tris(lods[0])}`],
    ['LOD1 tris', `${tris(lods[1])}`],
    ['card tris', '2'],
    ['spacing', `${POST_SPACING} m`],
    ['posts / metre', (1 / POST_SPACING).toFixed(2)],
    ['wall posts', `${wallPosts}`],
    ['gate', `${LABYRINTH.gate} m`],
  ]
  document.getElementById('statsTable').innerHTML = rows.map(([k, val]) => `<tr><td>${k}</td><td class="n">${val}</td></tr>`).join('')
}

function applyNight() {
  sun.intensity = night ? 0.1 : 2.1
  hemi.intensity = night ? 0.1 : 0.85
  scene.background.copy(night ? NIGHT_SKY : DAY_SKY)
  scene.fog.color.copy(scene.background)
}

const seedInput = document.getElementById('seed')
const reseed = () => { buildWall(); bakeCard() }
seedInput.addEventListener('change', () => { seed = Number(seedInput.value) | 0; reseed() })
document.getElementById('reroll').addEventListener('click', () => { seed += 1; seedInput.value = seed; reseed() })
const toggle = (id, fn) => {
  const b = document.getElementById(id)
  b.addEventListener('click', () => { b.classList.toggle('on'); fn(b.classList.contains('on')) })
}
toggle('night', (on) => { night = on; applyNight() })
toggle('wire', (on) => { material.wireframe = on })
toggle('spin', (on) => { spin = on })

function resize() {
  renderer.setSize(stage.clientWidth, stage.clientHeight)
  camera.aspect = stage.clientWidth / stage.clientHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()
buildWall()
bakeCard()
loadImageLayers(textureArray).then(bakeCard, (e) => console.error('palisade bench: image layers', e))

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime()
  controls.autoRotate = spin
  controls.update()
  flames.update(t, [1, 1, 1])
  torchLights.forEach((l, i) => { l.intensity = (night ? 5 : 0.6) * flicker(t, i * 2.1) })
  renderer.render(scene, camera)
})
window.palisadeBench = { camera, controls, get seed() { return seed }, get wallPosts() { return wallPosts }, lodTris: () => lods.map(tris) }
