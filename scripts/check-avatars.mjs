// Node-side gates for the peer avatars: the villager roster ship-biped.mjs
// writes, the shipped bodies' extras, and the body avatar-rig.js VrBody poses
// off a headset and two controllers (drawn by src/v2/render/avatar.js).
//
//   node scripts/check-avatars.mjs
//
// The body runs on the real skeleton of every shipped villager, built from the
// GLB's own joints, under clips that hold the rest pose: so the checks are of
// the solve alone, with nothing thrown. What can go wrong without anything
// throwing: a roster naming a villager that is not shipped, or shipped without
// the arms and head the body needs; a body that puts its hands off the grips
// it was given, or its wrists where they were not asked; a head 5 cm off its
// neck that stretches the neck sideways instead of moving the feet; a teleport
// that walks the body when it should stand, or that never
// stops, or that leaves the feet sliding; a teleport that arrives late, or
// whose arms keep reaching for hands a room away; a neck twist that turns the
// body too soon, or a body that never comes round; a solve that stacks on its
// own last frame instead of the clip's; a body hung from the head instead of
// stood on the ground, or a headset lowered that sinks it into the ground
// with its knees straight.
//
// What this can NOT check: whether it reads as her. That needs the body double.

import * as THREE from 'three'
import fs from 'node:fs'
import { VILLAGERS, BIPEDS } from '../tools/creatures/ship-biped.mjs'
import { CREATURES } from '../tools/creatures/creature-roster.mjs'
import { readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { TRADES } from '../src/v2/layers/trades.js'
import { LOD_TIERS } from '../src/v2/render/snowmen.js'
import { Puppet, makePuppetMaterials, makeSettledMaterial } from '../src/v2/render/puppet.js'
import {
  VrBody, HEAD_SLACK_M, EYE_LINE, TELEPORT_M, YAW_SLACK, YAW_SETTLE, GLIDE_STOP_M, FACE_TRAVEL_M, WALK_MAX_RATE, SNAP_HEIGHTS, MAX_TRAVEL_S, IK_OFF_M, CROUCH_FOLD, LEAN_MAX, FLY_M, FIT_MIN, wearerShoulder, gripScale,
} from '../src/v2/render/avatar-rig.js'
import { WALK } from '../src/v2/walk.js'
import { HAND_GLB, HAND_GRIP, HAND_PITCH_DEG, HAND_QUAT, HAND_SCALE_M, PEER_DRAW_M, PeerAvatars, handGeometry, ownHand, peerTier } from '../src/v2/render/avatar.js'
import { LOD_RUNGS, LOD_HYSTERESIS, critterTier, cullRange } from '../src/v2/render/critters.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`)
}
// Component-wise, since a shipped rotation is float32 and a hair off unit, which angleTo reads as a turn.
const qOff = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w)
const f3 = (v) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`
// A joint's name as the loader hands it to the world, and as the puppet and the body look it up.
const sane = (name) => THREE.PropertyBinding.sanitizeNodeName(name)

// --- the roster ---------------------------------------------------------------------
const OUT = new URL('../public/creatures/', import.meta.url)
const roster = JSON.parse(fs.readFileSync(new URL('avatars.json', OUT), 'utf8')).avatars
check(roster.map((a) => a.id).join(',') === VILLAGERS.join(','), `the roster lists every villager ship-biped.mjs ships, and only those`, roster.map((a) => a.id).join(','))
check(roster.every((a) => a.heightM === CREATURES.find((c) => c.id === a.id)?.sizeM), 'each at the creature roster\'s stature')
check(roster.every((a) => fs.existsSync(new URL(`${a.id}.glb`, OUT)) && fs.existsSync(new URL(`${a.id}.webp`, OUT))), 'each with its GLB and WebP shipped')

// --- the shipped extras, and a skeleton off each GLB --------------------------------
function loadShipped(id) {
  const { json } = readGlb(new URL(`${id}.glb`, OUT))
  const biped = json.scenes[json.scene ?? 0].extras.biped
  const joints = json.skins[0].joints
  const bones = new Map()
  for (const n of joints) {
    const node = json.nodes[n]
    const bone = new THREE.Bone()
    bone.name = sane(node.name)
    if (node.translation) bone.position.fromArray(node.translation)
    if (node.rotation) bone.quaternion.fromArray(node.rotation)
    if (node.scale) bone.scale.fromArray(node.scale)
    bones.set(n, bone)
  }
  for (const n of joints) for (const c of json.nodes[n].children ?? []) if (bones.has(c)) bones.get(n).add(bones.get(c))
  const roots = [...bones.values()].filter((b) => !b.parent)
  if (roots.length !== 1) throw new Error(`${id}: ${roots.length} root joints`)
  const root = roots[0]
  root.updateMatrixWorld(true)
  return { id, json, biped, root, byName: new Map([...bones.values()].map((b) => [b.name, b])), clipNames: json.animations.map((a) => a.name) }
}

const shipped = BIPEDS.map(loadShipped)
for (const { id, biped, byName } of shipped) {
  const has = (n) => byName.has(sane(n))
  const rest = (n) => byName.get(sane(n)).getWorldPosition(new THREE.Vector3())
  const arms = biped.arms ?? []
  check(arms.length === 2 && arms.some((a) => a.side === 1) && arms.some((a) => a.side === -1), `${id}: two arms named, one a side`, arms.map((a) => `${a.id} ${a.side}`).join(' '))
  check(arms.every((a) => a.chain.every(has) && [a.shoulder, a.elbow, a.wrist].every(has)), `${id}: every arm joint is one of the skeleton's`)
  check(arms.every((a) => a.chain.indexOf(a.shoulder) >= 0 && a.chain.indexOf(a.elbow) > a.chain.indexOf(a.shoulder) && a.chain.indexOf(a.wrist) > a.chain.indexOf(a.elbow)), `${id}: shoulder, elbow, wrist in that order down each chain`)
  check(arms.every((a) => a.chain.every((n, i) => i === 0 || byName.get(sane(n)).parent === byName.get(sane(a.chain[i - 1])))), `${id}: each arm chain hangs joint from joint`)
  check(biped.head?.length >= 1 && biped.head.every(has) && biped.head.every((n, i) => i === 0 || byName.get(sane(n)).parent === byName.get(sane(biped.head[i - 1]))), `${id}: a head chain, hanging joint from joint`, biped.head?.join(' > '))
  check(biped.spine?.length >= 1 && biped.spine.every(has), `${id}: a spine`, biped.spine?.join(' > '))
  // The hands hang: what the rest grip frame assumes. The wrist is below the shoulder and out on its own side, the head above the shoulders.
  check(arms.every((a) => { const S = rest(a.shoulder), W = rest(a.wrist); return W.y < S.y && Math.sign(W.z) === -a.side }), `${id}: at rest each hand hangs below its shoulder on its own side`, arms.map((a) => `${a.id} S ${f3(rest(a.shoulder))} W ${f3(rest(a.wrist))}`).join(' '))
  // The snowman hunches, its head joint level with its shoulders; a villager's is above them.
  const top = rest(biped.head[biped.head.length - 1])
  const aboveShoulders = !VILLAGERS.includes(id) || arms.every((a) => top.y > rest(a.shoulder).y)
  check(aboveShoulders && top.y > 0.7 * biped.height && top.y < biped.height, `${id}: the top of the head chain sits in the head${VILLAGERS.includes(id) ? ', above the shoulders' : ''}`, `${top.y.toFixed(3)} of ${biped.height.toFixed(3)}`)
}
// A town body's seat, as townsfolk.js `underside` measures it at load (and throws outside these bounds): the hip joints less a thigh's half-depth in the clip's first frame.
for (const id of TRADES.bodies) {
  const { json, biped, root, byName } = loadShipped(id)
  const { bin } = readGlb(new URL(`${id}.glb`, OUT))
  for (const clip of ['idle-sit', 'ride']) {
    const anim = json.animations.find((a) => a.name === clip)
    for (const ch of anim.channels) {
      const bone = byName.get(sane(json.nodes[ch.target.node].name))
      if (!bone || ch.target.path === 'weights') continue
      const acc = json.accessors[anim.samplers[ch.sampler].output], view = json.bufferViews[acc.bufferView]
      const v = new Float32Array(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0), ch.target.path === 'rotation' ? 4 : 3)
      ;({ translation: bone.position, rotation: bone.quaternion, scale: bone.scale })[ch.target.path].fromArray(v)
    }
    root.updateMatrixWorld(true)
    const y = biped.legs.reduce((s, l) => s + byName.get(sane(l.chain[0])).getWorldPosition(new THREE.Vector3()).y, 0) / biped.legs.length / biped.height - 0.05
    check(y > 0.05 && y < 0.5, `${id}: its ${clip} seat sits 5-50% of its height up`, y.toFixed(3))
  }
}
if (failures) {
  console.log(`\n${failures} failing -- the extras must ship before the body can be checked`)
  process.exit(1)
}

