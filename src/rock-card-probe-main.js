import THREE from './three-instance.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { buildRockBank, bakeRockImpostor, rockImpostorLayers, ROCK_CARD_SEED, ROCK_BAND_COUNT } from './props/rock-bank.js'
import { createPropMaterial } from './material.js'
import { spunCardFrame } from './v2/render/rocks.js'

// ---------------------------------------------------------------------------
// The rock card probe (rock-card-probe.html): one boulder drawn as its LOD0
// mesh and as its far card, under the same light and the same eye, and the two
// pictures measured against each other. The card is photographed UNLIT and lit
// live as the mean of the solid it replaces (SPHERE_CARD_LIGHT in material.js),
// and the card tier is handed its own instance matrix (RockBed._placeTier), so
// this is where both claims are checked: mean colour, mean brightness, and the
// ground the silhouette covers. Both need a live renderer, so no node gate can
// reach them; scripts/check-rock-card.mjs drives this page headless and reads
// the JSON it writes into #out.
//
// The rock is ROCK_CARD_SEED's, the same one the card was photographed from,
// so nothing but the shading and the placement is being compared. The eye is a
// far orthographic camera from above, as a slope is looked at, and the sun is
// swept over the bearings that tell the sphere mean apart from a flat card:
// the world's noon, straight overhead, over the eye's shoulder and behind the
// rock. The world's per-instance shadow and sky terms (lighting.js) multiply
// mesh and card alike and are not in this rig.
// ---------------------------------------------------------------------------

const N_COLS = 8
const N_ROWS = 4
const N = N_COLS * N_ROWS
const W = 1024
const H = 640

const SUNS = [
  { name: 'noon', dir: [-0.45, 0.62, 0.3] },
  { name: 'overhead', dir: [0, 1, 0] },
  { name: 'over the shoulder', dir: [0.2, 0.7, 1] },
  { name: 'behind the rock', dir: [0.2, 0.4, -1] },
]
const EYE_ELEVATION = 0.6

const out = document.getElementById('out')
const canvas = document.getElementById('view')
window.PROBE_STATE = 'running'

try {
  const report = await run()
  out.textContent = JSON.stringify(report, null, 1)
  window.PROBE_STATE = 'done'
} catch (err) {
  out.textContent = String(err && err.stack || err)
  window.PROBE_ERR = String(err && err.message || err)
  window.PROBE_STATE = 'error'
  throw err
}

