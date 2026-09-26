/**
 * Author the hob weevil's skeleton by eye and bind the mesh to it.
 *
 *   node tools/creatures/rig-hob.mjs            writes rig-fixed.glb and rig-map.json
 *   node tools/creatures/rig-hob.mjs --probe    prints what it found, writes nothing
 *
 * Tripo's hexapod rig for this mesh is unusable, so every joint here is STATED,
 * read off orthographic renders of the mesh: one thorax, one head, and each leg
 * jointed where it visibly bends -- hip, knee at the peak of the femur, ankle
 * where the tibia meets the ground, foot at the claw tip. Skinning is by mesh
 * island: each leg and its foot are separate pieces, so a vertex's group is
 * exact, not guessed. Re-running this rebuilds the rig-fixed.glb slot as
 * rig-spider.mjs does.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adjacency, loadMesh, skinWeights, writeRig } from './rig-spider.mjs'
import { workDir } from './workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ID = 'hob-weevil'

// --- what is stated ---------------------------------------------------------

/** Turns the mesh about +y so its mirror plane is x=0 and the snout points -z. */
const YAW_DEGREES = 46.75

/** Body joints. The thorax carries the head and every hip; its bone runs up the wing-cases. */
const BODY = [
  { name: 'Thorax', parent: null, at: [0, 0.18, 0.02], tip: [0, 0.3, 0.38] },
  { name: 'Head', parent: 'Thorax', at: [0, 0.3, -0.22], tip: [0, 0.17, -0.49] },
]

/**
 * The body island is split between thorax and head by a vertical plane at the
 * pronotum's front edge, blended over `HEAD_BLEND` either side. Nearest-bone
 * skinning would hand the top of the pronotum to the head, whose bone passes
 * closer to it than the thorax's does.
 */
const HEAD_CUT_Z = -0.24
const HEAD_BLEND = 0.02

/** The right legs, front to back; the left are their mirror in x. */
const LEGS = [
  { hip: [0.052, 0.146, -0.113], knee: [0.248, 0.214, -0.208], ankle: [0.278, 0.026, -0.312], foot: [0.396, 0.01, -0.37] },
  { hip: [0.063, 0.125, 0.024], knee: [0.274, 0.211, -0.023], ankle: [0.378, 0.028, -0.029], foot: [0.499, 0.01, -0.035] },
  { hip: [0.067, 0.121, 0.159], knee: [0.287, 0.201, 0.23], ankle: [0.354, 0.018, 0.34], foot: [0.455, 0.01, 0.417] },
]
const LEG_JOINTS = ['Hip', 'Knee', 'Ankle', 'Foot']
const LEG_PARENT = 'Thorax'

/** An island further than this from every leg's bones is head: the antennae. */
const LEG_REACH = 0.08

/** The body plan whose clip library drives this rig: anim/clips/insect. */
const PLAN = 'insect'

// --- the skeleton -----------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const mean = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)
const r6 = (v) => Math.round(v * 1e6) / 1e6

function segDist(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a)
  const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)))
  return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])
}

/** Legs 1-3 from the front, left (-x) before right, with their four joints each. */
function legList() {
  return LEGS.flatMap((leg, i) => ['L', 'R'].map((side) => ({
    n: i + 1,
    side,
    joints: LEG_JOINTS.map((part) => {
      const p = leg[part.toLowerCase()]
      return side === 'L' ? [-p[0], p[1], p[2]] : p.slice()
    }),
  })))
}

function buildJoints(legs) {
  const joints = BODY.map((j) => ({ ...j, group: 'body' }))
  for (const leg of legs) {
    const tag = `Leg${leg.n}`
    LEG_JOINTS.forEach((part, i) => joints.push({
      name: `${tag}${part}.${leg.side}`,
      parent: i === 0 ? LEG_PARENT : `${tag}${LEG_JOINTS[i - 1]}.${leg.side}`,
      at: leg.joints[i],
      group: `${tag}.${leg.side}`,
    }))
  }
  for (const j of joints) {
    j.children = joints.filter((c) => c.parent === j.name)
    j.boneTo = j.tip ?? (j.children.length === 1 ? j.children[0].at : null)
  }
  return joints
}

// --- the skin ---------------------------------------------------------------

/** Welded islands, biggest first. */
function islands(V, { adj, unique }) {
  const seen = new Set()
  const out = []
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
  return out.sort((a, b) => b.length - a.length)
}

/** Each island's group: the biggest is the body, the rest go to the leg whose bones they hug, else the head. */
function groupIslands(V, comps, legs) {
  const group = new Map()
  const count = new Map()
  comps.forEach((comp, k) => {
    let g = 'body'
    if (k > 0) {
      const c = mean(comp.map((v) => V[v]))
      let best = Infinity
      for (const leg of legs) {
        for (let i = 0; i < 3; i++) {
          const d = segDist(c, leg.joints[i], leg.joints[i + 1])
          if (d < best) { best = d; g = `Leg${leg.n}.${leg.side}` }
        }
      }
      if (best > LEG_REACH) g = 'head'
    }
    count.set(g, (count.get(g) ?? 0) + 1)
    for (const v of comp) group.set(v, g)
  })
  // A leg is a leg island and a foot island; anything else means the mesh or the stated joints moved.
  for (const leg of legs) {
    const g = `Leg${leg.n}.${leg.side}`
    if (count.get(g) !== 2) throw new Error(`${g} claimed ${count.get(g) ?? 0} islands, expected a leg and a foot`)
  }
  return { group, count }
}

