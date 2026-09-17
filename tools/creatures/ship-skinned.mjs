// ---------------------------------------------------------------------------
// The one shipper behind every animated creature: an id and its body plan in,
// one GLB into public/creatures/ out. ship-quadruped.mjs, ship-biped.mjs and
// ship-wyvern.mjs are each a roster, a plan check and a gait list over
// `shipSkinned`; the file they write is the shape src/v2/render/puppet.js reads.
//
// Each file carries Tripo's skinned mesh AND ITS LADDER -- the mesh decimated
// to skin-ladder.mjs's TIER_FRACTIONS, every tier over the same skeleton -- the
// whole clip library of its plan (tools/creatures/anim/clips/<plan>) as one
// animation per clip, and one colour WebP at the roster's texPx.
//
// THE WORK FILES ARE ALREADY NEARLY THIS. `anim-<clip>.glb` is a copy of the rig
// with one clip written into it, so the mesh, the skin and the joint nodes are
// the same nodes in all of them; this reads the first as the body and takes
// only the animations out of the rest, checking joint for joint that they were
// built against the same rig.
//
// WHAT IT CHANGES IS THE FRAME. Tripo hands a mesh back facing wherever its
// source image looked from, standing wherever the generator left it, under an
// `Armature` node that carries a translation of its own; the world wants every
// creature facing +X with its feet on y = 0 and its middle over the origin. The
// whole correction goes onto the ROOT JOINT: its rest transform, and every
// sample of the root translation and rotation the clips write, are premultiplied
// by one rigid transform, and the Armature is folded into the same product and
// dropped. Nothing else moves -- not a vertex, not an inverse bind matrix, not a
// limb's rotation track -- because premultiplying the root is exactly a change of
// the space the whole skeleton hangs in.
//
// THE LADDER IS DECIMATED HERE, not read off the bench. gen-creature.html can
// save tiers beside a candidate, but a saved tier is a decimation of THAT
// candidate, and Tripo's rigger may hand back a retopologised mesh instead of
// the one that was picked -- the fox's rig came back at 474 triangles against a
// 982-triangle pick, so its saved ladder was of a mesh that never shipped. What
// ships is decimated from what ships. The bench's tiers stay a preview.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CREATURES, shipTexPx } from './creature-roster.mjs'
import { clipNames, planOf, tunedSpec } from './anim/build.mjs'
import { readRigMap, workDir } from './anim/rig-map.mjs'
import { readAccessor, readGlb, writeGlb } from './apply-rig-edit.mjs'
import { ladderLine, skinnedLadder } from './skin-ladder.mjs'
import { packTexture, tripoColourJpeg } from '../tripo-pack.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'public/creatures')

const FLOAT = 5126, UINT = 5125

/** A flat [x, y, z, ...] run's bounds, the pair glTF wants on a POSITION accessor. */
function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k])
      max[k] = Math.max(max[k], positions[i + k])
    }
  }
  return { min, max }
}

/**
 * The rigid transform that carries a rig into the world's frame, as a yaw about
 * +Y and a translation after it.
 *
 * The yaw is the one that turns the map's `forward` onto +X, which three's
 * Matrix4.makeRotationY writes as (c*vx + s*vz, vy, -s*vx + c*vz): feeding
 * `forward` itself in as (c, s) gives (fx^2 + fz^2, 0, 0), and `forward` is a
 * unit vector, so cos = fx and sin = fz with no trigonometry at all.
 *
 * The translation is then MEASURED, off the turned bind pose, not taken from
 * the map: the map's `ground` and `centre` are in the joint chain's own space
 * and the Armature above it has already carried them somewhere, so reading them
 * as if they were scene coordinates moves the animal twice. `bind` is the
 * POSITION accessor as it stands -- at the bind pose every skin matrix is the
 * identity by the definition of an inverse bind matrix, so the vertices ARE the
 * skinned body.
 */
export function worldFrame(map, bind) {
  const [fx, fy, fz] = map.frame.forward
  if (Math.abs(fy) > 1e-6 || Math.abs(Math.hypot(fx, fz) - 1) > 1e-4) throw new Error(`frame.forward ${map.frame.forward} is not a unit vector in the ground plane`)
  const yaw = { c: fx, s: fz, t: [0, 0, 0] }
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < bind.length; i += 3) {
    const p = framePoint(yaw, [bind[i], bind[i + 1], bind[i + 2]])
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]) }
  }
  return {
    ...yaw,
    t: [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2],
    // The body along +X, so the length is the X extent; the world draws at sizeM over it.
    span: hi[0] - lo[0], width: hi[2] - lo[2], height: hi[1] - lo[1],
  }
}

