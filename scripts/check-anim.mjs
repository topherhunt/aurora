// Node-side gates for the creature animation tools (tools/creatures/anim/,
// design/27-creature-pipeline.md Stage 4).
//
//   node scripts/check-anim.mjs
//
// These clips are synthesised, not hand-keyed, so the failures worth gating are
// the ones that still produce a file that loads and plays. In the order they
// cost the most:
//
//   A PLANTED FOOT DRIFTS. The loudest tell that an animal is fake, and it is
//   invisible frame by frame -- every pose looks fine, and the skating only
//   appears once the clip runs. The solver places feet in the GROUND's frame and
//   the body moves through them, so the check is: undo the implied forward
//   speed, and a stance foot must not move between adjacent frames.
//
//   A HINGE INVERTS. Tripo binds a creature at near-full extension, so the IK
//   always works near a singularity and a knee that folds the wrong way costs
//   nothing numerically -- the foot still lands on target. Every interior joint
//   is pinned to the bend axis it has at rest, and the gate holds the solver to
//   that by pulling at an unreachable target and checking no joint straightened
//   past the bend it started with.
//
//   A TRACK COMES OUT SHORT. glTF cannot represent a channel with fewer samples
//   than its sampler's input, and a keyframe that happens to be all zeros used
//   to write no rotation at all -- so a sit whose first key was neutral failed
//   to bake. `seed()` exists for that, and this is its regression.
//
//   THE ROOT TRANSLATION LANDS IN THE WRONG SPACE. The body's rise and fall is
//   the one channel that is not a rotation, and glTF writes it in the joint's
//   PARENT space. Getting that wrong scales or rotates the bob rather than
//   erroring, which reads as a limp.
//
//   A CLIP STOPS LOOPING. Sample 0 and sample n are the same phase; if a track
//   does not come back where it started, the clip pops once per cycle.
//
// The fixture below is synthetic, not red-fox: tools/creatures/work is
// gitignored, so a clone has no rig to gate against. It is deliberately
// asymmetric -- three joints in front, four behind, and a hind leg that zig-zags
// -- because that is the shape Tripo actually returns and the reason the solver
// is CCD rather than a two-bone analytic. One skeleton carries two maps, because
// a body plan is a reading of a rig rather than a different rig: every plan under
// anim/clips needs an entry in FIXTURES or its specs go unchecked, and the gate
// says so rather than quietly skipping them. When a rigged creature IS on disk,
// its shipped clips get measured too, against its own plan's library.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGlb, writeGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { bakeClip, readClip } from '../tools/creatures/anim/bake.mjs'
import { bend, diagnose, footAt, limbSetup, poser, solveClip, solveLimb } from '../tools/creatures/anim/gait.mjs'
import { poseClip } from '../tools/creatures/anim/pose.mjs'
import { buildClip, clipNames, planOf, plans, readSpec } from '../tools/creatures/anim/build.mjs'
import { loadSkeleton, dot, len, sub } from '../tools/creatures/anim/skeleton.mjs'
import { readRigMap, workDir } from '../tools/creatures/anim/rig-map.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }
const mm = (v) => `${(v * 1000).toFixed(1)}mm`
const deg = (r) => `${(r * 180 / Math.PI).toFixed(2)} deg`

// --- the fixture ------------------------------------------------------------

