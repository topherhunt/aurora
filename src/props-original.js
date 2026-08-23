import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'

// ---------------------------------------------------------------------------
// The other half of the prop browser: the source file, before the pipeline.
//
// props.html answers "is this asset good enough". When the answer is no there is
// a second question it could not reach -- is the SOURCE any good, or is this
// asset as good as this source gets? -- and that decides whether an asset is
// worth another pass at a different budget or should just be dropped.
//
// Nothing here is converted or repackaged. Every one of the surviving sources is
// a format three.js already reads (binary FBX 7.x, glTF-binary, OBJ, PLY), and
// `tmp/` sits inside the Vite root, so the dev server streams the original bytes
// as they are. There is no build step, nothing is copied into `public/`, and
// nothing new is committed. The cost of that is that this works under `npm run
// dev` only -- see the `propOriginals` plugin in vite.config.js.
//
// What IS reconstructed is the material, and it has to be, because the source
// files disagree about where a texture lives: Megascans ships an FBX with no
// material at all and the maps loose beside it, one pack points at
// `C:/_Evan/PHOTSCANS/...`, another keeps its maps in a `nested/` folder the FBX
// does not name. `tools/props/manifest.json` and the dev endpoint's basename
// index between them resolve all three, using the same rules build.py uses --
// which is the point: what you see here is what the pipeline saw going in, not a
// prettier or a poorer version of it.
// ---------------------------------------------------------------------------

// Percent-encode each segment: these paths have spaces ("Bush test.obj"),
// parentheses and apostrophes in them, and `tmp/` is not a curated tree.
const urlOf = (p) => '/' + p.split('/').map(encodeURIComponent).join('/')
const baseName = (p) => decodeURIComponent(p.split(/[\\/]/).pop() ?? '').toLowerCase()
const extOf = (p) => (p.split('.').pop() ?? '').toLowerCase()

// An 8K albedo is 268 MB of VRAM and there are three of them on one grass scan.
// The question this page asks of a texture -- does this scan have any colour in
// it, is the cutout clean -- is fully answered at 2K, and the whole library can
// then be stepped through without a GC pause between assets.
const MAX_TEX = 2048

export async function fetchOriginals() {
  const res = await fetch('/__prop-originals')
  // The endpoint is `apply: 'serve'`, so a built deploy has no such route and
  // the SPA fallback answers with index.html. That is not an error, it is the
  // deployed page correctly having no originals; the caller says so in the UI.
  if (!(res.headers.get('content-type') ?? '').includes('json')) return null
  // A JSON answer means the endpoint IS there, so anything wrong with it is a
  // real fault and gets said out loud rather than folded into "no originals
  // here" -- which is the same page state and a completely different cause.
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(`the originals index failed: ${body.error ?? res.status}`)
  return body.assets
}

