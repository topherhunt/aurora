/**
 * Author the moor stag's skeleton by eye and bind the mesh to it.
 *
 *   node tools/creatures/rig-stag.mjs            writes rig-fixed.glb and rig-map.json
 *   node tools/creatures/rig-stag.mjs --probe    prints what it found, writes nothing
 *
 * Every joint is STATED, read off orthographic renders as rig-strider.mjs does,
 * at the real elbow, carpus, stifle and hock. Each leg is three bones in one
 * vertical plane (one x), so the IK's hinge is a clean lateral axis; the hoof
 * rides rigid on the cannon.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMesh, skinWeights, writeRig } from './rig-spider.mjs'
import { workDir } from './workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ID = 'moor-stag'

// --- what is stated ---------------------------------------------------------

/** Turns the mesh about +y, then shifts it in x, so its mirror plane is x=0 and the muzzle points -z. */
const YAW_DEGREES = 130.3
const SHIFT_X = 0.0062

/** Body joints, root first. `tip` ends a bone whose joint has several children. */
const BODY = [
  { name: 'Hips', parent: null, at: [0, 0.5, 0.3], tip: [0, 0.51, 0.12] },
  { name: 'Spine', parent: 'Hips', at: [0, 0.51, 0.12] },
  { name: 'Chest', parent: 'Spine', at: [0, 0.52, -0.04], tip: [0, 0.5, -0.14] },
  { name: 'Neck', parent: 'Chest', at: [0, 0.5, -0.14] },
  { name: 'Neck1', parent: 'Neck', at: [0, 0.61, -0.225] },
  { name: 'Head', parent: 'Neck1', at: [0, 0.72, -0.28], tip: [0, 0.66, -0.41] },
  { name: 'Tail', parent: 'Hips', at: [0, 0.54, 0.41] },
  { name: 'Tail1', parent: 'Tail', at: [0, 0.46, 0.42], tip: [0, 0.34, 0.42] },
]

/**
 * Each leg top to hoof, stated one by one: the mesh stands mid-stride, so no leg
 * mirrors another. The elbow and hock point back, the stifle and carpus forward.
 */
const LEGS = [
  { id: 'frontLeft', tag: 'FL', attach: 'Chest', parts: ['Shoulder', 'Elbow', 'Carpus', 'Foot'], x: -0.045, yz: [[0.46, -0.17], [0.37, -0.105], [0.22, -0.162], [0.025, -0.205]] },
  { id: 'frontRight', tag: 'FR', attach: 'Chest', parts: ['Shoulder', 'Elbow', 'Carpus', 'Foot'], x: 0.072, yz: [[0.46, -0.15], [0.37, -0.072], [0.22, -0.108], [0.025, -0.125]] },
  { id: 'hindLeft', tag: 'HL', attach: 'Hips', parts: ['Hip', 'Stifle', 'Hock', 'Foot'], x: -0.088, yz: [[0.49, 0.32], [0.36, 0.235], [0.255, 0.35], [0.025, 0.325]] },
  { id: 'hindRight', tag: 'HR', attach: 'Hips', parts: ['Hip', 'Stifle', 'Hock', 'Foot'], x: 0.075, yz: [[0.49, 0.35], [0.36, 0.27], [0.255, 0.385], [0.025, 0.365]] },
]

/** How readily each carpus takes an IK turn (gait.mjs `limbSetup`): the elbow lowers the chest, the carpus only lifts the hoof. */
const CARPUS_GIVE = 0.15

/**
 * Where a vertex stops being body: a height fade from LEG_FULL up to the leg's
 * `top`, times nearness to its nearest leg's bones -- LOW_REACH below LEG_FULL,
 * where the leg is thick, LEG_REACH above -- so the belly, the sheath and the
 * brisket between the legs stay on the spine.
 */
const LEG_FULL = 0.33, LEG_TOP = { front: 0.42, hind: 0.47 }
const LEG_REACH = 0.045, LOW_REACH = 0.08, FADE = 0.025

