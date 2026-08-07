import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

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
  { match: /^tree_oak_hero/, where: 'LANDMARK ONLY. Floors at 1,703 tris; at the pine density it would eat the whole prop budget by itself' },
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
// `consolidate_texture` unwraps and bakes the atlas on the FULL-RES object, and
// the LOD chain is decimated from that object afterwards. Nothing re-checks that
// the surviving triangles still point at anything: a 14k-tri grass photoscan cut
// to 83 triangles has UVs that stretch across half the atlas, gutters included,
// and at alphaTest 0.5 every fragment that lands in a gutter is discarded.
//
// So sample each triangle at its UV centroid and count how many land on a texel
// that is transparent (discarded) or black (drawn, but unlit-black). This is a
// coarse probe -- one sample per triangle, so a thin gutter can be missed or
// over-counted -- but it does not need to be precise to separate a working bake
// from one that has come unstuck from its mesh.
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
  let tris = 0
  let clear = 0
  let dark = 0
  for (let t = 0; t + 2 < count; t += 3) {
    let u = 0
    let v = 0
    for (let k = 0; k < 3; k++) { u += uv.getX(at(t + k)); v += uv.getY(at(t + k)) }
    // glTF UVs use a top-left origin and getImageData rows are top-left too, so
    // v indexes the row directly. Confirmed by measurement: flipping it makes
    // strictly more assets sample empty space, not fewer.
    const x = Math.min(px.width - 1, Math.max(0, Math.floor((u / 3) * px.width)))
    const y = Math.min(px.height - 1, Math.max(0, Math.floor((v / 3) * px.height)))
    const i = (y * px.width + x) * 4
    tris++
    if (px.data[i + 3] < 128) clear++
    else if ((px.data[i] + px.data[i + 1] + px.data[i + 2]) / 3 < 12) dark++
  }
  return { kind: 'mesh', tris, clear, dark }
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
let current = null // { asset, tiers: [{lod, object}], mixer, clips, box }
let activeTier = 0

function disposeCurrent() {
  if (!current) return
  scene.remove(current.root)
  current.root.traverse((o) => {
    if (!o.isMesh) return
    // Geometry and material are per-asset; the layer textures are cached and
    // shared across selections, so they are deliberately not disposed here.
    o.geometry.dispose()
    o.material.dispose()
  })
  current = null
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
  for (const lod of asset.lods) {
    const mesh = byName.get(lod.name)
    if (!mesh) continue // check-props.mjs would have failed the build; nothing to do here
    // Impostors carry their own sheet; mesh tiers carry the shared albedo layer,
    // or nothing at all when their colour lives entirely in vertex colours.
    // Billboard COLOR_0 is white, so vertex colours are a no-op there rather
    // than a second multiply against an already-lit sheet.
    const layer = lod.kind === 'billboard' ? lod.layer : asset.layer
    mesh.material = propMaterial(layer ? layerTexture(layer) : null)
    mesh.visible = false
    root.add(mesh)
    tiers.push({ lod, mesh, layer, audit: null })
  }
  scene.add(root)

  const mixer = gltf.animations.length ? new THREE.AnimationMixer(root) : null
  const box = new THREE.Box3().setFromObject(tiers[0].mesh)
  current = { asset, root, tiers, mixer, clips: gltf.animations, box }

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
  activeTier = Math.min(i, current.tiers.length - 1)
  current.tiers.forEach((t, n) => { t.mesh.visible = n === activeTier })
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
  for (const r of document.querySelectorAll('.lods tr')) r.classList.toggle('act', r.dataset.i === String(activeTier))
}

// ---------------------------------------------------------------------------
// The stats panel
// ---------------------------------------------------------------------------

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
  const lostTier = audited
    .filter(([, au]) => au.kind === 'mesh')
    .map(([label, au]) => ({ label, pct: 100 * (au.clear + au.dark) / au.tris }))
    .sort((x, y) => y.pct - x.pct)
    .find((w) => w.pct > 25)
  const blackSheet = audited.some(([, au]) => au.kind === 'sheet' && au.cover > 0.02 && au.lum < 12)
  const sheets = []
  if (a.layer) sheets.push(`<figure><img src="${PROPS}${a.layer}" alt="albedo"><figcaption>albedo ${manifest.layer_size}&sup2;</figcaption></figure>`)
  if (a.billboard_layer) sheets.push(`<figure><img src="${PROPS}${a.billboard_layer}" alt="impostor"><figcaption>impostor ${manifest.billboard_size}&sup2;</figcaption></figure>`)

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

    <h2>colour</h2>
    <table>
      <tr><td>source</td><td>${esc(a.color_source.replace(/_/g, ' '))}</td></tr>
      <tr><td>AO</td><td>baked into vertex colours</td></tr>
      ${audited.map(([label, au]) => {
        if (au.kind === 'sheet') {
          const dead = au.cover > 0.02 && au.lum < 12
          return `<tr><td>${esc(label)} sheet</td><td class="${dead ? 'warn' : ''}">${(100 * au.cover).toFixed(0)}% covered, mean RGB ${au.lum.toFixed(0)}${dead ? ' -- black' : ''}</td></tr>`
        }
        const lost = 100 * au.clear / au.tris
        const black = 100 * au.dark / au.tris
        const bad = lost + black > 25
        return `<tr><td>${esc(label)} on tex</td><td class="${bad ? 'warn' : ''}">${(100 - lost - black).toFixed(0)}% lands on colour${
          lost >= 1 ? `, ${lost.toFixed(0)}% cut` : ''}${black >= 1 ? `, ${black.toFixed(0)}% black` : ''}</td></tr>`
      }).join('')}
    </table>
    ${lostTier ? `<div class="warn" style="margin-top:6px">The bake has come unstuck from the mesh.
      <b>${lostTier.pct.toFixed(0)}% of ${esc(lostTier.label)}'s triangles</b> sample a texel that is transparent
      (discarded at alphaTest 0.5) or black. <code>consolidate_texture</code> unwraps and bakes on the
      full-res object and the LOD chain is decimated from it afterwards, so at ${(100 * a.lods[0].tris / a.src_tris).toFixed(2)}%
      of the source triangles the surviving UVs no longer line up with the atlas islands.</div>` : ''}
    ${blackSheet ? `<div class="warn" style="margin-top:6px">The impostor sheet is black.
      <code>render_billboard</code> renders LOD0 <em>after</em> <code>finalize_material</code> has swapped the
      albedo for the 1&times;1 stub, and a textured asset's vertex colours are deliberately white -- so the render
      has nothing to sample but the stub. Every textured asset with a billboard has this.</div>` : ''}
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

function buildList() {
  const q = $('search').value.trim().toLowerCase()
  shown = manifest.assets.filter((a) =>
    (!active.size || active.has(a.class)) && (!q || a.id.includes(q))
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
    b.innerHTML = `<span class="cl cl-${a.class}"></span><span class="nm">${esc(a.id)}</span><span class="tr">${a.lods[0].tris}</span>`
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
