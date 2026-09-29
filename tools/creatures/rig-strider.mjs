/**
 * Author the frost strider's skeleton by eye and bind the mesh to it.
 *
 *   node tools/creatures/rig-strider.mjs            writes rig-fixed.glb and rig-map.json
 *   node tools/creatures/rig-strider.mjs --probe    prints what it found, writes nothing
 *
 * Every joint is STATED, read off orthographic renders as rig-hob.mjs does. The
 * legs, wings and body are one welded island, so skinning is by REGION instead:
 * each vertex is scored for how much it is leg or wing, and only that share may
 * follow the limb's bones. The flank above the drumstick never follows the femur,
 * which is what keeps a swinging leg from dragging the body through itself.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAccessor, writeAccessor } from './apply-rig-edit.mjs'
import { paintOutTack } from './paint-tack.mjs'
import { adjacency, loadMesh, skinWeights, writeRig } from './rig-spider.mjs'
import { tripoColourJpeg } from '../tripo-pack.mjs'
import { workDir } from './workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ID = 'frost-strider'

// --- what is stated ---------------------------------------------------------

/** Turns the mesh about +y so its mirror plane is x=0 and the beak points -z. */
const YAW_DEGREES = 163.3

/** Body joints, root first. `tip` ends a bone whose joint has several children. */
const BODY = [
  { name: 'Hips', parent: null, at: [0, 0.4, 0.06], tip: [0, 0.39, -0.12] },
  { name: 'Chest', parent: 'Hips', at: [0, 0.39, -0.12], tip: [0, 0.4, -0.22] },
  { name: 'Neck', parent: 'Chest', at: [0, 0.4, -0.22] },
  { name: 'Neck1', parent: 'Neck', at: [0, 0.5, -0.29] },
  { name: 'Head', parent: 'Neck1', at: [0, 0.62, -0.35], tip: [0, 0.58, -0.49] },
  { name: 'Tail', parent: 'Hips', at: [0, 0.41, 0.27] },
  { name: 'Tail1', parent: 'Tail', at: [0, 0.4, 0.38], tip: [0, 0.39, 0.5] },
]

/** The right leg, hip to toe tip; the left is its mirror in x. The hock bends backward. */
const LEG = { hip: [0.09, 0.37, 0.05], knee: [0.11, 0.29, -0.04], ankle: [0.105, 0.175, 0.045], foot: [0.11, 0.035, 0], toe: [0.12, 0.01, -0.1] }
const LEG_JOINTS = ['Hip', 'Knee', 'Ankle', 'Foot', 'Toe']

/** The right wing down its centreline, shoulder to tip, held out and drooping; the left is its mirror. */
const WING = { wing: [0.11, 0.44, -0.13], wing1: [0.18, 0.428, -0.137], wing2: [0.25, 0.378, -0.14], tip: [0.33, 0.335, -0.072] }
const WING_JOINTS = ['Wing', 'Wing1', 'Wing2']

/**
 * Where a vertex stops being body. Legs: below LEG_TOP fading to fully leg by
 * LEG_FULL, on the leg's side of the midline, inside the drumstick's fore-aft
 * span -- which keeps the chest and the underside of the tail out. Wings: within
 * WING_REACH of the wing's bones and past WING_ROOT out from the shoulder. Gating
 * by |x| alone takes in the flank and the tail fan, which reach as wide as the
 * drooping wing does.
 */
const LEG_TOP = 0.34, LEG_FULL = 0.26, LEG_Z = [-0.07, 0.1]
const WING_REACH = 0.06, WING_ROOT = 0.015
const FADE = 0.03

/** Tack reaching forward of this z is the halter and reins, whose baked print on the face stays: paint-tack.mjs clears the rest. */
const HEAD_Z = -0.3

/** The body plan whose clip library drives this rig: anim/clips/bird. */
const PLAN = 'bird'

// --- the skeleton -----------------------------------------------------------

const mean = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)
const r6 = (v) => Math.round(v * 1e6) / 1e6
const mirror = (p, side) => (side === 'L' ? [-p[0], p[1], p[2]] : p.slice())

