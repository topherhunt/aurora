// ---------------------------------------------------------------------------
// Shared GLB writer for the character pipeline. Extracted from
// tools/trees/generate.mjs's hand-rolled writer (same reasoning: three's
// GLTFExporter wants a canvas, and Node has none) and extended with skinning
// (JOINTS_0/WEIGHTS_0 + a skin + inverse bind matrices) and baked animation
// clips, neither of which the tree pipeline needed.
//
// Bind pose is assumed translation-only (no per-bone rotation at rest) --
// true for every skeleton rig.mjs builds -- so each inverse bind matrix is
// just translate(-worldPos) and never needs a real matrix inverse.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

function bufferViewsAndAccessors() {
  const views = []
  const accessors = []
  const chunks = []
  let offset = 0
  // Pads to 4 bytes, appends `buf` as a bufferView, and returns its index.
  // The only way any chunk enters `chunks` -- every writer, `add()` included,
  // funnels through this so `offset` can never desync from the real byte
  // length again (it did, once: an earlier version pushed the image chunk
  // directly and left every accessor written after it pointing at the wrong
  // offset).
  const addView = (buf, target) => {
    const pad = (4 - (offset % 4)) % 4
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad }
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target })
    chunks.push(buf)
    offset += buf.length
    return views.length - 1
  }
  const add = (arr, target, type, componentType, extra = {}) => {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
    addView(buf, target)
    accessors.push({ bufferView: views.length - 1, componentType, count: extra.count, type, ...extra.bounds })
    return accessors.length - 1
  }
  return { views, accessors, chunks, add, addView, offset: () => offset }
}

/**
 * Writes one GLB.
 *
 * geo: { pos, nrm, uv, idx, skinIndices?, skinWeights? } -- flat arrays, plain
 *   JS numbers. skinIndices/skinWeights are length vcount*4 each (4 bone
 *   influences per vertex) when the mesh is skinned.
 * skeleton?: { bones: [{ name, parent }] , translations: Float32Array(N*3) }
 *   -- translation is LOCAL to the bone's parent (world for root bones).
 *   Bind pose is translation-only, per the header note.
 * animations?: [{ name, tracks: [{ bone, path: 'translation'|'rotation', times: number[], values: number[] }] }]
 *   -- values are flat VEC3 (translation) or VEC4 quaternion (rotation) per keyframe.
 * image?: Buffer -- a PNG to embed as the mesh's baseColor texture.
 */
