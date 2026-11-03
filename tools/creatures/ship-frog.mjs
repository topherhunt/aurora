/**
 * Ship the frog: pocket-game's bogpip, its 1000-triangle tier and a quarter-count LOD2 (frogs.js draws two mesh
 * tiers and a far card), and its idle and hop clips baked into one bone texture. Writes public/creatures/bogpip.glb,
 * bogpip-lod2.glb, bogpip.webp and
 * bogpip-anim.bin (src/v2/render/frog-anim.js reads it).
 *
 *   node tools/creatures/ship-frog.mjs
 *
 * The source is work/bogpip/rigged.glb, copied from ../pocket-game/tools/creatures/work/bogpip/rigged.glb.
 *
 * A tier is a plain mesh in the bind pose, facing +X, centred over its feet, carrying JOINTS_0/WEIGHTS_0. A frame of
 * a clip is one texture row: each joint's skin matrix (joint world x inverse bind), moved into the shipped frame, as
 * three half-float RGBA texels holding the rows of its 3x4 -- baked-puppet.js's layout.
 * File: u32 header length, header JSON padded to 4 bytes, then the texels. `{ bones, rows, clips: [{ name, base,
 * frames, seconds }] }`; a clip is `frames + 1` rows, its end time included.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { readAccessor, readGlb } from './apply-rig-edit.mjs'
import { skinnedLadder } from './skin-ladder.mjs'
import { magick, viewOf } from '../tripo-pack.mjs'
import { TEX_PX_SMALL } from './creature-roster.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, 'work/bogpip/rigged.glb')
const OUT = path.join(HERE, '../../public/creatures')
export const ID = 'bogpip'
const TIER = 'tier1000'
// Clip name in the rig, and samples a second: a hop is over in a fraction of a second, so it is sampled finer.
const CLIPS = [{ name: 'idle', fps: 15 }, { name: 'hop', fps: 30 }]

const { json, bin } = readGlb(SRC)
const nodeOf = (name) => {
  const i = json.nodes.findIndex((n) => n.name === name)
  if (i < 0) throw new Error(`${SRC}: no node ${name}`)
  return i
}
const skin = json.skins[0]
const joints = skin.joints
const nb = joints.length
const ibm = readAccessor(json, bin, skin.inverseBindMatrices)
const parent = new Map()
json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))
for (const i of json.nodes.keys()) {
  const n = json.nodes[i]
  if (n.matrix || ((n.mesh === undefined) && !joints.includes(i) && (n.translation || n.rotation || n.scale))) throw new Error(`${SRC}: node ${n.name} carries a transform this shipper does not fold`)
}

// --- the mesh ---------------------------------------------------------------

const prim = json.meshes[json.nodes[nodeOf(TIER)].mesh].primitives[0]
const mesh = {
  positions: Float32Array.from(readAccessor(json, bin, prim.attributes.POSITION)),
  normals: Float32Array.from(readAccessor(json, bin, prim.attributes.NORMAL)),
  uvs: Float32Array.from(readAccessor(json, bin, prim.attributes.TEXCOORD_0)),
  indices: Uint32Array.from(readAccessor(json, bin, prim.indices)),
  joints: Uint16Array.from(readAccessor(json, bin, prim.attributes.JOINTS_0)),
  weights: Float32Array.from(readAccessor(json, bin, prim.attributes.WEIGHTS_0)),
}

// --- the skeleton at a time -------------------------------------------------

const rest = json.nodes.map((n) => ({ t: n.translation ?? [0, 0, 0], r: n.rotation ?? [0, 0, 0, 1], s: n.scale ?? [1, 1, 1] }))
function sampler(clip, ch) {
  const s = clip.samplers[ch.sampler]
  if ((s.interpolation ?? 'LINEAR') !== 'LINEAR') throw new Error(`${clip.name}: ${s.interpolation} interpolation`)
  return { times: readAccessor(json, bin, s.input), values: readAccessor(json, bin, s.output), node: ch.target.node, path: ch.target.path }
}
function at(track, t) {
  const { times, values } = track
  const w = track.path === 'rotation' ? 4 : 3
  let k = 0
  while (k < times.length - 2 && times[k + 1] <= t) k++
  const u = times.length < 2 ? 0 : Math.max(0, Math.min(1, (t - times[k]) / (times[k + 1] - times[k])))
  const a = Array.from(values.subarray(k * w, k * w + w))
  if (times.length < 2) return a
  const b = Array.from(values.subarray((k + 1) * w, (k + 1) * w + w))
  if (w === 4) return new THREE.Quaternion(...a).slerp(new THREE.Quaternion(...b), u).toArray()
  return a.map((x, i) => x + (b[i] - x) * u)
}
/** Each joint's skin matrix with `tracks` at time `t`. */
function skinAt(tracks, t) {
  const local = rest.map((r) => ({ ...r }))
  for (const tr of tracks) local[tr.node][{ translation: 't', rotation: 'r', scale: 's' }[tr.path]] = at(tr, t)
  const world = new Map()
  const worldOf = (i) => {
    if (world.has(i)) return world.get(i)
    const l = local[i]
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...l.t), new THREE.Quaternion(...l.r), new THREE.Vector3(...l.s))
    if (parent.has(i)) m.premultiply(worldOf(parent.get(i)))
    world.set(i, m)
    return m
  }
  return joints.map((j, k) => worldOf(j).clone().multiply(new THREE.Matrix4().fromArray(ibm, k * 16)))
}

// The bind pose must be the rig's rest: a held frog (no pose) is drawn as the mesh is.
const restSkin = skinAt([], 0)
const restErr = Math.max(...restSkin.map((m) => Math.max(...m.elements.map((e, i) => Math.abs(e - new THREE.Matrix4().elements[i])))))
if (restErr > 1e-3) throw new Error(`the rig's rest pose is ${restErr} off its bind pose`)

