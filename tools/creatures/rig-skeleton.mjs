/**
 * Author the bone friend's skeleton by hand and bind the mesh to it.
 *
 *   node tools/creatures/rig-skeleton.mjs            writes rig-fixed.glb and rig-map.json
 *   node tools/creatures/rig-skeleton.mjs --probe    prints what it found, writes nothing
 *
 * The mesh is seventeen separate bone islands (skull, neck, ribcage, lumbar,
 * pelvis, and three pieces to each limb), so each island is bound rigidly to
 * the one joint it hangs off and the gaps between them stay gaps. Joint names
 * follow check-anim's human fixture, and the map is derived from the written
 * rig by rig-map.mjs's biped reading, not stated, so the two cannot disagree.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adjacency, loadMesh, writeRig } from './rig-spider.mjs'
import { buildRigMap } from './anim/rig-map.mjs'
import { workDir } from './workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ID = 'bone-friend'

// The mesh faces +x with its mirror plane at z = 0, so its left is -z. Joints
// sit at the gaps between islands, read off each island's principal axis; `holds`
// is the centroid of the island a joint carries, and every island must be the
// nearest to exactly one of them.
const TRUNK = [
  { name: 'Pelvis', parent: null, at: [-0.05, 0.42, 0], holds: [-0.052, 0.413, 0] },
  { name: 'Spine1', parent: 'Pelvis', at: [-0.07, 0.45, 0], holds: [-0.068, 0.485, 0] },
  { name: 'Chest', parent: 'Spine1', at: [-0.07, 0.55, 0], holds: [-0.033, 0.616, 0] },
  { name: 'Neck', parent: 'Chest', at: [-0.06, 0.69, 0], holds: [-0.043, 0.736, 0] },
  { name: 'Head', parent: 'Neck', at: [-0.03, 0.80, 0], holds: [0.039, 0.871, 0] },
  { name: 'HeadTop', parent: 'Head', at: [0, 0.99, 0] },
]

/** The right side (+z); the left is its mirror. The knee sits 1.5 cm ahead of the hip-ankle line so it has a hinge to keep. */
const LIMBS = [
  { name: 'Hip', parent: 'Pelvis', at: [-0.035, 0.39, 0.078], holds: [-0.039, 0.299, 0.082] },
  { name: 'Knee', parent: 'Hip', at: [-0.04, 0.218, 0.092], holds: [-0.063, 0.129, 0.092] },
  { name: 'Ankle', parent: 'Knee', at: [-0.07, 0.05, 0.092], holds: [-0.001, 0.018, 0.122] },
  { name: 'Toe', parent: 'Ankle', at: [0.06, 0.015, 0.13] },
  { name: 'Clavicle', parent: 'Chest', at: [-0.06, 0.66, 0.04] },
  { name: 'Shoulder', parent: 'Clavicle', at: [-0.05, 0.672, 0.125], holds: [-0.059, 0.608, 0.144] },
  { name: 'Elbow', parent: 'Shoulder', at: [-0.073, 0.524, 0.172], holds: [-0.035, 0.447, 0.197] },
  { name: 'Wrist', parent: 'Elbow', at: [0.008, 0.392, 0.207], holds: [0.017, 0.326, 0.219] },
  { name: 'Hand', parent: 'Wrist', at: [-0.015, 0.277, 0.224] },
]

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const mean = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)

function buildJoints() {
  const side = (s, mirror) => LIMBS.map((j) => ({
    name: `${j.name}.${s}`,
    parent: TRUNK.some((t) => t.name === j.parent) ? j.parent : `${j.parent}.${s}`,
    at: mirror ? [j.at[0], j.at[1], -j.at[2]] : j.at.slice(),
    ...(j.holds ? { holds: mirror ? [j.holds[0], j.holds[1], -j.holds[2]] : j.holds.slice() } : {}),
  }))
  const joints = [...TRUNK.map((j) => ({ ...j })), ...side('L', true), ...side('R', false)]
  for (const j of joints) j.children = joints.filter((c) => c.parent === j.name)
  return joints
}

function islands({ adj, unique }) {
  const seen = new Set(), out = []
  for (const s of unique) {
    if (seen.has(s)) continue
    const comp = [], stack = [s]
    seen.add(s)
    while (stack.length) {
      const v = stack.pop()
      comp.push(v)
      for (const n of adj.get(v) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n) }
    }
    out.push(comp)
  }
  return out
}

/** Each island rigidly to the carrier whose `holds` is nearest its centroid; one island a carrier, within 2 cm. */
function bind(V, joints, graph) {
  const comps = islands(graph)
  const carriers = joints.filter((j) => j.holds)
  if (comps.length !== carriers.length) throw new Error(`mesh has ${comps.length} islands, the rig carries ${carriers.length}`)
  const owner = new Map()
  const claimed = new Map()
  for (const comp of comps) {
    const c = mean(comp.map((v) => V[v]))
    const best = carriers.reduce((a, b) => (dist(c, a.holds) < dist(c, b.holds) ? a : b))
    if (dist(c, best.holds) > 0.02) throw new Error(`island at ${c.map((x) => x.toFixed(3))} is ${dist(c, best.holds).toFixed(3)} m from ${best.name}, the nearest carrier`)
    if (claimed.has(best.name)) throw new Error(`${best.name} claims two islands`)
    claimed.set(best.name, c)
    for (const v of comp) owner.set(v, joints.indexOf(best))
  }
  const J = new Uint8Array(V.length * 4), Wt = new Float32Array(V.length * 4)
  for (let v = 0; v < V.length; v++) {
    const j = owner.get(graph.rep[v])
    if (j === undefined) throw new Error(`vertex ${v} is in no island`)
    J[v * 4] = j
    Wt[v * 4] = 1
  }
  return { J, Wt, claimed }
}

export function rigSkeleton({ write = true } = {}) {
  const dir = workDir(ID)
  const mesh = loadMesh(path.join(dir, 'mesh.glb'))
  const joints = buildJoints()
  const skin = bind(mesh.V, joints, adjacency(mesh.V, mesh.I))
  const rigFile = path.join(dir, write ? 'rig-fixed.glb' : 'rig-probe.glb')
  writeRig(rigFile, mesh, joints, skin, ID)
  const map = buildRigMap(rigFile)
  if (write) fs.writeFileSync(path.join(dir, 'rig-map.json'), JSON.stringify(map, null, 2))
  else fs.rmSync(rigFile)
  return { joints, map, claimed: skin.claimed, vertices: mesh.V.length }
}

function main() {
  const probe = process.argv.includes('--probe')
  const { joints, map, claimed, vertices } = rigSkeleton({ write: !probe })
  console.log(`${ID}: ${vertices} vertices, ${joints.length} joints, ${claimed.size} islands bound`)
  console.log(`  ground ${map.ground}  height ${map.height}  hips ${map.wheelbase}  forward ${map.frame.yawDegrees} deg`)
  console.log(`  spine ${map.spine.join(' ')}  head ${map.head.join(' ')}`)
  for (const l of map.legs) console.log(`  ${l.id} ${l.chain.join(' ')} toe ${l.toe}`)
  for (const a of map.arms) console.log(`  ${a.id} ${a.chain.join(' ')}  S ${a.shoulder} E ${a.elbow} W ${a.wrist}`)
  if (probe) console.log('\n(nothing written; drop --probe to write rig-fixed.glb and rig-map.json)')
  else console.log(`\nwrote ${path.relative(ROOT, path.join(workDir(ID), 'rig-fixed.glb'))} and rig-map.json`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