/** The skull and antlers ride on Head alone: above ANTLER_Y, or in front of the plane through HEAD_CUT. */
const ANTLER_Y = 0.74
const HEAD_CUT = { at: [0, 0.68, -0.22], normal: [0, 0.447, -0.894] }
const HEAD_FADE = 0.03

// --- the skeleton -----------------------------------------------------------

const mean = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)
const r6 = (v) => Math.round(v * 1e6) / 1e6
const legJoint = (leg, i) => `${leg.parts[i]}.${leg.tag}`
const legAt = (leg, i) => [leg.x, ...leg.yz[i]]

function buildJoints() {
  const joints = BODY.map((j) => ({ ...j, group: 'body' }))
  for (const leg of LEGS) {
    leg.parts.forEach((_, i) => joints.push({
      name: legJoint(leg, i),
      parent: i === 0 ? leg.attach : legJoint(leg, i - 1),
      at: legAt(leg, i),
      group: `leg.${leg.tag}`,
    }))
  }
  for (const j of joints) {
    j.children = joints.filter((c) => c.parent === j.name)
    j.boneTo = j.tip ?? (j.children.length === 1 ? j.children[0].at : null)
  }
  return joints
}

// --- the skin ---------------------------------------------------------------

const smooth = (u) => { const c = Math.min(1, Math.max(0, u)); return c * c * (3 - 2 * c) }
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Distance from p to the segment a-b. */
function toSegment(p, a, b) {
  const ab = sub3(b, a), t = Math.min(1, Math.max(0, dot3(sub3(p, a), ab) / dot3(ab, ab)))
  return Math.hypot(...sub3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]))
}

const toLeg = (p, leg) => Math.min(...[0, 1, 2].map((i) => toSegment(p, legAt(leg, i), legAt(leg, i + 1))))
const TAIL_PATH = ['Tail', 'Tail1'].map((n) => BODY.find((j) => j.name === n).at).concat([BODY.at(-1).tip])
const toTail = (p) => Math.min(toSegment(p, TAIL_PATH[0], TAIL_PATH[1]), toSegment(p, TAIL_PATH[1], TAIL_PATH[2]))

/** [limb group, share] for one vertex: which leg is nearest, and how much of the vertex it may move. The hooked tail tip hangs within reach of the hocks, so a vertex nearer the tail is never leg. */
function legShare(p) {
  const [leg, d] = LEGS.map((l) => [l, toLeg(p, l)]).sort((a, b) => a[1] - b[1])[0]
  if (toTail(p) < d) return [`leg.${leg.tag}`, 0]
  if (p[1] < LEG_FULL) return [`leg.${leg.tag}`, smooth((LOW_REACH + FADE - d) / FADE)]
  const top = LEG_TOP[leg.attach === 'Chest' ? 'front' : 'hind']
  return [`leg.${leg.tag}`, smooth((top - p[1]) / (top - LEG_FULL)) * smooth((LEG_REACH + FADE - d) / FADE)]
}

const headShare = (p) => Math.max(
  smooth((p[1] - ANTLER_Y) / HEAD_FADE + 0.5),
  smooth(dot3(sub3(p, HEAD_CUT.at), HEAD_CUT.normal) / HEAD_FADE + 0.5))

function skin(V, joints) {
  const shares = V.map(legShare)
  const head = joints.findIndex((j) => j.name === 'Head')
  const body = skinWeights(V, joints, () => 'body')
  const limb = skinWeights(V, joints, (v) => (shares[v][1] > 0 ? shares[v][0] : 'body'))
  const J = new Uint8Array(V.length * 4)
  const Wt = new Float32Array(V.length * 4)
  for (let v = 0; v < V.length; v++) {
    const w = shares[v][1], h = w > 0 ? 0 : headShare(V[v])
    const mix = new Map([[head, h]])
    for (let k = 0; k < 4; k++) {
      mix.set(body.J[v * 4 + k], (mix.get(body.J[v * 4 + k]) ?? 0) + body.Wt[v * 4 + k] * (1 - w) * (1 - h))
      mix.set(limb.J[v * 4 + k], (mix.get(limb.J[v * 4 + k]) ?? 0) + limb.Wt[v * 4 + k] * w)
    }
    const top = [...mix].filter(([, x]) => x > 0.005).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = top.reduce((s, [, x]) => s + x, 0)
    top.forEach(([j, x], k) => { J[v * 4 + k] = j; Wt[v * 4 + k] = x / total })
  }
  return { J, Wt, shares }
}

