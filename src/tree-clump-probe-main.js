import THREE from './three-instance.js'
import { buildTextureArray, loadImageLayers, LAYER, TEX_SIZE } from './textures.js'
import { buildTreeBank, bakeTreeImpostors } from './props/tree-bank.js'
import { bakeTreeClumps, buildTreeClumpTier, treeClumpLayers } from './props/tree-clump.js'
import { createPropMaterial } from './material.js'
import { mulberry32 } from './sim/mathx.js'

// ---------------------------------------------------------------------------
// The tree clump probe (tree-clump-probe.html): what a far forest looks like
// drawn as clump cards, against the same hillside drawn as the shipped
// per-tree cards under trees.js's 1/d thinning, and against every tree.
//
// One pine forest at trees.js's full density is planted on a hillside rising
// across a valley from an eye on a ridge, from 40 m out to 750 m, and drawn three
// ways from the same camera:
//
//   every tree   one pine card per tree, nothing thinned -- the picture the
//                thinning law is an approximation of
//   shipped      the same trees kept where rank < FULL_RADIUS / d, which is
//                what the world draws past 50 m today
//   clumps       one clump card per CELL m cell, no thinning, at about a
//                sixth of the instances of the full forest -- ONE
//                InstancedMesh, each instance picking its picture with the
//                per-instance layer shift trees.js uses
//
// Above the three views, the raw 128 px layers the cards sample, so the bake
// can be judged as a picture before it is judged as a forest.
// ---------------------------------------------------------------------------

const W = 1280
const H = 400
const CARD_ZOOM = 3

// The forest: trees.js's DENSITY and FULL_RADIUS, on a 25 m tile.
const DENSITY = 0.05
const FULL_RADIUS = 50
const TILE = 25
const SCALE = [0.5, 1.5]
const X_HALF = 450
const Z_NEAR = -40
const Z_FAR = -750
// Metres per clump cell: one clump replaces the ~8 trees a 12.5 m cell holds.
const CELL = 12.5
const CLUMP_SCALE = [0.8, 1.2]

const out = document.getElementById('out')
const labels = document.getElementById('labels')
window.PROBE_STATE = 'running'

run().then((report) => {
  out.textContent = JSON.stringify(report, null, 1)
  window.PROBE_STATE = 'done'
}, (err) => {
  out.textContent = String(err && err.stack || err)
  window.PROBE_ERR = String(err && err.message || err)
  window.PROBE_STATE = 'error'
  throw err
})

// The ground: the eye stands on a ridge at RIDGE m, the valley floor is
// VALLEY m out, and beyond it the far side climbs at 17 degrees -- so the far
// forest is seen across a valley the way a distant forest is, not edge-on
// along its own slope. A swell across it keeps a clump's 15 m footprint on
// ground that is not flat.
const RIDGE = 60
const VALLEY = 250
function heightAt(x, z) {
  const d = -z
  const base = d < VALLEY ? RIDGE * ((VALLEY - d) / VALLEY) ** 2 : 0.3 * (d - VALLEY)
  return base + 6 * Math.sin(x / 70) * Math.cos(z / 90) + 3 * Math.sin((x - z) / 40)
}