// --- the frame: feet on y = 0, centred over the origin ------------------------

const box = new THREE.Box3().setFromArray(mesh.positions)
const shift = new THREE.Vector3(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
for (let i = 0; i < mesh.positions.length; i += 3) {
  mesh.positions[i] += shift.x; mesh.positions[i + 1] += shift.y; mesh.positions[i + 2] += shift.z
}
const T = new THREE.Matrix4().makeTranslation(shift)
const Tinv = new THREE.Matrix4().makeTranslation(shift.clone().negate())

// --- the bake ---------------------------------------------------------------

const header = { bones: nb, rows: 0, clips: [] }
const rowsOut = []
for (const { name, fps } of CLIPS) {
  const clip = json.animations.find((a) => a.name === name)
  if (!clip) throw new Error(`${SRC}: no clip ${name}`)
  const tracks = clip.channels.map((ch) => sampler(clip, ch))
  const seconds = Math.max(...tracks.map((tr) => tr.times[tr.times.length - 1]))
  const frames = Math.max(1, Math.round(seconds * fps))
  header.clips.push({ name, base: header.rows, frames, seconds })
  for (let f = 0; f <= frames; f++) {
    for (const m of skinAt(tracks, (seconds * f) / frames)) {
      const e = m.premultiply(T).multiply(Tinv).elements
      rowsOut.push(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14])
    }
  }
  header.rows += frames + 1
}
const texels = Uint16Array.from(rowsOut, (x) => THREE.DataUtils.toHalfFloat(x))
let head = Buffer.from(JSON.stringify(header), 'utf8')
head = Buffer.concat([head, Buffer.alloc((4 - (head.length % 4)) % 4, 0x20)])
const len = Buffer.alloc(4)
len.writeUInt32LE(head.length, 0)
fs.writeFileSync(path.join(OUT, `${ID}-anim.bin`), Buffer.concat([len, head, Buffer.from(texels.buffer)]))
console.log(`ship ${ID}-anim.bin: ${nb} bones x ${header.rows} rows, ${header.clips.map((c) => `${c.name} ${c.frames + 1} rows over ${c.seconds.toFixed(2)} s`).join(', ')}`)

// --- the colour map ---------------------------------------------------------

const mat = json.materials[prim.material]
const image = json.images[json.textures[mat.pbrMetallicRoughness.baseColorTexture.index].extensions.EXT_texture_webp.source]
const tmp = path.join(OUT, `${ID}.src.webp`)
fs.writeFileSync(tmp, viewOf(json, bin, image.bufferView))
try {
  magick([tmp, '-resize', `${TEX_PX_SMALL}x${TEX_PX_SMALL}`, '-alpha', 'off', '-quality', '90', path.join(OUT, `${ID}.webp`)])
} finally {
  fs.rmSync(tmp)
}

// --- the ladder -------------------------------------------------------------

/** One tier as a GLB: positions, normals, uvs, joints, weights, indices, the shared WebP by uri. */
function writeTier(file, t) {
  const n = t.positions.length / 3
  const arrays = [
    { data: Float32Array.from(t.positions), type: 'VEC3', comp: 5126, minmax: true },
    { data: Float32Array.from(t.normals), type: 'VEC3', comp: 5126 },
    { data: Float32Array.from(t.uvs), type: 'VEC2', comp: 5126 },
    { data: Uint8Array.from(t.joints), type: 'VEC4', comp: 5121 },
    { data: Float32Array.from(t.weights), type: 'VEC4', comp: 5126 },
    { data: Uint16Array.from(t.indices), type: 'SCALAR', comp: 5123, index: true },
  ]
  if (n > 65535) throw new Error(`${file}: ${n} vertices do not fit 16-bit indices`)
  const parts = [], views = [], accessors = []
  let off = 0
  for (const a of arrays) {
    const bytes = Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength)
    views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, target: a.index ? 34963 : 34962 })
    const acc = { bufferView: views.length - 1, componentType: a.comp, count: a.index ? a.data.length : n, type: a.type }
    if (a.minmax) {
      const b = new THREE.Box3().setFromArray(a.data)
      acc.min = b.min.toArray(); acc.max = b.max.toArray()
    }
    accessors.push(acc)
    const pad = (4 - (bytes.length % 4)) % 4
    parts.push(bytes, Buffer.alloc(pad))
    off += bytes.length + pad
  }
  const gltf = {
    asset: { version: '2.0', generator: 'tools/creatures/ship-frog.mjs' },
    extensionsUsed: ['EXT_texture_webp'],
    extensionsRequired: ['EXT_texture_webp'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: ID, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, JOINTS_0: 3, WEIGHTS_0: 4 }, indices: 5, material: 0 }] }],
    materials: [{ name: ID, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [{ extensions: { EXT_texture_webp: { source: 0 } } }],
    images: [{ uri: `${ID}.webp`, mimeType: 'image/webp' }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: off }],
  }
  let j = Buffer.from(JSON.stringify(gltf), 'utf8')
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)])
  const b = Buffer.concat(parts)
  const h = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8)
  h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + j.length + b.length, 8)
  jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
  bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  fs.writeFileSync(path.join(OUT, file), Buffer.concat([h, jh, j, bh, b]))
}

const ladder = skinnedLadder(mesh, [0.25])
ladder.forEach((t, k) => writeTier(k ? `${ID}-lod2.glb` : `${ID}.glb`, t))
console.log(`ship ${ID}.glb ladder: ${ladder.map((t) => t.indices.length / 3).join('/')} triangles`)