async function fetchBuffer(url, onProgress) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} -- ${url}`)
  // The trap this exists for: a file that is NOT on disk comes back 200 with
  // index.html as its body, because the dev server falls back to the SPA entry
  // for anything it cannot find. Handing that to FBXLoader produces "THREE.FBXLoader:
  // Cannot find the version number", which is a lie about a file that is simply gone.
  if ((res.headers.get('content-type') ?? '').startsWith('text/html')) {
    throw new Error(`not on disk -- the dev server answered with index.html for ${url}`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress?.(got, total)
  }
  const buf = new Uint8Array(got)
  let at = 0
  for (const c of chunks) { buf.set(c, at); at += c.length }
  return buf.buffer
}

// Load a texture at a bounded size, and report what it actually was.
async function loadTexture(path, { srgb }) {
  const blob = await (await fetch(urlOf(path))).blob()
  // Decode once at full size to learn the real dimensions -- worth knowing,
  // since "this scan is 8K and the library gives it 128x128" is half the
  // salvage argument -- then re-decode down if it is over budget.
  let bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' })
  const src = { w: bitmap.width, h: bitmap.height }
  if (Math.max(src.w, src.h) > MAX_TEX) {
    const k = MAX_TEX / Math.max(src.w, src.h)
    const scaled = await createImageBitmap(blob, {
      imageOrientation: 'flipY',
      resizeWidth: Math.round(src.w * k),
      resizeHeight: Math.round(src.h * k),
      resizeQuality: 'high',
    })
    bitmap.close()
    bitmap = scaled
  }
  const tex = new THREE.Texture(bitmap)
  // These UVs come from FBX/OBJ/PLY, which use the OpenGL bottom-left origin,
  // so the image wants flipping -- the opposite of `layerTexture` in
  // props-main.js, whose PNGs are addressed by glTF UVs. `imageOrientation`
  // above does it at decode time because an ImageBitmap ignores `flipY`.
  tex.flipY = false
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  tex.needsUpdate = true
  return { tex, path, srcSize: src, size: { w: bitmap.width, h: bitmap.height }, bytes: blob.size }
}

// ---------------------------------------------------------------------------
// Load one original
// ---------------------------------------------------------------------------

// `entry` is one record from the dev endpoint; `heightM` is the asset's declared
// real-world height from the built manifest.
export async function loadOriginal(entry, heightM, onStatus) {
  if (!entry.exists) throw new Error(`source file is not on disk: ${entry.src}`)
  const ext = extOf(entry.src)
  const t0 = performance.now()

  const buf = await fetchBuffer(urlOf(entry.src), (got, total) => {
    onStatus?.(`reading ${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`)
  })
  const tRead = performance.now()
  onStatus?.(`parsing ${(buf.byteLength / 1e6).toFixed(0)} MB of ${ext.toUpperCase()}...`)
  // Let the status paint before the parse takes the main thread for a few
  // seconds. A 2M-triangle FBX is ~3 s of synchronous work and there is no
  // worker here; a frozen page with no explanation reads as a crash.
  await new Promise((r) => setTimeout(r, 30))

  // Textures the source names are re-pointed by basename against the endpoint's
  // index -- the same rule as `resolve_missing_images` in build.py, and the only
  // way the packs that hardcode the author's own drive letter resolve at all.
  const missing = []
  const manager = new THREE.LoadingManager()
  const settled = textureGate(manager)
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url // GLB's own embedded images
    const want = baseName(url)
    const hit = lookupImage(entry, want)
    if (hit) return urlOf(hit.path)
    missing.push(want)
    return url
  })

  const resourcePath = urlOf(entry.src.split('/').slice(0, -1).join('/')) + '/'
  let root
  if (ext === 'fbx') {
    root = new FBXLoader(manager).parse(buf, resourcePath)
  } else if (ext === 'glb' || ext === 'gltf') {
    root = (await new GLTFLoader(manager).parseAsync(buf, resourcePath)).scene
  } else if (ext === 'obj') {
    root = new OBJLoader(manager).parse(new TextDecoder().decode(buf))
  } else if (ext === 'ply') {
    const geom = new PLYLoader().parse(buf)
    if (!geom.getAttribute('normal')) geom.computeVertexNormals()
    root = new THREE.Mesh(geom, new THREE.MeshLambertMaterial())
  } else {
    throw new Error(`no loader for .${ext} -- add one to props-original.js`)
  }
  const tParse = performance.now()

  const stats = { format: ext, bytes: buf.byteLength, readMs: tRead - t0, parseMs: tParse - tRead }
  measure(root, stats)
  onStatus?.(`${stats.tris.toLocaleString()} tris -- resolving textures...`)
  // FBXLoader.parse() hands back the geometry the moment it is built and lets
  // the LoadingManager finish the textures in the background, so reading
  // `material.map.image` straight after it answers "no texture" for every source
  // that wired its own maps up correctly -- the fern, the autumn tree and the
  // chalet all lost theirs this way and fell back to flat grey. GLTFLoader
  // resolves after its dependencies, so this is a no-op there.
  if (await settled() === 'timeout') missing.push('(timed out waiting for a texture)')

  onStatus?.(`${stats.tris.toLocaleString()} tris -- wiring materials...`)
  stats.textures = await dressMaterials(root, entry)
  stats.missingTextures = [...new Set(missing)]
  stats.scale = normalize(root, heightM, entry.rotate_x_deg)
  const box = new THREE.Box3().setFromObject(root)
  stats.size = box.getSize(new THREE.Vector3())
  stats.totalMs = performance.now() - t0
  return { root, stats }
}

// --- finding the maps -------------------------------------------------------
//
// Three packs, three ways of losing track of a texture, and all three are
// recoverable by name because the file is right there:
//
//   the FBX asks for `buesche.tga` and the download shipped `buesche.tga.png`,
//   which is a marketplace conversion, not a different texture;
//   the FBX asks for `base_color_texture` and the folder holds exactly one image;
//   the FBX asks for nothing at all -- 3ds Max wrote the maps into properties
//   three.js does not read -- and the folder holds one set per material, named
//   after the material.
//
// Everything here is a guess and is reported as one in the panel. The rule is
// deliberately conservative: a prefix match on the material name first, and a
// bare "there is only one of these" second, so that an index which had to widen
// out of the asset's own folder cannot dress it in a neighbour's bark.
const COLOUR_MAP = /(base[_ -]?colou?r|albedo|diffuse|_col(our|or)?[_.]|basecolor)/i
const ALPHA_MAP = /(opacity|transparen|alpha)/i
const NOT_COLOUR = /(normal|rough|gloss|metal|specular|height|displace|cavity|bump|curvature|translucen|_ao[_.]|ambient_?occlusion|mixed_ao)/i
const normKey = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

function lookupImage(entry, name) {
  // `.tga` -> `.tga.png` and friends: the extension the source names is not
  // always the extension the download shipped.
  const swapped = name.replace(/\.[^.]+$/, '')
  return entry.images[name]
    ?? entry.images[name + '.png'] ?? entry.images[name + '.jpg'] ?? entry.images[name + '.jpeg']
    ?? entry.images[swapped + '.png'] ?? entry.images[swapped + '.jpg'] ?? entry.images[swapped + '.jpeg']
    ?? null
}

function guessMaps(entry, materialName, lone) {
  const names = Object.keys(entry.images)
  const colours = names.filter((n) => COLOUR_MAP.test(n) && !NOT_COLOUR.test(n))
  const alphas = names.filter((n) => ALPHA_MAP.test(n))
  // "Tr_01_Leaves_autumn_001_mat" names "Tr_01_Leaves_autumn_001_Base_color.png",
  // so the trailing mat/material has to come off before the prefix will match.
  const stem = normKey(String(materialName ?? '').replace(/[_. ]*(mat|material)\s*\d*$/i, ''))
  const byStem = (list) => (stem.length >= 3 ? list.find((n) => normKey(n).startsWith(stem)) : undefined)
  // Last resort for a folder holding exactly one image that is not obviously a
  // normal or a roughness map -- which is how `texture_20250901.png`, a name
  // that says nothing at all, still finds its cabin. Only offered when the
  // source has a single material: with two, "the only opacity map here" is the
  // leaves' cutout and putting it on the trunk eats the tree.
  const plain = names.filter((n) => !NOT_COLOUR.test(n) && !ALPHA_MAP.test(n))
  const only = (list) => (lone && list.length === 1 ? list[0] : undefined)
  const colour = byStem(colours) ?? only(colours) ?? only(plain)
  const alpha = byStem(alphas) ?? only(alphas)
  return { colour: colour ? entry.images[colour] : null, alpha: alpha ? entry.images[alpha] : null }
}

// Resolves once every texture the loader asked for has arrived or failed.
// `LoadingManager.onLoad` never fires for a source that requested nothing, hence
// the counter: a wait that hangs forever on a mesh with no textures at all would
// be an odd way to lose the four assets that have none.
function textureGate(manager) {
  let started = 0
  let idleNow
  const idle = new Promise((res) => { idleNow = res })
  const itemStart = manager.itemStart.bind(manager)
  manager.itemStart = (url) => { started++; itemStart(url) }
  manager.onLoad = () => idleNow('loaded')
  return () => (started === 0 ? Promise.resolve('none') : Promise.race([
    idle,
    // A request that never settles would freeze the page on a blank frame with
    // nothing to read. 30 s is far beyond any local file; whatever has not
    // arrived by then gets reported as missing, which is what it is.
    new Promise((res) => setTimeout(() => res('timeout'), 30000)),
  ]))
}

function measure(root, stats) {
  let tris = 0
  let verts = 0
  let meshes = 0
  const materials = new Set()
  root.traverse((o) => {
    if (!o.isMesh) return
    meshes++
    const g = o.geometry
    const pos = g.getAttribute('position')
    verts += pos.count
    tris += (g.index ? g.index.count : pos.count) / 3
    for (const m of [].concat(o.material)) if (m) materials.add(m.name || m.uuid)
  })
  Object.assign(stats, { tris: Math.round(tris), verts, meshes, materials: materials.size })
}

// Re-shade to this page's material, keeping whatever map the loader resolved.
//
// Deliberately not "render the source as its author shaded it": the built props
// next to it are Lambert, double-sided, alphaTest 0.5, and a comparison between a
// PBR original and a Lambert LOD0 mostly measures the shading model. Same rig,
// same material, different geometry and different texture resolution -- then the
// difference you see is the pipeline's doing.
async function dressMaterials(root, entry) {
  const applied = []
  const shared = new Map() // one preview material per source material
  const cache = new Map() // one decode per file, however many materials name it
  const load = async (path, srgb, guessed) => {
    if (!cache.has(path)) {
      const t = await loadTexture(path, { srgb })
      cache.set(path, { ...t, guessed })
      applied.push(cache.get(path))
    }
    return cache.get(path)
  }

  let declared = null
  if (entry.base_color_map) {
    const color = await load(entry.base_color_map, true, false)
    const alpha = entry.opacity_map ? await load(entry.opacity_map, false, false) : null
    declared = { color, alpha }
  }

  // Every distinct source material, plus the one thing the guess needs that the
  // material itself does not carry: whether its geometry has vertex colours to
  // fall back on.
  const sources = new Map()
  root.traverse((o) => {
    if (!o.isMesh) return
    const vc = Boolean(o.geometry.getAttribute('color'))
    for (const m of [].concat(o.material)) {
      const key = m?.uuid ?? 'none'
      if (!sources.has(key)) sources.set(key, { m, vc })
      else if (vc) sources.get(key).vc = true
    }
  })

  const seen = new Set()
  for (const [key, { m, vc }] of sources) {
    // A map the source wired up itself and the loader found. `image` is unset
    // when the request 404'd, which is the case the basename index exists to
    // prevent and the case `missingTextures` reports when it could not.
    const own = m?.map?.image ? m.map : null
    if (own && !seen.has(own.uuid)) {
      seen.add(own.uuid)
      own.colorSpace = THREE.SRGBColorSpace
      // A file the source named, or -- for a GLB, whose images are object
      // URLs -- one packed inside it. Either way it is at its full size here:
      // only the maps this page loads itself go through the 2K cap.
      const url = own.image.src ?? ''
      const label = url && !url.startsWith('blob:') ? decodeURIComponent(url.split('/').pop()) : (own.name || 'embedded')
      const size = { w: own.image.width, h: own.image.height }
      applied.push({ path: label, size, srcSize: size, bytes: 0 })
    }

    let map = own ?? declared?.color.tex ?? null
    let alphaMap = (own ? (m?.alphaMap?.image ? m.alphaMap : null) : declared?.alpha?.tex) ?? null
    // Nothing wired up: go looking by name. Three of these packs ship their maps
    // beside a model that names them wrong or not at all, and a bark texture
    // sitting unused next to a flat grey trunk is exactly the kind of thing that
    // makes a salvageable source look worthless. Only for assets the manifest
    // says nothing about: where it DOES declare the maps it is authoritative --
    // it declares a colour and no opacity for the horsetail on purpose, and
    // guessing one in would show something build.py never built.
    if (!declared && (!map || !alphaMap)) {
      const g = guessMaps(entry, m?.name, sources.size === 1)
      if (!map && g.colour) map = (await load(g.colour.path, true, true)).tex
      if (!alphaMap && g.alpha) alphaMap = (await load(g.alpha.path, false, true)).tex
    }

    const mat = new THREE.MeshLambertMaterial({
      // Vertex colours only when nothing else supplies the colour: the grass
      // scans carry both, and their COLOR_0 is a mask, not an albedo --
      // multiplying it into a good base colour turns the clump black.
      vertexColors: !map && vc,
      map,
      alphaMap,
      color: map ? 0xffffff : new THREE.Color(...(entry.base_color?.slice(0, 3) ?? [0.62, 0.62, 0.62])),
      side: THREE.DoubleSide,
      alphaTest: map || alphaMap ? 0.5 : 0,
      transparent: false,
    })
    mat.needsUpdate = true
    shared.set(key, mat)
  }

  root.traverse((o) => {
    if (!o.isMesh) return
    const mats = [].concat(o.material).map((m) => shared.get(m?.uuid ?? 'none'))
    o.material = mats.length === 1 ? mats[0] : mats
  })
  return applied
}

// Stand it on the grid at its declared height, exactly as build.py does before
// it decimates anything (`ground_and_center` then `scale_to_height`). Sources
// arrive in centimetres, in inches and in at least one arbitrary unit -- the
// dead tree's bounding box is 620 units tall -- so without this the original
// would appear as a wall a hundred metres behind the LOD it is meant to be
// compared with.
function normalize(root, heightM, rotateXDeg) {
  if (rotateXDeg) root.rotation.x = THREE.MathUtils.degToRad(rotateXDeg)
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
  const height = box.getSize(new THREE.Vector3()).y
  if (!(height > 1e-9)) throw new Error('original has zero height -- nothing to scale to')
  const k = heightM / height
  root.scale.setScalar(k)
  root.updateMatrixWorld(true)
  const scaled = new THREE.Box3().setFromObject(root)
  const centre = scaled.getCenter(new THREE.Vector3())
  root.position.set(-centre.x, -scaled.min.y, -centre.z)
  root.updateMatrixWorld(true)
  return k
}

// Originals are the heaviest thing this page ever holds -- two million triangles
// and a 2K albedo apiece -- and the browser steps through the library one arrow
// key at a time. Nothing here is shared with anything else on the page, so all
// of it goes.
export function disposeOriginal(loaded) {
  if (!loaded) return
  const gone = new Set()
  loaded.root.traverse((o) => {
    if (!o.isMesh) return
    o.geometry.dispose()
    for (const m of [].concat(o.material)) {
      if (!m || gone.has(m.uuid)) continue
      gone.add(m.uuid)
      for (const slot of ['map', 'alphaMap', 'normalMap', 'emissiveMap', 'specularMap', 'aoMap']) {
        const t = m[slot]
        if (t && !gone.has(t.uuid)) { gone.add(t.uuid); t.image?.close?.(); t.dispose() }
      }
      m.dispose()
    }
  })
}