// --- a puppet on the real skeleton, under clips that hold the rest ------------------
// One box a rung, skinned to the root; the clips move nothing, so the solve is measured against the rest.
function makeAsset(s) {
  const { root, biped } = s
  const bones = []
  root.traverse((b) => bones.push(b))
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = Array.from({ length: LOD_TIERS }, (_, k) => {
    const g = new THREE.BoxGeometry(biped.span, biped.height, biped.width, LOD_TIERS - k, 1, 1).translate(0, biped.height / 2, 0)
    const n = g.getAttribute('position').count
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    return g
  })
  const spine = root.getObjectByName(sane(biped.spine[0]))
  const q = spine.quaternion.toArray()
  const clips = ['idle', 'walk', 'run'].map((name) => new THREE.AnimationClip(name, 1, [new THREE.QuaternionKeyframeTrack(`${spine.name}.quaternion`, [0, 1], [...q, ...q])]))
  return { root, skeleton, tiers, clips, map: null, extras: biped, ...biped }
}

const DT = 1 / 60
const UP = new THREE.Vector3(0, 1, 0)
// The ground: flat at 0 unless a stub is given, and dry unless the stub has a waterAt.
function makeBody(s, stature, walk = { heightAt: () => 0 }) {
  const asset = makeAsset(s)
  const plain = makeSettledMaterial(`check-${s.id}`)
  const puppet = new Puppet(asset, makePuppetMaterials(`check-${s.id}`, plain))
  const k = stature / asset.height
  const body = new VrBody(puppet, asset, k, { waterAt: () => null, ...walk })
  puppet.show(0)
  const bone = (name) => puppet.bones.find((b) => b.name === name)
  // A joint's world position and orientation, through the body's frame.
  const at = (name) => bone(name).getWorldPosition(new THREE.Vector3()).applyMatrix4(puppet.group.matrix)
  const turn = (name) => new THREE.Quaternion().setFromAxisAngle(UP, body.yaw).multiply(bone(name).getWorldQuaternion(new THREE.Quaternion()))
  return { s, asset, puppet, body, k, bone, at, turn }
}

// The rest of `s` in the body's own frame, at scale k: the eye point, and each arm's wrist. A grip's
// orientation is never read, so each carries a twist no hand could take.
function restOf(b, x, z, yaw) {
  const { s, body, k } = b
  const M = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(k, k, k))
  const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
  const world = (n) => s.byName.get(sane(n)).getWorldPosition(new THREE.Vector3()).applyMatrix4(M)
  const neck = world(s.biped.head[0])
  const head = new THREE.Vector3(neck.x, EYE_LINE * s.biped.height * k, neck.z)
  // The headset faces the body's +X: its -Z along it.
  const headQuat = R.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2))
  // The wearer's hand that puts arm i's wrist at `wrist` (world), given the clip's rest shoulder: the inverse of the solve's grip scaling.
  const Minv = M.clone().invert()
  const headB = head.clone().applyMatrix4(Minv)
  const ratioOf = (i) => {
    const [S, E, W] = [body.arms[i].S, body.arms[i].E, body.arms[i].W].map((j) => world(j.bone.name).applyMatrix4(Minv))
    return gripScale(S.distanceTo(E) + E.distanceTo(W), k)
  }
  const gripFor = (i, wrist) => {
    const arm = body.arms[i]
    const S = world(arm.S.bone.name).applyMatrix4(Minv)
    const sp = wearerShoulder(headB, arm.side, k, new THREE.Vector3())
    const ratio = ratioOf(i)
    return sp.add(wrist.clone().applyMatrix4(Minv).sub(S).divideScalar(ratio)).applyMatrix4(M)
  }
  const wrists = body.arms.map((arm) => world(arm.W.bone.name))
  const grips = wrists.map((w, i) => ({ pos: gripFor(i, w), quat: WILD_GRIP }))
  return { head, headQuat, grips, neck, wrists, gripFor, ratioOf }
}
const WILD_GRIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 2, 3).normalize(), 2.5)
const poseOf = (head, headQuat, grips) => [
  head.x, head.y, head.z, headQuat.x, headQuat.y, headQuat.z, headQuat.w,
  ...grips.flatMap((g) => [g.pos.x, g.pos.y, g.pos.z, g.quat.x, g.quat.y, g.quat.z, g.quat.w]),
]
const run = (b, pose, hands, seconds, foot = null, aboard = false) => { for (let t = 0; t < seconds; t += DT) b.body.drive(pose, hands, DT, foot, aboard) }

// --- at rest: the hands on the grips, the head where the headset is ---------------------
for (const s of shipped.filter((s) => VILLAGERS.includes(s.id))) {
  const stature = roster.find((a) => a.id === s.id).heightM
  const b = makeBody(s, stature)
  const { body, puppet } = b
  const rest = restOf(b, 3, -2, 0.4)
  const pose = poseOf(rest.head, rest.headQuat, rest.grips)
  run(b, pose, [true, true], 1)
  check(!body.gliding && puppet.current === puppet.actions.get('idle') && Math.abs(body.x - 3) < 1e-6 && Math.abs(body.z + 2) < 1e-6 && Math.abs(body.yaw - 0.4) < 1e-6, `${s.id}: stood where the head was, facing as it did, idle`, `at (${body.x.toFixed(3)}, ${body.z.toFixed(3)}) yaw ${body.yaw.toFixed(3)}`)
  check(body.hold === 1 && body.arms.every((a) => a.w === 1), `${s.id}: holding the head and both grips`)
  const off = body.arms.map((arm, i) => b.at(arm.W.bone.name).distanceTo(rest.wrists[i]))
  // An arm hanging straight at rest is pulled in by REACH, half a percent of its length.
  check(off.every((d) => d < 4e-3), `${s.id}: with the wearer's hands where their rest wrists map to, the wrists stay within 4 mm of the rest`, off.map((d) => `${(d * 1000).toFixed(2)} mm`).join(' '))
  const topName = sane(s.biped.head[s.biped.head.length - 1])
  const restTop = s.byName.get(topName).getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4))
  check(b.turn(topName).angleTo(restTop) < 1e-3, `${s.id}: with the headset at the rest gaze, the head keeps its rest turn`, `${((b.turn(topName).angleTo(restTop) * 180) / Math.PI).toFixed(3)} deg off`)
  const before = body.arms.map((arm) => b.at(arm.W.bone.name))
  run(b, pose, [true, true], 1)
  check(body.arms.every((arm, i) => b.at(arm.W.bone.name).distanceTo(before[i]) < 1e-6), `${s.id}: another second of the same pose leaves the wrists where they were -- the solve starts from the clip, not from itself`)
}