function buildJoints() {
  const joints = BODY.map((j) => ({ ...j, group: 'body' }))
  for (const side of ['L', 'R']) {
    LEG_JOINTS.forEach((part, i) => joints.push({
      name: `${part}.${side}`,
      parent: i === 0 ? 'Hips' : `${LEG_JOINTS[i - 1]}.${side}`,
      at: mirror(LEG[part.toLowerCase()], side),
      group: `leg.${side}`,
    }))
    WING_JOINTS.forEach((part, i) => joints.push({
      name: `${part}.${side}`,
      parent: i === 0 ? 'Chest' : `${WING_JOINTS[i - 1]}.${side}`,
      at: mirror(WING[part.toLowerCase()], side),
      ...(i === WING_JOINTS.length - 1 ? { tip: mirror(WING.tip, side) } : {}),
      group: `wing.${side}`,
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
const inside = (v, [lo, hi]) => smooth(1 - Math.max(lo - v, v - hi, 0) / FADE)
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Distance from p to the segment a-b. */
function toSegment(p, a, b) {
  const ab = sub3(b, a), t = Math.min(1, Math.max(0, dot3(sub3(p, a), ab) / dot3(ab, ab)))
  return Math.hypot(...sub3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]))
}

const WING_PATH = [WING.wing, WING.wing1, WING.wing2, WING.tip]
const WING_OUT = (() => { const d = sub3(WING.wing1, WING.wing); const n = Math.hypot(...d); return d.map((c) => c / n) })()

/** How much of a right-side point is wing: near the chain, and out past the shoulder. */
function wingShare(p) {
  const near = Math.min(...WING_PATH.slice(1).map((b, i) => toSegment(p, WING_PATH[i], b)))
  return smooth((WING_REACH + FADE - near) / FADE) * smooth((dot3(sub3(p, WING.wing), WING_OUT) + WING_ROOT) / FADE)
}

/** Welded islands as lists of first-indices, biggest first: the bird, then each piece of tack. */
function islands(I, { adj, unique, rep }) {
  const of = new Map()
  const comps = []
  for (const s of unique) {
    if (of.has(s)) continue
    const stack = [s], size = [0]
    of.set(s, comps.length)
    while (stack.length) {
      size[0]++
      for (const n of adj.get(stack.pop()) ?? []) if (!of.has(n)) { of.set(n, comps.length); stack.push(n) }
    }
    comps.push({ size: size[0], tris: [] })
  }
  for (let t = 0; t < I.length; t += 3) comps[of.get(rep[I[t]])].tris.push(t)
  return comps.sort((a, b) => b.size - a.size).map((c) => c.tris)
}

/** [limb group, share] for one vertex: how much of it a leg or wing on its side may move. */
function limbShare([x, y, z], onBird) {
  if (!onBird) return ['body', 0]
  const side = x < 0 ? 'L' : 'R', ax = Math.abs(x)
  const leg = smooth((LEG_TOP - y) / (LEG_TOP - LEG_FULL)) * smooth((ax - 0.025) / FADE) * (y < 0.2 ? 1 : inside(z, LEG_Z))
  // The drooping wingtips dip under LEG_TOP inside the leg's span, so the larger share wins, not the first.
  const wing = wingShare([ax, y, z])
  return leg > wing ? [`leg.${side}`, leg] : [`wing.${side}`, wing]
}

function skin(V, joints, onBird) {
  const shares = V.map((p, v) => limbShare(p, onBird(v)))
  const body = skinWeights(V, joints, () => 'body')
  const limb = skinWeights(V, joints, (v) => (shares[v][1] > 0 ? shares[v][0] : 'body'))
  const J = new Uint8Array(V.length * 4)
  const Wt = new Float32Array(V.length * 4)
  for (let v = 0; v < V.length; v++) {
    const w = shares[v][1]
    const mix = new Map()
    for (let k = 0; k < 4; k++) {
      mix.set(body.J[v * 4 + k], (mix.get(body.J[v * 4 + k]) ?? 0) + body.Wt[v * 4 + k] * (1 - w))
      mix.set(limb.J[v * 4 + k], (mix.get(limb.J[v * 4 + k]) ?? 0) + limb.Wt[v * 4 + k] * w)
    }
    const top = [...mix].filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = top.reduce((s, [, x]) => s + x, 0)
    top.forEach(([j, x], k) => { J[v * 4 + k] = j; Wt[v * 4 + k] = x / total })
  }
  return { J, Wt, shares }
}

// --- the rig map ------------------------------------------------------------

function buildMap(joints, existing, tackFrom) {
  const ys = joints.map((j) => j.at[1])
  const ground = Math.min(...ys), height = Math.max(...ys) - ground
  const centre = mean(joints.map((j) => j.at))
  const legs = ['L', 'R'].map((side) => {
    const foot = mirror(LEG.foot, side)
    return {
      id: side === 'L' ? 'hindLeft' : 'hindRight',
      foot: `Foot.${side}`,
      chain: ['Hip', 'Knee', 'Ankle', 'Foot'].map((p) => `${p}.${side}`),
      toe: `Toe.${side}`,
      attach: 'Hips',
      restFoot: foot.map(r6),
      station: { fore: r6(-(foot[2] - centre[2])), lat: r6(-(foot[0] - centre[0])) },
    }
  })
  return {
    source: 'rig-fixed.glb',
    note: 'Authored by tools/creatures/rig-strider.mjs from mesh.glb, not detected. Re-run that tool to rebuild the rig and this map together.',
    plan: PLAN,
    frame: { forward: [0, 0, -1], lateral: [-1, 0, 0], centre: centre.map(r6), yawDegrees: -90 },
    ground: r6(ground),
    height: r6(height),
    // A biped's feet share one station, so its stride is scaled by leg length instead.
    wheelbase: r6(LEG.hip[1] - LEG.foot[1]),
    spine: ['Hips', 'Chest'],
    head: ['Neck', 'Neck1', 'Head'],
    tail: ['Tail', 'Tail1'],
    legs,
    wings: ['L', 'R'].map((side) => ({ id: side === 'L' ? 'wingLeft' : 'wingRight', side: side === 'L' ? 1 : -1, chain: WING_JOINTS.map((p) => `${p}.${side}`) })),
    unclaimed: [],
    // Indices from here on draw the tack; a wild strider draws only those before it.
    tackFrom,
    ...(existing?.clipTweaks ? { clipTweaks: existing.clipTweaks } : {}),
  }
}

// --- main -------------------------------------------------------------------

export function rigStrider({ write = true } = {}) {
  const dir = workDir(ID)
  const mesh = loadMesh(path.join(dir, 'mesh.glb'))
  const c = Math.cos((YAW_DEGREES * Math.PI) / 180), s = Math.sin((YAW_DEGREES * Math.PI) / 180)
  for (const arr of [mesh.V, mesh.N]) {
    for (const p of arr) [p[0], p[2]] = [p[0] * c + p[2] * s, -p[0] * s + p[2] * c]
  }
  const joints = buildJoints()
  const [bird, ...tack] = islands(mesh.I, adjacency(mesh.V, mesh.I))
  const birdVerts = new Set(bird.flatMap((t) => [mesh.I[t], mesh.I[t + 1], mesh.I[t + 2]]))
  const weights = skin(mesh.V, joints, (v) => birdVerts.has(v))

  const mapFile = path.join(dir, 'rig-map.json')
  const existing = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : null
  const map = buildMap(joints, existing, bird.length * 3)
  if (write) {
    // Bird first, tack after, so one draw range drops the tack.
    const order = Uint32Array.from([bird, ...tack].flat().flatMap((t) => [mesh.I[t], mesh.I[t + 1], mesh.I[t + 2]]))
    writeAccessor(mesh.json, mesh.bin, mesh.prim.indices, order)
    const clearOfHead = tack.filter((isl) => isl.every((t) => [0, 1, 2].every((k) => mesh.V[mesh.I[t + k]][2] > HEAD_Z)))
    const { jpeg } = paintOutTack({
      V: mesh.V, I: mesh.I, UV: readAccessor(mesh.json, mesh.bin, mesh.prim.attributes.TEXCOORD_0),
      body: bird, tack: clearOfHead, headZ: HEAD_Z, jpeg: tripoColourJpeg(ID, mesh.json, mesh.bin, 0),
    })
    // The tack-printed map stays behind as unreferenced bytes, as apply-rig-edit's appendData leaves its arrays.
    const colour = mesh.json.images[mesh.json.textures[mesh.json.materials[0].pbrMetallicRoughness.baseColorTexture.index].source]
    const pad = (4 - (mesh.bin.length % 4)) % 4
    mesh.json.bufferViews.push({ buffer: 0, byteOffset: mesh.bin.length + pad, byteLength: jpeg.length })
    colour.bufferView = mesh.json.bufferViews.length - 1
    mesh.bin = Buffer.concat([mesh.bin, Buffer.alloc(pad), jpeg])
    writeRig(path.join(dir, 'rig-fixed.glb'), mesh, joints, weights, ID)
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2))
  }
  return { joints, map, skin: weights, vertices: mesh.V.length, mesh }
}

function main() {
  const probe = process.argv.includes('--probe')
  const { joints, map, skin: { shares }, vertices } = rigStrider({ write: !probe })
  const tally = new Map()
  for (const [g, w] of shares) if (w > 0) tally.set(g, (tally.get(g) ?? 0) + 1)
  console.log(`${ID}: ${vertices} vertices, ${joints.length} joints`)
  console.log(`  limb-weighted vertices ${[...tally].map(([g, n]) => `${g}:${n}`).join(' ')}`)
  console.log(`  ground ${map.ground}  height ${map.height}  wheelbase ${map.wheelbase}`)
  if (probe) console.log('\n(nothing written; drop --probe to write rig-fixed.glb and rig-map.json)')
  else console.log(`\nwrote ${path.relative(ROOT, path.join(workDir(ID), 'rig-fixed.glb'))} and rig-map.json`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
