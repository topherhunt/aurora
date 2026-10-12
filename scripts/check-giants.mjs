// Gates for the green giants (src/v2/render/giants.js; DESIGN.md §41), in a labyrinth sited on flat synthetic ground.
//
//   node scripts/check-giants.mjs
//
// Its round: from the middle through every cell and back, closed-form, the same on two clients at two frame rates, and
// never out of the maze. Her: noticed ahead within NOTICE_M and not behind, nor high on a tower; chased inside the maze
// slower than she walks; struck for BLOW once in reach; forgotten past FORGET_M, a rejoin owed, and the round taken up
// again. The room: an anchor a second while live, and a peer put live on its player by one.

import * as THREE from 'three'
import { Labyrinths, POST_HEIGHT } from '../src/v2/layers/labyrinths.js'
import { Giants, roundOf, roundAt, HEIGHT_M, NOTICE_M, FORGET_M, REACH_M, BLOW, CHASE_SPEED, ABOVE_M, ANCHOR_S } from '../src/v2/render/giants.js'
import { CRITTER_GLB } from '../src/v2/render/critters.js'
import { LOD_TIERS } from '../src/v2/render/snowmen.js'
import { setPuppetMode } from '../src/v2/render/baked-puppet.js'
import { readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { LOCOMOTION } from '../src/player.js'

setPuppetMode('skinned')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const ground = {
  scatterAt: (x, z, cell, out) => { out.h = 0; out.tan = 0; return out },
  layers: { lakes: { levelAt: () => null }, paths: { riverLevelAt: () => null, nearest: () => null } },
}
const labyrinths = new Labyrinths({ seed: 11, ground })
let site = null
for (let r = 0; site === null && r < 8; r++) site = labyrinths.siteOf(r, 0)
const m = labyrinths.mazeOf(site)
const total = m.cells.length
const walk = { heightAt: () => 0, normalAt: (x, z, e, out) => { out.x = 0; out.y = 1; out.z = 0; return out } }

// A stand-in body on the shipped yeti's numbers: a box on a root, a spine and two three-joint legs, carrying every clip at its shipped length.
const { json } = readGlb(new URL(`../public/${CRITTER_GLB.snowman}`, import.meta.url))
const biped = json.scenes[json.scene ?? 0].extras.biped
function makeAsset() {
  const root = new THREE.Bone()
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  root.add(spine)
  const bones = [root, spine], legs = []
  for (const id of ['L', 'R']) {
    const chain = ['Hip', 'Knee', 'Foot'].map((n) => { const b = new THREE.Bone(); b.name = `${n}${id}`; return b })
    chain[0].position.set(0, biped.height * 0.55, (id === 'L' ? 0.3 : -0.3) * biped.width)
    chain[1].position.set(biped.height * 0.1, -biped.height * 0.27, 0)
    chain[2].position.set(-biped.height * 0.1, -biped.height * 0.26, 0)
    root.add(chain[0]); chain[0].add(chain[1]); chain[1].add(chain[2])
    bones.push(...chain)
    legs.push({ id, chain: chain.map((b) => b.name) })
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = Array.from({ length: LOD_TIERS }, () => {
    const g = new THREE.BoxGeometry(biped.span, biped.height, biped.width).translate(0, biped.height / 2, 0)
    const n = g.getAttribute('position').count
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    return g
  })
  const clips = json.animations.map((a) => {
    const dur = Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))
    return new THREE.AnimationClip(a.name, dur, [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])])
  })
  return { root, skeleton, tiers, clips, map: null, extras: biped, ...biped, legs }
}
const make = () => new Giants(new THREE.Scene(), labyrinths, { walk, asset: makeAsset() })
const FAR = [site.cx + 100, 1.6, site.cz]
const step = (g, t0, t1, fps, her = FAR, each = null) => {
  for (let t = t0; t <= t1 + 1e-9; t += 1 / fps) { g.update(her[0], her[1], her[2], t, [], 1 / fps); if (each) each(t) }
}
const giantOf = (g) => g.slots.find((c) => c.laid && c.site === site)