// --- the fisherman, driven ---------------------------------------------------------------
const fisher = shipped.find((s) => s.id === 'fisherman')
const stature = roster.find((a) => a.id === 'fisherman').heightM
{
  const b = makeBody(fisher, stature)
  const { body } = b
  const rest = restOf(b, 0, 0, 0)
  run(b, poseOf(rest.head, rest.headQuat, rest.grips), [true, true], 1)
  // A grip forward of the shoulder, within reach: the wrist goes there.
  const grips = rest.grips.map((g, i) => {
    const arm = body.arms[i]
    const S = b.at(arm.S.bone.name)
    const reach = (b.at(arm.S.bone.name).distanceTo(b.at(arm.E.bone.name)) + b.at(arm.E.bone.name).distanceTo(b.at(arm.W.bone.name)))
    return { pos: S.clone().add(new THREE.Vector3(0.7 * reach, 0.1, 0)), quat: g.quat }
  })
  const wristAt = grips.map((g) => g.pos)
  const worn = grips.map((g, i) => ({ pos: rest.gripFor(i, g.pos), quat: g.quat }))
  run(b, poseOf(rest.head, rest.headQuat, worn), [true, true], 1)
  const off = body.arms.map((arm, i) => b.at(arm.W.bone.name).distanceTo(wristAt[i]))
  check(off.every((d) => d < 5e-3), 'a grip held out in front, in reach, takes the wrist to within 5 mm of it', off.map((d) => `${(d * 1000).toFixed(1)} mm`).join(' '))
  check(body.arms.every((arm, i) => b.at(arm.E.bone.name).y < wristAt[i].y), 'and the elbow hangs below the line to it')
  check(body.arms.every((arm) => qOff(arm.W.bone.quaternion, fisher.byName.get(arm.W.bone.name).quaternion) < 1e-9), 'the wrist keeps the clip\'s own bend whatever the grip is twisted to -- the hand hangs off the forearm')
  // Out of reach: the arm straightens toward it and stops short.
  const far = grips.map((g, i) => ({ pos: g.pos.clone().add(new THREE.Vector3(2, 0, 0)), quat: g.quat }))
  run(b, poseOf(rest.head, rest.headQuat, far.map((g, i) => ({ pos: rest.gripFor(i, g.pos), quat: g.quat }))), [true, true], 1)
  check(body.arms.every((arm, i) => { const S = b.at(arm.S.bone.name), W = b.at(arm.W.bone.name); const u = far[i].pos.clone().sub(S).normalize(); const along = W.clone().sub(S); return along.dot(u) > 0.95 * along.length() && W.distanceTo(far[i].pos) > 1.5 }), 'a grip out of reach straightens the arm down its line and the wrist stops short')
  // A controller put down leaves that arm to the clip.
  run(b, poseOf(rest.head, rest.headQuat, worn), [true, false], 1)
  const right = body.arms[1]
  check(right.w === 0 && [right.S, right.E].every((j) => qOff(j.bone.quaternion, fisher.byName.get(j.bone.name).quaternion) < 1e-9) && b.at(body.arms[0].W.bone.name).distanceTo(wristAt[0]) < 5e-3, 'a controller not held leaves its arm on the clip while the other still reaches')
  // Where a peer's hand is, for the thing drawn in it (hands-net.js): each wrist as last drawn, and nothing while no body stands.
  const peers = { peers: new Map([['p', { body, puppet: b.puppet }]]) }
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion()
  const placedAway = b.puppet.group.matrix.elements[12] !== 0 || b.puppet.group.matrix.elements[14] !== 0 || b.puppet.group.matrix.elements[0] !== 1
  const wrists = body.arms.map((arm, i) => PeerAvatars.prototype.handAt.call(peers, 'p', i, pos, quat) && pos.distanceTo(b.at(arm.W.bone.name)) < 1e-9)
  check(placedAway && wrists.every(Boolean), 'handAt gives each wrist in world space where the body last drew it, the left as side 0 -- the group\'s frame applied, since the rig hangs under nothing', `group off identity: ${placedAway}`)
  const was = body.placed
  body.placed = false
  check(PeerAvatars.prototype.handAt.call(peers, 'p', 1, pos, quat) === false && PeerAvatars.prototype.handAt.call(peers, 'q', 1, pos, quat) === false, 'and is false for a body not standing or a peer unknown')
  body.placed = was
}

