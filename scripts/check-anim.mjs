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
// is CCD rather than a two-bone analytic. One skeleton carries three maps, because
// a body plan is a reading of a rig rather than a different rig; the biped gets
// its own skeleton because toes and hanging arms are not a reading. Every plan
// under anim/clips needs an entry in FIXTURES or its specs go unchecked, and the
// gate says so rather than quietly skipping them. When a rigged creature IS on
// disk, its shipped clips get measured too, against its own plan's library.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGlb, writeGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { bakeClip, readClip } from '../tools/creatures/anim/bake.mjs'
import { bend, diagnose, footAt, limbSetup, poser, solveClip, solveLimb } from '../tools/creatures/anim/gait.mjs'
import { poseClip } from '../tools/creatures/anim/pose.mjs'
import { buildClip, clipNames, planOf, plans, readSpec } from '../tools/creatures/anim/build.mjs'
import { loadSkeleton, dot, len, sub } from '../tools/creatures/anim/skeleton.mjs'
import { buildRigMap, readRigMap, workDir } from '../tools/creatures/anim/rig-map.mjs'

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
  // Two more pairs of legs, sideways and arched like a spider's, for the spider
  // reading. Only that map names them; to the other two they hang inert.
  'MidAUpper.L': [0.10, 0.58, 0.16], 'MidAKnee.L': [0.26, 0.66, 0.16], 'MidAHock.L': [0.40, 0.30, 0.16], 'MidAFoot.L': [0.46, 0.02, 0.16],
  'MidAUpper.R': [-0.10, 0.58, 0.16], 'MidAKnee.R': [-0.26, 0.66, 0.16], 'MidAHock.R': [-0.40, 0.30, 0.16], 'MidAFoot.R': [-0.46, 0.02, 0.16],
  'MidBUpper.L': [0.10, 0.58, 0.04], 'MidBKnee.L': [0.26, 0.66, 0.04], 'MidBHock.L': [0.40, 0.30, 0.04], 'MidBFoot.L': [0.46, 0.02, 0.04],
  'MidBUpper.R': [-0.10, 0.58, 0.04], 'MidBKnee.R': [-0.26, 0.66, 0.04], 'MidBHock.R': [-0.40, 0.30, 0.04], 'MidBFoot.R': [-0.46, 0.02, 0.04],
}