function skin(V, joints, rep, group) {
  const groupOf = (v) => {
    const g = group.get(rep[v])
    return g === 'body' || g === 'head' ? 'body' : g
  }
  const { J, Wt } = skinWeights(V, joints, groupOf)
  const thorax = joints.findIndex((j) => j.name === 'Thorax')
  const head = joints.findIndex((j) => j.name === 'Head')
  for (let v = 0; v < V.length; v++) {
    const g = group.get(rep[v])
    if (g !== 'body' && g !== 'head') continue
    const u = Math.max(0, Math.min(1, (HEAD_CUT_Z + HEAD_BLEND - V[v][2]) / (2 * HEAD_BLEND)))
    const w = g === 'head' ? 1 : u * u * (3 - 2 * u)
    J.fill(0, v * 4, v * 4 + 4)
    Wt.fill(0, v * 4, v * 4 + 4)
    if (w < 1) { J[v * 4] = thorax; Wt[v * 4] = 1 - w }
    if (w > 0) { J[v * 4 + (w < 1 ? 1 : 0)] = head; Wt[v * 4 + (w < 1 ? 1 : 0)] = w }
  }
  return { J, Wt }
}

// --- the rig map ------------------------------------------------------------

function buildMap(joints, legs, existing) {
  const ys = joints.map((j) => j.at[1])
  const ground = Math.min(...ys), height = Math.max(...ys) - ground
  const centre = mean(joints.map((j) => j.at))
  const legMaps = legs.map((leg) => {
    const chain = LEG_JOINTS.map((part) => `Leg${leg.n}${part}.${leg.side}`)
    const foot = leg.joints[3]
    return {
      id: `leg${leg.n}${leg.side === 'L' ? 'Left' : 'Right'}`,
      foot: chain[3],
      chain,
      attach: LEG_PARENT,
      restFoot: foot.map(r6),
      station: { fore: r6(-(foot[2] - centre[2])), lat: r6(-(foot[0] - centre[0])) },
    }
  })
  const fore = legMaps.map((l) => l.station.fore)
  return {
    source: 'rig-fixed.glb',
    note: 'Authored by tools/creatures/rig-hob.mjs from mesh.glb, not detected: Tripo\'s hexapod rig is unusable. Re-run that tool to rebuild the rig and this map together.',
    plan: PLAN,
    frame: { forward: [0, 0, -1], lateral: [-1, 0, 0], centre: centre.map(r6), yawDegrees: -90 },
    ground: r6(ground),
    height: r6(height),
    wheelbase: r6(Math.max(...fore) - Math.min(...fore)),
    spine: ['Thorax'],
    head: ['Head'],
    tail: [],
    legs: legMaps,
    unclaimed: [],
    ...(existing?.clipTweaks ? { clipTweaks: existing.clipTweaks } : {}),
  }
}

// --- main -------------------------------------------------------------------

export function rigHob({ write = true } = {}) {
  const dir = workDir(ID)
  const mesh = loadMesh(path.join(dir, 'mesh.glb'))
  const c = Math.cos((YAW_DEGREES * Math.PI) / 180), s = Math.sin((YAW_DEGREES * Math.PI) / 180)
  for (const arr of [mesh.V, mesh.N]) {
    for (const p of arr) [p[0], p[2]] = [p[0] * c + p[2] * s, -p[0] * s + p[2] * c]
  }
  const legs = legList()
  const joints = buildJoints(legs)
  const graph = adjacency(mesh.V, mesh.I)
  const comps = islands(mesh.V, graph)
  const { group, count } = groupIslands(mesh.V, comps, legs)
  const weights = skin(mesh.V, joints, graph.rep, group)

  const mapFile = path.join(dir, 'rig-map.json')
  const existing = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : null
  const map = buildMap(joints, legs, existing)
  if (write) {
    writeRig(path.join(dir, 'rig-fixed.glb'), mesh, joints, weights, ID)
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2))
  }
  return { legs, joints, map, skin: weights, islands: count, vertices: mesh.V.length, mesh }
}

function main() {
  const probe = process.argv.includes('--probe')
  const { joints, map, islands: count, vertices } = rigHob({ write: !probe })
  console.log(`${ID}: ${vertices} vertices, ${joints.length} joints`)
  console.log(`  islands ${[...count].map(([g, n]) => `${g}:${n}`).join(' ')}`)
  console.log(`  ground ${map.ground}  height ${map.height}  wheelbase ${map.wheelbase}`)
  if (probe) console.log('\n(nothing written; drop --probe to write rig-fixed.glb and rig-map.json)')
  else console.log(`\nwrote ${path.relative(ROOT, path.join(workDir(ID), 'rig-fixed.glb'))} and rig-map.json`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