// --- the head: the feet follow it at once, the neck stretches only up and down, a teleport walks the body ---
{
  const b = makeBody(fisher, stature)
  const { body, puppet } = b
  const rest = restOf(b, 0, 0, 0)
  run(b, poseOf(rest.head, rest.headQuat, rest.grips), [true, true], 1)
  const neckName = sane(fisher.biped.head[0])
  const neck0 = b.at(neckName)
  const near = rest.head.clone().add(new THREE.Vector3(0.05, 0, 0.02))
  body.drive(poseOf(near, rest.headQuat, rest.grips), [true, true], DT)
  const slid = b.at(neckName).sub(neck0)
  check(!body.gliding && Math.abs(body.x - 0.05) < 1e-6 && Math.abs(body.z - 0.02) < 1e-6 && puppet.current === puppet.actions.get('idle') && puppet.planted, 'a head 5 cm off its neck moves the feet with it at once, planted, without a walk', `at (${body.x.toFixed(3)}, ${body.z.toFixed(3)})`)
  check(Math.abs(slid.x - 0.05) < 1e-3 && Math.abs(slid.z - 0.02) < 1e-3 && Math.abs(slid.y) < 1e-3, 'the neck over the feet, not slid to it', f3(slid))
  const up = near.clone().add(new THREE.Vector3(0, 0.05, 0))
  run(b, poseOf(up, rest.headQuat, rest.grips), [true, true], 1)
  const stretched = b.at(neckName).sub(neck0)
  check(Math.abs(stretched.y - 0.05) < 1e-3 && Math.abs(stretched.x - 0.05) < 1e-3 && body.crouch === 0, 'a head 5 cm up stretches the neck 5 cm up', f3(stretched))
  run(b, poseOf(near, rest.headQuat, rest.grips), [true, true], 1)
  // The shoulder moves with the head and the wearer's hand does not, so the wrist trails the head by what the grip's scaling gives away.
  const headMove = near.clone().sub(rest.head)
  const off = body.arms.map((arm, i) => b.at(arm.W.bone.name).distanceTo(rest.wrists[i].clone().addScaledVector(headMove, 1 - rest.ratioOf(i))))
  check(off.every((d) => d < 4e-3), 'with the hands still on their grips, the wrists trail the head by what the grip scaling gives away', off.map((d) => `${(d * 1000).toFixed(1)} mm`).join(' '))
  run(b, poseOf(rest.head, rest.headQuat, rest.grips), [true, true], 1)
  // A hop: the body walks after it, brisk enough to be there inside the second, and settles.
  const hop = TELEPORT_M + 0.3
  const step = rest.head.clone().add(new THREE.Vector3(hop, 0, 0))
  const pose = poseOf(step, rest.headQuat, rest.grips)
  body.drive(pose, [true, true], DT)
  check(body.gliding && puppet.current === puppet.actions.get('walk') && !puppet.planted, `a head jumped more than ${TELEPORT_M} m in a frame sets the body walking, its feet the clip's`)
  const pace = Math.max(body.walkSpeed, hop / MAX_TRAVEL_S)
  run(b, pose, [true, true], 0.1)
  const moved = body.x
  check(Math.abs(moved - pace * (0.1 + DT)) < pace * DT * 1.5, `at the pace that has it there inside the ${MAX_TRAVEL_S} s`, `${moved.toFixed(3)} m in ${(0.1 + DT).toFixed(3)} s at ${pace.toFixed(3)} m/s`)
  check(Math.abs(puppet.actions.get('walk').timeScale - pace / body.walkSpeed) < 1e-6 && Math.abs(body.yaw) < 1e-9, `the walk clip sped to that pace to keep the stride, short of the ${WALK_MAX_RATE}x that would make it a run, and the body square to the head, the hop being straight ahead of it`, `clip at ${(pace / body.walkSpeed).toFixed(2)}x`)
  run(b, pose, [true, true], 3)
  check(!body.gliding && puppet.current === puppet.actions.get('idle') && Math.abs(body.x - (TELEPORT_M + 0.3)) < 1e-6 && body.hold === 1, `and settles to idle under the head, holding on`, `at ${body.x.toFixed(4)}`)
  const slid2 = b.at(neckName).sub(neck0)
  check(Math.abs(slid2.x - (TELEPORT_M + 0.3)) < 1e-3, 'the head where the headset is', `neck ${slid2.x.toFixed(4)} of which the feet ${body.x.toFixed(4)}`)
  // The head tilts and turns with the headset, within the slack.
  const nod = rest.headQuat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.4))
  run(b, poseOf(step, nod, rest.grips), [true, true], 1)
  const topName = sane(fisher.biped.head[fisher.biped.head.length - 1])
  const restTop = fisher.byName.get(topName).getWorldQuaternion(new THREE.Quaternion())
  const delta = b.turn(topName).multiply(restTop.clone().invert())
  const axis = new THREE.Vector3(delta.x, delta.y, delta.z).normalize()
  check(Math.abs(delta.angleTo(new THREE.Quaternion()) - 0.4) < 1e-3 && Math.abs(axis.z) > 0.99, 'a nod of the headset nods the head the same, about the body\'s sideways', `${delta.angleTo(new THREE.Quaternion()).toFixed(3)} rad about ${f3(axis)}`)
  // All of it at the neck: a skull Tripo hung from the lower head joint nods as far as one hung from the top.
  const neckDelta = b.turn(neckName).multiply(fisher.byName.get(neckName).getWorldQuaternion(new THREE.Quaternion()).invert())
  check(Math.abs(neckDelta.angleTo(new THREE.Quaternion()) - 0.4) < 1e-3, 'the whole nod is the neck joint\'s, whichever joint the skull is skinned to', `${neckDelta.angleTo(new THREE.Quaternion()).toFixed(3)} rad`)
}

// --- the yaw: a twist within the slack turns the neck, past it the body ---------------
{
  const b = makeBody(fisher, stature)
  const { body } = b
  const rest = restOf(b, 0, 0, 0)
  run(b, poseOf(rest.head, rest.headQuat, rest.grips), [true, true], 1)
  const look = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a).multiply(rest.headQuat)
  run(b, poseOf(rest.head, look(0.5), rest.grips), [true, true], 1)
  check(!body.turning && Math.abs(body.yaw) < 1e-9, `a headset turned ${((0.5 * 180) / Math.PI).toFixed(0)} deg, under the ${((YAW_SLACK * 180) / Math.PI).toFixed(0)} deg slack, turns only the neck`)
  const topName = sane(fisher.biped.head[fisher.biped.head.length - 1])
  const restTop = fisher.byName.get(topName).getWorldQuaternion(new THREE.Quaternion())
  check(Math.abs(b.turn(topName).angleTo(restTop) - 0.5) < 1e-3, 'the head looking where the headset does', `${b.turn(topName).angleTo(restTop).toFixed(3)} rad`)
  run(b, poseOf(rest.head, look(0.9), rest.grips), [true, true], 3)
  check(!body.turning && Math.abs(0.9 - body.yaw) < YAW_SETTLE && body.yaw > 0.5, `past the slack the body comes round and stops within ${((YAW_SETTLE * 180) / Math.PI).toFixed(0)} deg of the gaze`, `yaw ${body.yaw.toFixed(3)}`)
  check(Math.abs(b.turn(topName).angleTo(restTop.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), body.yaw))) - (0.9 - body.yaw)) < 1e-3, 'the neck keeping the rest of the twist')
}

// --- a teleport: the body runs there inside the second, arms and head let go on the way ---
{
  const b = makeBody(fisher, stature)
  const { body, puppet } = b
  const rest = restOf(b, 0, 0, 0)
  run(b, poseOf(rest.head, rest.headQuat, rest.grips), [true, true], 1)
  // Six metres: a full teleport at her own size, and well inside the snap.
  const there = restOf(b, 4.8, -3.6, 0)
  const pose = poseOf(there.head, there.headQuat, there.grips)
  body.drive(pose, [true, true], DT)
  check(body.gliding && puppet.current === puppet.actions.get('run'), `a head 6 m off -- more than the ${WALK_MAX_RATE} walks the second would hold -- sets the body running`, `the walk turns over at ${(body.walkSpeed * WALK_MAX_RATE * MAX_TRAVEL_S).toFixed(2)} m`)
  const pace = Math.max(body.runSpeed, 6 / MAX_TRAVEL_S)
  check(Math.abs(body.pace - pace) < 1e-9 && Math.abs(puppet.actions.get('run').timeScale - pace / body.runSpeed) < 1e-9, `the pace is the run's or the ${MAX_TRAVEL_S} s deadline's, whichever is faster, and the feet keep it: the clip at pace over its own`, `${pace.toFixed(2)} m/s, run ${body.runSpeed.toFixed(2)}, clip at ${puppet.actions.get('run').timeScale.toFixed(2)}x`)
  run(b, pose, [true, true], 0.8)
  const travel = Math.atan2(3.6, 4.8)
  check(body.hold === 0 && body.arms.every((a) => a.w === 0), `more than ${IK_OFF_M} m from its head it has let go of the head and both grips`)
  check(body.turning && Math.abs(body.yaw - travel) < 0.02, `and, more than ${FACE_TRAVEL_M} m from it, faces the way it runs`, `yaw ${body.yaw.toFixed(3)} travel ${travel.toFixed(3)}`)
  run(b, pose, [true, true], 0.5)
  check(!body.gliding && puppet.current === puppet.actions.get('idle') && Math.hypot(body.x - 4.8, body.z + 3.6) <= GLIDE_STOP_M, `arrived and idle within ${MAX_TRAVEL_S} s`, `at (${body.x.toFixed(3)}, ${body.z.toFixed(3)})`)
  run(b, pose, [true, true], 3)
  check(body.hold === 1 && !body.turning && Math.abs(body.yaw) < YAW_SETTLE, 'then takes the head and grips back up and turns back to the gaze', `yaw ${body.yaw.toFixed(3)}`)
  const off = body.arms.map((arm, i) => b.at(arm.W.bone.name).distanceTo(there.wrists[i]))
  check(off.every((d) => d < 1e-2), 'the hands back on their grips', off.map((d) => `${(d * 1000).toFixed(1)} mm`).join(' '))
  // Past the snap nothing walked that far: a head a room away puts the body there in the frame, no trip.
  const snap = SNAP_HEIGHTS * body.height * body.k
  const gone = restOf(b, 20, -12, 0)
  body.drive(poseOf(gone.head, gone.headQuat, gone.grips), [true, true], DT)
  // Under the head, not on it: the feet sit a neck's offset back, turned by whatever yaw the body kept.
  check(!body.gliding && puppet.current === puppet.actions.get('idle') && Math.hypot(body.x - 20, body.z + 12) < 0.02, `a head jumped ${Math.hypot(15.2, 8.4).toFixed(1)} m, past the ${SNAP_HEIGHTS} statures, is stood under rather than run to`, `snap at ${snap.toFixed(2)} m, at (${body.x.toFixed(3)}, ${body.z.toFixed(3)})`)
  // Gone and back: it stands afresh where the head is, without walking.
  body.placed = false
  const back = restOf(b, -5, 4, 2)
  body.drive(poseOf(back.head, back.headQuat, back.grips), [true, true], DT)
  check(!body.gliding && Math.abs(body.x + 5) < 1e-6 && Math.abs(body.z - 4) < 1e-6 && Math.abs(body.yaw - 2) < 1e-6, 'un-placed, it stands where the head is at once, facing as it does')
}

