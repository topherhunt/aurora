import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { fetchOriginals, loadOriginal, disposeOriginal } from './props-original.js'

// ---------------------------------------------------------------------------
// The prop library browser (props.html).
//
// `scripts/check-props.mjs` proves the 160 built assets are correct -- grounded,
// scaled, one primitive per LOD, colour attribute present. It cannot tell you
// whether a birch reads as a birch, whether the 130-tri tier still has a
// silhouette, or whether an impostor is embarrassing. Those are seeing
// questions, and until this page there was nowhere to see one: nothing in the
// runtime loads `public/props` yet.
//
// Deliberately NOT the runtime path. This loads one GLB at a time with
// GLTFLoader and gives each mesh its own material; the game will pack all of
// them into one BatchedMesh against one DataArrayTexture (§5). Two consequences
// worth knowing before trusting what you see here:
//
//   Lighting matches the game's noon (one directional at 2.1, hemisphere fill at
//   0.85, Lambert, vertex colours on) so the baked AO reads the way it will in
//   world. The sky, the fog and the time of day do not.
//
//   Every texture is loaded from `public/props/layers/`, never from the GLB. The
//   GLB carries a 1x1 stub by design (see `layerTexture` below), and the
//   impostor quad has no material at all. Anything that renders these assets has
//   to wire both up itself -- a note for the runtime work, not a bug.
// ---------------------------------------------------------------------------

const PROPS = 'props/'

// --- what sways, and how ----------------------------------------------------
//
// Nothing in the runtime sways yet -- there is no wind system (§10 weather is
// unbuilt), and `shapes.js` has no vertex animation. This is a preview effect
// that lives on this page only, so that foliage can be judged in motion rather
// than as a frozen card. Amplitudes are a fraction of the asset's own height, so
// a 12 m willow and a 0.3 m tuft both move by a believable amount.
//
// `stiff` is the exponent on height-above-base: a high value pins the trunk and
// moves only the canopy, a low value bends the whole plant from the ground.
const SWAY = [
  { match: /_dead|dead_|cracked/, kind: 'bare branches', amp: 0.006, stiff: 3.0 },
  { match: /^willow/, kind: 'canopy, loose', amp: 0.020, stiff: 2.2 },
  { match: /^(pinetree|commontree|birchtree|tree_|oak)/, kind: 'canopy', amp: 0.012, stiff: 2.6 },
  { match: /^(grass|wheat|flowers|fern|horsetail|plant)/, kind: 'blade', amp: 0.075, stiff: 1.3 },
  { match: /^(bush|forest_floor)/, kind: 'shrub', amp: 0.030, stiff: 1.7 },
  { match: /^(rock|boulder|treestump|woodlog|log_|cabin|watchtower|windmill)/, kind: null, amp: 0, stiff: 1 },
]
const swayOf = (id) => SWAY.find((s) => s.match.test(id)) ?? { kind: 'canopy', amp: 0.012, stiff: 2.6 }

// --- where each family is meant to end up -----------------------------------
//
// ⚠️ PROPOSED, not implemented. The biome scatter tables do not exist (TASKS.md,
// "Biome-sensitive placement rules"): Phase A reports bare/pine/mixed/heath/lush
// per cell and nothing consumes it, while `src/props/scatter.js` still places
// four hand-built shapes by elevation band as a scale reference. This table is
// the argument for what should go where, written down where it can be looked at
// next to the actual asset -- which is the whole reason to have this page before
// writing those tables rather than after.
//
// The class ladder shown beside it IS real: it comes from the manifest and the
// runtime will read the same numbers.
const PLACEMENT = [
  { match: /^pinetree_snow/, where: 'pine, above the snow line -- the band between treeline and bare rock' },
  { match: /^pinetree_autumn/, where: 'pine and mixed, autumn dressing -- a seasonal swap for pinetree_*, not a separate species' },
  { match: /^pinetree/, where: 'pine biome, valley floor to treeline. The backbone conifer: highest density of anything here' },
  { match: /^(commontree|birchtree)_snow/, where: 'mixed, above the snow line -- thins out fast toward treeline' },
  { match: /^(commontree|birchtree)_autumn/, where: 'mixed and lush, autumn dressing' },
  { match: /^(commontree|birchtree)_dead/, where: 'sparse accent in every wooded biome, weighted toward treeline and burn scars' },
  { match: /^(commontree|birchtree)/, where: 'mixed and lush lowland, below the conifers. Birch wants river terraces and south slopes' },
  { match: /^willow_(snow|autumn|dead)/, where: 'lakeside and riverbank, seasonal or dead dressing' },
  { match: /^willow/, where: 'lakeside and riverbank only -- Phase A already knows where the water is, so this is a flow-accumulation mask, not a biome' },
  { match: /^tree_(dead_standing|cracked_dead)/, where: 'landmark snags. A handful per region in bare and heath, where a lone dead tree reads as scale' },
  { match: /^tree_/, where: 'mixed and lush lowland, low density -- these are the one-offs, so they should never repeat in view' },
  { match: /^rock_snow/, where: 'above the snow line and on bare alpine ground' },
  { match: /^rock_moss/, where: 'lush and damp lowland, forest floor, stream beds' },
  { match: /^(rock|boulder)/, where: 'every biome including bare -- boulders are the one thing with no upper elevation limit (scatter.js already does this)' },
  { match: /^bush_pine/, where: 'pine understorey and treeline scrub, where full trees stop' },
  { match: /^(bush|bushberries)/, where: 'heath and forest edge -- §5\'s "open fields of low heather scrub" is mostly these plus grass' },
  { match: /^treestump/, where: 'clearings and forest floor, correlated with tree density rather than independent of it' },
  { match: /^(woodlog|log_)/, where: 'forest floor, lying along the contour. Wants a slope-aligned rotation rule the scatter does not have yet' },
  { match: /^(forest_floor|fern|horsetail)/, where: 'damp lush forest floor, under canopy. Highest-value ground cover in the library' },
  { match: /^wheat/, where: 'village fields only -- village.js already plans where the fields are' },
  { match: /^(grass_tall|grass_wild)/, where: 'heath and lush lowland. These are the photoscans: the best ground cover here, so they carry the near field' },
  { match: /^(grass|plant|flowers)/, where: 'heath and lush lowland, dense near the player and hard-culled at 26 m' },
  { match: /^(cabin|watchtower|windmill)/, where: 'village sites only -- placed by village.js from the plan, never by the biome scatter' },
]
const placementOf = (id) => PLACEMENT.find((p) => p.match.test(id))?.where ?? 'unassigned'

