// ---------------------------------------------------------------------------
// Ships the birch spider as ONE animated GLB, public/creatures/birch-spider.glb:
//
//   node tools/creatures/ship-spider.mjs
//
// The world draws a spider as a skinned mesh playing its clip library, so the
// file carries what ship.mjs's static critter files do not: the authored
// skeleton (rig-spider.mjs), its skinned ladder bound to that one skeleton
// (skin-ladder.mjs), and every clip in anim-*.glb as one animation each,
// targeting the same joint nodes. The colour map is one 128 px WebP through
// tools/tripo-pack.mjs, like every other critter. src/v2/render/spiders.js
// loads it by name.
//
// Every tier is in the frame the skeleton was authored in -- the pick's node
// matrix baked in, feet on y = 0 -- because the ladder is decimated from the
// rig's own vertices rather than fetched from the bench and moved.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ID, rigSpider } from './rig-spider.mjs'
import { CREATURES, shipTexPx } from './creature-roster.mjs'
import { workDir } from './workspace.mjs'
import { readAccessor, readGlb, writeGlb } from './apply-rig-edit.mjs'
import { ladderLine, skinnedLadder } from './skin-ladder.mjs'
import { packTexture, tripoColourJpeg } from '../tripo-pack.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'public/creatures')
export const CLIPS = ['walk', 'run', 'idle', 'alert', 'eat', 'rest']

const FLOAT = 5126, UBYTE = 5121, UINT = 5125

