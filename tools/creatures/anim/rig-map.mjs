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
 * Two chains ending on the ground is a biped, and gets the `human` reading: two
 * legs, a spine up to wherever the arms branch, a head above that, and each arm
 * annotated with its shoulder, elbow and wrist so a clip can drive them apart.
 * The names are as random on a human as on a fox -- one farmer's arms hang off
 * a joint called `Head_0` -- and the chains are not even the same length from
 * one villager to the next, so nothing here goes by name either.
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
import { add, cross, dot, len, loadSkeleton, norm, scale, sub } from './skeleton.mjs'

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
    throw new Error(`found ${pairs.length} mirrored foot pair(s), need 2 -- `
      + `low leaves were ${cand.map((f) => skel.name(f.j)).join(', ') || '(none)'}. Edit rig-map.json by hand.`)
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
  const ys = skel.joints.map((j) => skel.pos(j)[1])
  const ground = Math.min(...ys), height = Math.max(...ys) - ground
  if (height < 1e-6) throw new Error('every joint is at the same height -- this rig is flat')

  // How many chains end on the ground decides the reading. A quadruped's tail
  // may hang low too, so it is "two or fewer", not "exactly two": one foot is a
  // biped Tripo left half-rigged, and the biped reading says so.
  const low = skel.leaves().filter((j) => skel.pos(j)[1] < ground + FOOT_BAND * height)
  const body = low.length <= 2 ? bipedMap(skel, low, ground, height) : quadrupedMap(skel, ground, height)
  return {
    source: path.basename(file),
    ...(body.plan ? { plan: body.plan } : {}),
    // Everything below is in the creature's own frame, derived not assumed.
    frame: {
      forward: body.frame.forward.map(r6),
      lateral: body.frame.lateral.map(r6),
      centre: body.frame.centre.map(r6),
      yawDegrees: r6((Math.atan2(body.frame.forward[2], body.frame.forward[0]) * 180) / Math.PI),
    },
    ground: r6(ground),
    height: r6(height),
    wheelbase: r6(body.wheelbase),
    spine: body.spine.map(skel.name),
    head: body.head.map(skel.name),
    tail: body.tail.map(skel.name),
    legs: body.legs,
    ...(body.arms ? { arms: body.arms } : {}),
    // Joints no group claimed: ears, jaw, stray Tripo extras. Not a failure --
    // they simply hold their rest pose unless a clip names them.
    unclaimed: skel.joints.map(skel.name).filter((n) => !body.claimed.has(n)),
  }
}

function quadrupedMap(skel, ground, height) {
  const frame = bodyFrame(skel)
  const legs = findLegs(skel, frame, height, ground)
  const frontAttach = skel.joints.find((j) => skel.name(j) === legs[0].attach)
  const hindAttach = skel.joints.find((j) => skel.name(j) === legs[2].attach)

  // Head: the unbranched run from the front attachment toward the skull. Tail:
  // the longest low run hanging off the hind end that is not a leg.
  const legJoints = new Set(legs.flatMap((l) => l.chain))
  const spine = pathBetween(skel, hindAttach, frontAttach)
  const head = pathBetween(skel, frontAttach, frame.skull).filter((j) => j !== frontAttach)

  const tailCands = skel.leaves()
    .filter((j) => !legJoints.has(skel.name(j)) && j !== frame.skull)
    .map((j) => ({ j, ...inFrame(frame, skel.pos(j)) }))
    .filter((f) => f.fore < 0)
    .sort((a, b) => a.fore - b.fore)
  const tail = tailCands.length ? limbChain(skel, tailCands[0].j) : []

  return {
    frame,
    // Front-to-hind foot distance: the natural stride scale for this animal.
    wheelbase: legs[0].station.fore - legs[2].station.fore,
    spine, head, tail, legs,
    claimed: new Set([...legJoints, ...[...spine, ...head, ...tail].map(skel.name)]),
  }
}