async function run() {
  const canvas = document.getElementById('scene')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
  renderer.setSize(W, H * 3, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x8fb4d8, 1)

  const tex = buildTextureArray()
  await loadImageLayers(tex)
  const bank = buildTreeBank({ billboard: true })
  const pineIdx = bank.variants.findIndex((v) => v.species === 'pine')
  if (pineIdx < 0) throw new Error('no pine in the bank')
  const pineCard = bank.tiers[2].geometries[pineIdx]
  const clumpTier = buildTreeClumpTier(bank)
  const pineClump = clumpTier.geometries[pineIdx]
  const singles = bakeTreeImpostors(renderer, tex)
  const clumps = bakeTreeClumps(renderer, tex, bank).filter((c) => c.species === 'pine')
  tex.needsUpdate = true

  const clumpLayers = clumps.map((c) => c.layer)
  drawLayers(tex, [LAYER.IMPOSTOR_PINE, ...clumpLayers])

  // The forest's material, with the layer shift compiled in: every geometry it
  // draws has to carry `aLayerShift`, the singles' all zero.
  const material = createPropMaterial(tex, {
    billboardLayers: [LAYER.IMPOSTOR_PINE, ...treeClumpLayers()],
    vertexColors: true,
    layerShift: true,
  })
  const withShift = (geometry, n) => {
    const g = geometry.clone()
    g.setAttribute('aLayerShift', new THREE.InstancedBufferAttribute(new Float32Array(n), 1))
    return g
  }

  // The forest, tile by tile as trees.js plants it: `perTile` candidates each
  // with a rank, a size and a yaw.
  const perTile = Math.round(TILE * TILE * DENSITY)
  const trees = []
  for (let tz = Math.floor(Z_FAR / TILE); tz * TILE < Z_NEAR; tz++) {
    for (let tx = Math.floor(-X_HALF / TILE); tx * TILE < X_HALF; tx++) {
      const rand = mulberry32((tx * 7919 + tz * 104729 + 12345) | 0)
      for (let i = 0; i < perTile; i++) {
        const x = (tx + rand()) * TILE
        const z = (tz + rand()) * TILE
        const u = rand()
        const scale = SCALE[0] + rand() * (SCALE[1] - SCALE[0])
        const yaw = rand() * Math.PI * 2
        trees.push({ x, z, u, scale, yaw })
      }
    }
  }

  const eye = new THREE.Vector3(0, heightAt(0, 0) + 1.7, 0)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)

  const singlesMesh = (keep) => {
    const kept = trees.filter(keep)
    const mesh = new THREE.InstancedMesh(withShift(pineCard, Math.max(1, kept.length)), material, Math.max(1, kept.length))
    mesh.frustumCulled = false
    kept.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yaw)
      s.setScalar(t.scale)
      m.compose(new THREE.Vector3(t.x, heightAt(t.x, t.z), t.z), q, s)
      mesh.setMatrixAt(i, m)
    })
    mesh.count = kept.length
    return mesh
  }
  const every = singlesMesh(() => true)
  const shipped = singlesMesh((t) => {
    const d = Math.hypot(t.x - eye.x, t.z - eye.z)
    return t.u < FULL_RADIUS / d
  })

  // Clumps: one per cell at a jittered centre, a picture and a size by hash,
  // all in one mesh.
  const clumpGeo = withShift(pineClump, 8192)
  const clumpMesh = new THREE.InstancedMesh(clumpGeo, material, 8192)
  clumpMesh.frustumCulled = false
  clumpMesh.count = 0
  const shifts = clumpGeo.attributes.aLayerShift
  for (let cz = Math.floor(Z_FAR / CELL); cz * CELL < Z_NEAR; cz++) {
    for (let cx = Math.floor(-X_HALF / CELL); cx * CELL < X_HALF; cx++) {
      const rand = mulberry32((cx * 3571 + cz * 45007 + 777) | 0)
      const x = (cx + 0.25 + rand() * 0.5) * CELL
      const z = (cz + 0.25 + rand() * 0.5) * CELL
      const v = Math.floor(rand() * clumps.length)
      const scale = CLUMP_SCALE[0] + rand() * (CLUMP_SCALE[1] - CLUMP_SCALE[0])
      q.setFromAxisAngle(up, rand() * Math.PI * 2)
      s.setScalar(scale)
      m.compose(new THREE.Vector3(x, heightAt(x, z), z), q, s)
      shifts.setX(clumpMesh.count, v)
      clumpMesh.setMatrixAt(clumpMesh.count++, m)
    }
  }
  shifts.needsUpdate = true
  const clumpCount = clumpMesh.count

  const scene = new THREE.Scene()
  const ground = new THREE.PlaneGeometry(2 * X_HALF + 200, -Z_FAR + 200, 220, 190)
  ground.rotateX(-Math.PI / 2)
  ground.translate(0, 0, (Z_FAR - 200) / 2 + 100)
  {
    const p = ground.attributes.position
    for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)))
    ground.computeVertexNormals()
  }
  scene.add(new THREE.Mesh(ground, new THREE.MeshLambertMaterial({ color: 0x4d6b33 })))
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.1)
  sun.position.set(-0.45, 0.62, 0.3)
  scene.add(sun)
  scene.add(new THREE.HemisphereLight(0xbfd4ee, 0x2c3140, 0.85))
  scene.add(every, shipped, clumpMesh)

  const cam = new THREE.PerspectiveCamera(50, W / H, 1, 2000)
  cam.position.copy(eye)
  cam.lookAt(0, heightAt(0, -450), -450)

  const views = [
    { name: `every tree (${every.count} cards)`, show: [every] },
    { name: `shipped: rank < ${FULL_RADIUS} / d (${shipped.count} cards)`, show: [shipped] },
    { name: `clumps: one per ${CELL} m cell (${clumpCount} cards, ${clumps.length} variants, one mesh)`, show: [clumpMesh] },
  ]
  labels.innerHTML = ''
  views.forEach((view, k) => {
    for (const o of [every, shipped, clumpMesh]) o.visible = view.show.includes(o)
    renderer.setViewport(0, H * (views.length - 1 - k), W, H)
    renderer.setScissor(0, H * (views.length - 1 - k), W, H)
    renderer.setScissorTest(true)
    renderer.render(scene, cam)
    const label = document.createElement('div')
    label.textContent = view.name
    label.style.top = `${H * k + 4}px`
    labels.appendChild(label)
  })
  renderer.setScissorTest(false)

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return {
    renderer: renderer.getContext().getParameter(renderer.getContext().RENDERER),
    single: singles.find((b) => b.species === 'pine'),
    clumps,
    counts: { every: every.count, shipped: shipped.count, clumps: clumpCount },
  }
}

/** The raw texture layers, side by side; the bake stores them the screen's way up. */
function drawLayers(tex, layers) {
  const n = TEX_SIZE
  const c = document.getElementById('cards')
  c.width = layers.length * (n + 4) * CARD_ZOOM
  c.height = n * CARD_ZOOM
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#05080f'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.imageSmoothingEnabled = false
  const data = tex.image.data
  layers.forEach((layer, k) => {
    const img = ctx.createImageData(n, n)
    const base = layer * n * n * 4
    img.data.set(data.subarray(base, base + n * n * 4))
    const off = document.createElement('canvas')
    off.width = n
    off.height = n
    off.getContext('2d').putImageData(img, 0, 0)
    ctx.drawImage(off, k * (n + 4) * CARD_ZOOM, 0, n * CARD_ZOOM, n * CARD_ZOOM)
  })
}
