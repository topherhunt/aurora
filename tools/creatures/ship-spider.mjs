// ---------------------------------------------------------------------------
// Ships the birch spider as ONE animated GLB, public/creatures/birch-spider.glb:
//
//   node tools/creatures/ship-spider.mjs
//
// The world draws a spider as a skinned mesh playing its clip library, so the
// file carries what ship.mjs's static critter files do not: the authored
// skeleton (rig-spider.mjs), three skinned tiers bound to it -- the pick as
// LOD0 and the bench's decimated lod1 and lod2 (lod3 is not shipped; at 48 tris
// it does not read as a spider), each tier skinned by the same bones -- and
// every clip in anim-*.glb as one animation each, targeting the same joint
// nodes. The colour map is one 128 px WebP through tools/tripo-pack.mjs, like
// every other critter. src/v2/render/spiders.js loads it by name.
//
// The tiers share the pick's frame: the pick's node matrix baked in and its
// feet on y = 0, which is the frame the skeleton was authored in; a tier is a
// decimation of the same vertices, so the same move puts it in register.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ID, rigSpider } from './rig-spider.mjs'
import { CREATURES, shipTexPx } from './creature-roster.mjs'
import { readState, workDir } from './workspace.mjs'
import { readAccessor, readGlb, writeGlb } from './apply-rig-edit.mjs'
import { packTexture, tripoColourJpeg } from '../tripo-pack.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'public/creatures')
// The tiers the world draws, by bench level; the pick is level 0.
export const TIERS = [0, 1, 2]
export const CLIPS = ['walk', 'run', 'idle', 'alert', 'eat', 'rest']

const FLOAT = 5126, UBYTE = 5121, UINT = 5125

/** A tier's vertices moved into the pick's frame: the pick's node matrix, then its floor. */
function tierMesh(file, { m, floor }) {
  const { json, bin } = readGlb(file)
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error(`${file}: expected one mesh with one primitive`)
  const prim = json.meshes[0].primitives[0]
  const P = readAccessor(json, bin, prim.attributes.POSITION)
  const N = readAccessor(json, bin, prim.attributes.NORMAL)
  const UV = readAccessor(json, bin, prim.attributes.TEXCOORD_0)
  const I = readAccessor(json, bin, prim.indices)
  const rot = (v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ]
  const V = [], Nw = []
  for (let i = 0; i < P.length; i += 3) {
    const p = rot([P[i], P[i + 1], P[i + 2]])
    V.push([p[0] + m[12], p[1] + m[13] - floor, p[2] + m[14]])
    Nw.push(rot([N[i], N[i + 1], N[i + 2]]))
  }
  return { V, N: Nw, UV: Array.from(UV), I: Array.from(I) }
}

export function shipSpider() {
  const meta = CREATURES.find((c) => c.id === ID)
  if (!meta) throw new Error(`${ID} is not in the roster`)
  const dir = workDir(ID)
  const { pickedMesh } = readState(ID)
  if (!pickedMesh) throw new Error(`${ID}: no picked mesh`)
  const rig = rigSpider({ write: false })
  const pick = rig.mesh
  const pickUV = Array.from(readAccessor(pick.json, pick.bin, pick.prim.attributes.TEXCOORD_0))

  const tiers = TIERS.map((level) => {
    if (level === 0) return { level, V: pick.V, N: pick.N, UV: pickUV, I: Array.from(pick.I), skin: rig.skin }
    const file = path.join(dir, 'meshes', `${pickedMesh.replace(/\.glb$/, '')}-lod${level}.glb`)
    if (!fs.existsSync(file)) throw new Error(`${ID}: no lod${level} tier at ${file} -- save a ladder in gen-creature.html`)
    const t = tierMesh(file, pick)
    return { level, ...t, skin: rig.skinOther(t.V) }
  })

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
  const tris = tiers.map((t) => t.I.length / 3)
  console.log(`ship ${ID}.glb: ${(fs.statSync(out).size / 1024).toFixed(0)} KB, tiers ${tris.join('/')} tris, ${joints.length} joints, clips ${CLIPS.join(' ')}, texture ${texPx}px ${(fs.statSync(path.join(OUT, texture)).size / 1024).toFixed(0)} KB`)
  return { out, tris, joints: joints.length, clips: CLIPS.length }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) shipSpider()
