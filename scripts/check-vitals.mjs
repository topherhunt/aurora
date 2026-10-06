// Node-side gates for her health, sleep and eating (src/v2/vitals.js, src/v2/eating.js, the fall in src/player.js, design/33-vitals.md).
//
//   node scripts/check-vitals.mjs
//
// A fall is walked off a cliff by the same Player.update the headset runs, and priced by fallDamage; the bed is a rolled house's own.

import * as THREE from 'three'

import { Player, LOCOMOTION } from '../src/player.js'
import { WALK, WalkSurface } from '../src/v2/walk.js'
import { InteriorStone, flatField, rollInterior } from '../src/v2/rooms/interior.js'
import { celestial, CLOCK } from '../src/clock.js'
import { WILD, WildStriders } from '../src/v2/render/wild-striders.js'
import { BED_REACH_M, FALL, Health, MAX_HP, SLEEP, Sleep, besideBed, fallDamage, feetOnBed, hoursToBoundary, inBed, leadsSleep, liesOn, rayHitsBed } from '../src/v2/vitals.js'
import { Bites, EAT, Effects, edible } from '../src/v2/eating.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const GROUND = 60
const DT = 1 / 72
const INPUT = { move: 1, strafe: 0, lift: 0, turn: 0, unstick: false, instant: true }
const noStone = { columnAt: () => 0, blockTopAt: () => -Infinity }
const trees = { trunkAt: () => null }
console.warn = () => {}

// She walks +x (yaw -PI/2) from x = 8 for `seconds` over `ground`; what she lands from, summed over every landing.
function walkOff(ground, { scale = 1, level, seconds = 5, input = INPUT } = {}) {
  const rig = new THREE.Group()
  const camera = new THREE.PerspectiveCamera()
  camera.position.y = LOCOMOTION.eyeHeight
  camera.rotation.y = -Math.PI / 2
  rig.add(camera)
  rig.scale.setScalar(scale)
  const surface = new WalkSurface(ground, noStone, trees, { scale })
  if (level !== undefined) surface.setWater(() => level)
  const p = new Player(rig, camera, surface, { scale })
  p.spawnAt(8, 0)
  rig.updateMatrixWorld(true)
  let fell = 0
  for (let f = 0; f < Math.round(seconds / DT); f++) {
    p.update(DT, input)
    rig.updateMatrixWorld(true)
    fell += p.fell
  }
  return { p, fell }
}
const cliff = (drop) => ({ heightAt: (x) => (x < 10 ? GROUND : GROUND - drop) })

console.log('\n=== vitals checks ===\n')