// World joint positions: +Z forward, +X lateral, ground at y = 0.02. Every leg
// carries a rest bend, because a dead-straight joint has no hinge axis to
// preserve and the solver leaves it rigid on purpose -- a fixture built straight
// would test nothing.
const JOINTS = {
  Back: [0, 0.60, 0],
  Torso: [0, 0.61, 0.12],
  Chest: [0, 0.62, 0.24],
  Neck: [0, 0.66, 0.32],
  Head: [0, 0.70, 0.40],
  Tail1: [0, 0.58, -0.06],
  Tail2: [0, 0.55, -0.16],
  Tail3: [0, 0.52, -0.26],
  // Front: three joints, the fewest `limbSetup` accepts, with the elbow well
  // behind the shoulder. One hinge is the hardest case for the solver -- see
  // `solveLimb` on why a short chain converges slowly -- so it belongs here.
  'FrontUpper.L': [0.08, 0.58, 0.24], 'FrontLower.L': [0.08, 0.33, 0.15], 'FrontFoot.L': [0.08, 0.02, 0.24],
  'FrontUpper.R': [-0.08, 0.58, 0.24], 'FrontLower.R': [-0.08, 0.33, 0.15], 'FrontFoot.R': [-0.08, 0.02, 0.24],
  // Hind: a zig-zag, stifle forward and hock back, which is what a two-bone
  // solve has to flatten.
  'HindUpper.L': [0.08, 0.58, -0.02], 'HindKnee.L': [0.08, 0.38, 0.07], 'HindHock.L': [0.08, 0.18, -0.04], 'HindFoot.L': [0.08, 0.02, 0.02],
  'HindUpper.R': [-0.08, 0.58, -0.02], 'HindKnee.R': [-0.08, 0.38, 0.07], 'HindHock.R': [-0.08, 0.18, -0.04], 'HindFoot.R': [-0.08, 0.02, 0.02],
  // Wings, for the wyvern reading of the same skeleton. The quadruped map does
  // not name them, so they hang inert off the chest and the four-legged checks
  // above are unaffected.
  'WingUpper.L': [0.06, 0.64, 0.20], 'WingMid.L': [0.20, 0.70, 0.14], 'WingTip.L': [0.34, 0.74, 0.06],
  'WingUpper.R': [-0.06, 0.64, 0.20], 'WingMid.R': [-0.20, 0.70, 0.14], 'WingTip.R': [-0.34, 0.74, 0.06],
}

const CHILDREN = {
  Back: ['Torso', 'Tail1', 'HindUpper.L', 'HindUpper.R'],
  Torso: ['Chest'],
  Chest: ['Neck', 'FrontUpper.L', 'FrontUpper.R', 'WingUpper.L', 'WingUpper.R'],
  Neck: ['Head'],
  Tail1: ['Tail2'], Tail2: ['Tail3'],
  'FrontUpper.L': ['FrontLower.L'], 'FrontLower.L': ['FrontFoot.L'],
  'FrontUpper.R': ['FrontLower.R'], 'FrontLower.R': ['FrontFoot.R'],
  'HindUpper.L': ['HindKnee.L'], 'HindKnee.L': ['HindHock.L'], 'HindHock.L': ['HindFoot.L'],
  'HindUpper.R': ['HindKnee.R'], 'HindKnee.R': ['HindHock.R'], 'HindHock.R': ['HindFoot.R'],
  'WingUpper.L': ['WingMid.L'], 'WingMid.L': ['WingTip.L'],
  'WingUpper.R': ['WingMid.R'], 'WingMid.R': ['WingTip.R'],
}

const MAP = {
  frame: { forward: [0, 0, 1], lateral: [1, 0, 0], centre: [0, 0.36, 0.07], yawDegrees: 90 },
  ground: 0.02,
  height: 0.68,
  wheelbase: 0.22,
  spine: ['Back', 'Torso', 'Chest'],
  head: ['Neck', 'Head'],
  tail: ['Tail1', 'Tail2', 'Tail3'],
  legs: [
    { id: 'frontLeft', foot: 'FrontFoot.L', attach: 'Chest', chain: ['FrontUpper.L', 'FrontLower.L', 'FrontFoot.L'] },
    { id: 'frontRight', foot: 'FrontFoot.R', attach: 'Chest', chain: ['FrontUpper.R', 'FrontLower.R', 'FrontFoot.R'] },
    { id: 'hindLeft', foot: 'HindFoot.L', attach: 'Back', chain: ['HindUpper.L', 'HindKnee.L', 'HindHock.L', 'HindFoot.L'] },
    { id: 'hindRight', foot: 'HindFoot.R', attach: 'Back', chain: ['HindUpper.R', 'HindKnee.R', 'HindHock.R', 'HindFoot.R'] },
  ],
}

// The same skeleton read as a wyvern: it stands on the hind pair, the front pair
// becomes arms it cannot walk on, and the wings are driven as a mirrored pair.
// A body plan is a reading of a rig, not a different rig, and gating both off one
// fixture is what keeps that honest.
const WYVERN_MAP = {
  ...MAP,
  wheelbase: 0.25,
  legs: MAP.legs.filter((l) => l.id.startsWith('hind')),
  arms: [
    { id: 'armLeft', side: 1, chain: ['FrontUpper.L', 'FrontLower.L', 'FrontFoot.L'] },
    { id: 'armRight', side: -1, chain: ['FrontUpper.R', 'FrontLower.R', 'FrontFoot.R'] },
  ],
  wings: [
    { id: 'wingLeft', side: 1, chain: ['WingUpper.L', 'WingMid.L', 'WingTip.L'] },
    { id: 'wingRight', side: -1, chain: ['WingUpper.R', 'WingMid.R', 'WingTip.R'] },
  ],
}