const CHILDREN = {
  Back: ['Torso', 'Tail1', 'HindUpper.L', 'HindUpper.R', 'MidBUpper.L', 'MidBUpper.R'],
  Torso: ['Chest'],
  Chest: ['Neck', 'FrontUpper.L', 'FrontUpper.R', 'WingUpper.L', 'WingUpper.R', 'MidAUpper.L', 'MidAUpper.R'],
  Neck: ['Head'],
  Tail1: ['Tail2'], Tail2: ['Tail3'],
  'FrontUpper.L': ['FrontLower.L'], 'FrontLower.L': ['FrontFoot.L'],
  'FrontUpper.R': ['FrontLower.R'], 'FrontLower.R': ['FrontFoot.R'],
  'HindUpper.L': ['HindKnee.L'], 'HindKnee.L': ['HindHock.L'], 'HindHock.L': ['HindFoot.L'],
  'HindUpper.R': ['HindKnee.R'], 'HindKnee.R': ['HindHock.R'], 'HindHock.R': ['HindFoot.R'],
  'WingUpper.L': ['WingMid.L'], 'WingMid.L': ['WingTip.L'],
  'WingUpper.R': ['WingMid.R'], 'WingMid.R': ['WingTip.R'],
  'MidAUpper.L': ['MidAKnee.L'], 'MidAKnee.L': ['MidAHock.L'], 'MidAHock.L': ['MidAFoot.L'],
  'MidAUpper.R': ['MidAKnee.R'], 'MidAKnee.R': ['MidAHock.R'], 'MidAHock.R': ['MidAFoot.R'],
  'MidBUpper.L': ['MidBKnee.L'], 'MidBKnee.L': ['MidBHock.L'], 'MidBHock.L': ['MidBFoot.L'],
  'MidBUpper.R': ['MidBKnee.R'], 'MidBKnee.R': ['MidBHock.R'], 'MidBHock.R': ['MidBFoot.R'],
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

// And as a spider: the front and hind pairs are legs I and IV, the two mid pairs
// II and III, the tail is the abdomen, and the wing chains stand in for the
// chelicerae, which a spider spec drives through the same `arms` handles.
const SPIDER_MAP = {
  ...MAP,
  legs: [
    ...MAP.legs.filter((l) => l.id.startsWith('front')).map((l) => ({ ...l, id: l.id === 'frontLeft' ? 'leg1Left' : 'leg1Right' })),
    { id: 'leg2Left', foot: 'MidAFoot.L', attach: 'Chest', chain: ['MidAUpper.L', 'MidAKnee.L', 'MidAHock.L', 'MidAFoot.L'] },
    { id: 'leg2Right', foot: 'MidAFoot.R', attach: 'Chest', chain: ['MidAUpper.R', 'MidAKnee.R', 'MidAHock.R', 'MidAFoot.R'] },
    { id: 'leg3Left', foot: 'MidBFoot.L', attach: 'Back', chain: ['MidBUpper.L', 'MidBKnee.L', 'MidBHock.L', 'MidBFoot.L'] },
    { id: 'leg3Right', foot: 'MidBFoot.R', attach: 'Back', chain: ['MidBUpper.R', 'MidBKnee.R', 'MidBHock.R', 'MidBFoot.R'] },
    ...MAP.legs.filter((l) => l.id.startsWith('hind')).map((l) => ({ ...l, id: l.id === 'hindLeft' ? 'leg4Left' : 'leg4Right' })),
  ],
  arms: WYVERN_MAP.wings,
}

// A biped is not a reading of that skeleton: it has toes, a pelvis both legs
// share, and arms that hang off the chest through a clavicle. So it gets its
// own, +Z forward again, with a small forward crease at each knee and elbow so
// both have a hinge to keep.
const HUMAN_JOINTS = {
  Pelvis: [0, 0.52, 0],
  Spine1: [0, 0.62, 0.01],
  Chest: [0, 0.74, 0.02],
  Neck: [0, 0.84, 0.02],
  Head: [0, 0.96, 0.03],
  'Hip.L': [0.09, 0.50, 0], 'Knee.L': [0.09, 0.27, 0.02], 'Ankle.L': [0.09, 0.05, 0], 'Toe.L': [0.09, 0.02, 0.10],
  'Hip.R': [-0.09, 0.50, 0], 'Knee.R': [-0.09, 0.27, 0.02], 'Ankle.R': [-0.09, 0.05, 0], 'Toe.R': [-0.09, 0.02, 0.10],
  'Clavicle.L': [0.04, 0.72, 0.02], 'Shoulder.L': [0.15, 0.70, 0.02], 'Elbow.L': [0.16, 0.48, 0.04], 'Wrist.L': [0.17, 0.27, 0.02], 'Hand.L': [0.17, 0.21, 0.03],
  'Clavicle.R': [-0.04, 0.72, 0.02], 'Shoulder.R': [-0.15, 0.70, 0.02], 'Elbow.R': [-0.16, 0.48, 0.04], 'Wrist.R': [-0.17, 0.27, 0.02], 'Hand.R': [-0.17, 0.21, 0.03],
}

const HUMAN_CHILDREN = {
  Pelvis: ['Spine1', 'Hip.L', 'Hip.R'],
  Spine1: ['Chest'],
  Chest: ['Neck', 'Clavicle.L', 'Clavicle.R'],
  Neck: ['Head'],
  'Hip.L': ['Knee.L'], 'Knee.L': ['Ankle.L'], 'Ankle.L': ['Toe.L'],
  'Hip.R': ['Knee.R'], 'Knee.R': ['Ankle.R'], 'Ankle.R': ['Toe.R'],
  'Clavicle.L': ['Shoulder.L'], 'Shoulder.L': ['Elbow.L'], 'Elbow.L': ['Wrist.L'], 'Wrist.L': ['Hand.L'],
  'Clavicle.R': ['Shoulder.R'], 'Shoulder.R': ['Elbow.R'], 'Elbow.R': ['Wrist.R'], 'Wrist.R': ['Hand.R'],
}

// Written the way rig-map.mjs writes a biped: legs solved to the ankle with the
// toe named as its rigid child, a lateral hinge axis for the near-straight knee,
// and arms annotated shoulder, elbow, wrist so the jointed handles apply.
const HUMAN_MAP = {
  plan: 'human',
  frame: { forward: [0, 0, 1], lateral: [1, 0, 0], centre: [0, 0.50, 0], yawDegrees: 90 },
  ground: 0.02,
  height: 0.94,
  wheelbase: 0.48,
  spine: ['Spine1', 'Chest'],
  head: ['Neck', 'Head'],
  tail: [],
  legs: [
    { id: 'legLeft', foot: 'Ankle.L', toe: 'Toe.L', attach: 'Pelvis', chain: ['Hip.L', 'Knee.L', 'Ankle.L'], hingeAxis: [1, 0, 0] },
    { id: 'legRight', foot: 'Ankle.R', toe: 'Toe.R', attach: 'Pelvis', chain: ['Hip.R', 'Knee.R', 'Ankle.R'], hingeAxis: [1, 0, 0] },
  ],
  arms: [
    { id: 'armLeft', side: 1, chain: ['Clavicle.L', 'Shoulder.L', 'Elbow.L', 'Wrist.L', 'Hand.L'], shoulder: 'Shoulder.L', elbow: 'Elbow.L', wrist: 'Wrist.L' },
    { id: 'armRight', side: -1, chain: ['Clavicle.R', 'Shoulder.R', 'Elbow.R', 'Wrist.R', 'Hand.R'], shoulder: 'Shoulder.R', elbow: 'Elbow.R', wrist: 'Wrist.R' },
  ],
}

const FIXTURES = { quadruped: MAP, wyvern: WYVERN_MAP, spider: SPIDER_MAP, human: HUMAN_MAP }

/** The handle groups a pose key may name -- and so the ones `scale` may dial. */
const GROUPS = new Set(['root', 'spine', 'head', 'tail', 'wings', 'arms', 'legs'])

/**
 * Write the fixture as a rigged GLB. Every node carries an identity rotation and
 * a translation equal to its offset from its parent, so a joint's world position
 * is exactly the table above -- which is what lets the checks state expected
 * geometry as numbers instead of deriving it the same way the code under test
 * does. The BIN chunk is a stub: nothing here is skinned, but `bakeClip` appends
 * its samples to a buffer and so needs one to exist.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anim-'))
function writeFixture(name, joints, children) {
  const names = Object.keys(joints)
  const index = new Map(names.map((n, i) => [n, i]))
  const parentOf = new Map()
  for (const [p, kids] of Object.entries(children)) for (const k of kids) parentOf.set(k, p)

  const nodes = names.map((n) => {
    const from = parentOf.has(n) ? joints[parentOf.get(n)] : [0, 0, 0]
    const node = {
      name: n,
      translation: [joints[n][0] - from[0], joints[n][1] - from[1], joints[n][2] - from[2]],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }
    if (children[n]) node.children = children[n].map((k) => index.get(k))
    return node
  })
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [index.get(names[0])] }],
    nodes,
    skins: [{ joints: names.map((n) => index.get(n)) }],
    buffers: [{ byteLength: 4 }],
    bufferViews: [],
    accessors: [],
  }
  const file = path.join(TMP, `${name}.glb`)
  writeGlb(file, json, Buffer.alloc(4))
  return file
}

const FIXTURE = writeFixture('fixture', JOINTS, CHILDREN)
const HUMAN_FIXTURE = writeFixture('human', HUMAN_JOINTS, HUMAN_CHILDREN)
/** The skeleton a plan's specs are solved on. */
const SKELETON_OF = { human: HUMAN_FIXTURE }
const skeletonOf = (plan) => SKELETON_OF[plan] ?? FIXTURE
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

  // `ground` is the lowest joint in the whole rig, which need not be a foot: on
  // a Tripo hare the hind pair are ankles 16cm up. Measuring plantedness against
  // that one plane reads those legs as permanently airborne, and an airborne leg
  // is exempt from the slide check -- so the clip skates and the gate says
  // nothing. Each leg is judged against its OWN rest foot instead.
  const sunk = poseClip(FIXTURE, { ...MAP, ground: MAP.ground - 0.1 }, SIT)
  check(sunk.frames[sunk.frames.length - 1].feet.every((f) => f.planted),
    'a foot above the rig\'s lowest joint is still load-bearing, not airborne')

  // A digging forepaw rakes backwards at its own rest height, so by geometry it
  // is planted -- but it carries nothing, and scoring it as stance reports the
  // intended stroke as skating.
  // One paw strokes back and forth; every other foot holds still. Whether that
  // is a defect is not something the geometry can answer -- the paw is at its
  // rest height either way -- so the spec has to say.
  const stroke = (t) => ({ t, pose: { legs: { frontLeft: { fore: t % 2 ? 0.25 : -0.25 } } } })
  const raked = { kind: 'pose', samples: 24, unweighted: ['frontLeft'], keys: [stroke(0), stroke(1), stroke(2)] }
  const mid = poseClip(FIXTURE, MAP, raked).frames[6].feet
  check(mid.find((f) => f.id === 'frontLeft').planted === false
    && mid.filter((f) => f.id !== 'frontLeft').every((f) => f.planted),
    'a foot the spec declares unweighted drops out of stance, and only that foot')
  const slideOf = (spec) => diagnose(poseClip(FIXTURE, MAP, spec)).stanceSlide
  check(slideOf(raked) < 1e-9 && slideOf({ ...raked, unweighted: [] }) > 1e-3,
    'so a rake costs the clip nothing, where the same stroke standing on it reads as a skid',
    `${mm(slideOf(raked))} raking, ${mm(slideOf({ ...raked, unweighted: [] }))} standing`)

  // A shared spec is relative, so it mostly carries across bodies -- and where
  // it does not, `scale` dials one group down for one animal.
  const offset = (spec) => {
    const feet = poseClip(FIXTURE, MAP, spec).frames.at(-1).feet
    return feet.find((f) => f.id === 'hindLeft').target[2] - JOINTS['HindFoot.L'][2]
  }
  check(Math.abs(offset({ ...SIT, scale: { legs: 0.5 } }) - offset(SIT) * 0.5) < 1e-9,
    'scaling a group takes exactly that fraction of every handle in it',
    `${mm(offset(SIT))} -> ${mm(offset({ ...SIT, scale: { legs: 0.5 } }))}`)

  const tailRest = (spec) => {
    const { tracks } = poseClip(FIXTURE, MAP, spec)
    return MAP.tail.every((n) => tracks.get(named(n)).every((v, i) => Math.abs(v - (i % 4 === 3 ? 1 : 0)) < 1e-9))
  }
  check(tailRest({ ...SIT, scale: { tail: 0 } }) && !tailRest(SIT),
    'a group scaled to zero stops moving, and only that group',
    `legs still reach ${mm(offset({ ...SIT, scale: { tail: 0 } }))}`)
  check(Math.abs(offset({ ...SIT, scale: { tail: 0 } }) - offset(SIT)) < 1e-9,
    'so dialling the tail back leaves the feet exactly where they were')

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

// --- a biped rig map --------------------------------------------------------

console.log('\na biped rig map')
{
  const map = buildRigMap(HUMAN_FIXTURE)
  check(map.plan === 'human', 'two feet on the ground read as a human', `plan ${map.plan}`)
  check(map.frame.forward.join() === '0,0,1', 'the toes say which way it faces', `forward ${map.frame.forward.join(',')}`)
  const legs = Object.fromEntries(map.legs.map((l) => [l.id, l]))
  check(legs.legLeft?.foot === 'Ankle.L' && legs.legLeft?.toe === 'Toe.L' && legs.legRight?.foot === 'Ankle.R' && legs.legRight?.toe === 'Toe.R',
    'each leg is solved to the ankle with its toe named beside it', map.legs.map((l) => `${l.id} ${l.foot}+${l.toe}`).join('  '))
  check(legs.legLeft?.chain.join() === 'Hip.L,Knee.L,Ankle.L' && legs.legLeft?.attach === 'Pelvis' && legs.legLeft?.hingeAxis.join() === '1,0,0',
    'a leg runs hip, knee, ankle off the pelvis and hinges about the lateral axis', `${legs.legLeft?.chain.join(' ')} off ${legs.legLeft?.attach}`)
  const arms = Object.fromEntries((map.arms ?? []).map((a) => [a.id, a]))
  check(arms.armLeft?.shoulder === 'Shoulder.L' && arms.armLeft?.elbow === 'Elbow.L' && arms.armLeft?.wrist === 'Wrist.L' && arms.armRight?.side === -1,
    'an arm is annotated shoulder, elbow, wrist past its clavicle', `${arms.armLeft?.chain.join(' ')}: S ${arms.armLeft?.shoulder} E ${arms.armLeft?.elbow} W ${arms.armLeft?.wrist}`)
  check(map.spine.join() === 'Spine1,Chest' && map.head.join() === 'Neck,Head', 'the spine runs pelvis to chest and the head chest to skull',
    `spine ${map.spine.join(' ')}  head ${map.head.join(' ')}`)
  check(map.unclaimed.length === 0, 'every joint is claimed', map.unclaimed.join(' '))

  // Tripo leaves one leg of some villagers as a lone joint at hip height. That
  // figure cannot walk, and the map must refuse rather than derive a hopper.
  const joints = { ...HUMAN_JOINTS }
  for (const n of ['Knee.R', 'Ankle.R', 'Toe.R']) delete joints[n]
  const children = { ...HUMAN_CHILDREN }
  for (const n of ['Hip.R', 'Knee.R', 'Ankle.R']) delete children[n]
  check(throws(() => buildRigMap(writeFixture('one-legged', joints, children))), 'a biped with one foot on the ground refuses to be mapped')
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
      // Both of these are looked up by name at solve time, so a misspelling is
      // silent: the clip builds, the handle simply never moves.
      for (const id of spec.unweighted ?? []) if (!legIds.has(id)) bad.push(`unweighted names no leg ${id}`)
      for (const g of Object.keys(spec.scale ?? {})) if (!GROUPS.has(g)) bad.push(`scale names no handle group ${g}`)
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
    const file = skeletonOf(plan)
    const solved = spec.kind === 'pose' ? poseClip(file, map, spec) : solveClip(file, map, spec)
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
    // A tweak is laid over the shared spec by name, so one aimed at a clip that
    // does not exist -- or at a handle group that does not -- changes nothing
    // and says nothing. The animal reads as untuned and the map looks tuned.
    const map = readRigMap(id)
    const known = new Set(clipNames(planOf(map)))
    const stray = Object.entries(map.clipTweaks ?? {}).flatMap(([clip, tweak]) => [
      ...(known.has(clip) ? [] : [`no clip "${clip}"`]),
      ...Object.keys(tweak.scale ?? {}).filter((g) => !GROUPS.has(g)).map((g) => `${clip}.scale has no group "${g}"`),
    ])
    check(stray.length === 0, `${id} tweaks clips it actually has`, stray.join('; '))

    for (const name of clipNames(planOf(map))) {
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

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'all animation checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