// --- a room swap: every standing body is handed the new room's ground ------------------
{
  // Dressed in the overworld, whose ground under the glade's coordinates is 40 m up; she stands on the glade's floor at 0.
  const b = makeBody(fisher, stature, { heightAt: () => 40 })
  const rest = restOf(b, 0, 0, 0)
  const pose = poseOf(rest.head, rest.headQuat, rest.grips)
  const hipY = () => b.at(b.puppet.ik.legs[0].A.name).y
  run(b, pose, [true, true], 1, 0)
  const hoisted = hipY() - rest.head.y
  check(hoisted > 5, 'on the last room\'s ground, a body the relay stands at 0 is hoisted metres over its own head', `hips ${hoisted.toFixed(2)} m over the headset`)
  const peers = { peers: new Map([['p', { body: b.body }]]), double: null }
  PeerAvatars.prototype.ground.call(peers, { heightAt: () => 0, waterAt: () => null })
  run(b, pose, [true, true], 1, 0)
  check(hipY() < rest.head.y, 'ground() hands it the new room\'s, and its hips come back down under its head', `hips ${(hipY() - rest.head.y).toFixed(2)} m over the headset`)
}

// --- the ground: the body stands on it, and a headset lowered crouches it ---------------
{
  const b = makeBody(fisher, stature, { heightAt: (x, z) => (x > 5 ? 2 : 0) })
  const { body, puppet } = b
  const rest = restOf(b, 0, 0, 0)
  run(b, poseOf(rest.head, rest.headQuat, rest.grips), [true, true], 1)
  check(puppet.planted && body.y === 0 && body.crouch === 0 && body.lean === 0, 'standing, its feet are planted to the ground and, with the headset at the eye line, it neither crouches nor leans')
  // Where the clip holds each foot: a plant keeps it there, whatever the hips do.
  const footRest = puppet.ik.legs.map((l) => fisher.byName.get(l.C.name).getWorldPosition(new THREE.Vector3()).y * b.k)
  const footOff = () => puppet.ik.legs.map((l, i) => b.at(l.C.name).y - footRest[i])
  const mm = (ds) => ds.map((d) => `${(d * 1000).toFixed(1)} mm`).join(' ')
  check(footOff().every((d) => Math.abs(d) < 5e-3), 'both feet where the clip stands them', mm(footOff()))
  const hip = puppet.ik.legs.map((l) => b.at(l.A.name).y)
  // The headset 40 cm below the eye line: the knees fold, the hips sink, the waist bends, the eyes come down to it.
  const low = rest.head.clone().setY(rest.head.y - 0.4)
  run(b, poseOf(low, rest.headQuat, rest.grips), [true, true], 2)
  check(body.crouch > 0.05 && body.lean > 0 && Math.abs(body.crouch + body.leanDrop(body.lean) + HEAD_SLACK_M - 0.4) < 1e-6, `a headset 40 cm down crouches it by the 40 cm less the ${(HEAD_SLACK_M * 100).toFixed(0)} cm of neck slack, between the hips and the waist`, `hips ${(body.crouch * 100).toFixed(1)} cm, waist ${((body.lean * 180) / Math.PI).toFixed(1)} deg for ${(body.leanDrop(body.lean) * 100).toFixed(1)} cm`)
  const hipNow = puppet.ik.legs.map((l) => b.at(l.A.name).y)
  check(hipNow.every((y, i) => Math.abs(hip[i] - y - body.crouch) < 5e-3), 'the hips sunk by that, the knees folding under them', hipNow.map((y, i) => `${((hip[i] - y) * 100).toFixed(1)} cm`).join(' '))
  check(footOff().every((d) => Math.abs(d) < 5e-3) && body.y === 0, 'the feet still on the ground, the body still stood on it', mm(footOff()))
  const neckY = b.at(sane(fisher.biped.head[0])).y
  check(Math.abs(neckY + (EYE_LINE * fisher.biped.height - rest.neck.y / b.k) * b.k - low.y) < 0.03, 'the eyes within 3 cm of the headset', `neck at ${neckY.toFixed(3)}, eyes wanted at ${low.y.toFixed(3)}`)
  // A deep squat: the legs fold no further than CROUCH_FOLD of their length, the waist bends no further than LEAN_MAX.
  const floor = rest.head.clone().setY(0.5)
  run(b, poseOf(floor, rest.headQuat, rest.grips), [true, true], 2)
  check(Math.abs(body.lean - LEAN_MAX) < 1e-9 && Math.abs(body.crouch - (1 - CROUCH_FOLD) * puppet.ik.legRest * b.k) < 1e-9, `a headset at 50 cm bends it double: the waist to ${((LEAN_MAX * 180) / Math.PI).toFixed(0)} deg, the legs folded to ${CROUCH_FOLD} of their length`, `hips ${(body.crouch * 100).toFixed(1)} cm`)
  check(footOff().every((d) => Math.abs(d) < 5e-3), 'the feet still on the ground', mm(footOff()))
  // Up again, and the body stands as it did.
  run(b, poseOf(rest.head, rest.headQuat, rest.grips), [true, true], 2)
  check(body.crouch === 0 && body.lean === 0 && puppet.ik.legs.every((l, i) => Math.abs(b.at(l.A.name).y - hip[i]) < 5e-3), 'and stands again when the headset comes back up')
  // As she bends her head goes forward as well as down; the lean is that, not a step, so the feet stay where they are.
  const stood = { x: body.x, z: body.z }
  const bent = rest.head.clone().add(new THREE.Vector3(body.leanReach(LEAN_MAX) * b.k, 0.5 - rest.head.y, 0))
  let stepped = false
  for (let t = 0; t < 2; t += DT) { body.drive(poseOf(bent, rest.headQuat, rest.grips), [true, true], DT); stepped ||= body.gliding }
  check(!stepped && Math.abs(body.x - stood.x) < 1e-6 && Math.abs(body.z - stood.z) < 1e-6 && Math.abs(body.lean - LEAN_MAX) < 1e-9, 'a head that goes down and forward by the lean\'s reach bends the body double where it stands, without a step', `reach ${(body.leanReach(LEAN_MAX) * b.k * 100).toFixed(0)} cm, feet moved ${(Math.hypot(body.x - stood.x, body.z - stood.z) * 100).toFixed(2)} cm`)
  // A shelf 2 m up: the body stands on it, not hung from the head, and a walk there unplants the feet.
  const up = restOf(b, 8, 0, 0)
  const shelf = poseOf(up.head.clone().setY(up.head.y + 2), up.headQuat, up.grips.map((g) => ({ pos: g.pos.clone().setY(g.pos.y + 2), quat: g.quat })))
  body.drive(shelf, [true, true], DT)
  check(body.gliding && !puppet.planted, 'walking off to a head that has moved, its feet are the clip\'s, not planted')
  run(b, shelf, [true, true], MAX_TRAVEL_S + 3)
  check(!body.gliding && body.y === 2 && puppet.planted, 'arrived on a shelf 2 m up, it stands on the shelf', `y ${body.y}`)
}

