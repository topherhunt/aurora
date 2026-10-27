/**
 * The shore crab's rigid skeleton: joints FOUND from the full-detail mesh, every tier's vertices bound to one
 * bone each. Design §27, "The crab". The mesh is hand-made and neither left/right symmetric nor evenly legged
 * (four legs on +Z, three on -Z), so joints are found per side and nothing is mirrored.
 *
 *   node tools/creatures/rig-crab.mjs     prints the bones and their vertex counts per tier
 *
 * The crab faces +X and is broad along Z. Legs are numbered rear to front per side. Each leg is an upper and a
 * lower segment; each claw is an arm and a finger hinged at the wrist. Bone 0 is the body.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adjacency, loadMesh } from './rig-spider.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TIER_FILES = ['shore-crab', 'shore-crab-lod1', 'shore-crab-lod2', 'shore-crab-lod3'].map((n) => path.join(ROOT, 'public/creatures', n + '.glb'))

/** Everything inside this xz ellipse is carapace; legs and claws leave it. */
const BODY = { cx: 0.05, a: 0.24, b: 0.24 }
/** Feet are the verts this close to the ground, and feet closer than FOOT_MERGE are one foot. */
const FOOT_Y = 0.075
const FOOT_MERGE = 0.12
/** Forward of CLAW_X, inside CLAW_Z of the midline and above CLAW_Y is claw; everything else outside the body is leg. */
const CLAW_X = 0.14
const CLAW_Z = 0.285
const CLAW_Y = 0.08
/** The finger is the lowest part of the hand beyond this fraction of the wrist-to-tip run. */
const FINGER_T = 0.6

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const inBody = (p) => ((p[0] - BODY.cx) / BODY.a) ** 2 + (p[2] / BODY.b) ** 2 < 1
const isClaw = (p) => p[0] > CLAW_X && Math.abs(p[2]) < CLAW_Z && p[1] > CLAW_Y

function segDist(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a)
  const t = Math.max(0, Math.min(1, dot(ap, ab) / (dot(ab, ab) || 1)))
  return dist(p, lerp(a, b, t))
}

/**
 * The skeleton found from the full-detail mesh: `bones` (name, parent, joint `at`, `tip`), plus the claw finger
 * split height. Legs are bones `Leg<n>Upper.<R|L>` (root to knee) and `Leg<n>Lower.<R|L>` (knee to foot); claws
 * are `ClawArm` (shoulder to wrist) and `ClawFinger` (wrist to tip). R is +Z.
 */
