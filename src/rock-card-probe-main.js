import THREE from './three-instance.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { buildRockBank, bakeRockImpostor, rockImpostorLayers, ROCK_CARD_SEED, ROCK_BAND_COUNT } from './props/rock-bank.js'
import { createPropMaterial } from './material.js'
import { spunCardFrame, CARD_FRAME_STRIDE } from './v2/render/rocks.js'

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
//
// HALF THE BED STANDS ON A HILLSIDE, seen from below, with the ground drawn
// into the depth buffer and nothing else: a bed on a slope tilts a boulder to
// the face and sinks most of it into the hill, and what shows is the downhill
// face, where the ground falls away. A card cut by the ground at the rock's
// origin showed a sliver of that or nothing, and a rock backing over the card
// rung vanished on the spot; the shader stands the card at the near face
// instead (billboardVertex, material.js), and the coverage checks here are
// what say so.
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
// The hillside: a face the boulder beds still take, rising away from the eye,
// and the share of its stand the bed sinks a boulder on one (SINK_MIN plus the
// slope term, times the normal correction, under SINK_CAP -- rocks.js).
const SLOPE = 40 * Math.PI / 180
const SLOPE_SINK = 0.85

const out = document.getElementById('out')
const canvas = document.getElementById('view')
window.PROBE_STATE = 'running'

// Not a top-level await: Vite's es2020 build target rejects it and this page
// is a build entry like every root .html.
run().then((report) => {
  out.textContent = JSON.stringify(report, null, 1)
  window.PROBE_STATE = 'done'
}, (err) => {
  out.textContent = String(err && err.stack || err)
  window.PROBE_ERR = String(err && err.message || err)
  window.PROBE_STATE = 'error'
  throw err
})

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
  // twice over, at a yaw each; the second half on the hillside, tilted to its
  // face, leaned as a tilting bed leans and sunk as the bed sinks them. The
  // card's matrix comes off the mesh's exactly as RockBed._placeTier takes it.
  // Rows are spread further than columns so a card's foot and a neighbour's
  // crown never share a screen row and every drawn pixel has one nearest
  // rock centre, and the hillside rows are the far ones, so their ground rises
  // behind every rock on the flat and in front of none.
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
  const tilt = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, Math.cos(SLOPE), Math.sin(SLOPE)))
  const frame = new Float32Array(CARD_FRAME_STRIDE)
  const centres = []
  const placements = []
  const rowSpan = span * 1.6
  const scene = new THREE.Scene()
  // One face under both hill rows, its foot on the flat rows' ground at their
  // edge and rising from there, so it never crosses a sight line from any rock
  // to the eye and the hill rows sit well up the screen from the flat ones.
  const hill = new THREE.Mesh(
    new THREE.PlaneGeometry((N_COLS + 2) * span, 2 * rowSpan / Math.cos(SLOPE)),
    new THREE.MeshBasicMaterial({ colorWrite: false }))
  hill.rotateX(-Math.PI / 2 + SLOPE)
  hill.position.set(0, Math.tan(SLOPE) * rowSpan, -rowSpan)
  hill.renderOrder = -1
  scene.add(hill)
  const v = new THREE.Vector3()
  const pos = meshGeo.attributes.position.array
  for (let i = 0; i < N; i++) {
    const ri = i % 16
    const onHill = i >= 16
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), ((ri / 4) | 0) * (Math.PI / 2))
    q.multiply(qx.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (ri % 4) * (Math.PI / 2)))
    yaw.setFromAxisAngle(up, rand() * Math.PI * 2)
    yaw.multiply(q)
    let leanBy = 0
    if (onHill) {
      yaw.premultiply(tilt)
      const a = rand() * Math.PI * 2
      leanBy = rand() * 0.4
      yaw.premultiply(lean.setFromAxisAngle(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), leanBy))
    }
    placements.push(`roll ${ri}${onHill ? ` on the hill, lean ${leanBy.toFixed(2)}` : ''}`)
    const row = (i / N_COLS) | 0
    p.set(((i % N_COLS) - (N_COLS - 1) / 2) * span, 0, ((N_ROWS - 1) / 2 - row) * rowSpan)
    s.set(1, 1, 1)
    if (onHill) {
      // Seated as the bed seats it: the lowest vertex of the placed mesh
      // SLOPE_SINK of its stand under the ground at the origin.
      m.compose(p, yaw, s)
      let lo = Infinity, hi = -Infinity
      for (let k = 0; k < pos.length; k += 3) {
        v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m)
        lo = Math.min(lo, v.y); hi = Math.max(hi, v.y)
      }
      p.y = -Math.tan(SLOPE) * p.z - SLOPE_SINK * (hi - lo) - lo
    }
    m.compose(p, yaw, s)
    meshes.setMatrixAt(i, m)
    spunCardFrame(m.elements, measured, frame)
    p.x += frame[0]; p.y += frame[1]; p.z += frame[2]
    // Pixels are credited to the nearest rock centre, which a roll leaves
    // nowhere near the origin.
    centres.push(p.clone())
    s.set(frame[3], frame[4], frame[5])
    m.compose(p, new THREE.Quaternion(), s)
    cards.setMatrixAt(i, m)
  }

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
      if (k === 0) row[what].each = perInstance(px, centres, cam)
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
function perInstance(px, centres, cam) {
  const sx = [], sy = []
  const v = new THREE.Vector3()
  for (const o of centres) {
    v.copy(o).project(cam)
    sx.push((v.x + 1) * 0.5 * W)
    sy.push((v.y + 1) * 0.5 * H)
  }
  const n = new Array(centres.length).fill(0)
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
