// ---------------------------------------------------------------------------
// Shared GLB writer for the character pipeline. Extracted from
// tools/trees/generate.mjs's hand-rolled writer (same reasoning: three's
// GLTFExporter wants a canvas, and Node has none) and extended with skinning
// (JOINTS_0/WEIGHTS_0 + a skin + inverse bind matrices) and baked animation
// clips, neither of which the tree pipeline needed.
//
// Bind pose is translation-only for most bones, but rig.mjs's arm bones
// carry a real rest rotation (T-pose), so world position/rotation per bone
// -- and each inverse bind matrix -- has to be composed through the full
// glTF hierarchy rule (childWorldPos = parentWorldPos + parentWorldRot *
// childTranslation, childWorldRot = parentWorldRot * childLocalRot), not a
// plain translation sum. That composition is a no-op for a skeleton whose
// rotations are all identity, so nothing here regresses a translation-only
// rig.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

const IDENTITY_QUAT = [0, 0, 0, 1]

// Rotates vector v by unit quaternion q (v' = q*v*q^-1).
function rotateVec([qx, qy, qz, qw], [vx, vy, vz]) {
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ]
}

// Hamilton product, a*b (applies b first then a).
function quatMultiply([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

// Column-major 3x3 rotation matrix for unit quaternion q.
function quatToMat3([x, y, z, w]) {
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  return [
    1 - (yy + zz), xy + wz, xz - wy,
    xy - wz, 1 - (xx + zz), yz + wx,
    xz + wy, yz - wx, 1 - (xx + yy),
  ]
}

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
 * skeleton?: { bones: [{ name, parent }], translations: Float32Array(N*3),
 *   rotations?: Float32Array(N*4) } -- translation/rotation are LOCAL to the
 *   bone's parent (world for root bones). rotations may be omitted (treated
 *   as identity for every bone) or per-bone identity, per the header note.
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

    const { bones, translations, rotations } = skeleton
    const world = new Float32Array(bones.length * 3)
    const worldRot = []
    for (let i = 0; i < bones.length; i++) {
      const p = bones[i].parent
      const pPos = p >= 0 ? [world[p * 3], world[p * 3 + 1], world[p * 3 + 2]] : [0, 0, 0]
      const pRot = p >= 0 ? worldRot[p] : IDENTITY_QUAT
      const localPos = [translations[i * 3], translations[i * 3 + 1], translations[i * 3 + 2]]
      const rotatedLocalPos = rotateVec(pRot, localPos)
      world[i * 3] = pPos[0] + rotatedLocalPos[0]
      world[i * 3 + 1] = pPos[1] + rotatedLocalPos[1]
      world[i * 3 + 2] = pPos[2] + rotatedLocalPos[2]
      const localRot = rotations ? [rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3]] : IDENTITY_QUAT
      worldRot[i] = quatMultiply(pRot, localRot)
    }

    const ibm = new Float32Array(bones.length * 16)
    for (let i = 0; i < bones.length; i++) {
      // Inverse of the bone's rigid bind-pose world transform (R, t): R^-1 =
      // R^T (quaternion conjugate), t^-1 = -R^T * t. Reduces to the old
      // translate(-world) shortcut whenever the bone's world rotation is
      // identity.
      const q = worldRot[i]
      const conj = [-q[0], -q[1], -q[2], q[3]]
      const rt = quatToMat3(conj)
      const wp = [world[i * 3], world[i * 3 + 1], world[i * 3 + 2]]
      const t = rotateVec(conj, [-wp[0], -wp[1], -wp[2]])
      const m = ibm.subarray(i * 16, i * 16 + 16)
      m[0] = rt[0]; m[1] = rt[1]; m[2] = rt[2]; m[3] = 0
      m[4] = rt[3]; m[5] = rt[4]; m[6] = rt[5]; m[7] = 0
      m[8] = rt[6]; m[9] = rt[7]; m[10] = rt[8]; m[11] = 0
      m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1
    }
    const aIbm = b.add(ibm, 0, 'MAT4', 5126, { count: bones.length })

    jointNodeBase = 1 // node 0 is the mesh node
    const jointNodes = bones.map((bone, i) => {
      const node = {
        name: bone.name,
        translation: [translations[i * 3], translations[i * 3 + 1], translations[i * 3 + 2]],
        children: [],
      }
      if (rotations) {
        const q = [rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3]]
        if (q[0] !== 0 || q[1] !== 0 || q[2] !== 0 || q[3] !== 1) node.rotation = q
      }
      return node
    })
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