export function shipSpider() {
  const meta = CREATURES.find((c) => c.id === ID)
  if (!meta) throw new Error(`${ID} is not in the roster`)
  const dir = workDir(ID)
  const rig = rigSpider({ write: false })
  const pick = rig.mesh
  const pickUV = readAccessor(pick.json, pick.bin, pick.prim.attributes.TEXCOORD_0)

  const ladder = skinnedLadder({
    positions: Float32Array.from(pick.V.flat()),
    normals: Float32Array.from(pick.N.flat()),
    uvs: pickUV,
    indices: Uint32Array.from(pick.I),
    joints: rig.skin.J,
    weights: rig.skin.Wt,
  })
  const tiers = ladder.map((t, level) => ({
    level,
    V: Array.from({ length: t.positions.length / 3 }, (_, i) => [t.positions[i * 3], t.positions[i * 3 + 1], t.positions[i * 3 + 2]]),
    N: Array.from({ length: t.normals.length / 3 }, (_, i) => [t.normals[i * 3], t.normals[i * 3 + 1], t.normals[i * 3 + 2]]),
    UV: t.uvs,
    I: Array.from(t.indices),
    skin: { J: t.joints, Wt: t.weights },
  }))

  // The BIN chunk, appended view by view.
  const parts = []
  let at = 0
  const bufferViews = [], accessors = []
  const view = (bytes) => {
    bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.length })
    parts.push(bytes)
    at += bytes.length
    const pad = (4 - (bytes.length % 4)) % 4
    if (pad) { parts.push(Buffer.alloc(pad)); at += pad }
    return bufferViews.length - 1
  }
  const accessor = (bytes, componentType, count, type, extra = {}) => {
    accessors.push({ bufferView: view(bytes), componentType, count, type, ...extra })
    return accessors.length - 1
  }
  const f32 = (arr) => Buffer.from(new Float32Array(arr).buffer)

  const meshes = tiers.map((t) => {
    const flat = t.V.flat()
    const min = [0, 1, 2].map((k) => Math.min(...t.V.map((p) => p[k])))
    const max = [0, 1, 2].map((k) => Math.max(...t.V.map((p) => p[k])))
    return {
      name: t.level ? `${ID}-lod${t.level}` : ID,
      primitives: [{
        attributes: {
          POSITION: accessor(f32(flat), FLOAT, t.V.length, 'VEC3', { min, max }),
          NORMAL: accessor(f32(t.N.flat()), FLOAT, t.N.length, 'VEC3'),
          TEXCOORD_0: accessor(f32(t.UV), FLOAT, t.V.length, 'VEC2'),
          JOINTS_0: accessor(Buffer.from(t.skin.J.buffer), UBYTE, t.V.length, 'VEC4'),
          WEIGHTS_0: accessor(Buffer.from(t.skin.Wt.buffer), FLOAT, t.V.length, 'VEC4'),
        },
        indices: accessor(Buffer.from(new Uint32Array(t.I).buffer), UINT, t.I.length, 'SCALAR'),
        material: 0,
      }],
    }
  })

  // Nodes: the tiers first, then the joints in rig order, so a joint's node is its rig index plus the tier count.
  const joints = rig.joints
  const jointNode = new Map(joints.map((j, i) => [j.name, i + tiers.length]))
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const nodes = [
    ...tiers.map((t, k) => ({ name: meshes[k].name, mesh: k, skin: 0 })),
    ...joints.map((j) => {
      const from = j.parent ? joints.find((p) => p.name === j.parent).at : [0, 0, 0]
      const node = { name: j.name, translation: sub(j.at, from), rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
      if (j.children.length) node.children = j.children.map((c) => jointNode.get(c.name))
      return node
    }),
  ]
  const root = joints.find((j) => j.parent === null)
  const ibm = joints.flatMap((j) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -j.at[0], -j.at[1], -j.at[2], 1])
  const skins = [{
    name: `${ID}-skeleton`,
    joints: joints.map((j) => jointNode.get(j.name)),
    inverseBindMatrices: accessor(f32(ibm), FLOAT, joints.length, 'MAT4'),
    skeleton: jointNode.get(root.name),
  }]

  // The clips: every channel re-targeted from its anim file's node index to this file's, by joint name.
  const animations = CLIPS.map((name) => {
    const file = path.join(dir, `anim-${name}.glb`)
    if (!fs.existsSync(file)) throw new Error(`${ID}: no clip ${file} -- run tools/creatures/anim/build.mjs ${ID}`)
    const { json, bin } = readGlb(file)
    const anim = json.animations?.[0]
    if (!anim) throw new Error(`${file} carries no animation`)
    const samplers = [], channels = []
    const inputs = new Map()
    for (const ch of anim.channels) {
      const s = anim.samplers[ch.sampler]
      if (!inputs.has(s.input)) {
        const times = readAccessor(json, bin, s.input)
        inputs.set(s.input, accessor(f32(times), FLOAT, times.length, 'SCALAR', { min: [times[0]], max: [times[times.length - 1]] }))
      }
      const jointName = json.nodes[ch.target.node].name
      const node = jointNode.get(jointName)
      if (node === undefined) throw new Error(`${file}: channel targets ${jointName}, which the skeleton has no joint for -- the clip was built against another rig`)
      const out = readAccessor(json, bin, s.output)
      const items = ch.target.path === 'rotation' ? 4 : 3
      samplers.push({
        input: inputs.get(s.input),
        output: accessor(f32(out), FLOAT, out.length / items, items === 4 ? 'VEC4' : 'VEC3'),
        interpolation: s.interpolation ?? 'LINEAR',
      })
      channels.push({ sampler: samplers.length - 1, target: { node, path: ch.target.path } })
    }
    return { name, samplers, channels }
  })

  const texture = `${ID}.webp`
  const texPx = shipTexPx(meta)
  packTexture(tripoColourJpeg(path.join(dir, 'mesh.glb'), pick.json, pick.bin, 0), path.join(OUT, texture), texPx)
  const { name: matName, doubleSided } = pick.json.materials[0]
  const json = {
    asset: { version: '2.0', generator: 'tools/creatures/ship-spider.mjs' },
    extensionsUsed: ['EXT_texture_webp'],
    extensionsRequired: ['EXT_texture_webp'],
    scene: 0,
    scenes: [{ nodes: [...tiers.map((_, k) => k), jointNode.get(root.name)] }],
    nodes, meshes, skins, animations, accessors, bufferViews,
    buffers: [{ byteLength: at }],
    images: [{ uri: texture, mimeType: 'image/webp' }],
    textures: [{ extensions: { EXT_texture_webp: { source: 0 } } }],
    materials: [{ name: matName, doubleSided, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
  }
  fs.mkdirSync(OUT, { recursive: true })
  const out = path.join(OUT, `${ID}.glb`)
  writeGlb(out, json, Buffer.concat(parts))
  console.log(`ship ${ID}.glb: ${(fs.statSync(out).size / 1024).toFixed(0)} KB, tiers ${ladderLine(ladder)} tris, ${joints.length} joints, clips ${CLIPS.join(' ')}, texture ${texPx}px ${(fs.statSync(path.join(OUT, texture)).size / 1024).toFixed(0)} KB`)
  return { out, tris: ladder.map((t) => t.indices.length / 3), joints: joints.length, clips: CLIPS.length }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) shipSpider()
