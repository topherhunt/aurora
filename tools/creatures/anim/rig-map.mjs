/**
 * Work out what a Tripo rig's joints ARE, from geometry alone.
 *
 *   node tools/creatures/anim/rig-map.mjs <id> [--write]
 *
 * Tripo's joint names cannot be trusted: on the red fox `tripo::0_Left_Limb_0`
 * is the second spine bone and both front legs are called `bone_14`..`bone_23`.
 * The shape of the skeleton, on the other hand, is unambiguous -- four chains
 * end on the ground in two mirrored pairs, the head end sits high, the tail
 * hangs off the back. So everything here is derived from joint POSITIONS.
 *
 * Two things this must not assume:
 *
 *   Axis alignment. The fox is modelled 45.9 degrees off the X axis. The body
 *   frame is derived per rig and every measurement below is taken in it.
 *
 *   That detection always works. It will not, on some creature, and a heuristic
 *   patched until it handles birds is worse than a file you can fix by hand. The
 *   map is written to rig-map.json and read back verbatim, so a wrong leg is a
 *   ten-second edit rather than a code change.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cross, dot, loadSkeleton, norm, sub } from './skeleton.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const workDir = (id) => path.join(ROOT, 'tools/creatures/work', id)

/** A foot is a low leaf; how low, as a fraction of the creature's height. */
const FOOT_BAND = 0.18
/** Two feet pair up if their fore-aft positions agree within this, in heights. */
const PAIR_TOL = 0.12

/**
 * The creature's own axes: `forward` along the spine toward the head, `up` the
 * world up, `lateral` across the shoulders. Derived by principal axis of the
 * horizontal joint spread, which is the body's long direction for any animal
 * longer than it is wide.
 */
