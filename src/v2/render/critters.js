// ---------------------------------------------------------------------------
// What the small Tripo creatures scattered in the world share: loading a shipped
// GLB into plain geometry arrays, and walking a tile grid around the player.
// The scatters themselves are frogs.js and crabs.js.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { cullTripoBackfaces } from '../../tripo-culling.js'

// What tools/creatures/ship.mjs writes for each critter, relative to the page like avatar.js's URLs.
export const CRITTER_GLB = {
  frog: 'creatures/marsh-frog.glb',
  crab: 'creatures/shore-crab.glb',
}

// three-instance resolves to A-Frame's bundled three on the world page, which
// hangs its loaders on the namespace; npm three keeps them in addons.
async function gltfLoader() {
  if (THREE.GLTFLoader) return new THREE.GLTFLoader()
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  return new GLTFLoader()
}

/**
 * A shipped Tripo creature as one baked geometry: the single mesh's node
 * transform applied, feet moved to y = 0, horizontal centre at the origin. The
 * result has the shape `setCritterAsset` takes -- plain arrays plus the base
 * colour texture -- so a gate can build the same thing by hand.
 *
 * Tripo normalises the longest axis to about one unit, so `span` (the longer
 * horizontal extent) is what a caller divides its metres by to scale the
 * creature. Both shipped critters face +X after their node transform.
 */
export async function loadCritterGlb(url) {
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
  geo.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
  // Only the colour map is drawn; Tripo's ORM and normal maps would sit on the GPU for nothing.
  const mat = mesh.material
  const map = mat.map
  if (!map) throw new Error(`${url}: material has no base colour map`)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 4
  for (const key of ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
    if (mat[key] && mat[key] !== map) mat[key].dispose()
  }
  mat.dispose()
  return {
    pos: geo.getAttribute('position').array,
    nrm: geo.getAttribute('normal').array,
    uv: geo.getAttribute('uv').array,
    idx: Array.from(geo.index.array),
    map,
  }
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
