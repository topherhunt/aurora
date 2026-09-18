// Node-side gates for the walk surface and the capsule (src/v2/walk.js,
// src/player.js). Rocks are SCRIPTED here rather than scattered: the question
// is what the walker does with a span of stone at a given height, and a real
// bed cannot be asked to put an overhang at 2.5 m over flat ground on demand.
// That columnAt reports the stone that is really there is check-rocks.mjs's.
//
//   node scripts/check-walk.mjs
//
// Every case is a walk: Player is driven frame by frame at walking pace across
// flat ground with one piece of stone in the way, and what is asserted is where
// she ends up. Pass or fail is decided by the same _tryMove the headset runs.

import * as THREE from 'three'

import { WalkSurface, WALK } from '../src/v2/walk.js'
import { Player, LOCOMOTION } from '../src/player.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const GROUND = 60
const field = { heightAt: () => GROUND }
const trees = { trunkAt: () => null }

// Stone as axis-aligned boxes: [x0, x1, z0, z1, bottom, top]. `columnAt` is
// what the walker reads; `blockTopAt` is what a spawn or a teleport reads.
const stone = (boxes) => ({
  columnAt(x, z, minSize, out) {
    let w = 0
    for (const b of boxes) {
      if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue
      out[w * 2] = b[4]
      out[w * 2 + 1] = b[5]
      w++
    }
    return w
  },
  blockTopAt(x, z) {
    let top = -Infinity
    for (const b of boxes) {
      if (x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3]) top = Math.max(top, b[5])
    }
    return top
  },
})

// A player facing `yaw` on a desktop rig: the camera is a child of the rig at
// eye height, so the locomotion origin is the rig and forward is the camera's.
// (0, 0, -1) turned by yaw about Y is (-sin, 0, -cos), so -PI/2 faces +x.
// `feet` puts her at a foot height a spawn would not choose -- under a ledge.
const walker = (rocks, x, z, yaw, feet) => {
  const rig = new THREE.Group()
  const camera = new THREE.PerspectiveCamera()
  camera.position.y = LOCOMOTION.eyeHeight
  camera.rotation.y = yaw
  rig.add(camera)
  const player = new Player(rig, camera, new WalkSurface(field, rocks, trees))
  player.spawnAt(x, z)
  if (feet !== undefined) player.smoothY = player.standY = rig.position.y = feet
  rig.updateMatrixWorld(true)
  return player
}
const DT = 1 / 72
const INPUT = { move: 1, strafe: 0, lift: 0, turn: 0, unstick: false, instant: true }
// Walk for `seconds`, returning the frame she was first refused a step, or -1.
const walk = (player, seconds) => {
  let blockedAt = -1
  const frames = Math.round(seconds / DT)
  for (let f = 0; f < frames; f++) {
    player.update(DT, INPUT)
    player.rig.updateMatrixWorld(true)
    if (player.blocked && blockedAt < 0) blockedAt = f
  }
  return blockedAt
}
// Silence the once-a-second locomotion diagnostic in Player.update.
const warn = console.warn
console.warn = () => {}

console.log('\n=== walk checks ===\n')