/** A point through the frame's yaw and translation. */
const framePoint = ({ c, s, t }, p) => [c * p[0] + s * p[2] + t[0], p[1] + t[1], c * p[2] - s * p[0] + t[2]]
/** The frame's yaw as a quaternion, to turn what the root already carries. */
const frameQuat = ({ c, s }) => {
  const half = Math.atan2(s, c) / 2
  return [0, Math.sin(half), 0, Math.cos(half)]
}
/** Hamilton product, three's [x, y, z, w] order. */
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]

/** The GLB a creature's clips were built into, and the joint nodes they share. */
function readRig(id, clip) {
  const file = path.join(workDir(id), `anim-${clip}.glb`)
  if (!fs.existsSync(file)) throw new Error(`${id}: no ${path.relative(ROOT, file)} -- run tools/creatures/anim/build.mjs ${id}`)
  const { json, bin } = readGlb(file)
  if (json.skins?.length !== 1) throw new Error(`${file}: ${json.skins?.length ?? 0} skins, expected one`)
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error(`${file}: expected one mesh with one primitive`)
  if (!json.animations?.length) throw new Error(`${file}: carries no animation`)
  return { file, json, bin }
}

/**
 * The skeleton as the output's nodes: the joints in the skin's order, each with
 * the rest transform it had, the root's premultiplied by `frame` composed with
 * whatever the Armature above it carried. A joint's node index is its skin index
 * plus `offset`, the ladder's tiers taking the nodes below it.
 */
function skeletonNodes(file, json, frame, offset) {
  const joints = json.skins[0].joints
  const index = new Map(joints.map((n, i) => [n, i + offset]))
  const parent = new Map()
  for (const n of joints) for (const c of json.nodes[n].children ?? []) {
    if (!index.has(c)) throw new Error(`${file}: joint ${json.nodes[n].name} has a child that is not a joint`)
    parent.set(c, n)
  }
  const roots = joints.filter((n) => !parent.has(n))
  if (roots.length !== 1) throw new Error(`${file}: ${roots.length} root joints, expected one`)

  // The Armature, or whatever else stands above the root joint, folded into the
  // frame: the root becomes a scene root, so anything it hung under has to come
  // with it or the clips' root translations land in the wrong place.
  const above = json.nodes.find((n) => (n.children ?? []).includes(roots[0]))
  if (above?.rotation || above?.scale || above?.matrix) throw new Error(`${file}: ${above.name} above the root joint carries more than a translation`)
  const lifted = above?.translation ? { ...frame, t: framePoint(frame, above.translation) } : frame

  const nodes = joints.map((n) => {
    const src = json.nodes[n]
    const node = { name: src.name, translation: src.translation ?? [0, 0, 0], rotation: src.rotation ?? [0, 0, 0, 1], scale: src.scale ?? [1, 1, 1] }
    if (n === roots[0]) {
      node.translation = framePoint(lifted, node.translation)
      node.rotation = qmul(frameQuat(frame), node.rotation)
    }
    if (src.children?.length) node.children = src.children.map((c) => index.get(c))
    return node
  })
  // Keyed by name as well as by source index: a clip built into a sibling file
  // carries its own node numbering, and only the joint names are shared.
  const byName = new Map(joints.map((n) => [json.nodes[n].name, index.get(n)]))
  return { nodes, index, byName, root: index.get(roots[0]), rootName: json.nodes[roots[0]].name, lifted }
}

/**
 * Ship creature `id` under body plan `plan`: `gaits` are the clips that carry
 * the body forward and ship with a ground speed, `key` is the name the world
 * finds the extras under, `generator` the file that asked.
 */