console.log('falling')
check(fallDamage(FALL.safeM) === 0 && fallDamage(9) === 25 && fallDamage(20) === 80 && fallDamage(24) === MAX_HP, 'a fall costs nothing to 4 m and 5 HP a metre past it, so she survives 20 m', `9 m: ${fallDamage(9)}, 20 m: ${fallDamage(20)}, 24 m: ${fallDamage(24)}`)
check(FALL.riddenM === 2 * FALL.safeM && fallDamage(8, FALL.riddenM) === 0 && fallDamage(12, FALL.riddenM) === 20, 'on a strider a fall is free to twice that, 8 m', `12 m: ${fallDamage(12, FALL.riddenM)}`)
{
  // A ridden leap off a 12 m drop through the real hop and _fall on a stub mount: aimTeleport leaps from WILD.hop.cap under its feet.
  const P = WildStriders.prototype, hurts = []
  const m = { pose: { x: 0, z: 0, y: 12, heading: 0, size: 1 }, ride: { last: null, gain: 1, still: 0, base: {}, off: {}, fall: null, lastY: 0 } }
  const ws = Object.assign(Object.create(P), {
    ridden: m, harm: (n) => hurts.push(n), walk: { heightAt: () => 0, waterAt: () => null }, _deep: () => false,
    _seat: (mm, out) => out.set(mm.pose.x, mm.pose.y, mm.pose.z), _float() {}, _say() {}, _set() {}, _chirp() {},
  })
  const rider = { scale: 1, carry() {} }
  ws.hop(3, 12 - WILD.hop.cap, 0, 6, rider, true)
  for (let i = 0; i < 2000 && m.ride.fall; i++) ws._fall(m, DT, rider)
  check(m.pose.y === 0 && hurts.length === 1 && hurts[0] === fallDamage(12, FALL.riddenM), 'a 12 m leap on a strider is priced from its feet, not where the leap starts', `hurt ${hurts}`)
}
{
  const { p, fell } = walkOff(cliff(9))
  check(p.standY === GROUND - 9 && Math.abs(fell - 9) < 1e-6, 'walking off a 9 m cliff is a fall of 9 m', `fell ${fell.toFixed(3)}, feet at ${p.standY}`)
  check(fallDamage(fell) === 25, 'which costs her 25 HP', `${fallDamage(fell)}`)
}
{
  const { fell } = walkOff(cliff(4))
  check(fallDamage(fell) === 0, 'a 4 m drop costs nothing', `fell ${fell.toFixed(3)}`)
}
{
  const { fell } = walkOff(cliff(4), { scale: 0.5 })
  check(Math.abs(fell - 8) < 1e-6 && fallDamage(fell) === 20, 'at half size a 4 m drop is 8 of her metres, 20 HP', `fell ${fell.toFixed(3)}`)
}
{
  const slope = Math.tan((30 * Math.PI) / 180)
  const { p, fell } = walkOff({ heightAt: (x) => GROUND - Math.max(0, x - 10) * slope }, { seconds: 15 })
  check(p.standY < GROUND - 5 && fell === 0, 'walking down a 30 degree hillside is no fall', `down ${(GROUND - p.standY).toFixed(1)} m, fell ${fell}`)
}
{
  const { p, fell } = walkOff(cliff(9), { level: GROUND - 2 })
  check(p.swimming && fell === 0, 'a 9 m drop into water over her head is no fall', `swimming ${p.swimming}, fell ${fell}`)
}
{
  const { p } = walkOff(cliff(9), { seconds: 0.1 })
  p.teleportTo(20, 0)
  p.update(DT, { ...INPUT, move: 0 })
  check(p.standY === GROUND - 9 && p.fell === 0, 'a teleport down the cliff is no fall', `fell ${p.fell}`)
}
{
  const ground = { h: GROUND, heightAt: () => ground.h }
  const { p } = walkOff(ground, { seconds: 0.5, input: { ...INPUT, move: 0 } })
  ground.h -= 47
  let fell = 0
  for (let f = 0; f < 72; f++) { p.update(DT, { ...INPUT, move: f < 36 ? 0 : 1 }); p.rig.updateMatrixWorld(true); fell += p.fell }
  check(p.standY === GROUND - 47 && fell === 0, 'the ground sinking under her as a room builds is no fall', `fell ${fell}`)
}

console.log('health')
{
  const h = new Health()
  const first = h.harm(30)
  check(!first && h.hp === 70 && h.hurt === 0, 'above half health she is unhurt to the eye', `hp ${h.hp}, hurt ${h.hurt}`)
  h.harm(45)
  check(Math.abs(h.hurt - 0.5) < 1e-9, 'the hurt rises from half health to death', `hp ${h.hp}, hurt ${h.hurt}`)
  const died = h.harm(50)
  check(died && h.dead && h.hp === 0 && h.hurt === 1, 'a blow past her health kills her at 0 HP', `hp ${h.hp}`)
  check(!h.harm(10) && h.hp === 0, 'the dead take no more harm')
  h.heal()
  check(h.hp === MAX_HP && !h.dead, 'healing is to full')
}

