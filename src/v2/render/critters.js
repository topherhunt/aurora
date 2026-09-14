// ---------------------------------------------------------------------------
// What the small Tripo creatures scattered in the world share: loading a shipped
// GLB into plain geometry arrays, walking a tile grid around the player, the
// LOD ladder a creature steps down as it shrinks in her view, and the cross
// card a creature may be drawn as instead -- see the notes at each. The
// scatters themselves are frogs.js and crabs.js.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { cullTripoBackfaces } from '../../tripo-culling.js'
import { TEX_SIZE } from '../../textures.js'
import { SUPERSAMPLE, downsample, dilate } from '../../props/impostor.js'

// What tools/creatures/ship.mjs writes for each critter, relative to the page like avatar.js's URLs: the pick, and its ladder as critterLodUrl.
export const CRITTER_GLB = {
  frog: 'creatures/marsh-frog.glb',
  crab: 'creatures/shore-crab.glb',
}
export const critterLodUrl = (url, level) => url.replace(/\.glb$/, `-lod${level}.glb`)

// three-instance resolves to A-Frame's bundled three on the world page, which
// hangs its loaders on the namespace; npm three keeps them in addons.
async function gltfLoader() {
  if (THREE.GLTFLoader) return new THREE.GLTFLoader()
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  return new GLTFLoader()
}

/**
 * A shipped Tripo creature as one baked geometry: the single mesh's node
 * transform applied, feet moved to y = 0, horizontal centre at the origin --
 * or moved by `origin`, the move the result reports, so a ladder tier lands
 * in register with its pick. The result has the shape `setCritterAsset` takes
 * -- plain arrays plus the colour map (tools/creatures/ship.mjs) -- so a gate
 * can build the same thing by hand.
 *
 * Tripo normalises the longest axis to about one unit, so `span` (the longer
 * horizontal extent) is what a caller divides its metres by to scale the
 * creature. Both shipped critters face +X after their node transform, which
 * ship.mjs turns by the roster's faceTurnDeg to make so.
 */
export async function loadCritterGlb(url, { origin = null } = {}) {
  const loader = await gltfLoader()
  const gltf = await loader.loadAsync(url)
  cullTripoBackfaces(gltf.scene)
  gltf.scene.updateMatrixWorld(true)
  const meshes = []
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o) })
  if (meshes.length !== 1) throw new Error(`${url}: expected one mesh, found ${meshes.length}`)
  const mesh = meshes[0]
  const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
  if (!geo.index) throw new Error(`${url}: mesh is not indexed`)
  for (const name of ['position', 'normal', 'uv']) {
    if (!geo.getAttribute(name)) throw new Error(`${url}: mesh has no ${name} attribute`)
  }
  geo.computeBoundingBox()
  const box = geo.boundingBox
  // Centred over its feet; or moved as given, which is how a ladder tier follows its pick.
  const move = origin ?? [-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2]
  geo.translate(...move)
  const mat = mesh.material
  const map = mat.map
  if (!map) throw new Error(`${url}: material has no base colour map`)
  // The raw Tripo pick carries its 2048 ORM and normal maps too, which the loader would already have decoded by now.
  if (mat.roughnessMap || mat.metalnessMap || mat.normalMap) throw new Error(`${url}: carries Tripo's raw maps -- run tools/creatures/ship.mjs`)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 4
  mat.dispose()
  return {
    pos: geo.getAttribute('position').array,
    nrm: geo.getAttribute('normal').array,
    uv: geo.getAttribute('uv').array,
    idx: Array.from(geo.index.array),
    map,
    origin: move,
  }
}

// ---------------------------------------------------------------------------
// THE GLINT. A Tripo creature that sits wet in the air -- the frogs, the
// crabs; not the fish, which are under the water whose surface does their
// shining for them -- wears a Standard material with a hand-set uniform
// roughness and metalness 0, not the Lambert everything else wears: the extra
// term is the sun's GGX lobe on wet skin or shell. The roughness is uniform by
// decision: Tripo's per-texel roughness map was tried here and is too
// inaccurate to ship (design/27-creature-pipeline.md). The lobe is scaled by
// GLINT: the full lobe catches an edge -- a jaw, a rim -- harder than wet
// reads, and half of it does not. No environment map exists, so the indirect
// specular is nothing and the glint is the sun's alone; lighting.js gates it
// with the same shadow as the diffuse.
// ---------------------------------------------------------------------------

export const GLINT = 0.5