// Quest 3 is ~1920 px over ~96 deg per eye. Rounded, because the point of the
// number is "is this tier resolving anything" and not the third digit.
const PX_PER_DEG = 20

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const stage = $('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x141c2b)

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.08
controls.autoRotateSpeed = 1.6

// The game's noon rig, copied from main.js so the baked AO reads the same here.
scene.add(new THREE.HemisphereLight(0xbfd4ee, 0x2c3140, 0.85))
const sun = new THREE.DirectionalLight(0xfff2dc, 2.1)
sun.position.set(-0.45, 0.62, 0.3).normalize()
scene.add(sun)

let grid = null

// A 1.75 m person. Every asset in the library is scaled to a declared
// real-world height, and this is the only way to check that declaration by eye
// -- which is exactly how the one wrong one was caught (§9, forest_floor_cluster
// at 167 m).
const human = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.22, 1.31, 4, 12),
  new THREE.MeshLambertMaterial({ color: 0x4a6f9c, transparent: true, opacity: 0.55 })
)
human.position.y = 0.875
scene.add(human)

const resize = () => {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

// One uniform set shared by every material on screen, so the sway toggle is a
// single assignment rather than a walk of the scene graph.
const wind = { uTime: { value: 0 }, uSway: { value: 0 }, uStiff: { value: 2 }, uHeight: { value: 1 } }

function swayable(mat) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wind)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uSway; uniform float uStiff; uniform float uHeight;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // Bend, do not translate: the displacement is weighted by height above
        // the base, so the foot stays planted and the tip carries the motion.
        float swayH = clamp(transformed.y / max(uHeight, 1e-4), 0.0, 1.0);
        float swayK = pow(swayH, uStiff) * uSway * uHeight;
        float swayP = dot(transformed.xz, vec2(0.7, 1.3));
        // A slow envelope over a fast carrier is what makes it read as gusting
        // wind rather than as a metronome.
        float swayG = 0.65 + 0.35 * sin(uTime * 0.31 + swayP * 0.05);
        transformed.x += swayK * swayG * sin(uTime * 1.7 + swayP);
        transformed.z += swayK * swayG * 0.6 * sin(uTime * 2.3 + swayP * 1.7 + 1.1);`)
  }
  return mat
}

// The runtime's material, per §5/§7: Lambert, double-sided, binary cutout. The
// GLB declares `alphaMode: BLEND`, which is not what ships -- alpha blending
// cannot be depth-sorted inside a batched draw call, so the runtime is
// alphaTest 0.5 and this page matches the runtime, not the file.
function propMaterial(map) {
  return swayable(new THREE.MeshLambertMaterial({
    color: 0xffffff,
    map: map ?? null,
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    transparent: false,
  }))
}

// ⚠️ The texture a prop renders with is NOT the one inside its GLB.
//
// `finalize_material` embeds a 1x1 stub image and ships the real 128² bake as a
// loose PNG, because the runtime samples it out of the `uArrAsset`
// DataArrayTexture and embedding it too would duplicate every layer. The stub
// exists only to make the exporter treat UVMap as used, and it is BLACK -- so
// anything that loads these GLBs naively and trusts `material.map` renders all
// 21 textured assets as solid black silhouettes. Loading the loose layer is not
// a workaround for this page; it is what the runtime has to do as well.
const texLoader = new THREE.TextureLoader()
const layerCache = new Map()
function layerTexture(path) {
  if (!layerCache.has(path)) {
    const t = texLoader.load(PROPS + path)
    t.colorSpace = THREE.SRGBColorSpace
    t.magFilter = THREE.LinearFilter
    // These UVs came out of the glTF exporter, so they use glTF's top-left
    // origin. TextureLoader defaults to flipY (the DOM convention) and would
    // hang every layer upside down; GLTFLoader compensates the same way for its
    // own textures, which is why the stub looked fine.
    t.flipY = false
    layerCache.set(path, t)
  }
  return layerCache.get(path)
}

// --- does the mesh still land on its own texture? ---------------------------
//
// Does this tier's atlas actually reach this tier's triangles?
//
// It is not a rhetorical question. The bake used to run once on the full-res
// object with the LOD chain decimated from it afterwards, and nothing rechecked
// that the surviving triangles still pointed at anything: a 1M-tri photoscan cut
// to 149 triangles had UVs stretched across the gutters, and at alphaTest 0.5
// every fragment landing in a gutter is discarded. `build.py` bakes per tier now
// and the numbers below went from 0% to 100%, but the check stays, because the
// failure is completely silent -- the GLB loads, the manifest is consistent, and
// `check-props.mjs` passes byte-for-byte on an asset that renders as nothing.
//
// Rasterise the UV footprint rather than sampling the centroid. A decimated
// alpha-card mesh is a few big quads whose CUTOUT is the shape, so a centroid
// landing in a transparent hole is expected and means nothing; and conversely a
// smeared unwrap collapses most triangles below one texel, where an area-only
// measure would skip them and score the wreck 100% clean. Both instruments got
// this wrong in opposite directions before they were combined.
const pixCache = new Map()
async function layerPixels(path) {
  if (!pixCache.has(path)) {
    const img = new Image()
    img.src = PROPS + path
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    pixCache.set(path, g.getImageData(0, 0, img.width, img.height))
  }
  return pixCache.get(path)
}

function auditMesh(mesh, px) {
  const uv = mesh.geometry.getAttribute('uv')
  const index = mesh.geometry.getIndex()
  if (!uv) return null
  const count = index ? index.count : uv.count
  const at = (i) => (index ? index.getX(i) : i)
  const W = px.width
  const H = px.height
  let tris = 0
  let hit = 0 // texels the mesh addresses
  let opaque = 0 // ...of which survive alphaTest 0.5
  let sum = 0 // luminance of those that survive
  const P = [[0, 0], [0, 0], [0, 0]]
  for (let t = 0; t + 2 < count; t += 3) {
    tris++
    for (let k = 0; k < 3; k++) {
      // glTF UVs use a top-left origin and getImageData rows are top-left too,
      // so v indexes the row directly. Confirmed by measurement: flipping it
      // makes strictly more assets sample empty space, not fewer.
      P[k][0] = uv.getX(at(t + k)) * W
      P[k][1] = uv.getY(at(t + k)) * H
    }
    const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])))
    const x1 = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])))
    const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])))
    const y1 = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])))
    const d = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1])
    let got = 0
    if (d !== 0) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const cx = x + 0.5
          const cy = y + 0.5
          const w0 = ((P[1][0] - cx) * (P[2][1] - cy) - (P[2][0] - cx) * (P[1][1] - cy)) / d
          const w1 = ((P[2][0] - cx) * (P[0][1] - cy) - (P[0][0] - cx) * (P[2][1] - cy)) / d
          if (w0 < 0 || w1 < 0 || 1 - w0 - w1 < 0) continue
          got++
          tally((y * W + x) * 4)
        }
      }
    }
    // Sub-texel in the atlas is still a real triangle on screen, so fall back to
    // one centroid sample rather than dropping it.
    if (got === 0) {
      const x = Math.min(W - 1, Math.max(0, Math.floor((P[0][0] + P[1][0] + P[2][0]) / 3)))
      const y = Math.min(H - 1, Math.max(0, Math.floor((P[0][1] + P[1][1] + P[2][1]) / 3)))
      tally((y * W + x) * 4)
    }
  }
  function tally(i) {
    hit++
    if (px.data[i + 3] < 128) return
    opaque++
    sum += (px.data[i] + px.data[i + 1] + px.data[i + 2]) / 3
  }
  // Everything above measures the TEXTURE. None of it measures the mesh, and a
  // tier can score 89% here and be invisible: a collapse that flattens a grass
  // blade leaves the triangle addressing perfectly good green texels while
  // giving it no area at all. So measure the geometry too, in metres, from the
  // positions rather than the scaled object.
  const pos = mesh.geometry.getAttribute('position')
  let area = 0
  let degen = 0
  for (let t = 0; t + 2 < count; t += 3) {
    const [i, j, k] = [at(t), at(t + 1), at(t + 2)]
    const ax = pos.getX(j) - pos.getX(i), ay = pos.getY(j) - pos.getY(i), az = pos.getZ(j) - pos.getZ(i)
    const bx = pos.getX(k) - pos.getX(i), by = pos.getY(k) - pos.getY(i), bz = pos.getZ(k) - pos.getZ(i)
    const a = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
    area += a
    if (a < 1e-4) degen++ // 1 cm^2: under a pixel at any distance you would see it from
  }
  return { kind: 'mesh', tris, hit, opaque, lum: opaque ? sum / opaque : 0, area, degen }
}

// An impostor is a handful of full-sheet quads, so the per-triangle probe above
// is the wrong instrument -- six samples of a sheet that is mostly transparent
// sky reports "83% cut" for a perfectly good billboard. Measure the sheet itself
// instead: how much of it is drawn, and whether what is drawn has any colour.
function auditSheet(px) {
  let lit = 0
  let sum = 0
  for (let i = 0; i < px.data.length; i += 4) {
    if (px.data[i + 3] < 128) continue
    lit++
    sum += (px.data[i] + px.data[i + 1] + px.data[i + 2]) / 3
  }
  const texels = px.data.length / 4
  return { kind: 'sheet', cover: lit / texels, lum: lit ? sum / lit : 0 }
}

// ---------------------------------------------------------------------------
// Loading one asset
// ---------------------------------------------------------------------------

const gltfLoader = new GLTFLoader()
let current = null // { asset, tiers: [{lod, object}], mixer, clips, box, original }
// A tier index, or ORIG for the source file -- which is not a tier: it has no
// budget and no place in the LOD chain, and is here to be compared against them.
const ORIG = 'orig'
let activeTier = 0

// Per-asset source records from the dev server (the propOriginals plugin in
// vite.config.js): where the source is, whether it is still on disk, and where
// its textures are. Null means the endpoint answered with nothing, which is what
// a built deploy does -- there is no dev server there and no tmp/ either.
let originals = null
let origIndexError = null
let origStatus = null // progress line while an original loads
let origError = null

function disposeCurrent() {
  if (!current) return
  if (current.original) {
    scene.remove(current.original.root)
    disposeOriginal(current.original)
  }
  scene.remove(current.root)
  const disposed = new Set()
  current.root.traverse((o) => {
    if (!o.isMesh) return
    // Geometry and material are per-asset; the layer textures are cached and
    // shared across selections, so they are deliberately not disposed here.
    // Tiers on one sheet share a material, so the Set keeps this to one
    // dispose per material rather than one per tier.
    o.geometry.dispose()
    if (!disposed.has(o.material)) {
      disposed.add(o.material)
      o.material.dispose()
    }
  })
  current = null
  origStatus = null
  origError = null
}

async function select(asset) {
  disposeCurrent()
  renderStats(asset, null)
  for (const b of document.querySelectorAll('.item')) b.classList.toggle('sel', b.dataset.id === asset.id)

  const gltf = await gltfLoader.loadAsync(PROPS + asset.glb)
  const root = new THREE.Group()
  const byName = new Map()
  gltf.scene.traverse((o) => { if (o.isMesh) byName.set(o.name, o) })

  const tiers = []
  const mats = new Map()
  for (const lod of asset.lods) {
    const mesh = byName.get(lod.name)
    if (!mesh) continue // check-props.mjs would have failed the build; nothing to do here
    // Every tier names its own sheet -- an impostor its billboard render, a mesh
    // tier the atlas baked against that tier's own triangulation -- or names
    // nothing at all when its colour lives entirely in vertex colours.
    // Billboard COLOR_0 is white, so vertex colours are a no-op there rather
    // than a second multiply against an already-lit sheet.
    const layer = lod.layer
    // One material per SHEET, not per tier. A decimated asset bakes a fresh
    // atlas per tier, so its tiers really do want three; a generated one shares
    // a UV layout across its tiers and names the same `shared_layer` three
    // times, and giving each an identical Lambert makes the page report three
    // materials for what the runtime draws with one. Keyed on the layer path,
    // with `''` standing in for the vertex-colour-only tiers so they share too.
    const key = layer ?? ''
    if (!mats.has(key)) mats.set(key, propMaterial(layer ? layerTexture(layer) : null))
    mesh.material = mats.get(key)
    mesh.visible = false
    root.add(mesh)
    tiers.push({ lod, mesh, layer, audit: null })
  }
  scene.add(root)

  const mixer = gltf.animations.length ? new THREE.AnimationMixer(root) : null
  const box = new THREE.Box3().setFromObject(tiers[0].mesh)
  current = { asset, root, tiers, mixer, clips: gltf.animations, box, original: null, origLoading: false }

  const sway = swayOf(asset.id)
  wind.uHeight.value = asset.height_m
  wind.uStiff.value = sway.stiff
  applySway()

  fitGround(box) // places the reference, which `frame` then has to fit
  frame(box)
  setTier(0)
  renderStats(asset, current)

  // After the first paint: decoding the layer and walking every triangle is not
  // worth making the model wait behind.
  for (const t of tiers.filter((t) => t.layer)) {
    const px = await layerPixels(t.layer)
    t.audit = t.lod.kind === 'billboard' ? auditSheet(px) : auditMesh(t.mesh, px)
  }
  if (current?.asset === asset) renderStats(asset, current)
}

function frame(box) {
  const size = box.getSize(new THREE.Vector3())
  const sphere = box.getBoundingSphere(new THREE.Sphere())
  // Fit the bounding sphere to whichever field of view is tighter, rather than
  // guessing a distance off the largest dimension: the stage is much wider than
  // it is tall, so the vertical FOV is what actually crops, and a wide flat
  // asset framed off its width sat as a strip across the bottom of the frame.
  //
  // Fit the human reference in too. It is the only thing that makes a sub-metre
  // asset legible -- a 0.85 m grass clump means nothing without it -- so leaving
  // it out of the fit just crops it to a blue wall at the edge of the frame.
  const ref = human.visible ? Math.abs(human.position.x) + 0.25 : 0
  const radius = Math.max(sphere.radius, ref, 0.12)
  const vfov = THREE.MathUtils.degToRad(camera.fov)
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect)
  const dist = 1.15 * radius / Math.sin(Math.min(vfov, hfov) / 2)
  controls.target.set(0, size.y * 0.45, 0)
  camera.position.set(dist * 0.48, size.y * 0.55 + radius * 0.35, dist * 0.88)
  camera.near = Math.max(dist / 500, 0.005)
  camera.far = dist * 200
  camera.updateProjectionMatrix()
  controls.update()
}

function fitGround(box) {
  const size = box.getSize(new THREE.Vector3())
  const span = Math.max(2, Math.ceil(Math.max(size.x, size.z, size.y * 0.6) * 1.6))
  if (grid) {
    scene.remove(grid)
    grid.geometry.dispose()
    grid.material.dispose()
  }
  grid = new THREE.GridHelper(span, span, 0x3c5f8c, 0x223550) // one cell = 1 m
  grid.material.transparent = true
  grid.material.opacity = 0.55
  scene.add(grid)
  // Negative x, because `frame` puts the camera on the positive side: standing
  // the reference on the camera's own side made a 1.75 m capsule the nearest
  // thing in the scene, and it filled a third of the frame while the asset it
  // was meant to give scale to sat small and far behind it.
  human.position.x = -(size.x * 0.5 + 0.6)
}

function setTier(i) {
  if (!current) return
  const orig = i === ORIG && Boolean(current.original)
  activeTier = orig ? ORIG : Math.min(i === ORIG ? 0 : i, current.tiers.length - 1)
  // No re-frame on a tier change, the original included: the camera staying
  // exactly where it was is the whole instrument. The original is normalised to
  // the same declared height as the built tiers, so it lands in the same frame.
  current.tiers.forEach((t, n) => { t.mesh.visible = !orig && n === activeTier })
  if (current.original) current.original.root.visible = orig
  // Labels come from this asset's own chain, not from the button's position: a
  // `structure` has two tiers where the second one is the impostor, so a fixed
  // "L0 L1 bb" would offer an "L1" that is actually the billboard.
  for (const b of $('lodBtns').children) {
    const n = Number(b.dataset.i)
    const tier = current.tiers[n]
    b.disabled = !tier
    b.textContent = tier ? (tier.lod.kind === 'billboard' ? 'bb' : 'L' + n) : '--'
    b.classList.toggle('on', n === activeTier)
  }
  paintOrigBtn()
  for (const r of document.querySelectorAll('.lods tr')) r.classList.toggle('act', r.dataset.i === String(activeTier))
}

// ---------------------------------------------------------------------------
// The original
//
// The half of the question this page could not reach. When a built prop looks
// bad, "is the SOURCE any good" decides whether it is worth another pass at a
// different budget or should be dropped -- and the sources are 120 MB photoscans
// in a gitignored tmp/ that nothing could open. They are loaded from there in
// place, in their original format, by props-original.js.
// ---------------------------------------------------------------------------

const origEntry = (a) => (originals ? originals[a.id] ?? null : null)

function paintOrigBtn() {
  const b = $('origBtn')
  const entry = current ? origEntry(current.asset) : null
  const loading = Boolean(current?.origLoading)
  b.disabled = !entry?.exists || loading
  b.classList.toggle('on', activeTier === ORIG)
  b.textContent = loading ? 'orig...' : 'orig'
  b.title = origIndexError
    ? origIndexError
    : !originals
    ? 'originals need the dev server -- this page was served from a build'
    : !entry
      ? (current?.asset.generated
        ? 'generated, not built from a source file -- tier 1 is the original'
        : 'no source record: this id is not in tools/props/manifest.json')
      : !entry.exists
        ? 'source is gone from tmp/: ' + entry.src
        : entry.src + ' -- ' + (entry.bytes / 1e6).toFixed(1) + ' MB, loads on demand'
}

// On demand, never on selection: the sources run to 120 MB and two million
// triangles, and stepping through the library with the arrow keys would pull
// gigabytes for assets nobody asked to see the inside of.
async function showOriginal() {
  const asset = current?.asset
  const entry = asset ? origEntry(asset) : null
  if (!asset || !entry?.exists || current.origLoading) return
  if (current.original) { setTier(ORIG); return }

  current.origLoading = true
  origError = null
  paintOrigBtn()
  try {
    const loaded = await loadOriginal(entry, asset.height_m, (msg) => {
      if (current?.asset !== asset) return
      origStatus = msg
      const line = $('origLine')
      if (line) line.textContent = msg
    })
    // The list is steppable with the arrow keys and a parse takes seconds, so
    // the selection can have moved on. Throw the result away rather than drop a
    // birch log into a pine tree's frame.
    if (current?.asset !== asset) { disposeOriginal(loaded); return }
    loaded.root.visible = false
    scene.add(loaded.root)
    current.original = loaded
    origStatus = null
    setTier(ORIG)
  } catch (err) {
    origStatus = null
    origError = err.message
    console.error(err)
  } finally {
    if (current) current.origLoading = false
    if (current?.asset === asset) renderStats(asset, current)
    paintOrigBtn()
  }
}

// ---------------------------------------------------------------------------
// The stats panel
// ---------------------------------------------------------------------------

// What the source file is, and -- once it has been loaded -- what it actually
// contained. The numbers here are the ones the salvage decision turns on: a
// source with 2 M triangles and an 8K albedo that reads as mush at LOD0 is a
// budget problem worth another pass, and a source that already looks like the
// LOD is not salvageable at any budget and should be dropped.
function originalBlock(a, live) {
  if (origIndexError) {
    return `<div class="warn" style="margin-top:6px">${esc(origIndexError)}</div>`
  }
  if (!originals) {
    return `<div class="note" style="margin-top:6px">The original is a dev-server feature. It is read out of the
      gitignored <code>tmp/</code> tree, which no build contains and nothing deploys; run <code>npm run dev</code>
      to compare an asset against the file it was built from.</div>`
  }
  const entry = origEntry(a)
  // Generated props have no source to go behind: src/props/*.js writes their
  // LOD0 directly, so the first tier above IS the original and there is no
  // decimation step between the two to inspect.
  if (!entry && a.generated) {
    return `<div class="note" style="margin-top:6px">Generated, not built from a source file &mdash; <code>${
      esc(a.src ?? '')}</code> is its own LOD0. What you see in tier 1 is the original.</div>`
  }
  if (!entry) return '<div class="warn" style="margin-top:6px">No source record: this id is not in tools/props/manifest.json.</div>'

  if (!entry.exists) {
    const kept = Object.values(originals).filter((e) => e.exists).length
    const all = Object.keys(originals).length
    return `<div class="warn" style="margin-top:6px">This source is no longer on disk, so this asset cannot be
      compared against what it was built from -- and cannot be rebuilt at a different budget either. ${all - kept} of
      ${all} sources are gone the same way (deleted from <code>tmp/</code> after the build);
      the ${kept} that remain are marked &#9670; in the list.</div>`
  }

  const st = live?.original?.stats
  const loading = Boolean(live?.origLoading)
  const rows = [
    ['format', `${esc(entry.src.split('.').pop().toUpperCase())}, ${(entry.bytes / 1e6).toFixed(1)} MB on disk`],
  ]
  if (st) {
    // The reduction the pipeline actually performed, measured against the source
    // as the browser reads it rather than as Blender read it. The two can differ
    // -- build.py welds first -- and the manifest's own `src_tris` is above.
    const pct = (100 * a.lods[0].tris / st.tris).toFixed(3)
    rows.push(
      ['geometry', `${st.tris.toLocaleString()} tris, ${st.verts.toLocaleString()} verts`],
      ['parts', `${st.meshes} mesh${st.meshes === 1 ? '' : 'es'}, ${st.materials} material${st.materials === 1 ? '' : 's'}`],
      ['LOD0 is', `${pct}% of it (${a.lods[0].tris} tris)`],
      ['scaled by', `${st.scale.toExponential(2)} to ${a.height_m.toFixed(2)} m`],
      ['footprint', `${st.size.x.toFixed(2)} &times; ${st.size.z.toFixed(2)} m`],
      ['load', `${(st.readMs / 1000).toFixed(1)} s read, ${(st.parseMs / 1000).toFixed(1)} s parse`],
    )
    for (const t of st.textures) {
      const shrunk = t.srcSize.w !== t.size.w
      // "guessed" is worth saying out loud: it means the source did not name
      // this file and it was matched by name against what sits beside it, so a
      // wrong texture here is this page's mistake, not the asset's.
      rows.push(['texture', `${esc(t.path.split('/').pop())} &mdash; ${t.srcSize.w}&times;${t.srcSize.h}${
        shrunk ? ` shown at ${t.size.w}&times;${t.size.h}` : ''}${t.guessed ? ' <i>guessed</i>' : ''}`])
    }
  }

  return `
    <table style="margin-top:6px">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
    ${loading ? `<div class="note" id="origLine" style="margin-top:4px">${esc(origStatus ?? 'loading...')}</div>` : ''}
    ${origError ? `<div class="warn" style="margin-top:6px">The original would not load: ${esc(origError)}</div>` : ''}
    ${st?.missingTextures.length ? `<div class="warn" style="margin-top:6px">${st.missingTextures.length} texture(s)
      the source names were not found next to it: ${esc(st.missingTextures.slice(0, 4).join(', '))}. Those materials are
      showing untextured here, which is a fact about this download, not about the asset -- build.py resolves the same
      names the same way and would have warned at build time.</div>` : ''}
    ${st ? `<div class="note" style="margin-top:6px">Shown in this page's material, not its author's: Lambert,
      double-sided, alphaTest 0.5, same lights as the tiers above. The difference you see between
      <b>orig</b> and <b>L0</b> is the pipeline's doing and not the shading model's.</div>`
      : !loading ? '<div class="note" style="margin-top:6px">Press <b>o</b> or the <b>orig</b> button to load it.</div>' : ''}
  `
}