console.log('the room that sleeps')
{
  let ok = true
  let worst = ''
  for (let hour = 0; hour < 24; hour += 0.25) {
    const h = hoursToBoundary(hour)
    const up = (t) => celestial(t, CLOCK.latitude, CLOCK.declination).elevDeg > 0
    if (!(h > 0 && h <= 13.5) || up(hour + h - 1 / 60) !== up(hour) || up(hour + h) === up(hour)) { ok = false; worst = `${hour} h -> +${h} h` }
  }
  check(ok, 'a sleep skips to the minute the sun next crosses the horizon, never more than a night', worst)
  const noon = hoursToBoundary(12), night = hoursToBoundary(2)
  check(celestial(12 + noon, CLOCK.latitude, CLOCK.declination).elevDeg <= 0 && celestial(2 + night, CLOCK.latitude, CLOCK.declination).elevDeg > 0,
    'from noon to dusk, from the small hours to dawn', `noon +${noon.toFixed(2)} h, 2 am +${night.toFixed(2)} h`)
  const ids = ['c9', 'a3', 'f1']
  check(ids.filter((id) => leadsSleep(id, ids.filter((o) => o !== id))).length === 1 && leadsSleep('a3', ['c9', 'f1']),
    'exactly one sleeper asks the relay, the lowest id')
  check(leadsSleep('a3', []), 'alone, she asks for herself')
}

console.log('the bed')
{
  const room = rollInterior({ seed: 1000, index: 2, height: 5 })
  const spot = room.spots.find((s) => s.kind === 'bed')
  const bed = { x: spot.x, z: spot.z, top: spot.top, floor: spot.floor, yaw: spot.yaw, len: spot.len, wid: spot.wid }
  const s = Math.sin(bed.yaw), c = Math.cos(bed.yaw)
  const at = (along, rise) => ({ x: bed.x + along * s, y: bed.top + rise, z: bed.z + along * c })
  const up = { x: 0, y: 1, z: 0 }
  const scale = 0.5
  const pillow = at(bed.len / 2 - 0.2, 0.15)
  check(liesOn(bed, pillow, up, scale), 'her head low over the pillow, face up, is lying in it')
  check(!liesOn(bed, pillow, { x: s, y: 0, z: c }, scale), 'face level is not')
  check(!liesOn(bed, at(-bed.len / 2 + 0.2, 0.15), up, scale), 'her head at its foot is not')
  check(!liesOn(bed, at(bed.len / 2 - 0.2, LOCOMOTION.eyeHeight * scale), up, scale), 'standing on it looking up is not')
  check(inBed(bed, pillow, scale) && inBed(bed, at(-bed.len / 2 + 0.2, 0.15), scale), 'a peer with its head low over the mattress, either end, is in it')
  const side = { x: pillow.x + (bed.wid / 2 + 0.3) * c, y: bed.top - 0.2 + LOCOMOTION.eyeHeight * scale, z: pillow.z - (bed.wid / 2 + 0.3) * s }
  check(!inBed(bed, side, scale) && !inBed(bed, at(0, LOCOMOTION.eyeHeight * scale), scale), 'a peer standing beside it or on it is not')
  const eye = at(-bed.len / 2 - 0.6, LOCOMOTION.eyeHeight * scale)
  const foot = at(-bed.len / 2 + 0.1, 0)
  const toward = new THREE.Vector3(foot.x - eye.x, foot.y - eye.y, foot.z - eye.z).normalize()
  const t = rayHitsBed(bed, eye, toward)
  check(t !== null && t < BED_REACH_M * scale, 'a click from its foot at the bed lands on it, in reach', `at ${t}`)
  check(rayHitsBed(bed, eye, { x: -toward.x, y: toward.y, z: -toward.z }) === null, 'a click away from it misses')

  const margin = WALK.radius * scale + 0.05
  check(feetOnBed(bed, at(0, 0.04), 0), 'feet on its mattress are on it')
  check(!feetOnBed(bed, at(0, -1.5), margin), 'feet on a floor well under it are not')
  // Walked at from beside it by the same Player.update the headset runs, on the house's own stone.
  const walk = new WalkSurface(flatField(0), new InteriorStone(room, 0, 0, 0), trees, { scale })
  const rig = new THREE.Group()
  const camera = new THREE.PerspectiveCamera()
  camera.position.y = LOCOMOTION.eyeHeight
  rig.add(camera)
  rig.scale.setScalar(scale)
  const p = new Player(rig, camera, walk, { scale })
  const by = besideBed(spot, walk)
  p.spawnAt(by.x - by.fx, by.z - by.fz, spot.top - 0.2)
  check(!feetOnBed(bed, rig.position, margin), 'standing back from it, she is not on it', `${rig.position.x.toFixed(2)}, ${rig.position.z.toFixed(2)}`)
  camera.rotation.y = Math.atan2(-by.fx, -by.fz)
  rig.updateMatrixWorld(true)
  let reached = false
  for (let f = 0; f < Math.round(3 / DT) && !reached; f++) {
    p.update(DT, INPUT)
    rig.updateMatrixWorld(true)
    reached = feetOnBed(bed, rig.position, margin)
  }
  check(reached, 'walking at it puts her feet on it', `${rig.position.x.toFixed(2)}, ${rig.position.y.toFixed(2)}, ${rig.position.z.toFixed(2)}`)
}

