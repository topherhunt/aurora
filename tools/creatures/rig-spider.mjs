/**
 * Author the birch spider's skeleton from its mesh and bind the mesh to it.
 *
 *   node tools/creatures/rig-spider.mjs            writes rig-fixed.glb and rig-map.json
 *   node tools/creatures/rig-spider.mjs --probe    prints what it found, writes nothing
 *
 * Tripo's octopod rig for this mesh is not a skeleton (two legs, five stubs, a
 * leg called a tail), so this builds one: the legs are FOUND -- eight connected
 * pieces outside a body box, each traced from the body to its tip and jointed at
 * thirds of that arc -- and the body joints are STATED in BODY below. Design
 * §27, Stage 5, has the why. The output lands in the slot the pipeline prefers
 * over rig.glb; a rig-edit save would regenerate that slot from Tripo's rig and
 * clobber it, and re-running this is the way back.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAccessor, readGlb, writeGlb } from './apply-rig-edit.mjs'
import { workDir } from './workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ID = 'birch-spider'

// --- what is stated ---------------------------------------------------------

/**
 * A box in the world frame that contains the body and no leg further out than
 * its coxa. Everything connected outside it is a leg.
 */
const BODY_BOX = { x: 0.11, zMin: -0.23, zMax: 0.2, yMin: 0.05 }

/**
 * The body joints. `at` is the joint; `tip` is where its bone ends for skinning
 * when that is not simply its child -- the thorax carries the head AND every
 * hip, and only the head is its bone. A leaf with no `tip` has no bone: it is a
 * target, and the bone above it owns the vertices around it.
 */
const BODY = [
  { name: 'Pedicel', parent: null, at: [0, 0.115, -0.04] },
  { name: 'Thorax', parent: 'Pedicel', at: [0, 0.12, -0.085], tip: [0, 0.125, -0.145] },
  { name: 'Head', parent: 'Thorax', at: [0, 0.125, -0.145], tip: [0, 0.12, -0.18] },
  { name: 'Chelicera.L', parent: 'Head', at: [-0.025, 0.11, -0.16] },
  { name: 'Fang.L', parent: 'Chelicera.L', at: [-0.025, 0.09, -0.172], tip: [-0.025, 0.068, -0.184] },
  { name: 'Chelicera.R', parent: 'Head', at: [0.03, 0.11, -0.16] },
  { name: 'Fang.R', parent: 'Chelicera.R', at: [0.03, 0.09, -0.172], tip: [0.03, 0.068, -0.184] },
  { name: 'Abdomen1', parent: 'Pedicel', at: [0, 0.14, 0.0] },
  { name: 'Abdomen2', parent: 'Abdomen1', at: [0, 0.165, 0.08] },
  { name: 'AbdomenTip', parent: 'Abdomen2', at: [0, 0.155, 0.185] },
]

/** Every leg hangs off the cephalothorax. */
const LEG_PARENT = 'Thorax'
const LEG_JOINTS = ['Hip', 'Knee', 'Ankle', 'Foot']

/** The body plan whose clip library drives this rig: anim/clips/spider. */
const PLAN = 'spider'

// --- the mesh ---------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const mean = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)

/**
 * The mesh's vertices in the world frame: its node matrix applied and the whole
 * thing lifted so the lowest vertex is the ground. The rig is written with the
 * mesh node at identity, so the vertices themselves carry this transform.
 */
function loadMesh(file) {
  const { json, bin } = readGlb(file)
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error(`${file}: expected one mesh with one primitive`)
  const meshNode = json.nodes.find((n) => n.mesh !== undefined)
  if (!meshNode || json.nodes.length !== 1) throw new Error(`${file}: expected one node, the mesh`)
  const m = meshNode.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const prim = json.meshes[0].primitives[0]
  const P = readAccessor(json, bin, prim.attributes.POSITION)
  const N = readAccessor(json, bin, prim.attributes.NORMAL)
  const I = readAccessor(json, bin, prim.indices)
  const rot = (v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ]
  const V = [], Nw = []
  for (let i = 0; i < P.length; i += 3) {
    const p = rot([P[i], P[i + 1], P[i + 2]])
    V.push([p[0] + m[12], p[1] + m[13], p[2] + m[14]])
    Nw.push(rot([N[i], N[i + 1], N[i + 2]]))
  }
  const floor = Math.min(...V.map((p) => p[1]))
  for (const p of V) p[1] -= floor
  // `m` and `floor` are the frame: a tier of the same pick is put in it by the same move.
  return { json, bin, prim, V, N: Nw, I, m, floor }
}

