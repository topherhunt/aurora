import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { LAYER } from './textures.js'

// ---------------------------------------------------------------------------
// Placeholder prop loading.
//
// The Quaternius Ultimate Nature Pack ships flat-colored and completely
// UV-less: each mesh carries 2-3 materials that are solid Kd colors (Wood,
// Green, Snow, Rock...). That is NOT the target art direction -- we want low
// poly geometry with N64-resolution textures -- so this module fakes UVs by
// projection and maps each material name onto a texture-array layer.
//
// This is throwaway. Real Meshy assets arrive with authored UVs and the
// Blender pass just downscales their textures into array layers. The point
// here is to exercise the real material path (sampler2DArray + alphaTest +
// BatchedMesh) with real-ish geometry while measuring draw calls.
// ---------------------------------------------------------------------------

const UV_SCALE = 1.6 // texture repeats per world unit
const BARK_U_REPEATS = 3 // repeats around a trunk's circumference

// Quaternius material name -> texture array layer.
function layerFor(materialName, assetName) {
  const m = (materialName || '').toLowerCase()
  const a = assetName.toLowerCase()
  if (m === 'snow' || m === 'white') {
    // Birch uses White for its trunk; everything else uses it for snow.
    return a.includes('birch') ? LAYER.BARK_BIRCH : LAYER.SNOW
  }
  if (m === 'black') return LAYER.BARK_BIRCH
  if (m === 'wood' || m === 'lightwood') return LAYER.BARK
  if (m === 'rock') return LAYER.ROCK
  if (m === 'darkgreen') return LAYER.NEEDLES
  if (m === 'green') {
    if (a.includes('pine') || a.includes('willow')) return LAYER.NEEDLES
    if (a.includes('bush') || a.includes('stump')) return LAYER.GRASS
    return LAYER.LEAVES
  }
  return LAYER.ROCK
}

const isBarkLayer = (l) => l === LAYER.BARK || l === LAYER.BARK_BIRCH

// OBJLoader emits non-indexed geometry. Pull one material group's vertex range
// out into a standalone geometry.
function extractRange(geometry, start, count) {
  const src = geometry.attributes
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'normal']) {
    const attr = src[name]
    if (!attr) continue
    const size = attr.itemSize
    out.setAttribute(
      name,
      new THREE.BufferAttribute(
        attr.array.slice(start * size, (start + count) * size),
        size
      )
    )
  }
  if (!out.attributes.normal) out.computeVertexNormals()
  return out
}

// Project UVs. Trunks get a cylindrical wrap (so bark tiles up the trunk);
// everything else gets dominant-axis planar projection, which is crude but
// reads fine at 64px.
function projectUVs(geometry, layer) {
  const pos = geometry.attributes.position
  const nor = geometry.attributes.normal
  const n = pos.count
  const uv = new Float32Array(n * 2)
  const tex = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    let u, v

    if (isBarkLayer(layer)) {
      u = ((Math.atan2(z, x) / (Math.PI * 2)) * BARK_U_REPEATS + 4) % 1
      v = y * UV_SCALE
    } else {
      const ax = Math.abs(nor.getX(i))
      const ay = Math.abs(nor.getY(i))
      const az = Math.abs(nor.getZ(i))
      if (ay >= ax && ay >= az) {
        u = x * UV_SCALE
        v = z * UV_SCALE
      } else if (ax >= az) {
        u = z * UV_SCALE
        v = y * UV_SCALE
      } else {
        u = x * UV_SCALE
        v = y * UV_SCALE
      }
    }

    uv[i * 2] = u
    uv[i * 2 + 1] = v
    tex[i] = layer
  }

  geometry.setAttribute('uvProj', new THREE.BufferAttribute(uv, 2))
  geometry.setAttribute('texLayer', new THREE.BufferAttribute(tex, 1))
  return geometry
}