const FIXTURES = { quadruped: MAP, wyvern: WYVERN_MAP }

/**
 * Write the fixture as a rigged GLB. Every node carries an identity rotation and
 * a translation equal to its offset from its parent, so a joint's world position
 * is exactly the table above -- which is what lets the checks state expected
 * geometry as numbers instead of deriving it the same way the code under test
 * does. The BIN chunk is a stub: nothing here is skinned, but `bakeClip` appends
 * its samples to a buffer and so needs one to exist.
 */
function writeFixture() {
  const names = Object.keys(JOINTS)
  const index = new Map(names.map((n, i) => [n, i]))
  const parentOf = new Map()
  for (const [p, kids] of Object.entries(CHILDREN)) for (const k of kids) parentOf.set(k, p)

  const nodes = names.map((n) => {
    const from = parentOf.has(n) ? JOINTS[parentOf.get(n)] : [0, 0, 0]
    const node = {
      name: n,
      translation: [JOINTS[n][0] - from[0], JOINTS[n][1] - from[1], JOINTS[n][2] - from[2]],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }
    if (CHILDREN[n]) node.children = CHILDREN[n].map((k) => index.get(k))
    return node
  })
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [index.get('Back')] }],
    nodes,
    skins: [{ joints: names.map((n) => index.get(n)) }],
    buffers: [{ byteLength: 4 }],
    bufferViews: [],
    accessors: [],
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anim-'))
  const file = path.join(dir, 'fixture.glb')
  writeGlb(file, json, Buffer.alloc(4))
  return file
}

const FIXTURE = writeFixture()
const skel = loadSkeleton(FIXTURE)
const byName = new Map(skel.joints.map((j) => [skel.name(j), j]))
const named = (n) => byName.get(n)

const WALK = {
  duration: 1, samples: 16, stride: 0.5, stepHeight: 0.1, duty: 0.62, crouch: 0.05, toeOff: 0.3,
  phases: { hindLeft: 0, frontLeft: 0.25, hindRight: 0.5, frontRight: 0.75 },
  bodyBob: 0.01, bodySway: 0.008, spineYaw: 0.1, tailPitch: 0.4, tailSway: 0.2,
}

// --- the footfall cycle -----------------------------------------------------

console.log('\nthe footfall cycle')
{
  const spec = { stride: 0.4, duty: 0.6, stepHeight: 0.12, toeOff: 0.3 }
  const at = (p) => footAt(p, spec)

  check(at(0).fore === 0.2 && Math.abs(at(0.6 - 1e-9).fore + 0.2) < 1e-6,
    'stance carries the foot from a half stride ahead to a half stride behind')
  // Linear, not eased: the body advances at a constant speed, so anything else
  // slides a planted foot in the ground's frame however smooth it looks alone.
  const steps = []
  for (let i = 1; i < 12; i++) steps.push(at((i / 12) * 0.6).fore - at(((i - 1) / 12) * 0.6).fore)
  check(Math.max(...steps) - Math.min(...steps) < 1e-9, 'and does it linearly, at a constant speed')

  check([0, 0.3, 0.59].every((p) => at(p).planted) && [0.6, 0.8, 0.99].every((p) => !at(p).planted),
    'planted is exactly the stance fraction')
  check([0, 0.3, 0.59].every((p) => at(p).lift === 0), 'a planted foot never leaves the ground')
  check(Math.abs(at(0.8).lift - 0.12) < 1e-9 && [0.65, 0.95].every((p) => at(p).lift > 0),
    'and a swinging one arcs to exactly the step height at mid-swing')
  check(Math.abs(at(0.9999).fore - at(0).fore) < 1e-3 && at(0.9999).lift < 1e-3,
    'the cycle closes: the end of swing meets the start of stance')

  // The paw is flat through the part of stance that bears weight, and flat again
  // well before it lands. Ramping either from the instant of contact puts the
  // animal on tiptoe for the whole step.
  check(at(0.1).pitch === 0 && at(0.3).pitch === 0, 'the paw stays flat through early stance')
  check(at(0.59).pitch > 0.25, 'rolls up for toe-off at the end of it', at(0.59).pitch.toFixed(3))
  check(at(0.85).pitch < 1e-6, 'and is level again long before heel strike', at(0.85).pitch.toFixed(3))
}