function renderStats(a, live) {
  const cls = manifest.classes[a.class]
  const sway = swayOf(a.id)
  const size = live ? live.box.getSize(new THREE.Vector3()) : null
  const reduction = ((1 - a.lods[0].tris / a.src_tris) * 100).toFixed(1)

  // Where each tier is actually used, read off the class ladder. The last mesh
  // tier runs to the impostor distance if there is one, otherwise to the cull.
  const bands = []
  const meshTiers = a.lods.filter((l) => l.kind === 'mesh')
  const bbEnd = cls.billboard_m ?? cls.cull_m
  meshTiers.forEach((l, i) => {
    const from = i === 0 ? 0 : cls.lod0_m
    const to = i === meshTiers.length - 1 ? bbEnd : cls.lod0_m
    bands.push([l.name, from, to])
  })
  if (cls.billboard_m) bands.push([a.lods[a.lods.length - 1].name, cls.billboard_m, cls.cull_m])

  const lodRows = a.lods.map((l, i) => {
    const band = bands.find((b) => b[0] === l.name)
    const stalled = l.tris > l.target_tris
    // Angular size at the far end of the tier's own band, in headset pixels.
    // This is the honest test of whether a tier is earning its place: §5's
    // argument is that a 128 px impostor beats a 45-tri mesh at the same size.
    const px = band ? (2 * Math.atan(a.height_m / (2 * band[2])) * 180 / Math.PI * PX_PER_DEG) : null
    return `<tr data-i="${i}">
      <td>${esc(l.kind === 'billboard' ? 'impostor' : 'LOD' + i)}</td>
      <td class="num${stalled ? ' warn' : ''}">${l.tris}</td>
      <td class="num note">${l.target_tris}</td>
      <td class="num">${l.verts}</td>
      <td class="num note">${band ? band[1] + '-' + band[2] + ' m' : '--'}</td>
      <td class="num note">${px ? px.toFixed(0) + ' px' : '--'}</td>
    </tr>`
  }).join('')

  const stalls = a.lods.filter((l) => l.tris > l.target_tris)

  // Texture audit, once the async pass has filled it in. Label from the tier's
  // own position, not the filtered one: an asset with a billboard sheet but no
  // albedo layer drops its mesh tiers here, which would relabel the impostor as
  // LOD0.
  const audited = (live?.tiers ?? [])
    .map((t, i) => [t.lod.kind === 'billboard' ? 'impostor' : 'LOD' + i, t.audit])
    .filter(([, au]) => au)

  // Two different defects, two different sentences, because they have two
  // different causes and one does not imply the other.
  const meshes = audited.filter(([, au]) => au.kind === 'mesh')
  const lostTier = meshes
    .map(([label, au]) => ({ label, pct: 100 * (au.hit - au.opaque) / Math.max(1, au.hit) }))
    .sort((x, y) => y.pct - x.pct)
    .find((w) => w.pct > 25)
  // 8, not 12: a bake that has actually failed measures 0, while `grass_wild_scan_c`
  // is a legitimately dark clump of a dark scan at 11 and must not be accused.
  const blackTier = meshes.find(([, au]) => au.opaque > au.hit * 0.1 && au.lum < 8)
  const blackSheet = audited.some(([, au]) => au.kind === 'sheet' && au.cover > 0.02 && au.lum < 8)
  // The mesh defect none of the texture measurements can see. Same AND as the
  // gate: a fern is legitimately 6 slivers in 15, a wispy tuft is legitimately
  // thin, and only a tier that is both has actually been crushed.
  // Silhouette a solid prop of these dimensions would present from the side.
  const hullArea = size ? Math.max(size.x, size.z) * size.y : a.height_m * a.height_m
  const crushed = meshes.find(([, au]) => au.degen > au.tris * 0.25 && au.area < 0.05 * hullArea)
  // One thumbnail per SHEET. A decimated asset bakes a fresh atlas per tier, and
  // seeing LOD0's next to LOD1's is how you tell a bad unwrap at a low budget
  // apart from a bad bake -- they need different fixes -- so those still get one
  // figure each. A generated asset names one `shared_layer` from every tier, and
  // printing the same PNG three times only implied a cost it does not have; the
  // label then carries every tier that lands on it.
  const bySheet = new Map()
  for (const l of a.lods) {
    if (!l.layer) continue
    if (!bySheet.has(l.layer)) bySheet.set(l.layer, [])
    bySheet.get(l.layer).push(l)
  }
  const sheets = [...bySheet].map(([layer, lods]) => {
    const bb = lods[0].kind === 'billboard'
    const tier = lods.map((l) => l.name.split('_').pop()).join(' + ')
    const label = bb ? `impostor ${manifest.billboard_size}` : `${tier} ${manifest.layer_size}`
    return `<figure><img src="${PROPS}${layer}" alt="${esc(label)}"><figcaption>${esc(label)}&sup2;</figcaption></figure>`
  })

  $('stats').innerHTML = `
    <h1>${esc(a.id)}</h1>
    <div class="sub">${esc(a.class)} &middot; ${esc(cls.note)}</div>

    <h2>geometry</h2>
    <table>
      <tr><td>height</td><td class="num">${a.height_m.toFixed(2)} m</td></tr>
      ${size ? `<tr><td>footprint</td><td class="num">${size.x.toFixed(2)} &times; ${size.z.toFixed(2)} m</td></tr>` : ''}
      <tr><td>source</td><td class="num">${a.src_tris.toLocaleString()} tris</td></tr>
      <tr><td>welded</td><td class="num">${a.welded_tris.toLocaleString()} tris</td></tr>
      <tr><td>reduction</td><td class="num">${reduction}% to LOD0</td></tr>
      <tr><td>on disk</td><td class="num">${(a.glb_bytes / 1024).toFixed(1)} kB</td></tr>
    </table>

    <h2>lod chain</h2>
    <table class="lods">
      <tr><th>tier</th><th class="num">tris</th><th class="num">aim</th><th class="num">verts</th><th class="num">used</th><th class="num">tall at</th></tr>
      ${lodRows}
    </table>
    <div class="note" style="margin-top:6px">
      &quot;used&quot; is the class ladder from the manifest; &quot;tall at&quot; is how many
      headset pixels the asset spans at the far end of that band (~${PX_PER_DEG} px/deg on Quest 3).
      Verts matter on their own: BatchedMesh reserves storage against vertex count, not triangles.
    </div>
    ${stalls.length ? `<div class="warn" style="margin-top:6px">${stalls.length} tier(s) stalled above target -- the collapse
      decimator will not collapse across an open boundary, and these are real triangles the budget pays for.</div>` : ''}

    <h2>surface</h2>
    <table>
      ${meshes.map(([label, au]) => {
        const bad = au.degen > au.tris * 0.25
        return `<tr><td>${esc(label)}</td><td class="num ${bad ? 'warn' : ''}">${au.area.toFixed(3)} m&sup2;, ${au.degen} of ${au.tris} tris under 1 cm&sup2;</td></tr>`
      }).join('')}
    </table>
    ${crushed ? `<div class="warn" style="margin-top:6px">This tier was crushed, not simplified.
      <b>${esc(crushed[0])}</b> keeps its triangles and loses their area, which is what a collapse decimator does to
      a mesh of thin blades or cards. The texture measurements below will look fine -- the surviving triangles still
      address good texels -- and the asset will still render as nothing. Raising the target buys the area back at a
      price the scatter cannot pay; the answer is a different source.</div>` : ''}

    <h2>colour</h2>
    <table>
      <tr><td>source</td><td>${esc(a.color_source.replace(/_/g, ' '))}</td></tr>
      <tr><td>AO</td><td>baked into vertex colours</td></tr>
      ${audited.map(([label, au]) => {
        if (au.kind === 'sheet') {
          const dead = au.cover > 0.02 && au.lum < 8
          return `<tr><td>${esc(label)} sheet</td><td class="${dead ? 'warn' : ''}">${(100 * au.cover).toFixed(0)}% covered, mean RGB ${au.lum.toFixed(0)}${dead ? ' -- black' : ''}</td></tr>`
        }
        const kept = 100 * au.opaque / Math.max(1, au.hit)
        const bad = kept < 75 || au.lum < 8
        return `<tr><td>${esc(label)} on tex</td><td class="${bad ? 'warn' : ''}">${kept.toFixed(0)}% of its UV footprint survives alphaTest, mean RGB ${au.lum.toFixed(0)}</td></tr>`
      }).join('')}
    </table>
    ${lostTier ? `<div class="warn" style="margin-top:6px">The bake has come unstuck from the mesh.
      <b>${lostTier.pct.toFixed(0)}% of the atlas area ${esc(lostTier.label)} addresses</b> is transparent, so those
      fragments are discarded at alphaTest 0.5. At ${(100 * a.lods[0].tris / a.src_tris).toFixed(2)}% of the source
      triangles, this tier's UVs are not describing this tier's triangles -- check that
      <code>consolidate_texture</code> ran on the decimated mesh rather than on the full-res source.</div>` : ''}
    ${blackTier ? `<div class="warn" style="margin-top:6px">The albedo baked black.
      <b>${esc(blackTier[0])}</b> lands on opaque texels with no colour in them. The usual cause is a source material
      that is physically not diffuse -- <code>metallicFactor: 1.0</code> makes the Cycles diffuse pass legitimately
      zero -- which <code>neutralize_pbr</code> is supposed to strip before the bake.</div>` : ''}
    ${blackSheet ? `<div class="warn" style="margin-top:6px">The impostor sheet is black.
      <code>render_billboard</code> re-shades LOD0's material as emission of its base colour, so it renders black
      whenever the albedo it samples is black or absent -- either the mesh albedo above is bad, or the real image
      was swapped for the 1&times;1 export stub before the render instead of after.</div>` : ''}
    ${sheets.length ? `<div class="sheet" style="margin-top:6px">${sheets.join('')}</div>` : '<div class="note">no texture layer -- flat material colours became vertex colours, so this asset costs zero of the 256 array slots.</div>'}

    <h2>motion</h2>
    <table>
      <tr><td>clips</td><td>${live ? (live.clips.length || 'none') : '...'}</td></tr>
      <tr><td>sway</td><td>${sway.kind ? esc(sway.kind) + ' (preview only)' : 'rigid'}</td></tr>
    </table>
    ${live && !live.clips.length ? `<div class="note" style="margin-top:4px">No asset in this library is animated: it is environmental props only,
      and the pipeline joins and decimates meshes, which discards any skinning. Sway is a vertex effect on this page alone -- the runtime has no wind system yet.</div>` : ''}

    <h2>placement</h2>
    <table>
      <tr><td>LOD0 to</td><td class="num">${cls.lod0_m} m</td></tr>
      ${cls.billboard_m ? `<tr><td>impostor at</td><td class="num">${cls.billboard_m} m</td></tr>` : ''}
      <tr><td>culled at</td><td class="num">${cls.cull_m} m</td></tr>
    </table>
    <div style="margin-top:6px">${esc(placementOf(a.id))}</div>
    <div class="note" style="margin-top:4px">⚠️ The distances above are real and come from the manifest. The
      sentence is a <em>proposal</em> -- the biome scatter tables do not exist yet, and nothing in the runtime loads this library.</div>

    <h2>source</h2>
    <div class="path">${esc(a.src)}</div>
    ${originalBlock(a, live)}
  `
  for (const r of document.querySelectorAll('.lods tr')) {
    if (r.dataset.i !== undefined) r.onclick = () => setTier(Number(r.dataset.i))
  }
  if (live) setTier(activeTier)
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

let manifest = null
let shown = []
const active = new Set()
let onlyOrig = false

function buildList() {
  const q = $('search').value.trim().toLowerCase()
  shown = manifest.assets.filter((a) =>
    (!active.size || active.has(a.class)) && (!q || a.id.includes(q)) &&
    (!onlyOrig || Boolean(origEntry(a)?.exists))
  )
  const list = $('list')
  list.innerHTML = ''
  let group = null
  for (const a of shown) {
    if (a.class !== group) {
      group = a.class
      const h = document.createElement('div')
      h.className = 'group'
      h.textContent = `${group} -- ${shown.filter((x) => x.class === group).length}`
      list.appendChild(h)
    }
    const b = document.createElement('button')
    b.className = 'item'
    b.dataset.id = a.id
    // The diamond is "the file this was built from is still on disk": 21 of 154,
    // and the only assets whose source can be looked at or rebuilt at all.
    const og = origEntry(a)?.exists ? '<span class="og" title="source still in tmp/">&#9670;</span>' : ''
    b.innerHTML = `<span class="cl cl-${a.class}"></span><span class="nm">${esc(a.id)}</span>${og}<span class="tr">${a.lods[0].tris}</span>`
    b.onclick = () => select(a)
    list.appendChild(b)
  }
  if (!shown.length) list.innerHTML = '<div class="group">nothing matches</div>'
}

function step(delta) {
  if (!current || !shown.length) return
  const i = shown.findIndex((a) => a.id === current.asset.id)
  const next = shown[Math.max(0, Math.min(shown.length - 1, i + delta))]
  if (next && next !== current.asset) {
    select(next)
    document.querySelector(`.item[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

let swayOn = true
function applySway() {
  const sway = current ? swayOf(current.asset.id) : { amp: 0 }
  wind.uSway.value = swayOn ? sway.amp : 0
  $('swayBtn').classList.toggle('on', swayOn && sway.amp > 0)
  $('swayBtn').disabled = !sway.amp
}

// One toggle for both the button and `o`: press it again to go back to L0, so
// the comparison the page exists for is one key held down and let go.
const toggleOriginal = () => (activeTier === ORIG ? setTier(0) : showOriginal())
$('origBtn').onclick = toggleOriginal
$('swayBtn').onclick = () => { swayOn = !swayOn; applySway() }
$('spinBtn').onclick = () => {
  controls.autoRotate = !controls.autoRotate
  $('spinBtn').classList.toggle('on', controls.autoRotate)
}
// Re-frame on toggle: the reference is part of the fit, so turning it off should
// close the camera back in on the asset rather than leave the gap it occupied.
$('refBox').onchange = (e) => {
  human.visible = e.target.checked
  if (current) frame(current.box)
}
$('search').oninput = buildList
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return
  if (e.key === 'ArrowDown') { step(1); e.preventDefault() }
  if (e.key === 'ArrowUp') { step(-1); e.preventDefault() }
  if (e.key >= '1' && e.key <= '3') setTier(Number(e.key) - 1)
  if (e.key === 'o' || e.key === 'O') toggleOriginal()
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta()
  wind.uTime.value += dt
  current?.mixer?.update(dt)
  controls.update()
  renderer.render(scene, camera)
})

async function boot() {
  manifest = await (await fetch(PROPS + 'manifest.json')).json()
  // Before the list is built: the "has an original" filter and the &#9670; marker
  // both need it, and a deploy without the endpoint has to fall back quietly to
  // the page as it was rather than to an error.
  try {
    originals = await fetchOriginals()
  } catch (e) {
    // The library is the page's job and the originals are an extra: a broken
    // index costs you the orig button, not the browser.
    origIndexError = e.message
    console.error(e)
  }

  for (const name of Object.keys(manifest.classes)) {
    const b = document.createElement('button')
    b.textContent = `${name} ${manifest.assets.filter((a) => a.class === name).length}`
    b.onclick = () => {
      active.has(name) ? active.delete(name) : active.add(name)
      b.classList.toggle('on', active.has(name))
      buildList()
    }
    $('filters').appendChild(b)
  }

  // One filter that is not a class, because 21 of 154 is a needle in a haystack:
  // the assets whose source is still in tmp/, and therefore the only ones that
  // can be looked at behind the build or rebuilt at a different budget.
  const withOrig = manifest.assets.filter((a) => origEntry(a)?.exists).length
  if (withOrig) {
    const b = document.createElement('button')
    b.textContent = `original ${withOrig}`
    b.title = 'only assets whose source file is still on disk'
    b.onclick = () => {
      onlyOrig = !onlyOrig
      b.classList.toggle('on', onlyOrig)
      buildList()
    }
    $('filters').appendChild(b)
  }

  // Three LOD buttons cover the deepest chain in the library (mesh, mesh,
  // impostor); shorter chains disable the tail rather than reflow the toolbar.
  for (let i = 0; i < 3; i++) {
    const b = document.createElement('button')
    b.dataset.i = i
    b.textContent = i === 2 ? 'bb' : 'L' + i
    b.style.padding = '2px 8px'
    b.onclick = () => setTier(i)
    $('lodBtns').appendChild(b)
  }

  buildList()
  resize()
  await select(manifest.assets[0])
}

boot()