console.log('sleep')
{
  const run = (sleep, seconds, frame) => {
    const events = []
    for (let f = 0; f < Math.round(seconds / DT); f++) {
      const e = sleep.update(DT, frame(f))
      if (e) events.push(e)
    }
    return events
  }
  const head = { x: 0, y: 0.1, z: 0 }, fwd = { x: 0, y: 1, z: 0 }
  const still = () => ({ lying: true, press: false, head, fwd, scale: 1 })
  const a = new Sleep()
  run(a, SLEEP.stillS - 0.1, still)
  check(a.state === 'lying' && a.lid === 0, 'lying still, her eyes stay open until the stillness has run', a.state)
  const fell = run(a, 0.2 + SLEEP.closeS + 0.1, still)
  check(a.state === 'asleep' && a.lid === 1 && fell.join() === 'asleep', 'then they close, and she sleeps', `${a.state}, ${fell}`)
  const woke = run(a, 0.1, (f) => ({ ...still(), press: f === 0 }))
  check(woke.join() === 'woke' && a.state === 'opening', 'a button wakes her, the lids still shut', `${woke}`)
  run(a, SLEEP.openS + 0.1, () => ({ ...still(), lying: false }))
  check(a.state === 'awake' && a.lid === 0, 'and they open')

  const b = new Sleep()
  run(b, SLEEP.stillS * 3, (f) => ({ ...still(), head: { x: 0, y: 0.1, z: f % 216 < 108 ? 0 : 0.3 } }))
  check(b.state === 'lying' && b.lid === 0, 'tossing about restarts the stillness', `${b.state}`)

  const c = new Sleep()
  run(c, SLEEP.stillS + SLEEP.closeS + 0.1, still)
  const sat = run(c, 0.1, () => ({ ...still(), head: { x: 0, y: 0.1 + 0.3, z: 0 } }))
  check(sat.join() === 'woke', 'in the headset, sitting up wakes her')

  const d = new Sleep()
  run(d, 1, still)
  const got = run(d, 0.1, () => ({ ...still(), lying: false }))
  check(got.join() === 'up' && d.state === 'awake', 'getting out of bed before sleeping is getting up', d.state)
}

