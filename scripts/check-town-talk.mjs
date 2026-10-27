// Node-side gates for talk with the townsfolk at home (render/town-residents.js talkers/hold/approach/release, as conversations.js calls them).
//
//   node scripts/check-town-talk.mjs
//
// Over many houses under a stand-in body: her on its floor, a resident awake there is one she can talk with; sent to her, it walks the house's ways to `come` m of her and waves; held, it turns to her; released, it goes about its house again.

import * as THREE from 'three'
import { planBuilding } from '../src/buildings/plan.js'
import { rollTownInterior } from '../src/v2/rooms/town-interior.js'
import { TownResidents } from '../src/v2/render/town-residents.js'
import { TOWNSFOLK } from '../src/v2/render/townsfolk.js'
import { houseUniforms } from '../src/v2/render/interior.js'
import { TORCHES } from '../src/lighting.js'
import { setPuppetMode } from '../src/v2/render/baked-puppet.js'
import { readGlb } from '../tools/creatures/apply-rig-edit.mjs'

setPuppetMode('skinned')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

// A slab on a root, a spine and two legs, carrying the shipped alchemist's clip names, lengths and gait.
const { json } = readGlb(new URL('../public/creatures/alchemist.glb', import.meta.url))
const biped = json.scenes[json.scene ?? 0].extras.biped
function makeBody() {
  const root = new THREE.Bone()
  root.name = 'tripoRoot'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  root.add(spine)
  const bones = [root, spine], legs = []
  for (const [side, sz] of [['L', 1], ['R', -1]]) {
    const chain = ['Hip', 'Knee', 'Foot'].map((j) => Object.assign(new THREE.Bone(), { name: `${j}${side}` }))
    chain[0].position.set(0, biped.height * 0.55, sz * biped.width * 0.3)
    chain[1].position.set(biped.height * 0.1, -biped.height * 0.27, 0)
    chain[2].position.set(-biped.height * 0.1, -biped.height * 0.26, 0)
    root.add(chain[0]); chain[0].add(chain[1]); chain[1].add(chain[2])
    bones.push(...chain)
    legs.push({ id: side, chain: chain.map((b) => b.name) })
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const g = new THREE.BoxGeometry(biped.span, biped.height, biped.width).translate(0, biped.height / 2, 0)
  const n = g.getAttribute('position').count
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
  const clips = json.animations.map((a) => new THREE.AnimationClip(a.name, Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0])), [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]))
  const asset = { root, skeleton, tiers: [g], clips, map: null, extras: biped, ...biped, legs }
  return { asset, heightM: biped.sizeM, height: biped.height, gait: biped.gait, wheelbase: biped.wheelbase, durations: Object.fromEntries(clips.map((c) => [c.name, c.duration])) }
}
const body = makeBody()
const bodies = TOWNSFOLK.bodies.map(() => body)
const view = { uniforms: houseUniforms({ value: Array.from({ length: TORCHES }, () => new THREE.Vector4()) }) }
const COME = 1.4

const tally = { houses: 0, talk: 0, came: 0, faced: 0, freed: 0 }
const misses = []
for (let s = 1; s <= 12; s++) {
  const room = rollTownInterior({ seed: 4242, index: s, plan: planBuilding({ seed: s * 7919, kind: 'cottage' }), wealth: 0.5 })
  const res = new TownResidents(new THREE.Scene(), room, { bodies, who: [{ id: 1, body: 0, size: 1.7, pace: 1 }], seed: 4242, ox: 0, oy: 0, oz: 0 })
  const r = res.all[0]
  const clips = new Set()
  // Her stood at the door, inside it.
  let feet = { x: room.doorIn.x, y: 0, z: room.doorIn.z }
  const run = (sec) => { for (let i = 0; i < sec * 60; i++) { res.update(1 / 60, view, feet); clips.add(r.clip) } }
  let waited = 0
  run(0.1)
  while (!(r.level === 0 && res.free(r)) && waited < 240) { run(1); waited++ }
  if (!res.free(r)) { misses.push(`house ${s}: never free on the ground floor (${r.state} ${r.phase} level ${r.level})`); continue }
  tally.houses++
  if (res.talkers([]).includes(r)) tally.talk++
  clips.clear()
  res.approach(r, COME)
  run(30)
  const off = Math.hypot(r.x - feet.x, r.z - feet.z)
  if (res.arrived(r) && clips.has('walk') && clips.has('wave') && Math.abs(off - COME) < 0.1) tally.came++
  else misses.push(`house ${s}: ${[...clips].join(' ')}, ${off.toFixed(2)} m off, arrived ${res.arrived(r)}`)
  feet = { x: r.x + 0.9 * Math.sin(r.heading + 1.5), y: 0, z: r.z + 0.9 * Math.cos(r.heading + 1.5) }
  run(3)
  if (res.held(r) && r.state === 'her' && Math.cos(Math.atan2(feet.x - r.x, feet.z - r.z) - r.heading) > 0.9) tally.faced++
  res.release(r)
  run(1)
  if (!res.held(r) && r.state !== 'her') tally.freed++
}
for (const m of misses) console.log(`    ${m}`)
const all = (k) => tally[k] === tally.houses
check(tally.houses >= 10 && all('talk'), 'her on its floor, a resident stood about is one she can talk with', `${tally.talk} of ${tally.houses}`)
check(tally.houses >= 10 && all('came'), `sent to her, it walks the house's ways to ${COME} m of her and waves there`, `${tally.came} of ${tally.houses}`)
check(tally.houses >= 10 && all('faced'), 'held, it turns to face her where she stands', `${tally.faced} of ${tally.houses}`)
check(tally.houses >= 10 && all('freed'), 'released, it goes about its house again', `${tally.freed} of ${tally.houses}`)

console.log(failures === 0 ? '\nall ok' : `\n${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