// --- the rig map ------------------------------------------------------------

function buildMap(joints, existing) {
  const ys = joints.map((j) => j.at[1])
  const ground = Math.min(...ys), height = Math.max(...ys) - ground
  const centre = mean(joints.map((j) => j.at))
  const legs = LEGS.map((leg) => {
    const foot = legAt(leg, 3)
    return {
      id: leg.id,
      foot: legJoint(leg, 3),
      chain: leg.parts.map((_, i) => legJoint(leg, i)),
      attach: leg.attach,
      ...(leg.attach === 'Chest' ? { give: { [legJoint(leg, 2)]: CARPUS_GIVE } } : {}),
      restFoot: foot.map(r6),
      station: { fore: r6(-(foot[2] - centre[2])), lat: r6(-(foot[0] - centre[0])) },
    }
  })
  const fore = legs.map((l) => l.station.fore)
  return {
    source: 'rig-fixed.glb',
    note: 'Authored by tools/creatures/rig-stag.mjs from mesh.glb, not detected. Re-run that tool to rebuild the rig and this map together.',
    frame: { forward: [0, 0, -1], lateral: [-1, 0, 0], centre: centre.map(r6), yawDegrees: -90 },
    ground: r6(ground),
    height: r6(height),
    wheelbase: r6(Math.max(...fore) - Math.min(...fore)),
    spine: ['Hips', 'Spine', 'Chest'],
    // Head stays out of the pitch chain: bend() hands the tip the full angle, and on this short neck a three-joint chain folds the muzzle under the chest before it reaches grass.
    head: ['Neck', 'Neck1'],
    tail: ['Tail', 'Tail1'],
    legs,
    unclaimed: [],
    ...(existing?.tweakNote ? { tweakNote: existing.tweakNote } : {}),
    ...(existing?.clipTweaks ? { clipTweaks: existing.clipTweaks } : {}),
  }
}

// --- main -------------------------------------------------------------------

export function rigStag({ write = true } = {}) {
  const dir = workDir(ID)
  const mesh = loadMesh(path.join(dir, 'mesh.glb'))
  const c = Math.cos((YAW_DEGREES * Math.PI) / 180), s = Math.sin((YAW_DEGREES * Math.PI) / 180)
  for (const arr of [mesh.V, mesh.N]) {
    for (const p of arr) [p[0], p[2]] = [p[0] * c + p[2] * s, -p[0] * s + p[2] * c]
  }
  for (const p of mesh.V) p[0] += SHIFT_X
  const joints = buildJoints()
  const weights = skin(mesh.V, joints)
  const mapFile = path.join(dir, 'rig-map.json')
  const existing = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : null
  const map = buildMap(joints, existing)
  if (write) {
    writeRig(path.join(dir, 'rig-fixed.glb'), mesh, joints, weights, ID)
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2))
  }
  return { joints, map, skin: weights, vertices: mesh.V.length }
}

function main() {
  const probe = process.argv.includes('--probe')
  const { joints, map, skin: { shares }, vertices } = rigStag({ write: !probe })
  const tally = new Map()
  for (const [g, w] of shares) if (w > 0) tally.set(g, (tally.get(g) ?? 0) + 1)
  console.log(`${ID}: ${vertices} vertices, ${joints.length} joints`)
  console.log(`  leg-weighted vertices ${[...tally].map(([g, n]) => `${g}:${n}`).join(' ')}`)
  console.log(`  ground ${map.ground}  height ${map.height}  wheelbase ${map.wheelbase}`)
  if (probe) console.log('\n(nothing written; drop --probe to write rig-fixed.glb and rig-map.json)')
  else console.log(`\nwrote ${path.relative(ROOT, path.join(workDir(ID), 'rig-fixed.glb'))} and rig-map.json`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