/**
 * Vertex adjacency over WELDED positions. A UV seam splits a vertex in two, and
 * a leg traced over unwelded vertices stops dead at its first seam.
 */
function adjacency(V, I) {
  const rep = []
  const seen = new Map()
  V.forEach((p, i) => {
    const k = p.map((v) => v.toFixed(4)).join(',')
    if (!seen.has(k)) seen.set(k, i)
    rep[i] = seen.get(k)
  })
  const adj = new Map()
  const link = (a, b) => {
    if (a === b) return
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a).add(b)
  }
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [rep[I[t]], rep[I[t + 1]], rep[I[t + 2]]]
    link(a, b); link(b, a); link(b, c); link(c, b); link(a, c); link(c, a)
  }
  return { rep, adj, unique: [...new Set(rep)] }
}

const inBody = (p) => Math.abs(p[0]) < BODY_BOX.x && p[2] > BODY_BOX.zMin && p[2] < BODY_BOX.zMax && p[1] > BODY_BOX.yMin

/** Connected components of the welded vertices outside the body box. */
function legComponents(V, { adj, unique }) {
  const seen = new Set()
  const comps = []
  for (const s of unique) {
    if (seen.has(s) || inBody(V[s])) continue
    const comp = [], stack = [s]
    seen.add(s)
    while (stack.length) {
      const v = stack.pop()
      comp.push(v)
      for (const n of adj.get(v) ?? []) {
        if (!seen.has(n) && !inBody(V[n])) { seen.add(n); stack.push(n) }
      }
    }
    comps.push(comp)
  }
  return comps
}

/**
 * One leg's joints from its vertices. Dijkstra from the vertices touching the
 * body finds the tip (furthest by path, not by straight line -- a leg that
 * doubles back would fool the latter) and the path back from it. Each joint is
 * the centre of the tube at its station: the mean of the ring of vertices whose
 * nearest point on the path lies closest to that arc length.
 */
function traceLeg(V, adj, comp) {
  const attach = comp.filter((v) => [...(adj.get(v) ?? [])].some((n) => inBody(V[n])))
  if (!attach.length) throw new Error('a leg component does not touch the body')
  const d = new Map(comp.map((v) => [v, Infinity]))
  const prev = new Map()
  const open = new Set(attach)
  for (const a of attach) d.set(a, 0)
  while (open.size) {
    let u = null
    for (const v of open) if (u === null || d.get(v) < d.get(u)) u = v
    open.delete(u)
    for (const n of adj.get(u) ?? []) {
      if (!d.has(n)) continue
      const nd = d.get(u) + dist(V[u], V[n])
      if (nd < d.get(n)) { d.set(n, nd); prev.set(n, u); open.add(n) }
    }
  }
  const tip = comp.reduce((a, v) => (d.get(v) > d.get(a) ? v : a), comp[0])
  const path = [tip]
  for (let v = tip; prev.has(v); v = prev.get(v)) path.push(prev.get(v))
  path.reverse()

  // Arc length along the path, and each vertex's station on it.
  const s = [0]
  for (let i = 1; i < path.length; i++) s.push(s[i - 1] + dist(V[path[i]], V[path[i - 1]]))
  const L = s[s.length - 1]
  const stationOf = (p) => {
    let best = Infinity, at = 0
    for (let i = 1; i < path.length; i++) {
      const a = V[path[i - 1]], b = V[path[i]]
      const ab = sub(b, a), ap = sub(p, a)
      const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)))
      const q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]
      const e = dist(p, q)
      if (e < best) { best = e; at = s[i - 1] + (s[i] - s[i - 1]) * t }
    }
    return at
  }
  const stations = comp.map((v) => ({ v, at: stationOf(V[v]) }))
  // A leg here is a tube of a dozen vertices in three or four rings. Its
  // centreline is the running mean of four station-sorted vertices, and a joint
  // is that centreline read at its station -- so the joints land at exactly a
  // third and two thirds of the leg however the rings happen to fall.
  stations.sort((a, b) => a.at - b.at)
  const line = []
  for (let i = 0; i + 4 <= stations.length; i++) {
    const ring = stations.slice(i, i + 4)
    line.push({ at: ring.reduce((t, x) => t + x.at, 0) / 4, p: mean(ring.map((x) => V[x.v])) })
  }
  const centreAt = (frac) => {
    const at = frac * L
    if (at <= line[0].at) return line[0].p
    for (let i = 1; i < line.length; i++) {
      if (at > line[i].at) continue
      const t = (at - line[i - 1].at) / (line[i].at - line[i - 1].at)
      return [0, 1, 2].map((k) => line[i - 1].p[k] + (line[i].p[k] - line[i - 1].p[k]) * t)
    }
    return line[line.length - 1].p
  }
  const joints = [mean(attach.map((v) => V[v])), centreAt(1 / 3), centreAt(2 / 3), V[tip].slice()]
  return { joints, length: L, verts: comp, attach: joints[0], tip: joints[3] }
}

