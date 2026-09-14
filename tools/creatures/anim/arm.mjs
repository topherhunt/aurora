/**
 * A jointed arm: shoulder, elbow, wrist, hand, each posed on its own.
 *
 * The mirrored `arms` pair in gait.mjs takes one angle and spreads it along the
 * whole chain, which is right for a forelimb tucked under a wyvern and useless
 * for a human: a wave is a raised upper arm, a bent elbow and a hand that flaps,
 * and no single number along seven joints produces that. So a rig map may
 * annotate an arm with `shoulder`, `elbow` and `wrist` (joint names inside its
 * `chain`), and an annotated arm is driven by these handles instead:
 *
 *   raise        swing at the shoulder about the body's lateral axis; positive
 *                brings the arm forward and up, pi points it at the sky
 *   spread       out to the side, positive away from the body on either arm
 *   twist        about the upper arm's own axis, positive turns the elbow
 *                crease inward on either arm
 *   elbow        flex, positive folds the hand toward the shoulder
 *   wristPitch   flex at the wrist in the same sense as the elbow
 *   wristSpread  bend the hand sideways, positive away from the body
 *   curl         fold the joints past the wrist, spread along them
 *
 * All radians, all DELTAS FROM THE REST POSE: Tripo binds an elbow forty degrees
 * bent and an upper arm thirty out from the flank, and a spec has no way to know
 * that, so `elbow: 0` keeps whatever bend the rig came with.
 *
 * Every axis is carried by the joint it turns: the elbow flexes about the
 * lateral axis as the shoulder has already rotated it, so raising the arm and
 * then bending the elbow brings the hand to the shoulder rather than to some
 * fixed point in the room, and a twist changes the plane the forearm folds in
 * exactly as a real humerus does.
 */

import { decompose, norm, qAxisAngle, qConj, qMul, qRotate, sub } from './skeleton.mjs'

export const ARM_HANDLES = ['raise', 'spread', 'twist', 'elbow', 'wristPitch', 'wristSpread', 'curl']

/** Whether a rig map's arm entry carries the joints these handles need. */
export const isJointed = (armMap) => armMap.shoulder !== undefined

/** Resolve one annotated arm to joints, with each joint's rest rotation for carrying axes. */
export function armSetup(skel, armMap, byName) {
  const chain = armMap.chain.map((n) => {
    const j = byName.get(n)
    if (j === undefined) throw new Error(`rig map arm "${armMap.id}" names joint "${n}", which this rig does not have`)
    return j
  })
  const at = (key) => {
    const i = armMap.chain.indexOf(armMap[key])
    if (i < 0) throw new Error(`rig map arm "${armMap.id}" has ${key} "${armMap[key]}" outside its chain`)
    return i
  }
  const s = at('shoulder'), e = at('elbow'), w = at('wrist')
  if (!(s < e && e < w)) throw new Error(`rig map arm "${armMap.id}" must run shoulder, elbow, wrist in chain order`)
  const restRot = new Map(chain.map((j) => [j, decompose(skel.world(j)).rotation]))
  return {
    id: armMap.id, side: armMap.side, chain,
    shoulder: chain[s], elbow: chain[e], wrist: chain[w], hand: chain.slice(w + 1),
    restRot,
  }
}

/** Apply one frame's handles to an arm. `h` may omit any handle. */
export function poseArm(pose, arm, h, { forward: fwd, lateral: lat }) {
  const carried = (j, axis) => qRotate(qMul(pose.rotation(j), qConj(arm.restRot.get(j))), axis)
  // Shoulder: spread first about the torso's forward axis, then raise about its
  // lateral one, both taken before either turn so they compose like Euler
  // angles rather than each riding on the last.
  const sFwd = carried(arm.shoulder, fwd), sLat = carried(arm.shoulder, lat)
  if (h.spread) pose.rotateWorld(arm.shoulder, qAxisAngle(sFwd, h.spread * arm.side))
  if (h.raise) pose.rotateWorld(arm.shoulder, qAxisAngle(sLat, -h.raise))
  if (h.twist) {
    const axis = norm(sub(pose.pos(arm.elbow), pose.pos(arm.shoulder)))
    pose.rotateWorld(arm.shoulder, qAxisAngle(axis, h.twist * arm.side))
  }
  if (h.elbow) pose.rotateWorld(arm.elbow, qAxisAngle(carried(arm.elbow, lat), -h.elbow))
  if (h.wristPitch) pose.rotateWorld(arm.wrist, qAxisAngle(carried(arm.wrist, lat), -h.wristPitch))
  if (h.wristSpread) pose.rotateWorld(arm.wrist, qAxisAngle(carried(arm.wrist, fwd), h.wristSpread * arm.side))
  if (h.curl) for (const j of arm.hand) pose.rotateWorld(j, qAxisAngle(carried(j, lat), -h.curl / arm.hand.length))
}