// Sit the model on y=0 and center it on the XZ origin so instancing is sane.
function groundAndCenter(geometry) {
  geometry.computeBoundingBox()
  const bb = geometry.boundingBox
  const cx = (bb.min.x + bb.max.x) / 2
  const cz = (bb.min.z + bb.max.z) / 2
  geometry.translate(-cx, -bb.min.y, -cz)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

async function loadOne(name, basePath) {
  const mtl = await new MTLLoader().setPath(basePath).loadAsync(`${name}.mtl`)
  mtl.preload()
  const obj = await new OBJLoader()
    .setMaterials(mtl)
    .setPath(basePath)
    .loadAsync(`${name}.obj`)

  const parts = []
  obj.updateMatrixWorld(true)

  obj.traverse((child) => {
    if (!child.isMesh) return
    const geom = child.geometry
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    const groups =
      geom.groups && geom.groups.length > 0
        ? geom.groups
        : [{ start: 0, count: geom.attributes.position.count, materialIndex: 0 }]

    for (const g of groups) {
      if (g.count === 0) continue
      const mat = mats[g.materialIndex ?? 0]
      const layer = layerFor(mat?.name, name)
      const part = extractRange(geom, g.start, g.count)
      part.applyMatrix4(child.matrixWorld)
      parts.push(projectUVs(part, layer))
    }
  })

  if (parts.length === 0) throw new Error(`${name}: no geometry found`)

  // All parts are non-indexed with an identical attribute set, which is what
  // BatchedMesh requires -- mixing indexed and non-indexed in one batch breaks.
  const merged = BufferGeometryUtils.mergeGeometries(parts, false)
  if (!merged) throw new Error(`${name}: merge failed`)
  merged.clearGroups()
  groundAndCenter(merged)
  merged.name = name

  for (const p of parts) p.dispose()
  return merged
}

// The 80-500m LOD tier: two crossed quads. 4 tris, and per-instance random
// Y-rotation at placement time keeps a forest of them from showing a grain.
function crossQuad(height, width, layer) {
  const h = height
  const w = width / 2
  const positions = []
  const normals = []
  const uvs = []
  const layers = []

  const quad = (nx, nz) => {
    // two triangles, wound so DoubleSide covers both faces
    const pts = nx
      ? [
          [-w, 0, 0], [w, 0, 0], [w, h, 0],
          [-w, 0, 0], [w, h, 0], [-w, h, 0],
        ]
      : [
          [0, 0, -w], [0, 0, w], [0, h, w],
          [0, 0, -w], [0, h, w], [0, h, -w],
        ]
    const uvset = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]
    for (let i = 0; i < 6; i++) {
      positions.push(...pts[i])
      normals.push(nx ? 0 : 1, 0, nx ? 1 : 0)
      uvs.push(...uvset[i])
      layers.push(layer)
    }
  }
  quad(true)
  quad(false)

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  g.setAttribute('uvProj', new THREE.Float32BufferAttribute(uvs, 2))
  g.setAttribute('texLayer', new THREE.Float32BufferAttribute(layers, 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

export const PROP_NAMES = [
  'PineTree_1',
  'PineTree_Snow_1',
  'CommonTree_1',
  'CommonTree_Snow_1',
  'BirchTree_1',
  'Willow_1',
  'Bush_1',
  'Bush_Snow_1',
  'Rock_1',
  'Rock_Snow_1',
  'TreeStump',
  'TreeStump_Snow',
  'WoodLog_Snow',
]

export async function loadProps(basePath = './props/') {
  const geometries = []
  const failures = []

  const results = await Promise.all(
    PROP_NAMES.map((name) =>
      loadOne(name, basePath).catch((err) => {
        failures.push(`${name}: ${err.message}`)
        return null
      })
    )
  )

  for (const g of results) if (g) geometries.push(g)

  // Add a billboard tier so the batch holds a realistic mix of geometry sizes
  // and we can exercise setGeometryIdAt-style LOD swapping.
  const billboards = []
  for (const g of geometries) {
    const bb = g.boundingBox
    const h = bb.max.y - bb.min.y
    if (h < 1.2) continue // rocks and logs do not get a billboard tier
    const layer = h > 4 ? LAYER.NEEDLES : LAYER.LEAVES
    const q = crossQuad(h, h * 0.62, layer)
    q.name = `${g.name}_BB`
    billboards.push(q)
  }

  const all = [...geometries, ...billboards]

  const stats = {
    count: all.length,
    fullMeshes: geometries.length,
    billboards: billboards.length,
    totalTris: all.reduce((s, g) => s + g.attributes.position.count / 3, 0),
    maxVerts: all.reduce((s, g) => s + g.attributes.position.count, 0),
    heights: geometries.map((g) => ({
      name: g.name,
      h: +(g.boundingBox.max.y - g.boundingBox.min.y).toFixed(2),
      tris: g.attributes.position.count / 3,
    })),
    failures,
  }

  return { geometries: all, stats }
}