export function writeGlb(file, geo, { skeleton, animations, image } = {}) {
  const pos = new Float32Array(geo.pos)
  const nrm = new Float32Array(geo.nrm)
  const uv = new Float32Array(geo.uv)
  const vcount = pos.length / 3
  const idx = vcount > 65535 ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx)

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (pos[i + c] < min[c]) min[c] = pos[i + c]
      if (pos[i + c] > max[c]) max[c] = pos[i + c]
    }
  }

  const b = bufferViewsAndAccessors()
  const aPos = b.add(pos, 34962, 'VEC3', 5126, { count: vcount, bounds: { min, max } })
  const aNrm = b.add(nrm, 34962, 'VEC3', 5126, { count: vcount })
  const aUv = b.add(uv, 34962, 'VEC2', 5126, { count: vcount })
  const aIdx = b.add(idx, 34963, 'SCALAR', idx.BYTES_PER_ELEMENT === 4 ? 5125 : 5123, { count: idx.length })

  const attributes = { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv }

  let skin, skinNode, jointNodeBase
  const nodes = [{ mesh: 0 }]
  let sceneNodes = [0]

  if (skeleton) {
    const skinI = new Uint8Array(geo.skinIndices)
    const skinW = new Float32Array(geo.skinWeights)
    const aJoints = b.add(skinI, 34962, 'VEC4', 5121, { count: vcount })
    const aWeights = b.add(skinW, 34962, 'VEC4', 5126, { count: vcount })
    attributes.JOINTS_0 = aJoints
    attributes.WEIGHTS_0 = aWeights

    const { bones, translations } = skeleton
    const world = new Float32Array(bones.length * 3)
    for (let i = 0; i < bones.length; i++) {
      const p = bones[i].parent
      const px = p >= 0 ? world[p * 3] : 0, py = p >= 0 ? world[p * 3 + 1] : 0, pz = p >= 0 ? world[p * 3 + 2] : 0
      world[i * 3] = px + translations[i * 3]
      world[i * 3 + 1] = py + translations[i * 3 + 1]
      world[i * 3 + 2] = pz + translations[i * 3 + 2]
    }

    const ibm = new Float32Array(bones.length * 16)
    for (let i = 0; i < bones.length; i++) {
      // Column-major 4x4 identity with translation -world.
      const m = ibm.subarray(i * 16, i * 16 + 16)
      m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1
      m[12] = -world[i * 3]; m[13] = -world[i * 3 + 1]; m[14] = -world[i * 3 + 2]
    }
    const aIbm = b.add(ibm, 0, 'MAT4', 5126, { count: bones.length })

    jointNodeBase = 1 // node 0 is the mesh node
    const jointNodes = bones.map((bone, i) => ({
      name: bone.name,
      translation: [translations[i * 3], translations[i * 3 + 1], translations[i * 3 + 2]],
      children: [],
    }))
    bones.forEach((bone, i) => {
      if (bone.parent >= 0) jointNodes[bone.parent].children.push(jointNodeBase + i)
    })
    if (!jointNodes.length) throw new Error('skeleton has no bones')
    jointNodes.forEach((n) => { if (!n.children.length) delete n.children })
    nodes.push(...jointNodes)

    const roots = bones.map((bone, i) => bone.parent < 0 ? jointNodeBase + i : -1).filter((i) => i >= 0)
    sceneNodes = [0, ...roots]

    skin = { inverseBindMatrices: aIbm, joints: bones.map((_, i) => jointNodeBase + i), skeleton: roots[0] }
    skinNode = 0
    nodes[0].skin = 0
  }

  let images, textures, materials
  if (image) {
    b.addView(image)
    images = [{ bufferView: b.views.length - 1, mimeType: 'image/png' }]
    textures = [{ source: 0 }]
    materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, alphaMode: image ? 'MASK' : 'OPAQUE' }]
  }

  let animOut
  if (animations && animations.length) {
    animOut = animations.map((clip) => {
      const samplers = []
      const channels = []
      for (const track of clip.tracks) {
        const times = new Float32Array(track.times)
        const values = new Float32Array(track.values)
        const aTimes = b.add(times, 0, 'SCALAR', 5126, { count: times.length, bounds: { min: [times[0]], max: [times[times.length - 1]] } })
        const aValues = b.add(values, 0, track.path === 'rotation' ? 'VEC4' : 'VEC3', 5126, { count: times.length })
        samplers.push({ input: aTimes, output: aValues, interpolation: 'LINEAR' })
        channels.push({ sampler: samplers.length - 1, target: { node: jointNodeBase + track.bone, path: track.path } })
      }
      return { name: clip.name, samplers, channels }
    })
  }

  const bin = Buffer.concat(b.chunks)
  const primitive = { attributes, indices: aIdx }
  if (materials) primitive.material = 0

  const json = {
    asset: { version: '2.0', generator: 'aurora tools/characters/gltf-writer.mjs' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes: [{ primitives: [primitive] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: b.views,
    accessors: b.accessors,
  }
  if (skin) json.skins = [skin]
  if (animOut) json.animations = animOut
  if (images) { json.images = images; json.textures = textures; json.materials = materials }

  const jsonBuf = Buffer.from(JSON.stringify(json))
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0)
  const jsonChunk = Buffer.concat([jsonBuf, jsonPad])
  const binChunk = Buffer.concat([bin, binPad])

  const header = Buffer.alloc(12)
  header.write('glTF', 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)

  const jsonHdr = Buffer.alloc(8)
  jsonHdr.writeUInt32LE(jsonChunk.length, 0)
  jsonHdr.writeUInt32LE(0x4e4f534a, 4)
  const binHdr = Buffer.alloc(8)
  binHdr.writeUInt32LE(binChunk.length, 0)
  binHdr.writeUInt32LE(0x004e4942, 4)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([header, jsonHdr, jsonChunk, binHdr, binChunk]))
  return { bytes: fs.statSync(file).size, verts: vcount, tris: idx.length / 3 }
}