export function shipSkinned(id, { plan, gaits, key, generator }) {
  const meta = CREATURES.find((c) => c.id === id)
  if (!meta) throw new Error(`${id} is not in the roster`)
  if (!(meta.sizeM > 0)) throw new Error(`${id}: no sizeM -- the world has no size to draw it at`)
  const map = readRigMap(id)
  if (planOf(map) !== plan) throw new Error(`${id}: body plan ${planOf(map)}, which ${generator} does not carry`)
  const clips = clipNames(plan)

  const base = readRig(id, clips[0])
  const prim = base.json.meshes[0].primitives[0]
  const frame = worldFrame(map, readAccessor(base.json, base.bin, prim.attributes.POSITION))

  // The ladder, decimated here rather than read off the bench: an NPC will not
  // have had a bench trip, and a saved tier can silently be a decimation of the
  // candidate rather than of the mesh Tripo's rigger handed back -- which is
  // exactly what the fox's was. skin-ladder.mjs carries JOINTS_0 and WEIGHTS_0
  // through; nothing else about the rig changes.
  const jointsAttr = readAccessor(base.json, base.bin, prim.attributes.JOINTS_0)
  const tiers = skinnedLadder({
    positions: readAccessor(base.json, base.bin, prim.attributes.POSITION),
    normals: readAccessor(base.json, base.bin, prim.attributes.NORMAL),
    uvs: readAccessor(base.json, base.bin, prim.attributes.TEXCOORD_0),
    indices: readAccessor(base.json, base.bin, prim.indices),
    joints: jointsAttr,
    weights: readAccessor(base.json, base.bin, prim.attributes.WEIGHTS_0),
  })
  // The tiers take the nodes below the joints, so the skeleton starts past them.
  const { nodes, index, byName, root, rootName, lifted } = skeletonNodes(base.file, base.json, frame, tiers.length)

  // The BIN, appended accessor by accessor; everything the output reads is copied
  // across, so the three 2048 px JPEGs and the bytes behind them stay behind.
  const parts = []
  let at = 0
  const bufferViews = []
  const accessors = []
  const view = (bytes) => {
    bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.length })
    parts.push(bytes)
    at += bytes.length
    const pad = (4 - (bytes.length % 4)) % 4
    if (pad) { parts.push(Buffer.alloc(pad)); at += pad }
    return bufferViews.length - 1
  }
  const accessor = (values, componentType, type, extra = {}) => {
    const items = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]
    accessors.push({ bufferView: view(Buffer.from(values.buffer, values.byteOffset, values.byteLength)), componentType, count: values.length / items, type, ...extra })
    return accessors.length - 1
  }
  /** One of the source's accessors copied across, component type and all. */
  const copy = (src, i, extra = {}) => {
    const a = src.json.accessors[i]
    return accessor(readAccessor(src.json, src.bin, i), a.componentType, a.type, extra)
  }

  const jointType = base.json.accessors[prim.attributes.JOINTS_0].componentType
  const pos = base.json.accessors[prim.attributes.POSITION]
  const meshes = tiers.map((t, k) => ({
    name: k ? `${id}-lod${k}` : id,
    primitives: [{
      attributes: {
        // The top tier's bounds are the source accessor's, which glTF wants on POSITION; a decimated tier only ever shrinks inside them.
        POSITION: accessor(Float32Array.from(t.positions), FLOAT, 'VEC3', k ? boundsOf(t.positions) : { min: pos.min, max: pos.max }),
        NORMAL: accessor(Float32Array.from(t.normals), FLOAT, 'VEC3'),
        TEXCOORD_0: accessor(Float32Array.from(t.uvs), FLOAT, 'VEC2'),
        JOINTS_0: accessor(new jointsAttr.constructor(t.joints), jointType, 'VEC4'),
        WEIGHTS_0: accessor(Float32Array.from(t.weights), FLOAT, 'VEC4'),
      },
      indices: accessor(Uint32Array.from(t.indices), UINT, 'SCALAR'),
      material: 0,
    }],
  }))
  const skins = [{
    name: `${id}-skeleton`,
    joints: base.json.skins[0].joints.map((n) => index.get(n)),
    inverseBindMatrices: copy(base, base.json.skins[0].inverseBindMatrices),
    skeleton: root,
  }]

  const animations = clips.map((name) => {
    const src = name === clips[0] ? base : readRig(id, name)
    const anim = src.json.animations[0]
    const samplers = []
    const channels = []
    const inputs = new Map()
    for (const ch of anim.channels) {
      const s = anim.samplers[ch.sampler]
      if (!inputs.has(s.input)) {
        const times = readAccessor(src.json, src.bin, s.input)
        inputs.set(s.input, accessor(times, FLOAT, 'SCALAR', { min: [times[0]], max: [times[times.length - 1]] }))
      }
      const jointName = src.json.nodes[ch.target.node].name
      const node = byName.get(jointName)
      if (node === undefined) throw new Error(`${src.file}: channel targets ${jointName}, which ${base.file} has no joint for -- the clips were built against two different rigs`)
      const out = readAccessor(src.json, src.bin, s.output)
      // The root's own motion is in the rig's old frame; every other joint's
      // rotation is relative to its parent and does not know the frame changed.
      const values = jointName !== rootName ? out
        : ch.target.path === 'translation' ? Float32Array.from(mapTriples(out, (p) => framePoint(lifted, p)))
          : ch.target.path === 'rotation' ? Float32Array.from(mapQuats(out, (q) => qmul(frameQuat(frame), q)))
            : out
      const items = ch.target.path === 'rotation' ? 4 : 3
      samplers.push({
        input: inputs.get(s.input),
        output: accessor(values, FLOAT, items === 4 ? 'VEC4' : 'VEC3'),
        interpolation: s.interpolation ?? 'LINEAR',
      })
      channels.push({ sampler: samplers.length - 1, target: { node, path: ch.target.path } })
    }
    return { name, samplers, channels }
  })

  // What the world cannot work out from the geometry: how fast the ground has to
  // run under each gait for its feet to hold. The same number build.mjs prints,
  // in the file's own units, so the world multiplies by the scale it draws at.
  const gait = {}
  for (const name of gaits) {
    const spec = tunedSpec(name, map)
    gait[name] = (spec.stride * map.wheelbase) / (spec.duty * spec.duration)
  }

  const texture = `${id}.webp`
  const texPx = shipTexPx(meta)
  packTexture(tripoColourJpeg(base.file, base.json, base.bin, 0), path.join(OUT, texture), texPx)
  const { name: matName, doubleSided } = base.json.materials[0]
  const json = {
    asset: { version: '2.0', generator },
    extensionsUsed: ['EXT_texture_webp'],
    extensionsRequired: ['EXT_texture_webp'],
    scene: 0,
    // The frame has to be shipped, not measured in the world: the correction
    // rides on the root joint, so the vertices are still on the rig's diagonal
    // and their bounding box says nothing about how the animal stands. `span`,
    // `width` and `height` are the turned body's extents, and `frame` is the
    // transform that turns the bind-pose geometry to match -- which is what the
    // world photographs its far card off.
    scenes: [{
      nodes: [...tiers.map((_, k) => k), root],
      extras: {
        [key]: {
          sizeM: meta.sizeM, wheelbase: map.wheelbase, gait,
          span: frame.span, width: frame.width, height: frame.height,
          frame: { yaw: Math.atan2(frame.s, frame.c), t: frame.t },
        },
      },
    }],
    nodes: [...meshes.map((m, k) => ({ name: `${m.name}-mesh`, mesh: k, skin: 0 })), ...nodes],
    meshes, skins, animations, accessors, bufferViews,
    buffers: [{ byteLength: at }],
    images: [{ uri: texture, mimeType: 'image/webp' }],
    textures: [{ extensions: { EXT_texture_webp: { source: 0 } } }],
    materials: [{ name: matName, doubleSided, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
  }
  fs.mkdirSync(OUT, { recursive: true })
  const out = path.join(OUT, `${id}.glb`)
  writeGlb(out, json, Buffer.concat(parts))
  const tris = tiers.map((t) => t.indices.length / 3)
  console.log(`ship ${id}.glb: ${(fs.statSync(out).size / 1024).toFixed(0)} KB, tiers ${ladderLine(tiers)} tris, ${skins[0].joints.length} joints,`
    + ` clips ${clips.join(' ')}, texture ${texPx}px ${(fs.statSync(path.join(OUT, texture)).size / 1024).toFixed(0)} KB`)
  return { out, tris, joints: skins[0].joints.length, clips, gait }
}

/** A flat [x, y, z, ...] run through `fn`, three at a time. */
function mapTriples(flat, fn) {
  const out = []
  for (let i = 0; i < flat.length; i += 3) out.push(...fn([flat[i], flat[i + 1], flat[i + 2]]))
  return out
}

/** A flat [x, y, z, w, ...] run through `fn`, four at a time. */
function mapQuats(flat, fn) {
  const out = []
  for (let i = 0; i < flat.length; i += 4) out.push(...fn([flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]))
  return out
}