// --- the limb solver --------------------------------------------------------

console.log('\nthe limb solver')
{
  const limbs = MAP.legs.map((l) => limbSetup(skel, l, byName))
  const [front, , hind] = limbs

  check(front.chain.length === 3 && hind.chain.length === 4,
    'a leg is whatever chain the rig map names, three joints or four')
  const hindBones = ['HindUpper.L', 'HindKnee.L', 'HindHock.L', 'HindFoot.L']
  let summed = 0
  for (let i = 1; i < hindBones.length; i++) summed += len(sub(JOINTS[hindBones[i]], JOINTS[hindBones[i - 1]]))
  check(Math.abs(hind.reach - summed) < 1e-9,
    'reach is the summed bone length, not the hip-to-foot distance',
    `${hind.reach.toFixed(4)} vs ${len(sub(hind.restFoot, JOINTS['HindUpper.L'])).toFixed(4)} straight`)
  check(limbs.every((l) => l.hinge.slice(1, l.chain.length - 1).every((h) => h && Math.abs(len(h) - 1) < 1e-9)),
    'and every interior joint has a unit bend axis taken from its rest pose')

  // The hind chain's two hinges bend in OPPOSITE senses. That zig-zag is the
  // whole reason the solver cannot be a two-bone analytic with a pole vector.
  check(dot(hind.hinge[1], hind.hinge[2]) < -0.5,
    'a hind leg zig-zags: its two hinges face opposite ways',
    dot(hind.hinge[1], hind.hinge[2]).toFixed(3))

  const residual = (limb, target) => {
    const pose = poser(skel)
    solveLimb(pose, limb, target)
    return len(sub(pose.pos(limb.foot), target))
  }
  check(limbs.every((l) => residual(l, l.restFoot) < 1e-6),
    'solving for the rest position leaves the leg exactly where it was')
  const reached = limbs.map((l) => Math.max(
    residual(l, [l.restFoot[0], l.restFoot[1], l.restFoot[2] + 0.05]),
    residual(l, [l.restFoot[0], l.restFoot[1], l.restFoot[2] - 0.05]),
    residual(l, [l.restFoot[0], l.restFoot[1] + 0.06, l.restFoot[2]])))
  check(Math.max(...reached) < 2e-3, 'and a target inside the leg is hit to under 2mm',
    reached.map(mm).join(' '))

  // A hinge may fold, and may straighten back out only as far as the rest bend
  // it started with. Past that it has inverted -- which the foot position alone
  // would never report, because an inverted knee still puts the paw on target.
  const strain = limbs.map((limb) => {
    const pose = poser(skel)
    const applied = solveLimb(pose, limb, [limb.restFoot[0], limb.restFoot[1] - 0.5, limb.restFoot[2] + 0.5])
    let worst = -Infinity
    for (let i = 1; i < limb.chain.length - 1; i++) {
      worst = Math.max(worst, -applied[i] - limb.restBend[i] * 0.85, applied[i] - 1.9)
    }
    return worst
  })
  check(Math.max(...strain) < 1e-9,
    'a target far out of reach stops at the joint stops rather than inverting a knee',
    strain.map((v) => v.toFixed(5)).join(' '))

  // The paw is the chain's leaf, so nothing downstream depends on it -- but left
  // alone it inherits every correction the joints above made and ploughs into
  // the ground through the step.
  const pose = poser(skel)
  solveLimb(pose, front, [front.restFoot[0], front.restFoot[1], front.restFoot[2] + 0.04])
  const q = pose.rotation(front.foot)
  check(Math.abs(Math.abs(q.reduce((s, v, i) => s + v * front.footRest[i], 0)) - 1) < 1e-6,
    'and the paw is levelled back to its rest orientation afterwards')
}

// --- carriage ---------------------------------------------------------------