/**
 * Eight legs, sorted into their anatomical order: I to IV from the front, left
 * (-x, because `lateral` is cross(up, forward) and forward is -z) before right.
 */
function findLegs(V, I) {
  const graph = adjacency(V, I)
  const comps = legComponents(V, graph)
  if (comps.length !== 8) {
    throw new Error(`found ${comps.length} pieces outside the body box, need 8 legs -- sizes ${comps.map((c) => c.length).join(', ')}`)
  }
  const legs = comps.map((c) => traceLeg(V, graph.adj, c))
  const left = legs.filter((l) => l.tip[0] < 0).sort((a, b) => a.tip[2] - b.tip[2])
  const right = legs.filter((l) => l.tip[0] >= 0).sort((a, b) => a.tip[2] - b.tip[2])
  if (left.length !== 4) throw new Error(`${left.length} legs on the left, need 4`)
  return { legs: left.flatMap((l, i) => [{ ...l, n: i + 1, side: 'L' }, { ...right[i], n: i + 1, side: 'R' }]), rep: graph.rep }
}

// --- the skeleton -----------------------------------------------------------

/** Every joint, body first then legs, each with a name, parent, position and skinning bone. */
function buildJoints(legs) {
  const joints = BODY.map((j) => ({ ...j, group: 'body' }))
  for (const leg of legs) {
    const tag = `Leg${leg.n}`
    LEG_JOINTS.forEach((part, i) => {
      joints.push({
        name: `${tag}${part}.${leg.side}`,
        parent: i === 0 ? LEG_PARENT : `${tag}${LEG_JOINTS[i - 1]}.${leg.side}`,
        at: leg.joints[i],
        group: `${tag}.${leg.side}`,
      })
    })
  }
  const byName = new Map(joints.map((j) => [j.name, j]))
  for (const j of joints) {
    if (j.parent !== null && !byName.has(j.parent)) throw new Error(`joint ${j.name} names parent ${j.parent}, which does not exist`)
    j.children = joints.filter((c) => c.parent === j.name)
    // The bone a joint owns for skinning: to its stated tip, else to its only
    // child. A branch point without a stated tip, or a leaf, owns no bone.
    j.boneTo = j.tip ?? (j.children.length === 1 ? j.children[0].at : null)
  }
  return joints
}

/** Distance from point `p` to the segment a-b. */
function segDist(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a)
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / l2))
  return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])
}

const MAX_INFLUENCES = 4
const WEIGHT_FLOOR = 0.01