// --- a crouch beside a step: the ground is read where it stands upright ----------------
// The lean carries the feet back by its reach, so a body that read its ground from where
// the lean had put them would pick the next frame's lean off that ground: standing anywhere
// within the reach of a step, it takes the step's two heights one a frame, for ever. Thirty
// centimetres of buzz on a peer at a rock's edge or a boat's gunwale, once per frame.
{
  const STEP = 0.6
  const walk = { heightAt: (x, z, y) => (x <= 0 ? 0 : (y === undefined || y + WALK.reach >= STEP ? STEP : 0)) }
  let worst = 0
  let worstX = 0
  let crouched = 0
  for (let hx = -0.5; hx <= 0.5; hx += 0.01) {
    const b = makeBody(fisher, stature, walk)
    const rest = restOf(b, hx, 0, 0)
    // The headset 30 cm under the standing eye line: a peer whose own head sits lower than the villager it wears.
    const pose = poseOf(rest.head.clone().setY(STEP + EYE_LINE * stature - 0.3), rest.headQuat, rest.grips)
    run(b, pose, [true, true], 2)
    const ys = []
    for (let i = 0; i < 30; i++) { b.body.drive(pose, [true, true], DT); ys.push(b.body.y) }
    const swing = Math.max(...ys) - Math.min(...ys)
    if (swing > worst) { worst = swing; worstX = hx }
    if (b.body.lean > 0) crouched++
  }
  check(crouched > 0, 'swept across a step with the headset under the eye line, the body does crouch somewhere along it', `${crouched} of 101 head positions leaning`)
  check(worst === 0, 'and its feet settle at every one of them -- the crouch never moves the ground it is measured off', `worst swing ${(worst * 100).toFixed(1)} cm at head x ${worstX.toFixed(2)}`)
}

// --- in the air: a flight, and a boat's sole over a lake bed ---------------------------
{
  const b = makeBody(fisher, stature)
  const { body, puppet } = b
  const rest = restOf(b, 0, 0, 0)
  run(b, poseOf(rest.head, rest.headQuat, rest.grips), [true, true], 1)
  // The head 3 m up, on a still frame: the body hangs under it, idle, its feet loose, without a walk.
  const lift = (h) => poseOf(rest.head.clone().setY(rest.head.y + h), rest.headQuat, rest.grips.map((g) => ({ pos: g.pos.clone().setY(g.pos.y + h), quat: g.quat })))
  run(b, lift(3), [true, true], 1)
  check(body.aloft && !body.gliding && !puppet.planted && puppet.current === puppet.actions.get('idle') && Math.abs(body.y - 3) < 1e-6 && body.crouch === 0, `a head more than ${FLY_M} m higher over the ground than its standing eyes carries the body under it, idle, feet loose`, `y ${body.y.toFixed(3)} crouch ${body.crouch.toFixed(3)}`)
  // Flying fast, the head is a teleport off every frame: the body is carried, never walked after.
  let walked = false
  for (let i = 0; i < 60; i++) {
    const p = lift(3); p[0] += 1.5 * (i + 1); p[7] += 1.5 * (i + 1); p[14] += 1.5 * (i + 1)
    body.drive(p, [true, true], DT); walked ||= body.gliding
  }
  check(!walked && body.aloft && Math.abs(body.x - 90) < 1e-6 && body.hold === 1, 'a flight at a teleport a frame is carried under the head, holding on, not walked after', `at x ${body.x.toFixed(2)}`)
  // Down again to the ground, it stands.
  run(b, poseOf(rest.head.clone().setX(rest.head.x + 90), rest.headQuat, rest.grips.map((g) => ({ pos: g.pos.clone().setX(g.pos.x + 90), quat: g.quat }))), [true, true], 1)
  check(!body.aloft && body.y === 0 && puppet.planted, 'and stands on the ground again when the head comes down to it')
}
{
  // A boat's sole at 0 over a lake bed 2 m down, past the walk surface's reach: stone the ceiling rule gives a body on the bed no way up onto.
  const b = makeBody(fisher, stature, { heightAt: (x, z, y) => (y === undefined || y + WALK.reach >= 0 ? 0 : -2) })
  const { body, puppet } = b
  const rest = restOf(b, 0, 0, 0)
  const at = (h) => poseOf(rest.head.clone().setY(rest.head.y + h), rest.headQuat, rest.grips.map((g) => ({ pos: g.pos.clone().setY(g.pos.y + h), quat: g.quat })))
  run(b, at(-2), [true, true], 1)
  check(body.y === -2 && puppet.planted, 'a body on the lake bed under a boat stands on the bed', `y ${body.y}`)
  run(b, at(0), [true, true], 1)
  check(!body.aloft && body.y === 0 && puppet.planted, 'and when she boards, her head over the sole, the body is lifted onto the sole and stands there', `y ${body.y}`)
}