console.log('\ncarriage')
{
  const lateral = MAP.frame.lateral
  const tipY = (chain, total) => {
    const pose = poser(skel)
    bend(pose, chain.map(named), lateral, total)
    return pose.pos(named(chain[chain.length - 1]))[1]
  }
  // Sign follows the chain, not the body: one positive number pitches a
  // forward-pointing chain down and lifts a backward-pointing one.
  check(tipY(MAP.head, 0.4) < tipY(MAP.head, 0),
    'positive pitch about the lateral axis drops a forward chain: the head nods down')
  check(tipY(MAP.tail, 0.4) > tipY(MAP.tail, 0),
    'and raises a backward one: the same sign carries the tail high')

  // The angle accumulates down the chain, so the tip takes all of it and the
  // base a fraction: a curl, not a rigid swing.
  const pose = poser(skel)
  bend(pose, MAP.tail.map(named), lateral, 0.6)
  const moved = MAP.tail.map((n) => len(sub(pose.pos(named(n)), JOINTS[n])))
  check(moved[0] < moved[1] && moved[1] < moved[2], 'and accumulates along it, so a tail curls rather than swings',
    moved.map(mm).join(' '))

  // The body's rise and fall is the one non-rotation channel, and glTF writes a
  // translation in the joint's PARENT space. An error there scales the bob
  // instead of erroring.
  const lifted = poser(skel)
  lifted.setOffset([0, -0.05, 0.02])
  const head = lifted.pos(named('Head'))
  check(Math.abs(head[1] - (JOINTS.Head[1] - 0.05)) < 1e-9 && Math.abs(head[2] - (JOINTS.Head[2] + 0.02)) < 1e-9,
    'a world offset on the root carries every joint by exactly that vector')
  const rootT = lifted.localTranslation(lifted.roots[0])
  check(Math.abs(rootT[1] - (JOINTS.Back[1] - 0.05)) < 1e-9 && Math.abs(rootT[2] - (JOINTS.Back[2] + 0.02)) < 1e-9,
    'and lands in the root translation the clip writes')
}

// --- a solved gait ----------------------------------------------------------

console.log('\na solved gait')
{
  const solved = solveClip(FIXTURE, MAP, WALK)
  const stats = diagnose(solved)

  check(solved.times.length === WALK.samples + 1, 'a clip samples its whole duration, both ends included')
  const short = [...solved.tracks].filter(([, q]) => q.length !== (WALK.samples + 1) * 4)
  check(short.length === 0, 'and every driven joint gets a rotation at every sample',
    short.map(([j]) => skel.name(j)).join(' '))
  check(solved.rootTranslations.length === (WALK.samples + 1) * 3, 'plus one root translation per sample')

  check(stats.stanceSlide < 1e-3, 'a planted foot holds still in the ground frame', mm(stats.stanceSlide))
  check(stats.ikStance < 1e-3, 'because the leg actually reaches its stance target', mm(stats.ikStance))
  check(stats.penetration < 1e-3, 'and no foot goes through the floor', mm(stats.penetration))
  check(stats.stanceFloat < 1e-3, 'nor skates above it', mm(stats.stanceFloat))
  check(stats.loopGap < 1e-3, 'the clip returns to its first pose, so it loops without a pop', deg(stats.loopGap))
  check(Math.abs(stats.speed - (WALK.stride * MAP.wheelbase) / (WALK.duty * WALK.duration)) < 1e-12,
    'and reports the forward speed its stride implies', `${stats.speed.toFixed(3)} m/s`)

  // Every foot has to take a turn. A phase table that collapsed -- all four feet
  // on the same beat -- would still solve, and would read as a hop.
  const swings = new Map(MAP.legs.map((l) => [l.id, 0]))
  let planted = 0
  for (const f of solved.frames.flatMap((fr) => fr.feet)) {
    if (f.planted) planted++
    else swings.set(f.id, swings.get(f.id) + 1)
  }
  check([...swings.values()].every((v) => v > 0), 'all four legs swing at some point in the cycle',
    [...swings].map(([k, v]) => `${k}:${v}`).join(' '))
  check(planted > 0 && planted < solved.frames.length * 4,
    'and in any one frame some feet are planted and some are not', `${planted} planted samples`)

  // The body bob is paid for out of leg slack, and a Tripo bind leaves almost
  // none: a planted foot at near-full extension cannot follow the body up. Gate
  // the coupling, not the numbers -- raising the bob without deepening the
  // crouch is exactly how a clip starts skating.
  const bobbier = diagnose(solveClip(FIXTURE, MAP, { ...WALK, bodyBob: 0.12 }))
  check(bobbier.stanceSlide > stats.stanceSlide * 4,
    'lifting the body further than the legs have slack shows up as slide',
    `${mm(stats.stanceSlide)} -> ${mm(bobbier.stanceSlide)}`)
  const deeper = diagnose(solveClip(FIXTURE, MAP, { ...WALK, bodyBob: 0.12, crouch: 0.16 }))
  check(deeper.stanceSlide < bobbier.stanceSlide / 2, 'and crouching deeper is what buys that slack back',
    `${mm(bobbier.stanceSlide)} -> ${mm(deeper.stanceSlide)}`)
}