/** Splice the glint scale into a Standard material's fragment shader, from its onBeforeCompile. */
export function glint(shader) {
  shader.fragmentShader = shader.fragmentShader
    // lighting.js splices its shadow multiply into the same slot, ahead of this line; the two commute.
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\nreflectedLight.directSpecular *= ${GLINT.toFixed(2)};`)
}

// ---------------------------------------------------------------------------
// THE HUE. One Tripo mesh wears one colour map, so without this every frog on
// a bank is the same frog. Each instance carries its own turn round the colour
// wheel in `aHue` (radians, either way), applied to the sampled map in the
// fragment stage as a rotation about the grey axis in linear RGB, so a green
// frog's neighbour is olive and the next one brown; the frogs' instanceColor
// tint and the fish's brightness ride on top through three's own vColor. The
// card wears it too, so a creature keeps its colour when it goes far.
// ---------------------------------------------------------------------------

/** Splice the per-instance hue turn into a material's shaders, from its onBeforeCompile. The mesh must carry an `aHue` instanced attribute. */
export function hueVary(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aHue;\nvarying float vHue;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHue = aHue;')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vHue;')
    .replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n' +
        '{\n' +
        '\tconst vec3 hueK = vec3( 0.57735027 );\n' +
        '\tfloat hueC = cos( vHue );\n' +
        '\tfloat hueS = sin( vHue );\n' +
        '\tdiffuseColor.rgb = max( vec3( 0.0 ), diffuseColor.rgb * hueC + cross( hueK, diffuseColor.rgb ) * hueS + hueK * dot( hueK, diffuseColor.rgb ) * ( 1.0 - hueC ) );\n' +
        '}'
    )
}

/** The `aHue` attribute for `n` instances, set on the mesh's geometry and returned for the caller to write. */
export function makeHueAttribute(mesh, n) {
  const hue = new THREE.InstancedBufferAttribute(new Float32Array(n), 1)
  hue.setUsage(THREE.DynamicDrawUsage)
  mesh.geometry.setAttribute('aHue', hue)
  return hue
}

/**
 * The asset onto an InstancedMesh's (empty) geometry. Returns the baked bounds
 * the caller sizes and seats the creature by: `span` is the longer horizontal
 * extent, `height` the top of the mesh over its feet.
 */
export function setCritterAsset(mesh, material, asset, label) {
  const n = asset.pos.length / 3
  if (asset.uv.length !== n * 2 || asset.nrm.length !== n * 3) throw new Error(`${label}: asset attribute lengths disagree`)
  const geo = mesh.geometry
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(asset.pos), 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(asset.nrm), 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(asset.uv), 2))
  geo.setIndex(asset.idx)
  geo.computeBoundingBox()
  const b = geo.boundingBox
  if (asset.map) {
    material.map = asset.map
    material.needsUpdate = true
  }
  mesh.visible = true
  return { span: Math.max(b.max.x - b.min.x, b.max.z - b.min.z), height: b.max.y - b.min.y, halfX: (b.max.x - b.min.x) / 2, halfZ: (b.max.z - b.min.z) / 2 }
}

// ---------------------------------------------------------------------------
// THE LOD LADDER. A creature that moves -- turns, hops, is seen from every
// side -- is drawn as its mesh at every distance, stepping down the bench's
// decimated tiers (ship.mjs ships them beside the pick) as it shrinks in her
// view, and drawn as nothing at all once it is under the ladder's last rung,
// under a degree of arc: a 0.36 m frog thirty metres off is a few pixels, and
// a few pixels of nothing is not missed. The tier is a function of APPARENT size, body span over
// distance, so a big frog near and a small frog far take the same step at the
// same number of pixels; critterTier below picks it, with a little hysteresis
// so a frog on a threshold does not flicker between two meshes as her head
// moves. The cost is a low tier that reads as its animal at its size, which
// is the decimator's job (src/mesh/decimate.js), not a card's.
//
// THE CROSS CARD, below, is for a creature that is seen in one fixed pose from
// one side -- the crab, clinging to its rock. It costs two quads and a bake,
// and shows its seams from any other angle, which is why the frog has none:
// most creatures want the ladder pared harder at the bottom, not a card.
// ---------------------------------------------------------------------------

/**
 * The ladder tier a body of `span` metres at `dist` metres is drawn as, given
 * the tier it was last drawn as: `deg` lists the apparent size in degrees of
 * arc each tier holds down to, tier 0 first, so tier k is drawn while the
 * body subtends at least deg[k]; under the last figure it returns deg.length,
 * meaning not drawn. A tier is left only past its edge by HYSTERESIS, in
 * either direction; `prev` of -1 is no tier yet, and takes the edges as they
 * are.
 */
export const LOD_HYSTERESIS = 0.1
export function critterTier(span, dist, prev, deg) {
  const apparent = (Math.atan2(span, dist) * 180) / Math.PI
  let tier = deg.length
  for (let k = 0; k < deg.length; k++) {
    // The edge, pushed away from the tier it is in so crossing it takes a real move.
    const edge = k === prev ? deg[k] * (1 - LOD_HYSTERESIS) : k === prev - 1 ? deg[k] * (1 + LOD_HYSTERESIS) : deg[k]
    if (apparent >= edge) { tier = k; break }
  }
  return tier
}

// ---------------------------------------------------------------------------
// THE CROSS CARD. Past CARD_M from her head a creature is drawn as two quads
// crossed at its body's middle, each the mesh photographed off the loaded GLB
// from one of the VIEWS below -- the side on the XY plane and the top on the
// XZ plane, the crab's -- under the SAME instance matrix as the mesh, so a
// card sits, tilts, turns and swells exactly as the body it stands in for; it
// is not turned to the camera. Both quads are double-sided, and a quad's back
// face shows its picture mirrored: the true other side of a bilateral animal
// on the side quad, the belly where the back should be under the top one.
//
// The card is a cutout (alphaTest). Its normals are all straight up and the
// double-sided flip is undone, so both planes and both faces of each take the
// same light and the seam between them is not a step in brightness.
// ---------------------------------------------------------------------------
export const CARD_M = 8
// The bake: each view is TEX_SIZE px square, side by side in the order the views are listed; the picture frames the body with this margin each side so the alpha edge is not the texel edge.
const CARD_MARGIN = 0.06

export function createCritterCardMaterial(label) {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, alphaTest: 0.5, side: THREE.DoubleSide })
  material.onBeforeCompile = (shader) => {
    hueVary(shader)
    // three flips a double-sided normal toward the viewer; twice is the identity, and the authored up-normal lights both faces alike.
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal *= faceDirection;')
  }
  material.customProgramCacheKey = () => `${label}-card`
  return material
}

/** The picture's extents in the unit mesh's frame: the body's box grown by CARD_MARGIN, feet a little below y = 0. */
export function critterCardExtents({ halfX, halfZ, height }) {
  const grow = 1 + 2 * CARD_MARGIN
  return { hx: halfX * grow, hz: halfZ * grow, y0: (height / 2) * (1 - grow), y1: (height / 2) * (1 + grow) }
}

// The two quads a card is built of, by view name: the crab's.
export const CRAB_VIEWS = ['side', 'top']

/**
 * One view's camera, in the unit mesh's frame: where it stands (ten units out
 * from the body's middle, `at`), which way is up in its picture, and its
 * orthographic frame -- half-width `w`, `top` and `bottom` along `up`. The
 * quad for the view is this same frame laid in the world, so the picture and
 * the quad agree by construction: see cardCorner.
 */
function cardView(name, { hx, hz, y0, y1 }) {
  const yMid = (y0 + y1) / 2
  const at = new THREE.Vector3(0, yMid, 0)
  const y = new THREE.Vector3(0, 1, 0)
  switch (name) {
    // From +Z: +X to the right.
    case 'side': return { at, from: new THREE.Vector3(0, yMid, 10), up: y, w: hx, top: y1 - yMid, bottom: y0 - yMid }
    // From above, laid flat at the body's middle: +X to the right, -Z up the picture.
    case 'top': return { at, from: new THREE.Vector3(0, yMid + 10, 0), up: new THREE.Vector3(0, 0, -1), w: hx, top: hz, bottom: -hz }
    default: throw new Error(`critter card: no view named ${name}`)
  }
}

/** The world point at picture coordinates (u, v) of a view, u 0..1 left to right and v 0..1 bottom to top -- three's camera basis, so `right` is up x (from - at). */
function cardCorner(view, u, v, out) {
  const right = new THREE.Vector3().subVectors(view.from, view.at).normalize()
  right.crossVectors(view.up, right)
  return out.copy(view.at)
    .addScaledVector(right, (2 * u - 1) * view.w)
    .addScaledVector(view.up, view.bottom + (view.top - view.bottom) * v)
}

/**
 * The crossed quads onto a card InstancedMesh's (empty) geometry, sized to
 * `bounds` from setCritterAsset. Each quad reads its view's strip of the
 * picture, 1 / n of its width where n is the count of views.
 */
export function setCritterCard(mesh, bounds, views) {
  if (!Array.isArray(views) || views.length !== 2) throw new Error('critter card: a card is two quads')
  const n = views.length
  const ext = critterCardExtents(bounds)
  const pos = []
  const uv = []
  const nrm = []
  const p = new THREE.Vector3()
  views.forEach((name, f) => {
    const view = cardView(name, ext)
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      cardCorner(view, u, v, p)
      pos.push(p.x, p.y, p.z)
      uv.push((f + u) / n, v)
      nrm.push(0, 1, 0)
    }
  })
  const geo = mesh.geometry
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
  geo.computeBoundingBox()
}

/**
 * Photograph the loaded creature for its card: each view the two quads of
 * `views` show, orthographic and unlit (the card is lit where it is drawn, like
 * the mesh), supersampled and dilated like the props' impostors, side by side
 * in one TEX_SIZE-high texture. Needs the renderer, so the world calls it once
 * the GLB has landed.
 */
export function bakeCritterCard(renderer, geometry, map, bounds, views) {
  if (!map) throw new Error('bakeCritterCard: the asset has no colour map to photograph')
  if (!Array.isArray(views) || views.length !== 2) throw new Error('critter card: a card is two quads')
  const ext = critterCardExtents(bounds)
  const material = new THREE.MeshBasicMaterial({ map, toneMapped: false })
  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(geometry, material))
  const big = TEX_SIZE * SUPERSAMPLE
  const target = new THREE.WebGLRenderTarget(big, big, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  })
  const prevTarget = renderer.getRenderTarget()
  const prevClear = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()
  // XR off for the capture: this runs when the GLB lands, which may be after
  // she has entered VR, and a presenting renderer photographs the headset's
  // view instead of the rig's -- see captureLayer in props/impostor.js.
  const prevXR = renderer.xr.enabled
  renderer.xr.enabled = false
  renderer.setRenderTarget(target)
  renderer.setClearColor(0x000000, 0)

  const raw = new Uint8Array(big * big * 4)
  const shots = views.map((name) => {
    const view = cardView(name, ext)
    const cam = new THREE.OrthographicCamera(-view.w, view.w, view.top, view.bottom, 0.1, 20)
    cam.position.copy(view.from)
    cam.up.copy(view.up)
    cam.lookAt(view.at)
    cam.updateMatrixWorld(true)
    renderer.clear(true, true, false)
    renderer.render(scene, cam)
    renderer.readRenderTargetPixels(target, 0, 0, big, big, raw)
    const px = downsample(raw, big)
    dilate(px)
    return px
  })

  renderer.xr.enabled = prevXR
  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevClear, prevAlpha)
  target.dispose()
  material.dispose()

  // GL hands rows back bottom first, which is the row order a DataTexture's v runs in, so a view's bottom is at v = 0 with no flip.
  const n = shots.length
  const data = new Uint8Array(TEX_SIZE * n * TEX_SIZE * 4)
  const row = TEX_SIZE * 4
  for (let y = 0; y < TEX_SIZE; y++) {
    shots.forEach((px, i) => data.set(px.subarray(y * row, (y + 1) * row), y * n * row + i * row))
  }
  const texture = new THREE.DataTexture(data, TEX_SIZE * n, TEX_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

export const tileKey = (tx, tz) => tx * 0x10000 + tz

/**
 * A tile's seed, from its own coordinates and the world seed -- the same mix as
 * ferns.js, so a scatter is a pure function of position and not of visit order.
 */
export function tileSeed(tx, tz, seed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/**
 * Bring `tiles` (Map keyed by tileKey) to the set of `tile`-metre tiles whose
 * centre lies within `radius` of (cx, cz): `enter(tx, tz)` makes the state for a
 * new tile and `leave(state)` releases one that has gone. Returns how many
 * changed, so a caller can tell an idle frame from a move.
 */
export function walkTiles(tiles, cx, cz, tile, radius, enter, leave) {
  let changed = 0
  const r2 = radius * radius
  for (const [key, t] of tiles) {
    const dx = (t.tx + 0.5) * tile - cx
    const dz = (t.tz + 0.5) * tile - cz
    if (dx * dx + dz * dz > r2) {
      leave(t)
      tiles.delete(key)
      changed++
    }
  }
  const n = Math.ceil(radius / tile)
  const gx = Math.floor(cx / tile)
  const gz = Math.floor(cz / tile)
  for (let tx = gx - n; tx <= gx + n; tx++) {
    for (let tz = gz - n; tz <= gz + n; tz++) {
      const dx = (tx + 0.5) * tile - cx
      const dz = (tz + 0.5) * tile - cz
      if (dx * dx + dz * dz > r2) continue
      const key = tileKey(tx, tz)
      if (tiles.has(key)) continue
      tiles.set(key, enter(tx, tz))
      changed++
    }
  }
  return changed
}