console.log('eating')
{
  const h = new Health()
  h.harm(30)
  h.heal(EAT.heal)
  check(h.hp === 80, 'food heals by its share, not to full', `hp ${h.hp}`)
  h.heal(50)
  check(h.hp === MAX_HP, 'and never past full', `hp ${h.hp}`)
  h.harm(MAX_HP)
  h.heal(EAT.heal)
  check(h.dead, 'the dead are not fed back to life')

  const carrot = { kind: 'carrot' }, fish = { kind: 'fish' }, cap = { kind: 'mushroom', name: 'ink cap' }
  check(edible(carrot) && edible(fish) && edible(cap) && !edible({ kind: 'spider' }) && !edible(null), 'carrots, fish and mushrooms are food; a spider and an empty hand are not')
  let threw = false
  try { edible({ kind: 'mushroom', name: 'toadstool' }) } catch { threw = true }
  check(threw, 'a mushroom eating.js does not know throws')

  const b = new Bites()
  const steps = (n, at) => { let ate = 0; for (let i = 0; i < n; i++) if (b.step('left', at, 0.1)) ate++; return ate }
  check(steps(19, true) === 0 && Math.abs(b.progress('left') - 0.95) < 1e-9, `short of ${EAT.holdS} s at her mouth, nothing is eaten`, `progress ${b.progress('left')}`)
  steps(1, false)
  check(b.progress('left') === 0 && steps(19, true) === 0, 'taking it from her mouth starts the bite over')
  check(steps(1, true) + steps(1, true) === 1, `${EAT.holdS} s there and it is eaten, once`)

  const e = new Effects()
  const run = (s) => { for (let t = 0; t < s - 1e-9; t += 0.05) e.update(0.05) }
  check(e.eat(carrot).heal === EAT.heal && e.eat(carrot).harm === 0, 'a carrot heals and does not harm')
  const ink = e.eat(cap)
  check(ink.harm === EAT.harm && ink.sound === 'zoom', 'an ink cap harms, and zooms')
  run(EAT.size.easeS / 2)
  check(Math.abs(e.size - Math.SQRT1_2) < 1e-6, 'halfway through the ease she is halfway to half, in ratio', e.size.toFixed(4))
  run(EAT.size.easeS / 2 + 0.1)
  check(Math.abs(e.size - 0.5) < 1e-9, `after ${EAT.size.easeS} s she is half her size`, e.size)
  for (let i = 0; i < 4; i++) e.eat(cap)
  run(EAT.size.easeS + 0.1)
  check(e.size === EAT.size.min, 'ink caps stack down to an eighth and no further', e.size)
  const up = e.eat({ kind: 'mushroom', name: 'parasol' })
  run(EAT.size.easeS + 0.1)
  check(up.sound === 'zoomBack' && e.size === 2 * EAT.size.min, 'a parasol doubles her, zooming backward', e.size)
  for (let i = 0; i < 5; i++) e.eat({ kind: 'mushroom', name: 'parasol' })
  run(EAT.size.easeS + 0.1)
  check(e.size === EAT.size.max, 'parasols stack up to twice and no further', e.size)

  const A = EAT.agaric
  e.eat({ kind: 'mushroom', name: 'fly agaric' })
  run(A.inS / 2)
  const halfIn = e.seeing
  run(A.inS / 2 + 0.1)
  check(Math.abs(halfIn - 0.5) < 0.02 && e.seeing === 1 && e.tint[1] > e.tint[0], 'the fly agaric fades in green', `${halfIn.toFixed(2)} then ${e.seeing}`)
  run(A.s - A.inS)
  check(e.seeing > 0 && e.seeing < 1, `and fades out from ${A.s} s`, e.seeing.toFixed(2))
  run(A.outS)
  check(e.seeing === 0, 'and is gone')

  const P = EAT.porcini, porcini = { kind: 'mushroom', name: 'porcini' }
  e.eat(porcini)
  check(e.guard === 1, 'a porcini does not guard against its own harm', `guard ${e.guard}`)
  run(P.inS)
  const one = e.tint[3]
  e.eat(porcini)
  run(P.inS)
  check(e.guard === P.guard * P.guard && e.tint[3] > one, 'two porcini guard twice as hard and brown the view deeper', `guard ${e.guard}`)
  run(P.s - P.inS)
  check(e.guard === P.guard, `each guards for ${P.s} s`, `guard ${e.guard}`)
  run(P.inS + P.outS)
  check(e.guard === 1 && e.porcini.length === 0, 'and then none')

  const C = EAT.chanterelle
  e.eat({ kind: 'mushroom', name: 'chanterelle' })
  run(C.inS + 0.1)
  check(e.maddened && e.dread === 1 && e.tint[3] > 0, 'a chanterelle maddens the animals and darkens the view')
  run(C.s - C.inS)
  check(!e.maddened && e.dread > 0, `for ${C.s} s, the dark fading after`)
  run(C.outS)
  check(e.dread === 0 && e.tint[3] === 0, 'and then nothing')

  e.eat(porcini); e.eat({ kind: 'mushroom', name: 'chanterelle' })
  e.clear()
  check(e.guard === 1 && !e.maddened && e.size === EAT.size.max, 'a revival clears what she is under and keeps her size')
  e.reset()
  check(e.size === 1, 'a new game gives her her own size back')
  e.setSize(0.25)
  e.update(1)
  check(e.size === 0.25, 'a loaded size stands, uneased')
}

console.log(`\n${failures === 0 ? 'all vitals checks passed' : `${failures} vitals check(s) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