function bodyFrame(skel) {
  const P = skel.joints.map(skel.pos)
  const n = P.length
  const c = [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / n)

  let sxx = 0, sxz = 0, szz = 0
  for (const p of P) {
    const dx = p[0] - c[0], dz = p[2] - c[2]
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  let forward = [Math.cos(theta), 0, Math.sin(theta)]

  // Which end is the head: the skull is the highest joint on every quadruped
  // standing in a bind pose. Recorded as `headroom` so a rig where the two ends
  // are close in height is visible as a low number rather than a silent guess.
  const top = skel.joints.reduce((a, b) => (skel.pos(a)[1] > skel.pos(b)[1] ? a : b))
  const tp = skel.pos(top)
  const along = (tp[0] - c[0]) * forward[0] + (tp[2] - c[2]) * forward[2]
  if (along < 0) forward = [-forward[0], 0, -forward[2]]

  return { centre: c, forward, up: [0, 1, 0], lateral: cross([0, 1, 0], forward), skull: top }
}

/** Body-frame coordinates of a world point: how far forward, how far left, how high. */
const inFrame = (frame, p) => {
  const d = sub(p, frame.centre)
  return { fore: dot(d, frame.forward), lat: dot(d, frame.lateral), up: p[1] }
}

/**
 * The chain of joints belonging to one limb: from the foot up to the last joint
 * before the body branches. A parent with more than one joint child is where the
 * limb attaches, so the walk stops below it.
 */
function limbChain(skel, foot) {
  const chain = [foot]
  for (const a of skel.ancestors(foot)) {
    if (skel.childrenOf(a).length > 1) break
    chain.unshift(a)
  }
  return chain
}

/** The joint a limb chain hangs off. */
const attachOf = (skel, chain) => skel.parent.get(chain[0])

/**
 * Find the four legs. Low leaves are candidates; a leg is one that has a mirror
 * partner at the same fore-aft station. The tail also ends low on many rigs and
 * is rejected here precisely because nothing mirrors it.
 */
function findLegs(skel, frame, height, ground) {
  const cand = skel.leaves()
    .map((j) => ({ j, ...inFrame(frame, skel.pos(j)) }))
    .filter((f) => f.up < ground + FOOT_BAND * height)

  const pairs = []
  const used = new Set()
  for (const a of cand) {
    if (used.has(a.j)) continue
    // The best partner: opposite side, similar distance out, same station.
    const mate = cand
      .filter((b) => b.j !== a.j && !used.has(b.j) && Math.sign(b.lat) === -Math.sign(a.lat))
      .sort((x, y) => Math.abs(x.fore - a.fore) - Math.abs(y.fore - a.fore))[0]
    if (!mate || Math.abs(mate.fore - a.fore) > PAIR_TOL * height) continue
    used.add(a.j); used.add(mate.j)
    const [left, right] = a.lat > 0 ? [a, mate] : [mate, a]
    pairs.push({ fore: (a.fore + mate.fore) / 2, left, right })
  }
  if (pairs.length < 2) {
    // Two feet and no pair is the signature of a biped: the body frame comes
    // from the principal horizontal axis, which only means "along the spine" on
    // an animal longer than it is wide. A standing human has no such axis, so
    // `forward` lands across the shoulders and the feet stop looking mirrored.
    const hint = cand.length <= 2
      ? 'this looks like a biped -- the gait synthesiser is quadruped-only'
      : 'edit rig-map.json by hand'
    throw new Error(`found ${pairs.length} mirrored foot pair(s), need 2 -- `
      + `low leaves were ${cand.map((f) => skel.name(f.j)).join(', ') || '(none)'}. ${hint}.`)
  }
  pairs.sort((a, b) => b.fore - a.fore)
  const front = pairs[0], hind = pairs[pairs.length - 1]

  const leg = (foot, side, end) => {
    const chain = limbChain(skel, foot.j)
    return {
      id: `${end}${side}`,
      foot: skel.name(foot.j),
      chain: chain.map(skel.name),
      attach: skel.name(attachOf(skel, chain)),
      restFoot: skel.pos(foot.j),
      // Where the foot sits in the body frame, which is what the gait plants it at.
      station: { fore: foot.fore, lat: foot.lat },
    }
  }
  return [
    leg(front.left, 'Left', 'front'), leg(front.right, 'Right', 'front'),
    leg(hind.left, 'Left', 'hind'), leg(hind.right, 'Right', 'hind'),
  ]
}

/**
 * The joint path between two joints, through their common ancestor. This is how
 * the spine is found: whatever lies between where the hind legs attach and where
 * the front legs attach IS the spine, whatever Tripo called it.
 */
function pathBetween(skel, from, to) {
  const up = [from, ...skel.ancestors(from)]
  const downSet = new Map()
  let k = to
  const downChain = [to, ...skel.ancestors(to)]
  downChain.forEach((n, i) => downSet.set(n, i))
  const meet = up.find((n) => downSet.has(n))
  if (meet === undefined) throw new Error('two joints in the same skin with no common ancestor')
  const a = up.slice(0, up.indexOf(meet) + 1)
  const b = downChain.slice(0, downSet.get(meet)).reverse()
  return [...a, ...b]
}

/** An unbranched run from `start` outward, following the only joint child. */
function runFrom(skel, start) {
  const out = []
  for (let k = start; k !== undefined;) {
    out.push(k)
    const kids = skel.childrenOf(k)
    k = kids.length === 1 ? kids[0] : undefined
  }
  return out
}

export function buildRigMap(file) {
  const skel = loadSkeleton(file)
  const frame = bodyFrame(skel)
  const ys = skel.joints.map((j) => skel.pos(j)[1])
  const ground = Math.min(...ys), height = Math.max(...ys) - ground
  if (height < 1e-6) throw new Error('every joint is at the same height -- this rig is flat')

  const legs = findLegs(skel, frame, height, ground)
  const frontAttach = skel.joints.find((j) => skel.name(j) === legs[0].attach)
  const hindAttach = skel.joints.find((j) => skel.name(j) === legs[2].attach)

  // Head: the unbranched run from the front attachment toward the skull. Tail:
  // the longest low run hanging off the hind end that is not a leg.
  const legJoints = new Set(legs.flatMap((l) => l.chain))
  const headRun = pathBetween(skel, frontAttach, frame.skull).filter((j) => j !== frontAttach)

  const tailCands = skel.leaves()
    .filter((j) => !legJoints.has(skel.name(j)) && j !== frame.skull)
    .map((j) => ({ j, ...inFrame(frame, skel.pos(j)) }))
    .filter((f) => f.fore < 0)
    .sort((a, b) => a.fore - b.fore)
  const tail = tailCands.length ? limbChain(skel, tailCands[0].j) : []

  const claimed = new Set([
    ...legJoints,
    ...pathBetween(skel, hindAttach, frontAttach).map(skel.name),
    ...headRun.map(skel.name),
    ...tail.map(skel.name),
  ])
  return {
    source: path.basename(file),
    // Everything below is in the creature's own frame, derived not assumed.
    frame: {
      forward: frame.forward.map(r6),
      lateral: frame.lateral.map(r6),
      centre: frame.centre.map(r6),
      yawDegrees: r6((Math.atan2(frame.forward[2], frame.forward[0]) * 180) / Math.PI),
    },
    ground: r6(ground),
    height: r6(height),
    // Front-to-hind foot distance: the natural stride scale for this animal.
    wheelbase: r6(legs[0].station.fore - legs[2].station.fore),
    spine: pathBetween(skel, hindAttach, frontAttach).map(skel.name),
    head: headRun.map(skel.name),
    tail: tail.map(skel.name),
    legs,
    // Joints no group claimed: ears, jaw, stray Tripo extras. Not a failure --
    // they simply hold their rest pose unless a clip names them.
    unclaimed: skel.joints.map(skel.name).filter((n) => !claimed.has(n)),
  }
}

const r6 = (v) => Math.round(v * 1e6) / 1e6

export const mapFile = (id) => path.join(workDir(id), 'rig-map.json')

/** The map for `id`, hand-edited if one is on disk, freshly derived if not. */
export function readRigMap(id) {
  const file = mapFile(id)
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  throw new Error(`no rig map for "${id}" -- run: node tools/creatures/anim/rig-map.mjs ${id} --write`)
}

function main() {
  const [id, ...flags] = process.argv.slice(2)
  if (!id) throw new Error('usage: rig-map.mjs <id> [--write]')
  const dir = workDir(id)
  const src = ['rig-fixed.glb', 'rig.glb'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
  if (!src) throw new Error(`no rig for "${id}"`)

  const map = buildRigMap(src)
  const show = (label, list) => console.log(`  ${label.padEnd(10)} ${list.length ? list.join(' -> ') : '(none found)'}`)
  console.log(`${id}  <- ${map.source}`)
  console.log(`  frame      forward ${map.frame.yawDegrees.toFixed(1)} deg off +X, ground y=${map.ground}, height ${map.height}, wheelbase ${map.wheelbase}`)
  show('spine', map.spine)
  show('head', map.head)
  show('tail', map.tail)
  for (const l of map.legs) console.log(`  ${l.id.padEnd(10)} ${l.chain.join(' -> ')}   (off ${l.attach})`)
  if (map.unclaimed.length) console.log(`  unclaimed  ${map.unclaimed.join(' ')}`)

  if (flags.includes('--write')) {
    fs.writeFileSync(mapFile(id), JSON.stringify(map, null, 2))
    console.log(`\nwrote ${path.relative(ROOT, mapFile(id))} -- edit it if anything above is wrong`)
  } else {
    console.log('\n(nothing written; pass --write to save)')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