/** The world axis nearest a horizontal direction, or a refusal if none is near. */
function snapToAxis(v) {
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  const best = axes.reduce((a, b) => (dot(b, v) > dot(a, v) ? b : a))
  const off = Math.acos(Math.min(1, dot(best, norm(v)))) * 180 / Math.PI
  if (off > 35) throw new Error(`the toes point ${off.toFixed(0)} degrees off every world axis -- write frame.forward into rig-map.json by hand`)
  return best
}

/**
 * Where an arm's shoulder, elbow and wrist are, by proportion. Tripo gives one
 * villager three arm joints and the next seven, so they are found rather than
 * counted: the shoulder is the first joint whose bone drops more than it reaches
 * sideways (everything before it is clavicle), the elbow the joint nearest
 * halfway down the arm from there, the wrist the one nearest twice the upper
 * arm's length, and whatever follows is hand.
 */
function armAnatomy(skel, chain, frame) {
  const P = chain.map(skel.pos)
  let s = 0
  for (; s < P.length - 2; s++) {
    const d = sub(P[s + 1], P[s])
    if (Math.abs(d[1]) > Math.abs(dot(d, frame.lateral))) break
  }
  const cum = [0]
  for (let i = s + 1; i < P.length; i++) cum.push(cum[cum.length - 1] + len(sub(P[i], P[i - 1])))
  const nearest = (target, lo, hi) => {
    let best = lo
    for (let i = lo; i <= hi; i++) if (Math.abs(cum[i] - target) < Math.abs(cum[best] - target)) best = i
    return best
  }
  const e = nearest(cum[cum.length - 1] / 2, 1, cum.length - 2)
  const w = nearest(2 * cum[e], e + 1, cum.length - 1)
  return { shoulder: skel.name(chain[s]), elbow: skel.name(chain[s + e]), wrist: skel.name(chain[s + w]) }
}

/**
 * The `human` reading. Forward is where the toes point -- the only cue a
 * standing figure offers, since its spine is vertical and its width is its
 * length -- snapped to a world axis because Tripo poses a humanoid square to
 * one and the toes themselves splay by twenty degrees. Left is the leg on the
 * positive lateral side, whatever Tripo called it.
 */