// --- a keyframed pose -------------------------------------------------------

console.log('\na keyframed pose')
{
  const held = {
    root: { lift: -0.18 }, spine: { pitch: -0.35 }, head: { pitch: 0.2 }, tail: { pitch: 0.8 },
    legs: { hindLeft: { fore: 0.2 }, hindRight: { fore: 0.2 } },
  }
  const SIT = {
    kind: 'pose', samples: 20, limits: { hipLimit: 1.5 },
    // A first key entirely at rest: the case that used to write no rotation at
    // all and bake a track a sample short.
    keys: [{ t: 0, pose: {} }, { t: 1, pose: held }, { t: 2, pose: held }],
  }
  const solved = poseClip(FIXTURE, MAP, SIT)
  const stats = diagnose(solved)

  const short = [...solved.tracks].filter(([, q]) => q.length !== (SIT.samples + 1) * 4)
  check(short.length === 0, 'a key left entirely at rest still writes a rotation for every joint it drives',
    short.map(([j]) => skel.name(j)).join(' '))
  check(stats.speed === 0, 'a pose clip has no stride, so it implies no ground speed')
  check(stats.ikStance < 1e-3, 'the feet reach where the keys put them', mm(stats.ikStance))
  check(stats.penetration < 1e-3, 'and stay out of the floor', mm(stats.penetration))

  const last = solved.frames[solved.frames.length - 1]
  check(last.feet.every((f) => f.planted),
    'a foot the keys never lift off the ground counts as load-bearing throughout')
  check(last.feet.every((f) => Math.abs(f.actual[1] - MAP.ground) < 1e-3),
    'and is still on the ground once the body has folded down',
    last.feet.map((f) => mm(f.actual[1] - MAP.ground)).join(' '))

  // The joint limits a walk runs under are too tight for a sit, so widening them
  // is the spec's job. A spec that narrows them instead must actually bind.
  const tight = diagnose(poseClip(FIXTURE, MAP, { ...SIT, limits: { hipLimit: 0.05, fold: 0.1 } }))
  check(tight.ikStance > stats.ikStance * 2, 'a spec that narrows the joint limits cannot reach as far',
    `${mm(stats.ikStance)} -> ${mm(tight.ikStance)}`)

  check(throws(() => poseClip(FIXTURE, MAP, { kind: 'pose', keys: [{ t: 0 }] })),
    'one key is not an animation')
  check(throws(() => poseClip(FIXTURE, MAP, { kind: 'pose', keys: [{ t: 1 }, { t: 0 }] })),
    'and keys running backwards in time are rejected rather than silently sorted')
}

// --- baking -----------------------------------------------------------------

console.log('\nbaking')
{
  const solved = solveClip(FIXTURE, MAP, WALK)
  const out = path.join(path.dirname(FIXTURE), 'anim-walk.glb')
  const baked = bakeClip({
    source: FIXTURE, out, name: 'walk',
    times: solved.times, tracks: solved.tracks, root: solved.root, rootTranslations: solved.rootTranslations,
  })
  const { json } = readGlb(out)

  check(json.animations?.length === 1, 'a clip bakes to exactly one animation, which is all the bench plays')
  check(baked.channels === solved.tracks.size + 1, 'one channel per driven joint, plus the root translation',
    `${baked.channels} channels`)

  const read = readClip(out)
  const translations = json.animations[0].channels.filter((c) => c.target.path === 'translation')
  check(translations.length === 1 && translations[0].target.node === solved.root,
    'and the only translation channel is on the root joint, so the clip retargets', skel.name(solved.root))
  check(read.targets.includes('HindHock.L') && read.targets.includes('Tail3'),
    'legs and tail both make it into the file')

  // A sampler input with no min/max leaves a player guessing the duration, and
  // three.js reads a missing max as a zero-length clip.
  const inputs = [...new Set(json.animations[0].samplers.map((s) => s.input))]
  check(inputs.every((i) => json.accessors[i].min?.length === 1 && json.accessors[i].max?.length === 1),
    'every time accessor declares its range')
  check(Math.abs(read.duration - WALK.duration) < 1e-6, 'and that range is the clip duration', `${read.duration}s`)

  check(throws(() => bakeClip({
    source: FIXTURE, out, name: 'short', times: solved.times, tracks: new Map([[0, [0, 0, 0, 1]]]),
  })), 'a track short of its sample times is refused rather than written')
}