/**
 * Per-vertex joint indices and weights. `groupOf(v)` says which segment a vertex
 * is in; only that segment's bones may claim it.
 */
function skinWeights(V, joints, groupOf) {
  const bones = joints.map((j, i) => ({ i, j })).filter(({ j }) => j.boneTo)
  const J = new Uint8Array(V.length * 4)
  const Wt = new Float32Array(V.length * 4)
  for (let v = 0; v < V.length; v++) {
    const g = groupOf(v)
    const cands = bones.filter(({ j }) => j.group === g)
    if (!cands.length) throw new Error(`vertex ${v} is in group ${g}, which has no bones`)
    const scored = cands.map(({ i, j }) => ({ i, w: 1 / (segDist(V[v], j.at, j.boneTo) ** 4 + 1e-10) }))
      .sort((a, b) => b.w - a.w).slice(0, MAX_INFLUENCES)
    let total = scored.reduce((s, x) => s + x.w, 0)
    const kept = scored.filter((x) => x.w / total >= WEIGHT_FLOOR)
    total = kept.reduce((s, x) => s + x.w, 0)
    kept.forEach((x, k) => { J[v * 4 + k] = x.i; Wt[v * 4 + k] = x.w / total })
  }
  return { J, Wt }
}

/**
 * Write the rigged glb: the mesh's own json with the vertices rewritten into the
 * world frame, skin attributes added, and the joint nodes appended. The mesh's
 * material, textures and images ride through untouched.
 */
function writeRig(out, mesh, joints, skin) {
  const { json, bin, prim, V, N } = mesh
  const parts = [bin]
  let at = bin.length
  const view = (bytes) => {
    const pad = (4 - (at % 4)) % 4
    if (pad) { parts.push(Buffer.alloc(pad)); at += pad }
    json.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.length })
    parts.push(bytes)
    at += bytes.length
    return json.bufferViews.length - 1
  }
  const accessor = (bytes, componentType, count, type, extra = {}) => {
    json.accessors.push({ bufferView: view(bytes), componentType, count, type, ...extra })
    return json.accessors.length - 1
  }
  const f32 = (arr) => Buffer.from(new Float32Array(arr).buffer)

  const flatV = V.flat(), flatN = N.flat()
  const min = [0, 1, 2].map((k) => Math.min(...V.map((p) => p[k])))
  const max = [0, 1, 2].map((k) => Math.max(...V.map((p) => p[k])))
  prim.attributes.POSITION = accessor(f32(flatV), 5126, V.length, 'VEC3', { min, max })
  prim.attributes.NORMAL = accessor(f32(flatN), 5126, N.length, 'VEC3')
  prim.attributes.JOINTS_0 = accessor(Buffer.from(skin.J.buffer), 5121, V.length, 'VEC4')
  prim.attributes.WEIGHTS_0 = accessor(Buffer.from(skin.Wt.buffer), 5126, V.length, 'VEC4')

  // Joint nodes follow the mesh node. Identity rotations and parent-relative
  // translations, so a joint's world position is exactly its `at`.
  const meshNode = json.nodes[0]
  delete meshNode.matrix
  meshNode.name = ID
  meshNode.skin = 0
  const index = new Map(joints.map((j, i) => [j.name, i + 1]))
  json.nodes = [meshNode, ...joints.map((j) => {
    const from = j.parent ? joints.find((p) => p.name === j.parent).at : [0, 0, 0]
    const node = { name: j.name, translation: sub(j.at, from), rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
    if (j.children.length) node.children = j.children.map((c) => index.get(c.name))
    return node
  })]
  const root = joints.find((j) => j.parent === null)
  json.scenes = [{ nodes: [0, index.get(root.name)] }]
  json.scene = 0

  const ibm = joints.flatMap((j) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -j.at[0], -j.at[1], -j.at[2], 1])
  json.skins = [{
    name: `${ID}-skeleton`,
    joints: joints.map((j) => index.get(j.name)),
    inverseBindMatrices: accessor(f32(ibm), 5126, joints.length, 'MAT4'),
    skeleton: index.get(root.name),
  }]

  const outBin = Buffer.concat(parts)
  json.buffers[0].byteLength = outBin.length
  writeGlb(out, json, outBin)
}