async function run() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
  renderer.setSize(W * 2, H * SUNS.length, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x000000, 0)

  const tex = buildTextureArray()
  await loadImageLayers(tex)
  const baked = bakeRockImpostor(renderer, tex)
  const bank = buildRockBank({ seed: ROCK_CARD_SEED })
  const shape = bank.shapes.boulder
  const meshGeo = shape.tiers[0]
  const cardGeo = shape.tiers[ROCK_BAND_COUNT - 1]
  const measured = shape.measured

  const material = createPropMaterial(tex, {
    billboardLayers: rockImpostorLayers(), sphericalBillboard: true, side: THREE.FrontSide, bump: true,
  })

  // THE SAME PLACEMENTS FOR BOTH: every quarter-turn roll the bed can draw,
  // twice over, half of them leaned as a tilting bed leans, at a yaw each. The
  // card's matrix comes off the mesh's exactly as RockBed._placeTier takes it.
  // Rows are spread further than columns so a card's foot and a neighbour's
  // crown never share a screen row and every drawn pixel has one nearest origin.
  const rand = mulberry32(7)
  const span = Math.max(measured.width, measured.height, measured.depth) * 2.2
  const meshes = new THREE.InstancedMesh(meshGeo, material, N)
  const cards = new THREE.InstancedMesh(cardGeo, material, N)
  meshes.frustumCulled = false
  cards.frustumCulled = false
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const qx = new THREE.Quaternion()
  const lean = new THREE.Quaternion()
  const yaw = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const frame = new Float32Array(3)
  const origins = []
  const placements = []
  for (let i = 0; i < N; i++) {
    const ri = i % 16
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), ((ri / 4) | 0) * (Math.PI / 2))
    q.multiply(qx.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (ri % 4) * (Math.PI / 2)))
    yaw.setFromAxisAngle(up, rand() * Math.PI * 2)
    yaw.multiply(q)
    let leanBy = 0
    if (i >= 16) {
      const a = rand() * Math.PI * 2
      leanBy = rand() * 0.4
      yaw.premultiply(lean.setFromAxisAngle(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), leanBy))
    }
    placements.push(`roll ${ri} lean ${leanBy.toFixed(2)}`)
    p.set(((i % N_COLS) - (N_COLS - 1) / 2) * span, 0, (((i / N_COLS) | 0) - (N_ROWS - 1) / 2) * span * 1.6)
    s.set(1, 1, 1)
    m.compose(p, yaw, s)
    meshes.setMatrixAt(i, m)
    origins.push(p.clone())
    spunCardFrame(m.elements, measured, frame)
    p.y += frame[0]
    s.set(frame[1], frame[2], 1)
    m.compose(p, new THREE.Quaternion(), s)
    cards.setMatrixAt(i, m)
  }

  const scene = new THREE.Scene()
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.1)
  scene.add(sun)
  scene.add(new THREE.HemisphereLight(0xbfd4ee, 0x2c3140, 0.85))
  scene.add(meshes)
  scene.add(cards)

  const half = Math.max(N_COLS, N_ROWS) * span * 0.5 + span
  const cam = new THREE.OrthographicCamera(-half * (W / H), half * (W / H), half, -half, 1, 400)
  cam.position.set(0, Math.sin(EYE_ELEVATION), Math.cos(EYE_ELEVATION)).multiplyScalar(200)
  cam.lookAt(0, 0, 0)

  const rt = new THREE.WebGLRenderTarget(W, H)
  const px = new Uint8Array(W * H * 4)
  const rows = []
  for (let k = 0; k < SUNS.length; k++) {
    sun.position.fromArray(SUNS[k].dir).normalize()
    const row = { sun: SUNS[k].name }
    for (const [what, obj, other] of [['mesh', meshes, cards], ['card', cards, meshes]]) {
      obj.visible = true
      other.visible = false
      renderer.setRenderTarget(rt)
      renderer.clear()
      renderer.render(scene, cam)
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, px)
      row[what] = measure(px)
      // Coverage does not depend on the sun; once is enough.
      if (k === 0) row[what].each = perInstance(px, origins, cam)
      // And on screen, for a person: mesh on the left, card on the right, one
      // row per sun.
      renderer.setRenderTarget(null)
      renderer.setViewport(what === 'mesh' ? 0 : W, H * (SUNS.length - 1 - k), W, H)
      renderer.setScissor(what === 'mesh' ? 0 : W, H * (SUNS.length - 1 - k), W, H)
      renderer.setScissorTest(true)
      renderer.render(scene, cam)
      renderer.setScissorTest(false)
    }
    rows.push(row)
  }
  return {
    renderer: renderer.getContext().getParameter(renderer.getContext().RENDERER),
    baked: baked.map((b) => ({ name: b.name, layer: b.layer })),
    measured: { width: measured.width, height: measured.height, depth: measured.depth, planMean: measured.planMean },
    placements,
    rows,
  }
}

/** Each instance's own pixel count: every drawn pixel handed to the nearest instance origin on screen. */
function perInstance(px, origins, cam) {
  const sx = [], sy = []
  const v = new THREE.Vector3()
  for (const o of origins) {
    v.copy(o).project(cam)
    sx.push((v.x + 1) * 0.5 * W)
    sy.push((v.y + 1) * 0.5 * H)
  }
  const n = new Array(origins.length).fill(0)
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue
    const x = (i / 4) % W, y = (i / 4 / W) | 0
    let best = 0, bd = Infinity
    for (let j = 0; j < sx.length; j++) {
      const d = (sx[j] - x) ** 2 + (sy[j] - y) ** 2
      if (d < bd) { bd = d; best = j }
    }
    n[best]++
  }
  return n
}

/** Coverage and the mean of the covered pixels: what the eye would average over a slope of these. */
function measure(px) {
  let n = 0, r = 0, g = 0, b = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue
    n++
    r += px[i]
    g += px[i + 1]
    b += px[i + 2]
  }
  if (n === 0) throw new Error('nothing drawn')
  r /= n * 255
  g /= n * 255
  b /= n * 255
  return { pixels: n, r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b }
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
