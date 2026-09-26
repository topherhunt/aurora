// Node-side gates for the hob weevils (src/v2/render/hobs.js, design/30-leafkin.md §Hobs).
//
//   node scripts/check-hobs.mjs
//
// One real village (rooms/village.js on a shipped entrance key) with its
// villagers on a stand-in body and the hobs on the shipped hob's skeleton:
// the shipped GLB carries the clips and extras the layer reads; every house
// keeps at most one adult and at most three babies, every baby smaller than
// every adult; through a day with her far off no hob stands in the lake, a
// baby keeps by its parent, a trailing adult by its owner, and a hob with
// nobody to trail keeps its yard; two clients on different frame rates, one
// booting late and one resuming after a pause, put every hob in about the
// same place.

import * as THREE from 'three'
import path from 'node:path'

import { SEED } from '../src/v2/config.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { validate } from '../src/v2/layers/doc.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { buildTextureArray } from '../src/textures.js'
import { CRITTER_GLB, LOD_RUNGS } from '../src/v2/render/critters.js'
import { RoomProps, propBankFrom } from '../src/v2/render/room-props.js'
import { Shell } from '../src/v2/render/shell.js'
import { Villagers } from '../src/v2/render/villagers.js'
import { BABY, CLIPS, HOB_GLB, Hobs, LOSE_M, SIZE_M, SIZE_VAR, TINTS, YARD_R } from '../src/v2/render/hobs.js'
import { WalkSurface } from '../src/v2/walk.js'
import { keyHash } from '../src/sim/score.js'
import { readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { readShippedLadder } from './lib/gen-prop-node.mjs'
import { buildVillage, rollVillage } from '../src/v2/rooms/village.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the village ------------------------------------------------------------------
const KEY = 'hollow:160.0:-356.0'
const houseBank = propBankFrom(readShippedLadder('house-leafkin'))
const spec = rollVillage(keyHash(KEY), houseBank.bounds)
const shell = new Shell(new THREE.Scene(), buildRockBank(), buildTextureArray(), spec.shell)
const room = buildVillage({ spec, shell, house: houseBank.bounds })
const layers = Layers.deserialize(validate(room.doc))
const field = new V2Height({ heightmap: room.heightmap, layers, seed: SEED, relief: RELIEF_SHIPPED })
const roomProps = new RoomProps(new THREE.Scene(), field, { bank: houseBank, props: room.props, clearing: room.clearing })
const walk = new WalkSurface(field, shell, { trunkAt: () => null })
walk.addStone(roomProps)
const water = { isSubmerged: (x, z, y) => y < room.lake.y }
const doors = roomProps.doors()

/** Box tiers skinned whole to the root bone, one a rung. */
const boxTiers = (w, h, d) => Array.from({ length: LOD_RUNGS }, (_, k) => {
  const g = new THREE.BoxGeometry(w, h, d, LOD_RUNGS - k, 1, 1).translate(0, h / 2, 0)
  const n = g.getAttribute('position').count
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
  return g
})
/** A shipped GLB's clips by name and length, each holding one bone still. */
const standInClips = (json, bone) => json.animations.map((a) => {
  const dur = Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))
  return new THREE.AnimationClip(a.name, dur, [new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])])
})

