// A shipped prop's ladder read off public/gen-props/ in node, in the frame
// src/v2/render/gen-props.js's loadGenProp puts it in in the browser: the pick
// centred over its feet at y = 0, every tier moved by the pick's own move, the
// long axis turned onto Z on request. The GLBs are tools/props/gen/ship.mjs's,
// so the one mesh node is under the identity and its accessors are plain
// float32 arrays. The colour map is a stub -- a gate builds materials it never
// draws through.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { readAccessor } from '../../tools/creatures/apply-rig-edit.mjs'
import { readGlbChunks } from '../../tools/tripo-pack.mjs'
import { GEN_PROP_LODS, ladderBounds, ladderGeometries } from '../../src/v2/render/gen-props.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const GEN_PROPS_DIR = path.join(ROOT, 'public/gen-props')

/** One shipped GLB as loadCritterGlb's asset: plain arrays in the pick's frame, `origin` the move it was given or made. */
export function readShippedAsset(file, { origin = null } = {}) {
  const { json, bin } = readGlbChunks(file)
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error(`${file}: expected one mesh with one primitive`)
  const node = json.nodes.find((n) => n.mesh !== undefined)
  if (!node.matrix || node.matrix.some((m, i) => m !== (i % 5 === 0 ? 1 : 0))) throw new Error(`${file}: the mesh node is not under the identity`)
  const prim = json.meshes[0].primitives[0]
  if (prim.indices === undefined) throw new Error(`${file}: mesh is not indexed`)
  const pos = readAccessor(json, bin, prim.attributes.POSITION)
  const nrm = readAccessor(json, bin, prim.attributes.NORMAL)
  const uv = readAccessor(json, bin, prim.attributes.TEXCOORD_0)
  const idx = Array.from(readAccessor(json, bin, prim.indices))
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < lo[k]) lo[k] = pos[i + k]
      if (pos[i + k] > hi[k]) hi[k] = pos[i + k]
    }
  }
  const move = origin ?? [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2]
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] += move[k]
  return { pos, nrm, uv, idx, map: new THREE.Texture(), origin: move }
}

/** loadGenProp's answer for the prop `id`, off the files on disk: `{ geometries, map, bounds }`. */
export function readShippedLadder(id, { longAxisZ = false } = {}) {
  const pick = readShippedAsset(path.join(GEN_PROPS_DIR, `${id}.glb`))
  const lods = Array.from({ length: GEN_PROP_LODS }, (_, k) =>
    readShippedAsset(path.join(GEN_PROPS_DIR, `${id}-lod${k + 1}.glb`), { origin: pick.origin }))
  const geometries = ladderGeometries([pick, ...lods], { longAxisZ })
  return { geometries, map: pick.map, bounds: ladderBounds(geometries[0]) }
}