// --- a told ground: the sender's feet beat this client's read of the surface ----------
// A peer's feet are not on the wire unless the sender sends them, and reconstructing them
// from a head and a villager's neck lands them a setback from the truth. Over a boat's
// gunwale that setback is the difference between the sole and the lake bed: the body drops
// through the boards, and the walk surface's reach can never lift it back. A told ground is
// the ground, and no read of the surface under it is consulted at all.
{
  // A hull whose pad ends at x = 0.5, its sole at 0.4 over a bed 2 m down -- past WALK.reach from the sole.
  const SOLE = 0.4
  const BED = -1.6
  const walk = { heightAt: (x, z, y) => {
    if (Math.abs(x) > 0.5) return BED
    return y === undefined || y + WALK.reach >= SOLE ? SOLE : BED
  } }
  // Seated on a thwart, aboard as the wire says with every told foot on a boat: the sender's headset well under the villager's standing eye line, which is the shape that sinks.
  const b = makeBody(fisher, stature, walk)
  const rest = restOf(b, 0, 0, 0)
  const seated = (x) => poseOf(new THREE.Vector3(x, SOLE + 0.95, 0), rest.headQuat, rest.grips.map((g) => ({ pos: g.pos.clone().setX(g.pos.x + x).setY(SOLE + 0.45), quat: g.quat })))
  run(b, seated(0), [true, true], 2, SOLE, true)
  check(b.body.y === SOLE && !b.body.aloft, 'a peer that sends its feet stands on them, seated amidships', `y ${b.body.y}`)
  run(b, seated(0.5), [true, true], 3, SOLE, true)
  check(b.body.y === SOLE && !b.body.aloft, 'and still stands on them carried to the bow, where its guessed-at feet are over the side', `y ${b.body.y}`)
  check(Math.min(...b.body.dys) > -1, 'and neither leg reaches for the bed the foot beside it samples', `dys ${b.body.dys.map((d) => d.toFixed(2)).join(' ')}`)
  // The same trip with nothing told, which is what the wire used to carry: the body drops through the boards.
  const c = makeBody(fisher, stature, walk)
  run(c, seated(0), [true, true], 2)
  const amidships = c.body.y
  run(c, seated(0.5), [true, true], 3)
  check(amidships === SOLE && c.body.y < SOLE - 0.3, 'guessing at the ground instead, the same peer drops through the boards at the bow',
    `amidships ${amidships.toFixed(2)} -> bow ${c.body.y.toFixed(2)}`)
}
{
  // A teleport down a hillside: the told feet are at the far end from the first frame, but the body walks the slope between.
  const slope = (x) => -0.5 * x
  const b = makeBody(fisher, stature, { heightAt: (x) => slope(x) })
  const rest = restOf(b, 0, 0, 0)
  const at = (x) => poseOf(rest.head.clone().setX(rest.head.x + x).setY(rest.head.y + slope(x)), rest.headQuat, rest.grips.map((g) => ({ pos: g.pos.clone().setX(g.pos.x + x).setY(g.pos.y + slope(x)), quat: g.quat })))
  run(b, at(0), [true, true], 1, 0)
  let worst = 0
  b.body.drive(at(5), [true, true], DT, slope(5))
  for (let t = 0; t < MAX_TRAVEL_S && b.body.gliding; t += DT) {
    worst = Math.max(worst, Math.abs(b.body.y - slope(b.body.x)))
    b.body.drive(at(5), [true, true], DT, slope(5))
  }
  check(worst < 0.05, 'a teleport down a hillside is walked on the slope, not sunk to the told feet at the far end', `worst ${(worst * 100).toFixed(1)} cm off the slope`)
}
{
  // A swimmer: a lake at 0 over a bed 2 m down, her feet told where they float, her eyes over the surface.
  const walk = { heightAt: () => -2, waterAt: () => 0 }
  const b = makeBody(fisher, stature, walk)
  const eye = EYE_LINE * b.asset.height * b.k
  const rest = restOf(b, 0, 0, 0)
  const HY = 0.25
  const afloat = poseOf(new THREE.Vector3(0, HY, 0), rest.headQuat, rest.grips.map((g) => ({ pos: g.pos.clone().setY(g.pos.y - rest.head.y + HY), quat: g.quat })))
  run(b, afloat, [true, true], 1, HY - 1.6)
  const eyeAt = b.at(sane(fisher.biped.head[0])).y + (EYE_LINE * fisher.biped.height - rest.neck.y / b.k) * b.k
  check(b.body.aloft && !b.puppet.planted && Math.abs(b.body.y - (HY - eye)) < 1e-6, 'a swimmer\'s body hangs under its head, feet loose, never planted on the lake bed', `y ${b.body.y.toFixed(3)} planted ${b.puppet.planted}`)
  check(Math.abs(eyeAt - HY) < 0.05, 'and its eyes are at the headset, over the water', `eyes ${eyeAt.toFixed(3)} headset ${HY}`)
  // Aboard a boat on the same lake, told feet over the side are still the deck.
  const c = makeBody(fisher, stature, walk)
  run(c, afloat, [true, true], 1, HY - 1.6, true)
  check(!c.body.aloft && c.body.y === HY - 1.6, 'aboard a boat on it, the same told feet are stood on', `y ${c.body.y}`)
}
{
  // A flyer over dry land, her feet told 2 m up (player.js flyClearance): the body hangs from her head, not from the ground.
  const b = makeBody(fisher, stature)
  const eye = EYE_LINE * b.asset.height * b.k
  const rest = restOf(b, 0, 0, 0)
  const HY = 3.6
  const flying = poseOf(new THREE.Vector3(0, HY, 0), rest.headQuat, rest.grips.map((g) => ({ pos: g.pos.clone().setY(g.pos.y - rest.head.y + HY), quat: g.quat })))
  run(b, flying, [true, true], 1, 2)
  const eyeAt = b.at(sane(fisher.biped.head[0])).y + (EYE_LINE * fisher.biped.height - rest.neck.y / b.k) * b.k
  check(b.body.aloft && !b.puppet.planted && Math.abs(b.body.y - (HY - eye)) < 1e-6, `told feet more than ${FLY_M} m over dry ground hang the body under its head, feet loose`, `y ${b.body.y.toFixed(3)} planted ${b.puppet.planted}`)
  check(Math.abs(eyeAt - HY) < 0.05, 'and its eyes are at the headset', `eyes ${eyeAt.toFixed(3)} headset ${HY}`)
}

// --- the wearer's size: a body is scaled until its standing eyes are the wearer's ------
{
  const stand = (b, rest, dy) => poseOf(rest.head.clone().setY(rest.head.y + dy), rest.headQuat, rest.grips.map((g) => ({ pos: g.pos.clone().setY(g.pos.y + dy), quat: g.quat })))
  // The eyes as drawn: the neck joint plus the rest eye line over it, at the body's live scale.
  const eyesOf = (b, rest) => b.at(sane(fisher.biped.head[0])).y + (EYE_LINE * fisher.biped.height - rest.neck.y / b.k) * b.body.k
  for (const [what, dy] of [['taller', 0.12], ['shorter', -0.25]]) {
    const b = makeBody(fisher, stature)
    const rest = restOf(b, 0, 0, 0)
    const own = rest.head.y
    run(b, stand(b, rest, dy), [true, true], 8, 0)
    const { body } = b
    check(Math.abs(body.wearerEye - (own + dy)) < 1e-3 && Math.abs(body.fit - (own + dy) / own) < 0.01, `a wearer ${Math.abs(dy * 100)} cm ${what} than the villager's eye line is measured, and the body scaled to it`, `wearer ${body.wearerEye.toFixed(3)} fit ${body.fit.toFixed(3)}`)
    check(body.crouch === 0 && body.lean === 0 && Math.abs(eyesOf(b, rest) - (own + dy)) < 0.02, 'standing straight, neither crouched nor leaning, its eyes at the headset', `crouch ${body.crouch.toFixed(3)} lean ${body.lean.toFixed(3)} eyes ${eyesOf(b, rest).toFixed(3)} headset ${(own + dy).toFixed(3)}`)
    if (dy > 0) {
      // A duck to a mushroom after that: a crouch, not a shrink.
      const fit = body.fit
      run(b, stand(b, rest, dy - 0.6), [true, true], 3, 0)
      check(Math.abs(body.fit - fit) < 0.005 && body.crouch > 0.05, 'a three-second duck crouches it and leaves its size alone', `fit ${fit.toFixed(3)} -> ${body.fit.toFixed(3)} crouch ${body.crouch.toFixed(3)}`)
    }
  }
  const b = makeBody(fisher, stature)
  const rest = restOf(b, 0, 0, 0)
  run(b, stand(b, rest, -0.5 * rest.head.y), [true, true], 8, 0)
  check(b.body.fitTo() === FIT_MIN && Math.abs(b.body.fit - FIT_MIN) < 0.01, `a headset at half the eye line shrinks it no further than ${FIT_MIN}`, `fit ${b.body.fit.toFixed(3)}`)
  // Feet not told, or told aboard a boat, are no measure of a wearer's height.
  const c = makeBody(fisher, stature)
  run(c, stand(c, rest, 0.12), [true, true], 4)
  run(c, stand(c, rest, 0.12), [true, true], 4, 0, true)
  check(c.body.fit === 1 && Number.isNaN(c.body.wearerEye), 'without told feet, or aboard, the body keeps the villager\'s own size', `fit ${c.body.fit}`)
}