export function findRig(V, I) {
  const g = adjacency(V, I)
  const bones = [{ name: 'Body', parent: -1, at: [BODY.cx, 0.15, 0], tip: [BODY.cx + 0.1, 0.15, 0] }]
  const fingerSplit = {}
  for (const [sign, tag] of [[1, 'R'], [-1, 'L']]) {
    const out = g.unique.filter((v) => V[v][2] * sign > 0.08 && !inBody(V[v]))
    const legVerts = out.filter((v) => !isClaw(V[v]))
    const feet = []
    for (const v of legVerts.filter((u) => V[u][1] < FOOT_Y).sort((a, b) => V[a][1] - V[b][1])) {
      const f = feet.find((c) => dist(c.p, V[v]) < FOOT_MERGE)
      if (f) { f.n++; for (let k = 0; k < 3; k++) f.p[k] += (V[v][k] - f.p[k]) / f.n } else feet.push({ p: [...V[v]], n: 1 })
    }
    feet.sort((a, b) => a.p[0] - b.p[0])
    const own = feet.map(() => [])
    for (const v of legVerts) {
      let bi = 0, bd = Infinity
      feet.forEach((f, i) => { const d = dist(f.p, V[v]); if (d < bd) { bd = d; bi = i } })
      own[bi].push(v)
    }
    feet.forEach((f, n) => {
      const vs = own[n]
      const root = V[vs.reduce((a, v) => (V[v][1] > V[a][1] ? v : a), vs[0])]
      const lo = f.p[1] + 0.35 * (root[1] - f.p[1]), hi = f.p[1] + 0.65 * (root[1] - f.p[1])
      const band = vs.filter((v) => V[v][1] > lo && V[v][1] < hi)
      if (!band.length) throw new Error(`rig-crab: leg ${n}.${tag} has no verts at knee height`)
      const knee = band.reduce((a, v) => [a[0] + V[v][0] / band.length, a[1] + V[v][1] / band.length, a[2] + V[v][2] / band.length], [0, 0, 0])
      const up = bones.length
      bones.push({ name: `Leg${n}Upper.${tag}`, parent: 0, at: [...root], tip: knee })
      bones.push({ name: `Leg${n}Lower.${tag}`, parent: up, at: knee, tip: [...f.p] })
    })
    const claw = out.filter((v) => isClaw(V[v]))
    const tip = V[claw.reduce((a, v) => (V[v][0] > V[a][0] ? v : a), claw[0])]
    const shoulder = V[claw.reduce((a, v) => (V[v][0] < V[a][0] ? v : a), claw[0])]
    // the wrist is the hand's far elbow: the claw vert farthest from the shoulder-tip line, on the leg side
    const axis = sub(tip, shoulder)
    let wrist = null, wd = -1
    for (const v of claw) {
      const t = dot(sub(V[v], shoulder), axis) / dot(axis, axis)
      if (t < 0.3 || t > 0.8) continue
      const d = dist(V[v], lerp(shoulder, tip, t))
      if (d > wd) { wd = d; wrist = V[v] }
    }
    const hand = sub(tip, wrist)
    const far = claw.filter((v) => dot(sub(V[v], wrist), hand) / dot(hand, hand) > FINGER_T)
    fingerSplit[tag] = far.reduce((a, v) => a + V[v][1], 0) / far.length
    const arm = bones.length
    bones.push({ name: `ClawArm.${tag}`, parent: 0, at: [...shoulder], tip: [...wrist] })
    bones.push({ name: `ClawFinger.${tag}`, parent: arm, at: [...wrist], tip: [...tip] })
  }
  return { bones, fingerSplit }
}

/** One bone index per vertex of a tier. */
export function bindTier(V, rig) {
  const { bones, fingerSplit } = rig
  const own = new Uint8Array(V.length)
  for (let i = 0; i < V.length; i++) {
    const p = V[i]
    if (inBody(p) || Math.abs(p[2]) <= 0.08) continue
    const tag = p[2] > 0 ? 'R' : 'L'
    let best = 0, bd = Infinity
    if (isClaw(p)) {
      const arm = bones.findIndex((b) => b.name === `ClawArm.${tag}`)
      const fin = arm + 1
      const wrist = bones[arm].tip, tip = bones[fin].tip
      const hand = sub(tip, wrist)
      const t = dot(sub(p, wrist), hand) / dot(hand, hand)
      best = t > FINGER_T && p[1] < fingerSplit[tag] ? fin : arm
    } else {
      bones.forEach((b, j) => {
        if (!b.name.startsWith('Leg') || !b.name.endsWith(tag)) return
        const d = segDist(p, b.at, b.tip)
        if (d < bd) { bd = d; best = j }
      })
    }
    own[i] = best
  }
  return own
}

export function loadTiers() {
  const tiers = TIER_FILES.map((f) => loadMesh(f))
  const rig = findRig(tiers[0].V, tiers[0].I)
  return { rig, tiers: tiers.map((t) => ({ ...t, bone: bindTier(t.V, rig) })) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { rig, tiers } = loadTiers()
  console.log('bones', rig.bones.length)
  rig.bones.forEach((b, i) => console.log(String(i).padStart(2), b.name.padEnd(16), 'parent', String(b.parent).padStart(2), b.at.map((x) => x.toFixed(3)).join(','), '->', b.tip.map((x) => x.toFixed(3)).join(','), '|', tiers.map((t) => t.bone.reduce((n, b2) => n + (b2 === i), 0)).join(' ')))
}