console.log('the round')
{
  const round = roundOf(m, 12345)
  const n = round.xs.length - 1
  const at = (id) => (id === total ? m.middle : m.cells[id])
  const visited = new Set()
  for (let i = 0; i <= n; i++) for (let id = 0; id < total; id++) if (round.xs[i] === at(id)[0] && round.zs[i] === at(id)[1]) visited.add(id)
  check(round.xs[0] === m.middle[0] && round.xs[n] === m.middle[0] && round.zs[n] === m.middle[1], 'it begins and ends in the middle')
  check(visited.size === total, 'it stands in every cell', `${visited.size}/${total}`)
  let out = 0, fast = 0
  const p = { x: 0, z: 0, moving: false }, q = { x: 0, z: 0, moving: false }
  for (let t = 0; t < round.length; t += 0.25) {
    roundAt(round, t, p)
    if (labyrinths.nodeAt(site, p.x, p.z) === -1) out++
    roundAt(round, t + 0.25, q)
    if (Math.hypot(q.x - p.x, q.z - p.z) > 0.25 * 0.61) fast++
  }
  check(out === 0 && fast === 0, 'its whole length inside the outer wall, at its walking pace', `${out} out, ${fast} too fast, ${(round.length / 60).toFixed(1)} min long`)
}

console.log('\nthe body')
{
  const g = make()
  step(g, 1000, 1000, 60)
  const c = giantOf(g)
  check(c !== undefined && g.stats.laid === 1, 'one giant laid for the labyrinth within reach')
  check(Math.abs(c.k * biped.height - (POST_HEIGHT + 1)) < 1e-9 && HEIGHT_M === POST_HEIGHT + 1, `it stands ${HEIGHT_M} m, a metre over the posts`)
  check(g.plain.color.g > 1.5 * g.plain.color.r && g.plain.color.g > 1.5 * g.plain.color.b, 'it is green')
}

console.log('\nthe room clock')
{
  const a = make(), b = make()
  step(a, 1000, 1090, 60)
  step(b, 1000, 1090, 23)
  const ca = giantOf(a), cb = giantOf(b)
  const r = roundAt(ca.round, ca.rec.tick / 20, { x: 0, z: 0, moving: false })
  check(Math.hypot(ca.sx - cb.sx, ca.sz - cb.sz) < 1e-9 && ca.state === 'round' && cb.state === 'round', 'two clients at 60 and 23 fps have it at the one pose after 90 s', `${Math.hypot(ca.sx - cb.sx, ca.sz - cb.sz).toExponential(1)} m apart`)
  check(Math.hypot(ca.sx - r.x, ca.sz - r.z) < 1e-9, 'and that pose is its round, closed-form in world time')
}

// Her head `d` m along the line ahead of the giant (`side` 1) or behind it (-1).
function herAt(c, side, d) {
  return [c.sx + Math.cos(c.sh) * d * side, 1.6, c.sz - Math.sin(c.sh) * d * side]
}