// --- how far a peer is drawn ------------------------------------------------------------
console.log('\nhow far a peer is drawn')
{
  const size = 1.7, last = LOD_RUNGS - 1
  check(peerTier(size, 100, -1) === last && peerTier(size, 100, LOD_RUNGS) === last, 'a peer 100 m off is drawn on the last rung, coming into range or already there', `wildlife cull ${cullRange(size).toFixed(1)} m`)
  check(peerTier(size, 3, -1) === critterTier(size, 3, -1) && peerTier(size, 20, -1) === critterTier(size, 20, -1), 'nearer, the ladder is the wildlife\'s')
  check(peerTier(size, PEER_DRAW_M * (1 + LOD_HYSTERESIS / 2), last) === last && peerTier(size, PEER_DRAW_M * (1 + LOD_HYSTERESIS * 1.5), last) === LOD_RUNGS, 'past PEER_DRAW_M it goes, once it is clear of the hysteresis')
  check(peerTier(size, PEER_DRAW_M * (1 - LOD_HYSTERESIS / 2), LOD_RUNGS) === LOD_RUNGS && peerTier(size, PEER_DRAW_M * (1 - LOD_HYSTERESIS * 1.5), LOD_RUNGS) === last, 'and comes back only once well inside it')
}

// --- release --------------------------------------------------------------------------
{
  const b = makeBody(fisher, stature)
  const { body, puppet } = b
  const rest = restOf(b, 0, 0, 0)
  const grips = rest.grips.map((g) => ({ pos: g.pos.clone().add(new THREE.Vector3(0.3, 0.3, 0)), quat: g.quat }))
  run(b, poseOf(rest.head, rest.headQuat, grips), [true, true], 1)
  puppet.release()
  check(body.hold === 0 && body.arms.every((a) => a.w === 0) && puppet.bones.every((bn) => qOff(bn.quaternion, fisher.byName.get(bn.name).quaternion) < 1e-6 && bn.position.distanceTo(fisher.byName.get(bn.name).position) < 1e-9), 'a puppet released is back on its rest, with the body holding nothing')
}

// --- her own hand: the shipped mesh seated in the grip frame --------------------------
//
// What can go wrong without throwing: the mesh turned so the thumb is not on
// the grip's -Z or the fingers do not run down its -Y, a left hand that is the
// right one again, or the grip point off the palm.

console.log('\nown hand')
{
  const glb = new URL(`../public/${HAND_GLB}`, import.meta.url)
  check(fs.existsSync(glb) && fs.existsSync(new URL(`../public/${HAND_GLB.replace(/\.glb$/, '.webp')}`, import.meta.url)), `${HAND_GLB} and its map are shipped (tools/props/gen/ship.mjs hand)`)
  const { json } = readGlb(glb)
  const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION]
  const span = [0, 1, 2].map((k) => pos.max[k] - pos.min[k])
  check(Math.abs(span[2] - 1) < 0.01 && span[2] > span[0] && span[2] > span[1], 'the shipped hand is Tripo\'s unit box with its length along Z, which HAND_SCALE_M and HAND_GRIP measure in', span.map((v) => v.toFixed(3)).join(' '))
  check(HAND_GRIP.x > 0 && HAND_GRIP.x < pos.max[0] && HAND_GRIP.z > 0 && HAND_GRIP.z < pos.max[2] && Math.abs(HAND_GRIP.y) < 0.1, 'the grip point is inside the box, on the palm side (+X) of the fingers\' half')
  check(Math.abs(HAND_QUAT.length() - 1) < 1e-9, 'HAND_QUAT is unit')
  const turned = (v) => new THREE.Vector3(...v).applyQuaternion(HAND_QUAT)
  const pitch = THREE.MathUtils.degToRad(HAND_PITCH_DEG), cos = Math.cos(pitch), sin = Math.sin(pitch)
  check(turned([-1, 0, 0]).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-9, 'the back of the hand (mesh -X) faces the grip\'s +X, the right hand\'s, which the pitch turns about')
  const fingers = turned([0, 0, 1]), forearm = turned([0, 0, -1]), thumb = turned([0, 1, 0])
  check(fingers.distanceTo(new THREE.Vector3(0, -cos, -sin)) < 1e-9, `the fingers (mesh +Z) run down the grip's -Y, pitched ${HAND_PITCH_DEG} about the palm`)
  check(forearm.z > 0 && forearm.y > 0 && Math.abs(forearm.y - cos) < 1e-9, 'so the forearm (mesh -Z) leans from the grip\'s +Y toward +Z: down, with the hand held out thumb up')
  check(thumb.distanceTo(new THREE.Vector3(0, sin, -cos)) < 1e-9, 'and the thumb (mesh +Y) points down the grip\'s -Z, pitched with it')
  // A three-vertex asset: the grip point, one unit along the fingers, one along the thumb.
  const g = HAND_GRIP
  const geometry = handGeometry({
    pos: [g.x, g.y, g.z, g.x, g.y, g.z + 1, g.x, g.y + 1, g.z],
    nrm: [0, 0, 1, 0, 0, 1, 0, 0, 1], uv: [0, 0, 1, 0, 0, 1], idx: [0, 1, 2],
  })
  const at = (i) => new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('position'), i)
  check(at(0).length() < 1e-6, 'handGeometry puts the grip point at the origin')
  check(at(1).distanceTo(fingers.clone().multiplyScalar(HAND_SCALE_M)) < 1e-6 && at(2).distanceTo(thumb.clone().multiplyScalar(HAND_SCALE_M)) < 1e-6, `and a mesh unit is ${HAND_SCALE_M} m, along the turned axes`)
  const bank = { geometry, material: new THREE.MeshLambertMaterial() }
  const right = ownHand(bank, 'right'), left = ownHand(bank, 'left')
  check(right.geometry === geometry && left.geometry === geometry && right.material === left.material, 'both hands share the one geometry and material')
  check(right.scale.x === 1 && left.scale.x === -1 && left.scale.y === 1 && left.scale.z === 1, 'the right hand is the mesh as shipped and the left is its mirror across the palm')
  let threw = false
  try { ownHand(bank, 'both') } catch { threw = true }
  check(threw, 'a side that is not left or right throws')
}

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