// --- the rig map ------------------------------------------------------------

const r6 = (v) => Math.round(v * 1e6) / 1e6

/**
 * The map the clip builder reads. Written in the same shape rig-map.mjs derives
 * for a quadruped, with the spider's own reading of the groups: the thorax is
 * the spine, the abdomen is the tail (a backward chain, so positive pitch lifts
 * it), and the chelicerae are the mirrored `arms` pair. `clipTweaks` on an
 * existing map survive a rebuild -- they are tuning, not derivation.
 */
function buildMap(joints, legs, existing) {
  const forward = [0, 0, -1], lateral = [-1, 0, 0]
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
    note: 'Authored by tools/creatures/rig-spider.mjs from mesh.glb, not detected: Tripo\'s octopod rig has two legs and five stubs. Re-run that tool to rebuild the rig and this map together.',
    plan: PLAN,
    frame: { forward, lateral, centre: centre.map(r6), yawDegrees: -90 },
    ground: r6(ground),
    height: r6(height),
    wheelbase: r6(Math.max(...fore) - Math.min(...fore)),
    spine: ['Thorax'],
    head: ['Head'],
    tail: ['Abdomen1', 'Abdomen2'],
    arms: [
      { id: 'cheliceraLeft', side: 1, chain: ['Chelicera.L', 'Fang.L'] },
      { id: 'cheliceraRight', side: -1, chain: ['Chelicera.R', 'Fang.R'] },
    ],
    legs: legMaps,
    unclaimed: ['Pedicel', 'AbdomenTip'],
    ...(existing?.clipTweaks ? { clipTweaks: existing.clipTweaks } : {}),
  }
}

// --- main -------------------------------------------------------------------

export function rigSpider({ write = true } = {}) {
  const dir = workDir(ID)
  const mesh = loadMesh(path.join(dir, 'mesh.glb'))
  const { legs, rep } = findLegs(mesh.V, mesh.I)
  const joints = buildJoints(legs)
  const groupByRep = new Map()
  for (const leg of legs) for (const v of leg.verts) groupByRep.set(v, `Leg${leg.n}.${leg.side}`)
  const groupOf = (v) => groupByRep.get(rep[v]) ?? 'body'
  const skin = skinWeights(mesh.V, joints, groupOf)

  const mapFile = path.join(dir, 'rig-map.json')
  const existing = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : null
  const map = buildMap(joints, legs, existing)
  if (write) {
    writeRig(path.join(dir, 'rig-fixed.glb'), mesh, joints, skin)
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2))
  }
  // `mesh` is for ship-spider.mjs, which decimates these very vertices into its
  // LOD ladder and carries `skin` down it (tools/creatures/skin-ladder.mjs).
  return { legs, joints, map, skin, vertices: mesh.V.length, mesh }
}

function main() {
  const probe = process.argv.includes('--probe')
  const { legs, joints, map, vertices } = rigSpider({ write: !probe })
  const f = (p) => p.map((v) => v.toFixed(3).padStart(7)).join(' ')
  console.log(`${ID}: ${vertices} vertices, ${joints.length} joints, ${legs.length} legs`)
  for (const leg of legs) {
    console.log(`  leg ${leg.n}${leg.side}  ${leg.verts.length} verts, ${(leg.length * 100).toFixed(1)}cm`)
    LEG_JOINTS.forEach((part, i) => console.log(`      ${part.padEnd(6)} ${f(leg.joints[i])}`))
  }
  console.log(`  ground ${map.ground}  height ${map.height}  wheelbase ${map.wheelbase}`)
  if (probe) console.log('\n(nothing written; drop --probe to write rig-fixed.glb and rig-map.json)')
  else console.log(`\nwrote ${path.relative(ROOT, path.join(workDir(ID), 'rig-fixed.glb'))} and rig-map.json`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