// --- the shipped specs ------------------------------------------------------

console.log('\nthe shipped clip specs')
for (const plan of plans()) {
  const map = FIXTURES[plan]
  check(!!map, `${plan} has a fixture to gate against`,
    map ? '' : 'add one to FIXTURES, or its specs go unchecked')
  if (!map) continue

  const names = clipNames(plan)
  check(names.length > 0, `${plan} has clips to build`, names.join(' '))
  const legIds = new Set(map.legs.map((l) => l.id))

  for (const name of names) {
    const spec = readSpec(name, plan)
    const bad = []
    if (!spec.note) bad.push('no note saying what the clip is for')
    if (spec.kind === 'pose') {
      if (!Array.isArray(spec.keys) || spec.keys.length < 2) bad.push('needs at least two keys')
      for (const k of spec.keys ?? []) {
        for (const id of Object.keys(k.pose?.legs ?? {})) if (!legIds.has(id)) bad.push(`unknown leg ${id}`)
      }
    } else {
      if (!(spec.duration > 0)) bad.push('no duration')
      if (!(spec.duty > 0 && spec.duty <= 1)) bad.push(`duty ${spec.duty} is not a stance fraction`)
      for (const id of Object.keys(spec.phases ?? {})) if (!legIds.has(id)) bad.push(`unknown leg ${id}`)
      // A moving gait with a partial phase table has feet silently sharing a
      // beat, which is a hop. How many legs that is depends on the body plan.
      if (spec.stride > 0 && Object.keys(spec.phases ?? {}).length !== legIds.size) {
        bad.push(`a moving gait needs a phase for each of the ${legIds.size} legs`)
      }
    }
    check(bad.length === 0, `${plan}/${name} is a well-formed ${spec.kind ?? 'gait'} spec`, bad.join('; '))
  }

  // The specs are tuned against one real rig, so their numbers only mean
  // something there. Solving them here proves they survive a skeleton they were
  // not written for, which is the rig-agnostic claim the whole solver rests on.
  for (const name of names) {
    const spec = readSpec(name, plan)
    const solved = spec.kind === 'pose' ? poseClip(FIXTURE, map, spec) : solveClip(FIXTURE, map, spec)
    const stats = diagnose(solved)
    check(stats.penetration < 1e-3 && stats.loopGap < 1e-3, `${plan}/${name} solves on a skeleton it was not tuned for`,
      `sink ${mm(stats.penetration)}  loop ${deg(stats.loopGap)}`)
  }
}

// --- the real creatures, when one is on disk --------------------------------

console.log('\nrigged creatures on disk')
{
  const root = path.dirname(workDir('x'))
  const rigged = fs.existsSync(root)
    ? fs.readdirSync(root).filter((id) => fs.existsSync(path.join(root, id, 'rig-map.json'))
      && ['rig-fixed.glb', 'rig.glb'].some((f) => fs.existsSync(path.join(root, id, f))))
    : []

  if (rigged.length === 0) {
    console.log('  --   none rigged under tools/creatures/work (gitignored); the fixture checks stand alone')
  }
  for (const id of rigged) {
    for (const name of clipNames(planOf(readRigMap(id)))) {
      const { spec, stats } = buildClip(id, name)
      // A pose clip may deliberately reposition a foot -- a sit scoots the hind
      // paws forward as the animal folds -- so its feet are allowed to travel.
      // A gait's are not.
      const bad = []
      if (stats.stanceSlide > (spec.kind === 'pose' ? 0.015 : 0.003)) bad.push(`slide ${mm(stats.stanceSlide)}`)
      if (stats.ikStance > 0.003) bad.push(`stance ik ${mm(stats.ikStance)}`)
      if (stats.penetration > 0.002) bad.push(`sink ${mm(stats.penetration)}`)
      if (stats.stanceFloat > 0.006) bad.push(`float ${mm(stats.stanceFloat)}`)
      if (stats.loopGap > 1e-3) bad.push(`loop ${deg(stats.loopGap)}`)
      check(bad.length === 0, `${id} ${name} holds its feet`, bad.join('  '))
    }
  }
}

fs.rmSync(path.dirname(FIXTURE), { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'all animation checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