console.log('\nher')
{
  const g = make()
  step(g, 1000, 1001, 30)
  const c = giantOf(g)
  const behind = herAt(c, -1, NOTICE_M - 2)
  step(g, 1001, 1001.2, 30, behind)
  check(c.state === 'round', `${NOTICE_M - 2} m behind it, she is not noticed`, c.state)
  const g2 = make()
  step(g2, 1000, 1001, 30)
  const c2 = giantOf(g2)
  step(g2, 1001, 1001.2, 30, [...herAt(c2, 1, NOTICE_M - 2).slice(0, 1), 1.6 + ABOVE_M + 1, herAt(c2, 1, NOTICE_M - 2)[2]])
  check(c2.state === 'round', `ahead of it but ${ABOVE_M + 1} m up a tower, she is not noticed`, c2.state)
  const g3 = make()
  step(g3, 1000, 1001, 30)
  const c3 = giantOf(g3)
  const ahead = herAt(c3, 1, NOTICE_M - 2)
  step(g3, 1001, 1001.2, 30, ahead)
  check(c3.state === 'chase' && g3.pending().some((x) => x[0] === c3.key && x[7] === 'chase' && x[8] === null), `${NOTICE_M - 2} m ahead, she is noticed and chased, and a chase anchor owed`, c3.state)

  // She stands still in a cell inside: it comes for her along the graph, inside, never faster than CHASE_SPEED, and strikes once in reach.
  const g4 = make()
  step(g4, 1000, 1001, 30)
  const c4 = giantOf(g4)
  let target = null
  for (let id = 0; id < total && target === null; id++) {
    const d = Math.hypot(m.cells[id][0] - c4.sx, m.cells[id][1] - c4.sz)
    if (d > 4 && d < NOTICE_M - 1 && Math.abs(Math.atan2(Math.sin(Math.atan2(-(m.cells[id][1] - c4.sz), m.cells[id][0] - c4.sx) - c4.sh), Math.cos(Math.atan2(-(m.cells[id][1] - c4.sz), m.cells[id][0] - c4.sx) - c4.sh))) < 1.2) target = m.cells[id]
  }
  const her = [target[0], 1.6, target[1]]
  let out = 0, fast = 0, px = c4.sx, pz = c4.sz, pk = c4.rec.tick, walked = 0, swungAt = -1, blows = 0, anchors = 0
  step(g4, 1001, 1121, 30, her, (t) => {
    if (labyrinths.nodeAt(site, c4.sx, c4.sz) === -1) out++
    const d = Math.hypot(c4.sx - px, c4.sz - pz)
    if (d > (CHASE_SPEED * (c4.rec.tick - pk)) / 20 + 1e-6) fast++
    if (swungAt < 0) walked += d
    px = c4.sx; pz = c4.sz; pk = c4.rec.tick
    if (c4.state === 'swing' && swungAt < 0) swungAt = t
    blows += g4.drainBlows()
    anchors += g4.pending().filter((x) => x[0] === c4.key).length
  })
  check(swungAt > 0, 'it reaches her standing in a cell and swings', `${swungAt > 0 ? (swungAt - 1001).toFixed(1) : '-'} s, ${walked.toFixed(0)} m walked`)
  check(out === 0, 'never out of the maze on the way', `${out} ticks out`)
  check(fast === 0 && CHASE_SPEED < LOCOMOTION.maxSpeed, `never faster than ${CHASE_SPEED} m/s, under her ${LOCOMOTION.maxSpeed}`, `${fast} frames too fast`)
  check(blows > 0 && blows % BLOW === 0, `its blows land on her ${BLOW} HP at a time`, `${blows} HP in 120 s`)
  check(Math.hypot(c4.sx - her[0], c4.sz - her[2]) <= REACH_M + 0.05, 'it stands within reach of her')
  check(anchors >= 100 / ANCHOR_S, 'an anchor a second while live', `${anchors} in 120 s`)

  // She walks off past FORGET_M: forgotten, a rejoin owed, and it walks back to its round.
  const gone = [site.cx + FORGET_M + site.rOuter + 5, 1.6, site.cz]
  step(g4, 1121.03, 1122, 30, gone)
  check(c4.state === 'back' && g4.pending().some((x) => x[0] === c4.key && x[7] === 'rejoin'), `past ${FORGET_M} m she is forgotten and a rejoin owed`, c4.state)
  let backOut = 0
  step(g4, 1122.03, 1600, 10, gone, () => { if (labyrinths.nodeAt(site, c4.sx, c4.sz) === -1) backOut++ })
  check(c4.state === 'round' && backOut === 0, 'and it walks back inside the maze to its round', `${c4.state}, ${backOut} ticks out`)

  // A peer hears the authority's anchor: its giant is put there, live on that client's player.
  const peer = make()
  step(peer, 1000, 1001, 30)
  const pc = giantOf(peer)
  peer.apply([pc.key, 1001, m.cells[0][0], 0, m.cells[0][1], 0, -1, 'chase', 'client-7', 0], 1001.05)
  check(pc.live !== null && pc.live.by === 'client-7' && pc.state === 'chase' && Math.hypot(pc.sx - m.cells[0][0], pc.sz - m.cells[0][1]) < 0.2, "a peer's giant goes live on the anchor's player where the anchor has it", `${pc.state}`)
}

console.log(failures === 0 ? '\nall giant checks passed' : `\n${failures} giant check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