function bipedMap(skel, low, ground, height) {
  const feet = low.map(skel.name).join(', ') || '(none)'
  if (low.length !== 2) {
    throw new Error(`found ${low.length} foot chain(s) reaching the ground, a biped needs 2 -- ${feet}. `
      + 'Tripo left the other leg as a stub joint at hip height; re-rig, or write the leg into rig-map.json by hand.')
  }
  const chains = low.map((f) => limbChain(skel, f))
  for (const c of chains) {
    if (c.length < 3) throw new Error(`leg ending at ${skel.name(c[c.length - 1])} has only ${c.length} joints, need hip, knee and foot`)
  }
  // A last bone that runs along the ground is a toe: the leg is solved to the
  // ankle above it (see limbSetup) and the toe says which way the figure faces.
  const toeOf = (c) => {
    const d = sub(skel.pos(c[c.length - 1]), skel.pos(c[c.length - 2]))
    return c.length >= 4 && Math.hypot(d[0], d[2]) > Math.abs(d[1]) ? [d[0], 0, d[2]] : null
  }
  let cue = [0, 0, 0]
  for (const c of chains) { const d = toeOf(c); if (d) cue = add(cue, d) }
  if (len(cue) < 0.02 * height) throw new Error('neither foot has a toe joint to say which way this biped faces -- write frame.forward into rig-map.json by hand')
  const forward = snapToAxis(cue)
  const up = [0, 1, 0]
  const lateral = cross(up, forward)
  const hips = chains.map((c) => skel.pos(c[0]))
  const skull = skel.joints.reduce((a, b) => (skel.pos(a)[1] > skel.pos(b)[1] ? a : b))
  const frame = { centre: scale(add(hips[0], hips[1]), 0.5), forward, up, lateral, skull }

  const pelvis = attachOf(skel, chains[0])
  if (attachOf(skel, chains[1]) !== pelvis) throw new Error('the two legs hang off different joints -- write the map by hand')
  const legs = chains.map((whole) => {
    const toe = toeOf(whole) ? whole[whole.length - 1] : null
    const chain = toe === null ? whole : whole.slice(0, -1)
    const foot = chain[chain.length - 1]
    const at = inFrame(frame, skel.pos(foot))
    return {
      id: at.lat > 0 ? 'legLeft' : 'legRight',
      foot: skel.name(foot),
      ...(toe === null ? {} : { toe: skel.name(toe) }),
      chain: chain.map(skel.name),
      attach: skel.name(pelvis),
      restFoot: skel.pos(foot),
      station: { fore: at.fore, lat: at.lat },
      hingeAxis: lateral,
    }
  }).sort((a) => (a.id === 'legLeft' ? -1 : 1))
  if (legs[0].id === legs[1].id) throw new Error(`both feet are on the same side of the body (${feet}) -- write the map by hand`)

  // Arms: the two longest chains that are not legs, one each side. Stray
  // single joints Tripo leaves at hip height have no chain and drop out here.
  const legJoints = new Set(chains.flat())
  const armCands = skel.leaves()
    .filter((j) => !legJoints.has(j) && j !== skull)
    .map((j) => ({ chain: limbChain(skel, j), lat: inFrame(frame, skel.pos(j)).lat }))
    .filter((c) => c.chain.length >= 3)
    .sort((a, b) => b.chain.length - a.chain.length)
  const armOf = (side) => armCands.find((c) => Math.sign(c.lat) === side)
  const left = armOf(1), right = armOf(-1)
  if (!left || !right) throw new Error(`could not find an arm on ${!left ? 'the left' : 'the right'} -- write the map by hand`)
  const chest = attachOf(skel, left.chain)
  if (attachOf(skel, right.chain) !== chest) throw new Error('the two arms hang off different joints -- write the map by hand')
  const arms = [[left, 'armLeft', 1], [right, 'armRight', -1]].map(([c, id, side]) => ({
    id, side, chain: c.chain.map(skel.name), ...armAnatomy(skel, c.chain, frame),
  }))

  // The pelvis stays out of the spine: bending it would pivot the whole figure
  // about a root joint Tripo puts on the ground between the feet.
  const spine = pathBetween(skel, pelvis, chest).slice(1)
  const head = pathBetween(skel, chest, skull).slice(1)
  return {
    plan: 'human',
    frame,
    // Hip height above the ground: the natural stride and reach scale on two legs.
    wheelbase: (hips[0][1] + hips[1][1]) / 2 - ground,
    spine, head, tail: [], legs, arms,
    claimed: new Set([pelvis, ...chains.flat(), ...spine, ...head, ...left.chain, ...right.chain].map(skel.name)),
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
  console.log(`${id}  <- ${map.source}${map.plan ? `  (${map.plan})` : ''}`)
  console.log(`  frame      forward ${map.frame.yawDegrees.toFixed(1)} deg off +X, ground y=${map.ground}, height ${map.height}, wheelbase ${map.wheelbase}`)
  show('spine', map.spine)
  show('head', map.head)
  show('tail', map.tail)
  for (const l of map.legs) console.log(`  ${l.id.padEnd(10)} ${l.chain.join(' -> ')}   (off ${l.attach})`)
  for (const a of map.arms ?? []) {
    const tag = (n) => (n === a.shoulder ? `[S]${n}` : n === a.elbow ? `[E]${n}` : n === a.wrist ? `[W]${n}` : n)
    console.log(`  ${a.id.padEnd(10)} ${a.chain.map(tag).join(' -> ')}`)
  }
  if (map.unclaimed.length) console.log(`  unclaimed  ${map.unclaimed.join(' ')}`)

  if (flags.includes('--write')) {
    fs.writeFileSync(mapFile(id), JSON.stringify(map, null, 2))
    console.log(`\nwrote ${path.relative(ROOT, mapFile(id))} -- edit it if anything above is wrong`)
  } else {
    console.log('\n(nothing written; pass --write to save)')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