// The villagers on the check-villagers stand-in: a slab on a spine and two legs, sitting where the shipped leafkin sits.
function villagerAsset() {
  const { json } = readGlb(new URL(`../public/${CRITTER_GLB.leafkin}`, import.meta.url))
  const biped = json.scenes[json.scene ?? 0].extras.biped
  const root = new THREE.Bone()
  root.name = 'tripoRoot'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  spine.position.set(0, 0.5, 0)
  root.add(spine)
  const bones = [root, spine]
  const legs = []
  for (const [side, sz] of [['L', 1], ['R', -1]]) {
    const chain = ['Hip', 'Knee', 'Foot'].map((n) => { const b = new THREE.Bone(); b.name = `${n}${side}`; return b })
    chain[0].position.set(0, biped.height * 0.55, sz * biped.width * 0.3)
    chain[1].position.set(biped.height * 0.1, -biped.height * 0.27, 0)
    chain[2].position.set(-biped.height * 0.1, -biped.height * 0.26, 0)
    root.add(chain[0]); chain[0].add(chain[1]); chain[1].add(chain[2])
    bones.push(...chain)
    legs.push({ id: side, chain: chain.map((b) => b.name) })
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const clips = standInClips(json, 'Spine')
  const sit = clips.find((c) => c.name === 'idle-sit')
  sit.tracks.push(new THREE.VectorKeyframeTrack('tripoRoot.position', [0, sit.duration], [0, 0.19 * biped.height, 0, 0, 0.19 * biped.height, 0]))
  return { root, skeleton, tiers: boxTiers(biped.span, biped.height, biped.width), clips, map: null, extras: biped, ...biped, legs }
}

// The hobs on the shipped skeleton itself, so the foot IK reads the real legs.
const hobGlb = readGlb(new URL(`../public/${HOB_GLB}`, import.meta.url)).json
const insect = hobGlb.scenes[hobGlb.scene ?? 0].extras?.insect
function hobAsset() {
  const joints = hobGlb.skins[0].joints
  const bones = joints.map((i) => {
    const n = hobGlb.nodes[i], b = new THREE.Bone()
    b.name = THREE.PropertyBinding.sanitizeNodeName(n.name)
    if (n.translation) b.position.fromArray(n.translation)
    if (n.rotation) b.quaternion.fromArray(n.rotation)
    return b
  })
  joints.forEach((i, k) => { for (const c of hobGlb.nodes[i].children ?? []) if (joints.includes(c)) bones[k].add(bones[joints.indexOf(c)]) })
  const root = bones.find((b) => !b.parent)
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  return { root, skeleton, tiers: boxTiers(insect.span, insect.height, insect.width), clips: standInClips(hobGlb, root.name), map: null, extras: insect, ...insect }
}

const T0 = 1000
const FAR = { x: 400, y: 100, z: 400 }
function make() {
  const villagers = new Villagers(new THREE.Scene(), water, { walk, roads: room.doc.roads, doors, lake: room.lake, seed: spec.seed, asset: villagerAsset() })
  return { villagers, hobs: new Hobs(new THREE.Scene(), { walk, villagers, seed: spec.seed, asset: hobAsset() }) }
}
/** Frames at `hz` from `t` for `seconds`, her far off; `each(t)` after every frame. */
function run(w, t, seconds, each = null, hz = 60) {
  const frames = Math.round(seconds * hz)
  for (let i = 0; i < frames; i++) {
    t += 1 / hz
    w.villagers.update(FAR, FAR, t, 1 / hz)
    w.villagers.voices([])
    w.hobs.update(FAR, t, 1 / hz)
    if (each) each(t)
  }
  return t
}

// --- the asset ---------------------------------------------------------------------
console.log('\nthe asset')
{
  const names = hobGlb.animations.map((a) => a.name)
  check(CLIPS.every((c) => names.includes(c)), 'the shipped hob carries every clip the layer plays', names.join(' '))
  check(insect && insect.span > 0 && insect.gait?.walk > 0 && insect.gait?.run > insect.gait.walk && insect.legs?.length === 6, 'its insect extras carry a span, a walk slower than its run, and six legs', insect ? `span ${insect.span.toFixed(2)} walk ${insect.gait.walk.toFixed(3)} run ${insect.gait.run.toFixed(3)}` : 'none')
}

// --- the households ---------------------------------------------------------------
console.log('\nthe households')
{
  const { villagers, hobs } = make()
  const adults = hobs.all.filter((h) => !h.parent), babies = hobs.all.filter((h) => h.parent)
  const perHouse = new Map()
  for (const h of adults) perHouse.set(h.yard, (perHouse.get(h.yard) ?? 0) + 1)
  check(adults.length > 0 && [...perHouse.values()].every((n) => n === 1) && adults.length <= doors.length, 'at most one adult a house, and some house keeps one', `${adults.length} adults over ${doors.length} houses`)
  const broods = adults.map((a) => babies.filter((b) => b.parent === a).length)
  check(babies.length > 0 && broods.every((n) => n <= 3), 'at most three babies an adult, and some adult has one', `broods ${broods.join(' ')}`)
  check(adults.every((a) => Math.abs(a.size / SIZE_M - 1) <= SIZE_VAR + 1e-9) && babies.every((b) => b.size / b.parent.size >= BABY[0] && b.size / b.parent.size <= BABY[1]), 'every adult is SIZE_M give or take SIZE_VAR, every baby its share of its parent')
  const smallest = Math.min(...adults.map((a) => a.size)), biggest = Math.max(...babies.map((b) => b.size))
  check(biggest < smallest, 'the sizes are two humps: every baby is smaller than every adult', `babies to ${biggest.toFixed(2)} m, adults from ${smallest.toFixed(2)} m`)
  check(new Set(hobs.all.map((h) => h.tint)).size > 1 && hobs.all.every((h) => h.tint >= 0 && h.tint < TINTS.length), 'the tints vary, each one of TINTS', `${new Set(hobs.all.map((h) => h.tint)).size} of ${TINTS.length}`)
  check(adults.some((a) => a.owner) && adults.every((a) => !a.owner || a.owner === villagers.all[doors.findIndex((_, k) => villagers.graph.doorNodes[k] === a.owner.home)]), 'some adults trail an owner, each the villager of its own house', `${adults.filter((a) => a.owner).length} of ${adults.length}`)
  const again = make().hobs
  check(again.all.every((h, i) => h.size === hobs.all[i].size && h.tint === hobs.all[i].tint && !!h.owner === !!hobs.all[i].owner), 'the same seed rolls the same households')
}

// --- a day with her far off ------------------------------------------------------------
console.log('\na day with her far off')
{
  const w = make()
  let frames = 0, wet = 0, babyFar = 0, babyWorst = 0, trailFrames = 0, trailFar = 0, trailWorst = 0, yardFrames = 0, yardOff = 0, yardWorst = 0, runs = 0, eats = 0, walks = 0
  run(w, T0, 600, () => {
    frames++
    for (const h of w.hobs.all) {
      if (h.y < room.lake.y - 0.02) wet++
      if (h.clip === 'run') runs++
      if (h.clip === 'eat') eats++
      if (h.clip === 'walk') walks++
      if (h.parent) {
        const d = Math.hypot(h.x - h.parent.x, h.z - h.parent.z)
        babyWorst = Math.max(babyWorst, d)
        if (d > 3) babyFar++
      } else if (h.owner && w.hobs._out(h)) {
        trailFrames++
        const d = Math.hypot(h.x - h.owner.pose.x, h.z - h.owner.pose.z)
        trailWorst = Math.max(trailWorst, d)
        if (d > 3) trailFar++
      } else {
        yardFrames++
        const d = Math.hypot(h.x - h.yard.x, h.z - h.yard.z)
        if (d > YARD_R + 0.5) yardOff++
        else yardWorst = Math.max(yardWorst, d)
      }
    }
  })
  const n = frames * w.hobs.all.length
  check(wet === 0, 'no hob ever stands in the lake', `${wet} wet hob-frames`)
  check(babyFar / n < 0.01 && babyWorst < LOSE_M, 'a baby keeps within three metres of its parent all but a hundredth of the day', `${(100 * babyFar / n).toFixed(2)}% out, worst ${babyWorst.toFixed(1)} m`)
  check(trailFrames > 0 && trailFar / trailFrames < 0.15, 'an adult trailing its owner keeps within three metres of it most of the time', `${trailFrames} frames, ${(100 * trailFar / Math.max(1, trailFrames)).toFixed(1)}% out, worst ${trailWorst.toFixed(1)} m`)
  check(yardFrames > 0 && yardOff / yardFrames < 0.1, 'an adult with nobody to trail keeps to its yard, bar the walk home', `${(100 * yardOff / Math.max(1, yardFrames)).toFixed(1)}% out`)
  check(walks > 0 && eats > 0 && runs > 0, 'the day has walks, runs and roots in it', `walk ${(100 * walks / n).toFixed(0)}% run ${(100 * runs / n).toFixed(0)}% eat ${(100 * eats / n).toFixed(0)}%`)
}

// --- two clients --------------------------------------------------------------------
console.log('\ntwo clients')
{
  const a = make(), b = make()
  run(a, T0, 300, null, 60)
  run(b, T0, 300, null, 90)
  const gaps = a.hobs.all.map((h, i) => Math.hypot(h.x - b.hobs.all[i].x, h.z - b.hobs.all[i].z))
  const sorted = gaps.slice().sort((p, q) => p - q)
  check(sorted[Math.floor(sorted.length / 2)] < 0.3 && sorted[sorted.length - 1] < 1.5, 'two clients on 60 and 90 Hz frames put every hob in about the same place', `median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} m, worst ${sorted[sorted.length - 1].toFixed(2)} m`)
  // A client booting late, and one whose leafkin were switched off for a minute, against one that watched throughout.
  const late = make(), paused = make()
  run(paused, T0, 240)
  const spread = (w) => {
    const d = a.hobs.all.map((h, i) => Math.hypot(h.x - w.hobs.all[i].x, h.z - w.hobs.all[i].z)).sort((p, q) => p - q)
    return { median: d[Math.floor(d.length / 2)], worst: d[d.length - 1] }
  }
  const worlds = [[late, 'a client booting 300 s in'], [paused, 'a client resuming after 60 s unstepped']]
  let t = T0 + 300
  for (const [span, median, worst] of [[1, 1.5, 3], [29, 0.1, 0.1]]) {
    for (const w of [a, late, paused]) run(w, t, span)
    t += span
    for (const [w, name] of worlds) {
      const s = spread(w)
      check(s.median < median && s.worst < worst, `${name} has every hob within ${worst} m of one that watched throughout, ${t - T0 - 300} s on`, `median ${s.median.toFixed(2)} m, worst ${s.worst.toFixed(2)} m`)
    }
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