console.log('the capsule')
{
  // A BRIDGE with room under it. Bottom at reach + 1 m over her feet, top above
  // her crown: the topmost-surface answer read this as a wall and stopped her
  // at x = 10. She is expected to walk under it, on the ground the whole way.
  const bridge = [10, 12, -5, 5, GROUND + WALK.height + 0.6, GROUND + WALK.height + 1.6]
  const p = walker(stone([bridge]), 5, 0, -Math.PI / 2)
  let lifted = 0
  for (let f = 0; f < Math.round(8 / DT); f++) {
    p.update(DT, INPUT)
    p.rig.updateMatrixWorld(true)
    if (p.standY > GROUND + 1e-6) lifted++
  }
  check(p.rig.position.x > 13 && !p.blocked, 'she walks under a bridge her head clears',
    `reached x = ${p.rig.position.x.toFixed(2)}${p.blocked ? ', blocked' : ''}`)
  check(lifted === 0, 'and stays on the ground beneath it rather than being lifted onto it',
    `${lifted} frames with her feet above the ground`)
  check(p.th.heightAt(11, 0) === bridge[5],
    'while a teleport or a spawn asked without a foot height still lands on top of it')
}
{
  // A WALL from the ground past her crown. She stops at it, a shoulder short,
  // and every frame after is a refused step rather than a shove.
  const p = walker(stone([[20, 22, -5, 5, GROUND, GROUND + 3]]), 18, 0, -Math.PI / 2)
  const blockedAt = walk(p, 3)
  const x = p.rig.position.x
  check(blockedAt >= 0 && x < 20 && x > 20 - WALK.radius - 0.05,
    'she stops at a wall a shoulder short of it', `x = ${x.toFixed(2)}, refused from frame ${blockedAt}`)
  check(p.standY === GROUND, 'with her feet on the ground, not on the wall')
}
{
  // A LEDGE at head height: bottom above reach, so not a step, and below her
  // crown, so not a bridge. A bump.
  const p = walker(stone([[20, 22, -5, 5, GROUND + WALK.reach + 0.2, GROUND + WALK.height - 0.2]]), 18, 0, -Math.PI / 2)
  walk(p, 3)
  check(p.blocked && p.rig.position.x < 20, 'a ledge between her knee and her crown stops her',
    `x = ${p.rig.position.x.toFixed(2)}`)
}
{
  // A STEP within reach: she mantles onto it and walks off the far side.
  const step = [20, 22, -5, 5, GROUND, GROUND + WALK.reach - 0.1]
  const p = walker(stone([step]), 18, 0, -Math.PI / 2)
  let onTop = 0
  for (let f = 0; f < Math.round(5 / DT); f++) {
    p.update(DT, INPUT)
    p.rig.updateMatrixWorld(true)
    if (p.standY === step[5]) onTop++
  }
  check(p.rig.position.x > 23 && !p.blocked, 'a step within reach is climbed and left again',
    `reached x = ${p.rig.position.x.toFixed(2)}`)
  check(onTop > 0, 'and she stood on top of it on the way', `${onTop} frames on the step`)
  check(p.standY === GROUND, 'and is back on the ground past it')
}
{
  // A FACE just past reach, ground to well over her head. The stride rule alone
  // would have let her straight up a 1.79 m step; reach is the ceiling now.
  const p = walker(stone([[20, 22, -5, 5, GROUND, GROUND + WALK.reach + 0.1]]), 18, 0, -Math.PI / 2)
  walk(p, 3)
  check(p.blocked && p.standY === GROUND && p.rig.position.x < 20,
    'a face just past reach is a wall, not a step', `x = ${p.rig.position.x.toFixed(2)}`)
}
{
  // THE SLIDE. Walking into a wall at 45 degrees (+x, -z), she is carried along
  // it rather than stopped: x holds a shoulder short of the wall and z keeps
  // falling.
  const p = walker(stone([[20, 22, -50, 50, GROUND, GROUND + 3]]), 18, 0, -Math.PI / 4)
  walk(p, 6)
  check(p.rig.position.x < 20 && p.rig.position.z < -3,
    'pressed into a wall at an angle she slides along it', `x = ${p.rig.position.x.toFixed(2)}, z = ${p.rig.position.z.toFixed(2)}`)
}
{
  // ALREADY IN STONE. Put under a ledge with her head inside it (a spawn would
  // have stood her on top), every step out would be a step into stone; the
  // entry-only rule lets her walk clear.
  const p = walker(stone([[18, 22, -5, 5, GROUND + WALK.reach + 0.2, GROUND + WALK.height - 0.2]]), 19, 0, -Math.PI / 2, GROUND)
  walk(p, 4)
  check(p.rig.position.x > 22.5, 'stone she is already inside does not fence her in', `x = ${p.rig.position.x.toFixed(2)}`)
}
{
  // REVERSIBLE. Under the bridge and back out the way she came, and up the step
  // and back down it: what let her in lets her out.
  const rocks = stone([
    [10, 12, -5, 5, GROUND + WALK.height + 0.6, GROUND + WALK.height + 1.6],
    [20, 22, -5, 5, GROUND, GROUND + WALK.reach - 0.1],
  ])
  const there = walker(rocks, 5, 0, -Math.PI / 2)
  walk(there, 15)
  const back = walker(rocks, there.rig.position.x, 0, Math.PI / 2)
  walk(back, 15)
  check(there.rig.position.x > 23 && back.rig.position.x < 5 && !back.blocked,
    'the way in is the way out, under the bridge and over the step',
    `out to x = ${there.rig.position.x.toFixed(2)}, back to x = ${back.rig.position.x.toFixed(2)}`)
}
{
  // pathClear, which the teleport asks: refused through a wall, allowed under a
  // bridge, and refused under a ledge.
  const p = walker(stone([
    [10, 12, -5, 5, GROUND + WALK.height + 0.6, GROUND + WALK.height + 1.6],
    [20, 22, -5, 5, GROUND, GROUND + 3],
    [30, 32, -5, 5, GROUND + WALK.reach + 0.2, GROUND + WALK.height - 0.2],
  ]), 5, 0, -Math.PI / 2)
  check(p.pathClear(5, 0, 15, 0), 'a teleport path runs under a bridge')
  check(!p.pathClear(15, 0, 25, 0), 'and not through a wall')
  check(!p.pathClear(25, 0, 35, 0), 'and not under a ledge at head height')
}

