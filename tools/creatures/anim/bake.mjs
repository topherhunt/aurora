/**
 * Write per-joint rotation tracks into a copy of a rig as `animations[0]`.
 *
 * The bench plays `gltf.animations[0]` and nothing else, so one clip per file is
 * the contract, matching the `anim-<name>.glb` files Tripo's retargeter writes.
 *
 * Limbs get rotation channels only, and the body's rise and fall goes on the
 * root joint as translation. That split is about retargeting, not legality: a
 * rotation transfers to a skeleton of different proportions unchanged, while a
 * translation is in the source creature's units and would put a stag's stride
 * on a fox. The root is the one joint whose translation has to survive, because
 * nothing else can lift the whole animal.
 */

import fs from 'node:fs'
import { readGlb, writeGlb } from '../apply-rig-edit.mjs'

const FLOAT = 5126

/** Park bytes at the end of the BIN chunk, 4-byte aligned, as a new bufferView. */
function appender(json, bin) {
  const parts = [bin]
  let at = bin.length
  return {
    view(bytes) {
      const pad = (4 - (at % 4)) % 4
      if (pad) { parts.push(Buffer.alloc(pad)); at += pad }
      json.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.length })
      parts.push(bytes)
      at += bytes.length
      return json.bufferViews.length - 1
    },
    finish() {
      const out = Buffer.concat(parts)
      json.buffers[0].byteLength = out.length
      return out
    },
  }
}

const f32 = (values) => Buffer.from(new Float32Array(values).buffer)

/**
 * @param source  path to the rig GLB the clip drives
 * @param out     path to write
 * @param name    clip name
 * @param times   sample times in seconds, ascending
 * @param tracks  Map of node index -> flat [x,y,z,w, x,y,z,w, ...], one quaternion per time
 * @param root    optional node index to carry translation, for body rise and fall
 * @param rootTranslations  flat [x,y,z, ...], one per time, when `root` is given
 */
export function bakeClip({ source, out, name, times, tracks, root = null, rootTranslations = null }) {
  const { json, bin } = readGlb(source)
  if (!bin) throw new Error(`${source} has no BIN chunk`)
  if (!times.length) throw new Error('a clip needs at least one sample time')
  for (const [node, q] of tracks) {
    if (q.length !== times.length * 4) {
      throw new Error(`track for node ${node} has ${q.length / 4} quaternions for ${times.length} times`)
    }
  }

  const app = appender(json, bin)
  json.accessors ??= []
  json.bufferViews ??= []

  // glTF requires min/max on an animation input accessor; three.js reads the
  // sampler's duration from it, and a missing max makes the clip zero-length.
  const timeView = app.view(f32(times))
  json.accessors.push({
    bufferView: timeView, componentType: FLOAT, count: times.length, type: 'SCALAR',
    min: [times[0]], max: [times[times.length - 1]],
  })
  const timeAccessor = json.accessors.length - 1

  const samplers = []
  const channels = []
  const addChannel = (node, path, values, items) => {
    json.accessors.push({
      bufferView: app.view(f32(values)), componentType: FLOAT,
      count: times.length, type: items === 4 ? 'VEC4' : 'VEC3',
    })
    samplers.push({ input: timeAccessor, output: json.accessors.length - 1, interpolation: 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node, path } })
  }

  for (const [node, q] of tracks) addChannel(node, 'rotation', q, 4)
  if (root !== null && rootTranslations) {
    if (rootTranslations.length !== times.length * 3) {
      throw new Error(`root translation has ${rootTranslations.length / 3} samples for ${times.length} times`)
    }
    addChannel(root, 'translation', rootTranslations, 3)
  }

  json.animations = [{ name, samplers, channels }]
  writeGlb(out, json, app.finish())
  return { out, name, channels: channels.length, duration: times[times.length - 1], samples: times.length }
}

/** Read back what a baked clip contains, for gates and probes. */
export function readClip(file) {
  const { json } = readGlb(file)
  const anim = json.animations?.[0]
  if (!anim) throw new Error(`${file} carries no animation`)
  return {
    name: anim.name,
    channels: anim.channels.length,
    targets: anim.channels.map((c) => json.nodes[c.target.node].name ?? `node${c.target.node}`),
    paths: anim.channels.map((c) => c.target.path),
    duration: json.accessors[anim.samplers[0].input].max[0],
  }
}

export { readGlb, writeGlb, fs }