{
  console.log('\nthe added stone')
  // A layer registered after construction -- the dead wood -- is stone in the
  // same terms as the rocks: a step within reach she mantles, a wall over her
  // crown stops her, and a top under the ground is nothing to her at all. The
  // same boxes as above, handed to addStone rather than the constructor.
  let threw = false
  try { new WalkSurface(field, stone([]), trees).addStone({ columnAt() {} }) } catch { threw = true }
  check(threw, 'a layer without columnAt and blockTopAt is refused loudly')
  const over = (boxes, x, z, yaw) => {
    const p = walker(stone([]), x, z, yaw)
    p.th.addStone(stone(boxes))
    return p
  }
  const step = [20, 22, -5, 5, GROUND, GROUND + WALK.reach - 0.1]
  let p = over([step], 18, 0, -Math.PI / 2)
  let topped = 0
  for (let f = 0; f < Math.round(4 / DT); f++) {
    p.update(DT, INPUT)
    p.rig.updateMatrixWorld(true)
    if (Math.abs(p.standY - step[5]) < 1e-6) topped++
  }
  check(p.rig.position.x > 23 && !p.blocked && topped > 0, 'a low log from an added layer is a step she walks over',
    `x = ${p.rig.position.x.toFixed(2)}, ${topped} frames on top`)
  p = over([[20, 22, -5, 5, GROUND, GROUND + 3]], 18, 0, -Math.PI / 2)
  walk(p, 3)
  check(p.blocked && p.rig.position.x < 20 && p.standY === GROUND, 'a tall stump from an added layer is a wall',
    `x = ${p.rig.position.x.toFixed(2)}`)
  p = over([[20, 22, -5, 5, GROUND - 2, GROUND - 0.2]], 18, 0, -Math.PI / 2)
  walk(p, 4)
  check(!p.blocked && p.rig.position.x > 23 && p.standY === GROUND, 'and a log the ground has swallowed is no obstacle',
    `x = ${p.rig.position.x.toFixed(2)}`)
  const w = new WalkSurface(field, stone([[0, 1, 0, 1, GROUND, GROUND + 0.5]]), trees)
  w.addStone(stone([[0, 1, 0, 1, GROUND, GROUND + 0.9]]))
  check(w.heightAt(0.5, 0.5) === GROUND + 0.9 && w.heightAt(0.5, 0.5, GROUND) === GROUND + 0.9,
    'the highest top over the point wins across layers, asked with or without her feet')
  // Rocks.blockTopAt settles a prop into the stone unless told not to; a teleport
  // landed on that seat stands inside the boulder and rides up to the top the
  // walker reads. The surface asked without her feet must be the walker's.
  const seat = stone([[0, 1, 0, 1, GROUND, GROUND + 1]])
  const seatTop = seat.blockTopAt
  seat.blockTopAt = (x, z, minSize, settle = true) => seatTop(x, z) - (settle ? 0.35 : 0)
  const s = new WalkSurface(field, seat, trees)
  check(s.heightAt(0.5, 0.5) === GROUND + 1 && s.heightAt(0.5, 0.5) === s.heightAt(0.5, 0.5, GROUND),
    'a teleport or a spawn lands on the stone itself, not the seat a prop is settled to',
    `without feet ${s.heightAt(0.5, 0.5)}, with ${s.heightAt(0.5, 0.5, GROUND)}`)
  // A deck's slope is its own: a boat's sole four metres over the lake bed is
  // level ground at its tip, where the field a stride ahead is far below.
  const boxes = [[0, 1, 0, 1, GROUND + 3.5, GROUND + 4]]
  const deck = stone(boxes)
  const plain = new WalkSurface(field, deck, trees)
  check(plain.slopeAt(0.9, 0.5) > Math.PI / 4, 'a high stone top is a cliff to the slope rule at its edge', `${(plain.slopeAt(0.9, 0.5) * 180 / Math.PI).toFixed(0)} deg`)
  deck.deckAt = (x, z) => deck.blockTopAt(x, z) > -Infinity
  check(plain.slopeAt(0.9, 0.5) === 0 && plain.slopeAt(1.5, 0.5) > Math.PI / 4,
    'but a deck is level at its edge, and the ground beside it is still the ground', `${(plain.slopeAt(0.9, 0.5) * 180 / Math.PI).toFixed(0)} deg on, ${(plain.slopeAt(1.5, 0.5) * 180 / Math.PI).toFixed(0)} deg off`)
}

console.warn = warn
console.log(failures ? `\n${failures} FAILED\n` : '\nall walk checks passed\n')
process.exit(failures ? 1 : 0)
